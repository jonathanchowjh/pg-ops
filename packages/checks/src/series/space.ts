import {
  readRelationSpace, readSpaceGrowth, type StoredGrowth, type StoredSize,
} from '../store/read.js';
import type { Series } from '../types.js';

export interface GrowthPoint {
  relation: string;
  firstBytes: number;
  lastBytes: number;
  /** `lastBytes - firstBytes`. Negative is a real reading. */
  growthBytes: number;
  firstAt: Date;
  lastAt: Date;
  /** Captures in the window. 1 means there is no interval, not zero growth. */
  points: number;
}

/**
 * Growth is computed here only; `readSpaceGrowth` returns both endpoints.
 *
 * Negative is not clamped: a relation shrinks for ordinary reasons (VACUUM
 * FULL, a dropped index, a detached partition).
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
  // `ctx.store!`: runSeries returns `missing-store` before calling read.
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
