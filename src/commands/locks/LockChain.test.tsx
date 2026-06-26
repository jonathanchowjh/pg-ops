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
    // Progressive-disclosure invariant: expanded content appears exactly once (selected row only)
    expect((frame.match(/UPDATE users/g) || []).length).toBe(1);
    expect((frame.match(/safe to kill/g) || []).length).toBe(1);
  });
  it('shows the healthy state when there is no contention', () => {
    const { lastFrame } = render(<LockChain roots={[]} selectedIndex={0} />);
    expect(lastFrame()).toContain('No lock contention');
  });
});
