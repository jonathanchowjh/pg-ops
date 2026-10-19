import {
  BUCKET_MS, CHAIN_THRESHOLDS, CHECKS, IDLE_THRESHOLDS, bucketFilled, chainEvents, lockTables, readCoverage, readEvents, readLoad,
  messageOf, readSamples, readStatements, recordEvent, recordSample, runCheck, sampleOf,
  type CheckResult, type EventKind, type LoadCell, type Sample, type SessionsData, type StatementInfo, type StoredEvent,
  type Threshold,
} from '@pgops/checks';
import { runCheckFor } from './check';
import { DAY_MS, gridFor, one, type Grid, type Search } from './clock';
import { ConfigError } from './config';
import { UnknownDatabaseError, contextFor, storePool } from './pools';
import { buildTree, type Marks, type Tree, type TreeInput } from './tree';

/** What the console remembers with no store: the last fifteen minutes, in this process. */
export const MEMORY_MS = 15 * 60_000;
/** The 24-hour strip's columns: eight minutes each. */
export const DAY_COLUMNS = 180;
const DAY_COLUMN_MS = DAY_MS / DAY_COLUMNS;
/** Where the 24-hour strip ends: the close of the column holding `now`. */
const dayEnd = (now: number): number => Math.floor(now / DAY_COLUMN_MS) * DAY_COLUMN_MS + DAY_COLUMN_MS;

interface Ring { samples: Sample[]; events: StoredEvent[]; statements: Map<string, StatementInfo>; down: boolean }

/**
 * This process's memory of each database. On `globalThis`, not module-level:
 * Next compiles this file into the instrumentation bundle, the page bundle
 * and each route's, and a module-level map would be three maps, so the
 * sampler's ticks and an action's event would never reach the page.
 */
const RINGS_KEY = Symbol.for('pgops.sample-rings');
const SHARED = globalThis as { [RINGS_KEY]?: Map<string, Ring> };
const RINGS = (SHARED[RINGS_KEY] ??= new Map<string, Ring>());

function ring(name: string): Ring {
  let r = RINGS.get(name);
  if (r === undefined) {
    r = { samples: [], events: [], statements: new Map(), down: false };
    RINGS.set(name, r);
  }
  return r;
}

/** For tests. */
export function forget(): void { RINGS.clear(); }

/** Where this console keeps its samples. The page opens on a window that fits it. */
export function kept(): 'store' | 'memory' {
  return storePool(process.env) === null ? 'memory' : 'store';
}

const bucketOf = (at: number) => Math.floor(at / BUCKET_MS) * BUCKET_MS;

function remember(name: string, sample: Sample, texts: ReadonlyMap<string, StatementInfo>): void {
  const r = ring(name);
  const last = r.samples.at(-1);
  if (last !== undefined && bucketOf(last.at) === bucketOf(sample.at)) return;
  const before = last === undefined ? null : { bucket: bucketOf(last.at), tables: lockTables(last) };
  r.events.push(...chainEvents(before, sample, bucketOf(sample.at)));
  r.samples.push(sample);
  for (const [key, info] of texts) {
    const known = r.statements.get(key);
    r.statements.set(key, {
      text: known?.text ?? info.text,
      relations: [...new Set([...(known?.relations ?? []), ...info.relations])].sort(),
    });
  }
  const floor = sample.at - MEMORY_MS;
  r.samples = r.samples.filter((s) => s.at >= floor);
  r.events = r.events.filter((e) => e.at >= floor);
  // A text nothing in the ring names any more goes with its samples. Without
  // `compute_query_id` every distinct literal is its own key.
  const named = new Set(r.samples.flatMap((s) => s.sessions.map((x) => x.statement)));
  for (const key of r.statements.keys()) if (!named.has(key)) r.statements.delete(key);
}

/**
 * Make a sessions read the sample for its bucket, if the bucket is free.
 * Returns the sample either way, because the page draws the read it just
 * made whether or not it was the one stored. Null when the read failed.
 * Never rejects: a store that is down must not blank the page.
 */
export async function recordFor(
  name: string,
  result: CheckResult<SessionsData>,
  at = Date.now(),
): Promise<{ sample: Sample; texts: Map<string, StatementInfo> } | null> {
  if (!result.ok) return null;
  const made = sampleOf(result.data, at);
  const store = storePool(process.env);
  if (store === null) {
    remember(name, made.sample, made.texts);
    return made;
  }
  try {
    await recordSample(store, name, made.sample, made.texts);
  } catch (err) {
    // A store that is down costs the history, not the page: memory takes over.
    storeFailed(name, 'sample not stored', err);
    remember(name, made.sample, made.texts);
  }
  return made;
}

export async function eventFor(name: string, kind: EventKind, relation = ''): Promise<void> {
  const store = storePool(process.env);
  if (store === null) {
    const r = ring(name);
    const transition = kind === 'unreachable' || kind === 'reachable';
    if (transition && r.down === (kind === 'unreachable')) return;
    if (transition) r.down = kind === 'unreachable';
    r.events.push({ at: Date.now(), kind, relation });
    return;
  }
  try {
    await recordEvent(store, name, kind, relation);
  } catch (err) {
    storeFailed(name, 'event not stored', err);
  }
}

/** The last store failure logged per database, so an outage is one line and not one a poll. */
const STORE_FAILED = new Map<string, string>();
function storeFailed(name: string, what: string, err: unknown): void {
  const message = messageOf(err);
  if (STORE_FAILED.get(name) === message) return;
  STORE_FAILED.set(name, message);
  console.error('[pgops] %s for %s; the clock is on memory until the store answers: %s', what, name, message);
}

/** Databases this process last saw unreachable, so a recovery is marked even when a page's poll made the sample. */
const DOWN = new Set<string>();

/**
 * The sampler's turn for one database: read only if nobody has filled the
 * current bucket. With a page open on it, the page's poll has, and this
 * sends nothing. Never rejects; the scheduler has no caller to reject to.
 */
export async function sampleTick(name: string): Promise<void> {
  try {
    if (await filled(name)) {
      // Someone read it, so it is reachable.
      if (DOWN.delete(name)) await eventFor(name, 'reachable');
      return;
    }
    // `contextFor`, not `runCheckFor`: there is no request here. Its first
    // connection is the probe, so a database that is down fails here.
    const result = await contextFor(name).then(
      (ctx) => runCheck(ctx, CHECKS.sessions, {}),
      (err: unknown) => {
        if (err instanceof ConfigError || err instanceof UnknownDatabaseError) throw err;
        return { ok: false as const, reason: 'unreachable' as const };
      },
    );
    if (!result.ok) {
      if (result.reason === 'unreachable') {
        DOWN.add(name);
        await eventFor(name, 'unreachable');
      }
      return;
    }
    DOWN.delete(name);
    await eventFor(name, 'reachable');
    await recordFor(name, result);
  } catch (err) {
    // Not marked unreachable: a throw here is this console's fault (its
    // configuration, its store), and the database was never asked.
    console.error('[pgops] sample failed for %s: %s', name, messageOf(err));
  }
}

/** Whether the current bucket is taken. A store that cannot say falls back to memory. */
async function filled(name: string): Promise<boolean> {
  const store = storePool(process.env);
  if (store !== null) {
    try {
      return await bucketFilled(store, name);
    } catch (err) {
      storeFailed(name, 'bucket not read', err);
    }
  }
  const last = RINGS.get(name)?.samples.at(-1);
  return last !== undefined && bucketOf(last.at) === bucketOf(Date.now());
}

/** `SampleWindow`, not `Window`: this file is compiled with the DOM lib, where `Window` is the browser's. */
export interface SampleWindow {
  samples: Sample[];
  cells: LoadCell[];
  /** How much of each column was sampled, for a window that reads the rollup. Null otherwise: the samples say. */
  coverage: number[] | null;
  day: LoadCell[];
  events: StoredEvent[];
  statements: Map<string, StatementInfo>;
  kept: 'store' | 'memory';
  /** Why the store did not answer, when this is memory standing in for it. */
  failed: string | null;
}

/**
 * What the clock needs for one window. `raw` windows read samples; wider
 * ones read the rollup. `relation` narrows the vacuum and analyze marks to
 * one table's. Never rejects: a store that is down or unmigrated leaves the
 * page on what memory holds, with the live read it just made.
 */
export async function windowFor(
  name: string,
  grid: { from: number; to: number; columns: number; raw: boolean },
  relation?: string,
): Promise<SampleWindow> {
  const store = storePool(process.env);
  let failed: string | null = null;
  if (store !== null) {
    try {
      const stored = await fromStore(store, name, grid, relation);
      STORE_FAILED.delete(name);
      return stored;
    } catch (err) {
      storeFailed(name, 'window not read', err);
      failed = messageOf(err);
    }
  }
  // `get`, not `ring`: a name in a URL must not grow the map.
  const r = RINGS.get(name);
  return {
    // `<=`: on a live window `to` is now, and so is the sample the page just took.
    samples: r?.samples.filter((s) => s.at >= grid.from && s.at <= grid.to) ?? [],
    cells: [], day: [], coverage: null,
    // readEvents' rule, so a console with no store draws the same marks.
    events: r?.events.filter((e) => e.at >= grid.from && e.at <= grid.to
      && (relation === undefined
        ? !((e.kind === 'vacuum' || e.kind === 'analyze') && e.relation !== '')
        : e.relation === '' || e.relation === relation)) ?? [],
    statements: new Map(r?.statements),
    kept: 'memory',
    failed,
  };
}

async function fromStore(
  store: NonNullable<ReturnType<typeof storePool>>,
  name: string,
  grid: { from: number; to: number; columns: number; raw: boolean },
  relation: string | undefined,
): Promise<SampleWindow> {
  const from = new Date(grid.from);
  const to = new Date(grid.to);
  const dayTo = dayEnd(Date.now());
  const [samples, cells, coverage, day, events] = await Promise.all([
    grid.raw ? readSamples(store, name, from, to) : Promise.resolve([]),
    grid.raw ? Promise.resolve([]) : readLoad(store, name, from, to, grid.columns, ['d', 't', 'q']),
    grid.raw ? Promise.resolve(null) : readCoverage(store, name, from, to, grid.columns),
    readLoad(store, name, new Date(dayTo - DAY_MS), new Date(dayTo), DAY_COLUMNS, ['d']),
    readEvents(store, name, new Date(Math.min(grid.from, dayTo - DAY_MS)), new Date(dayTo), relation),
  ]);
  const keys = new Set<string>();
  for (const s of samples) for (const x of s.sessions) if (x.statement !== null) keys.add(x.statement);
  for (const c of cells) if (c.kind === 'q') keys.add(c.key);
  return { samples, cells, coverage, day, events, statements: await readStatements(store, name, [...keys]), kept: 'store', failed: null };
}

export interface ClockRead {
  grid: Grid;
  now: number;
  /** The live sessions read. Null for a window in the past, and for a page with no sessions on it. */
  read: CheckResult<SessionsData> | null;
  /** The window ends in a read just made. */
  live: boolean;
  /** Ascending, the read just made last: it is drawn whether or not it was the one stored. */
  samples: Sample[];
  statements: Map<string, StatementInfo>;
  stored: SampleWindow;
  /** The 24-hour strip: per column, sessions not waiting on a lock, and waiting. */
  day: { to: number; columns: [number, number][] };
  /** The last 24 hours of events: the strip's marks and the stops for `[` and `]`. */
  events: StoredEvent[];
  /** A moment the URL asks to be pinned, after a hop that changed the window. */
  pinAt: number | null;
}

/**
 * One read of the clock, for every page under it: the window the URL asks
 * for, the sessions if the window is live, and what the store or memory
 * holds of it. A live read is this bucket's sample if no other tab, replica
 * or sampler tick got there first.
 *
 * `sessions: false` is a page with no session rows: it reads the strip and
 * the events and no samples. `relation` narrows the events to one table's.
 */
export async function clockFor(
  name: string, sp: Search, opts: { sessions?: boolean; relation?: string } = {},
): Promise<ClockRead> {
  // With no store the clock holds fifteen minutes, so that is the window it opens on.
  const asked = sp.win === undefined && kept() === 'memory' ? { ...sp, win: String(MEMORY_MS / 1000) } : sp;
  const sessions = opts.sessions ?? true;
  const read = sessions && gridFor(asked, Date.now()).live ? await runCheckFor(name, CHECKS.sessions, {}) : null;
  // The window ends one millisecond after the read, and the live cursor is the
  // window's last millisecond: so live is this read, not the sample before it.
  const readAt = Date.now();
  const now = readAt + 1;
  const grid = gridFor(asked, now);
  const made = read === null ? null : await recordFor(name, read, readAt);
  const stored = await windowFor(name, sessions ? grid : { ...grid, raw: false, columns: 1 }, opts.relation);

  const columns: [number, number][] = Array.from({ length: DAY_COLUMNS }, () => [0, 0]);
  for (const c of stored.day) {
    const col = columns[c.col];
    if (col !== undefined) col[c.cls === 'lock' ? 1 : 0] += c.sessions;
  }
  const dayTo = dayEnd(now);
  const pinAt = Number(one(sp.at));
  return {
    grid, now, read, live: made !== null,
    // A bucket the store already holds ends where the live read begins: the tree runs
    // each sample to the next one's moment, so the two never count or speak twice.
    samples: made === null ? stored.samples : [...stored.samples.filter((s) => s.at < made.sample.at), made.sample],
    statements: new Map([...stored.statements, ...(made?.texts ?? [])]),
    stored,
    day: { to: dayTo, columns },
    events: stored.events.filter((e) => e.at >= dayTo - DAY_MS),
    pinAt: Number.isFinite(pinAt) && pinAt >= grid.from && pinAt < grid.to ? pinAt : null,
  };
}

const mark = (list: Threshold[], level: 'warn' | 'critical'): number => list.find((t) => t.level === level)!.value;

/** The chain's and the idle transaction's marks, as every page that builds a tree passes them. */
export const MARKS: Marks = {
  chainCriticalSecs: mark(CHAIN_THRESHOLDS, 'critical'),
  idleWarnSecs: mark(IDLE_THRESHOLDS, 'warn'),
  idleCriticalSecs: mark(IDLE_THRESHOLDS, 'critical'),
};

type FromClock = 'from' | 'to' | 'columns' | 'live' | 'raw' | 'coverage' | 'samples' | 'cells' | 'events' | 'statements' | 'bucketMs' | 'marks';

/** The tree over the clock's window. Every page that draws one takes these from the clock the same way. */
export function treeFor(clock: ClockRead, input: Omit<TreeInput, FromClock>): Tree {
  const { grid } = clock;
  return buildTree({
    ...input,
    from: grid.from, to: grid.to, columns: grid.columns, live: clock.live, raw: grid.raw,
    coverage: clock.stored.coverage ?? undefined,
    samples: clock.samples, cells: clock.stored.cells, events: clock.stored.events,
    statements: clock.statements, bucketMs: BUCKET_MS, marks: MARKS,
  });
}
