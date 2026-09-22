import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTOR_HEADER } from '@/lib/auth';
import { openAction, readJson, type ActionRequest } from '@/lib/action-route';

// The preamble resolves a context; these are unit tests over the preamble,
// not over the pools, so the seam is mocked at the module boundary.
vi.mock('@/lib/pools', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pools')>('@/lib/pools');
  return {
    ...actual,
    contextFor: vi.fn(async (name: string) => {
      // Two arguments: the constructor does `known.join(...)`, so a
      // single-argument call throws a TypeError from inside it and the
      // instanceof branch under test is never reached.
      if (name === 'nosuch') throw new actual.UnknownDatabaseError(name, ['prod']);
      if (name === 'broken') throw new Error('could not connect');
      return { target: {}, databaseName: name } as never;
    }),
  };
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://console.example/api/db/prod/reset-stats', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => { process.env.PGOPS_ALLOW_ACTIONS = 'true'; });
afterEach(() => { delete process.env.PGOPS_ALLOW_ACTIONS; vi.clearAllMocks(); });

describe('openAction', () => {
  /**
   * 404, never 403: a 403 advertises an endpoint that is merely switched off.
   * Checked before the body is read, so a flagless deployment reveals nothing
   * about what the body would have needed.
   */
  it('answers 404 when actions are off', async () => {
    delete process.env.PGOPS_ALLOW_ACTIONS;
    const r = await openAction(post({ reason: 'x' }), 'prod');
    expect(r).toBeInstanceOf(Response);
    expect((r as Response).status).toBe(404);
  });

  /**
   * The CSRF defence. A cross-origin HTML form can send a body that parses as
   * JSON, but `enctype` accepts only three values and none of them is this
   * one — and nothing else can set a request header cross-origin without a
   * preflight these routes never answer.
   */
  it('answers 415 for a body that is not declared JSON', async () => {
    const r = await openAction(post({ reason: 'x' }, { 'content-type': 'text/plain' }), 'prod');
    expect((r as Response).status).toBe(415);
  });

  /**
   * The ORDER of the two checks above, which is not stylistic and which
   * nothing else covers.
   *
   * With actions off, a request that would otherwise earn a 415 must still
   * answer 404 — a 415 tells the caller the route exists and is merely
   * switched off, which is exactly what the 404 is there to hide.
   *
   * The integration suite cannot see this: proxy.ts gates the path above
   * method dispatch, so with actions off the request never reaches this
   * function at all. This copy is the defence-in-depth layer, and its
   * ordering is observable only from here. Swapping the two blocks passes
   * every other test in both suites.
   */
  it('answers 404 rather than 415 when actions are off, whatever the body claims', async () => {
    delete process.env.PGOPS_ALLOW_ACTIONS;
    const r = await openAction(post({ reason: 'x' }, { 'content-type': 'text/plain' }), 'prod');
    expect((r as Response).status).toBe(404);
  });

  it('rejects a body that is not JSON at all', async () => {
    const req = new Request('http://console.example/api/db/prod/reset-stats', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    });
    expect((await openAction(req, 'prod') as Response).status).toBe(400);
  });

  it('requires a reason that is more than whitespace', async () => {
    expect((await openAction(post({ reason: '   ' }), 'prod') as Response).status).toBe(400);
    expect((await openAction(post({}), 'prod') as Response).status).toBe(400);
  });

  /**
   * Tier 2. A confirmation the client alone enforces is one curl away from
   * bypassed, so the comparison happens here.
   */
  it('rejects a tier-2 request whose typed confirmation does not match', async () => {
    const r = await openAction(post({ reason: 'x', confirm: 'not-the-db' }), 'prod',
      { confirm: 'prod' });
    expect((r as Response).status).toBe(400);
  });

  it('rejects a tier-2 request with no confirmation at all', async () => {
    const r = await openAction(post({ reason: 'x' }), 'prod', { confirm: 'prod' });
    expect((r as Response).status).toBe(400);
  });

  /**
   * Exact, not case-insensitive. The fixture differs only in case precisely so
   * a loosened comparison is visible — a typed confirmation that accepts a
   * near-miss is a confirmation the operator did not actually give.
   */
  it('compares the confirmation exactly, not loosely', async () => {
    const r = await openAction(post({ reason: 'x', confirm: 'PROD' }), 'prod',
      { confirm: 'prod' });
    expect((r as Response).status).toBe(400);
  });

  it('accepts a tier-2 request whose confirmation matches exactly', async () => {
    const r = await openAction(post({ reason: 'x', confirm: 'prod' }), 'prod',
      { confirm: 'prod' });
    expect(r).not.toBeInstanceOf(Response);
    expect((r as ActionRequest).reason).toBe('x');
  });

  it('records the authenticated actor', async () => {
    const r = await openAction(post({ reason: 'x' }, { [ACTOR_HEADER]: 'alice' }), 'prod');
    expect((r as ActionRequest).actor).toMatch(/^alice@/);
  });

  /**
   * Absent auth is recorded honestly rather than falling back to the
   * container's OS user and container id, which is what writeAudit would do
   * on its own. See ActionMeta's docblock.
   */
  it('records anonymous when no actor header is present', async () => {
    const r = await openAction(post({ reason: 'x' }), 'prod');
    expect((r as ActionRequest).actor).toMatch(/^anonymous@/);
  });

  it('answers 404 for a database the console does not know', async () => {
    expect((await openAction(post({ reason: 'x' }), 'nosuch') as Response).status).toBe(404);
  });

  it('answers 502 when a known database cannot be reached', async () => {
    const r = await openAction(post({ reason: 'x' }), 'broken') as Response;
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: expect.stringContaining('could not connect') });
  });

  it('trims the reason it hands on, so the audit record has no stray padding', async () => {
    const r = await openAction(post({ reason: '  spaced  ' }), 'prod');
    expect((r as ActionRequest).reason).toBe('spaced');
  });
});

/**
 * The CSRF defence and the body parse, shared with the tier-0 explain route.
 * No tier gate here: that stays in openAction, above this call.
 */
describe('readJson', () => {
  const req = (body: string, type: string) =>
    new Request('http://console.example/api/db/prod/explain', { method: 'POST', headers: { 'content-type': type }, body });

  it('answers 415 for a body not declared JSON', async () => {
    expect(((await readJson(req('{}', 'text/plain'))) as Response).status).toBe(415);
  });
  it('answers 400 for a body that does not parse', async () => {
    const r = (await readJson(req('{', 'application/json'))) as Response;
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'Body must be JSON.' });
  });
  it('returns the object, whatever the parameters on the media type', async () => {
    expect(await readJson(req('{"sql":"SELECT 1"}', 'Application/JSON; charset=utf-8'))).toEqual({ sql: 'SELECT 1' });
  });
});
