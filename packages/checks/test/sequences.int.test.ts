import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { sequences } from '../src/checks/sequences.js';
import { withPostgres, seed } from './harness.js';

const { Pool } = pg;

/**
 * The same database, as a different role. The harness hands out a pool rather
 * than a URI, and the pool keeps the string it was built with — which is the
 * only place the per-test database name exists.
 *
 * ROLES ARE CLUSTER-WIDE. `withPostgres` gives every test its own DATABASE,
 * but every database in a run shares one container and therefore one set of
 * roles — so two tests creating the same role name in one run collide with
 * `role "lowpriv" already exists`, and the second one fails for a reason that
 * has nothing to do with what it is testing. Each test here uses its own name.
 */
function asRole(pool: pg.Pool, role: string, password: string): string {
  const base = (pool as unknown as { options: { connectionString?: string } })
    .options.connectionString;
  if (!base) throw new Error('harness pool was not built from a connection string');
  const uri = new URL(base);
  uri.username = role;
  uri.password = password;
  return uri.toString();
}

describe('sequences against a real server', () => {
  /**
   * §6: identity-column sequences arrived in pgHero 4.0.1, and the catalog
   * join is the most intricate query in P2 — a fixture with an identity
   * column is the only thing that proves it finds them.
   */
  it('resolves serial, identity and OWNED BY to their table, column and type', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE seq_serial   (id serial PRIMARY KEY)');
      await seed(pool, 'CREATE TABLE seq_identity (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY)');
      await seed(pool, 'CREATE TABLE seq_big      (id bigserial PRIMARY KEY)');
      await seed(pool, 'CREATE TABLE seq_small    (id smallint PRIMARY KEY)');
      await seed(pool, 'CREATE SEQUENCE seq_small_seq OWNED BY seq_small.id');

      const r = await runCheck(ctx, sequences, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const by = (frag: string) => r.data.sequences.find((s) => s.name.includes(frag))!;

      expect(by('seq_serial').table).toBe('public.seq_serial');
      expect(by('seq_serial').column).toBe('id');
      expect(by('seq_serial').columnType).toBe('integer');
      expect(by('seq_serial').maxValue).toBe(2147483647);

      expect(by('seq_identity').table).toBe('public.seq_identity');
      expect(by('seq_identity').maxValue).toBe(2147483647);

      expect(by('seq_big').columnType).toBe('bigint');
      expect(by('seq_small_seq').columnType).toBe('smallint');
      expect(by('seq_small_seq').maxValue).toBe(32767);
    });
  });

  it('survives a schema whose name needs quoting', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE SCHEMA "Weird Schema"');
      await seed(pool, 'CREATE TABLE "Weird Schema".t (id serial)');

      const r = await runCheck(ctx, sequences, {});

      // Revision 1 returned {ok:false, message:'invalid name syntax'} here,
      // for EVERY schema in the database, not just this one.
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.sequences.some((s) => s.name.includes('Weird Schema'))).toBe(true);
    });
  });

  /**
   * §5's rule, made falsifiable. The dangerous sequence must survive the cap,
   * which means the ORDER BY ranks by HEADROOM rather than by absolute value.
   * Revision 1 ordered by last_value and returned only the harmless bigint
   * row — five billion sorts above two billion — then reported ok.
   */
  it('keeps the sequence nearest its ceiling when the list is capped', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE small_col (id integer PRIMARY KEY)');
      await seed(pool, 'CREATE SEQUENCE small_col_seq OWNED BY small_col.id');
      await seed(pool, 'CREATE TABLE big_col (id bigint PRIMARY KEY)');
      await seed(pool, 'CREATE SEQUENCE big_col_seq OWNED BY big_col.id');
      await pool.query("SELECT setval('small_col_seq', 2000000000)");
      await pool.query("SELECT setval('big_col_seq', 5000000000)");

      const r = await runCheck(ctx, sequences, { limit: 1 });

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.sequences).toHaveLength(1);
      expect(r.data.sequences[0]!.name).toContain('small_col_seq');
      expect(r.data.sequences[0]!.pctUsed!).toBeGreaterThan(90);
      expect(r.data.total).toBeGreaterThanOrEqual(2);
      expect(r.verdict?.level).toBe('warn');
    });
  });

  /**
   * A never-called sequence has a NULL `last_value` — verified on 17.11 for
   * three freshly created, fully readable sequences. So NULL does NOT mean
   * unreadable, and a check that inferred it from the null would report every
   * new database as unreadable. `readable` comes from the privilege
   * predicate; the value falls back to `start_value`, as pgHero's own
   * COALESCE does.
   */
  it('treats a never-called sequence as readable and near-empty, not unreadable', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE fresh (id serial PRIMARY KEY)');

      const r = await runCheck(ctx, sequences, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const s = r.data.sequences.find((x) => x.name.includes('fresh'))!;
      expect(s.readable).toBe(true);
      expect(s.lastValue).not.toBeNull();
      expect(s.pctUsed).not.toBeNull();
      expect(s.pctUsed!).toBeLessThan(1);
      expect(r.data.unreadable).toBe(0);
    });
  });

  /**
   * `has_sequence_privilege(..., 'SELECT,USAGE')` means "any of", not "both".
   * Postgres exposes last_value to either privilege, so the SELECT-only
   * predicate under-reports: a USAGE-only role sees the value while the
   * predicate says false, and a 93%-full sequence would be blanked and
   * dropped from the verdict.
   */
  it('counts USAGE as readable, because Postgres does', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE a (id serial PRIMARY KEY)');
      await seed(pool, 'CREATE ROLE lowpriv LOGIN');
      await seed(pool, 'GRANT USAGE ON SCHEMA public TO lowpriv');
      await seed(pool, 'GRANT USAGE ON SEQUENCE a_id_seq TO lowpriv');

      const { rows } = await pool.query<{ any: boolean; sel: boolean }>(
        `SELECT has_sequence_privilege('lowpriv', 'a_id_seq', 'SELECT,USAGE') AS any,
                has_sequence_privilege('lowpriv', 'a_id_seq', 'SELECT') AS sel`);
      expect(rows[0]!.any).toBe(true);
      expect(rows[0]!.sel).toBe(false);

      const r = await runCheck(ctx, sequences, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.unreadable).toBe(0);
      expect(r.data.sequences.every((s) => s.readable)).toBe(true);
    });
  });

  /**
   * A sequence wired only through a DEFAULT expression, with no OWNED BY, has
   * NO pg_class entry in pg_depend at all — verified on 17.11, it carries only
   * an 'n' dependency on its namespace. A pg_depend-driven query omits it
   * entirely, which is the silent incompleteness this project exists to avoid.
   * Driving from pg_class instead lists every sequence; the column is what is
   * optional, and the ceiling falls back to the sequence's own maximum.
   */
  /**
   * #54, exercised as a role that genuinely cannot read the sequence — the
   * only way to reach the unreadable path at all. Run as the owner, every
   * sequence is readable, which is why the privilege predicate and the
   * unreadable counter both survived mutation until this test existed.
   */
  it('blanks a sequence the current role cannot read, and counts it database-wide', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE hidden (id serial PRIMARY KEY)');
      await seed(pool, 'CREATE TABLE shown  (id serial PRIMARY KEY)');
      await seed(pool, "CREATE ROLE seq_reader LOGIN PASSWORD 'seq_reader'");
      await seed(pool, 'GRANT USAGE ON SCHEMA public TO seq_reader');
      // USAGE only on one of them: Postgres exposes last_value to SELECT *or*
      // USAGE, so this sequence must read as READABLE despite having no
      // SELECT — the trap a 'SELECT'-only predicate falls into.
      await seed(pool, 'GRANT USAGE ON SEQUENCE shown_id_seq TO seq_reader');

      const low = new Pool({
        connectionString: asRole(pool, 'seq_reader', 'seq_reader'),
        max: 2,
        application_name: 'pgops-test-lowpriv',
      });
      try {
        const r = await runCheck({ target: low, serverVersion: ctx.serverVersion },
                                 sequences, {});
        expect(r.ok).toBe(true);
        if (!r.ok) return;

        const hidden = r.data.sequences.find((x) => x.name === 'public.hidden_id_seq')!;
        const shown = r.data.sequences.find((x) => x.name === 'public.shown_id_seq')!;

        expect(hidden.readable).toBe(false);
        expect(hidden.lastValue).toBeNull();
        expect(hidden.pctUsed).toBeNull();

        expect(shown.readable).toBe(true);
        expect(shown.pctUsed).not.toBeNull();

        expect(r.data.unreadable).toBe(1);
      } finally {
        await low.end().catch(() => {});
      }
    });
  });

  it('lists a sequence that no column owns, falling back to its own maximum', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE SEQUENCE loose_seq');
      await seed(pool, "CREATE TABLE loose_t (id int DEFAULT nextval('loose_seq'))");

      const r = await runCheck(ctx, sequences, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const s = r.data.sequences.find((x) => x.name === 'public.loose_seq');
      expect(s).toBeDefined();
      expect(s!.table).toBeNull();
      expect(s!.columnType).toBeNull();
      expect(s!.maxValue).toBeGreaterThan(2147483647);
    });
  });

  it('excludes a temporary sequence, which another session cannot read', async () => {
    await withPostgres(async (ctx, pool) => {
      const holder = await pool.connect();
      try {
        await holder.query('CREATE TEMP TABLE tmp_seq_t (id serial PRIMARY KEY)');

        const r = await runCheck(ctx, sequences, {});
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.data.sequences.some((s) => s.name.includes('tmp_seq_t'))).toBe(false);
      } finally {
        holder.release();
      }
    });
  });

  it('is ok when every sequence is far from its ceiling', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id serial PRIMARY KEY)');
      const r = await runCheck(ctx, sequences, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.verdict).toEqual({ level: 'ok' });
    });
  });
});
