import { connection } from 'next/server';
import { messageOf } from '@pgops/checks';
import { ACTOR_HEADER } from '@/lib/auth';
import { actorOf, bad, json, readJson } from '@/lib/action-route';
import { ConfigError, assertNew, removeDatabase, saveDatabase } from '@/lib/config';
import { identityLine } from '@/lib/format';
import { probe, retireTarget } from '@/lib/pools';

/**
 * Adding and removing a database from the console. Behind basic auth like
 * every route, and JSON only, which is the CSRF defence (see `readJson`).
 * Neither the request's URL nor anything derived from it is ever answered
 * back: it carries the password.
 *
 * POST `{name, url, save}` connects the way pgops always will and says what
 * the server answered. With `save: true` it also saves the database, and
 * only if the server kept the session read only.
 */
export async function POST(req: Request): Promise<Response> {
  // Reads process.env; see guards.test.ts ("dynamic rendering").
  await connection();
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  try {
    assertNew(process.env, { name, url });
  } catch (err) {
    if (err instanceof ConfigError) return bad(err.message);
    throw err;
  }

  let tested;
  try {
    tested = await probe(url);
  } catch (err) {
    return bad(`Could not connect: ${messageOf(err)}`, 422);
  }
  const answer = { identity: identityLine(tested.identity), readOnly: tested.readOnly };
  if (body.save !== true) return json(answer, 200);

  if (!tested.readOnly) {
    return bad('The server did not keep the session read only, so pgops will not add it. A pooler can ignore the setting; connect to Postgres directly.', 422);
  }
  try {
    saveDatabase(process.env, { name, url });
  } catch (err) {
    if (err instanceof ConfigError) return bad(err.message, 409);
    throw err;
  }
  console.info('[pgops] %s added database %s', actorOf(req.headers.get(ACTOR_HEADER)), name);
  return json(answer, 201);
}

/** DELETE `{name}` removes a saved database. pgops forgets it; nothing is sent to it. */
export async function DELETE(req: Request): Promise<Response> {
  await connection();
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  try {
    retireTarget(removeDatabase(process.env, name).url);
  } catch (err) {
    if (err instanceof ConfigError) return bad(err.message, 409);
    throw err;
  }
  console.info('[pgops] %s removed database %s', actorOf(req.headers.get(ACTOR_HEADER)), name);
  return json({ name }, 200);
}
