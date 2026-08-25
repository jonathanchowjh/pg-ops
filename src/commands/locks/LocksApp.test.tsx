import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabStrip } from '../../ui/TabStrip.js';
import type { LockEdge } from './query.js';

/**
 * The REAL LocksApp, not the hub's mock of it (Home.test.tsx stubs the child
 * views, so it only ever asserted the mock's contract). Two things nothing else
 * proves:
 *
 *  1. The `session-changed` refusal actually reaches the operator. That branch
 *     (core/kill.ts's CASE-guarded terminate) is the only thing standing between
 *     a stale selection and a wrong-session kill; core/kill.test.ts proves the
 *     SQL→outcome mapping, but not that the caller surfaces it.
 *  2. The keyboard-capture report: while the confirm modal is up this view owns
 *     every key, and the shell's global nav must go inert. `ConfirmModal`
 *     cancels on ANY key that is not `y`, and Ink fires every registered
 *     handler for a keypress — so without the report, `4` would cancel the kill
 *     AND navigate to `top` in the same keystroke.
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

describe('LocksApp — shell frame', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue([edge]);
    mockKill.mockReset();
  });

  // Two lines, like the real `TabStrip`, marked with text that appears nowhere
  // else in a locks frame — a marker that could occur anyway would leave the
  // assertion below green with the `{strip}` deleted from the JSX.
  const marker = (
    <Box flexDirection="column" height={2}>
      <Text>STRIP-L1</Text>
      <Text>STRIP-L2</Text>
    </Box>
  );

  it('renders the strip it was handed, between the status bar and the table', async () => {
    const { lastFrame } = render(<LocksApp strip={marker} />);
    await flush();
    const lines = (lastFrame() ?? '').split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at('STRIP-L1')).toBeGreaterThan(-1);
    expect(at('STRIP-L1')).toBeGreaterThan(at('pgops locks'));
    expect(at('STRIP-L1')).toBeLessThan(at('user@app')); // the table's header row
  });

  /**
   * The `CHROME_LINES` gate — the assertion that catches a wrong
   * `TAB_STRIP_LINES`, which is the one mistake in this task that breaks the
   * product silently.
   *
   * Not a restatement of the arithmetic: it renders the real container with
   * the real `TabStrip` and COUNTS LINES against the terminal.
   * `ink-testing-library`'s stdout stub exposes no `rows` at all (see
   * `useTerminalSize.ts`), so the hook falls back to the POSIX 24 — which is
   * exactly the floor this product has to honour, so the un-settable stub is
   * the case worth testing rather than a limitation to work around.
   *
   * The 30 `j`s matter. `Table` reserves a line for the `↑` scroll indicator
   * whether or not it is showing, so with the selection parked on row 0 the
   * table renders one line short of its budget and that slack would absorb an
   * off-by-one in `CHROME_LINES`. Moving the selection into the middle of the
   * list puts both `↑` and `↓` on screen, the table spends its budget exactly,
   * and the frame lands flush against the 24-line floor — where being one line
   * over is a failure rather than slack.
   */
  it('fills the 80x24 floor exactly with the real strip above it', async () => {
    const roots = Array.from({ length: 60 }, (_, i) => ({
      ...edge,
      blocking_pid: 800_000 + i,
      blocked_pid: 900_000 + i,
    }));
    mockFetch.mockResolvedValue(roots);

    const { stdin, lastFrame } = render(<LocksApp strip={<TabStrip active="locks" width={80} />} />);
    await flush();
    for (let i = 0; i < 30; i++) stdin.write('j');
    await flush();

    const frame = lastFrame() ?? '';
    // Anchors: the strip really rendered (otherwise the count below is
    // satisfied by a view that dropped it), and the table really is scrolled
    // off both ends (otherwise the reserved-line slack is back).
    expect(frame).toContain('3 locks');
    expect(frame).toContain('↑');
    expect(frame).toContain('↓');
    // Exactly 23, not "at most": one line over and the table has overflowed the
    // terminal again (the defect the geometry phase existed to fix); one line
    // under and `CHROME_LINES` is charging for chrome nobody rendered, costing
    // the operator a row of the list. Both directions are bugs, so both are
    // failures — an over-count is otherwise invisible.
    //
    // 23 and not 24 on a 24-row terminal, because Ink does not merely clip a
    // frame as tall as the terminal — it takes a different write path for it.
    // `ink/build/ink.js:121` is `if (outputHeight >= this.options.stdout.rows)`,
    // and that branch writes `ansiEscapes.clearTerminal` before the frame. So a
    // 24-line frame here would wipe the terminal AND its scrollback every 2s
    // poll: the screen flashes, and the psql session the operator scrolled back
    // to is gone. Note the boundary is `>=`, not `>`. See `INK_CLEAR_RESERVE`.
    expect(frame.split('\n').length).toBe(23);
  });

  it('reports keyboard capture while the confirm modal owns the keyboard', async () => {
    const onCapture = vi.fn();
    const { stdin } = render(<LocksApp onCapture={onCapture} />);
    await flush();
    // Mounted, nothing armed: the shell's nav is live.
    expect(onCapture).toHaveBeenLastCalledWith(false);

    stdin.write('x');
    await flush();
    expect(onCapture).toHaveBeenLastCalledWith(true);

    // `n` is not `y`, so ConfirmModal cancels — and capture must be released,
    // or the shell's number keys stay dead for the rest of the session.
    stdin.write('n');
    await flush();
    expect(onCapture).toHaveBeenLastCalledWith(false);
  });
});
