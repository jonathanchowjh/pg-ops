import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTOR_HEADER } from '@/lib/auth';
import { openAction, readJson, type ActionRequest } from '@/lib/action-route';

// Unit tests over the preamble, not the pools, so contextFor is mocked.
vi.mock('@/lib/pools', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pools')>('@/lib/pools');
  return {
    ...actual,
    contextFor: vi.fn(async (name: string) => {
      // Two arguments: the constructor does `known.join(...)`, so a
      // single-argument call throws a TypeError instead.
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
  /** 404, not 403: a 403 advertises an endpoint that is merely switched off. */
  it('answers 404 when actions are off', async () => {
    delete process.env.PGOPS_ALLOW_ACTIONS;
    const r = await openAction(post({ reason: 'x' }), 'prod');
    expect(r).toBeInstanceOf(Response);
    expect((r as Response).status).toBe(404);
  });

  /**
   * The CSRF defence: a cross-origin form can send a body that parses as JSON,
   * but cannot declare it `application/json`.
   */
  it('answers 415 for a body that is not declared JSON', async () => {
    const r = await openAction(post({ reason: 'x' }, { 'content-type': 'text/plain' }), 'prod');
    expect((r as Response).status).toBe(415);
  });

  /**
   * The order of the two checks above: with actions off, a 415 would reveal
   * that the route exists. The integration suite cannot see this, because
   * proxy.ts gates the path before the request reaches this function.
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

  /** Tier 2: the confirmation is compared server-side, since curl bypasses the client. */
  it('rejects a tier-2 request whose typed confirmation does not match', async () => {
    const r = await openAction(post({ reason: 'x', confirm: 'not-the-db' }), 'prod',
      { confirm: 'prod' });
    expect((r as Response).status).toBe(400);
  });

  it('rejects a tier-2 request with no confirmation at all', async () => {
    const r = await openAction(post({ reason: 'x' }), 'prod', { confirm: 'prod' });
    expect((r as Response).status).toBe(400);
  });

  /** The fixture differs only in case, so a case-insensitive comparison fails here. */
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

  /** Without this, writeAudit would fall back to the container's OS user and id. */
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

/** Shared with the tier-0 explain route; the tier gate stays in openAction. */
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
