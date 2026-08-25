import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunViewOptions } from '../../core/run-view.js';
import type { TriageData } from '../home/query.js';
import type { LockEdge } from '../locks/query.js';
import type { SessionRow } from '../sessions/query.js';
import type { QueryStat } from '../top/query.js';
import type { ShellProps } from './Shell.js';

/**
 * `runShell` is the CLI's only door into the app (RULING R-P6), so this file
 * asks two things of it: does `pgops <tab>` open the shell on THAT tab, and
 * does `--snapshot` still produce the one-shot each subcommand used to produce
 * on its own?
 *
 * `runView` is stubbed to CAPTURE its options rather than act on them — the
 * real one renders Ink and blocks on `waitUntilExit()`, which no test can
 * escape. What `runView` then DOES with those options (the exit-code contract)
 * is proven directly in `src/core/run-view.test.tsx`, and end-to-end through
 * the real binary in `src/cli.test.ts`. Here we prove the wiring between them:
 * that the right `snapshot`, `failure` and `mapError` reach it.
 */

const calls: RunViewOptions[] = [];
vi.mock('../../core/run-view.js', async (orig) => ({
  ...(await orig()),
  runView: async (opts: RunViewOptions) => {
    calls.push(opts);
  },
}));

const mockTriage = vi.fn();
const mockLocks = vi.fn();
const mockSessions = vi.fn();
const mockTop = vi.fn();
vi.mock('../home/query.js', async (orig) => ({ ...(await orig()), fetchTriage: () => mockTriage() }));
vi.mock('../locks/query.js', async (orig) => ({ ...(await orig()), fetchLockEdges: () => mockLocks() }));
vi.mock('../sessions/query.js', async (orig) => ({ ...(await orig()), fetchSessions: () => mockSessions() }));
vi.mock('../top/query.js', async (orig) => ({ ...(await orig()), fetchQueryStats: () => mockTop() }));

const { runShell } = await import('./run.js');
const { Shell } = await import('./Shell.js');

/** The single captured `runView` call. Fails loudly if there wasn't exactly one. */
function captured(): RunViewOptions {
  expect(calls).toHaveLength(1);
  const only = calls[0];
  if (only === undefined) throw new Error('unreachable: length asserted above');
  return only;
}

/** The element `runView` would have rendered, typed as what it must be. */
function mounted(target?: string): ReactElement<ShellProps> {
  return captured().view(target) as ReactElement<ShellProps>;
}

const healthy: TriageData = {
  sessions: { ok: true, data: { byState: [{ state: 'active', sessions: 3, longestInStateSecs: 9 }], oldestIdleInTxnSecs: null } },
  blocked: { ok: true, data: { blockedCount: 0, longestWaitSecs: 0, suspectPid: null } },
  longRunning: { ok: true, data: [] },
  connections: { ok: true, data: { used: 5, max: 100, headroom: 95 } },
  wraparound: { ok: true, data: { pctOfHorizon: 3 } },
  slots: { ok: true, data: { inactiveCount: 0, retainedBytes: 0, worstSlot: null } },
};

/** The unreachable-database shape: `fetchTriage` RESOLVES with six failures. */
const REFUSED = 'connect ECONNREFUSED 127.0.0.1:1';
const allFailed: TriageData = {
  sessions: { ok: false, error: REFUSED },
  blocked: { ok: false, error: REFUSED },
  longRunning: { ok: false, error: REFUSED },
  connections: { ok: false, error: REFUSED },
  wraparound: { ok: false, error: REFUSED },
  slots: { ok: false, error: REFUSED },
};

const edge: LockEdge = {
  blocked_pid: 6662,
  blocking_pid: 6661,
  blocked_user: 'app',
  blocking_user: 'batch',
  blocked_app: 'web',
  blocking_app: 'worker',
  locktype: 'relation',
  waiting_mode: 'AccessExclusiveLock',
  held_mode: 'RowExclusiveLock',
  table_name: 'orders',
  blocking_query: 'UPDATE orders SET total = 1',
  blocked_query: 'ALTER TABLE orders ADD COLUMN x int',
  blocked_state: 'active',
  blocking_state: 'idle in transaction',
  blocked_for_secs: 12,
  blocking_for_secs: 600,
  blocked_backend_start: '2026-08-21 10:05:00.000000+00',
  blocking_backend_start: '2026-08-21 10:00:00.000000+00',
};

const session: SessionRow = {
  pid: 5551,
  state: 'idle in transaction',
  user: 'app',
  app: 'web',
  clientAddr: null,
  backendStart: '2026-08-21 10:00:00+00',
  inStateSecs: 840,
  runningSecs: null,
  query: 'BEGIN',
};

const stat: QueryStat = {
  queryid: '42',
  query: 'UPDATE inventory SET qty = $1',
  calls: 120,
  totalMs: 5400,
  meanMs: 45,
  stddevMs: 10,
  rows: 120,
  sharedBlksHit: 900,
  sharedBlksRead: 100,
};

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe('runShell — which tab the subcommand opens', () => {
  it('mounts the shell on the named tab, and hands the view the redacted target', async () => {
    await runShell({ tab: 'locks' });
    const el = mounted('db.example:5432/appdb');
    expect(el.type).toBe(Shell);
    expect(el.props.initialTab).toBe('locks');
    expect(el.props.target).toBe('db.example:5432/appdb');
  });

  it('mounts the shell on `sessions` for `pgops sessions`', async () => {
    await runShell({ tab: 'sessions' });
    expect(mounted().props.initialTab).toBe('sessions');
  });

  it('mounts the shell on `top` for `pgops top`', async () => {
    await runShell({ tab: 'top' });
    expect(mounted().props.initialTab).toBe('top');
  });

  it('opens the cockpit when no tab was named — bare `pgops`', async () => {
    await runShell({});
    expect(mounted().type).toBe(Shell);
    expect(mounted().props.initialTab).toBe('triage');
  });

  it('passes the connection string and the one-shot flag straight through', async () => {
    await runShell({ tab: 'top', connectionString: 'postgres://u:p@h:5432/d', once: true });
    expect(captured().connectionString).toBe('postgres://u:p@h:5432/d');
    expect(captured().once).toBe(true);
  });

  it('leaves the one-shot flag off for an interactive run', async () => {
    await runShell({ tab: 'top' });
    expect(captured().once).toBeFalsy();
  });
});

describe('runShell --snapshot — one body per tab', () => {
  it('labels the snapshot envelope with the tab, so `pgops locks --snapshot` says locks', async () => {
    await runShell({ tab: 'locks', once: true });
    expect(captured().subcommand).toBe('locks');
  });

  it('labels a bare `pgops --snapshot` as triage', async () => {
    await runShell({ once: true });
    expect(captured().subcommand).toBe('triage');
  });

  it('renders the lock chain for `locks`', async () => {
    mockLocks.mockResolvedValue([edge]);
    await runShell({ tab: 'locks', once: true });
    const { body, failure } = await captured().snapshot();
    expect(body).toContain('6661');
    expect(body).toContain('UPDATE orders SET total = 1');
    expect(failure).toBeUndefined();
  });

  it('renders the sessions table for `sessions`', async () => {
    mockSessions.mockResolvedValue([session]);
    await runShell({ tab: 'sessions', once: true });
    const { body } = await captured().snapshot();
    expect(body).toContain('5551');
    expect(body).toContain('idle in transaction');
  });

  it('renders the query stats for `top`, sorted by total time', async () => {
    mockTop.mockResolvedValue([stat]);
    await runShell({ tab: 'top', once: true });
    const { body } = await captured().snapshot();
    expect(body).toContain('UPDATE inventory');
    expect(body).toContain('total');
  });

  it('renders the triage markdown for the cockpit', async () => {
    mockTriage.mockResolvedValue(healthy);
    await runShell({ once: true });
    const { body, failure } = await captured().snapshot();
    expect(body).toContain('## Connections');
    expect(body).toContain('5 / 100 used');
    // A healthy database measured something: nothing to exit 1 about.
    expect(failure).toBeUndefined();
  });
});

describe('runShell --snapshot — the failures that decide the exit code', () => {
  /**
   * The cockpit's special case, and the reason `runHome` existed (deep-review
   * I1). `fetchTriage` never rejects, so an unreachable database arrives as a
   * RESOLVED payload of six failed panels. Without `connectionFailure` here,
   * `pgops --snapshot` would print six honest `n/a`s and exit 0 — and
   * `pgops --snapshot > incident.md || page-someone` would never page.
   */
  it('reports the connection failure for the cockpit, whose fetch resolves instead of rejecting', async () => {
    mockTriage.mockResolvedValue(allFailed);
    await runShell({ once: true });
    const { body, failure } = await captured().snapshot();
    // The body is still worth printing: it names the failure per panel.
    expect(body).toContain(REFUSED);
    // And this is what makes `runView` exit 1.
    expect(failure).toBe(REFUSED);
  });

  it('lets the other three tabs reject, which is failure enough', async () => {
    mockLocks.mockRejectedValue(new Error('boom'));
    await runShell({ tab: 'locks', once: true });
    await expect(captured().snapshot()).rejects.toThrow('boom');
  });

  it("turns top's missing extension into the install hint", async () => {
    await runShell({ tab: 'top', once: true });
    const mapError = captured().mapError;
    expect(mapError).toBeDefined();
    expect(mapError?.('relation "pg_stat_statements" does not exist')).toContain('shared_preload_libraries');
  });

  it('leaves an unrelated error alone', async () => {
    await runShell({ tab: 'top', once: true });
    expect(captured().mapError?.('permission denied for table foo')).toBe('permission denied for table foo');
  });

  it('gives the other three tabs no error vocabulary of their own', async () => {
    await runShell({ tab: 'sessions', once: true });
    expect(captured().mapError).toBeUndefined();
  });
});
