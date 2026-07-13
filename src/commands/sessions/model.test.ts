import { describe, expect, it } from 'vitest';
import { prepareSessions } from './model.js';
import type { SessionRow } from './query.js';

function row(pid: number, over: Partial<SessionRow> = {}): SessionRow {
  return {
    pid, state: 'idle', user: 'app', app: 'web', clientAddr: '10.0.0.1',
    backendStart: '2026-07-12 10:00:00.000000+00',
    inStateSecs: 5, runningSecs: null, query: 'SELECT 1', ...over,
  };
}

describe('prepareSessions', () => {
  it('triage sort: idle-in-transaction first (oldest first), then active by duration, then idle', () => {
    const rows = [
      row(1, { state: 'active', runningSecs: 120 }),
      row(2, { state: 'idle' }),
      row(3, { state: 'idle in transaction', inStateSecs: 900 }),
      row(4, { state: 'idle in transaction', inStateSecs: 60 }),
      row(5, { state: 'active', runningSecs: 2400 }),
    ];
    expect(prepareSessions(rows, { sort: 'triage', filter: '' }).map((r) => r.pid)).toEqual([3, 4, 5, 1, 2]);
  });

  it('active sort: active sessions by running time desc, everything else after', () => {
    const rows = [row(1, { state: 'idle' }), row(2, { state: 'active', runningSecs: 30 }), row(3, { state: 'active', runningSecs: 300 })];
    expect(prepareSessions(rows, { sort: 'active', filter: '' }).map((r) => r.pid)).toEqual([3, 2, 1]);
  });

  it('filters case-insensitively across user, app, state, and query text', () => {
    const rows = [row(1, { app: 'billing-worker' }), row(2, { query: 'UPDATE billing SET …' }), row(3)];
    expect(prepareSessions(rows, { sort: 'triage', filter: 'BILLING' }).map((r) => r.pid)).toEqual([1, 2]);
  });
});
