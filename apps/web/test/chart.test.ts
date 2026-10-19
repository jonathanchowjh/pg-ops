import { describe, expect, it } from 'vitest';
import { nearest, ticks, withGaps } from '@/lib/chart';

const MIN = 60_000;
/** A capture every five minutes, with `skip[i]` extra minutes before point `i`. */
const every5 = (values: number[], skip: number[] = []) => values.map((value, i) => ({
  at: (i * 5 + skip.slice(0, i + 1).reduce((a, b) => a + b, 0)) * MIN,
  value,
}));

describe('ticks', () => {
  it('rules round numbers up to the first one at or past the range', () => {
    expect(ticks(900, 'count')).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(ticks(3, 'count')).toEqual([0, 1, 2, 3]);
    expect(ticks(12, 'count')).toEqual([0, 5, 10, 15]);
  });

  it('never rules a count or a duration finer than one', () => {
    expect(ticks(0.4, 'count')).toEqual([0, 1]);
    expect(ticks(2, 'secs')).toEqual([0, 1, 2]);
  });

  it('rules a duration in minutes and hours, not in hundreds of seconds', () => {
    expect(ticks(6_240, 'secs')).toEqual([0, 1800, 3600, 5400, 7200]);
    expect(ticks(10_000_000, 'millis')).toEqual([0, 3_600_000, 7_200_000, 10_800_000]);
    expect(ticks(340, 'millis')).toEqual([0, 100, 200, 300, 400]);
  });

  it('rules bytes in powers of two, so a tick prints as 256 KB', () => {
    expect(ticks(1_048_576, 'bytes')).toEqual([0, 262_144, 524_288, 786_432, 1_048_576]);
    expect(ticks(500, 'bytes')).toEqual([0, 100, 200, 300, 400, 500]);
  });

  it('rules a fraction for a rate or an average', () => {
    expect(ticks(0.31, 'perSec')).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
  });

  it('gives a series that never left zero its baseline and nothing above it', () => {
    expect(ticks(0, 'count')).toEqual([0]);
  });
});

describe('withGaps', () => {
  it('breaks the line where pgops stopped capturing', () => {
    // Four captures, then 45 minutes of nothing, then three more.
    const out = withGaps(every5([1, 2, 3, 4, 5, 6, 7], [0, 0, 0, 0, 40, 0, 0]));
    expect(out).toHaveLength(8);
    expect(out[4]!.value).toBeNull();
    expect(out[4]!.at).toBe((15 + 22.5) * MIN);
  });

  /**
   * One missed tick is not a hole: a capture already running on another
   * replica is skipped rather than queued, so single gaps are normal.
   */
  it('draws through a single skipped capture', () => {
    expect(withGaps(every5([1, 2, 3, 4, 5, 6], [0, 0, 5, 0, 0, 0])).every((p) => p.value !== null)).toBe(true);
  });

  it('leaves two points alone, which have no median to judge by', () => {
    expect(withGaps(every5([1, 2]))).toHaveLength(2);
  });
});

describe('nearest', () => {
  it('picks the point closest in time, on either side', () => {
    const pts = every5([1, 2, 3]);
    expect(nearest(pts, 4 * MIN)).toBe(1);
    expect(nearest(pts, 6 * MIN)).toBe(1);
    expect(nearest(pts, 9 * MIN)).toBe(2);
    expect(nearest([], 0)).toBe(-1);
  });
});
