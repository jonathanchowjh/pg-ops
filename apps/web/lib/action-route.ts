import { messageOf, type ActionMeta, type CheckContext } from '@pgops/checks';
import { ACTOR_HEADER, authConfigured } from '@/lib/auth';
import { actionsAllowed, publicHost } from '@/lib/config';
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
 * The preamble every action route shares. The order is a security property:
 *
 *   1. The tier gate, before the body is read. 404 and not 403, because a 403
 *      advertises an endpoint that is merely switched off.
 *   2. The media type, below the gate. A 415 from a deployment with actions
 *      off would advertise the route the 404 exists to hide.
 *   3. Body, reason, confirmation, context.
 *
 * The media-type check is the CSRF defence. A cross-origin HTML form can send
 * a body that parses as JSON, but `enctype` accepts only
 * application/x-www-form-urlencoded, multipart/form-data and text/plain, and
 * nothing else can set a request header cross-origin without a preflight
 * these routes never answer. HTTP basic-auth credentials ride cross-site
 * automatically and there is no SameSite equivalent for the Authorization
 * header.
 *
 * Returns the Response to send, or the parsed request. Callers narrow with
 * `if (opened instanceof Response) return opened;`.
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

  // The only free-text field in the audit record. Required, and required to
  // be more than spaces.
  const { reason } = body;
  if (typeof reason !== 'string' || reason.trim() === '') {
    return bad('reason is required.');
  }

  // Tier 2. Checked here, not only in the browser, and compared exactly.
  if (opts.confirm !== undefined && body.confirm !== opts.confirm) {
    return bad(`confirm must be exactly "${opts.confirm}".`);
  }

  let ctx;
  try {
    ctx = await contextFor(name);
  } catch (err) {
    // An unknown database name is a 404. Anything else is the console failing
    // to reach a database it does know about.
    if (err instanceof UnknownDatabaseError) return missing();
    return failed(err);
  }

  // PGOPS_PUBLIC_HOST first, the request's Host header second: the fallback
  // is the client's own claim about the console's address.
  const host = publicHost(process.env) ?? new URL(req.url).host;

  return {
    ctx,
    // proxy.ts sets this header after authenticating and deletes any
    // client-supplied copy first, so it is either a real authenticated
    // username or absent. Absent means auth is not configured, recorded as
    // "anonymous".
    actor: `${req.headers.get(ACTOR_HEADER) ?? 'anonymous'}@${host}`,
    reason: reason.trim(),
    body,
  };
}

/**
 * The CSRF defence and the body parse, shared by every JSON route: the action
 * routes reach it through `openAction`, below the tier gate; the tier-0
 * explain route calls it directly. See `openAction`'s docblock for why the
 * media type is the defence.
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
 * Latched: one warning per process covers every action route. The
 * environment is read at request time rather than at module scope.
 */
let warned = false;

function warnIfActionsAreUnauthenticated(env: Record<string, string | undefined>) {
  if (warned || !actionsAllowed(env) || authConfigured(env)) return;
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
// which throws rather than returning a Response.
function missing() {
  return new Response('Not found', { status: 404 });
}

/** A request the caller got wrong. */
export function bad(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * An action that threw, most likely because the role lacks the privilege.
 * Uncaught, Next answers a bare 500 with no JSON body and the client's
 * `res.json()` fails. The audit record was written before this runs.
 */
export function failed(err: unknown): Response {
  return bad(messageOf(err), 502);
}

/** What every action records, built in one place so no route can drop the actor or the database. */
export function auditMeta(opened: ActionRequest, name: string, subcommand: string): ActionMeta {
  return { subcommand, reason: opened.reason, actor: opened.actor, extra: { database: name } };
}

/** Every action route answers JSON, including its errors — the clients all
 * call `res.json()` on the response. */
export function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
