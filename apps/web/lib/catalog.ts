import {
  CHECKS, readCaptured, readIndexScans, readWritten, tableFlags,
  type CapturedRead, type IndexRead, type SequenceEntry, type TableRead,
} from '@pgops/checks';
import { readStore, runCheckFor, type StoreRead } from './check';
import { CAPTURE_INTERVAL_MS } from './scheduler';
import type { Pointer, TableFact } from './tree';

/** The catalog is read at most this often per database, however often a page polls. */
const FRESH_MS = 60_000;
/** Two capture intervals. Past this the store's rows are not the catalog any more, and this process reads its own. */
const STALE_MS = 2 * CAPTURE_INTERVAL_MS;
/** What one in-process read asks for: the capture's own cap. */
const CATALOG_ROWS = 5_000;
/** A find text reads the names that hold it, live, so a table past the cap is still reachable. */
const SEARCH_ROWS = 1_000;
/** Entries kept: a find box is free text, and each new text is a new key. */
const KEPT = 50;
/** Findings of one kind named at the top of the tree. The rest are on their population. */
const POINTERS_EACH = 3;

export interface Catalog {
  /** Largest first. */
  tables: TableRead[];
  /** Largest first. */
  indexes: IndexRead[];
  /** Fullest first, the unreadable last. */
  sequences: SequenceEntry[];
  /** How many the catalog holds, which may be more than the rows here. Null: never read. */
  tablesTotal: number | null;
  indexesTotal: number | null;
  /** When it was read, by the capture or by this process. Null: never. */
  at: number | null;
  /** The moment an index's scans count from. */
  statsReset: number | null;
  freezeMaxAge: number | null;
  /** Each read that failed. Its rows, if any, are the read before. */
  failed: { read: CapturedRead; message: string }[];
}

/**
 * On `globalThis` for the reason lib/samples.ts keeps its rings there. A
 * request has nowhere else to remember, and a catalog scan on a five-second
 * poll is what this file exists to prevent.
 */
const KEY = Symbol.for('pgops.catalog');
/** `at` is null while the read is in flight. */
interface Entry { at: number | null; catalog: Promise<Catalog> }
const SHARED = globalThis as { [KEY]?: Map<string, Entry> };
const SEEN = (SHARED[KEY] ??= new Map());

/** For tests. */
export function forgetCatalog(): void { SEEN.clear(); }

/**
 * A read that fails is dated too, or a scan that times out would start again
 * on every poll. A read in flight is shared: during a slow scan every poll
 * would otherwise start its own and hold a connection, and the pool would
 * empty at the moment the tree is needed.
 */
async function remembered(key: string, read: (last: Catalog | undefined) => Promise<Catalog>): Promise<Catalog> {
  const known = SEEN.get(key);
  if (known !== undefined && (known.at === null || Date.now() - known.at < FRESH_MS)) return known.catalog;
  const entry: Entry = { at: null, catalog: (async () => read(known === undefined ? undefined : await known.catalog))() };
  SEEN.delete(key);
  SEEN.set(key, entry);
  if (SEEN.size > KEPT) SEEN.delete(SEEN.keys().next().value!);
  entry.catalog.then(
    () => { entry.at = Date.now(); },
    () => { if (SEEN.get(key) === entry) SEEN.delete(key); },
  );
  return entry.catalog;
}

const sorted = (c: Catalog): Catalog => ({
  ...c,
  tables: [...c.tables].sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name)),
  indexes: [...c.indexes].sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name)),
  sequences: [...c.sequences].sort((a, b) => (b.pctUsed ?? -1) - (a.pctUsed ?? -1) || a.name.localeCompare(b.name)),
});

/** The capture's rows, or null when there is no store, it will not answer, or its capture is missing or old. */
async function fromStore(name: string): Promise<Catalog | null> {
  const read = await readStore((store) => Promise.all([
    readCaptured<TableRead>(store, name, 'tables'),
    readCaptured<IndexRead>(store, name, 'indexes'),
    readCaptured<SequenceEntry>(store, name, 'sequences'),
  ]));
  if (!read.ok) return null;
  const [t, i, s] = read.value;
  if (t === null || i === null || s === null || Date.now() - t.at > STALE_MS) return null;
  // A read that has never worked was stored with a total of 0: unknown, not empty.
  const total = (r: { ok: boolean; rows: unknown[]; total: number }): number | null => (!r.ok && r.rows.length === 0 ? null : r.total);
  const reads = [['tables', t], ['indexes', i], ['sequences', s]] as const;
  return {
    tables: t.rows, indexes: i.rows, sequences: s.rows, tablesTotal: total(t), indexesTotal: total(i),
    at: t.at, statsReset: i.statsReset ?? t.statsReset, freezeMaxAge: t.freezeMaxAge,
    failed: reads.flatMap(([read, r]) => (r.ok ? [] : [{ read, message: r.message ?? 'not read' }])),
  };
}

/** The three reads, by this process, one after another: a render is one connection wide here, as the capture is. */
async function fromDatabase(name: string, relation: string | undefined, last: Catalog | undefined): Promise<Catalog> {
  const opts = { limit: CATALOG_ROWS, relation };
  const t = await runCheckFor(name, CHECKS.tables, opts);
  const i = await runCheckFor(name, CHECKS.indexes, opts);
  const s = await runCheckFor(name, CHECKS.sequences, opts);
  // A read that fails keeps the rows before it: a stale list is better than one that vanishes for a minute.
  return {
    tables: t.ok ? t.data.tables : last?.tables ?? [],
    indexes: i.ok ? i.data.indexes : last?.indexes ?? [],
    sequences: s.ok ? s.data.sequences : last?.sequences ?? [],
    tablesTotal: t.ok ? t.data.total : last?.tablesTotal ?? null,
    indexesTotal: i.ok ? i.data.total : last?.indexesTotal ?? null,
    at: t.ok ? Date.now() : last?.at ?? null,
    statsReset: i.ok ? i.data.statsReset : t.ok ? t.data.statsReset : last?.statsReset ?? null,
    freezeMaxAge: t.ok ? t.data.freezeMaxAge : last?.freezeMaxAge ?? null,
    failed: ([['tables', t], ['indexes', i], ['sequences', s]] as const)
      .flatMap(([read, r]) => (r.ok ? [] : [{ read, message: r.message }])),
  };
}

/**
 * The catalog of one database, or of one table of it.
 *
 * The whole database is the capture's rows when the store has a fresh
 * capture, and this process's own read otherwise. One table is always asked
 * about live: its page is where the operator goes to see it as it is, and a
 * table past the capture's cap must not read as missing. Never rejects.
 */
export function catalogFor(name: string, relation?: string): Promise<Catalog> {
  return remembered(relation === undefined ? `${name}\n` : `${name}\nr:${relation}`, async (last) =>
    sorted((relation === undefined ? await fromStore(name) : null) ?? await fromDatabase(name, relation, last)));
}

const factOf = (t: TableRead, freezeMaxAge: number | null): TableFact =>
  ({ name: t.name, sizeBytes: t.sizeBytes, liveRows: t.liveRows, flags: tableFlags(t, freezeMaxAge) });

/**
 * The tables the tree counts as quiet and reaches by name: the catalog's,
 * or with a find text the ones whose name holds it, read live.
 */
export async function tablesFor(name: string, find: string): Promise<{ facts: TableFact[]; total: number | null }> {
  const search = find.trim();
  const c = search === '' ? await catalogFor(name) : await remembered(`${name}\ns:${search}`, async (last) => {
    const t = await runCheckFor(name, CHECKS.tables, { limit: SEARCH_ROWS, search });
    return {
      tables: t.ok ? t.data.tables : last?.tables ?? [], indexes: [], sequences: [],
      tablesTotal: t.ok ? t.data.total : last?.tablesTotal ?? null, indexesTotal: null,
      at: t.ok ? Date.now() : last?.at ?? null, statsReset: null,
      freezeMaxAge: t.ok ? t.data.freezeMaxAge : last?.freezeMaxAge ?? null,
      failed: t.ok ? [] : [{ read: 'tables', message: t.message }],
    };
  });
  return { facts: c.tables.map((t) => factOf(t, c.freezeMaxAge)), total: c.tablesTotal };
}

/** From here a sequence is near its limit: the `sequences` check's own mark, `sequence_danger(threshold: 0.9)`. */
export const NEAR_LIMIT_PCT = CHECKS.sequences.thresholds![0]!.value;

/**
 * What the catalog has to say at the top of the tree: a sequence near its
 * limit, a table read by full scan. Each names its node and points at its
 * page. Catalog findings exist at live only; the page leaves them out of a
 * past window.
 */
export function pointersOf(name: string, c: Catalog): Pointer[] {
  const page = (table: string): string => `/db/${name}/tables/${encodeURIComponent(table)}`;
  const near = c.sequences.filter((s) => s.pctUsed !== null && s.pctUsed >= NEAR_LIMIT_PCT).slice(0, POINTERS_EACH)
    .map((s): Pointer => ({
      label: s.name, note: `${Math.round(s.pctUsed!)}% of ${s.columnType ?? 'its range'}`, level: 'warn',
      href: s.table === null ? `/db/${name}/tables` : page(s.table),
    }));
  const scanned = c.tables.filter((t) => tableFlags(t, c.freezeMaxAge).includes('full scans')).slice(0, POINTERS_EACH)
    .map((t): Pointer => ({ label: t.name, note: 'read by full scan', level: 'warn', href: page(t.name) }));
  return [...near, ...scanned];
}

/** Rows written to each table over a window, from the hourly rollup. No store and a store that will not answer are told apart. */
export function writtenFor(name: string, grid: { from: number; to: number }): Promise<StoreRead<Map<string, number>>> {
  return readStore((store) => readWritten(store, name, new Date(grid.from), new Date(grid.to)));
}

/** Scans of each index over a window, the same way. */
export function scansFor(name: string, grid: { from: number; to: number }): Promise<StoreRead<Map<string, number>>> {
  return readStore((store) => readIndexScans(store, name, new Date(grid.from), new Date(grid.to)));
}
