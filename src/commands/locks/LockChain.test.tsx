import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { LockChain } from './LockChain.js';
import type { RootBlocker } from './chain.js';

const mk = (pid: number, over: Partial<RootBlocker> = {}): RootBlocker => ({
  pid, user: 'deploy', app: 'batch-worker', query: 'UPDATE users SET x = 1',
  heldMode: 'AccessExclusiveLock', heldForSecs: 863, state: 'idle in transaction',
  backendStart: null, totalWaiters: 2, waiters: [
    { pid: pid + 1, user: 'u', app: 'web-api', query: 'q', waitingMode: 'ShareLock', table: 'users', waitingForSecs: 5, waiters: [], cycle: false, state: 'active', backendStart: null },
  ], ...over,
});

/**
 * Deliberately pathological, mirroring `geometry.test.tsx`'s `sessionRow`: a
 * `user@app` past the 20-wide `who` column, a `heldMode` past the 16-wide
 * `mode` column, and a `query` long enough to prove `truncateQuery` (never a
 * bare `.slice()`) is doing the cutting. A fixture whose cells never saturate
 * their columns proves nothing about windowing or truncation — review round
 * 1 (R1-4) found exactly this gap in the `pid` column: the windowing test
 * below used 4-digit pids in a 7-wide column, so it never would have caught
 * the `⚠` marker eating 2 of those 7 columns. Callers now pass 7-digit pids
 * (`kernel.pid_max` defaults to 4194304, so these are ordinary).
 */
const rootBlocker = (pid: number, over: Partial<RootBlocker> = {}): RootBlocker => ({
  pid,
  user: 'a-fairly-long-username',
  app: 'PostgreSQL JDBC Driver',
  query: 'SELECT '.repeat(80),
  heldMode: 'AccessExclusiveLock (unusually verbose)',
  heldForSecs: 863,
  state: 'idle in transaction',
  backendStart: null,
  totalWaiters: 2,
  waiters: [
    { pid: pid + 1, user: 'u', app: 'web-api', query: 'q', waitingMode: 'ShareLock', table: 'users', waitingForSecs: 5, waiters: [], cycle: false, state: 'active', backendStart: null },
  ],
  ...over,
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
    // Progressive-disclosure invariant: expanded content appears exactly once (selected row only)
    expect((frame.match(/UPDATE users/g) || []).length).toBe(1);
    expect((frame.match(/safe to kill/g) || []).length).toBe(1);
  });
  it('shows the healthy state when there is no contention', () => {
    const { lastFrame } = render(<LockChain roots={[]} selectedIndex={0} />);
    expect(lastFrame()).toContain('No lock contention');
  });

  it('windows a long root list rather than rendering every row', () => {
    const roots = Array.from({ length: 60 }, (_, i) => rootBlocker(1_000_000 + i));
    const { lastFrame } = render(<LockChain roots={roots} selectedIndex={0} width={120} maxLines={12} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1000000');
    // budgetRows(12, 60) = 9, so the window is [0, 9) and pid 1000009 is the
    // first excluded row — the boundary an off-by-one would leak.
    expect(frame).toContain('1000008');
    expect(frame).not.toContain('1000009');
    expect(frame).toContain('more');
  });

  // The same-line-count-at-every-width invariant for this view lives in
  // `src/ui/geometry.test.tsx` (`views` array) — that file is the chartered
  // home for that assertion across every Table-backed view. Do not duplicate
  // it here.
});
