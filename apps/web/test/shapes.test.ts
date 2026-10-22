// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ pool: {} as unknown }));
vi.mock('@/lib/pools', () => ({ storePool: () => store.pool, contextFor: async () => ({}) }));
const pg = vi.hoisted(() => ({ read: vi.fn(), plan: vi.fn(), events: vi.fn(async () => [] as { at: number; kind: string; relation: string }[]) }));
vi.mock('@pgops/checks', async (orig) => ({
  ...(await orig<typeof import('@pgops/checks')>()),
  readWindowStats: pg.read,
  readEvents: pg.events,
  planStatements: pg.plan,
}));

import { MAX_STATEMENT_LENGTH } from '@pgops/checks';
import { PLACE_PER_TICK, forgetShapes, placeTick, shapesFor } from '@/lib/shapes';

const T0 = Date.parse('2026-10-12T08:00:00Z');
const point = (at: number, calls: number, ms: number) => ({
  capturedAt: new Date(at), calls, totalExecTime: ms, rows: calls * 2,
  sharedBlksHit: calls * 9, sharedBlksRead: calls, statsReset: null,
});
/** A shape that ran `calls` times in the ten minutes before T0, for `ms` in all. */
const stored = (queryid: string, calls: number, ms: number, query = `SELECT ${queryid}`) =>
  ({ queryid, query, points: [point(T0 - 600_000, 100, 1000), point(T0, 100 + calls, 1000 + ms)] });
const grid = { from: T0 - 3_600_000, to: T0, live: true, winSecs: 3600 };
const plan = (schema: string, rel: string) =>
  ({ ok: true, parameters: 0, plan: { 'Node Type': 'Seq Scan', Schema: schema, 'Relation Name': rel } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  forgetShapes();
  store.pool = {};
  pg.read.mockReset();
  pg.plan.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe('shapesFor', () => {
  it('turns two snapshots into a rate, a mean, rows a call and a cache hit', async () => {
    pg.read.mockResolvedValue({ shapes: [stored('7', 600, 3000)], allMs: 12_000 });
    const { shapes, allMs } = await shapesFor('db', grid);
    expect(shapes).toEqual([{
      key: '7', text: 'SELECT 7', relations: null, calls: 600, totalMs: 3000,
      callsPerSec: 1, meanMs: 5, rowsPerCall: 2, cacheHit: 0.9,
    }]);
    expect(allMs).toBe(12_000);
  });

  it('drops a pair that spans a reset: no number is better than a wrong one', async () => {
    const reset = stored('7', 600, 3000);
    reset.points[1]!.calls = 5;
    pg.read.mockResolvedValue({ shapes: [reset], allMs: null });
    expect((await shapesFor('db', grid)).shapes).toEqual([]);
  });

  it('drops a pair that spans pgops\'s own reset, though every counter rose', async () => {
    pg.read.mockResolvedValue({ shapes: [stored('7', 600, 3000)], allMs: null });
    pg.events.mockResolvedValueOnce([{ at: T0 - 300_000, kind: 'reset', relation: '' }]);
    expect((await shapesFor('db', grid)).shapes).toEqual([]);
  });

  it('reads the snapshots once a minute, however often the page polls', async () => {
    pg.read.mockResolvedValue({ shapes: [], allMs: null });
    await shapesFor('db', grid);
    vi.advanceTimersByTime(55_000);
    await shapesFor('db', grid);
    expect(pg.read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    await shapesFor('db', grid);
    expect(pg.read).toHaveBeenCalledTimes(2);
  });

  it('makes one read for every poll that arrives while the first is in flight', async () => {
    let release!: (v: { shapes: never[]; allMs: null }) => void;
    pg.read.mockReturnValue(new Promise((r) => { release = r; }));
    const polls = [shapesFor('db', grid), shapesFor('db', grid), shapesFor('db', grid)];
    release({ shapes: [], allMs: null });
    await Promise.all(polls);
    expect(pg.read).toHaveBeenCalledTimes(1);
  });

  it('reaches back far enough for two captures when the window is shorter than that', async () => {
    pg.read.mockResolvedValue({ shapes: [], allMs: null });
    await shapesFor('db', { from: T0 - 120_000, to: T0, live: true, winSecs: 120 });
    expect((pg.read.mock.calls[0]![2] as Date).getTime()).toBe(T0 - 11 * 60_000);
  });

  // Review Focus 6.
  it('has no shapes and reads nothing with no store', async () => {
    store.pool = null;
    expect(await shapesFor('db', grid)).toEqual({ shapes: [], allMs: null });
    expect(pg.read).not.toHaveBeenCalled();
  });

  // Review Focus 6.
  it('keeps the last numbers when the store stops answering, and never rejects', async () => {
    pg.read.mockResolvedValueOnce({ shapes: [stored('7', 600, 3000)], allMs: 1 });
    await shapesFor('db', grid);
    vi.advanceTimersByTime(61_000);
    pg.read.mockRejectedValue(new Error('store down'));
    expect((await shapesFor('db', grid)).shapes.map((s) => s.key)).toEqual(['7']);
  });
});

describe('placeTick', () => {
  it('places a shape under the tables its plan names, by the next read', async () => {
    pg.read.mockResolvedValue({ shapes: [stored('7', 600, 3000)], allMs: 1 });
    pg.plan.mockResolvedValue([plan('public', 'orders')]);
    await placeTick('db');
    expect((await shapesFor('db', grid)).shapes[0]!.relations).toEqual(['public.orders']);
  });

  // Nobody is waiting on a background plan: a second, not the operator's ten.
  it('plans under a 100 ms lock timeout and a one-second statement timeout', async () => {
    pg.read.mockResolvedValue({ shapes: [stored('7', 600, 3000)], allMs: 1 });
    pg.plan.mockResolvedValue([plan('public', 'orders')]);
    await placeTick('db');
    expect(pg.plan).toHaveBeenCalledWith({}, ['SELECT 7'], { lockTimeoutMs: 100, statementTimeoutMs: 1000 });
  });

  it('plans a few a tick, the costliest first, and each once', async () => {
    pg.read.mockResolvedValue({ shapes: [...Array(8)].map((_, i) => stored(String(i), 10, 800 - i * 100)), allMs: 1 });
    pg.plan.mockImplementation(async (_ctx: unknown, texts: string[]) => texts.map(() => plan('public', 't')));
    await placeTick('db');
    expect(pg.plan.mock.calls[0]![1]).toHaveLength(PLACE_PER_TICK);
    expect(pg.plan.mock.calls[0]![1]).toEqual(['SELECT 0', 'SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4']);
    await placeTick('db');
    expect(pg.plan.mock.calls[1]![1]).toEqual(['SELECT 5', 'SELECT 6', 'SELECT 7']);
    await placeTick('db');
    expect(pg.plan).toHaveBeenCalledTimes(2);
  });

  // The limit the Explain path and suggestedIndexes hold to.
  it('never plans a statement longer than the limit, leaves it unplaced, and spends no turn on it', async () => {
    const long = `SELECT ${'x'.repeat(MAX_STATEMENT_LENGTH)}`;
    pg.read.mockResolvedValue({
      shapes: [stored('long', 10, 9000, long), ...[...Array(5)].map((_, i) => stored(String(i), 10, 800 - i * 100))], allMs: 1,
    });
    pg.plan.mockImplementation(async (_ctx: unknown, texts: string[]) => texts.map(() => plan('public', 't')));
    await placeTick('db');
    expect(pg.plan.mock.calls[0]![1]).toEqual(['SELECT 0', 'SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4']);
    await placeTick('db');
    expect(pg.plan).toHaveBeenCalledTimes(1);
    const shapes = (await shapesFor('db', grid)).shapes;
    expect(shapes.find((s) => s.key === 'long')!.relations).toBeNull();
  });

  // Review Focus 1.
  it('leaves a statement that cannot be planned unplaced, and does not ask again for an hour', async () => {
    pg.read.mockResolvedValue({ shapes: [stored('7', 600, 3000, 'BEGIN')], allMs: 1 });
    pg.plan.mockResolvedValue([{ ok: false, code: '42601', message: 'syntax error' }]);
    await placeTick('db');
    await placeTick('db');
    expect(pg.plan).toHaveBeenCalledTimes(1);
    expect((await shapesFor('db', grid)).shapes[0]!.relations).toBeNull();
    vi.advanceTimersByTime(3_600_001);
    await placeTick('db');
    expect(pg.plan).toHaveBeenCalledTimes(2);
  });

  // Review Focus 1.
  it('asks again on the next tick when the plan only lost a lock', async () => {
    pg.read.mockResolvedValue({ shapes: [stored('7', 600, 3000)], allMs: 1 });
    pg.plan
      .mockResolvedValueOnce([{ ok: false, code: '55P03', message: 'lock timeout' }])
      .mockResolvedValueOnce([plan('public', 'orders')]);
    await placeTick('db');
    await placeTick('db');
    expect((await shapesFor('db', grid)).shapes[0]!.relations).toEqual(['public.orders']);
  });

  it('never rejects: a tick has no caller to reject to', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    pg.read.mockResolvedValue({ shapes: [stored('7', 600, 3000)], allMs: 1 });
    pg.plan.mockRejectedValue(new Error('connection lost'));
    await expect(placeTick('db')).resolves.toBeUndefined();
    error.mockRestore();
  });
});
