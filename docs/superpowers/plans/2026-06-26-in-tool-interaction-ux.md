# In-tool Interaction & Flow UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `locks` view from an identity list into a decision surface — state-aware rows, an advise heuristic, progressive disclosure, pid-safe selection, liveness, and a scriptable `--snapshot` — under one consistent interaction grammar.

**Architecture:** Keep the established pipeline (query → pure transform → render/Ink). All new logic lands in pure, unit-tested functions (`chain.ts`, new `advise.ts`, helpers in `useListNavigation.ts`/`index.tsx`); the Ink components stay thin and are checked with `ink-testing-library`. Each task is independently testable and committed.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), React + Ink 5, `node-postgres`, Vitest, `ink-testing-library`.

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` sources (e.g. `./chain.js`).
- Navigation keys `j` `k` `↑` `↓` are reserved everywhere; no action key may shadow them.
- Every write action is on `x`, behind the confirm modal + audit log.
- Pure logic is TDD'd with Vitest; Ink components are checked with `ink-testing-library`.
- Postgres column names use the PG 13+ spelling already in the codebase.
- Conventional commits; commit after each task.

---

### Task 1: Move the kill action off `k` to `x`

**Files:**
- Modify: `src/commands/locks/index.tsx` (the `useListNavigation` call + `StatusBar` hints)

**Interfaces:**
- Consumes: existing `useListNavigation({ actionKeys, onAction })`.
- Produces: nothing new; `locks` now binds kill to `x`.

- [ ] **Step 1: Change the action key and hints.** In `src/commands/locks/index.tsx`, change `actionKeys: ['k']` to `actionKeys: ['x']`, and in `onAction` change `if (key === 'k' && roots[i])` to `if (key === 'x' && roots[i])`. Update the `StatusBar` `hints` to `['j/k move', 'x kill', 's snapshot', 'q quit']`.

- [ ] **Step 2: Verify it still typechecks and tests pass.**
Run: `npm run typecheck && npx vitest run`
Expected: clean typecheck, all tests pass.

- [ ] **Step 3: Live check.** Seed a chain and confirm `k` now moves up and `x` opens the kill modal.
Run: `npm run db:up && npm run db:seed` (separate terminal), then `npm run dev -- locks`; press `k` (moves), press `x` (modal). `npm run db:down` after.

- [ ] **Step 4: Commit.**
```bash
git add src/commands/locks/index.tsx
git commit -m "feat(locks): bind kill to x, freeing j/k for navigation"
```

---

### Task 2: Guard against action keys shadowing navigation

**Files:**
- Modify: `src/ui/useListNavigation.ts`
- Test: `src/ui/useListNavigation.test.tsx`

**Interfaces:**
- Produces: `assertActionKeys(actionKeys?: string[]): void` — throws if any key is a navigation key.

- [ ] **Step 1: Write the failing test.** Add to `src/ui/useListNavigation.test.tsx`:
```tsx
import { assertActionKeys } from './useListNavigation.js';

describe('assertActionKeys', () => {
  it('accepts non-navigation action keys', () => {
    expect(() => assertActionKeys(['x', 'o'])).not.toThrow();
    expect(() => assertActionKeys(undefined)).not.toThrow();
  });
  it('rejects an action key that shadows navigation', () => {
    expect(() => assertActionKeys(['k'])).toThrow(/navigation key "k"/);
    expect(() => assertActionKeys(['j'])).toThrow(/navigation key "j"/);
  });
});
```

- [ ] **Step 2: Run it, watch it fail.**
Run: `npx vitest run src/ui/useListNavigation.test.tsx -t assertActionKeys`
Expected: FAIL — `assertActionKeys` is not exported.

- [ ] **Step 3: Implement.** In `src/ui/useListNavigation.ts`, add near the top (after imports):
```ts
const NAVIGATION_KEYS = new Set(['j', 'k']);

/** Movement is reserved; an action key may never shadow it. */
export function assertActionKeys(actionKeys: string[] = []): void {
  const clash = actionKeys.find((key) => NAVIGATION_KEYS.has(key));
  if (clash) {
    throw new Error(`actionKeys cannot include navigation key "${clash}" — movement is reserved.`);
  }
}
```
Then call it once inside `useListNavigation`, immediately after `const enabled = ...`:
```ts
  assertActionKeys(opts.actionKeys);
```
And simplify the now-unnecessary special case: change
`if (input === 'k' && !opts.actionKeys?.includes('k'))` to `if (input === 'k')`.

- [ ] **Step 4: Run tests, verify pass.**
Run: `npx vitest run src/ui/useListNavigation.test.tsx`
Expected: PASS (all, including the existing filter tests).

- [ ] **Step 5: Commit.**
```bash
git add src/ui/useListNavigation.ts src/ui/useListNavigation.test.tsx
git commit -m "feat(ui): guard action keys from shadowing j/k navigation"
```

---

### Task 3: Fetch the blocker's `state` (the missing decision input)

**Files:**
- Modify: `src/commands/locks/query.ts`

**Interfaces:**
- Produces: `LockEdge` gains `blocked_state: string | null` and `blocking_state: string | null`.

- [ ] **Step 1: Add the columns to the SQL.** In `LOCK_CHAIN_SQL`, add after the `blocked_query`/`blocking_query` selections:
```sql
    blocked_act.state             AS blocked_state,
    blocking_act.state            AS blocking_state,
```

- [ ] **Step 2: Extend the `LockEdge` type.** Add to the interface:
```ts
  blocked_state: string | null;
  blocking_state: string | null;
```

- [ ] **Step 3: Coerce in `fetchLockEdges`.** Add to the mapped object:
```ts
    blocked_state: (r.blocked_state as string) ?? null,
    blocking_state: (r.blocking_state as string) ?? null,
```

- [ ] **Step 4: Verify typecheck + existing tests.**
Run: `npm run typecheck && npx vitest run src/commands/locks`
Expected: clean (chain.test.ts still passes — it builds edges via a helper we update next).

- [ ] **Step 5: Commit.**
```bash
git add src/commands/locks/query.ts
git commit -m "feat(locks): fetch blocker/waiter state from pg_stat_activity"
```

---

### Task 4: Carry `state` into the tree + per-app waiter breakdown

**Files:**
- Modify: `src/commands/locks/chain.ts`
- Test: `src/commands/locks/chain.test.ts`

**Interfaces:**
- Consumes: `LockEdge` (now with `blocked_state`/`blocking_state`).
- Produces:
  - `RootBlocker` gains `state: string | null`; `Waiter` gains `state: string | null`.
  - `waiterAppBreakdown(waiters: Waiter[]): { app: string; count: number }[]` — flattened, grouped by app, count-desc.

- [ ] **Step 1: Write failing tests.** In `src/commands/locks/chain.test.ts`, first add `blocked_state: 'active'` and `blocking_state: 'idle in transaction'` to the `edge()` defaults object. Then add:
```ts
import { buildChains, waiterAppBreakdown, formatDuration } from './chain.js';

describe('state propagation', () => {
  it('carries the blocking session state onto the root', () => {
    const roots = buildChains([edge(2, 1, { blocking_state: 'idle in transaction' })]);
    expect(roots[0]?.state).toBe('idle in transaction');
  });
});

describe('waiterAppBreakdown', () => {
  it('groups waiters by app, count descending', () => {
    const roots = buildChains([
      edge(2, 1, { blocked_app: 'web-api' }),
      edge(3, 1, { blocked_app: 'web-api' }),
      edge(4, 1, { blocked_app: 'cron' }),
    ]);
    expect(waiterAppBreakdown(roots[0]!.waiters)).toEqual([
      { app: 'web-api', count: 2 },
      { app: 'cron', count: 1 },
    ]);
  });
  it('counts nested waiters and labels missing apps as "?"', () => {
    const roots = buildChains([edge(2, 1, { blocked_app: null }), edge(3, 2, { blocked_app: null })]);
    expect(waiterAppBreakdown(roots[0]!.waiters)).toEqual([{ app: '?', count: 2 }]);
  });
});
```

- [ ] **Step 2: Run, watch fail.**
Run: `npx vitest run src/commands/locks/chain.test.ts`
Expected: FAIL — `state` undefined on root; `waiterAppBreakdown` not exported.

- [ ] **Step 3: Implement.** In `src/commands/locks/chain.ts`:
  - Add `state: string | null;` to both `RootBlocker` and `Waiter` interfaces.
  - In `buildWaiters`, add `state: edge.blocked_state,` to the pushed waiter object.
  - In `buildChains`, add `state: info?.blocking_state ?? null,` to the pushed root.
  - Append the new function:
```ts
/** Flatten the waiter tree and tally how many sessions each app has waiting. */
export function waiterAppBreakdown(waiters: Waiter[]): { app: string; count: number }[] {
  const counts = new Map<string, number>();
  const walk = (ws: Waiter[]) => {
    for (const w of ws) {
      const app = w.app ?? '?';
      counts.set(app, (counts.get(app) ?? 0) + 1);
      walk(w.waiters);
    }
  };
  walk(waiters);
  return [...counts.entries()]
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => b.count - a.count);
}
```

- [ ] **Step 4: Run, verify pass.**
Run: `npx vitest run src/commands/locks/chain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/commands/locks/chain.ts src/commands/locks/chain.test.ts
git commit -m "feat(locks): carry session state into the tree; add per-app waiter breakdown"
```

---

### Task 5: The advise heuristic

**Files:**
- Create: `src/commands/locks/advise.ts`
- Test: `src/commands/locks/advise.test.ts`

**Interfaces:**
- Consumes: `RootBlocker` (needs `state`, `heldForSecs`).
- Produces: `adviseBlocker(root: RootBlocker): { text: string; tone: 'safe' | 'caution' }`.

- [ ] **Step 1: Write failing tests.** Create `src/commands/locks/advise.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { adviseBlocker } from './advise.js';
import type { RootBlocker } from './chain.js';

function root(over: Partial<RootBlocker> = {}): RootBlocker {
  return { pid: 1, user: 'u', app: 'a', query: 'q', heldMode: 'AccessExclusiveLock',
    heldForSecs: 60, state: 'active', waiters: [], totalWaiters: 1, ...over };
}

describe('adviseBlocker', () => {
  it('flags an idle-in-transaction blocker as likely safe to kill', () => {
    const a = adviseBlocker(root({ state: 'idle in transaction', heldForSecs: 863 }));
    expect(a.tone).toBe('safe');
    expect(a.text).toMatch(/safe to kill/);
  });
  it('cautions on a young active query', () => {
    const a = adviseBlocker(root({ state: 'active', heldForSecs: 8 }));
    expect(a.tone).toBe('caution');
    expect(a.text).toMatch(/consider waiting/);
  });
  it('cautions on a long-running active query', () => {
    const a = adviseBlocker(root({ state: 'active', heldForSecs: 600 }));
    expect(a.tone).toBe('caution');
    expect(a.text).toMatch(/long-running/);
  });
});
```

- [ ] **Step 2: Run, watch fail.**
Run: `npx vitest run src/commands/locks/advise.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement.** Create `src/commands/locks/advise.ts`:
```ts
import { formatDuration, type RootBlocker } from './chain.js';

export interface Advice {
  text: string;
  tone: 'safe' | 'caution';
}

/** Heuristic verdict for the kill decision. Never auto-acts; advice only. */
export function adviseBlocker(root: RootBlocker): Advice {
  const age = formatDuration(root.heldForSecs);
  const secs = root.heldForSecs ?? 0;
  const state = root.state ?? '';
  if (state.startsWith('idle in transaction')) {
    return { tone: 'safe', text: `stuck ${age}, no running query — likely safe to kill` };
  }
  if (state === 'active' && secs < 30) {
    return { tone: 'caution', text: `active query, ${age} — real work; killing rolls it back. consider waiting` };
  }
  if (state === 'active') {
    return { tone: 'caution', text: `long-running active query (${age}) — stuck or heavy; judge by the query` };
  }
  return { tone: 'caution', text: `state ${state || 'unknown'} — inspect the query before killing` };
}
```

- [ ] **Step 4: Run, verify pass.**
Run: `npx vitest run src/commands/locks/advise.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/commands/locks/advise.ts src/commands/locks/advise.test.ts
git commit -m "feat(locks): advise heuristic for the kill decision"
```

---

### Task 6: Put state + breakdown + advise into the snapshot markdown

**Files:**
- Modify: `src/commands/locks/render.ts`
- Test: `src/commands/locks/render.test.ts` (create — render.ts currently has no test)

**Interfaces:**
- Consumes: `RootBlocker`, `waiterAppBreakdown`, `adviseBlocker`.
- Produces: `chainsToMarkdown` output now includes the blocker state line, the per-app breakdown, and the advise line.

- [ ] **Step 1: Write failing test.** Create `src/commands/locks/render.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { chainsToMarkdown } from './render.js';
import type { RootBlocker } from './chain.js';

const root: RootBlocker = {
  pid: 18432, user: 'deploy', app: 'batch-worker', query: 'UPDATE users SET x = 1',
  heldMode: 'AccessExclusiveLock', heldForSecs: 863, state: 'idle in transaction',
  totalWaiters: 2,
  waiters: [
    { pid: 2, user: 'u', app: 'web-api', query: 'q', waitingMode: 'ShareLock', table: 'users', waitingForSecs: 5, waiters: [], cycle: false, state: 'active' },
    { pid: 3, user: 'u', app: 'web-api', query: 'q', waitingMode: 'ShareLock', table: 'users', waitingForSecs: 5, waiters: [], cycle: false, state: 'active' },
  ],
};

describe('chainsToMarkdown', () => {
  it('includes state, advise, and the per-app breakdown', () => {
    const md = chainsToMarkdown([root]);
    expect(md).toContain('idle in transaction');
    expect(md).toContain('web-api×2');
    expect(md).toMatch(/safe to kill/);
  });
});
```

- [ ] **Step 2: Run, watch fail.**
Run: `npx vitest run src/commands/locks/render.test.ts`
Expected: FAIL — output lacks the new lines.

- [ ] **Step 3: Implement.** In `src/commands/locks/render.ts`, import the helpers and extend the per-root block. After the existing `- holds **...**` line, add:
```ts
    lines.push(`- state: **${root.state ?? '?'}**`);
    const breakdown = waiterAppBreakdown(root.waiters)
      .map((b) => `${b.app}×${b.count}`)
      .join(', ');
    if (breakdown) lines.push(`- waiting: ${breakdown}`);
    const advice = adviseBlocker(root);
    lines.push(`- advise: _${advice.text}_`);
```
Add the imports at the top:
```ts
import { waiterAppBreakdown } from './chain.js';
import { adviseBlocker } from './advise.js';
```

- [ ] **Step 4: Run, verify pass (and the snapshot live-probe still renders).**
Run: `npx vitest run src/commands/locks/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/commands/locks/render.ts src/commands/locks/render.test.ts
git commit -m "feat(locks): snapshots carry state, waiter breakdown, and advise"
```

---

### Task 7: Decision-grade rows with progressive disclosure (Tiers 1 & 2)

**Files:**
- Modify: `src/commands/locks/LockChain.tsx`
- Test: `src/commands/locks/LockChain.test.tsx` (create)

**Interfaces:**
- Consumes: `RootBlocker`, `waiterAppBreakdown`, `adviseBlocker`, `theme`.
- Produces: `LockChain` renders one compact line per blocker; the row at `selectedIndex` expands to query + breakdown + advise.

- [ ] **Step 1: Write the failing snapshot/behavior test.** Create `src/commands/locks/LockChain.test.tsx`:
```tsx
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { LockChain } from './LockChain.js';
import type { RootBlocker } from './chain.js';

const mk = (pid: number, over: Partial<RootBlocker> = {}): RootBlocker => ({
  pid, user: 'deploy', app: 'batch-worker', query: 'UPDATE users SET x = 1',
  heldMode: 'AccessExclusiveLock', heldForSecs: 863, state: 'idle in transaction',
  totalWaiters: 2, waiters: [
    { pid: pid + 1, user: 'u', app: 'web-api', query: 'q', waitingMode: 'ShareLock', table: 'users', waitingForSecs: 5, waiters: [], cycle: false, state: 'active' },
  ], ...over,
});

describe('LockChain', () => {
  it('shows a compact line for unselected blockers and expands the selected one', () => {
    const { lastFrame } = render(<LockChain roots={[mk(18432), mk(19001)]} selectedIndex={0} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('18432');
    expect(frame).toContain('19001');
    // selected (18432) shows the query + advise; unselected (19001) does not.
    expect(frame).toContain('UPDATE users');
    expect(frame).toMatch(/safe to kill/);
  });
  it('shows the healthy state when there is no contention', () => {
    const { lastFrame } = render(<LockChain roots={[]} selectedIndex={0} />);
    expect(lastFrame()).toContain('No lock contention');
  });
});
```

- [ ] **Step 2: Run, watch fail.**
Run: `npx vitest run src/commands/locks/LockChain.test.tsx`
Expected: FAIL — current component renders cards, not compact rows, and shows no advise.

- [ ] **Step 3: Implement.** Rewrite `src/commands/locks/LockChain.tsx` to render compact rows + an expanded selected row. Keep the empty/healthy branch. Use `theme.critical` for the `⚠`, `theme.warning` for `idle in transaction` state badge, `theme.success`/`theme.warning` for advise tone, `theme.info` for the selection marker. Concretely:
```tsx
import { Box, Text } from 'ink';
import { theme } from '../../core/theme.js';
import { adviseBlocker } from './advise.js';
import { formatDuration, waiterAppBreakdown, type RootBlocker } from './chain.js';
import { truncateQuery } from './render.js';

function CompactRow({ root, selected }: { root: RootBlocker; selected: boolean }) {
  return (
    <Text>
      <Text color={selected ? theme.info : theme.dim}>{selected ? '❯' : ' '}</Text>
      <Text color={theme.critical}>⚠ </Text>
      <Text color={theme.fg} bold={selected}>{root.pid} </Text>
      <Text color={theme.dim}>{root.user ?? '?'}@{root.app ?? '?'}  </Text>
      <Text color={theme.warning}>{root.state ?? '?'} {formatDuration(root.heldForSecs)}  </Text>
      <Text color={theme.dim}>{root.heldMode ?? '?'} · blocking {root.totalWaiters}</Text>
    </Text>
  );
}

function ExpandedDetail({ root }: { root: RootBlocker }) {
  const advice = adviseBlocker(root);
  const breakdown = waiterAppBreakdown(root.waiters).map((b) => `${b.app}×${b.count}`).join(', ');
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.dim}>    {truncateQuery(root.query, 100)}</Text>
      {breakdown ? <Text color={theme.dim}>    blocking {root.totalWaiters} → {breakdown}</Text> : null}
      <Text color={advice.tone === 'safe' ? theme.success : theme.warning}>    ▸ {advice.text}</Text>
    </Box>
  );
}

export interface LockChainProps {
  roots: RootBlocker[];
  selectedIndex: number;
}

export function LockChain({ roots, selectedIndex }: LockChainProps) {
  if (roots.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={theme.success}>No lock contention. The DB is not blocked.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      {roots.map((root, i) => (
        <Box key={root.pid} flexDirection="column">
          <CompactRow root={root} selected={i === selectedIndex} />
          {i === selectedIndex ? <ExpandedDetail root={root} /> : null}
        </Box>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: Run, verify pass.**
Run: `npx vitest run src/commands/locks/LockChain.test.tsx && npm run typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit.**
```bash
git add src/commands/locks/LockChain.tsx src/commands/locks/LockChain.test.tsx
git commit -m "feat(locks): decision-grade rows with selection-driven disclosure"
```

---

### Task 8: Liveness — "updated Ns ago"

**Files:**
- Create: `src/ui/freshness.ts`
- Test: `src/ui/freshness.test.ts`
- Modify: `src/ui/StatusBar.tsx`, `src/commands/locks/index.tsx`

**Interfaces:**
- Produces: `formatFreshness(secondsAgo: number): string`; `StatusBar` gains optional `freshness?: string` prop.

- [ ] **Step 1: Write failing test.** Create `src/ui/freshness.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatFreshness } from './freshness.js';

describe('formatFreshness', () => {
  it('reads "just now" under a second', () => expect(formatFreshness(0)).toBe('updated just now'));
  it('reads seconds', () => expect(formatFreshness(3)).toBe('updated 3s ago'));
  it('reads minutes past 60s', () => expect(formatFreshness(125)).toBe('updated 2m ago'));
});
```

- [ ] **Step 2: Run, watch fail.**
Run: `npx vitest run src/ui/freshness.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the helper.** Create `src/ui/freshness.ts`:
```ts
/** Relative freshness label for the status bar, e.g. "updated 3s ago". */
export function formatFreshness(secondsAgo: number): string {
  if (secondsAgo < 1) return 'updated just now';
  if (secondsAgo < 60) return `updated ${Math.floor(secondsAgo)}s ago`;
  return `updated ${Math.floor(secondsAgo / 60)}m ago`;
}
```

- [ ] **Step 4: Wire it in.** In `src/ui/StatusBar.tsx`, add `freshness?: string;` to `StatusBarProps` and render it after `cadence`: `{freshness ? <Text color={theme.dim}>{freshness}</Text> : null}`. In `src/commands/locks/index.tsx`: add `const [lastPollAt, setLastPollAt] = useState(() => Date.now());` set `setLastPollAt(Date.now())` at the end of a successful `poll()`; add a 1s ticker `const [, force] = useState(0); useEffect(() => { const id = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(id); }, []);` and pass `freshness={formatFreshness((Date.now() - lastPollAt) / 1000)}` to `StatusBar`.

- [ ] **Step 5: Verify.**
Run: `npx vitest run src/ui/freshness.test.ts && npm run typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 6: Commit.**
```bash
git add src/ui/freshness.ts src/ui/freshness.test.ts src/ui/StatusBar.tsx src/commands/locks/index.tsx
git commit -m "feat(ui): show data freshness in the status bar"
```

---

### Task 9: Selection follows the pid across re-polls

**Files:**
- Modify: `src/commands/locks/chain.ts` (add a tiny pure helper) + `src/commands/locks/index.tsx`
- Test: `src/commands/locks/chain.test.ts`

**Interfaces:**
- Produces: `indexForPid(roots: RootBlocker[], pid: number | undefined): number` — the row index of `pid`, or `0` if absent/empty.

- [ ] **Step 1: Write failing test.** Add to `src/commands/locks/chain.test.ts`:
```ts
import { indexForPid } from './chain.js';

describe('indexForPid', () => {
  const roots = buildChains([edge(2, 1), edge(4, 3), edge(6, 5)]); // roots sorted by waiters; all 1 waiter → insertion-ish
  it('finds the row holding the pid', () => {
    const pid = roots[1]!.pid;
    expect(indexForPid(roots, pid)).toBe(1);
  });
  it('falls back to 0 when the pid is gone or undefined', () => {
    expect(indexForPid(roots, 99999)).toBe(0);
    expect(indexForPid(roots, undefined)).toBe(0);
  });
});
```

- [ ] **Step 2: Run, watch fail.**
Run: `npx vitest run src/commands/locks/chain.test.ts -t indexForPid`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the helper.** Append to `src/commands/locks/chain.ts`:
```ts
/** Row index of the given pid, or 0 when it is absent (selection fallback). */
export function indexForPid(roots: RootBlocker[], pid: number | undefined): number {
  if (pid === undefined) return 0;
  const i = roots.findIndex((r) => r.pid === pid);
  return i === -1 ? 0 : i;
}
```

- [ ] **Step 4: Wire pid-tracking into `index.tsx`.** In `src/commands/locks/index.tsx`:
  - Track the selected pid: `const selectedPid = roots[index]?.pid;`
  - After a successful poll sets new roots, re-point the hook's index at the same pid. Use the `setIndex` returned by `useListNavigation`: in `poll()`, after `setRoots(next)`, call `setIndex(indexForPid(next, selectedPidRef.current))`. Keep `selectedPidRef` as a `useRef` updated each render to `roots[index]?.pid`.
  - Import `indexForPid`.
  This guarantees `roots[index]` (and therefore the `x`-kill target) stays the backend the user selected, even if a poll reorders the list.

- [ ] **Step 5: Verify.**
Run: `npx vitest run src/commands/locks/chain.test.ts && npm run typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 6: Commit.**
```bash
git add src/commands/locks/chain.ts src/commands/locks/chain.test.ts src/commands/locks/index.tsx
git commit -m "fix(locks): pin selection to pid so re-polls can't shift the kill target"
```

---

### Task 10: The resolution moment

**Files:**
- Modify: `src/commands/locks/index.tsx`

**Interfaces:**
- Consumes: existing `confirmKill`, `setMessage`, `RootBlocker.totalWaiters`.

- [ ] **Step 1: Show waiters-released on a successful kill.** In `confirmKill`, when the kill succeeds, set the message to include the released count captured from the pending blocker:
```ts
        ok
          ? { text: `✓ terminated pid ${target.pid} — ${target.totalWaiters} waiter(s) released`, color: 'success' }
          : { text: `pid ${target.pid} already gone`, color: 'warning' },
```

- [ ] **Step 2: Verify.**
Run: `npm run typecheck && npx vitest run`
Expected: clean, all pass.

- [ ] **Step 3: Live check.** Seed a chain, select the root, press `x`, confirm; the status bar shows "✓ terminated pid N — 2 waiter(s) released" and the chain clears on the next poll.

- [ ] **Step 4: Commit.**
```bash
git add src/commands/locks/index.tsx
git commit -m "feat(locks): show waiters-released on a successful kill"
```

---

### Task 11: `--snapshot` one-shot to stdout + README fix

**Files:**
- Modify: `src/cli.tsx`, `src/commands/locks/index.tsx`, `README.md`
- Test: `src/commands/locks/snapshot-once.test.ts` (create)

**Interfaces:**
- Produces: `runLocks({ connectionString, once })`; when `once` is true, fetch one frame, print `chainsToMarkdown` to stdout via `buildSnapshot`, and return (no Ink).

- [ ] **Step 1: Write a failing test for the one-shot body.** The renderable string is pure given edges, so test the composition. Create `src/commands/locks/snapshot-once.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildChains } from './chain.js';
import { chainsToMarkdown } from './render.js';
import { buildSnapshot } from '../../core/snapshot.js';

describe('snapshot composition for --snapshot', () => {
  it('wraps the chain markdown with the snapshot envelope', () => {
    const body = chainsToMarkdown(buildChains([]));
    const md = buildSnapshot({ subcommand: 'locks', timestamp: '2026-06-26T00:00:00Z' }, body);
    expect(md).toContain('# pgops locks snapshot');
    expect(md).toContain('No lock contention');
  });
});
```

- [ ] **Step 2: Run, verify it passes immediately** (this asserts the existing pure pieces compose — it's a guard, not new behavior).
Run: `npx vitest run src/commands/locks/snapshot-once.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the `--snapshot` flag to the parser.** In `src/cli.tsx` `ParsedArgs`, add `snapshot: boolean;`; default `false`; parse `else if (arg === '--snapshot') out.snapshot = true;`. Pass it through: `await runLocks({ connectionString: args.connectionString, once: args.snapshot });`.

- [ ] **Step 4: Implement the one-shot path in `runLocks`.** In `src/commands/locks/index.tsx`, extend `LocksOptions` with `once?: boolean;`. At the top of `runLocks`, after the pool is created, branch:
```ts
  if (opts.once) {
    try {
      const edges = await fetchLockEdges();
      const body = chainsToMarkdown(buildChains(edges));
      process.stdout.write(buildSnapshot({ subcommand: 'locks', timestamp: new Date().toISOString(), target }, body) + '\n');
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    } finally {
      await closePool();
    }
    return;
  }
```
Add the imports (`buildChains`, `fetchLockEdges`, `chainsToMarkdown`, `buildSnapshot` — most already imported). Move the `target` computation above this branch.

- [ ] **Step 5: Fix the README.** In `README.md`, change the `s` key row from "snapshot the current view to markdown (stdout)" to "snapshot the current view to a markdown file (prints the path)", and add a line under Use: `pgops locks --snapshot   # one-shot: print the chain as markdown to stdout, then exit`.

- [ ] **Step 6: Verify end-to-end.**
Run: `npm run typecheck && npx vitest run`. Then live: `npm run db:up && npm run db:seed` (other terminal), `npm run dev -- locks --snapshot` — markdown prints to stdout and the process exits. `npm run db:down`.
Expected: clean; stdout shows the chain markdown.

- [ ] **Step 7: Commit.**
```bash
git add src/cli.tsx src/commands/locks/index.tsx src/commands/locks/snapshot-once.test.ts README.md
git commit -m "feat(locks): --snapshot one-shot to stdout; fix README snapshot docs"
```

---

## Follow-on (not in this pass; tracked for later)

- **Tier 3 detail page** (`Enter` → full-screen blocker detail: untruncated query, full waiter tree, kill, `Esc` back).
- **`top` disclosure alignment** (selected query row expands to full query + stddev + cache); reorder `top` hints to the grammar.
- **`?` help overlay** (key already reserved).

## Self-Review

- **Spec coverage:** §1 grammar → Tasks 1–2; §2 decision inputs (state, breakdown) → Tasks 3–4; §3 disclosure → Task 7; §4 advise → Task 5 (+6, +7 render); §5 selection-by-pid → Task 9; §6 resolution moment → Task 10; §7 liveness → Task 8; §8 snapshot flow → Task 11; §9 top alignment → Follow-on. The `?` overlay and Tier 3 are explicitly deferred in both spec and plan. No gaps.
- **Placeholder scan:** every code step shows real code; no TBD/TODO.
- **Type consistency:** `RootBlocker`/`Waiter` gain `state: string | null` (Task 4) and every later consumer (advise Task 5, render Task 6, LockChain Task 7, the render test fixture) includes `state` on its fixtures. `waiterAppBreakdown`, `adviseBlocker`, `indexForPid`, `formatFreshness` names are used identically wherever referenced.
