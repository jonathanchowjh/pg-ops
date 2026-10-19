import { describe, expect, it } from 'vitest';
import { formatBytes } from '@/lib/format';
import {
  NAMED, SCATTER_MAX, along, byHourOfDay, byteDecades, byteSteps, decades, isoLine, layScatter, logAxis, onColumns, type Mark,
} from '@/lib/plot';

const mark = (id: string, over: Partial<Mark> = {}): Mark =>
  ({ id, label: id, x: 10, y: 10, flag: false, weight: 0, href: null, lines: [], ...over });

describe('logAxis', () => {
  it('spans the decades that hold every positive value, and at least one', () => {
    expect(logAxis([0.3, 40, 0, -2])).toEqual({ lo: -1, hi: 2 });
    expect(logAxis([100])).toEqual({ lo: 2, hi: 3 });
    expect(logAxis([])).toEqual({ lo: 0, hi: 1 });
  });

  it('places a value along it, and zero on its left edge', () => {
    expect(along({ lo: 0, hi: 2 }, 10)).toBeCloseTo(0.5);
    expect(along({ lo: 0, hi: 2 }, 0)).toBe(0);
    expect(along({ lo: 0, hi: 2 }, 1e9)).toBe(1);
  });

  it('is ruled at each power of ten', () => {
    expect(decades({ lo: -1, hi: 2 })).toEqual([0.1, 1, 10, 100]);
  });
});

/** What a byte label says, back in bytes: equal to the rule only when the label is exact. */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const bytesOf = (label: string): number => {
  const [n, u] = label.split(' ');
  return Number(n) * 1024 ** UNITS.indexOf(u!);
};

describe('byte rules', () => {
  /** formatBytes is binary, so a decimal step printed "9.8 KB" and "19.1 MB". */
  it('step in a binary unit on a linear axis, so each prints exactly what it is', () => {
    for (const max of [3, 700, 1_000, 9_999, 20_000, 19_000_000, 300_000_000, 600_000_000, 999_000_000, 4e9, 7.5e12]) {
      const steps = byteSteps(max);
      expect(steps[0]).toBe(0);
      expect(steps.at(-1)!).toBeGreaterThanOrEqual(max);
      expect(steps.length - 1, String(max)).toBeLessThanOrEqual(4);
      for (const v of steps.slice(1)) expect(bytesOf(formatBytes(v)), `${max}: ${formatBytes(v)}`).toBe(v);
    }
    expect(byteSteps(19_000_000).map(formatBytes)).toEqual(['0 B', '5 MB', '10 MB', '15 MB', '20 MB']);
  });

  it('are 1, 10 and 100 of a binary unit on a log axis, and 2 and 5 as well where those are too few', () => {
    expect(byteDecades({ lo: 3, hi: 10 }).map(formatBytes)).toEqual(['1 KB', '10 KB', '100 KB', '1 MB', '10 MB', '100 MB', '1 GB']);
    expect(byteDecades({ lo: 3, hi: 4 }).map(formatBytes)).toEqual(['1 KB', '2 KB', '5 KB']);
    for (const v of byteDecades({ lo: 0, hi: 13 })) expect(bytesOf(formatBytes(v))).toBe(v);
  });
});

describe('layScatter', () => {
  // Review Focus 3.
  it('draws two thousand of ten thousand, the flagged first, and says how many it left out', () => {
    const laid = layScatter([...Array(10_000)].map((_, i) => mark(`i${i}`, { weight: i, flag: i < 5 })));
    expect(laid.marks).toHaveLength(SCATTER_MAX);
    expect(laid.dropped).toBe(8000);
    // The five flagged are the lightest of all and are still drawn.
    expect(laid.marks.filter((m) => m.flag).map((m) => m.id).sort()).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
    expect(laid.marks.some((m) => m.id === 'i9999')).toBe(true);
    expect(laid.marks.some((m) => m.id === 'i5')).toBe(false);
  });

  it('puts a point with no x in the band, and one at zero on the left edge', () => {
    const laid = layScatter([mark('never', { x: null }), mark('idle', { x: 0 }), mark('some', { x: 10 }), mark('busy', { x: 1000 })]);
    const at = (id: string) => laid.marks.find((m) => m.id === id)!.cx;
    expect([at('never'), at('idle'), at('some'), at('busy')]).toEqual([null, 0, 0, 1]);
  });

  it('names the heaviest that have a name, and draws them last so they are on top', () => {
    const laid = layScatter([...Array(10)].map((_, i) => mark(`m${i}`, { weight: i, label: i === 9 ? '' : `m${i}` })));
    expect(laid.marks.filter((m) => m.named).map((m) => m.id).sort()).toEqual(['m3', 'm4', 'm5', 'm6', 'm7', 'm8']);
    expect(laid.marks.filter((m) => m.named)).toHaveLength(NAMED);
    expect(laid.marks.at(-1)!.id).toBe('m9');
  });

  it('is an empty plot with one decade each way for no points', () => {
    expect(layScatter([])).toEqual({ marks: [], dropped: 0, x: { lo: 0, hi: 1 }, y: { lo: 0, hi: 1 } });
  });
});

describe('isoLine', () => {
  it('runs corner to corner where x times y is the box\'s diagonal', () => {
    expect(isoLine({ lo: 0, hi: 2 }, { lo: 0, hi: 2 }, 100)).toEqual({ x1: 0, y1: 1, x2: 1, y2: 0 });
  });

  it('is clipped to the box, and absent when it misses it', () => {
    const line = isoLine({ lo: 0, hi: 2 }, { lo: 0, hi: 2 }, 10)!;
    expect([line.x1, line.y1, line.x2, line.y2].map((v) => Number(v.toFixed(3)))).toEqual([0, 0.5, 0.5, 0]);
    expect(isoLine({ lo: 0, hi: 1 }, { lo: 0, hi: 1 }, 1e6)).toBeNull();
  });
});

describe('onColumns', () => {
  const HOUR = 3_600_000;
  const grid = { from: 10 * HOUR, to: 12 * HOUR, columns: 4 };

  it('gives each column the reading whose span its middle falls in', () => {
    expect(onColumns(grid, [{ at: 10 * HOUR, value: 5 }, { at: 11 * HOUR, value: 9 }], HOUR)).toEqual([5, 5, 9, 9]);
  });

  it('is null where nothing was kept, never zero', () => {
    expect(onColumns(grid, [{ at: 11 * HOUR, value: 9 }], HOUR)).toEqual([null, null, 9, 9]);
    expect(onColumns(grid, [], HOUR)).toEqual([null, null, null, null]);
  });

  it('lets a reading from before the window stand while its span lasts', () => {
    expect(onColumns(grid, [{ at: 9.5 * HOUR, value: 3 }], HOUR)).toEqual([3, null, null, null]);
  });
});

describe('byHourOfDay', () => {
  /** 14:30 UTC on a Monday. */
  const NOW = Date.UTC(2026, 9, 12, 14, 30, 0);
  const at = (daysAgo: number, hour: number) => Date.UTC(2026, 9, 12 - daysAgo, hour, 0, 0);

  it('means each hour of the day over the seven days before, and lays this day over it', () => {
    const hours = [...Array(7)].map((_, i) => ({ at: at(i + 1, 9), sessions: 7 }));
    const { mean, today } = byHourOfDay([...hours, { at: at(0, 9), sessions: 3 }, { at: at(8, 9), sessions: 700 }], NOW, 0);
    expect(mean[9]).toBe(7);
    expect(mean[10]).toBe(0);
    expect(today[9]).toBe(3);
  });

  it('means over the days since the first reading on a store younger than a week', () => {
    // Two days kept: 9 o'clock busy on both, 10 o'clock on one.
    const { mean } = byHourOfDay([
      { at: at(1, 9), sessions: 4 }, { at: at(2, 9), sessions: 2 }, { at: at(2, 10), sessions: 6 },
    ], NOW, 0);
    expect(mean[9]).toBe(3);
    expect(mean[10]).toBe(3);
  });

  it('has nothing to say of an hour this day has not reached, and zero for one it passed quietly', () => {
    const { today } = byHourOfDay([], NOW, 0);
    expect(today[14]).toBe(0);
    expect(today[3]).toBe(0);
    expect(today[15]).toBeNull();
  });

  it('reads the hour in the reader\'s zone', () => {
    // 09:00 UTC is 17:00 at UTC+8, and still the same day there.
    const { today } = byHourOfDay([{ at: at(0, 9), sessions: 3 }], NOW, 8 * 60);
    expect(today[17]).toBe(3);
    expect(today[9]).toBe(0);
  });
});
