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

  it('escapes backticks in the query so the markdown code span is not broken', () => {
    const md = chainsToMarkdown([{ ...root, query: 'SELECT `v`()' }]);
    expect(md).toContain("SELECT 'v'()");
    // the only backticks on the query line are the wrapping pair
    const queryLine = md.split('\n').find((l) => l.startsWith('- query:'))!;
    expect((queryLine.match(/`/g) || []).length).toBe(2);
  });

  it('redacts credentials embedded in the query text', () => {
    const md = chainsToMarkdown([{ ...root, query: "SELECT dblink('host=db password=hunter2 user=app')" }]);
    expect(md).not.toContain('hunter2');
    expect(md).toContain('***');
  });
});
