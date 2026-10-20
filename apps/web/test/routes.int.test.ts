import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { withConsole } from './harness.js';

describe('/ the fleet', () => {
  it('lists every configured database as a row on the clock', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(baseUrl)).text();
      expect(html).toContain('href="/db/primary"');
      expect(html).toContain('sessions not idle');
    });
  }, 180_000);

  /**
   * The harness builds the app, then starts it with PGOPS_DATABASES pointing
   * at a container that did not exist at build time. Without `connection()`
   * the route would be prerendered against the build machine's environment.
   *
   * The negative assertion checks for the rendered link (`/db/default`), not
   * a bare `'default'`: every Next page's RSC payload embeds `"default"` as
   * an ES module default-export marker.
   */
  it('reads its database configuration at run time, not build time', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(baseUrl)).text();
      expect(html).toContain('primary');
      expect(html).not.toContain('/db/default');
    });
  }, 180_000);
});

describe('/db/[name], the tree', () => {
  it('draws the band and says so when nothing needs attention', async () => {
    await withConsole(async ({ baseUrl, sql }) => {
      // An empty database says it is empty and draws nothing else.
      const empty = await (await fetch(`${baseUrl}/db/primary`)).text();
      expect(empty).toContain('This database has no tables and no sessions.');

      await sql('CREATE TABLE quiet_one (v int)');
      // The table list is read at most once a minute per database, and the
      // fetch above just read it empty.
      const html = await (await fetch(`${baseUrl}/db/primary?find=quiet`)).text();
      expect(html).toContain('nothing needs attention');
      expect(html).toContain('sessions not idle');
    });
  }, 180_000);

  /**
   * The whole point of the page, against a real lock manager: one finding
   * that names the root, with the waiter under the table it wants.
   */
  it('shows a real lock chain as one finding on its table', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      const holder = new Client({ connectionString: url });
      const waiter = new Client({ connectionString: url });
      await Promise.all([holder.connect(), waiter.connect()]);
      try {
        await holder.query('CREATE TABLE IF NOT EXISTS chained (v int)');
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE chained IN ACCESS EXCLUSIVE MODE');
        const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        void waiter.query('UPDATE chained SET v = 1').catch(() => {});
        await new Promise((r) => setTimeout(r, 1_500));

        const html = await (await fetch(`${baseUrl}/db/primary`)).text();
        expect(html).toContain('public.chained');
        expect(html).toMatch(/blocks/);
        expect(html).toContain(`pid-${rows[0]!.pid}`);
        expect(html).not.toContain('nothing needs attention');
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await Promise.all([holder.end().catch(() => {}), waiter.end().catch(() => {})]);
      }
    });
  }, 180_000);

  /** A 404, not a 500: the operator typed the wrong name, pgops is not broken. */
  it('404s for a database that is not configured', async () => {
    await withConsole(async ({ baseUrl }) => {
      const r = await fetch(`${baseUrl}/db/nope`);
      expect(r.status).toBe(404);
    });
  }, 180_000);
});

describe('/db/[name]/queries', () => {
  /**
   * pg_stat_statements is not installed in the plain postgres image, so the
   * check fails. An empty table would read as "this database runs no queries".
   */
  it('says the extension is missing rather than showing an empty table', async () => {
    await withConsole(async ({ baseUrl }) => {
      const r = await fetch(`${baseUrl}/db/primary/queries`);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toMatch(/could not be read/);
      // Observed from a real run: reason `missing-extension`, message
      // `relation "pg_stat_statements" does not exist`, remedy
      // `CREATE EXTENSION pg_stat_statements;`.
      expect(html).toMatch(/pg_stat_statements/);
    });
  }, 180_000);
});

/**
 * End-to-end halves that no source scan or unit test can stand in for: seed a
 * real database with the condition, fetch the real pages from the production
 * build, and read the HTML.
 */
describe('the two properties, end to end', () => {
  /** Distinctive enough that a match cannot be coincidence. */
  const SENTINEL = 'hunter2sentinel';
  // A statement's page needs a queryid, which this fixed array cannot seed: the test adds it once the statement runs.
  const ROUTES = [
    '', '/db/primary', '/db/primary/queries',
    '/db/primary/tables', '/db/primary/tables/public.leaky_t',
    // A suggested index names the statements that want it, and those are text.
    '/db/primary/indexes', '/db/primary/indexes?run=suggest',
  ];

  /**
   * The redaction guard in guards.test.ts is a source scan and so a
   * heuristic; this catches a bypass of any shape.
   *
   * Backends are held open across the fetches, because `sql()` closes its
   * connection and takes the backend (and its `query` text) with it:
   *
   *  - an idle one whose last statement was a `CREATE ROLE … PASSWORD '…'`;
   *    pg_stat_activity keeps the last statement of an idle session.
   *    Exercises redactSecrets' SQL-spelling rule.
   *  - an active one running a statement containing a connection URI.
   *    Exercises the `scheme://user:password@host` rule.
   */
  it('leaks no password on any route that can render a query', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      const idle = new Client({ connectionString: url });
      const busy = new Client({ connectionString: url });
      const holder = new Client({ connectionString: url });
      const waiter = new Client({ connectionString: url });
      await Promise.all([idle.connect(), busy.connect(), holder.connect(), waiter.connect()]);
      try {
        // Before the CREATE ROLE below, so pg_stat_statements captures it.
        // Utility statements are stored verbatim (constants are normalised to
        // $1 only for non-utility statements), which is how a password
        // reaches the queries page.
        await idle.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');

        // An idle session's last statement: on no page now, and it must stay off them.
        await idle.query(`CREATE ROLE leaky_probe LOGIN PASSWORD '${SENTINEL}'`);

        // The tree, under "not on any table": the scheme://user:password@host rule.
        void busy
          .query(`SELECT pg_sleep(120), 'postgres://pgops:${SENTINEL}@db.internal:5432/app'`)
          .catch(() => {});

        // The tree opens the table its newest finding is on, so the waiter's
        // statement is drawn without a fold being asked for.
        await holder.query('CREATE TABLE IF NOT EXISTS leaky_t (v text)');
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE leaky_t IN ACCESS EXCLUSIVE MODE');
        void waiter
          .query(`UPDATE leaky_t SET v = 'postgres://pgops:${SENTINEL}@db.internal:5432/app'`)
          .catch(() => {});

        await new Promise((r) => setTimeout(r, 1_500));
        // The busy statement has its own page, keyed on the id Postgres gave it. Not the
        // waiter's: a statement queued on a table lock has no id yet, the lock is taken first.
        const { rows: [running] } = await holder.query<{ id: string | null }>(
          "SELECT query_id::text AS id FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(120)%'");
        expect(running?.id, 'the busy statement has no query_id').toBeTruthy();
        const statement = `/db/primary/queries/${running!.id}`;

        const pages = await Promise.all(
          [...ROUTES, statement].map(async (r) => [r, await (await fetch(`${baseUrl}${r}`)).text()] as const),
        );
        for (const [route, html] of pages) {
          expect(html, `${route} leaked the password`).not.toContain(SENTINEL);
        }

        /**
         * "Must not contain X" passes trivially on a page that rendered no
         * query text (a 500, an empty list, an Unavailable panel). Asserting
         * a seeded statement's shape, its literal a placeholder, on each
         * route that can render a query proves the statements reached it.
         */
        const byRoute = new Map(pages);
        for (const route of ['/db/primary', '/db/primary/queries', '/db/primary/tables/public.leaky_t', statement]) {
          expect(byRoute.get(route), `${route} rendered no seeded statement, so it proves nothing`)
            .toMatch(/pg_sleep\(\$1\)|SET v = \$1/);
        }
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await Promise.all([
          idle.end().catch(() => {}),
          busy.end().catch(() => {}),
          holder.end().catch(() => {}),
          waiter.end().catch(() => {}),
        ]);
      }
    });
  }, 300_000);

  /**
   * Points `/` at a database that is actually busy. The fleet draws what the
   * sampler held of it, so a row reads a session once a tick has run; the
   * wait is for that tick. Nothing on the fleet contacts the database, so
   * nothing on it can be "unavailable".
   */
  it('draws a running session on the fleet, and says nothing is unavailable', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      const runner = new Client({ connectionString: url });
      await runner.connect();
      try {
        void runner.query('SELECT pg_sleep(600)').catch(() => {});
        // The sampler ticks every 15 seconds from boot.
        await new Promise((r) => setTimeout(r, 20_000));
        const html = await (await fetch(baseUrl)).text();
        expect(html).toContain('href="/db/primary"');
        // A reading above zero: the last column is the mean over its samples, the one before the sleep among them.
        expect(html).toMatch(/tabular-nums">(?:0\.[1-9]|[1-9]\d*\.\d)<\/span>/);
        expect(html).not.toMatch(/unavailable|unreachable/i);
      } finally {
        await runner.end().catch(() => {});
      }
    });
  }, 300_000);
});
