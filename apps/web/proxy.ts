import { NextResponse, type NextRequest } from 'next/server';
import { ACTOR_HEADER, authorize } from '@/lib/auth';
import { actionsAllowed } from '@/lib/actions';

/**
 * The action routes, matched here rather than in the route file, because
 * Next answers an unsupported METHOD before it runs the handler.
 *
 * `route.ts` exports only POST, and app-route dispatch (route-modules/
 * app-route/module.js) answers every other method 405 without entering
 * userland — so the `actionsAllowed` gate inside the handler never saw a
 * `GET`. A build without the file answers 404, which made `GET
 * /api/db/<name>/kill -> 405` a reliable oracle that a console had the kill
 * endpoint compiled in, however firmly PGOPS_ALLOW_ACTIONS was left unset.
 * That contradicted the property both README.md and route.ts claim: a
 * flagless deployment is indistinguishable from a build without the file.
 *
 * The gate belongs above the method dispatch, which means here. route.ts
 * KEEPS its own copy — this one is what works, that one is what stays true
 * if this matcher is ever narrowed. Neither is redundant with the other.
 */
const ACTION_PATH = /^\/api\/db\/[^/]+\/kill\/?$/;

/**
 * The adapter over lib/auth.ts. Everything decidable lives there; this file
 * turns an AuthResult into a Response and does the one thing a pure function
 * cannot: rewrite the request headers seen downstream.
 *
 * This is Next's "proxy" convention — what used to be called "middleware".
 * Next 16.3.3 deprecated the `middleware.ts` filename and the `middleware`
 * export in favor of `proxy.ts` / `export function proxy`, warning on every
 * build until migrated (`warnOnce`, next/dist/build/index.js). Do NOT rename
 * this back to middleware.ts: that reintroduces the warning this rename
 * exists to remove. The one thing this migration changes in practice is that
 * proxy always runs on the Node.js runtime (next/dist/build/analysis/
 * get-page-static-info.js) — the only config a proxy file may not declare is
 * `runtime`; `matcher`, below, is unaffected and still honoured.
 */
export function proxy(req: NextRequest) {
  // FIRST, unconditionally, before any decision: strip any client-supplied
  // actor header. The kill route audits against this header, so a client that
  // could set it would choose the name recorded against a terminated backend
  // — forging entries in the log that exists to attribute exactly that. The
  // strip happens whether or not auth is configured, because an unauthenticated
  // deployment must not have a MORE forgeable audit trail than an
  // authenticated one. Guarded directly by apps/web/test/proxy.test.ts, which
  // calls this function and inspects the forwarded header set (auth.int.test.ts
  // exercises this indirectly, through a real server, but asserts nothing
  // about x-pgops-user).
  const headers = new Headers(req.headers);
  headers.delete(ACTOR_HEADER);

  // Then the action gate, and before `authorize`: a 401 on this path would
  // advertise the endpoint to an unauthenticated caller exactly as the 405
  // did. A flagless deployment answers every method here the way it answers
  // a path with no route at all.
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
 * EVERY route that can read or change a database goes through this. That is
 * the claim to check first when editing the pattern below, and the only one
 * that matters: an exclusion added here is an unauthenticated route.
 *
 * The three exclusions are asset paths, not routes. `_next/static` and
 * `_next/image` are Next's own hashed build output; `favicon.ico` is
 * inherited matcher boilerplate that still excludes a 404 — this app has no
 * `public/` directory and no `app/favicon.ico`, and you cannot generate one
 * (app-icons.md: "You cannot generate a `favicon` icon").
 *
 * It does now ship `app/icon.svg`, which is NOT that path: Next serves an app
 * icon as its own Route Handler at `/icon`, which this matcher therefore
 * covers. That is left alone deliberately. The tab icon goes through
 * `authorize` like everything else, so an unauthenticated browser gets a 401
 * for it and shows no icon beside the credential prompt — which is cosmetic,
 * and cheaper than widening a matcher whose every exclusion is an
 * unauthenticated route.
 *
 * None of the three can reach a database, which is why they are safe to skip;
 * the skipping also keeps a credential comparison off every asset request on
 * every page load, but that is the bonus, not the reason.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
