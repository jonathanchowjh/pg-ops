import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { withConsole } from './harness.js';

// The literal header name, not an import from lib/auth: this file runs under
// the root config's `integration` project (Client, real Postgres), which —
// unlike apps/web/vitest.config.ts's `web` project — configures no `@` alias,
// so `@/lib/auth` does not resolve here. lib/auth.ts exports ACTOR_HEADER as
// this same string, and proxy.test.ts / actions.test.ts pin that from the
// `web` project.
const ACTOR_HEADER = 'x-pgops-user';

const ALLOWED = { PGOPS_ALLOW_ACTIONS: 'true' };

// The same path vitest.config.ts pins PGOPS_AUDIT_LOG to for the
// `integration` project. Read directly rather than re-derived, so a typo
// here fails the assertion instead of silently agreeing with itself.
const AUDIT_LOG = join(tmpdir(), 'pgops-integration-tests', 'audit.log');

function readAuditRecords(): Record<string, unknown>[] {
  // Missing is empty, not a throw. The positive assertions below all write a
  // record before they read, so they never depend on this; the CSRF test's
  // NEGATIVE assertion ("no record was written") would otherwise fail with
  // ENOENT on the first run on a machine where no kill has ever been audited.
  let text: string;
  try {
    text = readFileSync(AUDIT_LOG, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function kill(baseUrl: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return act(baseUrl, 'kill', body, extraHeaders);
}

/** Every action route, by its path segment. `kill` is the special case that
 * predates the rest and keeps its own name above. */
async function act(
  baseUrl: string, path: string, body: unknown, extraHeaders: Record<string, string> = {},
) {
  return fetch(`${baseUrl}/api/db/primary/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

/** The four routes P5 added, beside the kill route they share a preamble with. */
const P5_ROUTES = ['kill-long-running', 'reset-query-stats', 'reset-stats', 'analyze'] as const;

describe('the kill route', () => {
  /**
   * Spec §9's "Action gating" row, asserted against the route rather than the
   * UI. The server here is started with PGOPS_ALLOW_ACTIONS unset — which is
   * also the default, so this is the shape every deployment has until someone
   * opts in.
   */
  it('does not exist when PGOPS_ALLOW_ACTIONS is unset', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(baseUrl, { pid: 1, backendStart: null, reason: 'x' });
      expect(res.status).toBe(404);
    });
  });

  /**
   * The half the POST-only test above could not see. `route.ts` exports only
   * POST, so Next's app-route dispatch answered every OTHER method 405 before
   * the handler — and therefore before `actionsAllowed` — ever ran. A build
   * without the file answers 404, so `GET /api/db/<name>/kill -> 405` was a
   * reliable oracle that a console had the kill endpoint compiled in, however
   * firmly the flag was left unset. That is precisely the disclosure the 404
   * exists to prevent, and both README.md and route.ts asserted it did not
   * happen.
   *
   * Asserted against a real server rather than against `proxy()` directly:
   * the unit test in proxy.test.ts pins the decision, but the property being
   * claimed is about Next's DISPATCH, so only a booted console can show the
   * 405 is gone. Compared byte-for-byte against a path with no route at all,
   * because "indistinguishable" is the actual claim — not merely "also 404".
   */
  it('is indistinguishable from a build without the file, on every method', async () => {
    await withConsole(async ({ baseUrl }) => {
      const methods = ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

      const control = await fetch(`${baseUrl}/api/db/primary/no-such-route`);
      expect(control.status).toBe(404);

      for (const method of methods) {
        const res = await fetch(`${baseUrl}/api/db/primary/kill`, { method });
        expect(res.status, `${method} leaked the route`).toBe(control.status);
      }
    });
  });

  it('terminates a real backend, refuses a stale identity, and reports a dead pid', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      // A real, idle client backend to kill.
      const victim = new Client({ connectionString: url });
      // pg_terminate_backend closes the socket out from under this client,
      // which node-postgres surfaces as an 'error' event ("terminating
      // connection due to administrator command") independent of whatever
      // `victim.query`/`victim.end()` call happens to be in flight at the
      // time. An EventEmitter with no 'error' listener makes Node treat that
      // as an uncaught exception — observed nondeterministically failing this
      // suite depending on exactly when the socket event lands relative to
      // the test's own assertions. This is the expected, intended
      // consequence of the kill under test, not a real failure; same pattern
      // as lib/pools.ts's own `pool.on('error', () => {})`.
      victim.on('error', () => {});
      await victim.connect();
      const { rows } = await victim.query<{ pid: number; backend_start: string }>(
        'SELECT pg_backend_pid() AS pid, backend_start::text AS backend_start ' +
        'FROM pg_stat_activity WHERE pid = pg_backend_pid()',
      );
      const target = rows[0]!;

      // Wrong identity for a live pid: the guard must refuse rather than kill
      // whatever now answers to that number. This is the PID-reuse case, and
      // it runs BEFORE the successful kill so the pid is known to be live.
      const stale = await kill(baseUrl, {
        pid: target.pid,
        backendStart: '1999-01-01T00:00:00Z',
        reason: 'stale identity',
      });
      expect(stale.status).toBe(200);
      expect(await stale.json()).toEqual({ outcome: 'session-changed' });

      const good = await kill(baseUrl, {
        pid: target.pid,
        backendStart: target.backend_start,
        reason: 'integration test',
      });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ outcome: 'terminated' });
      await victim.end().catch(() => {});

      const absent = await kill(baseUrl, {
        pid: 999_999,
        backendStart: '2026-01-01T00:00:00Z',
        reason: 'no such pid',
      });
      expect(await absent.json()).toEqual({ outcome: 'gone' });
    }, ALLOWED);
  });

  /**
   * R14 (final review): CSRF. `req.json()` ignores Content-Type, and HTTP
   * basic-auth credentials ride cross-site automatically — there is no
   * SameSite equivalent for the `Authorization` header, so an operator with
   * the console open who visits a hostile page issues whatever this route
   * accepts. A cross-origin `<form enctype="text/plain">` can post a body
   * that parses as JSON; requiring `application/json` is what closes that,
   * because a form's `enctype` may only be
   * application/x-www-form-urlencoded, multipart/form-data or text/plain.
   *
   * The audit half of this assertion is the half that matters. The PID-reuse
   * guard already means no backend dies (the attacker cannot guess
   * `backend_start`, and `backendStart: null` never matches), but nothing
   * stopped a forged request authoring unlimited audit records with an
   * attacker-chosen `reason`, attributed to a real authenticated operator, in
   * the log this project calls the mitigation for the malicious-operator
   * threat.
   */
  it('refuses a body that is not application/json with 415, and audits nothing', async () => {
    const reason = `csrf check ${randomUUID()}`;
    await withConsole(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/db/primary/kill`, {
        method: 'POST',
        // Exactly what a cross-origin `<form enctype="text/plain">` sends —
        // and the body is valid JSON, so nothing but the header stops it.
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ pid: 999_999, backendStart: null, reason }),
      });
      expect(res.status).toBe(415);

      const records = readAuditRecords().filter(
        (r) => r.action === 'kill' && r.reason === reason,
      );
      expect(records).toEqual([]);
    }, ALLOWED);
  });

  it('rejects a body with no reason', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(baseUrl, { pid: 1, backendStart: null, reason: '   ' });
      expect(res.status).toBe(400);
    }, ALLOWED);
  });

  /**
   * `backendStart` is the PID-reuse guard's input, and `null` is a MEANINGFUL
   * value there: it says "I did not capture an identity, kill on pid alone".
   * An ABSENT field meant the same thing to every caller that wrote one, but
   * the check was `backendStart !== null && typeof backendStart !== 'string'`,
   * and `undefined` fails both halves — so omitting the field was rejected
   * with a message that explicitly offers null as a legal value.
   */
  it('treats an absent backendStart as null rather than rejecting it', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(baseUrl, { pid: 999_999, reason: 'absent backendStart' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: 'gone' });
    }, ALLOWED);
  });

  /**
   * Ordering, not just acceptance. `reason` is the only field a human writes
   * and the only one that makes an audit record mean anything six months on,
   * so a body missing both must name it — a caller told only about
   * `backendStart` fixes that, retries, and is rejected a second time.
   */
  it('names the missing reason first when a body is missing both fields', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(baseUrl, { pid: 1 });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/reason/i);
    }, ALLOWED);
  });

  it('is 404 for a database that is not configured', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/db/nosuchdb/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 1, backendStart: null, reason: 'x' }),
      });
      expect(res.status).toBe(404);
    }, ALLOWED);
  });

  /**
   * The Global Constraint says the gate is checked "before the body is parsed
   * and before the database is resolved". That is TWO claims, and the earlier
   * version of this test pinned one of them.
   *
   * `{"pid":"x"}` against `/api/db/nosuchdb/kill` discriminates the BODY half
   * — a gate below body validation answers 400, not 404. It does not
   * discriminate the database half: move the gate below `contextFor` and
   * `nosuchdb` still 404s, because `UnknownDatabaseError` has its own 404
   * path. The assertion stayed green against the mutation it claimed to
   * catch. (F11, final review — the old docblock hedged around exactly this.)
   *
   * What discriminates the database half is a CONFIGURED name whose host
   * cannot be reached: `contextFor` gets past the name lookup and fails on
   * the connection, which is a 502. So this test makes two requests, one for
   * each half, and neither one alone would do.
   *
   * Both mutations were run against this version:
   *   gate below body validation  → request 1 answers 400  (red)
   *   gate below contextFor       → request 2 answers 502  (red)
   *
   * Port 1 on loopback refuses immediately, so request 2 costs nothing; the
   * overview page the harness waits on renders fine against it (every check
   * comes back `unreachable`, which is a 200 page).
   */
  it('checks the gate before parsing the body AND before resolving the database', async () => {
    const UNREACHABLE = JSON.stringify([
      { name: 'unreachable', url: 'postgres://u:p@127.0.0.1:1/postgres' },
    ]);
    await withConsole(async ({ baseUrl }) => {
      // The body half: `pid` is not a number, so anything below body
      // validation answers 400.
      const badBody = await fetch(`${baseUrl}/api/db/nosuchdb/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 'x' }),
      });
      expect(badBody.status).toBe(404);

      // The database half: a well-formed body against a CONFIGURED database
      // whose host refuses, so anything below `contextFor` answers 502.
      const unreachableDb = await fetch(`${baseUrl}/api/db/unreachable/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 1, backendStart: null, reason: 'gate ordering' }),
      });
      expect(unreachableDb.status).toBe(404);
    }, { PGOPS_DATABASES: UNREACHABLE });
  });

  /**
   * I1 (review): `ACTIONS.kill` rethrows on a real query failure (kill.ts's
   * catch logs `result: "error: …"` to the audit record, then rethrows).
   * Left uncaught, that surfaces as a bare Next 500 with no JSON body — and
   * Task 4's client calls `res.json()` unconditionally, which then throws on
   * exactly the error an operator most needs to read. This triggers a REAL
   * query failure rather than a mock: `backendStart` passes the route's own
   * `typeof … === 'string'` validation but is not a valid timestamp, so
   * `$2::timestamptz` fails inside kill.ts's SQL — the same failure shape a
   * missing `pg_signal_backend` grant would produce (a rethrown query
   * error), without needing to provision an unprivileged role in the test
   * container.
   */
  it('answers 502 with a JSON body when the kill itself fails, and still audits the error', async () => {
    const reason = `bad-timestamp-check ${randomUUID()}`;
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(baseUrl, { pid: 1, backendStart: 'not-a-timestamp', reason });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/invalid input syntax/i);

      const records = readAuditRecords().filter(
        (r) => r.action === 'kill' && r.reason === reason,
      );
      expect(records).toHaveLength(1);
      expect(records[0]!.result).toMatch(/^error:/);
    }, ALLOWED);
  });

  /**
   * C3: Task 2 unit-tested that `proxy()` strips a client-supplied
   * `x-pgops-user` header (proxy.test.ts). That is necessary but not
   * sufficient — it proves the header doesn't survive the proxy, not that
   * the thing actually consuming the header (this route, via the audit
   * record it writes) can't be fooled by some other path. This is the
   * end-to-end version: a real server, real basic auth, a forged header
   * riding alongside valid credentials, and an assertion on the actual
   * audit record that lands on disk.
   */
  it('audits the authenticated user, not a forged x-pgops-user header', async () => {
    const creds = Buffer.from('realuser:realpass').toString('base64');
    // The audit log is a real append-only file that outlives one `npm run
    // test:int` invocation (it lives at a fixed path under the OS temp dir,
    // not a per-run mkdtemp), so a fixed reason string collides with records
    // any earlier run of THIS test left behind. A unique reason per run is
    // what makes "exactly one matching record" a meaningful assertion rather
    // than one that depends on how many times this file has been run before.
    const reason = `forgery check ${randomUUID()}`;
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(
        baseUrl,
        { pid: 999_999, backendStart: '2026-01-01T00:00:00Z', reason },
        {
          authorization: `Basic ${creds}`,
          [ACTOR_HEADER]: 'mallory',
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: 'gone' });

      const records = readAuditRecords().filter(
        (r) => r.action === 'kill' && r.reason === reason,
      );
      expect(records).toHaveLength(1);
      const user = records[0]!.user as string;
      expect(user).not.toMatch(/mallory/);
      // The proxy strips the forged header and sets the REAL authenticated
      // username instead, so the recorded actor is the basic-auth user.
      expect(user).toMatch(/^realuser@/);
    }, { ...ALLOWED, PGOPS_USERNAME: 'realuser', PGOPS_PASSWORD: 'realpass' });
  });

  /**
   * Ruling R8 (review): the plan's own text promised "PGOPS_PUBLIC_HOST or
   * the request host", and only the fallback half had shipped —
   * `new URL(req.url).host` reflects whatever Host header the CALLER sent,
   * which is not the resolvable, operator-chosen host the audited field
   * exists to name. Set `PGOPS_PUBLIC_HOST` and confirm it — not the
   * server's own `127.0.0.1:<port>` — is what lands in the record.
   */
  it('audits PGOPS_PUBLIC_HOST as the host, when the operator has set one', async () => {
    const reason = `public-host check ${randomUUID()}`;
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(baseUrl, { pid: 999_999, backendStart: '2026-01-01T00:00:00Z', reason });
      expect(res.status).toBe(200);

      const records = readAuditRecords().filter(
        (r) => r.action === 'kill' && r.reason === reason,
      );
      expect(records).toHaveLength(1);
      const user = records[0]!.user as string;
      expect(user).toBe('anonymous@ops.example.internal');
    }, { ...ALLOWED, PGOPS_PUBLIC_HOST: 'ops.example.internal' });
  });
});

describe('the P5 action routes', () => {
  /**
   * The same claim the kill route makes, for every route that now shares its
   * preamble: a flagless deployment is indistinguishable from a build without
   * the file. Compared byte-for-byte against a path with no route at all,
   * because "indistinguishable" is the claim — not merely "also 404".
   *
   * Every method, because route.ts exports only POST and Next's app-route
   * dispatch answers the others 405 before userland runs. proxy.ts is what
   * holds this, and this is the test that would notice if its matcher ever
   * stopped covering one of these paths.
   */
  it('are indistinguishable from a build without the files, on every method', async () => {
    await withConsole(async ({ baseUrl }) => {
      const control = await fetch(`${baseUrl}/api/db/primary/no-such-route`);
      expect(control.status).toBe(404);

      for (const path of P5_ROUTES) {
        for (const method of ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
          const res = await fetch(`${baseUrl}/api/db/primary/${path}`, { method });
          expect(res.status, `${method} ${path} leaked the route`).toBe(control.status);
        }
      }
    });
  });

  /**
   * Tier 2, enforced server-side. A confirmation the browser alone checks is
   * one curl away from bypassed, which is the whole reason openAction compares
   * it rather than trusting the control.
   */
  it('refuse a tier-2 action with no typed confirmation', async () => {
    await withConsole(async ({ baseUrl }) => {
      for (const path of ['kill-long-running', 'reset-query-stats', 'reset-stats']) {
        const res = await act(baseUrl, path, { reason: 'x', targets: [{ pid: 1, backendStart: null }] });
        expect(res.status, path).toBe(400);
        expect((await res.json()).error, path).toMatch(/confirm/);
      }
    }, ALLOWED);
  });

  it('refuse a tier-2 action whose confirmation names the wrong database', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await act(baseUrl, 'reset-stats', { reason: 'x', confirm: 'not-primary' });
      expect(res.status).toBe(400);
    }, ALLOWED);
  });

  it('perform a tier-2 action when the confirmation matches, and audit it', async () => {
    await withConsole(async ({ baseUrl }) => {
      const before = readAuditRecords().length;
      const res = await act(baseUrl, 'reset-stats', { reason: 'integration', confirm: 'primary' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });

      const written = readAuditRecords().slice(before);
      expect(written.some((r) => r.action === 'reset-stats' && r.reason === 'integration')).toBe(true);
    }, ALLOWED);
  });

  /**
   * Tier 1: analyze refreshes statistics rather than destroying them, so the
   * gate and an inline confirmation are the whole ladder for it. No `confirm`
   * in this body, and it must still succeed.
   */
  it('run analyze without a typed confirmation, and report per-table results', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await act(baseUrl, 'analyze', { reason: 'integration', limit: 5 });
      expect(res.status).toBe(200);
      const body = await res.json() as { results: { relation: string; ok: boolean }[] };
      expect(Array.isArray(body.results)).toBe(true);
    }, ALLOWED);
  });

  it('reject a bulk kill whose targets are not a bounded array', async () => {
    await withConsole(async ({ baseUrl }) => {
      const bad = [
        { reason: 'x', confirm: 'primary', targets: 'not an array' },
        { reason: 'x', confirm: 'primary', targets: [] },
        { reason: 'x', confirm: 'primary', targets: [{ pid: 'no', backendStart: null }] },
        { reason: 'x', confirm: 'primary',
          targets: Array.from({ length: 101 }, (_, i) => ({ pid: i + 1, backendStart: null })) },
      ];
      for (const body of bad) {
        const res = await act(baseUrl, 'kill-long-running', body);
        expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      }
    }, ALLOWED);
  });

  /**
   * The audit records the authenticated operator, never a header the caller
   * supplied — proxy.ts deletes any client copy before setting its own. The
   * kill route asserts this for itself; these hold it through openAction, so
   * a regression there would break every action at once.
   */
  it('audit the authenticated user, not a forged x-pgops-user header', async () => {
    await withConsole(async ({ baseUrl }) => {
      const before = readAuditRecords().length;
      const res = await act(baseUrl, 'reset-stats',
        { reason: 'forged?', confirm: 'primary' }, { [ACTOR_HEADER]: 'mallory' });
      expect(res.status).toBe(200);

      const written = readAuditRecords().slice(before)
        .filter((r) => r.action === 'reset-stats');
      expect(written.length).toBeGreaterThan(0);
      for (const r of written) expect(String(r.user)).not.toMatch(/^mallory@/);
    }, ALLOWED);
  });
});

/**
 * The pages that mount a confirmation control, fetched with actions ON.
 *
 * Every other test in this file posts to an API route. None of them renders a
 * page, and every page test outside this file runs with actions off — where
 * `ConfirmAction` is never mounted. So until this block existed, nothing in the
 * suite ever serialised a `ConfirmAction` across the server–client boundary,
 * and v2.2.0 shipped two pages that answer 500 the moment the flag is set:
 * both handed the client component a `describe` FUNCTION, which React refuses
 * to serialise. The component tests render pages directly and cannot see it;
 * only a real `next start` can. The actions-off runs passing is exactly what
 * hid this, which is why this block exists and why it must stay actions-on.
 *
 * `/sessions` mounts "Terminate all" only when something runs past the
 * long-running floor (60 s, the check's warn threshold), so that half holds a
 * `pg_sleep` open past it before fetching. That wait is the cost of testing
 * the page an operator opens during a pile-up, which is when this broke.
 */
describe('pages that mount a confirmation, with actions on', () => {
  it('renders /cleanup/maintenance with the analyze control, and /sessions with Terminate all', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      const maintenance = await fetch(`${baseUrl}/db/primary/cleanup/maintenance`);
      expect(maintenance.status).toBe(200);
      expect(await maintenance.text()).toContain('Analyze tables');

      const sleeper = new Client({ connectionString: url, application_name: 'p7a-sleeper' });
      await sleeper.connect();
      // Not awaited: it has to be RUNNING while the page renders.
      const running = sleeper.query('SELECT pg_sleep(150)').catch(() => {});
      try {
        await new Promise((r) => setTimeout(r, 62_000));
        const sessions = await fetch(`${baseUrl}/db/primary/sessions`);
        expect(sessions.status).toBe(200);
        expect(await sessions.text()).toContain('Terminate all');
      } finally {
        await sleeper.end().catch(() => {});
        await running;
      }
    }, ALLOWED);
  }, 300_000);
});
