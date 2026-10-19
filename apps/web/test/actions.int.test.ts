import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { withConsole } from './harness.js';

// A literal, not an import: the `integration` project has no `@` alias, so
// `@/lib/auth` does not resolve here. actions.test.ts pins the value.
const ACTOR_HEADER = 'x-pgops-user';

const ALLOWED = { PGOPS_ALLOW_ACTIONS: 'true' };

// The path vitest.config.ts pins PGOPS_AUDIT_LOG to for the `integration` project.
const AUDIT_LOG = join(tmpdir(), 'pgops-integration-tests', 'audit.log');

function readAuditRecords(): Record<string, unknown>[] {
  // Missing is empty, not a throw: the CSRF test asserts no record was written,
  // and may run before the file exists.
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

/** Every action route, by its path segment. */
async function act(
  baseUrl: string, path: string, body: unknown, extraHeaders: Record<string, string> = {},
) {
  return fetch(`${baseUrl}/api/db/primary/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

/** The four routes that share a preamble with the kill route. */
const P5_ROUTES = ['kill-long-running', 'reset-query-stats', 'reset-stats', 'analyze'] as const;

describe('the kill route', () => {
  /** Unset is the default, so this is every deployment until someone opts in. */
  it('does not exist when PGOPS_ALLOW_ACTIONS is unset', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(baseUrl, { pid: 1, backendStart: null, reason: 'x' });
      expect(res.status).toBe(404);
    });
  });

  /**
   * `route.ts` exports only POST, so Next's dispatch answers other methods 405
   * before the handler runs, which would reveal the route exists. Needs a real
   * server because the property is about Next's dispatch. Compared against a
   * path with no route, because "indistinguishable" is the claim.
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
      const victim = new Client({ connectionString: url });
      // pg_terminate_backend closes this client's socket, which node-postgres
      // emits as an 'error' event. Without a listener Node treats that as an
      // uncaught exception and fails the suite nondeterministically.
      victim.on('error', () => {});
      await victim.connect();
      const { rows } = await victim.query<{ pid: number; backend_start: string }>(
        'SELECT pg_backend_pid() AS pid, backend_start::text AS backend_start ' +
        'FROM pg_stat_activity WHERE pid = pg_backend_pid()',
      );
      const target = rows[0]!;

      // The PID-reuse case. Runs before the successful kill so the pid is live.
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
   * CSRF. Basic-auth credentials ride cross-site automatically, and a
   * cross-origin `<form enctype="text/plain">` can post a body that parses as
   * JSON; requiring `application/json` closes that. The audit half matters
   * most: a forged request must not author audit records attributed to a real
   * operator.
   */
  it('refuses a body that is not application/json with 415, and audits nothing', async () => {
    const reason = `csrf check ${randomUUID()}`;
    await withConsole(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/db/primary/kill`, {
        method: 'POST',
        // The body is valid JSON, so nothing but the header stops it.
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

  /** `null` means "kill on pid alone"; an omitted field must mean the same. */
  it('treats an absent backendStart as null rather than rejecting it', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(baseUrl, { pid: 999_999, reason: 'absent backendStart' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: 'gone' });
    }, ALLOWED);
  });

  /** Otherwise a caller fixes `backendStart`, retries, and is rejected again. */
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
   * Two requests, one per claim. A bad body shows the gate is above body
   * validation (else 400). It cannot show the gate is above `contextFor`,
   * because an unknown name 404s on its own; a configured name whose host
   * refuses does (else 502). Port 1 on loopback refuses immediately, and the
   * overview page the harness waits on still renders as a 200.
   */
  it('checks the gate before parsing the body AND before resolving the database', async () => {
    const UNREACHABLE = JSON.stringify([
      { name: 'unreachable', url: 'postgres://u:p@127.0.0.1:1/postgres' },
    ]);
    await withConsole(async ({ baseUrl }) => {
      // The body half: `pid` is not a number.
      const badBody = await fetch(`${baseUrl}/api/db/nosuchdb/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 'x' }),
      });
      expect(badBody.status).toBe(404);

      // The database half: a well-formed body, a configured host that refuses.
      const unreachableDb = await fetch(`${baseUrl}/api/db/unreachable/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 1, backendStart: null, reason: 'gate ordering' }),
      });
      expect(unreachableDb.status).toBe(404);
    }, { PGOPS_DATABASES: UNREACHABLE });
  });

  /**
   * `ACTIONS.kill` rethrows on a query failure; uncaught, that is a bare 500
   * with no JSON body, and the client calls `res.json()` unconditionally.
   * The failure is real, not mocked: `backendStart` passes the route's string
   * check but fails `$2::timestamptz` inside kill.ts's SQL.
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
   * End to end: proxy.test.ts shows the proxy strips the header; this shows
   * the audit record on disk cannot be fooled by a forged one.
   */
  it('audits the authenticated user, not a forged x-pgops-user header', async () => {
    const creds = Buffer.from('realuser:realpass').toString('base64');
    // The audit log is a fixed path that outlives a run, so a unique reason
    // is what makes "exactly one matching record" hold.
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
      expect(user).toMatch(/^realuser@/);
    }, { ...ALLOWED, PGOPS_USERNAME: 'realuser', PGOPS_PASSWORD: 'realpass' });
  });

  /** The request host reflects whatever Host header the caller sent. */
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
   * The kill route's claim, for every route sharing its preamble. Fails if
   * proxy.ts's matcher stops covering one of these paths.
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

  /** Tier 2 is enforced server-side, since curl bypasses the browser's check. */
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

  /** Tier 1: analyze refreshes statistics rather than destroying them. One table, named. */
  it('run analyze on the one table named, without a typed confirmation, and refuse a request naming none', async () => {
    await withConsole(async ({ baseUrl, sql }) => {
      await sql('CREATE TABLE analyzed_here (v int)');
      const res = await act(baseUrl, 'analyze', { reason: 'integration', relation: 'public.analyzed_here' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [{ relation: 'public.analyzed_here', ok: true }] });

      const none = await act(baseUrl, 'analyze', { reason: 'integration' });
      expect(none.status).toBe(400);
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

  /** The kill route asserts this for itself; this holds it through openAction. */
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
 * The only tests that serialise a `ConfirmAction` across the server–client
 * boundary: a prop React cannot serialise (a function) makes the page answer
 * 500, and only a real `next start` with actions on shows it.
 *
 * The tree mounts Terminate only on a chain's root, so that half holds a
 * real lock with a waiter behind it.
 */
describe('pages that mount a confirmation, with actions on', () => {
  it('renders a table\'s page with the analyze control, and the tree with Terminate on a chain', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      const holder = new Client({ connectionString: url, application_name: 'p7a-holder' });
      const waiter = new Client({ connectionString: url, application_name: 'p7a-waiter' });
      await Promise.all([holder.connect(), waiter.connect()]);
      try {
        await holder.query('CREATE TABLE IF NOT EXISTS p7a_chained (v int)');
        // Before the lock: the table's page reads its catalog row live.
        const table = await fetch(`${baseUrl}/db/primary/tables/public.p7a_chained`);
        expect(table.status).toBe(200);
        expect(await table.text()).toContain('Analyze');

        await holder.query('BEGIN');
        await holder.query('LOCK TABLE p7a_chained IN ACCESS EXCLUSIVE MODE');
        // Not awaited: it has to be waiting while the page renders.
        void waiter.query('UPDATE p7a_chained SET v = 1').catch(() => {});
        await new Promise((r) => setTimeout(r, 1_500));
        const tree = await fetch(`${baseUrl}/db/primary`);
        expect(tree.status).toBe(200);
        expect(await tree.text()).toContain('Terminate');
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await Promise.all([holder.end().catch(() => {}), waiter.end().catch(() => {})]);
      }
    }, ALLOWED);
  }, 300_000);
});
