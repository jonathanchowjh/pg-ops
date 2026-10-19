import { TOOLS, checkStatement, runTool } from '@pgops/checks';
import { bad, failed, json, readJson } from '@/lib/action-route';
import { contextFor, UnknownDatabaseError } from '@/lib/pools';

/**
 * Explain and best-index, at tier 0: not in proxy.ts's ACTION_PATH and not
 * behind PGOPS_ALLOW_ACTIONS, because planning changes nothing.
 * `planStatements` enforces that: a named statement, so Postgres refuses a
 * second command; read-only and rolled back; its connection destroyed.
 *
 * The media type is still required — it is the CSRF defence (see
 * `openAction`). POST, not GET, so the statement stays out of proxy logs and
 * browser history.
 */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await readJson(req);
  if (body instanceof Response) return body;

  // Checked before a connection is opened: a 400 names the operator's
  // mistake, where a failed tool result would read as the database's.
  const { sql } = body;
  if (typeof sql !== 'string') return bad('sql is required.');
  try {
    checkStatement(sql);
  } catch (err) {
    return bad((err as Error).message);
  }

  let ctx;
  try {
    ctx = await contextFor(name);
  } catch (err) {
    if (err instanceof UnknownDatabaseError) return new Response('Not found', { status: 404 });
    return failed(err);
  }
  return json(await runTool(ctx, TOOLS.explain, { sql }), 200);
}
