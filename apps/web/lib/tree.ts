// Types only: this file reaches the client bundle, and the checks package carries `pg`.
import type { HealthMinute, LoadCell, Sample, SampleSession, SessionClass, StatementInfo, StoredEvent } from '@pgops/checks';
import { CLASSES } from './clock';
import { formatBytes, formatCompact, formatDuration } from './format';

/** A session shorter than this in one state is counted on its statement, never listed. */
const LASTING_MS = 30_000;
const SESSIONS_SHOWN = 3;
export const STATEMENTS_SHOWN = 20;
export const QUIET_SHOWN = 200;
/** Hot tables past this many are counted, and reached by the find box. */
export const TABLES_SHOWN = 100;
/** Two missed samples. Past this, a session seen again is a new span and a chain a new finding. */
export const GAP_MS = 40_000;
/** "Not on any table", and a statement this role cannot read. */
export const NONE = '';
/** The fold keys of "not on any table" and of the quiet tables. A table's key is its name. */
export const FOLD_NONE = '(none)';
export const FOLD_QUIET = '(quiet)';

/** Under this share of a column sampled, the column is unseen: it reads "not sampled", never 0. */
export const UNSEEN = 0.5;
export const unseenAt = (seen: readonly number[], col: number): boolean => (seen[col] ?? 1) < UNSEEN;

/** One node's load on the clock: per column, mean sessions per class, in `CLASSES` order. */
export type Strip = number[][];

export interface TableFact {
  name: string;
  sizeBytes: number;
  liveRows: number;
  /** What its row is tagged with, most urgent first. */
  flags: readonly string[];
}

/** A finding whose home is another page: the top of the tree names it and points there. */
export interface Pointer { label: string; note: string; level: 'warn' | 'critical'; href: string }
/** The marks every finding is judged against, read once from the checks' own thresholds. */
export interface Marks {
  chainCriticalSecs: number;
  idleWarnSecs: number;
  idleCriticalSecs: number;
  /** Connections left as a share of the limit, in percent: warn below the first, critical below the second. */
  headroomWarnPct: number;
  headroomCriticalPct: number;
  lagWarnSecs: number;
  lagCriticalSecs: number;
  /** Transaction ID age: warn at or past the first, critical at or past the second. Wraparound less the transactions left. */
  xidWarnAge: number;
  xidCriticalAge: number;
}

/** A health row's minute holds until the next; past this with no next it says nothing. */
const HEALTH_HOLD_MS = 150_000;

/** A statement the window's snapshots saw run, and where its plan puts it. */
export interface Shape {
  key: string;
  text: string;
  /** The tables its plan names. Null: not planned yet, or it cannot be. */
  relations: readonly string[] | null;
  callsPerSec: number;
  meanMs: number;
}

export interface TreeInput {
  from: number;
  to: number;
  columns: number;
  /** `to` is now: the last sample's spans and findings run to the window's end. */
  live: boolean;
  /**
   * The window reads samples, and so lists sessions; false reads the
   * rollup and the tree stops at statements. The grid's, not worked out
   * again from `to - from`: a wide window snapped to minutes can be exactly
   * two hours long.
   */
  raw: boolean;
  /** How much of each column some sample covered, from the store, for a window that reads the rollup. */
  coverage?: readonly number[];
  /** Ascending. Every sample of a window of two hours or less; the live one alone when wider. */
  samples: readonly Sample[];
  /** The rollup, for a window wider than two hours. Empty otherwise. */
  cells: readonly LoadCell[];
  events: readonly StoredEvent[];
  tables: readonly TableFact[];
  /** Tables in the catalog, which may be more than `tables` holds. Null when the catalog could not be read. */
  tablesTotal: number | null;
  statements: ReadonlyMap<string, StatementInfo>;
  shapes: readonly Shape[];
  /**
   * The folds the URL holds open, or null for the default: the table the
   * newest finding is on, else the hottest. Only an open table carries its
   * statements, so the page ships what it draws.
   */
  open: ReadonlySet<string> | null;
  find: string;
  bucketMs: number;
  marks: Marks;
  /** How many of the hottest statements to list flat, each with its sessions: a population's rows. */
  flat?: number;
  /** One statement to list flat whatever its load: its own page. */
  only?: string;
  /** Lasting sessions listed under a statement before the rest are counted. */
  sessionsMax?: number;
  /** The health row's minutes, with the live reads as the newest. The tree and the fleet pass them; a node's page has none. */
  health?: readonly HealthMinute[];
}

export interface Span { cls: SessionClass; from: number; to: number; blockedBy: number | null }
export interface SessionNode { pid: number; backendStart: string; app: string | null; spans: Span[]; inChain: boolean }
export interface StatementNode {
  key: string;
  /** Null when this role cannot read it. Not yet redacted: the page does that. */
  text: string | null;
  strip: Strip;
  /** Every table it was seen on, so a row can say "+2 tables". */
  tables: string[];
  sessions: SessionNode[];
  /** Lasting sessions beyond the ones listed. */
  more: number;
  /** On no table only because no plan says where. */
  unplaced: boolean;
  /** Over the window, from the stored snapshots. Null when they hold no interval for it. */
  callsPerSec: number | null;
  meanMs: number | null;
}
export interface TableNode {
  name: string;
  strip: Strip;
  open: boolean;
  /** Statements seen on it in the window, whether or not it is open. */
  shapes: number;
  /** Empty while folded. */
  statements: StatementNode[];
  /** Statements beyond the ones listed. */
  more: number;
  /** From the catalog. None for a table its cap left out. */
  flags: string[];
}

export type HealthKind = 'connections' | 'replication' | 'xid' | 'deadlock';

interface Finding {
  id: string;
  kind: 'chain' | 'idle' | HealthKind;
  /** A health finding is the server's: `NONE`. */
  table: string;
  /** The chain's root or the idle session. Null for a chain known only from its events. */
  pid: number | null;
  backendStart: string | null;
  app: string | null;
  /** A chain: when its first wait began. Idle: when the transaction went idle. */
  since: number;
  /** When the finding holds: `from <= t < to`. */
  from: number;
  to: number;
  waiters: { pid: number; from: number; to: number }[];
  /** A health finding's level, fixed for its stretch, and its worst figure as text. A chain's and an idle's are read at the cursor. */
  level?: 'warn' | 'critical';
  note?: string;
}

export interface Tree {
  from: number;
  to: number;
  columns: number;
  live: boolean;
  sessionsShown: boolean;
  /**
   * How much of each column some sample covered, 0 to 1. Under a half the
   * column is unseen: nothing was there to read, which is not the same as
   * nothing running.
   */
  seen: number[];
  /** The one scale every row strip on the page shares. */
  scale: number;
  band: Strip;
  tables: TableNode[];
  /** Hot tables beyond the ones listed. */
  tablesMore: number;
  none: TableNode | null;
  /** Empty while folded. */
  quiet: TableFact[];
  quietOpen: boolean;
  quietTotal: number;
  /** Statements flat, hottest first. Empty unless asked for. */
  flat: StatementNode[];
  /** Statements beyond the ones listed flat. */
  flatMore: number;
  findings: Finding[];
  events: StoredEvent[];
  marks: Marks;
  hidden: boolean;
  truncated: boolean;
  empty: boolean;
}

const blank = (n: number): Strip => Array.from({ length: n }, () => [0, 0, 0, 0, 0]);
const sumOf = (c: readonly number[]): number => c[0]! + c[1]! + c[2]! + c[3]! + c[4]!;
const peak = (s: Strip): number => s.reduce((m, c) => Math.max(m, sumOf(c)), 0);

/** An axis from zero in round steps of 1, 2 or 5, to the first step at or above `max`. */
export function scaleSteps(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const count = Math.ceil(max / step - 1e-9);
  return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(6)));
}

/** The row scale's top: the next round number at or above the hottest column. */
export function roundUp(max: number): number {
  return scaleSteps(max).at(-1)!;
}

/**
 * Every node's strip, counted from the samples. A sample holds from its own
 * moment to the next one, so a column narrower than a bucket is not striped.
 * `seen` is every node any sample named. On a live window that reads samples
 * the last one is the live read, and it is the newest column whole: a
 * session ended since the bucket before it reads nothing there (decision 48).
 */
function fromSamples(input: TreeInput): { strips: Map<string, Strip>; seen: Set<string>; cover: number[] } {
  const { from, to, columns, samples, bucketMs } = input;
  const width = (to - from) / columns;
  const strips = new Map<string, Strip>();
  const seen = new Set<string>();
  const cover = Array.from({ length: columns }, () => 0);
  const stripOf = (k: string): Strip => {
    let s = strips.get(k);
    if (s === undefined) { s = blank(columns); strips.set(k, s); }
    return s;
  };
  samples.forEach((sample, i) => {
    const counts = new Map<string, number[]>();
    const bump = (k: string, ci: number): void => {
      seen.add(k);
      let c = counts.get(k);
      if (c === undefined) { c = [0, 0, 0, 0, 0]; counts.set(k, c); }
      c[ci]! += 1;
    };
    for (const s of sample.sessions) {
      const ci = CLASSES.indexOf(s.cls);
      bump('d:', ci);
      // Once per table it is on: a session on three tables lights all three.
      for (const r of s.relations.length > 0 ? s.relations : [NONE]) bump(`t:${r}`, ci);
      bump(`q:${s.statement ?? NONE}`, ci);
    }
    if (input.live && input.raw && i === samples.length - 1) {
      for (const strip of strips.values()) strip[columns - 1] = [0, 0, 0, 0, 0];
      for (const [k, v] of counts) stripOf(k)[columns - 1] = [...v];
      cover[columns - 1] = 1;
      return;
    }
    const a = Math.max(sample.at, from);
    const b = Math.min(sample.at + bucketMs, samples[i + 1]?.at ?? Infinity, to);
    if (b <= a) return;
    for (let c = Math.max(0, Math.floor((a - from) / width)); c < columns && from + c * width < b; c += 1) {
      const share = (Math.min(b, from + (c + 1) * width) - Math.max(a, from + c * width)) / width;
      if (share <= 0) continue;
      cover[c]! += share;
      for (const [k, v] of counts) {
        const col = stripOf(k)[c]!;
        for (let j = 0; j < 5; j += 1) col[j]! += v[j]! * share;
      }
    }
  });
  // A column's load is the mean over the part of it that was sampled, not over all of it.
  for (const s of strips.values()) {
    s.forEach((col, c) => {
      const k = cover[c]!;
      if (k > 0 && k < 1) for (let j = 0; j < 5; j += 1) col[j]! /= k;
    });
  }
  return { strips, seen, cover: cover.map((k) => Math.min(1, k)) };
}

/**
 * The pid a waiter is ultimately queued behind. A blocker the sample does
 * not hold (idle, hidden, or in another database) is the root by default. A
 * cycle is a deadlock in flight; its lowest pid stands for it.
 */
function rootOf(waiter: SampleSession, byPid: ReadonlyMap<number, SampleSession>): number {
  const walked = new Set([waiter.pid]);
  let cur = waiter;
  for (;;) {
    if (cur.blockedBy === null) return cur.pid;
    const next = byPid.get(cur.blockedBy);
    if (next === undefined) return cur.blockedBy;
    if (walked.has(next.pid)) return Math.min(...walked);
    walked.add(next.pid);
    cur = next;
  }
}

/** The table a chain is fought over: the one most of its waiters are on. */
function tableOf(waiters: readonly SampleSession[], root: SampleSession | undefined): string {
  const votes = new Map<string, number>();
  for (const w of waiters) {
    const t = w.relations[0];
    if (t !== undefined) votes.set(t, (votes.get(t) ?? 0) + 1);
  }
  const best = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best?.[0] ?? root?.relations[0] ?? NONE;
}

/**
 * When each sample stops speaking: at the next sample, a bucket later, or
 * the window's end, whichever is first. The live sample runs to the end. A
 * stored bucket and the live read share a bucket on most polls, so without
 * the next sample's moment the older one would outlive the newer, and a
 * chain just terminated would stand until the bucket closed.
 */
function endsOf(input: TreeInput): Map<number, number> {
  const { samples, to, live, bucketMs } = input;
  return new Map(samples.map((s, i) => [
    s.at,
    live && i === samples.length - 1 ? to : Math.min(s.at + bucketMs, samples[i + 1]?.at ?? Infinity, to),
  ]));
}

/** Chains and idle transactions, each as the stretch of the window it held for. */
function findingsOf(input: TreeInput): Finding[] {
  const { samples, marks } = input;
  const ends = endsOf(input);
  const out: Finding[] = [];
  const running = new Map<string, { finding: Finding; at: number }>();
  const touch = (id: string, at: number, make: () => Finding): Finding => {
    const known = running.get(id);
    if (known !== undefined && at - known.at <= GAP_MS) {
      known.at = at;
      return known.finding;
    }
    const finding = make();
    out.push(finding);
    running.set(id, { finding, at });
    return finding;
  };

  for (const sample of samples) {
    const end = ends.get(sample.at)!;
    const byPid = new Map(sample.sessions.map((s) => [s.pid, s]));
    const chains = new Map<number, SampleSession[]>();
    for (const s of sample.sessions) {
      if (s.blockedBy === null) continue;
      const root = rootOf(s, byPid);
      // In a cycle one member stands for the root; it is not its own waiter.
      if (root === s.pid) continue;
      chains.set(root, [...(chains.get(root) ?? []), s]);
    }
    for (const [rootPid, waiters] of chains) {
      const root = byPid.get(rootPid);
      const began = Math.min(...waiters.map((w) => w.since));
      const f = touch(`chain:${rootPid}/${root?.backendStart ?? ''}`, sample.at, () => ({
        id: `chain:${rootPid}/${root?.backendStart ?? ''}@${began}`,
        kind: 'chain', table: tableOf(waiters, root),
        pid: rootPid, backendStart: root?.backendStart ?? null, app: root?.app ?? null,
        since: began, from: began, to: end, waiters: [],
      }));
      f.to = end;
      for (const w of waiters) {
        const known = f.waiters.find((x) => x.pid === w.pid && Math.abs(x.from - w.since) < 1000);
        if (known !== undefined) known.to = end;
        else f.waiters.push({ pid: w.pid, from: w.since, to: end });
      }
    }
    for (const s of sample.sessions) {
      // A root is already named by its chain.
      if (s.cls !== 'idle' || chains.has(s.pid)) continue;
      if (sample.at - s.since < marks.idleWarnSecs * 1000) continue;
      const key = `idle:${s.pid}/${s.backendStart}`;
      const f = touch(key, sample.at, () => ({
        id: `${key}@${s.since}`, kind: 'idle', table: s.relations[0] ?? NONE,
        pid: s.pid, backendStart: s.backendStart, app: s.app,
        since: s.since, from: s.since + marks.idleWarnSecs * 1000, to: end, waiters: [],
      }));
      f.to = end;
    }
  }
  return out;
}

/**
 * Chains a wide window knows only from its events: where and when, with no
 * pids and so no action. One the samples already show is left to them.
 */
function fromEvents(input: TreeInput, sampled: readonly Finding[]): Finding[] {
  const out: Finding[] = [];
  const begun = new Map<string, number>();
  const add = (table: string, from: number, to: number): void => {
    if (sampled.some((f) => f.kind === 'chain' && f.table === table && f.from < to && f.to > from)) return;
    out.push({
      id: `past:${table}@${from}`, kind: 'chain', table, pid: null, backendStart: null, app: null,
      since: from, from, to, waiters: [],
    });
  };
  for (const e of [...input.events].sort((a, b) => a.at - b.at)) {
    if (e.kind === 'chain-begin') begun.set(e.relation, e.at);
    const from = begun.get(e.relation);
    if (e.kind === 'chain-end' && from !== undefined) {
      add(e.relation, from, e.at);
      begun.delete(e.relation);
    }
  }
  for (const [table, from] of begun) add(table, from, input.to);
  return out;
}

const HEALTH_KINDS = ['connections', 'replication', 'xid'] as const;
type Judged = (typeof HEALTH_KINDS)[number];

/** One minute of one kind against the marks: its level and the figure judged, or null within the marks or unread. */
function judge(kind: Judged, p: HealthMinute, marks: Marks): { level: 'warn' | 'critical'; value: number } | null {
  const level = (critical: boolean, warn: boolean): 'warn' | 'critical' | null => (critical ? 'critical' : warn ? 'warn' : null);
  if (kind === 'connections') {
    if (p.serverConnections === null || p.maxConnections === null || p.maxConnections <= 0) return null;
    const left = (100 * (p.maxConnections - p.serverConnections)) / p.maxConnections;
    const l = level(left < marks.headroomCriticalPct, left < marks.headroomWarnPct);
    return l === null ? null : { level: l, value: p.serverConnections };
  }
  if (kind === 'replication') {
    if (p.lagSecs === null) return null;
    const l = level(p.lagSecs >= marks.lagCriticalSecs, p.lagSecs >= marks.lagWarnSecs);
    return l === null ? null : { level: l, value: p.lagSecs };
  }
  if (p.xidAge === null) return null;
  const l = level(p.xidAge >= marks.xidCriticalAge, p.xidAge >= marks.xidWarnAge);
  return l === null ? null : { level: l, value: p.xidAge };
}

function noteOf(kind: Judged, p: HealthMinute): string {
  if (kind === 'connections') return `${p.serverConnections} of ${p.maxConnections}`;
  if (kind === 'replication') {
    return p.lagBytes === null ? formatDuration(p.lagSecs) : `${formatDuration(p.lagSecs)} · ${formatBytes(p.lagBytes)}`;
  }
  return `${formatCompact(p.xidAge ?? 0)} transactions old`;
}

/**
 * The server's findings over the window, from the health row's minutes:
 * connections, replication lag and transaction ID age as one finding per
 * run of one level, each noting its worst minute; a deadlock as the counter
 * advancing between two minutes with the same `stats_reset`. A minute holds
 * until the next, or for HEALTH_HOLD_MS with none: where nobody looked,
 * nothing is said. Pure.
 */
function healthFindings(points: readonly HealthMinute[], marks: Marks, to: number): Finding[] {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const out: Finding[] = [];
  const runs = new Map<Judged, { finding: Finding; worst: number }>();
  const make = (kind: HealthKind, from: number, end: number, level: 'warn' | 'critical', note: string): Finding => ({
    id: `${kind}@${from}`, kind, table: NONE, pid: null, backendStart: null, app: null,
    since: from, from, to: end, waiters: [], level, note,
  });
  sorted.forEach((p, i) => {
    const end = Math.min(sorted[i + 1]?.at ?? to, p.at + HEALTH_HOLD_MS, to);
    for (const kind of HEALTH_KINDS) {
      const j = judge(kind, p, marks);
      const run = runs.get(kind);
      if (j !== null && run !== undefined && run.finding.level === j.level && run.finding.to >= p.at) {
        run.finding.to = end;
        if (j.value > run.worst) { run.worst = j.value; run.finding.note = noteOf(kind, p); }
        continue;
      }
      runs.delete(kind);
      if (j === null) continue;
      const f = make(kind, p.at, end, j.level, noteOf(kind, p));
      out.push(f);
      runs.set(kind, { finding: f, worst: j.value });
    }
    const prev = sorted[i - 1];
    if (prev !== undefined && p.deadlocks !== null && prev.deadlocks !== null
      && p.statsReset === prev.statsReset && p.deadlocks > prev.deadlocks) {
      const n = p.deadlocks - prev.deadlocks;
      out.push(make('deadlock', prev.at, p.at, 'warn', `${n} deadlock${n === 1 ? '' : 's'}`));
    }
  });
  return out.filter((f) => f.to > f.from);
}

interface Seen { s: SampleSession; at: number }

/** One session's stretches on one statement. A new state, a new `since` or a gap starts a new one. */
function spansOf(occ: readonly Seen[], input: TreeInput, ends: ReadonlyMap<number, number>): Span[] {
  const out: Span[] = [];
  let prev: Seen | undefined;
  for (const o of occ) {
    const end = ends.get(o.at)!;
    const cur = out.at(-1);
    const goesOn = prev !== undefined && cur !== undefined && cur.cls === o.s.cls
      && o.at - prev.at <= GAP_MS && Math.abs(o.s.since - prev.s.since) < 1000;
    if (goesOn) {
      cur!.to = end;
    } else {
      // The state changed inside the last bucket: the old stretch ends where the new one began.
      if (cur !== undefined && o.s.since > cur.from && o.s.since < cur.to) cur.to = o.s.since;
      out.push({ cls: o.s.cls, from: Math.max(o.s.since, input.from), to: end, blockedBy: o.s.blockedBy });
    }
    prev = o;
  }
  return out;
}

/**
 * The tree for one window. Pure: the same input gives the same rows in the
 * same order. There is no cursor here; the client reads any moment out of
 * what this returns, which is why pinning one never moves a row.
 */
export function buildTree(input: TreeInput): Tree {
  const { from, to, columns, statements } = input;
  const sessionsShown = input.raw;

  const { strips, seen, cover } = fromSamples(input);
  for (const c of input.cells) {
    const k = `${c.kind}:${c.key}`;
    seen.add(k);
    let s = strips.get(k);
    if (s === undefined) { s = blank(columns); strips.set(k, s); }
    const col = s[c.col];
    // The rollup's mean is over the whole column; over what was sampled of it is the reading.
    const share = input.coverage?.[c.col] ?? 1;
    if (col !== undefined) col[CLASSES.indexOf(c.cls)] = share > 0 ? c.sessions / share : c.sessions;
  }
  const covered = cover.map((k, c) => Math.max(k, input.coverage?.[c] ?? 0));
  // The read a live page just made covers the moment it was made.
  if (input.live && input.samples.length > 0) covered[columns - 1] = 1;
  const strip = (k: string): Strip => strips.get(k) ?? blank(columns);

  const sampled = findingsOf(input);
  const onTable = (sessionsShown ? sampled : [...sampled, ...fromEvents(input, sampled)])
    .sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
  const findings = [...onTable, ...healthFindings(input.health ?? [], input.marks, to)];
  const rootPids = new Set(sampled.filter((f) => f.kind === 'chain').map((f) => f.pid));
  const chainPids = new Set<number | null>(rootPids);
  for (const f of sampled) for (const w of f.waiters) chainPids.add(w.pid);

  // Which tables each statement is on, who ran it, and whether it is part of a chain.
  const onTables = new Map<string, Set<string>>();
  const ranBy = new Map<string, Map<string, Seen[]>>();
  const rootKeys = new Set<string>();
  const waiterKeys = new Set<string>();
  const place = (key: string, tables: readonly string[]): void => {
    let set = onTables.get(key);
    if (set === undefined) { set = new Set(); onTables.set(key, set); }
    for (const t of tables.length > 0 ? tables : [NONE]) set.add(t);
  };
  for (const sample of input.samples) {
    for (const s of sample.sessions) {
      const key = s.statement ?? NONE;
      place(key, s.relations);
      if (rootPids.has(s.pid)) rootKeys.add(key);
      if (s.blockedBy !== null) waiterKeys.add(key);
      let by = ranBy.get(key);
      if (by === undefined) { by = new Map(); ranBy.set(key, by); }
      const id = `${s.pid}/${s.backendStart}`;
      by.set(id, [...(by.get(id) ?? []), { s, at: sample.at }]);
    }
  }
  for (const c of input.cells) if (c.kind === 'q') place(c.key, statements.get(c.key)?.relations ?? []);
  // A shape nobody is running sits where its plan put it. With no plan it
  // sits on no table, marked, unless its locks already placed it.
  const shapes = new Map(input.shapes.map((s) => [s.key, s]));
  const unplaced = new Set<string>();
  for (const s of input.shapes) {
    if (s.relations !== null) place(s.key, s.relations);
    else if (!onTables.has(s.key)) { place(s.key, []); unplaced.add(s.key); }
    for (const t of onTables.get(s.key)!) seen.add(`t:${t}`);
  }
  /** Milliseconds of execution a second: what orders rows the samples never caught. */
  const cost = (key: string): number => {
    const s = shapes.get(key);
    return s === undefined ? 0 : s.callsPerSec * s.meanMs;
  };
  // Each table's statements and what they cost, worked out once: a database has thousands of shapes.
  const keysOn = new Map<string, string[]>();
  const weight = new Map<string, number>();
  for (const [key, on] of onTables) {
    for (const t of on) {
      const keys = keysOn.get(t);
      if (keys === undefined) keysOn.set(t, [key]);
      else keys.push(key);
      weight.set(t, (weight.get(t) ?? 0) + cost(key));
    }
  }
  // The root's statement first, then the waiters', so a tie spans two or three rows.
  const rank = (k: string): number =>
    (rootKeys.has(k) && !waiterKeys.has(k) ? 2 : rootKeys.has(k) || waiterKeys.has(k) ? 1 : 0);

  // Load is summed over the columns that closed before the last whole minute,
  // so on a live page the order moves when a minute closes, not on every poll.
  const width = (to - from) / columns;
  const settled = Math.max(1, Math.min(columns, Math.floor((Math.floor(to / 60_000) * 60_000 - from) / width)));
  const load = (s: Strip): number => {
    let t = 0;
    for (let c = 0; c < settled; c += 1) t += sumOf(s[c]!);
    return t;
  };

  const ends = endsOf(input);
  const atEnd = new Set(input.samples.at(-1)?.sessions.map((x) => `${x.pid}/${x.backendStart}`) ?? []);
  const longest = (n: SessionNode): number => n.spans.reduce((m, p) => Math.max(m, p.to - p.from), 0);
  const made = new Map<string, StatementNode>();
  const shown = input.sessionsMax ?? SESSIONS_SHOWN;
  const nodeOf = (key: string): StatementNode => {
    const known = made.get(key);
    if (known !== undefined) return known;
    const lasting = !sessionsShown ? [] : [...(ranBy.get(key)?.values() ?? [])]
      .map((occ): SessionNode => ({
        pid: occ[0]!.s.pid, backendStart: occ[0]!.s.backendStart, app: occ[0]!.s.app,
        spans: spansOf(occ, input, ends), inChain: chainPids.has(occ[0]!.s.pid),
      }))
      .filter((n) => n.inChain || longest(n) >= LASTING_MS)
      // What is still there at the window's end first, so a chain running now is not
      // listed below the ones it replaced and counted out of sight.
      .sort((a, b) => Number(atEnd.has(`${b.pid}/${b.backendStart}`)) - Number(atEnd.has(`${a.pid}/${a.backendStart}`))
        || Number(b.inChain) - Number(a.inChain) || longest(b) - longest(a) || a.pid - b.pid);
    const shape = shapes.get(key);
    const node: StatementNode = {
      key, text: statements.get(key)?.text ?? shape?.text ?? null, strip: strip(`q:${key}`),
      tables: [...(onTables.get(key) ?? [])].sort(),
      sessions: lasting.slice(0, shown), more: Math.max(0, lasting.length - shown),
      unplaced: unplaced.has(key), callsPerSec: shape?.callsPerSec ?? null, meanMs: shape?.meanMs ?? null,
    };
    made.set(key, node);
    return node;
  };

  const find = input.find.trim().toLowerCase();
  const textOf = (key: string): string => (statements.get(key)?.text ?? shapes.get(key)?.text ?? '').toLowerCase();
  const hit = (key: string): boolean =>
    textOf(key).includes(find)
    || [...(ranBy.get(key)?.values() ?? [])].some((occ) => String(occ[0]!.s.pid).includes(find));

  const hot = [...seen].filter((k) => k.startsWith('t:') && k !== 't:').map((k) => k.slice(2))
    .sort((a, b) => load(strip(`t:${b}`)) - load(strip(`t:${a}`)) || (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || a.localeCompare(b));
  const hotSet = new Set(hot);
  // With no word from the URL, open where the newest finding is, else the hottest table.
  const newest = [...onTable].sort((a, b) => b.to - a.to)[0];
  const opened = input.open ?? new Set([newest === undefined ? hot[0] ?? '' : newest.table === NONE ? FOLD_NONE : newest.table]);

  const facts = new Map(input.tables.map((t) => [t.name, t]));
  const tableNode = (name: string): TableNode | null => {
    let keys = keysOn.get(name) ?? [];
    // A find narrows to the text: a table by its name, else by what is under it.
    if (find !== '' && (name === NONE || !name.toLowerCase().includes(find))) {
      keys = keys.filter(hit);
      if (keys.length === 0) return null;
    }
    // A find opens every fold, because what was found may be inside one.
    const open = find !== '' || opened.has(name === NONE ? FOLD_NONE : name);
    const nodes = !open ? [] : keys.map(nodeOf)
      .sort((a, b) => rank(b.key) - rank(a.key) || load(b.strip) - load(a.strip) || cost(b.key) - cost(a.key) || a.key.localeCompare(b.key));
    return {
      name, flags: [...(facts.get(name)?.flags ?? [])], strip: strip(`t:${name}`), open, shapes: keys.length,
      statements: nodes.slice(0, STATEMENTS_SHOWN), more: Math.max(0, nodes.length - STATEMENTS_SHOWN),
    };
  };
  const matched = hot.map(tableNode).filter((t): t is TableNode => t !== null);
  // A table the URL opens is listed whatever its rank: its own page asks for it by name.
  const tables = matched.filter((t, i) => i < TABLES_SHOWN || (input.open?.has(t.name) ?? false));
  const none = seen.has('t:') ? tableNode(NONE) : null;

  // A table with nothing in the window is counted, and named up to a cap.
  const quietAll = input.tables
    .filter((t) => !hotSet.has(t.name) && (find === '' || t.name.toLowerCase().includes(find)))
    .sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
  const hotKnown = input.tables.filter((t) => hotSet.has(t.name)).length;

  // Every row's peak, open or folded, so folding a table never rescales the page.
  let top = 0;
  for (const [k, s] of strips) if (k !== 'd:') top = Math.max(top, peak(s));
  const quietOpen = find !== '' || opened.has(FOLD_QUIET);
  const last = input.samples.at(-1);
  // A population's rows: the same nodes, flat, in the order a table lists them.
  const flatKeys = input.only !== undefined
    ? (onTables.has(input.only) ? [input.only] : [])
    : (input.flat ?? 0) <= 0 ? [] : [...onTables.keys()].filter((k) => find === '' || hit(k)).sort((a, b) =>
      rank(b) - rank(a) || load(strip(`q:${b}`)) - load(strip(`q:${a}`)) || cost(b) - cost(a) || a.localeCompare(b));
  const flat = flatKeys.slice(0, input.only !== undefined ? 1 : input.flat).map(nodeOf);
  return {
    from, to, columns, live: input.live, sessionsShown, seen: covered,
    scale: roundUp(top * 1.02),
    band: strip('d:'),
    tables, tablesMore: matched.length - tables.length, none,
    quiet: quietOpen ? quietAll.slice(0, QUIET_SHOWN) : [],
    quietOpen,
    quietTotal: find === '' ? Math.max(quietAll.length, (input.tablesTotal ?? 0) - hotKnown) : quietAll.length,
    flat, flatMore: flatKeys.length - flat.length,
    findings,
    events: input.events.filter((e) => e.at >= from && e.at <= to),
    marks: input.marks,
    hidden: last?.hidden ?? false,
    truncated: last?.truncated ?? false,
    // A catalog that could not be read is not an empty one.
    empty: find === '' && input.tablesTotal === 0 && seen.size === 0,
  };
}

export interface Ranked { finding: Finding; level: 'warn' | 'critical'; waiting: number; secs: number }

/**
 * The findings that hold at one moment, worst first. A live page asks for
 * `tree.to - 1`: a finding holds on `from <= t < to`, and the live ones end
 * at the window's end.
 */
export function findingsAt(tree: Pick<Tree, 'findings' | 'marks'>, at: number): Ranked[] {
  const level = (secs: number, critical: number): 'warn' | 'critical' => (secs >= critical ? 'critical' : 'warn');
  return tree.findings.filter((f) => f.from <= at && at < f.to).map((finding): Ranked => {
    // A health finding was judged when it was built; its stretch is one level.
    if (finding.level !== undefined) return { finding, level: finding.level, waiting: 0, secs: (at - finding.from) / 1000 };
    if (finding.kind === 'idle') {
      const secs = (at - finding.since) / 1000;
      return { finding, level: level(secs, tree.marks.idleCriticalSecs), waiting: 0, secs };
    }
    const waiting = finding.waiters.filter((w) => w.from <= at && at < w.to);
    const began = waiting.length > 0 ? Math.min(...waiting.map((w) => w.from)) : finding.since;
    const secs = (at - began) / 1000;
    return { finding, level: level(secs, tree.marks.chainCriticalSecs), waiting: waiting.length, secs };
  }).sort((a, b) =>
    Number(b.level === 'critical') - Number(a.level === 'critical')
    || Number(b.finding.kind === 'chain') - Number(a.finding.kind === 'chain')
    || b.secs - a.secs);
}
