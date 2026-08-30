import { NextResponse, type NextRequest } from 'next/server';
import { ACTOR_HEADER, authorize } from '@/lib/auth';

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
 * inherited matcher boilerplate — this app ships no favicon at all (there is
 * no `public/` directory and no `app/icon.*`), so that third pattern
 * currently excludes a 404. None of the three can reach a database, which is
 * why they are safe to skip; the skipping also keeps a credential comparison
 * off every asset request on every page load, but that is the bonus, not the
 * reason.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
