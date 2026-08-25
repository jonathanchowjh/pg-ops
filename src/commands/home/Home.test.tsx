import stringWidth from 'string-width';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from '../../ui/StatusBar.js';
import { TabStrip } from '../../ui/TabStrip.js';
import type { TriageData } from './query.js';

const mockFetch = vi.fn();
vi.mock('./query.js', async (orig) => ({
  ...(await orig()),
  fetchTriage: (...a: unknown[]) => mockFetch(...a),
}));

const { HomeApp, REFRESH_MS } = await import('./index.js');
const { Home, PANEL_DRILLS } = await import('./Home.js');

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

describe('HomeApp — triage cockpit', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(triage);
  });

  it('renders every panel of the first five minutes', async () => {
    const { lastFrame } = render(<HomeApp />);
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
    const { stdin, lastFrame } = render(<HomeApp />);
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

  it('Enter on the focused SESSIONS panel asks for sessions in triage order', async () => {
    const onDrill = vi.fn();
    const { stdin } = render(<HomeApp onDrill={onDrill} />);
    await flush();
    stdin.write('\r');
    await flush();
    expect(onDrill).toHaveBeenCalledWith({ view: 'sessions', sort: 'triage' });
  });

  it('Enter on BLOCKED asks for locks', async () => {
    const onDrill = vi.fn();
    const { stdin } = render(<HomeApp onDrill={onDrill} />);
    await flush();
    stdin.write('j');
    await flush();
    stdin.write('\r');
    await flush();
    expect(onDrill).toHaveBeenCalledWith({ view: 'locks' });
  });

  it('Enter on LONG-RUNNING asks for sessions sorted by active', async () => {
    // The one drill that carries a payload beyond the view name. `sort: 'active'`
    // is what makes the LONG-RUNNING panel land on the longest-running query
    // rather than the default triage order — drop it and the door opens on the
    // wrong screen while every other assertion here stays green.
    const onDrill = vi.fn();
    const { stdin } = render(<HomeApp onDrill={onDrill} />);
    await flush();
    stdin.write('j');
    stdin.write('j');
    await flush();
    stdin.write('\r');
    await flush();
    expect(onDrill).toHaveBeenCalledWith({ view: 'sessions', sort: 'active' });
  });

  it('t asks for top from anywhere on the cockpit', async () => {
    const onDrill = vi.fn();
    const { stdin } = render(<HomeApp onDrill={onDrill} />);
    await flush();
    stdin.write('t');
    await flush();
    expect(onDrill).toHaveBeenCalledWith({ view: 'top' });
  });

  it('a failed panel shows n/a while every other panel still renders live', async () => {
    mockFetch.mockResolvedValue({
      ...triage,
      slots: { ok: false, error: 'permission denied for pg_replication_slots' },
    });
    const { lastFrame } = render(<HomeApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('n/a');
    expect(frame).toContain('47 / 100'); // connections still live
    expect(frame).toContain('idle in transaction'); // sessions still live
  });

  it('isolates a failed core panel — BLOCKED n/a, the rest still render', async () => {
    mockFetch.mockResolvedValue({ ...triage, blocked: { ok: false, error: 'boom' } });
    const { lastFrame } = render(<HomeApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('n/a');
    expect(frame).toContain('CONNECTIONS');
    expect(frame).toContain('47 / 100');
  });

  it('shows a freshness indicator in the status bar once a poll lands', async () => {
    const { lastFrame } = render(<HomeApp />);
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
    const { lastFrame } = render(<HomeApp />);
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
describe('HomeApp — database unreachable', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:1'));
  });

  it('never renders a ✓ verdict for a panel that was never measured', async () => {
    const { lastFrame } = render(<HomeApp />);
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
    const { lastFrame } = render(<HomeApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('nothing blocked');
    expect(frame).not.toContain('0 / 0 used');
    expect(frame).not.toContain('0% of horizon');
    expect(frame).not.toContain('0 inactive');
  });

  it('shows n/a for every panel and surfaces the connection error', async () => {
    const { lastFrame } = render(<HomeApp />);
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
    const { lastFrame } = render(<HomeApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('✓');
    expect(frame).toContain('ECONNREFUSED');
  });

  it('does not claim a connection failure when only one panel is denied', async () => {
    mockFetch.mockResolvedValue({ ...triage, slots: { ok: false, error: 'permission denied' } });
    const { lastFrame } = render(<HomeApp />);
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
      const { lastFrame } = render(<HomeApp />);
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
    const { lastFrame } = render(<HomeApp />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('✓');
    expect(frame).toContain('n/a');
  });
});

/**
 * The shell frame. Task 5's `Shell` hands every view the tab strip as an
 * ELEMENT — the view keeps its own `StatusBar` (its contents change on every
 * poll and are per-view) and simply renders whatever it was given directly
 * underneath.
 */
describe('HomeApp — shell frame', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(triage);
  });

  // Two lines, like the real `TabStrip`, and marked with text that appears
  // nowhere else in a cockpit frame — a marker that could occur anyway would
  // make the assertion below pass with the `{strip}` deleted from the JSX.
  const marker = (
    <Box flexDirection="column" height={2}>
      <Text>STRIP-L1</Text>
      <Text>STRIP-L2</Text>
    </Box>
  );

  it('renders the strip it was handed, between the status bar and the panels', async () => {
    const { lastFrame } = render(<HomeApp strip={marker} />);
    await flush();
    const lines = (lastFrame() ?? '').split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at('STRIP-L1')).toBeGreaterThan(-1);
    // Position, not mere presence: below the bar, above the first panel.
    expect(at('STRIP-L1')).toBeGreaterThan(at('pgops triage'));
    expect(at('STRIP-L1')).toBeLessThan(at('SESSIONS'));
  });

  /**
   * The cockpit at its tallest, not at its calmest.
   *
   * The `triage` fixture above is the *least* busy realistic state — two
   * session states, one long-running query — and a floor test driven by it
   * passes with four lines of slack no matter what the production code does.
   * That is a test whose green is a property of the fixture, which is the
   * failure mode this branch has produced nine times.
   *
   * So: every panel at its maximum. `SESSIONS_SQL` is a `GROUP BY state` with
   * no `LIMIT`, and these are the six states `pg_stat_activity.state` can
   * actually report. `LONG_RUNNING_SQL` has `LIMIT 3`. Every verdict is a
   * warning, because a warning carries a `note` and a `note` is the longest
   * the header line gets.
   */
  const busiest: TriageData = {
    sessions: {
      ok: true,
      data: {
        byState: [
          { state: 'active', sessions: 120, longestInStateSecs: 30 },
          { state: 'idle', sessions: 300, longestInStateSecs: 90 },
          { state: 'idle in transaction', sessions: 14, longestInStateSecs: 840 },
          { state: 'idle in transaction (aborted)', sessions: 5, longestInStateSecs: 900 },
          { state: 'fastpath function call', sessions: 2, longestInStateSecs: 3 },
          { state: 'disabled', sessions: 1, longestInStateSecs: 1 },
        ],
        oldestIdleInTxnSecs: 900,
      },
    },
    blocked: { ok: true, data: { blockedCount: 41, longestWaitSecs: 1300, suspectPid: 399_000 } },
    longRunning: {
      ok: true,
      data: [
        // Long enough to drive the LONG-RUNNING truncation to its bound. A
        // fixture whose queries are 20 characters never tests the cap at all,
        // which is how an 81-column row shipped.
        {
          pid: 3990,
          runningSecs: 2460,
          query:
            'SELECT o.id, o.total, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.created_at > now() - interval $1',
        },
        { pid: 3991, runningSecs: 2400, query: 'UPDATE inventory SET qty = qty - $1 WHERE sku = $2 AND warehouse_id = $3' },
        { pid: 3992, runningSecs: 2300, query: 'DELETE FROM sessions WHERE expires_at < now() AND revoked IS NOT TRUE' },
      ],
    },
    connections: { ok: true, data: { used: 98, max: 100, headroom: 2 } },
    wraparound: { ok: true, data: { pctOfHorizon: 91 } },
    slots: { ok: true, data: { inactiveCount: 3, retainedBytes: 9e9, worstSlot: 'replica_2' } },
  };

  /**
   * The real 80x24 frame, composed by hand.
   *
   * It cannot go through `HomeApp`: that reads the terminal, and
   * `ink-testing-library`'s stdout stub hardcodes `columns` to 100 with no
   * setter. A guard named "fits 80x24" that renders at 100 is exactly the
   * shape of vacuity this branch keeps producing — and it is what let the
   * cockpit ship 24 lines: `budgetHome` counts ELEMENTS, which equals counting
   * terminal ROWS only while nothing is wider than the screen. At 80 a
   * LONG-RUNNING row was 81 columns and a HEALTH note 86, so three of them
   * wrapped into rows the budget had never paid for.
   *
   * So: the same three children `HomeApp` renders, each given the real 80 —
   * and deliberately NOT inside a `<Box width={80}>`.
   *
   * That wrapper was the obvious thing to reach for and it is exactly wrong.
   * Ink *wraps* text at a constrained `<Box>`, so inside one no line can ever
   * exceed the box: a 200-column `<Text>` renders as [80, 80, 40], and
   * `stringWidth(line) <= 80` becomes an assertion that cannot fail. Every
   * child here sets its own width, and the harness's stdout is 100, so an
   * unwrapped 81-column line renders AS 81 columns and the width assertion
   * below can see it. `maxLines` is 18 — `24 - INK_CLEAR_RESERVE(1) -
   * STATUS_BAR_LINES(3) - TAB_STRIP_LINES(2)`.
   */
  const frameAt80 = (data: TriageData, maxLines = 18) =>
    (
      render(
        <Box flexDirection="column">
          <StatusBar
            subcommand="triage"
            target="prod-cluster-01.abcdefgh.eu-west-1.rds.amazonaws.com:5432/appdb"
            freshness="updated just now"
            hints={['j/k panels', 'Enter drill in', 't top', 's snapshot', 'q quit']}
            width={80}
          />
          <TabStrip active="triage" width={80} />
          <Home data={data} focusedPanel={0} width={80} maxLines={maxLines} />
        </Box>,
      ).lastFrame() ?? ''
    ).split('\n');

  it('fits 80x24 on the busiest database — every line, not just the count', () => {
    const lines = frameAt80(busiest);
    // Both axes, because on this screen either one can be the failure, and
    // each is invisible to the other's assertion. Too many elements shows up
    // only in the line count; a single 81-column line shows up only in the
    // width, because `budgetHome` counts elements and an element is one row
    // right up until it is two.
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(80);
    // 23, not 24: `ink/build/ink.js:121` clears the whole terminal, scrollback
    // included, for any frame at or above the terminal's height.
    expect(lines.length).toBeLessThanOrEqual(23);
    // And it must still be a cockpit.
    expect(lines.join('\n')).toContain('3 locks');
    expect(lines.join('\n')).toContain('idle in transaction');
    expect(lines.join('\n')).toContain('CONNECTIONS');
    expect(lines.join('\n')).toContain('HEALTH');
  });

  /**
   * The busiest fixture cannot prove the budget arithmetic: with six states
   * the cockpit is compact at every plausible budget, so `TAB_STRIP_LINES` and
   * `INK_CLEAR_RESERVE` could both be zero and the frame would not move a
   * line. Three states and three long-running rows sits exactly on
   * `budgetHome`'s spacing threshold — kept at 19, dropped at 18 — so one
   * wrong line anywhere in the budget re-inflates the stack by four.
   */
  const midSize: TriageData = {
    ...busiest,
    sessions: {
      ok: true,
      data: {
        byState: [
          { state: 'active', sessions: 120, longestInStateSecs: 30 },
          { state: 'idle', sessions: 300, longestInStateSecs: 90 },
          { state: 'idle in transaction', sessions: 14, longestInStateSecs: 840 },
        ],
        oldestIdleInTxnSecs: 840,
      },
    },
  };

  it('a mid-size database still fits — the budget is right to the line', () => {
    const lines = frameAt80(midSize);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(80);
    expect(lines.length).toBeLessThanOrEqual(23);
    // Nothing was dropped to get there — at this size the spacing is the only
    // thing that should have given way.
    expect(lines.join('\n')).not.toContain('more');
    expect(lines.join('\n')).toContain('idle in transaction');
  });

  it('still fits when the whole cockpit is n/a — the database is unreachable', async () => {
    // The `n/a (…)` lines are composed differently from the healthy ones and
    // carry a driver error of arbitrary length, so they need their own case —
    // and the error has to be long enough to drive both truncations to their
    // bound, or the case proves only that short errors are short. This is a
    // real node/libpq failure against a managed endpoint.
    const down =
      'connect ECONNREFUSED 10.0.0.1:5432 — could not translate host name "prod-cluster-01.abcdefgh.eu-west-1.rds.amazonaws.com" to address: nodename nor servname provided';
    const p = { ok: false as const, error: down };
    const lines = frameAt80({ sessions: p, blocked: p, longRunning: p, connections: p, wraparound: p, slots: p });
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(80);
    expect(lines.length).toBeLessThanOrEqual(23);
    // Still honest: nothing unmeasured may claim health.
    expect(lines.join('\n')).not.toContain('✓');
    expect(lines.join('\n')).toContain('n/a');
  });

  /**
   * The container's own arithmetic — `terminal.rows - INK_CLEAR_RESERVE -
   * CHROME_LINES - (message ? 1 : 0)`. `top`, `sessions` and `locks` pin
   * theirs with an exact `toBe(23)`; the cockpit's budget was unpinned
   * entirely, so every constant in it could be changed with the suite green.
   *
   * Two fixtures, because one cannot catch both directions. `budgetHome` keeps
   * the spacing while it fits and drops it when it does not, so a budget that
   * is too LARGE shows up only where the larger value crosses back over the
   * threshold, and one that is too SMALL only where the smaller value crosses
   * under it. Three states cross at 19 (catches under-reserving: a budget of 19
   * keeps the spacing and the frame jumps to 24); two states cross at 18
   * (catches over-reserving: a budget of 17 drops the spacing and the frame
   * falls to 19). The counts are what the harness's 100 columns and 24-row
   * fallback produce.
   */
  const states = (n: number): TriageData => ({
    ...busiest,
    sessions: {
      ok: true,
      data: {
        byState: Array.from({ length: n }, (_, i) => ({
          state: `state-${i}`,
          sessions: 1,
          longestInStateSecs: 1,
        })),
        oldestIdleInTxnSecs: 1,
      },
    },
  });

  it('the container spends exactly the budget it computes', async () => {
    mockFetch.mockResolvedValue(states(3));
    const three = render(<HomeApp strip={<TabStrip active="triage" width={80} />} />);
    await flush();
    expect((three.lastFrame() ?? '').split('\n').length).toBe(20);
    expect(three.lastFrame() ?? '').not.toContain('more');

    mockFetch.mockResolvedValue(states(2));
    const two = render(<HomeApp strip={<TabStrip active="triage" width={80} />} />);
    await flush();
    expect((two.lastFrame() ?? '').split('\n').length).toBe(23);
    expect(two.lastFrame() ?? '').not.toContain('more');
  });

  it('gives the panels the real terminal width, not a literal', async () => {
    // The container's other terminal-derived value, and the one no line count
    // can see: truncation changes CONTENT, never the number of lines. The
    // harness's stdout is 100 columns, so a LONG-RUNNING query is cut at
    // `100 - 21 = 79`; hardcode 80 and it is cut at 59, losing everything from
    // `WHERE` on. Without this, `width={terminal.columns}` could be any
    // literal at all.
    mockFetch.mockResolvedValue({
      ...busiest,
      longRunning: {
        ok: true,
        data: [
          {
            pid: 3990,
            runningSecs: 2460,
            query: 'SELECT id, total FROM orders WHERE created_at > now() - interval $1 AND status = $2',
          },
        ],
      },
    });
    const { lastFrame } = render(<HomeApp strip={<TabStrip active="triage" width={80} />} />);
    await flush();
    // Visible at the real 100 columns, cut off at a hardcoded 80.
    expect(lastFrame() ?? '').toContain('now() - interval');
  });

  it('fits the 80x24 floor through the real container too', async () => {
    // The container-level check that `HomeApp` wires strip, width and budget
    // together at all. It renders at the harness's 100 columns, so it cannot
    // see the 80-column wraps the three tests above exist to catch — which is
    // the whole reason those compose the frame by hand.
    mockFetch.mockResolvedValue(busiest);
    const { lastFrame } = render(<HomeApp strip={<TabStrip active="triage" width={80} />} />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('3 locks');
    expect(frame.split('\n').length).toBeLessThanOrEqual(23);
  });

  it('reports the state rows it had to drop rather than hiding them', async () => {
    // A deliberately impossible budget, to prove the `+N more` path exists and
    // says how much is missing. `budgetHome` never goes below one row.
    const { lastFrame } = render(<Home data={busiest} focusedPanel={0} maxLines={13} />);
    expect(lastFrame() ?? '').toContain('+5 more');
  });
});
