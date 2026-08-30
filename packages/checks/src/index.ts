export * from './types.js';
export * from './run.js';
export * from './registry.js';
export { redactSecrets } from './redact.js';

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
export type * from './checks/locks.js';
export type * from './checks/long-running.js';
export type * from './checks/query-stats.js';
export type * from './checks/sessions.js';
export type * from './checks/slots.js';
export type * from './checks/wraparound.js';
export type * from './actions/kill.js';
