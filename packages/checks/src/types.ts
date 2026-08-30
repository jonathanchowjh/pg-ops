import type { Pool } from 'pg';

export type VerdictLevel = 'ok' | 'warn' | 'critical';
export interface Verdict { level: VerdictLevel; note?: string }

/**
 * A threshold is DATA, not a constant in a comparison.
 *
 * Six of the eleven defects in the pre-port review were calibration errors:
 * correct SQL compared against a number that meant something other than the
 * label claimed. The worst shipped a `critical` at 8.38% of the horizon it was
 * named after, and 363 tests agreed with it because the test asserted the
 * constant equalled itself. `because` makes that hard to write down; `unit`
 * makes a seconds-vs-transactions mix-up a type question, not a review question.
 */
export interface Threshold {
  level: 'warn' | 'critical';
  value: number;
  unit: 'seconds' | 'transactions' | 'bytes' | 'percent' | 'count';
  /** The sentence justifying this number. MUST NOT be empty. */
  because: string;
}

export type Requirement =
  | { kind: 'extension'; name: string }
  | { kind: 'role'; name: string }
  | { kind: 'version'; min: number };

export interface SqlQuery { text: string; values?: unknown[] }

export interface Check<Row, Data, Opts = void> {
  id: string;
  title: string;
  /** `incident` renders on the triage page; `hygiene` renders on its own page and in doctor. */
  class: 'incident' | 'hygiene';
  sql: string | ((opts: Opts) => SqlQuery);
  /** Pure. Row shape in, domain data out. */
  map: (rows: Row[]) => Data;
  /** Pure. Absent means this check reports but never escalates. */
  verdict?: (data: Data, thresholds: Threshold[]) => Verdict;
  thresholds?: Threshold[];
  requires?: Requirement[];
}

export type FailureReason =
  | 'privilege' | 'missing-extension' | 'unsupported-version'
  | 'unreachable' | 'error';

export type CheckResult<D> =
  | { ok: true; data: D; verdict: Verdict; measuredAt: number }
  | { ok: false; reason: FailureReason; message: string; remedy?: string };

/**
 * Pools are passed in, never reached for. The TUI kept `let pool` at module
 * scope, which is why `fetchTriage()` took no arguments and could only ever
 * address one database — incompatible with multi-database and with a capture
 * job iterating targets.
 */
export interface CheckContext {
  target: Pool;
  /** The pgops schema. Only history-backed checks need it; absent in P0. */
  store?: Pool;
  /** `server_version_num`, e.g. 170000. */
  serverVersion: number;
}
