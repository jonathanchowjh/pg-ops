export * from './types.js';
// The tree — the four gates a request clears. Every check declares one and
// the triage page's bands are derived from it; see gates.ts.
export * from './gates.js';
// By name, not `export *`: run.ts owns both runners and `messageOf`, which
// capture.ts imports and which is not part of this package's surface.
export { runCheck, runSeries, runTool } from './run.js';
export * from './registry.js';
export { redactSecrets } from './redact.js';
export { captureOnce } from './capture.js';
export { deltas, historicalQueryStats } from './series/query-stats.js';
export { migrate, CURRENT_VERSION } from './store/schema.js';
export type * from './series/query-stats.js';
// `export type *`: the series objects stay reachable through SERIES, so there
// remains exactly one way to get one.
export type * from './series/space.js';

/**
 * The per-check domain types.
 *
 * Without these the barrel exported the FRAMEWORK — Check, CheckResult,
 * Verdict, CHECKS — but none of the shapes those generics resolve to, so a
 * consumer rendering `CHECKS.locks`'s output could not name a `Waiter`. P1a's
 * locks page hit exactly that and had to derive the type structurally
 * (`ReturnType<typeof CHECKS.locks.map>` indexed down through
 * `roots[number].waiters[number]`), which is correct but unreadable, and which
 * silently reshapes if the check's return type changes.
 *
 * `export type *` re-exports the interfaces ONLY. The check objects themselves
 * stay reachable through CHECKS, so there remains exactly one way to get a
 * check and this adds no second one.
 */
export type * from './checks/blocked.js';
export type * from './checks/connections.js';
export type * from './checks/constraints.js';
export type * from './checks/identity.js';
export type * from './checks/index-bloat.js';
export type * from './checks/indexes.js';
export type * from './checks/locks.js';
export type * from './checks/maintenance.js';
export type * from './checks/long-running.js';
export type * from './checks/query-stats.js';
export type * from './checks/replication.js';
export type * from './checks/sequences.js';
export type * from './checks/sessions.js';
export type * from './checks/settings.js';
export type * from './checks/slots.js';
export type * from './checks/space.js';
export type * from './checks/tables.js';
export type * from './checks/wraparound.js';
export type * from './actions/kill.js';
// `export type *`, like kill.ts above: the action FUNCTIONS stay reachable
// through `ACTIONS` alone, so there remains exactly one way to get one, and
// guards.test.ts can hold which files are allowed to.
export type * from './actions/stats.js';
export type * from './actions/analyze.js';
// Tools: the types by `export type *`, so the tools themselves stay reachable
// through TOOLS alone — one way to get one, as with checks and series.
export type * from './tools/explain.js';
export type * from './tools/advice.js';
export type * from './tools/suggested-indexes.js';

// slowQueries and SLOW_QUERY_DEFAULTS are VALUES, not types — `export type *`
// above carries interfaces only, so without this apps/web cannot import them
// and the queries page fails to compile.
export { slowQueries, SLOW_QUERY_DEFAULTS } from './checks/query-stats.js';
// Same reason: `settingNames` is the function the settings check's own
// integration test and any caller that needs the asked-for list uses, and
// `export type *` above cannot carry it.
export { settingNames } from './checks/settings.js';
// A value: the explain route refuses bad input by the tool's own rule, before
// it opens a connection, rather than restating the rule.
export { checkStatement } from './tools/explain.js';
// A value: the suggestions page names the thresholds it applied.
export { SUGGESTION_DEFAULTS } from './tools/suggested-indexes.js';
