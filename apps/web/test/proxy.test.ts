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
 * What the route handler will see for `name`. Next encodes the forwarded
 * request headers onto the response `proxy()` returns
 * (server/web/spec-extension/response.js, `handleMiddlewareField`):
 * `x-middleware-override-headers` lists the header names, and each gets an
 * `x-middleware-request-<name>` header carrying its value.
 *
 * Returns `undefined` when `name` is not in the override list, so "absent" is
 * distinguishable from an empty string.
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
   * The ACTOR_HEADER forwarded downstream is the authenticated username, never
   * what the client sent. Otherwise the kill route would audit the wrong human.
   */
  it('replaces a forged actor header with the authenticated username', () => {
    process.env.PGOPS_USERNAME = 'alice';
    process.env.PGOPS_PASSWORD = 'hunter2';

    const req = request({ authorization: basic('alice', 'hunter2'), [ACTOR_HEADER]: 'mallory' });
    const res = proxy(req);

    expect(forwarded(res, ACTOR_HEADER)).toBe('alice');
  });

  /**
   * The strip runs whether or not auth is configured, so an unauthenticated
   * deployment cannot have a more forgeable audit trail than an authenticated
   * one. Stripping only on the auth-configured branch would pass every other
   * test here.
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
    // A challenge is not `NextResponse.next(...)`: there is no forwarded request at all.
    expect(res.headers.get('x-middleware-override-headers')).toBeNull();
  });

  /**
   * The kill route is POST-only, so Next answers every other method with 405
   * before the handler, and so before `actionsAllowed`, runs. A build without
   * the file answers 404, so a 405 would disclose that the endpoint exists
   * even with PGOPS_ALLOW_ACTIONS unset. The gate therefore lives in the
   * proxy, above Next's method matching; the route keeps its own copy.
   */
  describe('the kill route with actions disabled', () => {
    const KILL = '/api/db/default/kill';

    afterEach(() => { delete process.env.PGOPS_ALLOW_ACTIONS; });

    for (const method of ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      it(`answers ${method} with a bare 404, never a 405`, () => {
        const res = proxy(req(method, KILL));

        expect(res.status).toBe(404);
        // Not `NextResponse.next(...)`: nothing downstream may run.
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
   * `kill` must not swallow a longer sibling, and no action path may match
   * something deeper: an over-matching matcher would 404 ordinary routes on a
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
