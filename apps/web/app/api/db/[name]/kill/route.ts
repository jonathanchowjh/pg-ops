import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { ACTOR_HEADER } from '@/lib/auth';
import { actionsAllowed } from '@/lib/actions';
import { contextFor, UnknownDatabaseError } from '@/lib/pools';

/**
 * The only tier-1 surface in P1b, and the only place in apps/web permitted to
 * name `ACTIONS` (guarded in test/guards.test.ts).
 *
 * `killBackend` is not on the barrel's value surface — `packages/checks`
 * re-exports its TYPES only (`export type * from './actions/kill.js'`), so
 * the check objects and action objects stay reachable through exactly one
 * name each: `CHECKS` and `ACTIONS`. This route goes through `ACTIONS.kill`.
 *
 * `await connection()` stays — but NOT for the reason an earlier version of
 * this comment gave. It claimed that without the call this handler "is a
 * candidate for prerendering, and `actionsAllowed(process.env)` would be
 * evaluated in the BUILD process". That cannot happen. A POST-only route
 * handler is never a prerender candidate: in next 16.3.3 (the version in this
 * workspace), next/dist/server/route-modules/app-route/module.js defines
 *
 *   function hasNonStaticMethods(handlers) {
 *       if (handlers.POST || handlers.PUT || handlers.DELETE ||
 *           handlers.PATCH || handlers.OPTIONS) { return true; }
 *       return false;
 *   }
 *
 * and its `handle` does, before `this.do(handler, …)` ever runs userland code:
 * if that returns true and `workStore.isStaticGeneration` is set, it throws
 * `DynamicServerError('Route is configured with methods that cannot be
 * statically generated.')`.
 *
 * No forward-looking justification is offered for keeping it, and that is
 * deliberate. An earlier version of THIS paragraph argued the call defends a
 * future `GET` on this path, because a GET-only module has no non-static
 * method. The premise is true; the inference was not. For an app route
 * handler, prerender candidacy at build is decided in
 * next/dist/export/routes/app-route.js, which bails to `revalidate: 0`
 * WITHOUT calling `module.handle` unless `isStaticGenEnabled(userland)` holds
 * — and that (helpers/is-static-gen-enabled.js) wants `dynamic` of
 * 'force-static'/'error', a `revalidate` export, or `generateStaticParams`.
 * A GET-only handler here would be skipped for prerendering too.
 *
 * Two comments on this call have now asserted a mechanism that did not hold,
 * so this one asserts none. It stays because it costs one `await` and every
 * other rendering path in this app has one: a uniform rule with nothing to
 * remember beats a conditional one that has to be re-derived out of Next's
 * export code before anyone can trust it. Do not add a new mechanism claim
 * here without reading that code first.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  await connection();

  // Spec §7.1: "A deployment that never sets PGOPS_ALLOW_ACTIONS cannot reach
  // tiers 1-3 at all — the routes do not exist." 404, not 403: a 403
  // advertises a kill endpoint that is merely switched off. Checked before
  // the body is read and before the database is resolved, so a disallowed
  // deployment is indistinguishable from one built without this file.
  if (!actionsAllowed(process.env)) return missing();

  warnIfActionsAreUnauthenticated(process.env);

  // Ruling R14 (final review): CSRF, on the only destructive endpoint here.
  // `req.json()` ignores Content-Type entirely, and HTTP basic-auth
  // credentials ride cross-site automatically — there is no SameSite
  // equivalent for the `Authorization` header, so an operator with this
  // console open who visits a hostile page issues whatever this route
  // accepts. Requiring `application/json` is what closes it, and the reason
  // it works is the non-obvious part: a cross-origin HTML form can send a
  // body that parses as JSON, but it cannot send this header — `enctype`
  // accepts only application/x-www-form-urlencoded, multipart/form-data and
  // text/plain, and nothing else can set a request header cross-origin
  // without a CORS preflight this route never answers.
  //
  // Not left to a reverse proxy, unlike rate limiting and session cookies:
  // OAuth2 Proxy, ALB auth and IAP authenticate the caller, they do not
  // prevent an authenticated caller's browser being driven from another
  // origin.
  //
  // Below the gate, never above it: a 415 from a deployment that has actions
  // switched OFF would advertise the route the 404 above exists to hide.
  const mediaType = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return new Response(JSON.stringify({ error: 'Content-Type must be application/json.' }), {
      status: 415,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { name } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad('Body must be JSON.');
  }
  const { pid, backendStart, reason } = (body ?? {}) as Record<string, unknown>;

  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return bad('pid must be a positive integer.');
  }
  if (backendStart !== null && typeof backendStart !== 'string') {
    return bad('backendStart must be the session identity string, or null.');
  }
  // The only free-text field in the audit record, and the only thing that
  // distinguishes a deliberate kill from an accident when someone reads the
  // log six months from now. Required, and required to be more than spaces.
  if (typeof reason !== 'string' || reason.trim() === '') {
    return bad('reason is required.');
  }

  let ctx;
  try {
    ctx = await contextFor(name);
  } catch (err) {
    // An unknown database name is a 404 for the same reason a bad path is:
    // nothing here to act on. Anything else is the console failing to reach a
    // database it does know about.
    if (err instanceof UnknownDatabaseError) return missing();
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  // Ruling R8 (review): PGOPS_PUBLIC_HOST first, the request's Host header
  // second. The whole justification for auditing a host at all is "a host
  // anyone can resolve" — the plan's own text says "PGOPS_PUBLIC_HOST or the
  // request host" and only the fallback half had shipped. `new URL(...).host`
  // reflects whatever Host header the CALLER sent, which is second-best: it
  // is not attacker-chosen in the sense that matters here (URL parsing
  // forbids `@` in `.host`, so it can't spoof the username half of the
  // audited string), but it is still the client's own claim about the
  // console's address rather than an operator-configured, resolvable one.
  // Read at request time, like every other env access in this file.
  const host = process.env.PGOPS_PUBLIC_HOST ?? new URL(req.url).host;

  // backendStart is passed through EXACTLY as received, never looked up or
  // normalised server-side. killBackend's PID-reuse guard works only because
  // the identity it checks was captured at selection time, before any human
  // delay; re-deriving it here would compare the server's current idea of
  // the session against itself and always agree, defeating the guard.
  //
  // I1 (review): ACTIONS.kill's most likely real-world failure — the
  // console's database role lacking pg_signal_backend, i.e. Postgres's
  // "permission denied" / "must be a member of the role whose process is
  // being terminated" — rethrows (kill.ts's catch re-throws after recording
  // `result: "error: …"`). Left uncaught here, Next answers with a bare 500
  // and no JSON body, and Task 4's client does `res.json()` on the response,
  // which then throws on exactly the error an operator most needs to read.
  // contextFor's far less likely failure already gets a clean JSON 502
  // above; this mirrors that shape. The audit trail is unaffected either
  // way — kill.ts's `finally` writes the "error: …" record BEFORE this catch
  // ever runs, so there is no reason to move it here.
  let outcome;
  try {
    outcome = await ACTIONS.kill(
      ctx,
      { pid, backendStart: (backendStart as string | null) ?? null },
      {
        subcommand: 'web/sessions',
        reason: reason.trim(),
        // Always explicit, never left to currentActor() — see the plan's Ruling
        // 6. proxy.ts sets this header after authenticating and deletes any
        // client-supplied copy first, so it is either a real authenticated
        // username or absent. Absent means auth is not configured, which is
        // honestly recorded as "anonymous" rather than silently falling back to
        // the container's OS user and container ID.
        actor: `${req.headers.get(ACTOR_HEADER) ?? 'anonymous'}@${host}`,
        extra: { database: name },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  // All three outcomes are 200 — see the plan's Ruling 3. They are three
  // results of a request that succeeded, and only the client distinguishes
  // them.
  return new Response(JSON.stringify({ outcome }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The combination no single task could have flagged: Task 2 made auth
 * optional, Task 3 made actions opt-in, and each is right on its own.
 * Together, `PGOPS_ALLOW_ACTIONS=true` with no `PGOPS_USERNAME` is an
 * unauthenticated kill endpoint. The audit record honestly says
 * `anonymous@host`, but honesty after the fact is not a mitigation.
 *
 * Warned, not refused. Some deployments genuinely sit behind an
 * authenticating proxy that this process cannot see, and whether to run that
 * way is the operator's call.
 *
 * Latched here rather than warned at module scope, for the same reason
 * `actionsAllowed` is read inside the handler: module scope would be
 * evaluated with whatever environment the process started under, and this
 * app's whole configuration model is that the environment belongs to the
 * request. `warned` is process-local state, not configuration, so latching it
 * costs nothing and keeps a busy console from writing one line per kill.
 */
let warned = false;

function warnIfActionsAreUnauthenticated(env: Record<string, string | undefined>) {
  if (warned || !actionsAllowed(env) || env.PGOPS_USERNAME) return;
  warned = true;
  console.warn(
    'pgops: PGOPS_ALLOW_ACTIONS is on and PGOPS_USERNAME is unset — ' +
    'POST /api/db/<name>/kill can terminate backends without authentication. ' +
    'Set PGOPS_USERNAME and PGOPS_PASSWORD, or make sure an authenticating ' +
    'proxy sits in front of this console.',
  );
}

// Named `missing`, not `notFound`: next/navigation also exports a function
// called `notFound()`, which THROWS rather than returning a Response — a
// same-named local helper that RETURNS a Response reads correctly only to
// someone who already knows it isn't the framework one. Review finding.
function missing() {
  return new Response('Not found', { status: 404 });
}

function bad(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}
