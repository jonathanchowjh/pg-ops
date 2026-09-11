/**
 * The tree: the four gates a request clears, in the order it clears them.
 *
 * This is the console's organising idea, and everything else is derived from
 * it — the triage page's bands, their headings, their order, and the sentence
 * under each one. It lives here, in data, rather than in a README, because a
 * model that is only written down drifts from the thing it describes. Every
 * check declares its gate (`Check.gate`), every pgHero capability in
 * `registry.ts` declares one too — including the forty not built yet — and
 * `gates.test.ts` fails if a capability is ever added without a home.
 *
 *   A query arrives
 *   │
 *   ├─ 1 connect   can it get IN?              connections · sessions · sources
 *   │              stuck → nothing runs at all
 *   │
 *   ├─ 2 wait      can it get its LOCKS?       blocked · the wait graph
 *   │              stuck → it is waiting, not slow; it does zero work
 *   │
 *   ├─ 3 work      can it do the WORK fast?    long-running · statement stats
 *   │              stuck → genuinely slow: the plan, the index, the volume
 *   │
 *   └─ 4 keep-up   can the server KEEP UP?     replication · vacuum · space
 *                  failing → not an outage today; it is tomorrow's outage
 *
 * Two properties of that order are the reason it is worth having at all.
 *
 * **Causes run down it and symptoms run up it.** Vacuum falls behind (4), so
 * tables bloat, so queries get slow (3), so connections pile up behind them
 * (1). The gate that pages you is near the top; the gate you have to fix is
 * usually further down. `causedBy` records the two edges where that is
 * literally true, and deliberately records no others.
 *
 * **A failure at one gate disguises itself as the next.** This is not theory:
 * a session blocked at gate 2 is `state = 'active'` in `pg_stat_activity`, so
 * it also appears at gate 3 as a long-running query, and the triage page used
 * to offer to terminate it — beside a panel saying, correctly, never to
 * terminate a waiter. Naming the gates is what let the page say which one a
 * session is actually stuck at (see `blockedByRoot` in the triage page).
 */
export type Gate = 'connect' | 'wait' | 'work' | 'keep-up';

/**
 * A gate, or `server` for something that describes the SERVER rather than a
 * request's progress through it — its version, its role, its settings.
 *
 * `server` is deliberately not a gate and gets no band: those facts belong in
 * the status line under the page heading, where `identity` already puts them.
 * It exists so that "which gate is this?" has an answer for every capability
 * rather than an escape hatch of `undefined`, which is the form that lets
 * things quietly arrive with no home.
 */
export type Placement = Gate | 'server';

export interface GateNode {
  /**
   * The band heading, which mirrors the TAB that goes deeper into the same
   * subject. Not a coincidence and not free wording: the bands were once
   * called `Saturation`, `Lock chains`, `Slow queries` and `Replication` —
   * a resource state, a mechanism, a symptom and a noun, so nothing told a
   * reader they were the same kind of thing — and none of them matched the
   * tab it linked to, so the console taught two names for everything.
   */
  title: string;
  /** What this gate asks, in the words somebody would actually use. */
  question: string;
  /** What being stuck HERE means, as distinct from anywhere else. */
  stuck: string;
  /**
   * The gate whose failure surfaces here as a symptom, where one genuinely
   * does. `wait` has none on purpose: a lock chain is not caused by another
   * gate, it is caused by an application holding a transaction open — which
   * is exactly why its remedy is a pid and not a setting.
   */
  causedBy?: Gate;
}

export const GATES: Record<Gate, GateNode> = {
  connect: {
    title: 'Sessions',
    question: 'is there room for the next request?',
    stuck: 'nothing runs at all — the server answers "too many clients already"',
    causedBy: 'work',
  },
  wait: {
    title: 'Locks',
    question: 'is anything waiting instead of working?',
    stuck: 'the query is queued behind another transaction and doing no work at all',
  },
  work: {
    title: 'Queries',
    question: 'is the work itself taking too long?',
    stuck: 'genuinely slow — the plan, a missing index, or simply too much data',
    causedBy: 'keep-up',
  },
  'keep-up': {
    title: 'Replication & cleanup',
    question: 'can the server keep up with what already committed?',
    stuck: 'not an outage today; it is tomorrow\'s outage',
  },
};

/**
 * Render order, which is the order a request meets them. Fixed, and not
 * sorted by severity: an operator who has used this page before knows where
 * to look before it renders, and re-ranking the bands under them during an
 * incident is when that memory is worth the most.
 */
export const GATE_ORDER: readonly Gate[] = ['connect', 'wait', 'work', 'keep-up'];
