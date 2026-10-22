import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/store/migrate.js';
import { bucketFilled, readCoverage, readEvents, readLoad, readSamples, readStatements } from '../src/store/read.js';
import { recordEvent, recordSample } from '../src/store/write.js';
import type { Sample, SampleSession } from '../src/samples.js';
import { withPostgres } from './harness.js';

const AT = new Date('2026-10-12T08:00:07Z');
const ses = (pid: number, over: Partial<SampleSession> = {}): SampleSession => ({
  pid, backendStart: `2026-10-12 07:00:0${pid}+00`, app: 'web', cls: 'cpu', since: AT.getTime() - 5_000,
  statement: 'q1', relations: ['public.users'], blockedBy: null, ...over,
});
const sample = (sessions: SampleSession[]): Sample => ({ at: AT.getTime(), sessions, hidden: false, truncated: false });
const texts = new Map([['q1', { text: 'UPDATE users SET n = $1', relations: ['public.users'] }]]);
const plus = (secs: number) => new Date(AT.getTime() + secs * 1000);

describe('recordSample', () => {
  it('writes a bucket once, whoever asks second', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      expect(await recordSample(pool, 'db', sample([ses(1)]), texts, AT)).toBe('written');
      // Seven seconds later is the same 15-second bucket.
      expect(await recordSample(pool, 'db', sample([ses(1), ses(2)]), texts, plus(7))).toBe('filled');
      const read = await readSamples(pool, 'db', new Date('2026-10-12T08:00:00Z'), plus(60));
      expect(read).toHaveLength(1);
      expect(read[0]!.at).toBe(Date.parse('2026-10-12T08:00:00Z'));
      expect(read[0]!.sessions.map((s) => s.pid)).toEqual([1]);
      expect(read[0]!.sessions[0]).toMatchObject({ backendStart: '2026-10-12 07:00:01+00', since: AT.getTime() - 5_000 });
    });
  }, 120_000);

  it('keeps an empty bucket, because nothing running is a reading', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      await recordSample(pool, 'db', sample([]), new Map(), AT);
      const read = await readSamples(pool, 'db', new Date('2026-10-12T08:00:00Z'), plus(60));
      expect(read).toEqual([{ at: Date.parse('2026-10-12T08:00:00Z'), sessions: [], hidden: false, truncated: false }]);
    });
  }, 120_000);

  it('rolls a minute up right when two writers fill its buckets at once', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      // Two replicas: each minute's two buckets written at the same moment, one session in the first, three in the second.
      const wide = new Pool({ connectionString: pool.options.connectionString, max: 16 });
      const minute = (m: number) => new Date(Date.parse('2026-10-12T09:00:00Z') + m * 60_000);
      try {
        await Promise.all(Array.from({ length: 60 }, (_, m) => Promise.all([
          recordSample(wide, 'db', { ...sample([ses(1)]), at: minute(m).getTime() }, texts, minute(m)),
          // A statement of its own, or its row in sample_statements would make one writer wait for the other.
          recordSample(wide, 'db', { ...sample([1, 2, 3].map((p) => ses(p, { statement: 'q2' }))), at: minute(m).getTime() + 15_000 },
            new Map([['q2', { text: 'SELECT $1', relations: ['public.users'] }]]), new Date(minute(m).getTime() + 15_000)),
        ])));
      } finally {
        await wide.end();
      }
      const cells = await readLoad(pool, 'db', minute(0), minute(60), 60, ['d']);
      expect(cells.filter((c) => c.cls === 'cpu').map((c) => c.sessions)).toEqual(Array(60).fill(2));
    });
  }, 120_000);

  it('says how much of each column was sampled, a quiet bucket included', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const base = Date.parse('2026-10-12T08:00:00Z');
      // The first minute fully, the second not at all, the third half: two quiet buckets of four.
      for (const s of [0, 15, 30, 45, 120, 135]) await recordSample(pool, 'db', { ...sample([]), at: base + s * 1000 }, new Map(), new Date(base + s * 1000));
      expect(await readCoverage(pool, 'db', new Date(base), new Date(base + 180_000), 3)).toEqual([1, 0, 0.5]);
    });
  }, 120_000);

  it('rolls a minute up per class, counting a session once per level', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const both = ses(1, { relations: ['public.users', 'public.orders'] });
      // Two of the minute's buckets: the session in both, a lock waiter in the second.
      await recordSample(pool, 'db', sample([both]), texts, AT);
      await recordSample(pool, 'db', sample([both, ses(2, { cls: 'lock', blockedBy: 1, relations: [] })]), texts, plus(15));
      // Exactly the minute, so the one column is sixty seconds wide.
      const cells = await readLoad(pool, 'db', new Date('2026-10-12T08:00:00Z'), new Date('2026-10-12T08:01:00Z'), 1, ['d', 't', 'q']);
      const of = (kind: string, key: string, cls: string) =>
        cells.find((c) => c.kind === kind && c.key === key && c.cls === cls)?.sessions ?? 0;
      // One column of one minute, two buckets seen: the mean over what was seen.
      expect(of('d', '', 'cpu')).toBeCloseTo(1);
      expect(of('d', '', 'lock')).toBeCloseTo(0.5);
      expect(of('t', 'public.users', 'cpu')).toBeCloseTo(1);
      expect(of('t', 'public.orders', 'cpu')).toBeCloseTo(1);
      expect(of('t', '', 'lock')).toBeCloseTo(0.5);
      expect(of('q', 'q1', 'cpu')).toBeCloseTo(1);
    });
  }, 120_000);

  it('records a chain beginning and ending, and merges a statement\'s tables', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const waiter = ses(2, { cls: 'lock', blockedBy: 1 });
      await recordSample(pool, 'db', sample([ses(1)]), texts, AT);
      await recordSample(pool, 'db', sample([ses(1), waiter]), texts, plus(15));
      await recordSample(pool, 'db', sample([ses(1), waiter]), new Map([['q1', { text: 'x', relations: ['public.orders'] }]]), plus(30));
      await recordSample(pool, 'db', sample([ses(1)]), texts, plus(45));
      const events = await readEvents(pool, 'db', new Date('2026-10-12T08:00:00Z'), plus(120));
      expect(events.map((e) => [e.kind, e.relation, e.at])).toEqual([
        ['chain-begin', 'public.users', Date.parse('2026-10-12T08:00:15Z')],
        ['chain-end', 'public.users', Date.parse('2026-10-12T08:00:45Z')],
      ]);
      const known = await readStatements(pool, 'db', ['q1', 'nope']);
      // The first text stays; the tables accumulate.
      expect(known.get('q1')).toEqual({ text: 'UPDATE users SET n = $1', relations: ['public.orders', 'public.users'] });
      expect(known.has('nope')).toBe(false);
    });
  }, 120_000);

  it('closes a chain that was last seen before a gap, where it was last seen', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const waiter = ses(2, { cls: 'lock', blockedBy: 1 });
      await recordSample(pool, 'db', sample([ses(1), waiter]), texts, AT);
      // Ten minutes of nobody looking, then a calm sample.
      await recordSample(pool, 'db', sample([ses(1)]), texts, plus(600));
      const events = await readEvents(pool, 'db', new Date('2026-10-12T08:00:00Z'), plus(900));
      expect(events.map((e) => [e.kind, e.at])).toEqual([
        ['chain-begin', Date.parse('2026-10-12T08:00:00Z')],
        ['chain-end', Date.parse('2026-10-12T08:00:15Z')],
      ]);
    });
  }, 120_000);

  it('says a database went unreachable once, and came back once', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      await recordEvent(pool, 'db', 'unreachable');
      await recordEvent(pool, 'db', 'unreachable');
      await recordEvent(pool, 'db', 'reachable');
      await recordEvent(pool, 'db', 'reachable');
      const events = await readEvents(pool, 'db', new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
      expect(events.map((e) => e.kind)).toEqual(['unreachable', 'reachable']);
    });
  }, 120_000);

  it('knows whether a bucket is taken', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      // `AT` on both, not the store's now: a test straddling a 15-second
      // boundary would otherwise ask about two different buckets.
      expect(await bucketFilled(pool, 'db', AT)).toBe(false);
      await recordSample(pool, 'db', sample([]), new Map(), AT);
      expect(await bucketFilled(pool, 'db', AT)).toBe(true);
      expect(await bucketFilled(pool, 'db', plus(15))).toBe(false);
    });
  }, 120_000);
});
