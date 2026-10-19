import { NextResponse, type NextRequest } from 'next/server';
import { ACTOR_HEADER, authorize } from '@/lib/auth';
import { actionsAllowed } from '@/lib/config';

/**
 * The action routes, matched here as well as in the handler, because Next
 * answers an unsupported method before it runs the handler.
 *
 * `route.ts` exports only POST, and app-route dispatch answers every other
 * method 405 without entering userland, so the `actionsAllowed` gate inside
 * the handler never sees a `GET`. That 405 would reveal that the endpoint is
 * compiled in even with PGOPS_ALLOW_ACTIONS unset; a flagless deployment must
 * be indistinguishable from a build without the file. Each route keeps its
 * own copy of the gate (lib/action-route.ts), which stays true if this
 * matcher is ever narrowed.
 *
 * One branch per action route, each anchored by `/?$`, so `kill` cannot
 * swallow `kill-long-running` by prefix. proxy.test.ts asserts that.
 */
export const ACTION_PATH =
  /^\/api\/db\/[^/]+\/(?:kill|kill-long-running|reset-query-stats|reset-stats|analyze)\/?$/;

/**
 * The adapter over lib/auth.ts. Everything decidable lives there; this file
 * turns an AuthResult into a Response and rewrites the request headers seen
 * downstream.
 *
 * This is Next's "proxy" convention, formerly "middleware"; the
 * `middleware.ts` filename is deprecated, so do not rename this back. Proxy
 * always runs on the Node.js runtime, and `runtime` is the one config a proxy
 * file may not declare.
 */
export function proxy(req: NextRequest) {
  // First, before any decision: strip any client-supplied actor header. The
  // kill route audits against this header, so a client that could set it
  // would choose the name recorded against a terminated backend. Stripped
  // whether or not auth is configured. apps/web/test/proxy.test.ts holds this.
  const headers = new Headers(req.headers);
  headers.delete(ACTOR_HEADER);

  // Then the action gate, before `authorize`: a 401 on this path would
  // advertise the endpoint to an unauthenticated caller. A flagless
  // deployment answers every method here the way it answers a path with no
  // route at all.
  if (ACTION_PATH.test(req.nextUrl.pathname) && !actionsAllowed(process.env)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const result = authorize(process.env, req.headers.get('authorization'));

  if (!result.ok) {
    return new NextResponse(result.message, {
      status: result.status,
      headers:
        result.status === 401
          ? { 'WWW-Authenticate': 'Basic realm="pgops", charset="UTF-8"' }
          : {},
    });
  }

  if (result.user !== null) headers.set(ACTOR_HEADER, result.user);
  return NextResponse.next({ request: { headers } });
}

/**
 * Every route that can read or change a database goes through this. An
 * exclusion added to the pattern below is an unauthenticated route.
 *
 * The three exclusions are asset paths, not routes, and none can reach a
 * database. `favicon.ico` excludes a 404: this app has no such file.
 *
 * `app/icon.svg` is served at `/icon.svg`, which this matcher covers, so an
 * unauthenticated browser gets a 401 for it. That is left alone deliberately.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
