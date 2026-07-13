import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

// The brief's illustrative test sends `stdin.write('')` for Esc; a raw 0x1B byte
// doesn't survive markdown, so it was lost in transcription. The codebase's
// working pattern for Esc (src/ui/useListNavigation.test.tsx) sends this byte.
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

  it('Esc fires onBack when provided', async () => {
    const onBack = vi.fn();
    const { stdin } = render(<SessionsApp onBack={onBack} />);
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onBack).toHaveBeenCalled();
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
