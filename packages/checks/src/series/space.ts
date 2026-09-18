import {
  readRelationSpace, readSpaceGrowth, type StoredGrowth, type StoredSize,
} from '../store/read.js';
import type { Series } from '../types.js';

export interface GrowthPoint {
  relation: string;
  firstBytes: number;
  lastBytes: number;
  /** `lastBytes - firstBytes`. Negative is a real reading — see the docblock. */
  growthBytes: number;
  firstAt: Date;
  lastAt: Date;
  /** Captures in the window. 1 means there is no interval, not zero growth. */
  points: number;
}

/**
 * The one subtraction, in one place.
 *
 * `readSpaceGrowth` returns both endpoints rather than their difference so the
 * surface can show what the window actually contained — computing the
 * difference in SQL as well would be two expressions that drift.
 *
 * Negative is NOT clamped. A relation shrinks for ordinary reasons — VACUUM
 * FULL, a dropped index, a detached partition — and a space page that can only
 * count upward cannot show an operator that the thing they just did worked.
 */
export function toGrowthPoints(rows: StoredGrowth[]): GrowthPoint[] {
  return rows.map((r) => ({
    relation: r.relation,
    firstBytes: r.firstBytes,
    lastBytes: r.lastBytes,
    growthBytes: r.lastBytes - r.firstBytes,
    firstAt: r.firstAt,
    lastAt: r.lastAt,
    points: r.points,
  }));
}

export const spaceGrowth: Series<GrowthPoint, { databaseName: string }> = {
  id: 'spaceGrowth',
  title: 'Space growth',
  // `ctx.store!`: runSeries returns `missing-store` before ever calling read,
  // so the store is present here by construction — the same note
  // historicalQueryStats carries. Reached any other way this throws, and
  // runSeries converts that to ok:false like any other error.
  read: async (ctx, range, opts) =>
    toGrowthPoints(await readSpaceGrowth(ctx.store!, opts.databaseName, range.from, range.to)),
};

export const relationSpace: Series<
  StoredSize,
  { databaseName: string; relation: string; maxPoints?: number }
> = {
  id: 'relationSpace',
  title: 'Relation size over time',
  read: async (ctx, range, opts) => readRelationSpace(
    ctx.store!, opts.databaseName, opts.relation, range.from, range.to,
    { maxPoints: opts.maxPoints }),
};
