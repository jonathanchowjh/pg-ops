import type { Pool } from 'pg';

/**
 * A threshold is data, not a constant in a comparison: a number, its unit,
 * and the reason it matters. The tree judges against it, over time
 * (apps/web/lib/samples.ts, MARKS); a check reports and never judges.
 */
export interface Threshold {
  level: 'warn' | 'critical';
  value: number;
  unit: 'seconds' | 'transactions' | 'bytes' | 'percent' | 'count';
  /** The sentence justifying this number. Must not be empty. */
  because: string;
  /**
   * What the operator should do once this threshold is crossed. Optional: a
   * threshold with no single safe action must not invent one.
   */
  remedy?: string;
}

export type Requirement =
  | { kind: 'extension'; name: string }
  | { kind: 'role'; name: string }
  | { kind: 'version'; min: number };

export interface SqlQuery { text: string; values?: unknown[] }

/** The node a check's finding belongs to. One home each; see the spec's model. */
export type Home = 'database' | 'table' | 'query' | 'session' | 'index' | 'sequence' | 'server';
export const HOMES: readonly Home[] = ['database', 'table', 'query', 'session', 'index', 'sequence', 'server'];

export interface Check<Row, Data, Opts = void> {
  id: string;
  title: string;
  /**
   * The node this check's finding belongs to: its one placement. Required,
   * so a check cannot be built with no page to render on.
   */
  home: Home;
  /**
   * The run model.
   *
   *   live      — may run on the five-second poll.
   *   captured  — a catalog scan. The capture runs it and stores its rows, a
   *               node's own page runs it when opened, a button runs
   *               `indexBloat`. Never on a poll.
   */
  class: 'live' | 'captured';
  /**
   * `statement_timeout` for this check's own query, in milliseconds: 10s for
   * a captured read, 30s for `indexBloat`, 4s for `sessions`. A check that
   * sets none runs under the pool's backstop (apps/web/lib/pools.ts).
   */
  timeoutMs?: number;
  sql: string | ((opts: Opts) => SqlQuery);
  /** Pure. Row shape in, domain data out. */
  map: (rows: Row[]) => Data;
  thresholds?: Threshold[];
  requires?: Requirement[];
}

export type FailureReason =
  | 'privilege' | 'missing-extension' | 'unsupported-version'
  | 'unreachable' | 'error'
  /**
   * History was asked for and no store is configured. Distinct from `error`
   * so the surface can name the remedy, which is one environment variable.
   */
  | 'missing-store';

export type CheckResult<D> =
  | { ok: true; data: D; measuredAt: number }
  | { ok: false; reason: FailureReason; message: string; remedy?: string };

/** Pools are passed in, never held at module scope. */
export interface CheckContext {
  target: Pool;
  /** The pgops schema. Only history-backed checks need it. */
  store?: Pool;
  /** `server_version_num`, e.g. 170000. */
  serverVersion: number;
}

export interface TimeRange { from: Date; to: Date }

/**
 * A check answers "what is true now" with one reading. A series answers
 * "how has this moved" with many points. They share
 * pools, requirements and the failure envelope, and nothing else.
 */
export interface Series<Point, Opts = void> {
  id: string;
  title: string;
  read: (ctx: CheckContext, range: TimeRange, opts: Opts) => Promise<Point[]>;
  requires?: Requirement[];
}

/**
 * A tool answers a question the operator asks ("how would this statement
 * run?"), where a check answers one pgops asks of every database on every
 * render. Unlike a check it may take several dependent round trips. It reads
 * only.
 */
export interface Tool<Input, Data> {
  id: string;
  title: string;
  run: (ctx: CheckContext, input: Input) => Promise<Data>;
  requires?: Requirement[];
}

export type SeriesResult<P> =
  | { ok: true; points: P[]; readAt: number }
  | { ok: false; reason: FailureReason; message: string; remedy?: string };

/** What every action records about who did it and why. */
export interface ActionMeta {
  /** Which view/command issued the action — audit-log field. */
  subcommand: string;
  /** Human-readable justification — audit-log field, and required. */
  reason: string;
  /**
   * Who did it, when the caller knows better than this process does.
   * Omitted, `writeAudit` falls back to the OS user and hostname, which in a
   * container is the container ID, or 0.0.0.0 under a Next standalone server.
   */
  actor?: string;
  /** Extra target metadata for the audit entry (user, app, held_mode, state…). */
  extra?: Record<string, unknown>;
}
