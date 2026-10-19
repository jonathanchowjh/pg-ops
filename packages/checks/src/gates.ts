/**
 * The tree: the four gates a request clears, in the order it clears them.
 *
 * The triage page's bands, their headings, order and sentences derive from
 * this. Every check declares its gate (`Check.gate`), as does every
 * capability in `registry.ts`; `gates.test.ts` holds this.
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
 * Causes run down the order and symptoms run up it: vacuum falls behind (4),
 * so tables bloat, so queries get slow (3), so connections pile up (1).
 * `causedBy` records the two edges where that holds.
 *
 * A failure at one gate can look like the next: a session blocked at gate 2
 * is `state = 'active'` in `pg_stat_activity`, so it also appears at gate 3
 * as a long-running query.
 */
export type Gate = 'connect' | 'wait' | 'work' | 'keep-up';

/**
 * A gate, or `server` for a fact about the server itself (version, role,
 * settings). `server` gets no band; it exists so every capability has a
 * placement rather than `undefined`.
 */
export type Placement = Gate | 'server';

export interface GateNode {
  /** The band heading. Must match the tab that goes deeper into the subject. */
  title: string;
  /** What this gate asks. */
  question: string;
  /** What being stuck at this gate means. */
  stuck: string;
  /**
   * The gate whose failure surfaces here as a symptom. `wait` has none: a
   * lock chain is caused by an application holding a transaction open, not
   * by another gate.
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
 * Render order, which is the order a request meets them. Fixed, not sorted
 * by severity, so the bands stay where an operator expects them.
 */
export const GATE_ORDER: readonly Gate[] = ['connect', 'wait', 'work', 'keep-up'];
