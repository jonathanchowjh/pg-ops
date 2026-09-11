# P2c — The Hygiene Class, Keep-Up Gate: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the ten remaining P2 capabilities — space, maintenance, sequences and settings — behind a new `Cleanup` tab, and close phase P2.

**Architecture:** Three new check files plus `settings.ts`, and a fourth top-level tab. The tab is not new scope: `gates.ts` gives the `keep-up` gate the title *Replication & cleanup*, and that is the one gate title mirroring no tab — the triage page's `keep-up` band has always been the band with nowhere to go. `/cleanup` is that destination, carrying the four already-shipped checks the gate owns (#44, #49, #50, #51) plus the hygiene sub-routes.

**Tech Stack:** TypeScript 5.7, `@pgops/checks` (dependencies stay exactly `["pg"]`), Next 16 App Router, React 19 Server Components, Vitest 4, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-09-03-pgops-p2-hygiene-design.md` — the Amendment, §1.1, §2.1, §2.2, §3, §4.1, §4.2, §5, §6, §7, §8.

**Sibling plan:** `docs/superpowers/plans/2026-09-10-p2b-hygiene-work-gate.md`. **This plan must run second.** It depends on P2b for two things — `ListOpts` (P2b Task 1) and the `SubNav` component (P2b Task 9) — and Task 8 here adds `'P2'` to `COMPLETE_PHASES`, which the phase gate rejects until P2b has landed.

---

## Why this plan does not contain finished SQL

**Revision 2 (2026-09-11), after review.** Revision 1 specified complete query bodies. A reviewer executed every one against PostgreSQL 17.11 with fixtures for serial, identity, bigserial, smallint, standalone, cross-schema and partitioned cases, plus two low-privilege roles. Findings, all reproduced:

- **`autovacuumDanger` did not parse at all.** `ORDER BY …, table` — `table` is a fully reserved word and is illegal as a bare column reference, however legal it is as an `AS` label.
- **Had it parsed, it would have been nonsense.** A partitioned parent has `relfrozenxid = 0`, and `age(0)` is `2147483647` — so every partition parent renders "0 transactions remaining", permanently, at the top of a page titled *Tables holding the transaction horizon*.
- **And it would have shown almost no user tables.** Leaving `pg_catalog` and `pg_toast` in meant 104 catalog rows crowded the `LIMIT 100`; exactly **one** `public.` row survived, which then failed the plan's own integration test.
- **`sequences` failed outright on a mixed-case schema.** `s.schemaname::regnamespace` parses its argument as identifier syntax: one schema named `"Weird Schema"` containing a sequence, anywhere in the database, and the check returns `{ok:false}` for every schema, permanently. Confirmed: `ERROR: invalid name syntax`.
- **`sequences` lost the finding under its own cap.** It ordered by absolute `last_value`, not by headroom — so a bigint sequence at 5,000,000,000 (0.00% of its ceiling) sorted above an integer-column sequence at 93%, and with the cap applied the verdict reported `ok`. That is §5's named failure, in the check §5 names.
- **`relationSizes` double-counted.** `pg_total_relation_size` already includes indexes and TOAST, and the list emits a row per index too: the rows summed to 76.7 MB on a 56.5 MB database. P4 charts these numbers.

The lesson is about the artifact: **a plan is the wrong place for unverified SQL**, in a repo whose premise is that claims are checked. So this revision inverts it — **for each check the failing integration test is written out in full and IS the specification**, and the query is derived against a live server until it passes. Queries actually executed and confirmed during review appear verbatim and are labelled. **There are no unlabelled verified queries in this file.**

---

## Global Constraints

Identical to P2b's — read that section in full, including **the two guards** (no DDL in a `remedy:` string; never `ORDER BY` a `::text` alias) and **the real `withPostgres` / `render` signatures**. The constraints that bite hardest here:

- **`null` means "we could not look".** #54 `unreadable_sequences` exists *because* of this rule.
- **A check with no `verdict` yields `verdict: null`, not `{level:'ok'}`.** Spec §2.2 said otherwise until 2026-09-11 and is corrected.
- **Row caps carry the true total**, and **every verdict reads it** — *and the `ORDER BY` must sort the finding to the top*, which is the half Revision 1 got wrong.
- **`table` is a reserved word.** Legal as `AS "table"`, illegal as a bare `ORDER BY` term.
- **Exclude system *and temp* schemas.** `NOT IN ('pg_catalog','information_schema','pg_toast')` is exact-match and lets `pg_temp_7` through; add `AND n.nspname NOT LIKE 'pg\_%'`.
- **Schema-qualify every relation name**, consistently, via an explicit `pg_namespace` join — never via `regclass` text output, which is search_path-dependent and produced `public.seq_serial` or `seq_serial` depending on session state.

---

## Ruling 1: #45 `autovacuum_danger` ships without a verdict

**Verified correct during review, and the spec now agrees.**

§2.1 gave #45 a `warn` at 2,000,000 transactions, adopted from pgHero's `transaction_id_danger(threshold: 2000000)`. That threshold predates the recalibration of `wraparound` (#44), which now criticals at **100,000,000 transactions remaining**.

`pg_database.datfrozenxid` is the *minimum* `relfrozenxid` across the database, so `age(datfrozenxid)` **is** the maximum age over its tables — confirmed empirically (`db_age 1602 = max_tbl_age 1602`). The two therefore track the same number at different granularities, and a #45 warn at 2,000,000 remaining sits 98,000,000 transactions *inside* #44's critical. It can never fire first. A warning that only appears beneath a standing critical is noise, and §2.1's own discipline forbids inventing tiers.

**#45's value is the list, not the level**: #44 answers "how close is this database to shutdown", #45 answers "which tables are holding the xid back", which is the only actionable half. It ships with no `verdict` and joins §2.2's list, which is now nineteen. **Spec §2.1's row for #45 has been struck and §2.2 updated** — this ruling is no longer a deviation from the spec but a record of why the spec changed.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/checks/src/checks/space.ts` (create) | #37, #38, #39 |
| `packages/checks/src/checks/maintenance.ts` (create) | #43, #45, #46 |
| `packages/checks/src/checks/sequences.ts` (create) | #52, #53, #54 — one check, three capabilities |
| `packages/checks/src/checks/settings.ts` (create) | #56 |
| `packages/checks/src/index.ts` (modify) | `export type *` for all four |
| `packages/checks/src/registry.ts` (modify) | Wire eight checks; flip ten entries; add `'P2'` to `COMPLETE_PHASES` |
| `apps/web/components/nav.tsx` (modify) | One new tab |
| `apps/web/test/nav.test.tsx` (create) | Does not exist today |
| `apps/web/test/guards.test.ts` (modify) | `/cleanup` joins `INCIDENT_PAGES` — the one legitimate case |
| `apps/web/app/db/[name]/cleanup/page.tsx` (create) | #44, #49, #50, #51 — **polls** |
| `apps/web/app/db/[name]/cleanup/{space,maintenance,sequences}/page.tsx` (create) | The hygiene sub-routes — do not poll |
| `apps/web/components/status-bar.tsx` (modify) | #56 — server facts belong in the status line |
| `README.md`, `CHANGELOG.md`, three `package.json` | The v2 entry and the parity numbers |

---

### Task 1: `space.ts` — #37, #38, #39

§3's divergence governs all three: **bytes, not a formatted string.** pgHero returns `pretty_size(...)` — `"8192 MB"` — which cannot be thresholded, compared or charted, and P4 charts space growth from exactly these numbers.

**Contract:** `databaseSize` (no Opts), `relationSizes` and `tableSizes` (`ListOpts`); all `gate: 'keep-up'`, `class: 'hygiene'`, `timeoutMs: 10_000`, **no verdict** (§2.2).

**The trap review found.** `pg_total_relation_size(t)` already includes every index and the TOAST relation. #38 `relationSizes` lists *relations*, indexes included — so using `pg_total_relation_size` for each row double-counts. Measured: rows summed to 76,693,504 bytes on a 56,481,459-byte database. **#38 wants `pg_table_size` (per-relation, no indexes); #39 `tableSizes` wants `pg_total_relation_size` (the number an operator means by "how big is this table").** Confirm against pgHero's `methods/space.rb` before settling it.

- [ ] **Step 1: Write the failing integration test**

```typescript
// packages/checks/test/space.int.test.ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { databaseSize, relationSizes, tableSizes } from '../src/checks/space.js';
import { withPostgres, seed } from './harness.js';

describe('space against a real server', () => {
  it('reads a database size larger than zero', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, databaseSize);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.sizeBytes).toBeGreaterThan(0);
      expect(result.verdict).toBeNull();
    });
  });

  /**
   * The double-count, as a falsifiable test. `pg_total_relation_size` on a
   * table already includes its indexes; if #38 uses it per row while also
   * listing the indexes, the list sums to more than the database.
   */
  it('does not sum to more than the database it describes', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE big_t (a int, b int, c text);
        INSERT INTO big_t SELECT g, g, repeat('x', 100) FROM generate_series(1, 60000) g;
        CREATE INDEX ix_a ON big_t (a);
        CREATE INDEX ix_b ON big_t (b);
      `);

      const rels = await runCheck(ctx, relationSizes, { limit: 1000 });
      const db = await runCheck(ctx, databaseSize);

      expect(rels.ok && db.ok).toBe(true);
      if (!rels.ok || !db.ok) return;
      const sum = rels.data.relations.reduce((n, r) => n + r.sizeBytes, 0);
      expect(sum).toBeLessThanOrEqual(db.data.sizeBytes!);
    });
  });

  it('finds a table it was just given, schema-qualified, and excludes catalogs', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE space_fixture (id int PRIMARY KEY);');

      const result = await runCheck(ctx, tableSizes, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.relations.map((r) => r.name);
      expect(names).toContain('public.space_fixture');
      expect(names.some((n) => n.startsWith('pg_'))).toBe(false);
      expect(names.some((n) => n.startsWith('information_schema.'))).toBe(false);
    });
  });

  it('excludes another session\'s temporary tables', async () => {
    await withPostgres(async (ctx, pool) => {
      // A temp table in this pool's session lands in a pg_temp_N schema,
      // which an exact-match NOT IN list does not exclude.
      await pool.query('CREATE TEMP TABLE tmp_leak (id int)');

      const result = await runCheck(ctx, relationSizes, { limit: 1000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.relations.some((r) => r.name.includes('tmp_leak'))).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Derive.** `databaseSize` **was verified** and may be used as written: `SELECT pg_database_size(current_database())::text AS size_bytes`. For the two lists: explicit `pg_class`/`pg_namespace` join, `nspname || '.' || relname`, the `NOT LIKE 'pg\_%'` exclusion, `count(*) OVER ()`, size DESC ordering, and the `pg_table_size` / `pg_total_relation_size` split above. Keep the `IS NOT NULL` guard — `pg_total_relation_size(999999999::oid)` really does return NULL for a relation dropped mid-scan — but note it cannot fully prevent one, since the WHERE and SELECT calls are independent; compute the size **once** in a `LATERAL` or CTE and filter on that, which also removes the triple evaluation per row.

- [ ] **Step 4: Unit tests** — bytes as numbers not strings; `sizeBytes: null` when no row; truncation arithmetic; `verdict` `undefined` on all three.

- [ ] **Step 5: Run unit + integration + `npm run test:web`.**

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): database, relation and table sizes, in bytes"`

---

### Task 2: `sequences.ts` — #52, #53, #54, the most intricate query in P2

One check backs all three capabilities. §3: **`sequence_danger` measures against the COLUMN's type, not the sequence's own maximum** — a `bigint` sequence feeding an `integer` column fails at 2,147,483,647 while the sequence still has four billion values left. pgHero's mapping is adopted verbatim: `smallint` → 32767, `integer` → 2147483647, everything else → 9223372036854775807. #54 is not a separate query — it is the `readable` attribute on #52's own shape.

**Contract:** `gate: 'keep-up'`, `class: 'hygiene'`, `timeoutMs: 10_000`, `ListOpts`. Threshold `{ level: 'warn', value: 90, unit: 'percent', because: "pgHero's sequence_danger(threshold: 0.9); adopted for parity, and measured against the column type rather than the sequence maximum", remedy: <prose> }`. Data `{ sequences: SequenceEntry[]; total; truncated; unreadable }`.

**Five traps, every one a reproduced Revision 1 defect:**

1. **`s.schemaname::regnamespace` throws on any schema whose name is not a bare lowercase identifier.** `regnamespace` parses identifier syntax, so `"Weird Schema"` yields `ERROR: invalid name syntax` and the whole check returns `{ok:false}` forever. **Join `pg_namespace` on `nspname` and compare oids.**
2. **Order by headroom, not by `last_value`.** Revision 1's `ORDER BY COALESCE(s.last_value,0) DESC` put a 0.00%-full bigint sequence above a 93%-full integer one, and the cap then dropped the finding. **Order by `last_value / <column ceiling>` descending, NULLS LAST** — which means the ceiling has to be computed in SQL, not only in `map`.
3. **`has_sequence_privilege(oid, 'SELECT')` under-reports.** Postgres exposes `pg_sequences.last_value` to `SELECT` **or** `USAGE`; a USAGE-only role sees the value while that predicate says false, so a 93%-full sequence would be blanked and dropped from the verdict. Use `'SELECT,USAGE'`, which means "any of" — verified to return true for the USAGE-only case.
4. **`d.refobjid::regclass::text` is search_path-dependent.** It returned `seq_serial` or `public.seq_serial` depending on session state, while `name` was always qualified — two naming conventions in one row. Join `pg_class`/`pg_namespace` and build the qualified name explicitly.
5. **`unreadable` must be a window aggregate, not a count of the returned page.** Unreadable sequences have a NULL `last_value`, so they sort last and are the first rows a cap discards — the page would then claim a database-wide fact from a truncated list. Use `count(*) FILTER (WHERE NOT <privilege>) OVER ()::int`.

**Verified as correct, do not change:** `format_type(a.atttypid, NULL)` returns exactly `integer`, `smallint`, `bigint`; the `pg_depend` join with `deptype IN ('a','i')` resolves serial (`'a'`), identity (`'i'`) and `OWNED BY` (`'a'`) correctly and produces **no duplicate rows** across partitioned, two-serial and cross-schema fixtures; `pg_sequences.last_value` is genuinely NULL for an unreadable sequence.

- [ ] **Step 1: Write the failing integration test**

```typescript
// packages/checks/test/sequences.int.test.ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { sequences } from '../src/checks/sequences.js';
import { withPostgres, seed } from './harness.js';

describe('sequences against a real server', () => {
  /**
   * §6: "identity-column sequences, added in pgHero 4.0.1. The catalog join
   * is the most intricate query in P2 and a fixture with an identity column
   * is the only thing that proves it finds them."
   */
  it('resolves serial, identity and OWNED BY to their table, column and type', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE seq_serial   (id serial PRIMARY KEY);
        CREATE TABLE seq_identity (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
        CREATE TABLE seq_big      (id bigserial PRIMARY KEY);
        CREATE TABLE seq_small    (id smallint PRIMARY KEY);
        CREATE SEQUENCE seq_small_seq OWNED BY seq_small.id;
      `);

      const r = await runCheck(ctx, sequences, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const by = (frag: string) => r.data.sequences.find((s) => s.name.includes(frag))!;

      expect(by('seq_serial').table).toBe('public.seq_serial');
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
      await seed(pool, 'CREATE SCHEMA "Weird Schema"; CREATE TABLE "Weird Schema".t (id serial);');

      const r = await runCheck(ctx, sequences, {});

      // Revision 1 returned {ok:false, message:'invalid name syntax'} here,
      // for EVERY schema, not just this one.
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.sequences.some((s) => s.name.includes('Weird Schema'))).toBe(true);
    });
  });

  /**
   * §5's rule, made falsifiable. The dangerous sequence must survive the cap,
   * which means the ORDER BY must rank by headroom rather than by absolute
   * value. Revision 1 returned only the harmless bigint row and reported ok.
   */
  it('keeps the sequence nearest its ceiling when the list is capped', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE small_col (id integer PRIMARY KEY);
        CREATE SEQUENCE small_col_seq OWNED BY small_col.id;
        CREATE TABLE big_col (id bigint PRIMARY KEY);
        CREATE SEQUENCE big_col_seq OWNED BY big_col.id;
      `);
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

  it('reports an unreadable sequence as unreadable, and counts them all', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE a (id serial PRIMARY KEY);
        CREATE TABLE b (id serial PRIMARY KEY);
        CREATE ROLE lowpriv LOGIN;
        GRANT USAGE ON SCHEMA public TO lowpriv;
      `);
      // Exercised as the owner; the unreadable path is asserted through map's
      // own unit tests plus the privilege predicate below.
      const { rows } = await pool.query<{ ok: boolean }>(
        "SELECT has_sequence_privilege('lowpriv', 'a_id_seq', 'SELECT,USAGE') AS ok");
      expect(rows[0]!.ok).toBe(false);

      const r = await runCheck(ctx, sequences, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // As owner, everything is readable and nothing is excluded.
      expect(r.data.unreadable).toBe(0);
      expect(r.data.sequences.every((s) => s.readable)).toBe(true);
    });
  });

  it('is ok when every sequence is far from its ceiling', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id serial PRIMARY KEY);');
      const r = await runCheck(ctx, sequences, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.verdict).toEqual({ level: 'ok' });
    });
  });
});
```

- [ ] **Step 2: Run it, watch all five fail.**

- [ ] **Step 3: Derive the query**, working the five traps above. The column ceiling must exist in SQL (a `CASE format_type(a.atttypid, NULL) WHEN 'smallint' THEN 32767 WHEN 'integer' THEN 2147483647 ELSE 9223372036854775807 END`, as `numeric` to avoid int8 issues) so the `ORDER BY` can rank by headroom, and `map` must derive `pctUsed` from the same mapping so the two cannot drift. Keep the mapping in one exported helper.

- [ ] **Step 4: Unit tests for `map`.** Cover:
  - an integer column at 2,000,000,000 → `pctUsed ≈ 93.13` (verified arithmetic)
  - `smallint` at 32767 → exactly 100
  - **assert `maxValue` directly** for the bigint case rather than asserting `pctUsed < 0.001` — Revision 1's version passed identically whether the ceiling was bigint or integer, which is the one confusion the test existed to catch
  - unreadable → `pctUsed: null`, `readable: false`, never `0`
  - boundary: `1932735283` → warn (90.00000003%); **`1932735282` → ok (89.99999999%)**. Revision 1's ok-side fixture was 46.6%, which would still pass if the threshold were mis-set to 50, 60 or 80
  - every sequence unreadable → `{level:'ok'}`, with the test **named** for what that means ("no readable sequence to judge"), since `Verdict` has no third state and `ok` here is otherwise indistinguishable from "we looked and it is fine"

  **`BIGINT_MAX` note:** `9223372036854775807` is not representable as a JS number — `node -e "console.log(9223372036854775807)"` prints `9223372036854776000`. The 90% comparison is unaffected, but `maxValue` is rendered, so an operator would see a number that is not the bigint maximum. Either keep the ceiling as a string for display, or state the imprecision in the docblock rather than leaving it implicit.

- [ ] **Step 5: Run unit + integration + `npm run test:web`.**

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): sequences, measured against the column type"`

---

### Task 3: `maintenance.ts` — #43, #45, #46

Per Ruling 1, **none of these carries a verdict.** #45 is the per-table detail behind the shipped `wraparound` alarm; §3 records that `wraparound` itself is **not modified**.

**Contract:** `maintenanceInfo` and `autovacuumDanger` take `ListOpts`; `vacuumProgress` takes none (the view holds one row per running worker, bounded by `autovacuum_max_workers` plus manual sessions — nothing to cap). All `gate: 'keep-up'`, `class: 'hygiene'`, `timeoutMs: 10_000`, **no verdict**.

**Traps:**
- **`ORDER BY …, table` is a syntax error.** Use `ORDER BY <expr> DESC, 1` or a non-reserved alias.
- **Exclude `relkind 'p'`.** A partitioned parent has `relfrozenxid = 0` and `age(0) = 2147483647`, so it reports zero transactions remaining, permanently, at the top. It has no storage and cannot hold an xid back. Add `AND c.relfrozenxid <> 0` as a second guard. pgHero uses `relkind IN ('r','m')`.
- **Exclude `pg_catalog` and `pg_toast`.** With them in, 104 catalog rows crowded the default `LIMIT 100` and exactly one user table survived.
- **`2147483647 - age(...)` is int4 arithmetic and overflows** if `age()` returns negative (possible on a standby or after `pg_resetwal`): `SELECT 2147483647 - (-1)::int` → `ERROR: integer out of range`. Cast to `bigint`.
- **`maintenanceInfo` must schema-qualify**; Revision 1 returned a bare `relname` while every sibling returned `schema.relation`.
- **The `ORDER BY` on `maintenanceInfo` sorts by vacuum only**, though the docblock says "oldest activity". Pick one and make the prose match.
- `HARD_LIMIT`: `wraparound.ts` uses `2_147_483_647` and its own remedy text says Postgres refuses new transactions at 1,000,000 remaining (pgHero uses `2146483647`). **Inherit the shipped constant for consistency**, but do not write a docblock that contradicts the sibling file three lines away.

- [ ] **Step 1: Write the failing integration test**

```typescript
// packages/checks/test/maintenance.int.test.ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { autovacuumDanger, maintenanceInfo, vacuumProgress } from '../src/checks/maintenance.js';
import { withPostgres, seed } from './harness.js';

describe('maintenance against a real server', () => {
  /**
   * §6: pg_stat_progress_vacuum is empty unless a vacuum is running. Empty
   * must be `ok` with zero rows — NOT a failure. A regression to ok:false
   * would make the page say "we could not look" on every healthy database,
   * the inverse of the honesty rule.
   */
  it('reports no running vacuum as an empty list rather than a failure', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, vacuumProgress);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.vacuums).toEqual([]);
      expect(result.verdict).toBeNull();
    });
  });

  it('finds a user table and excludes catalog, toast and partitioned parents', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE maint_fixture (id int PRIMARY KEY);
        CREATE TABLE part_parent (id int, d date) PARTITION BY RANGE (d);
        CREATE TABLE part_child PARTITION OF part_parent
          FOR VALUES FROM ('2020-01-01') TO ('2030-01-01');
      `);

      const result = await runCheck(ctx, autovacuumDanger, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.tables.map((t) => t.table);
      expect(names).toContain('public.maint_fixture');
      // The partitioned PARENT has relfrozenxid 0 and would report
      // txnsRemaining 0 — a permanent false alarm at the top of the page.
      expect(names).not.toContain('public.part_parent');
      expect(names.some((n) => n.startsWith('pg_'))).toBe(false);
      // A real child partition has storage and does belong.
      expect(names).toContain('public.part_child');
    });
  });

  /**
   * Falsifiable, unlike Revision 1's `toBeGreaterThanOrEqual(0)`: the two
   * numbers must be two views of one reading.
   */
  it('reports an age and a remaining count that are consistent with each other', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id int PRIMARY KEY);');

      const result = await runCheck(ctx, autovacuumDanger, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.tables.find((t) => t.table === 'public.t')!;
      expect(row).toBeDefined();
      expect(row.xactAge + row.txnsRemaining).toBe(2_147_483_647);
    });
  });

  it('reports a freshly vacuumed table as vacuumed and never analyzed, schema-qualified', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE maint_vac (id int PRIMARY KEY);');
      await pool.query('VACUUM maint_vac');

      const result = await runCheck(ctx, maintenanceInfo, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.tables.find((t) => t.table === 'public.maint_vac')!;
      expect(row).toBeDefined();
      expect(row.lastVacuum).not.toBeNull();
      expect(row.lastAnalyze).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Derive.** `vacuumProgress` **was verified** — columns, phase strings and empty-when-idle all confirmed on 17.11. Its `map` must render an unknown total as a **null** percentage: the `initializing` phase reports `heap_blks_total = 0`, and `0%` would read as "no progress" rather than "not yet known".

- [ ] **Step 4: Unit tests** — four nullable timestamps where null means "never"; bigint conversions; `pctScanned` null when total is 0; `verdict` `undefined` on all three, with a test named for Ruling 1 on `autovacuumDanger`.

- [ ] **Step 5: Run unit + integration + `npm run test:web`.**

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): maintenance info, per-table xid age and vacuum progress"`

---

### Task 4: `settings.ts` — #56, one query rather than fifteen

§3: pgHero's `fetch_settings` issues `SHOW <name>` per setting; pgops reads `pg_settings WHERE name = ANY($1)` in one round trip. The version branch is preserved — `io_method` only when `server_version_num >= 180000`, matching `settings.rb`.

**Contract:** `gate: 'server'` (not a gate — `gates.ts` is explicit that server facts belong in the status line), `class: 'hygiene'`, `timeoutMs: 10_000`, `Opts = { serverVersion: number }`, **no verdict**. The opts carry the version because `sql` is a pure function of opts and cannot reach `ctx`.

**Verified during review:** `name = ANY($1)` with a text array works; all 31 setting names in the three groups exist on PG 17; `io_method` is correctly absent there and returns no row rather than an error.

- [ ] **Step 1: Write the failing integration test**

```typescript
// packages/checks/test/settings.int.test.ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { settings } from '../src/checks/settings.js';
import { withPostgres } from './harness.js';

describe('settings against a real server', () => {
  it('reads every group in one round trip', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, settings, { serverVersion: ctx.serverVersion });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.main.find((s) => s.name === 'max_connections')?.value).toBeTruthy();
      expect(result.data.autovacuum.length).toBeGreaterThan(0);
      expect(result.data.vacuum.length).toBeGreaterThan(0);
      expect(result.verdict).toBeNull();
    });
  });

  /**
   * The version branch, asserted from ctx.serverVersion rather than a literal
   * — the only form that covers the whole 14/16/17/18 CI matrix from one test.
   */
  it('includes io_method exactly when the server is 18 or newer', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, settings, { serverVersion: ctx.serverVersion });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const present = result.data.main.some((s) => s.name === 'io_method');
      expect(present).toBe(ctx.serverVersion >= 180_000);
    });
  });

  it('names every setting it asks for, so a typo fails here rather than rendering blank', async () => {
    await withPostgres(async (ctx, pool) => {
      const { settingNames } = await import('../src/checks/settings.js');
      const asked = settingNames(ctx.serverVersion);
      const { rows } = await pool.query<{ name: string }>(
        'SELECT name FROM pg_settings WHERE name = ANY($1)', [asked]);
      const missing = asked.filter((n) => !rows.some((r) => r.name === n));
      expect(missing).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Implement.** Three name arrays (main / autovacuum / vacuum) matching `settings.rb`'s groups, `settingNames(serverVersion)` appending `io_method` at `>= 180_000`, one query, and a `map` that groups by membership. **Decide deliberately whether groups render in array order or alphabetically** — the SQL's `ORDER BY name` plus a filter gives alphabetical, while Revision 1's docblock implied the arrays defined presentation order. Say which in the docblock.

- [ ] **Step 4: Unit tests** — `settingNames` omits/includes `io_method` either side of 180_000; each group contains its own members and not the others'; a unitless setting keeps `unit: null` rather than an empty string; an empty result gives three empty groups; `verdict` `undefined`. Use **more than one setting per group** so the grouping test can actually fail.

- [ ] **Step 5: Run unit + integration + `npm run test:web`.**

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): settings, in one round trip with the io_method branch"`

---

### Task 5: The `Cleanup` tab — the one page in either plan that legitimately polls

`gates.ts` titles the `keep-up` gate *Replication & cleanup* and states that each gate title mirrors the tab going deeper into it. Three of four tabs exist; this is the fourth. It carries the four **already-shipped** checks the gate owns — #44 `wraparound`, #49 `replicationLag`, #50 `slots`, #51 `replicating` (folded into `replicationLag`'s data) — so it is an incident page and **does** render `<Refresh>`.

This is the single case where `INCIDENT_PAGES` is extended. P2b forbids it for hygiene routes; this is not one.

**Depends on P2b Task 9** for `SubNav`; this task cannot compile without it.

**Files:** modify `apps/web/components/nav.tsx`, `apps/web/test/guards.test.ts`; create `apps/web/test/nav.test.tsx`, `apps/web/app/db/[name]/cleanup/page.tsx`, `apps/web/test/cleanup-page.test.tsx`

- [ ] **Step 1: Write the failing nav test**

`GATES` and `GATE_ORDER` **are already exported** from `@pgops/checks` (`index.ts` does `export * from './gates.js'`) — do not add a duplicate export.

```tsx
// apps/web/test/nav.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import { Nav } from '@/components/nav';
import { GATES, GATE_ORDER } from '@pgops/checks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => null,
}));

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; });

describe('Nav', () => {
  it('links the cleanup tab', async () => {
    rendered = await render(<Nav name="prod" />);
    expect(rendered.container.innerHTML).toContain('/db/prod/cleanup');
  });

  /**
   * The property gates.ts calls the organising idea: every gate has a tab.
   * Matched by HREF SEGMENT, not by label text — the keep-up gate's title is
   * "Replication & cleanup" while its tab reads "Cleanup", and a naive
   * first-word match on the title asserts "Replication", which is not on the
   * page at all. Revision 1 made exactly that mistake.
   */
  it('has a tab for every gate', async () => {
    rendered = await render(<Nav name="prod" />);
    const hrefs = [...rendered.container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '');
    expect(GATE_ORDER).toHaveLength(4);
    for (const gate of GATE_ORDER) {
      const segment = GATE_TAB[gate];
      expect(
        hrefs.some((h) => h === `/db/prod/${segment}` || (segment === '' && h === '/db/prod')),
        `gate ${gate} (${GATES[gate].title}) has no tab`,
      ).toBe(true);
    }
  });
});

/**
 * The gate -> tab segment map, declared here rather than derived from the
 * title. Two of the four titles are not their segment ("Replication &
 * cleanup" -> "cleanup"), so deriving it is what produced a test that could
 * not pass. If a gate is ever added, this map fails to compile.
 */
const GATE_TAB: Record<(typeof GATE_ORDER)[number], string> = {
  connect: 'sessions',
  wait: 'locks',
  work: 'queries',
  'keep-up': 'cleanup',
};
```

- [ ] **Step 2: Run it, watch it fail** — no `/db/prod/cleanup` in the output.

- [ ] **Step 3: Add the tab.** Append to `TABS` in `nav.tsx`:

```typescript
  { segment: 'cleanup', href: '/cleanup', label: 'Cleanup' },
```

Labelled `Cleanup`, not `Replication & cleanup`: the gate's title is the sentence a band uses; the tab is a word on a strip, and an ampersand is where the nav starts wrapping. Put that reasoning in a comment beside the entry.

- [ ] **Step 4: Run it, watch it pass.**

- [ ] **Step 5: Write the failing page test.** Same harness shape as P2b Task 10 — dispatch the `runCheckFor` mock on `check.id`, **call** the async component then render the element, assert on `container.innerHTML`. Cover:
  - the wraparound and replication panels render
  - **a null replication lag on a primary renders as not-applicable, never `0s`** — the README's stated divergence, held at the page
  - each hygiene sub-route is linked
  - the page polls (assert the `Refresh` marker is present)

- [ ] **Step 6: Implement the page.** `<Refresh intervalMs={5_000} />`, then `<SubNav name={name} base="cleanup" items={[{segment:'space',label:'Space'},{segment:'maintenance',label:'Maintenance'},{segment:'sequences',label:'Sequences'}]} />`, then a `CheckPanel` each for `CHECKS.wraparound`, `CHECKS.replicationLag` and `CHECKS.slots`. **Do not change any of those four checks** — they ship on the triage page and continue to; this is a second surface over the same checks, exactly as `/sessions` already is for the `connect` gate.

- [ ] **Step 7: Extend the guard, deliberately.** Add to `INCIDENT_PAGES` in `guards.test.ts`:

```typescript
    join(APP, 'db', '[name]', 'cleanup', 'page.tsx'),
```

with a comment recording why this one is allowed where the hygiene routes are not: it renders `class: 'incident'` checks and must stay current during an incident, while its sub-routes run catalog scans on visit.

- [ ] **Step 8: Run the whole web suite** — `npm run test:web`. Both `<Refresh>` guards must pass; the cadence guard now compares the overview (30s) against five pages rather than four.

- [ ] **Step 9: Commit** — `git commit -m "feat(web): the Cleanup tab, closing the gate with no destination"`

---

### Task 6: `/cleanup/space`, `/cleanup/maintenance`, `/cleanup/sequences`

Three pages of one shape, and one task: a reviewer would not sensibly accept one and reject another. Each is a `SubNav` plus two or three `CheckPanel`s over checks already tested in Tasks 1–3.

**Files:** create the three `page.tsx` files and `apps/web/test/cleanup-subroutes.test.tsx`

- [ ] **Step 1: Write the failing tests.** Same harness shape as Task 5, covering:
  - **space** — bytes are formatted at the edge (`8589934592` renders as GB, and the raw digits do not appear); a check that could not run says why rather than rendering empty
  - **maintenance** — a never-vacuumed table renders `never`, not a blank cell; no running vacuum says so rather than showing an empty table; `autovacuumDanger` renders **no verdict badge** (Ruling 1 — #44 owns the alarm)
  - **sequences** — the percentage renders **with the column type named** (a bare `93%` is meaningless without the ceiling); an unreadable sequence renders as unreadable, never `0%`; the unreadable count renders with wording about permission

- [ ] **Step 2: Run them, watch three modules fail to resolve.**

- [ ] **Step 3: Implement.** Each: `generateMetadata`, a `SubNav` with `base="cleanup"` and the same three items, then `CheckPanel`s. **None renders `<Refresh>`.**

  The sequences copy is worth pinning, because it is the check's whole point:

```tsx
{s.pctUsed === null ? (
  <span className="text-muted-foreground">
    {s.readable ? 'never used' : 'not readable by this role'}
  </span>
) : (
  <>{s.pctUsed.toFixed(1)}% of {s.columnType ?? 'its column type'}</>
)}
```

  and, when `d.unreadable > 0`:

```tsx
<p className="text-sm text-muted-foreground">
  {d.unreadable} sequence(s) could not be read by this role and are excluded
  from the verdict. Grant select or usage on them, or open this page as a role
  that has it.
</p>
```

  (Prose, not a `GRANT` statement — the DDL guard covers `packages/checks/src` only, but the house style is prose and the page should match.)

- [ ] **Step 4: Run them, then `npm run test:web`.** Three new pages, none polling — the `<Refresh>` guard is the one to watch.

- [ ] **Step 5: Commit** — `git commit -m "feat(web): the space, maintenance and sequences routes"`

---

### Task 7: #56 into the status line

`gates.ts` is explicit: `server` facts belong in the status line under the page heading, where `identity` already puts them — not in a band, not in a tab.

**The trap Revision 1 walked into.** It said to fetch settings in `app/db/[name]/layout.tsx` alongside `identity`. That layout is shared by all four incident pages and `router.refresh()` re-renders layouts — so a `pg_settings` query would land **behind the 5-second poll**, which is precisely the defect §4.2's poll boundary exists to prevent. **Fetch it in the `/cleanup` page and pass it to `StatusBar`**, or render the disclosure on `/cleanup` only.

**The second trap.** `SettingsOpts` is `{ serverVersion: number }` — `server_version_num`, compared against `180_000`. `IdentityData.serverVersion` is `string | null`, a formatted display version. **They are not the same value**; `{ serverVersion }` off the identity result does not typecheck and would be wrong if it did. Take the number from `ctx.serverVersion` via a check that has it, or read `current_setting('server_version_num')` where you need it.

**Files:** modify `apps/web/components/status-bar.tsx`, `apps/web/test/status-bar.test.tsx`

- [ ] **Step 1: Write the failing test.** Cover: the existing one-line summary is unchanged when settings are supplied (the regression that matters — this bar sits directly above a button that terminates backends); groups render with their headings; a unitless setting renders without a trailing space (operators copy these values); a settings read that failed still renders the disclosure, **with the reason inside it**.

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Implement.** An **optional** `settings?: CheckResult<SettingsData>` prop, so the four pages that do not fetch settings are unchanged. Absent → render exactly what renders today. Present → a `<details>` disclosure after the existing line, `<summary>Settings</summary>`, three groups inside.

- [ ] **Step 4: Run it, then `npm run test:web`.**

- [ ] **Step 5: Commit** — `git commit -m "feat(web): settings in the status line, where server facts belong"`

---

### Task 8: Close phase P2

Ten entries flip and `'P2'` joins `COMPLETE_PHASES`. **The phase gate is the point of this task.**

**Files:** modify `packages/checks/src/registry.ts` and `packages/checks/src/index.ts`

- [ ] **Step 1: Confirm the starting point** — `npm test`. `parityBacklog('P2')` must be **10**. If it is 25, P2b has not landed; stop and run it first.

- [ ] **Step 2: Add the barrel type exports** — `export type * from './checks/{maintenance,sequences,settings,space}.js';` Task 7 needs `SettingsData` as a `StatusBar` prop, and Task 6's pages need the row types.

- [ ] **Step 3: Wire the imports and `CHECKS`** — eight names, alphabetical order preserved.

- [ ] **Step 4: Flip the ten entries**

| # | id | # | id |
|---|---|---|---|
| 37 | `databaseSize` | 46 | `vacuumProgress` |
| 38 | `relationSizes` | 52 | `sequences` |
| 39 | `tableSizes` | 53 | `sequences` |
| 43 | `maintenanceInfo` | 54 | `sequences` |
| 45 | `autovacuumDanger` | 56 | `settings` |

**#52, #53 and #54 all map to the one `sequences` check.** Verified as permitted: `registry.test.ts` has no uniqueness assertion, and there is precedent — #49 and #51 both map to `replicationLag`, and #1/#2/#3/#48 all map to `identity`. The registry forbids naming a check that does not exist; it does not forbid naming one twice.

- [ ] **Step 5: Add `'P2'` to `COMPLETE_PHASES`**

```typescript
export const COMPLETE_PHASES: readonly Phase[] = ['P0', 'P1', 'P3', 'P2'];
```

Order within this array does not matter — `registry.test.ts` does `PHASE_ORDER.filter(p => COMPLETE_PHASES.includes(p))`, which is order-insensitive. (Revision 1 claimed otherwise.) Append anyway, so the array reads in build order.

- [ ] **Step 6: Run the gate** — `npm test`. If `owes nothing for a phase that is already complete` fails, it names the entries still owed; fix those rather than reverting Step 5. That is the gate doing its job.

- [ ] **Step 7: Run everything** — `npm test && npm run test:web && npm run test:int && npm run typecheck:test`.

- [ ] **Step 8: Commit** — `git commit -m "feat(checks): close phase P2"`

---

### Task 9: The v2 documentation

§8: the registry is the authority, and prose restating a number the registry owns is what rotted in the first place.

**Files:** `README.md`, `CHANGELOG.md`, three `package.json`

- [ ] **Step 1: Get the real numbers.** Import the built registry and print shipped / declined / remaining. **Do not count by hand and do not trust this plan's arithmetic** — that is the whole §8 lesson.

- [ ] **Step 2: Rewrite the README's "What v1 is, and what v2 adds".** It is written in the future tense and points at the spec. Make it describe what shipped, and **delete the line telling readers to keep pgHero for the weekly hygiene pass** — no longer true, and exactly the kind of claim that rots silently.

- [ ] **Step 3: Update the parity table** with the Step 1 numbers.

- [ ] **Step 4: Add the CHANGELOG entry.** `## [2.0.0]` — major, because the nav gained a tab and the console's shape changed. List the routes, and carry the divergences new in this release: bytes not `pretty_size`; `null` not `'Insufficient data'`; settings in one round trip; `sequence_danger` against the column type; and Ruling 1's decision that #45 ships as a list rather than an alarm.

- [ ] **Step 5: Bump all three `package.json` versions to 2.0.0.**

- [ ] **Step 6: Verify no stale claim survives** — `grep -niE "hygiene half|not here yet|next phase|is the next" README.md`. Every hit must be historical or rewritten.

- [ ] **Step 7: Commit** — `git commit -m "docs: v2 — the hygiene half ships"`

---

## Done when

- `parityBacklog('P2')` returns **0**, `'P2'` is in `COMPLETE_PHASES`, and the phase gate is green.
- The nav shows five tabs and every gate has one.
- `/cleanup` polls; its three sub-routes do not, and the `<Refresh>` guard proves it.
- Every query has been run against a live server by its own integration test — **nothing here ships on the strength of having been written down.**
- `npm test`, `npm run test:web`, `npm run test:int`, `npm run typecheck:test` all pass.
- The README's parity numbers come from `parityBacklog`, not from this plan.

**Still not done after this, correctly** (§7): no CLI, no `/doctor` roll-up, no hygiene signal on the overview, no history or trend data for hygiene (P4), no `analyze` or `reset_stats` actions (P5). P2 is read-only.
