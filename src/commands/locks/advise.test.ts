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
  it('does not advise waiting when an active query has unknown (null) age', () => {
    const a = adviseBlocker(root({ state: 'active', heldForSecs: null }));
    expect(a.text).toMatch(/inspect the query/);
    expect(a.text).not.toMatch(/consider waiting/);
  });
  it('does not treat a negative (clock-skewed) age as a young query', () => {
    const a = adviseBlocker(root({ state: 'active', heldForSecs: -7200 }));
    expect(a.text).toMatch(/inspect the query/);
    expect(a.text).not.toMatch(/consider waiting/);
  });
});
