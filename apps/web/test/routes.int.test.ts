import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { withConsole } from './harness.js';

describe('/ overview', () => {
  it('lists every configured database with a verdict', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(baseUrl)).text();
      expect(html).toContain('primary');
      expect(html).toMatch(/OK|WARN|CRITICAL/);
    });
  }, 180_000);

  /**
   * The build baked in NOTHING about which database to talk to: the harness
   * builds the app, then starts it with PGOPS_DATABASES pointing at a
   * container that did not exist at build time. If the page rendered without
   * `connection()`, this route would have been PRERENDERED -- its body evaluated
   * in the build process, against the build machine's environment -- and
   * this test would show an empty or wrong database list.
   *
   * The negative assertion checks for the rendered LINK (`/db/default`), not
   * a bare `'default'` substring: every Next page's RSC payload embeds the
   * literal string `"default"` dozens of times as an ES module default-export
   * marker, unrelated to `readDatabases`'s single-database fallback name.
   * `toContain('default')` fails on that noise regardless of what the page
   * actually rendered — asserting on the real page content, not on that
   * plumbing, is what makes this a check on the ARTIFACT rather than a
   * coin flip on how many internal export names Next's bundler happens to
   * name `default` this build.
   */
  it('reads its database configuration at run time, not build time', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(baseUrl)).text();
      expect(html).toContain('primary');
      expect(html).not.toContain('/db/default');
    });
  }, 180_000);
});

describe('/db/[name] triage', () => {
  it('renders every incident check on one screen', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(`${baseUrl}/db/primary`)).text();
      for (const title of ['Connections', 'Sessions', 'Blocked', 'Long-running', 'Lock wait graph']) {
        expect(html).toContain(title);
      }
    });
  }, 180_000);

  /**
   * An unknown database must be a 404, not a 500 and not an empty page. A 500
   * reads as "pgops is broken"; a 404 reads as "you typed the wrong name",
   * which is what actually happened.
   */
  it('404s for a database that is not configured', async () => {
    await withConsole(async ({ baseUrl }) => {
      const r = await fetch(`${baseUrl}/db/nope`);
      expect(r.status).toBe(404);
    });
  }, 180_000);

  /**
   * A check that cannot run must render as unavailable, NOT be omitted. An
   * omitted panel reads as "nothing to report" during an incident. Proven by
   * pg_stat_statements simply not being installed in the plain postgres
   * image, rather than by mocking.
   *
   * The brief's original assertion here also matched `/pg_stat_statements/`
   * in the rendered message text. Weakened per task-8's corrections: that
   * string was written from memory, not from a real run. See
   * task-8-report.md for the actual message text observed.
   */
  it('renders an unavailable check rather than omitting it', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(`${baseUrl}/db/primary`)).text();
      expect(html).toContain('Query statistics');
      expect(html).toMatch(/Unavailable/);
    });
  }, 180_000);
});

describe('/db/[name]/sessions and /locks', () => {
  /**
   * Two fetches, because of the pgops fold — and the reason this test now
   * asks for `?pgops=show` is a defect it caught rather than a concession.
   *
   * On this harness the console is the ONLY client of its own database, so
   * the default view folds every row away and there is genuinely nothing
   * left to list. That used to render a table header over an empty body,
   * with the explanation below the fold: indistinguishable, on the page an
   * operator opens to find out what is connected, from a query that returned
   * nothing. The default URL now says so where the rows would be, and this
   * asserts BOTH halves — the empty state, and that the rows really are one
   * click away with their pid and state intact.
   */
  it('lists live sessions with pid, state and age', async () => {
    await withConsole(async ({ baseUrl, sql }) => {
      await sql("SELECT pg_sleep(0)");
      const folded = await (await fetch(`${baseUrl}/db/primary/sessions`)).text();
      expect(folded).toContain('Nothing but pgops');
      expect(folded).toContain('show them');

      const shown = await (await fetch(`${baseUrl}/db/primary/sessions?pgops=show`)).text();
      expect(shown).toContain('pid');
      expect(shown).toMatch(/active|idle/);
    });
  }, 180_000);

  /**
   * Truncation must be VISIBLE. A partial list an operator knows is partial is
   * useful; one they believe is complete is worse than nothing — they will
   * conclude the session they are hunting does not exist.
   *
   * Correction to the brief (see task-9-report.md): the brief's version of
   * this test fetched `?limit=1` and trusted that SOME other backend was
   * already connected to make `total_matching > 1` true, which only holds by
   * ambient accident. Two extra `pg.Client` connections are opened directly
   * against the container and held open across the fetch, so
   * `total_matching` (every client backend except the check's own, per
   * sessions.ts's WHERE clause) is guaranteed to be at least 2 regardless of
   * ambient state, rather than left to whatever happens to already be
   * connected. See task-9-report.md for a recorded caveat: on the harness's
   * own dev machine this repo was built on, ambient state already produces
   * enough backends on its own (an artifact of `next start` against an
   * `output: standalone` build — the harness's own pre-existing choice, out
   * of this task's scope), so dropping this block does not currently fail
   * the test there. The two connections stay, correctly, as the only thing
   * that makes the guarantee explicit rather than incidental — an
   * environment where that ambient noise is absent (a leaner container, a
   * future harness fix to use the standalone server directly) is exactly
   * the "quieter machine" this test is written to survive.
   */
  it('says so when the session list was truncated', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      const extra = [new Client({ connectionString: url }), new Client({ connectionString: url })];
      await Promise.all(extra.map((c) => c.connect()));
      try {
        const html = await (await fetch(`${baseUrl}/db/primary/sessions?limit=1`)).text();
        expect(html).toMatch(/showing|truncated|more/i);
      } finally {
        await Promise.all(extra.map((c) => c.end().catch(() => {})));
      }
    });
  }, 180_000);

  it('renders the wait graph, and says so when nothing is blocking', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(`${baseUrl}/db/primary/locks`)).text();
      expect(html).toContain('Lock wait graph');
      expect(html).toMatch(/No blocking/i);
    });
  }, 180_000);
});

describe('/db/[name]/queries', () => {
  /**
   * pg_stat_statements is not installed in the plain postgres image, so this
   * check necessarily fails — and that is the assertion worth making: the page
   * must say the extension is missing, not render an empty table that reads as
   * "this database runs no queries".
   */
  it('says the extension is missing rather than showing an empty table', async () => {
    await withConsole(async ({ baseUrl }) => {
      const r = await fetch(`${baseUrl}/db/primary/queries`);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toMatch(/Unavailable/);
      // Observed for real in Task 8, not invented: reason `missing-extension`,
      // message `relation "pg_stat_statements" does not exist`, remedy
      // `CREATE EXTENSION pg_stat_statements;`.
      expect(html).toMatch(/pg_stat_statements/);
    });
  }, 180_000);
});

/**
 * C2 and C1 (final review). Both properties this phase rests on were green
 * under every gate the phase built — 490 unit tests, 43 web tests, 54
 * integration tests, four typechecks and four source-scanning guards — and
 * both were broken. These two tests are the end-to-end halves that no source
 * scan and no unit test can stand in for: they seed a real database with the
 * exact condition the property is about, fetch the real pages out of the real
 * production build, and read the real HTML.
 */
describe('the two properties, end to end', () => {
  /** Distinctive enough that a match cannot be coincidence. */
  const SENTINEL = 'hunter2sentinel';
  const ROUTES = [
    '', '/db/primary', '/db/primary/sessions', '/db/primary/locks', '/db/primary/queries',
    // Neither new P2 route (Tables list, Table page) had ANY integration
    // coverage until now — both were exercised only by unit tests with a
    // wholesale-mocked `@/lib/check`. The Table page is deliberately left
    // out: it needs a real relation name to fetch, which this block's fixed
    // ROUTES array has no way to seed, and richer seeded assertions for it
    // are deferred work, not something to invent a new pattern for here. The
    // list route needs no relation, so it costs nothing to add: it gets
    // fetched and checked for a leaked password exactly like its siblings.
    '/db/primary/tables',
  ];

  /**
   * The redaction guard in guards.test.ts is a source scan, and a source scan
   * is a heuristic: it walked `app/` only and matched one spelling of the
   * violation, so a `components/session-row.tsx` rendering `{s.query}`, a
   * destructured `{query}` and a truncating `{s.query?.slice(0, 120)}` all put
   * an unredacted `pg_stat_activity.query` on a URL with tsc clean and every
   * gate green. The guard is widened now, but the guarantee cannot rest on a
   * regex — this does, and it catches a bypass of ANY shape.
   *
   * Two backends are held open across the fetches, because `sql()` closes its
   * connection and takes the backend (and its `query` text) with it:
   *
   *  - an IDLE one whose last statement was a `CREATE ROLE … PASSWORD '…'`.
   *    pg_stat_activity keeps the last statement of an idle session, which is
   *    exactly how a password ends up on the sessions page long after the
   *    statement finished. Exercises redactSecrets' SQL-spelling rule.
   *  - an ACTIVE one running a statement containing a connection URI.
   *    Exercises the `scheme://user:password@host` rule.
   *
   * The `***` assertion is what stops this passing vacuously: it proves the
   * seeded statements genuinely reached the page and were masked there, rather
   * than the page having failed to render any session at all.
   */
  it('leaks no password on any route that can render a query', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      const idle = new Client({ connectionString: url });
      const busy = new Client({ connectionString: url });
      const holder = new Client({ connectionString: url });
      const waiter = new Client({ connectionString: url });
      await Promise.all([idle.connect(), busy.connect(), holder.connect(), waiter.connect()]);
      try {
        // BEFORE the CREATE ROLE below, so pg_stat_statements captures it.
        // Utility statements are stored VERBATIM -- constants are normalised to
        // $1 only for non-utility statements -- which is precisely why a
        // password reaches the queries page at all.
        await idle.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');

        // Route 1, /sessions: pg_stat_activity keeps the LAST statement of an
        // idle session, which is how a password outlives the statement.
        await idle.query(`CREATE ROLE leaky_probe LOGIN PASSWORD '${SENTINEL}'`);

        // Route 1 again, active: the scheme://user:password@host rule.
        void busy
          .query(`SELECT pg_sleep(120), 'postgres://pgops:${SENTINEL}@db.internal:5432/app'`)
          .catch(() => {});

        // Route 2, /locks: a waiter's query is rendered per node in the graph,
        // so contention is REQUIRED for that route to render any query text at
        // all. Without this the route returns "No blocking." and a leak there
        // could never be observed -- which is exactly how the first version of
        // this test passed while covering only one of the five routes it
        // fetched.
        await holder.query('CREATE TABLE IF NOT EXISTS leaky_t (v text)');
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE leaky_t IN ACCESS EXCLUSIVE MODE');
        void waiter
          .query(`UPDATE leaky_t SET v = 'postgres://pgops:${SENTINEL}@db.internal:5432/app'`)
          .catch(() => {});

        await new Promise((r) => setTimeout(r, 1_500));

        const pages = await Promise.all(
          ROUTES.map(async (r) => [r, await (await fetch(`${baseUrl}${r}`)).text()] as const),
        );
        for (const [route, html] of pages) {
          expect(html, `${route} leaked the password`).not.toContain(SENTINEL);
        }

        /**
         * The positive half, and the half that stops this test rotting.
         *
         * "Must not contain X" passes trivially on a page that rendered no
         * query text -- a 500, an empty list, an Unavailable panel. The first
         * version of this test asserted the mask on /sessions only, so /locks
         * (no contention) and /queries (extension never created) were fetched
         * but proved nothing, and a raw-rendered query on either shipped with
         * every gate green. Asserting the MASK on all three routes that can
         * render a query is what makes the negative assertion above mean
         * something on each of them.
         */
        const byRoute = new Map(pages);
        for (const route of ['/db/primary/sessions', '/db/primary/locks', '/db/primary/queries']) {
          expect(byRoute.get(route), `${route} rendered no masked query, so it proves nothing`)
            .toContain('***');
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
   * C1: `/` computed its verdict from nine of twelve incident checks, because a
   * cast erased `runCheckFor`'s arity overloads and `longRunning`, `queryStats`
   * and `sessions` were called with no options — throwing inside `runCheck`,
   * which never rejects, so they came back as three permanently "unavailable"
   * panels indistinguishable from three checks the database would not answer.
   * `longRunning` is the check whose entire job is escalating a runaway query,
   * and on the front door it could never run at all: a 40-minute runaway
   * rendered as `OK · 3 unavailable`.
   *
   * That shipped through nine tasks because the two overview tests here assert
   * `toContain('primary')` and `/OK|WARN|CRITICAL/` — both of which hold while
   * the verdict is wrong. Nothing ever pointed `/` at a database that was
   * actually unwell. This does.
   *
   * The 60-second wait is not padding: `longRunning`'s `minSecs` and its warn
   * threshold are both 60 (pgHero #9's definition), and the overview
   * deliberately calls it with the defaults an operator gets. Escalating
   * sooner would mean testing options the page does not pass.
   */
  it('reports a real runaway query rather than OK, and nothing as unavailable', async () => {
    await withConsole(async ({ baseUrl, url, sql }) => {
      const runner = new Client({ connectionString: url });
      await runner.connect();
      try {
        // Started FIRST: everything below runs while its clock is already
        // going, so the wait at the end is only what is left over.
        void runner.query('SELECT pg_sleep(600)').catch(() => {});
        const startedAt = Date.now();

        // With the extension created, all twelve incident checks can run on this
        // container — so "unavailable" on a healthy database means a defect,
        // not a missing extension, and the count can be asserted as zero.
        await sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');

        const elapsed = Date.now() - startedAt;
        await new Promise((r) => setTimeout(r, Math.max(0, 65_000 - elapsed)));

        const html = await (await fetch(baseUrl)).text();
        // Before the fix this page rendered `OK · 3 unavailable` here.
        expect(html).toMatch(/WARN|CRITICAL/);
        expect(html).not.toMatch(/unavailable/i);
      } finally {
        await runner.end().catch(() => {});
      }
    });
  }, 300_000);
});
