import type { Placement } from './gates.js';
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
  /**
   * What the operator should DO once this threshold is crossed.
   *
   * Lives here rather than on `Verdict` because it completes the same
   * thought: a threshold is a number, the reason that number matters, and
   * the action it calls for. Splitting the action onto the verdict would
   * separate it from the only value that decides whether it applies, and
   * would have meant editing all nine `verdict()` functions to carry a
   * constant they do not compute.
   *
   * `registry.ts` already states the rule this closes — "pgHero's capability
   * is the probe plus the remedy" — but the package applied it to only one
   * of the two paths. `CheckResult`'s `ok: false` branch carries a `remedy`
   * for a check that BROKE (`CREATE EXTENSION pg_stat_statements`); nothing
   * carried one for a check that WORKED and found a problem. So pgops could
   * explain how to repair itself and not how to repair the database.
   *
   * Optional: a threshold whose crossing has no single safe action must not
   * invent one. Silence is correct where advice would be a guess.
   */
  remedy?: string;
}

export type Requirement =
  | { kind: 'extension'; name: string }
  | { kind: 'role'; name: string }
  | { kind: 'version'; min: number };

export interface SqlQuery { text: string; values?: unknown[] }

export interface Check<Row, Data, Opts = void> {
  id: string;
  title: string;
  /**
   * Which gate of a request's life this check measures — see gates.ts, which
   * is the console's organising model and the thing the triage page's bands
   * are derived from.
   *
   * Required, and deliberately not optional. A check with no gate is a check
   * with no home on any page, and the way that goes wrong is silent: it gets
   * built, it runs, and it renders nowhere. Making the compiler ask the
   * question is cheaper than a guard that notices later.
   */
  gate: Placement;
  /**
   * The RUN MODEL, and only that. Surface follows from it; it is not decided
   * per check any more.
   *
   *   incident   — run live on every render; its page polls at 5s.
   *   hygiene    — the scheduler runs it; pages read the cached result.
   *   on-demand  — run only when the operator clicks through to it.
   *
   * `on-demand` exists so `index_bloat` — a multi-CTE estimate that pgHero
   * itself keeps off the page you open by reflex — is a class member rather
   * than an exception carved out in prose. See spec 2026-09-03 §2.
   */
  class: 'incident' | 'hygiene' | 'on-demand';
  /**
   * `statement_timeout` for this check's own query, in milliseconds.
   *
   * Per-check rather than a global constant, because an expensive check can
   * afford more than a cheap one: 10s for hygiene, 30s for `index_bloat` on
   * its own route where a wait is expected. Incident checks poll at 5s and
   * set none — they must stay well inside the interval by construction, and
   * a timeout would only convert one silent problem into another.
   */
  timeoutMs?: number;
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
  | 'unreachable' | 'error'
  /**
   * History was asked for and no store is configured.
   *
   * A distinct reason rather than `error` for the same purpose the others
   * serve: `reason` is machine-readable so the surface renders the exact
   * remedy, and the remedy here is one environment variable, not a GRANT or a
   * CREATE EXTENSION. Reported as `error`, an unconfigured store would read
   * to an operator as their database being unwell — the misattribution class
   * run.ts's I1 and check.ts's M8/F4 docblocks were both written against.
   */
  | 'missing-store';

/**
 * `verdict: null` means the check does not judge — it reports a reading an
 * operator looks at, and has no opinion to escalate.
 *
 * `runCheck` used to substitute `{level: 'ok'}` here, which made "we do not
 * judge" indistinguishable from "we judged and it is fine". That is this
 * project's own `ok:false`-vs-`ok:true` discipline, violated one level down.
 * It was harmless while every check was `incident` and the overview ranked
 * `ok` at 0; it stops being harmless in P2, where a per-area badge reads
 * these verdicts and a substituted `ok` paints a green dot on an area
 * nobody has an opinion about. See spec 2026-09-03 §1.1.
 */
export type CheckResult<D> =
  | {
      ok: true; data: D; verdict: Verdict | null; measuredAt: number;
      /**
       * The threshold `verdict` crossed, when it crossed one — so a surface
       * can show WHY the number matters and what to do, not just its colour.
       * Absent for `ok` and for checks that do not judge. See run.ts.
       */
      crossed?: Threshold;
    }
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

export interface TimeRange { from: Date; to: Date }

/**
 * A check answers "what is true now" and yields one verdict. A series answers
 * "how has this moved" and yields many points with NO verdict at all. They
 * share pools, requirements and the failure envelope, and share nothing else
 * — siblings, not variants. See the parent spec §4.1.
 *
 * They live beside `Check` and `CheckResult` rather than in a `series/`
 * module of their own for that reason: this file is the framework's shapes,
 * `run.ts` is its runners, and everything under `checks/`, `actions/` and
 * `series/` is an instance. A `series/types.ts` that also held `runSeries`
 * broke that split in both directions at once.
 */
export interface Series<Point, Opts = void> {
  id: string;
  title: string;
  read: (ctx: CheckContext, range: TimeRange, opts: Opts) => Promise<Point[]>;
  requires?: Requirement[];
}

/**
 * A tool answers a question the OPERATOR asks — "how would this statement
 * run?", "which index would my slow queries use?" — where a check answers one
 * pgops asks of every database on every render.
 *
 * Neither existing shape fits, and spec 2026-09-03 §7 said so without
 * designing the answer. `Check.sql` is parameterised by options and makes ONE
 * round trip into a pure `map`; `explain` is parameterised by operator-supplied
 * SQL and makes several dependent round trips (prepare, count parameters,
 * explain, then read the catalog for the relations the plan names). `Series`
 * reads the store. An action mutates. A tool does none of those: it reads, on
 * request, in as many steps as the question needs.
 *
 * Like a series, a tool never judges — `runTool` yields `verdict: null`.
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

/**
 * What every action records about who did it and why.
 *
 * Here rather than in actions/kill.ts because three action modules need it,
 * and an action importing a type from a sibling action would be a dependency
 * between two things whose only intended meeting point is `ACTIONS`.
 */
export interface ActionMeta {
  /** Which view/command issued the action — audit-log field. */
  subcommand: string;
  /** Human-readable justification — audit-log field, and required. */
  reason: string;
  /**
   * Who did it, when the caller knows better than this process does.
   *
   * `writeAudit` derives `user` from `currentActor()` — the OS user, plus
   * `process.env.HOSTNAME || hostname()`. That is right for a CLI on a
   * bastion host and wrong inside a container, where HOSTNAME is the
   * container ID, and wronger still once a Next standalone server pins it to
   * 0.0.0.0 so it binds on all interfaces (verified: next/dist/build/utils.js
   * generates `process.env.HOSTNAME || '0.0.0.0'` into server.js). A web
   * console authenticating an operator knows their name; nothing else in
   * this process does. Omitted, the fallback is unchanged.
   */
  actor?: string;
  /** Extra target metadata for the audit entry (user, app, held_mode, state…). */
  extra?: Record<string, unknown>;
}
