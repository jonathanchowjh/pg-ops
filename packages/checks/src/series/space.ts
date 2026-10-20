import { readRelationSpace, type StoredSize } from '../store/read.js';
import type { Series } from '../types.js';

/** One relation's captured size over a window: the table page's size panel. */
export const relationSpace: Series<
  StoredSize,
  { databaseName: string; relation: string; maxPoints?: number }
> = {
  id: 'relationSpace',
  title: 'Relation size over time',
  // `ctx.store!`: runSeries returns `missing-store` before calling read.
  read: async (ctx, range, opts) => readRelationSpace(
    ctx.store!, opts.databaseName, opts.relation, range.from, range.to,
    { maxPoints: opts.maxPoints }),
};
