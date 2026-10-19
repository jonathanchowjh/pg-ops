import {
  MAX_STATEMENT_LENGTH, OWN_SQL_MARKER, deltas, messageOf, planStatements, readEvents, readWindowStats, relationsOf,
  type StoredShape,
} from '@pgops/checks';
import { contextFor, storePool } from './pools';
import type { Shape } from './tree';

/** A window's snapshots are read at most this often: they change every five minutes. */
const FRESH_MS = 60_000;
/** The costliest this many shapes of a window. */
export const SHAPES_READ = 500;
/** Two captures at the five-minute cadence, with room for one that was skipped. */
const MIN_SPAN_MS = 11 * 60_000;
/** Windows remembered: a past window's end is part of its key. */
const KEPT = 50;

/** Planning: a few a tick, never queued behind a lock, and never long. */
export const PLACE_PER_TICK = 5;
export const PLACE_LOCK_MS = 100;
/** Nobody waits on these plans, so a plan that takes longer is not worth the connection: the operator's Explain allows ten. */
export const PLACE_TIMEOUT_MS = 1_000;
const PLACE_WINDOW_MS = 3_600_000;
/** A statement that cannot be planned is asked again this often: the table it names may have been made since. */
const RETRY_MS = 3_600_000;
const LOCK_NOT_AVAILABLE = '55P03';
const PLACED_KEPT = 5_000;

export interface WindowShape extends Shape {
  calls: number;
  /** Milliseconds of execution in the window. */
  totalMs: number;
  rowsPerCall: number;
  /** 0 to 1, or null when it touched no shared buffer. */
  cacheHit: number | null;
}

export interface Shapes {
  /** Costliest first. */
  shapes: WindowShape[];
  /** Every statement's execution time over the same stretch, for a share. Null when the window holds no two captures. */
  allMs: number | null;
}

const NONE: Shapes = { shapes: [], allMs: null };

interface Placed {
  relations: string[] | null;
  /** When to plan it again. Infinity: never. */
  again: number;
}
interface Memory {
  reads: Map<string, { at: number; value: Shapes }>;
  placed: Map<string, Map<string, Placed>>;
}

/**
 * On `globalThis` for the reason lib/samples.ts keeps its rings there: the
 * scheduler fills the plan memory and the pages read it, from different
 * bundles. Per process and never stored: a restart plans again over the
 * next minutes.
 */
const KEY = Symbol.for('pgops.shapes');
const SHARED = globalThis as { [KEY]?: Memory };
const MEMORY: Memory = (SHARED[KEY] ??= { reads: new Map(), placed: new Map() });

/** For tests. */
export function forgetShapes(): void {
  MEMORY.reads.clear();
  MEMORY.placed.clear();
}

/** One shape's interval as its numbers, or nothing when the pair spans a reset or an eviction. */
function shapeOf(s: StoredShape, resets: readonly number[]): WindowShape[] {
  const [interval] = deltas(s.points, resets);
  if (interval === undefined || interval.calls <= 0) return [];
  const seconds = (interval.to.getTime() - interval.from.getTime()) / 1000;
  if (!(seconds > 0)) return [];
  const blocks = interval.sharedBlksHit + interval.sharedBlksRead;
  return [{
    key: s.queryid, text: s.query, relations: null,
    calls: interval.calls, totalMs: interval.totalExecTime,
    callsPerSec: interval.calls / seconds, meanMs: interval.totalExecTime / interval.calls,
    rowsPerCall: interval.rows / interval.calls,
    cacheHit: blocks === 0 ? null : interval.sharedBlksHit / blocks,
  }];
}

/**
 * The statements that ran in a window, with their numbers over it and the
 * tables their plans name. From the stored snapshots, so with no store there
 * are none. Never rejects: a store that is down costs the numbers, not the
 * page.
 */
export async function shapesFor(
  name: string,
  grid: { from: number; to: number; live: boolean; winSecs: number },
): Promise<Shapes> {
  const store = storePool(process.env);
  if (store === null) return NONE;
  const key = `${name}\n${grid.winSecs}\n${grid.live ? 'live' : grid.to}`;
  let entry = MEMORY.reads.get(key);
  if (entry === undefined || Date.now() - entry.at >= FRESH_MS) {
    let value = entry?.value ?? NONE;
    try {
      const from = new Date(Math.min(grid.from, grid.to - MIN_SPAN_MS));
      const [read, events] = await Promise.all([
        readWindowStats(store, name, from, new Date(grid.to), { limit: SHAPES_READ, notLike: `%${OWN_SQL_MARKER}` }),
        readEvents(store, name, from, new Date(grid.to)),
      ]);
      const resets = events.filter((e) => e.kind === 'reset').map((e) => e.at);
      value = { shapes: read.shapes.flatMap((s) => shapeOf(s, resets)), allMs: read.allMs };
    } catch {
      // lib/samples.ts logs a store that is down; the last numbers stand.
    }
    entry = { at: Date.now(), value };
    MEMORY.reads.delete(key);
    MEMORY.reads.set(key, entry);
    if (MEMORY.reads.size > KEPT) MEMORY.reads.delete(MEMORY.reads.keys().next().value!);
  }
  // Placement is read now, not when the numbers were: the scheduler may have planned since.
  // `get`, not a map made on demand: a name in a URL must not grow the memory.
  const placed = MEMORY.placed.get(name);
  return {
    allMs: entry.value.allMs,
    shapes: entry.value.shapes.map((s) => ({ ...s, relations: placed?.get(s.key)?.relations ?? null })),
  };
}

/**
 * The scheduler's turn for one database: plan the costliest shapes of the
 * last hour that no plan has placed. PREPARE takes AccessShareLock, so it is
 * a few a tick under a 100 ms lock timeout. Never rejects.
 */
export async function placeTick(name: string): Promise<void> {
  try {
    const now = Date.now();
    const { shapes } = await shapesFor(name, { from: now - PLACE_WINDOW_MS, to: now, live: true, winSecs: PLACE_WINDOW_MS / 1000 });
    const known = MEMORY.placed.get(name) ?? new Map<string, Placed>();
    MEMORY.placed.set(name, known);
    const todo: WindowShape[] = [];
    for (const s of shapes) {
      if (todo.length === PLACE_PER_TICK) break;
      if ((known.get(s.key)?.again ?? 0) > now) continue;
      // Longer than Explain accepts, so never sent: on no table, and no turn spent on it.
      if (s.text.length > MAX_STATEMENT_LENGTH) known.set(s.key, { relations: null, again: Infinity });
      else todo.push(s);
    }
    if (todo.length > 0) {
      // `contextFor`, not `runToolFor`: there is no request here.
      const plans = await planStatements(
        await contextFor(name), todo.map((s) => s.text), { lockTimeoutMs: PLACE_LOCK_MS, statementTimeoutMs: PLACE_TIMEOUT_MS },
      );
      plans.forEach((p, i) => {
        const k = todo[i]!.key;
        known.delete(k);
        known.set(k, p.ok
          ? { relations: relationsOf(p.plan), again: Infinity }
          // A lock held now is no reason to stop asking; a statement Postgres will not plan is.
          : { relations: null, again: p.code === LOCK_NOT_AVAILABLE ? 0 : now + RETRY_MS });
      });
    }
    while (known.size > PLACED_KEPT) known.delete(known.keys().next().value!);
  } catch (err) {
    console.error('[pgops] placement failed for %s: %s', name, messageOf(err));
  }
}

/**
 * One statement's numbers over a window, for its own page. From the same
 * read the tree makes, so a statement past the window's costliest
 * SHAPES_READ has none here, and the page falls back to the live counters.
 */
export async function shapeFor(
  name: string, grid: { from: number; to: number; live: boolean; winSecs: number }, key: string,
): Promise<{ shape: WindowShape | null; allMs: number | null }> {
  const all = await shapesFor(name, grid);
  return { shape: all.shapes.find((s) => s.key === key) ?? null, allMs: all.allMs };
}
