import { TOOLS, checkStatement, runTool } from '@pgops/checks';
import { json, readJson } from '@/lib/action-route';
import { contextFor, UnknownDatabaseError } from '@/lib/pools';

/**
 * #57 `explain` and #64 `best_index`, at tier 0.
 *
 * Not in proxy.ts's ACTION_PATH and not behind PGOPS_ALLOW_ACTIONS, because
 * planning changes nothing — and `planStatements` is what makes that a
 * property rather than a hope: a named statement, so Postgres refuses a
 * second command; read-only and rolled back; its connection destroyed.
 *
 * The media type is still required. It is the CSRF defence (see
 * `openAction`), and a hostile page must not be able to make an operator's
 * browser plan statements against their database, any more than act on it.
 *
 * POST, not GET with the statement in the URL: a statement belongs in no
 * proxy log or browser history. pgHero's own TODO weighs the same trade.
 */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await readJson(req);
  if (body instanceof Response) return body;

  // The tool's own rule, applied before a connection is opened: a 400 names
  // the operator's mistake, where a failed tool result would read as the
  // database's.
  const { sql } = body;
  if (typeof sql !== 'string') return json({ error: 'sql is required.' }, 400);
  try {
    checkStatement(sql);
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  let ctx;
  try {
    ctx = await contextFor(name);
  } catch (err) {
    if (err instanceof UnknownDatabaseError) return new Response('Not found', { status: 404 });
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
  return json(await runTool(ctx, TOOLS.explain, { sql }), 200);
}
