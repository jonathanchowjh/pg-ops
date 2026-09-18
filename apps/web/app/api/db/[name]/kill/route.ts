import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { openAction } from '@/lib/action-route';

/**
 * The first of the action routes, and the one the others were factored out
 * of.
 *
 * `killBackend` is not on the barrel's value surface — packages/checks
 * re-exports its TYPES only — so every action is reached through `ACTIONS`
 * and guards.test.ts holds which files may name it.
 *
 * The gate, the CSRF media-type check, the reason, the context and the actor
 * now live in `lib/action-route.ts`, shared with four sibling routes. Every
 * line of that preamble is load-bearing security and five hand-maintained
 * copies would be five places for one of them to drift silently. Its docblock
 * carries the reasoning that used to live here, including why the order of
 * the checks is not stylistic.
 *
 * `await connection()` stays, and asserts no mechanism. Two previous comments
 * on this call claimed one that did not hold (a POST-only route handler is
 * never a prerender candidate; Next throws DynamicServerError before userland
 * runs). It costs one await and every other rendering path in this app has
 * one: a uniform rule with nothing to remember beats a conditional one that
 * has to be re-derived out of Next's export code before anyone can trust it.
 * Do not add a new mechanism claim here without reading that code first.
 *
 * Tier 1 (web spec §7.1): the gate plus an inline confirmation, no typed
 * confirmation. The PID-reuse guard is what makes a single kill safe, and it
 * lives in killBackend.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  await connection();
  const { name } = await params;

  const opened = await openAction(req, name);
  if (opened instanceof Response) return opened;

  const { pid, backendStart } = opened.body;

  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return bad('pid must be a positive integer.');
  }
  // Absent means null — "I captured no identity, kill on pid alone" — which is
  // what every caller that omitted the field already meant.
  if (backendStart !== undefined && backendStart !== null && typeof backendStart !== 'string') {
    return bad('backendStart must be the session identity string, or null.');
  }

  // backendStart is passed through EXACTLY as received, never looked up or
  // normalised server-side. killBackend's PID-reuse guard works only because
  // the identity it checks was captured at selection time, before any human
  // delay; re-deriving it here would compare the server's current idea of the
  // session against itself and always agree.
  //
  // ACTIONS.kill's most likely real-world failure — the console's role lacking
  // pg_signal_backend — rethrows from kill.ts after recording `result:
  // "error: …"`. Left uncaught, Next answers a bare 500 with no JSON body, and
  // the client does res.json() on exactly the error an operator most needs to
  // read. The audit trail is unaffected either way: kill.ts's finally writes
  // the record before this catch runs.
  let outcome;
  try {
    outcome = await ACTIONS.kill(
      opened.ctx,
      { pid, backendStart: (backendStart as string | null) ?? null },
      {
        subcommand: 'web/sessions',
        reason: opened.reason,
        actor: opened.actor,
        extra: { database: name },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  // All three outcomes are 200 — they are three results of a request that
  // succeeded, and only the client distinguishes them.
  return new Response(JSON.stringify({ outcome }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function bad(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}
