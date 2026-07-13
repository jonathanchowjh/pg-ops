import { describe, expect, it } from 'vitest';
import type { TriageData } from './query.js';
import { triageToMarkdown } from './render.js';

const data: TriageData = {
  sessions: {
    ok: true,
    data: {
      byState: [
        { state: 'active', sessions: 12, longestInStateSecs: 30 },
        { state: 'idle in transaction', sessions: 3, longestInStateSecs: 840 },
      ],
      oldestIdleInTxnSecs: 840,
    },
  },
  blocked: { ok: true, data: { blockedCount: 4, longestWaitSecs: 130, suspectPid: 3990 } },
  longRunning: { ok: true, data: [{ pid: 3990, runningSecs: 2460, query: 'SELECT * FROM orders' }] },
  connections: { ok: true, data: { used: 47, max: 100, headroom: 53 } },
  wraparound: { ok: true, data: { pctOfHorizon: 34 } },
  slots: { ok: false, error: 'permission denied for pg_replication_slots' },
};

describe('triageToMarkdown', () => {
  it('renders every panel with its verdict', () => {
    const md = triageToMarkdown(data);
    expect(md).toContain('## Sessions');
    expect(md).toContain('idle in transaction | 3');
    expect(md).toContain('## Blocked');
    expect(md).toContain('suspect pid 3990');
    expect(md).toContain('## Long-running');
    expect(md).toContain('## Connections');
    expect(md).toContain('47 / 100');
    expect(md).toContain('wraparound 34%');
  });

  it('renders a failed panel as n/a with its error', () => {
    expect(triageToMarkdown(data)).toContain('slots: n/a (permission denied');
  });

  it('marks a warning verdict with ⚠ and a healthy one with ✓', () => {
    const md = triageToMarkdown(data);
    // blocked: 4 waiting, longest 130s → critical
    expect(md).toMatch(/## Blocked ⚠/);
    // connections: 53% headroom → ok
    expect(md).toMatch(/## Connections ✓/);
  });

  it('isolates a failed core panel — the other panels still render', () => {
    const md = triageToMarkdown({ ...data, blocked: { ok: false, error: 'boom' } });
    expect(md).toContain('blocked: n/a (boom)');
    expect(md).toContain('## Sessions');
    expect(md).toContain('## Connections');
  });

  it('renders an empty long-running list without a table', () => {
    const md = triageToMarkdown({ ...data, longRunning: { ok: true, data: [] } });
    expect(md).toContain('No queries running longer than 5s.');
  });
});
