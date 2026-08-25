import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabStrip } from '../../ui/TabStrip.js';
import type { SessionRow } from './query.js';

const mockFetch = vi.fn();
const mockKill = vi.fn();
vi.mock('./query.js', async (orig) => ({ ...(await orig()), fetchSessions: (...a: unknown[]) => mockFetch(...a) }));
vi.mock('../../core/kill.js', () => ({ killBackend: (...a: unknown[]) => mockKill(...a) }));

const { SessionsApp } = await import('./index.js');

const idleInTxn: SessionRow = {
  pid: 4711, state: 'idle in transaction', user: 'app', app: 'web', clientAddr: null,
  backendStart: '2026-07-12 10:00:00+00', inStateSecs: 840, runningSecs: null, query: 'BEGIN',
};

async function flush() { await new Promise((r) => setTimeout(r, 20)); }

// A raw 0x1B byte doesn't survive markdown; this is the codebase's working
// pattern for Esc (src/ui/useListNavigation.test.tsx). Esc no longer pops back
// — RULING R-P7 gave the shell sole ownership of the key — so its one remaining
// job in this view is leaving filter mode, which is what it is used for below.
const ESC = String.fromCharCode(27);

describe('SessionsApp', () => {
  beforeEach(() => { mockFetch.mockResolvedValue([idleInTxn]); mockKill.mockReset(); });

  it('lists sessions with idle-in-transaction highlighted first', async () => {
    const { lastFrame } = render(<SessionsApp />);
    await flush();
    expect(lastFrame()).toContain('4711');
    expect(lastFrame()).toContain('idle in transaction');
  });

  it('x arms the confirm modal against the selected pid; y kills via core with session identity', async () => {
    mockKill.mockResolvedValue('terminated');
    const { stdin, lastFrame } = render(<SessionsApp />);
    await flush();
    stdin.write('x');
    expect(lastFrame()).toContain('Kill pid 4711');
    // ConfirmModal's own `useInput` subscribes via a passive effect on mount;
    // a keystroke fired in the same synchronous tick would race that commit
    // (the effect hasn't run yet), so flush before the confirming keystroke.
    await flush();
    stdin.write('y');
    await flush();
    expect(mockKill).toHaveBeenCalledWith(
      { pid: 4711, backendStart: '2026-07-12 10:00:00+00' },
      expect.objectContaining({ subcommand: 'sessions' }),
    );
    expect(lastFrame()).toContain('terminated pid 4711');
  });

  it('a kill triggers an immediate re-poll rather than waiting for the interval', async () => {
    mockKill.mockResolvedValue('terminated');
    const { stdin } = render(<SessionsApp />);
    await flush();
    const callsBeforeKill = mockFetch.mock.calls.length;
    stdin.write('x');
    await flush();
    stdin.write('y');
    await flush();
    // No timers advanced (REFRESH_MS is 2s) — the extra fetch must come from
    // confirmKill re-polling immediately, not the interval tick.
    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBeforeKill);
  });

  it('surfaces the session-changed refusal instead of swallowing it', async () => {
    // The pid was reused between `x` and `y`, so core/kill.ts refused. That
    // refusal is the only thing between a stale selection and a wrong-session
    // kill — if it never reaches the bar, the operator reads it as a clean kill.
    mockKill.mockResolvedValue('session-changed');
    const { stdin, lastFrame } = render(<SessionsApp />);
    await flush();
    stdin.write('x');
    await flush();
    stdin.write('y');
    await flush();
    expect(lastFrame()).toContain('pid 4711 session changed — not killing');
    expect(lastFrame()).not.toContain('✓ terminated');
  });

  it('shows freshness in the status bar — this is the view you kill from', async () => {
    // I2: `sessions` used to advertise a cadence with no freshness, so a view
    // whose polls had been failing for 90s still read as live.
    const { lastFrame } = render(<SessionsApp />);
    await flush();
    expect(lastFrame()).toContain('updated just now');
  });

  it('never renders a password caught in flight in pg_stat_activity.query', async () => {
    // I3: this terminal gets screenshotted into Slack far more often than `s`
    // gets pressed. Both the row and the selected-row disclosure must redact.
    mockFetch.mockResolvedValue([{ ...idleInTxn, query: "ALTER USER app PASSWORD 'hunter2'" }]);
    const { lastFrame } = render(<SessionsApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('hunter2');
    expect(frame).toContain('ALTER USER app PASSWORD ***');
  });
});

describe('SessionsApp — shell frame', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue([idleInTxn]);
    mockKill.mockReset();
  });

  // Two lines, like the real `TabStrip`, marked with text that appears nowhere
  // else in a sessions frame — a marker that could occur anyway would leave the
  // assertion below green with the `{strip}` deleted from the JSX.
  const marker = (
    <Box flexDirection="column" height={2}>
      <Text>STRIP-L1</Text>
      <Text>STRIP-L2</Text>
    </Box>
  );

  it('renders the strip it was handed, between the status bar and the table', async () => {
    const { lastFrame } = render(<SessionsApp strip={marker} />);
    await flush();
    const lines = (lastFrame() ?? '').split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at('STRIP-L1')).toBeGreaterThan(-1);
    expect(at('STRIP-L1')).toBeGreaterThan(at('pgops sessions'));
    expect(at('STRIP-L1')).toBeLessThan(at('user@app')); // the table's header row
  });

  /**
   * The `CHROME_LINES` gate. Counts real lines rather than restating the
   * arithmetic: the real `TabStrip` inside the real container, measured against
   * the terminal. `ink-testing-library`'s stdout stub exposes no `rows` at all
   * (`useTerminalSize.ts`), so the hook falls back to the POSIX 24 — which is
   * this product's floor, so the un-settable stub is the case worth testing.
   *
   * The 30 `j`s matter: `Table` reserves a line for the `↑` indicator whether
   * or not it shows, so a selection parked on row 0 leaves a line of slack that
   * would absorb an off-by-one. Scrolled into the middle, both indicators are
   * on screen, the table spends its budget exactly, and the frame lands flush
   * against the floor.
   */
  it('fills the 80x24 floor exactly with the real strip above it', async () => {
    mockFetch.mockResolvedValue(Array.from({ length: 60 }, (_, i) => ({ ...idleInTxn, pid: 4000 + i })));
    const { stdin, lastFrame } = render(<SessionsApp strip={<TabStrip active="sessions" width={80} />} />);
    await flush();
    for (let i = 0; i < 30; i++) stdin.write('j');
    await flush();

    const frame = lastFrame() ?? '';
    // Anchors: the strip really rendered, and the table really is scrolled off
    // both ends — without them the line count below proves much less.
    expect(frame).toContain('3 locks');
    expect(frame).toContain('↑');
    expect(frame).toContain('↓');
    // Exactly 23, not "at most": one over and the table has overflowed the
    // terminal again; one under and CHROME_LINES is charging for chrome nobody
    // rendered, costing the operator a row of the list.
    //
    // 23 and not 24 on a 24-row terminal: Ink takes a different write path for
    // a frame as tall as the terminal. `ink/build/ink.js:121` is
    // `if (outputHeight >= this.options.stdout.rows)`, and that branch writes
    // `ansiEscapes.clearTerminal` first — so a 24-line frame wipes the terminal
    // and its scrollback on every 2s poll. See `INK_CLEAR_RESERVE`.
    expect(frame.split('\n').length).toBe(23);
  });

  it('reports keyboard capture while the confirm modal owns the keyboard', async () => {
    const onCapture = vi.fn();
    const { stdin } = render(<SessionsApp onCapture={onCapture} />);
    await flush();
    expect(onCapture).toHaveBeenLastCalledWith(false);

    stdin.write('x');
    await flush();
    expect(onCapture).toHaveBeenLastCalledWith(true);

    // `n` is not `y`, so ConfirmModal cancels — capture must be released, or
    // the shell's number keys stay dead for the rest of the session.
    stdin.write('n');
    await flush();
    expect(onCapture).toHaveBeenLastCalledWith(false);
  });

  it('reports keyboard capture while filter mode owns the keyboard', async () => {
    // Filter mode deliberately takes the WHOLE keyboard so you can type `q`,
    // `j`, `1` into a search term. If the shell's nav stayed live, typing `4`
    // into a filter would navigate to `top` mid-word.
    const onCapture = vi.fn();
    const { stdin } = render(<SessionsApp onCapture={onCapture} />);
    await flush();
    expect(onCapture).toHaveBeenLastCalledWith(false);

    stdin.write('/');
    await flush();
    expect(onCapture).toHaveBeenLastCalledWith(true);

    stdin.write(ESC);
    await flush();
    expect(onCapture).toHaveBeenLastCalledWith(false);
  });
});
