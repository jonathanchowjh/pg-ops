import { describe, expect, it } from 'vitest';
import { relationSpace, spaceGrowth, toGrowthPoints } from '../src/series/space.js';

describe('toGrowthPoints', () => {
  const at = (d: number) => new Date(`2026-09-0${d}T00:00:00Z`);

  it('derives growth from the two stored endpoints', () => {
    const [p] = toGrowthPoints([{
      relation: 'public.t', firstBytes: 1_000, lastBytes: 9_000,
      firstAt: at(1), lastAt: at(7), points: 3,
    }]);
    expect(p!.growthBytes).toBe(8_000);
  });

  /** A relation can really shrink: VACUUM FULL, a dropped index, a detached partition. */
  it('keeps a negative growth negative rather than clamping it', () => {
    const [p] = toGrowthPoints([{
      relation: 'public.t', firstBytes: 8_000, lastBytes: 2_000,
      firstAt: at(1), lastAt: at(7), points: 2,
    }]);
    expect(p!.growthBytes).toBe(-6_000);
  });

  /**
   * With one capture `growthBytes` is arithmetically 0, which must not be
   * drawn as "did not grow"; `points` is what tells the two apart.
   */
  it('passes the capture count through, so one point is distinguishable from no growth', () => {
    const [single] = toGrowthPoints([{
      relation: 'public.once', firstBytes: 500, lastBytes: 500,
      firstAt: at(7), lastAt: at(7), points: 1,
    }]);
    const [flat] = toGrowthPoints([{
      relation: 'public.flat', firstBytes: 500, lastBytes: 500,
      firstAt: at(1), lastAt: at(7), points: 12,
    }]);
    expect(single!.growthBytes).toBe(0);
    expect(flat!.growthBytes).toBe(0);
    expect(single!.points).toBe(1);
    expect(flat!.points).toBe(12);
  });

  it('returns an empty list for a store with no captures', () => {
    expect(toGrowthPoints([])).toEqual([]);
  });
});

describe('the space series', () => {
  it('carry no verdict, because a series reports movement and does not judge it', () => {
    expect('verdict' in spaceGrowth).toBe(false);
    expect('verdict' in relationSpace).toBe(false);
  });

  it('are named for what they answer', () => {
    expect(spaceGrowth.id).toBe('spaceGrowth');
    expect(relationSpace.id).toBe('relationSpace');
  });
});
