import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/db/[name]/explain/route';

vi.mock('@/lib/pools', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pools')>('@/lib/pools');
  return {
    ...actual,
    contextFor: vi.fn(async (name: string) => {
      if (name === 'nosuch') throw new actual.UnknownDatabaseError(name, ['prod']);
      if (name === 'broken') throw new Error('could not connect');
      return { target: {}, serverVersion: 170000 } as never;
    }),
  };
});

const { runTool } = vi.hoisted(() => ({
  runTool: vi.fn(async (_ctx: unknown, _tool: unknown, input: { sql: string }) =>
    ({ ok: true, data: { plan: { 'Node Type': 'Result' }, parameters: 0, advice: [], echo: input.sql }, measuredAt: 0 })),
}));
vi.mock('@pgops/checks', async () => {
  const actual = await vi.importActual<typeof import('@pgops/checks')>('@pgops/checks');
  return { ...actual, runTool };
});

const call = (name: string, body: unknown, type = 'application/json') =>
  POST(
    new Request(`http://console.example/api/db/${name}/explain`, {
      method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ name }) },
  );

afterEach(() => { vi.clearAllMocks(); });

describe('POST /api/db/[name]/explain', () => {
  it('requires a JSON body — the CSRF defence, even at tier 0', async () => {
    expect((await call('prod', { sql: 'SELECT 1' }, 'text/plain')).status).toBe(415);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('requires a statement', async () => {
    const r = await call('prod', {});
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'sql is required.' });
    const blank = await call('prod', { sql: '   ' });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: 'Nothing to explain: the statement is empty.' });
  });

  it('refuses a statement over the length the tool plans, by the tool\'s own rule', async () => {
    const r = await call('prod', { sql: 'x'.repeat(10_001) });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'The statement is 10001 characters; the limit is 10000.' });
    // Measured after trimming, as the tool measures it: padding is not length.
    expect((await call('prod', { sql: ` ${'x'.repeat(10_000)} ` })).status).toBe(200);
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a database it does not know, and 502 for one it cannot reach', async () => {
    expect((await call('nosuch', { sql: 'SELECT 1' })).status).toBe(404);
    const broken = await call('broken', { sql: 'SELECT 1' });
    expect(broken.status).toBe(502);
    expect(await broken.json()).toEqual({ error: 'could not connect' });
  });

  it('passes the tool envelope through unchanged', async () => {
    const r = await call('prod', { sql: 'SELECT 1' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, data: { echo: 'SELECT 1' } });
    expect(runTool).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'explain' }), { sql: 'SELECT 1' });
  });

  it('answers with actions switched off — planning changes nothing', async () => {
    delete process.env.PGOPS_ALLOW_ACTIONS;
    expect((await call('prod', { sql: 'SELECT 1' })).status).toBe(200);
  });
});
