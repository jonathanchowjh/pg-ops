import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageData } from './query.js';

const mockFetch = vi.fn();
vi.mock('./query.js', async (orig) => ({
  ...(await orig()),
  fetchTriage: (...a: unknown[]) => mockFetch(...a),
}));

// The child views are mocked as marker components that honour the real `onBack`
// contract (Esc → onBack), the same contract SessionsApp/LocksApp/TopApp
// implement through useListNavigation. That keeps the hub's navigation under
// test without booting three polling views (and three Postgres pools).
vi.mock('../locks/index.js', async () => {
  const { Text, useInput } = await import('ink');
  return {
    LocksApp: ({ onBack }: { onBack?: () => void }) => {
      useInput((_i, key) => key.escape && onBack?.());
      return <Text>LOCKS-VIEW</Text>;
    },
  };
});
vi.mock('../top/index.js', async () => {
  const { Text, useInput } = await import('ink');
  return {
    TopApp: ({ onBack }: { onBack?: () => void }) => {
      useInput((_i, key) => key.escape && onBack?.());
      return <Text>TOP-VIEW</Text>;
    },
  };
});
vi.mock('../sessions/index.js', async () => {
  const { Text, useInput } = await import('ink');
  return {
    SessionsApp: ({ onBack, initialSort }: { onBack?: () => void; initialSort?: string }) => {
      useInput((_i, key) => key.escape && onBack?.());
      return <Text>SESSIONS-VIEW sort={initialSort ?? 'triage'}</Text>;
    },
  };
});

const { HubApp, REFRESH_MS } = await import('./index.js');
const { PANEL_DRILLS } = await import('./Home.js');

const triage: TriageData = {
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
  slots: { ok: true, data: { inactiveCount: 0, retainedBytes: 0, worstSlot: null } },
};

async function flush() {
  await new Promise((r) => setTimeout(r, 20));
}

// A raw 0x1B byte doesn't survive markdown, so the brief's `stdin.write('')`
// lost it in transcription; the codebase's working Esc pattern is this byte.
const ESC = String.fromCharCode(27);

describe('PANEL_DRILLS', () => {
  it('maps panel focus order to the view that can fix that problem', () => {
    expect(PANEL_DRILLS).toEqual([
      { view: 'sessions', sort: 'triage' },
      { view: 'locks' },
      { view: 'sessions', sort: 'active' },
      { view: 'sessions', sort: 'triage' },
    ]);
  });
});

describe('HubApp — triage cockpit', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(triage);
  });

  it('renders every panel of the first five minutes', async () => {
    const { lastFrame } = render(<HubApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('SESSIONS');
    expect(frame).toContain('BLOCKED');
    expect(frame).toContain('LONG-RUNNING');
    expect(frame).toContain('CONNECTIONS');
    expect(frame).toContain('HEALTH');
    expect(frame).toContain('idle in transaction');
    expect(frame).toContain('47 / 100');
    expect(frame).toContain('pgops triage');
  });

  it('j moves focus down the panels', async () => {
    const { stdin, lastFrame } = render(<HubApp />);
    await flush();
    // Focus starts on SESSIONS.
    expect(lastFrame()).toMatch(/▸\s*SESSIONS/);
    stdin.write('j');
    await flush();
    expect(lastFrame()).toMatch(/▸\s*BLOCKED/);
    stdin.write('k');
    await flush();
    expect(lastFrame()).toMatch(/▸\s*SESSIONS/);
  });

  it('Enter on the focused SESSIONS panel drills into sessions; Esc returns', async () => {
    const { stdin, lastFrame } = render(<HubApp />);
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain('SESSIONS-VIEW');
    stdin.write(ESC);
    await flush();
    expect(lastFrame()).toContain('BLOCKED'); // cockpit panel headers are back
  });

  it('Enter on BLOCKED drills into locks; Esc returns to the cockpit', async () => {
    const { stdin, lastFrame } = render(<HubApp />);
    await flush();
    stdin.write('j');
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain('LOCKS-VIEW');
    stdin.write(ESC);
    await flush();
    expect(lastFrame()).toContain('BLOCKED');
    expect(lastFrame()).not.toContain('LOCKS-VIEW');
  });

  it('Enter on LONG-RUNNING drills into sessions sorted by active', async () => {
    const { stdin, lastFrame } = render(<HubApp />);
    await flush();
    stdin.write('j');
    stdin.write('j');
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain('SESSIONS-VIEW sort=active');
  });

  it('t opens top from anywhere on the cockpit', async () => {
    const { stdin, lastFrame } = render(<HubApp />);
    await flush();
    stdin.write('t');
    await flush();
    expect(lastFrame()).toContain('TOP-VIEW');
  });

  it('a failed panel shows n/a while every other panel still renders live', async () => {
    mockFetch.mockResolvedValue({
      ...triage,
      slots: { ok: false, error: 'permission denied for pg_replication_slots' },
    });
    const { lastFrame } = render(<HubApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('n/a');
    expect(frame).toContain('47 / 100'); // connections still live
    expect(frame).toContain('idle in transaction'); // sessions still live
  });

  it('isolates a failed core panel — BLOCKED n/a, the rest still render', async () => {
    mockFetch.mockResolvedValue({ ...triage, blocked: { ok: false, error: 'boom' } });
    const { lastFrame } = render(<HubApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('n/a');
    expect(frame).toContain('CONNECTIONS');
    expect(frame).toContain('47 / 100');
  });

  it('shows a freshness indicator in the status bar once a poll lands', async () => {
    const { lastFrame } = render(<HubApp />);
    await flush();
    expect(lastFrame() ?? '').toContain('updated just now');
  });

  it('never renders a password caught in flight in the LONG-RUNNING panel', async () => {
    // I3: an ALTER USER … PASSWORD caught mid-flight in pg_stat_activity used to
    // land in plaintext on the cockpit — the screen that gets screenshotted into
    // the incident channel.
    mockFetch.mockResolvedValue({
      ...triage,
      longRunning: { ok: true, data: [{ pid: 3990, runningSecs: 12, query: "ALTER USER app PASSWORD 'hunter2'" }] },
    });
    const { lastFrame } = render(<HubApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('hunter2');
    expect(frame).toContain('ALTER USER app PASSWORD ***');
  });
});

/**
 * The failure mode the cockpit exists to survive: the database is unreachable,
 * which is exactly the moment someone opens an incident tool. Nothing has been
 * measured, so nothing may be asserted healthy — a fabricated "all clear" is
 * worse than a blank screen.
 */
describe('HubApp — database unreachable', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:1'));
  });

  it('never renders a ✓ verdict for a panel that was never measured', async () => {
    const { lastFrame } = render(<HubApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('✓');
    // Positive anchor: the assertion above would also pass against a blank
    // frame. Pin that the cockpit is actually rendered — the panel is there,
    // honestly reporting it has nothing measured yet — not merely absent.
    expect(frame).toContain('SESSIONS');
    expect(frame).toContain('n/a (not yet polled)');
  });

  it('does not fabricate zeroed data for unmeasured panels', async () => {
    const { lastFrame } = render(<HubApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('nothing blocked');
    expect(frame).not.toContain('0 / 0 used');
    expect(frame).not.toContain('0% of horizon');
    expect(frame).not.toContain('0 inactive');
  });

  it('shows n/a for every panel and surfaces the connection error', async () => {
    const { lastFrame } = render(<HubApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('n/a');
    expect(frame).toContain('ECONNREFUSED');
    // The panels are still there — the screen is honest, not blank.
    expect(frame).toContain('SESSIONS');
    expect(frame).toContain('CONNECTIONS');
  });

  it('names the connection failure in the status bar when every panel fails', async () => {
    // The real shape of an unreachable database: fetchTriage isolates each panel,
    // so it RESOLVES with six failures rather than rejecting.
    const err = 'connect ECONNREFUSED 127.0.0.1:1';
    mockFetch.mockResolvedValue({
      sessions: { ok: false, error: err },
      blocked: { ok: false, error: err },
      longRunning: { ok: false, error: err },
      connections: { ok: false, error: err },
      wraparound: { ok: false, error: err },
      slots: { ok: false, error: err },
    });
    const { lastFrame } = render(<HubApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('✓');
    expect(frame).toContain('ECONNREFUSED');
  });

  it('does not claim a connection failure when only one panel is denied', async () => {
    mockFetch.mockResolvedValue({ ...triage, slots: { ok: false, error: 'permission denied' } });
    const { lastFrame } = render(<HubApp />);
    await flush();
    const frame = lastFrame() ?? '';
    // The denial belongs to the slots card, not the status bar.
    expect(frame).toContain('slots n/a (permission denied)');
    expect(frame).toContain('47 / 100');
  });

  it(
    'does not re-stamp freshness on a later poll that measured nothing (pool down)',
    async () => {
      // A poll that finds every panel failed did not measure anything — it must
      // not reset `lastPollAt`, or the status bar would read "updated just now"
      // beside a screen full of n/a and a connection-error banner.
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce(triage);
      const { lastFrame } = render(<HubApp />);
      await flush();
      expect(lastFrame() ?? '').toContain('updated just now');

      const err = 'connect ECONNREFUSED 127.0.0.1:1';
      mockFetch.mockResolvedValue({
        sessions: { ok: false, error: err },
        blocked: { ok: false, error: err },
        longRunning: { ok: false, error: err },
        connections: { ok: false, error: err },
        wraparound: { ok: false, error: err },
        slots: { ok: false, error: err },
      });
      // Wait past the cockpit's real cadence (imported, not copied — the test
      // must not silently stop exercising the poll if the cadence changes) so
      // the failing poll above lands, then assert it did NOT re-stamp
      // `lastPollAt`: the label must have aged, not reset to "just now".
      await new Promise((r) => setTimeout(r, REFRESH_MS + 400));

      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('updated just now');
      expect(frame).toMatch(/updated \d+s ago/);
      expect(frame).toContain('ECONNREFUSED');
    },
    REFRESH_MS + 10_000,
  );

  it('renders unmeasured panels as not-yet-polled before the first poll lands', async () => {
    // Never resolves: the pre-first-poll state, held open.
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { lastFrame } = render(<HubApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('✓');
    expect(frame).toContain('n/a');
  });
});
