import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockEdge } from './query.js';

/**
 * The REAL LocksApp, not the hub's mock of it (Home.test.tsx stubs the child
 * views, so it only ever asserted the mock's contract). Two things nothing else
 * proves:
 *
 *  1. Esc → onBack on the retrofitted view. Without this the hub could be a
 *     one-way door and the whole suite would stay green.
 *  2. The `session-changed` refusal actually reaches the operator. That branch
 *     (core/kill.ts's CASE-guarded terminate) is the only thing standing between
 *     a stale selection and a wrong-session kill; core/kill.test.ts proves the
 *     SQL→outcome mapping, but not that the caller surfaces it.
 */

const mockFetch = vi.fn();
const mockKill = vi.fn();
vi.mock('./query.js', async (orig) => ({ ...(await orig()), fetchLockEdges: (...a: unknown[]) => mockFetch(...a) }));
vi.mock('../../core/kill.js', () => ({ killBackend: (...a: unknown[]) => mockKill(...a) }));

const { LocksApp } = await import('./index.js');

const edge: LockEdge = {
  blocked_pid: 8802,
  blocking_pid: 8801,
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
  blocked_backend_start: '2026-07-12 10:05:00.000000+00',
  blocking_backend_start: '2026-07-12 10:00:00.000000+00',
};

async function flush() {
  await new Promise((r) => setTimeout(r, 20));
}

// A raw 0x1B byte doesn't survive markdown; this is the codebase's Esc pattern
// (src/ui/useListNavigation.test.tsx).
const ESC = String.fromCharCode(27);

describe('LocksApp', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue([edge]);
    mockKill.mockReset();
  });

  it('renders the root blocker of the wait graph', async () => {
    const { lastFrame } = render(<LocksApp />);
    await flush();
    expect(lastFrame()).toContain('8801');
    expect(lastFrame()).toContain('blocking 1');
  });

  it('Esc fires onBack when provided', async () => {
    const onBack = vi.fn();
    const { stdin } = render(<LocksApp onBack={onBack} />);
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onBack).toHaveBeenCalled();
  });

  it('surfaces the session-changed refusal instead of swallowing it', async () => {
    // The pid was reused between `x` and `y`: core/kill.ts refuses. The operator
    // must be TOLD — a silent no-op reads as a successful kill.
    mockKill.mockResolvedValue('session-changed');
    const { stdin, lastFrame } = render(<LocksApp />);
    await flush();
    stdin.write('x');
    await flush();
    stdin.write('y');
    await flush();
    expect(lastFrame()).toContain('pid 8801 session changed — not killing');
    expect(lastFrame()).not.toContain('✓ terminated');
  });

  it('reports a successful kill with the waiters it released', async () => {
    mockKill.mockResolvedValue('terminated');
    const { stdin, lastFrame } = render(<LocksApp />);
    await flush();
    stdin.write('x');
    await flush();
    stdin.write('y');
    await flush();
    expect(mockKill).toHaveBeenCalledWith(
      { pid: 8801, backendStart: '2026-07-12 10:00:00.000000+00' },
      expect.objectContaining({ subcommand: 'locks' }),
    );
    expect(lastFrame()).toContain('terminated pid 8801');
  });

  it('shows freshness in the status bar once a poll lands', async () => {
    const { lastFrame } = render(<LocksApp />);
    await flush();
    expect(lastFrame()).toContain('updated just now');
  });
});
