import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { ACTOR_HEADER } from '@/lib/auth';

const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/', { headers });
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
});
