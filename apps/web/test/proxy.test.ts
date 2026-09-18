import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { ACTION_PATH, proxy } from '@/proxy';
import { ACTOR_HEADER } from '@/lib/auth';

const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/', { headers });
}

function req(method: string, path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method });
}

/**
 * `NextResponse.next({ request: { headers } })` does not literally hand a
 * rewritten Request to anything this test can see — Next's own source
 * (server/web/spec-extension/response.js, `handleMiddlewareField`) encodes
 * the forwarded header set onto the RESPONSE `proxy()` returns:
 * `x-middleware-override-headers` is a comma-separated list of the header
 * NAMES that were set on the forwarded request, and each one also gets an
 * `x-middleware-request-<name>` header carrying its value. That is the exact
 * protocol the real Next server reads to reconstruct the downstream request,
 * so reading it back here is equivalent to asking "what will the route
 * handler see" without booting a server.
 *
 * Returns `undefined` — not the client's original value — when `name` is not
 * in the override list, so a test asserting "absent" can tell that apart
 * from a header that happens to carry an empty string.
 */
function forwarded(res: Response, name: string): string | undefined {
  const overridden = res.headers.get('x-middleware-override-headers');
  if (!overridden?.split(',').includes(name)) return undefined;
  return res.headers.get(`x-middleware-request-${name}`) ?? undefined;
}

const ENV_KEYS = ['PGOPS_USERNAME', 'PGOPS_PASSWORD'] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('proxy', () => {
  /**
   * I2 (review). The interface Task 3 consumes: on a successful auth, the
   * ACTOR_HEADER forwarded downstream is the AUTHENTICATED username, never
   * whatever the client put on the wire. Without the strip in proxy.ts, this
   * would forward "mallory" — the exact forged value a client sent — and the
   * kill route would audit the wrong human.
   */
  it('replaces a forged actor header with the authenticated username', () => {
    process.env.PGOPS_USERNAME = 'alice';
    process.env.PGOPS_PASSWORD = 'hunter2';

    const req = request({ authorization: basic('alice', 'hunter2'), [ACTOR_HEADER]: 'mallory' });
    const res = proxy(req);

    expect(forwarded(res, ACTOR_HEADER)).toBe('alice');
  });

  /**
   * I2 (review), and the plan's Ruling 5 by name: the strip runs whether or
   * not auth is configured, so an unauthenticated deployment cannot have a
   * MORE forgeable audit trail than an authenticated one. This is the case
   * that is easiest to lose, because nothing is authenticating anybody — a
   * fix that only stripped the header on the auth-configured branch would
   * pass every other test in this suite and still leave this one open.
   */
  it('strips a forged actor header entirely when auth is unconfigured', () => {
    const req = request({ [ACTOR_HEADER]: 'mallory' });
    const res = proxy(req);

    expect(forwarded(res, ACTOR_HEADER)).toBeUndefined();
  });

  it('challenges wrong credentials with a 401 and forwards nothing', () => {
    process.env.PGOPS_USERNAME = 'alice';
    process.env.PGOPS_PASSWORD = 'hunter2';

    const req = request({ authorization: basic('alice', 'wrong') });
    const res = proxy(req);

    expect(res.status).toBe(401);
    // A challenge response is not `NextResponse.next(...)`, so it never runs
    // `handleMiddlewareField` at all — there is no forwarded request for
    // ANY header to ride along on, not just this one.
    expect(res.headers.get('x-middleware-override-headers')).toBeNull();
  });

  /**
   * The kill route is POST-only, so Next's own app-route dispatch answers
   * every other method with 405 BEFORE the handler — and therefore before
   * `actionsAllowed` — ever runs. A 405 is a disclosure: a build without the
   * file answers 404, so `GET /api/db/<name>/kill` was a reliable oracle
   * that a console had the kill endpoint compiled in, no matter how firmly
   * PGOPS_ALLOW_ACTIONS was left unset.
   *
   * Both README.md and the route's own comment claimed a flagless
   * deployment was "indistinguishable from a build without this file". This
   * is the test that makes the claim true instead of merely written down.
   * The gate has to live here, above Next's method matching; the route keeps
   * its own copy so the property does not rest on this matcher alone.
   */
  describe('the kill route with actions disabled', () => {
    const KILL = '/api/db/default/kill';

    afterEach(() => { delete process.env.PGOPS_ALLOW_ACTIONS; });

    for (const method of ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      it(`answers ${method} with a bare 404, never a 405`, () => {
        const res = proxy(req(method, KILL));

        expect(res.status).toBe(404);
        // Not `NextResponse.next(...)`: nothing downstream may run, so there
        // is no forwarded request for the route handler to be reached by.
        expect(res.headers.get('x-middleware-override-headers')).toBeNull();
      });
    }

    it('lets the request through to the route once actions are enabled', () => {
      process.env.PGOPS_ALLOW_ACTIONS = 'true';

      const res = proxy(req('POST', KILL));

      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-override-headers')).not.toBeNull();
    });

    it('gates on the kill path only, leaving ordinary pages alone', () => {
      const res = proxy(req('GET', '/db/default/sessions'));

      expect(res.status).toBe(200);
    });
  });
});

describe('the proxy action gate', () => {
  it('matches every action path', () => {
    for (const p of ['kill', 'kill-long-running', 'reset-query-stats', 'reset-stats', 'analyze']) {
      expect(ACTION_PATH.test(`/api/db/prod/${p}`), p).toBe(true);
      // With and without the trailing slash, which Next may or may not
      // normalise depending on config.
      expect(ACTION_PATH.test(`/api/db/prod/${p}/`), `${p}/`).toBe(true);
    }
  });

  /**
   * The prefix question, asserted rather than read off the regex. `kill` must
   * not swallow a longer sibling, and no action path may match something
   * deeper — a matcher that over-matched would 404 ordinary routes on a
   * flagless deployment.
   */
  it('does not match a path that merely starts like one', () => {
    for (const p of [
      '/api/db/prod/kill-everything',
      '/api/db/prod/analyze/extra',
      '/api/db/prod/killer',
      '/api/db/prod/reset-stats/all',
      '/db/prod/kill',
    ]) {
      expect(ACTION_PATH.test(p), p).toBe(false);
    }
  });
});
