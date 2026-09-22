import type { CheckContext } from '@pgops/checks';
import { ACTOR_HEADER } from '@/lib/auth';
import { actionsAllowed } from '@/lib/actions';
import { contextFor, UnknownDatabaseError } from '@/lib/pools';

export interface ActionRequest {
  ctx: CheckContext;
  /** `<user>@<host>` — always explicit, never left to currentActor(). */
  actor: string;
  /** Trimmed, non-empty. */
  reason: string;
  /** The parsed body, for a route that needs more than `reason`. */
  body: Record<string, unknown>;
}

/**
 * The preamble every action route shares, and every line of it is
 * load-bearing security.
 *
 * Five routes hand-maintaining sixty identical lines is five places for one of
 * them to drift, silently. It stays a bare function rather than a class:
 * nothing is shared between calls.
 *
 * THE ORDER IS NOT STYLISTIC.
 *
 *   1. The tier gate, before the body is read. 404 and not 403, because a 403
 *      advertises an endpoint that is merely switched off. Spec §7.1: a
 *      deployment that never sets PGOPS_ALLOW_ACTIONS cannot reach these
 *      routes at all.
 *   2. The media type, BELOW the gate. A 415 from a deployment with actions
 *      off would advertise the route the 404 exists to hide.
 *   3. Body, reason, confirmation, context.
 *
 * The media-type check is the CSRF defence, and the reason it works is the
 * non-obvious part: a cross-origin HTML form can send a body that parses as
 * JSON, but `enctype` accepts only application/x-www-form-urlencoded,
 * multipart/form-data and text/plain, and nothing else can set a request
 * header cross-origin without a preflight these routes never answer. HTTP
 * basic-auth credentials ride cross-site automatically and there is no
 * SameSite equivalent for the Authorization header, so without this an
 * operator with the console open who visits a hostile page issues whatever
 * these routes accept.
 *
 * Returns the Response to send, or the parsed request. Callers narrow with
 * `if (opened instanceof Response) return opened;` — not a thrown error, which
 * would need a catch in every route anyway and would make the 404 path an
 * exception.
 */
export async function openAction(
  req: Request,
  name: string,
  opts: { confirm?: string } = {},
): Promise<ActionRequest | Response> {
  if (!actionsAllowed(process.env)) return missing();

  warnIfActionsAreUnauthenticated(process.env);

  const body = await readJson(req);
  if (body instanceof Response) return body;

  // The only free-text field in the audit record, and the only thing that
  // distinguishes a deliberate action from an accident when someone reads the
  // log six months from now. Required, and required to be more than spaces.
  const { reason } = body;
  if (typeof reason !== 'string' || reason.trim() === '') {
    return bad('reason is required.');
  }

  // Tier 2 (web spec §7.1). Checked HERE, not only in the browser: a
  // confirmation the client alone enforces is one curl away from bypassed.
  // Compared exactly — a typed confirmation that accepts a near-miss is a
  // confirmation the operator did not actually give.
  if (opts.confirm !== undefined && body.confirm !== opts.confirm) {
    return bad(`confirm must be exactly "${opts.confirm}".`);
  }

  let ctx;
  try {
    ctx = await contextFor(name);
  } catch (err) {
    // An unknown database name is a 404 for the same reason a bad path is:
    // nothing here to act on. Anything else is the console failing to reach a
    // database it does know about.
    if (err instanceof UnknownDatabaseError) return missing();
    return bad(err instanceof Error ? err.message : String(err), 502);
  }

  // PGOPS_PUBLIC_HOST first, the request's Host header second: the whole
  // justification for auditing a host is "a host anyone can resolve", and the
  // fallback is the client's own claim about the console's address. Read at
  // request time, like every other env access here.
  const host = process.env.PGOPS_PUBLIC_HOST ?? new URL(req.url).host;

  return {
    ctx,
    // proxy.ts sets this header after authenticating and deletes any
    // client-supplied copy first, so it is either a real authenticated
    // username or absent. Absent means auth is not configured, recorded
    // honestly as "anonymous" rather than falling back to the container's OS
    // user and container id.
    actor: `${req.headers.get(ACTOR_HEADER) ?? 'anonymous'}@${host}`,
    reason: reason.trim(),
    body,
  };
}

/**
 * The CSRF defence and the body parse, shared by every JSON route: the action
 * routes reach it through `openAction`, BELOW the tier gate; the tier-0
 * explain route calls it directly. See `openAction`'s docblock for why the
 * media type IS the defence. One copy, because the explain route would
 * otherwise be the sixth hand-maintained version of exactly the lines this
 * file was written to stop drifting.
 */
export async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  const mediaType = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return bad('Content-Type must be application/json.', 415);
  }
  try {
    return ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return bad('Body must be JSON.');
  }
}

/**
 * Latched, and read from the environment at request time rather than at module
 * scope — this app's configuration model is that the environment belongs to
 * the request. One warning now covers every action route rather than one per
 * route, which is a change from the kill route's own copy and an improvement:
 * the condition it warns about is a property of the deployment, not of a path.
 */
let warned = false;

function warnIfActionsAreUnauthenticated(env: Record<string, string | undefined>) {
  if (warned || !actionsAllowed(env) || env.PGOPS_USERNAME) return;
  warned = true;
  console.warn(
    'pgops: PGOPS_ALLOW_ACTIONS is on and PGOPS_USERNAME is unset — '
    + 'the action routes can terminate backends, reset statistics and write to '
    + 'the monitored database without authentication. Set PGOPS_USERNAME and '
    + 'PGOPS_PASSWORD, or make sure an authenticating proxy sits in front of '
    + 'this console.',
  );
}

// Named `missing`, not `notFound`: next/navigation also exports a `notFound()`
// which THROWS rather than returning a Response.
function missing() {
  return new Response('Not found', { status: 404 });
}

function bad(message: string, status = 400) {
  return json({ error: message }, status);
}

/** Every action route answers JSON, including its errors — the clients all
 * call `res.json()` on the response, so a bare body would throw over exactly
 * the message an operator needs to read. */
export function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
