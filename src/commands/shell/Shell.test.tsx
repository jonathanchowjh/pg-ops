import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageData } from '../home/query.js';
import type { LockEdge } from '../locks/query.js';
import type { SessionRow } from '../sessions/query.js';
import type { QueryStat } from '../top/query.js';

/**
 * The shell, mounted with the four REAL views behind it — only the four
 * database queries are stubbed. Mocking the views themselves would leave every
 * assertion here proving the mock's contract instead of the product's, which is
 * exactly the gap `LocksApp.test.tsx` was written to close for `HubApp`.
 *
 * Each view is identified by a string only IT renders. `StatusBar` prints
 * `pgops <subcommand>`, so `pgops locks` is unique across the four; the fixture
 * pids and query texts below are deliberately disjoint so no assertion can be
 * satisfied by the wrong view's data.
 */

const mockTriage = vi.fn();
const mockLocks = vi.fn();
const mockSessions = vi.fn();
const mockTop = vi.fn();
vi.mock('../home/query.js', async (orig) => ({ ...(await orig()), fetchTriage: () => mockTriage() }));
vi.mock('../locks/query.js', async (orig) => ({ ...(await orig()), fetchLockEdges: () => mockLocks() }));
vi.mock('../sessions/query.js', async (orig) => ({ ...(await orig()), fetchSessions: () => mockSessions() }));
vi.mock('../top/query.js', async (orig) => ({ ...(await orig()), fetchQueryStats: () => mockTop() }));

const { Shell } = await import('./Shell.js');

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

/**
 * Two sessions whose order FLIPS with the sort — the whole point of the
 * LONG-RUNNING drill. `triage` puts idle-in-transaction (5551) first; `active`
 * ranks running backends first, so 5552 leads. Same two rows either way, so the
 * only thing the drill test can be reading is the order.
 */
const idleInTxn: SessionRow = {
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
const longActive: SessionRow = {
  pid: 5552,
  state: 'active',
  user: 'batch',
  app: 'worker',
  clientAddr: null,
  backendStart: '2026-08-21 09:00:00+00',
  inStateSecs: 2460,
  runningSecs: 2460,
  query: 'REFRESH MATERIALIZED VIEW revenue',
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

// Escape sequences as `ink-testing-library`'s stdin delivers them — the same
// three constants `useGlobalNav.test.tsx` probed and documented.
const TAB = String.fromCharCode(9);
const ESC = String.fromCharCode(27);
const SHIFT_TAB = ESC + '[Z';

/** Every key the shell's global nav claims. Used by the suppression test. */
const NAV_KEYS = ['1', '5', '9', 'D', TAB, SHIFT_TAB, ESC];

async function flush(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Give Ink time to attach its stdin listener before the first keystroke. */
const mounted = () => flush(120);

async function press(stdin: { write: (s: string) => void }, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k);
    await flush();
  }
}

describe('Shell — one app, nine tabs', () => {
  beforeEach(() => {
    mockTriage.mockReset().mockResolvedValue(triage);
    mockLocks.mockReset().mockResolvedValue([edge]);
    mockSessions.mockReset().mockResolvedValue([idleInTxn, longActive]);
    mockTop.mockReset().mockResolvedValue([stat]);
  });

  /**
   * The one link between `useTerminalSize` and `TabStrip`, and the easiest
   * thing on this branch to break invisibly: every other strip assertion is a
   * `contains`, and `TabStrip`'s fixed `height={2}` makes its line count
   * width-independent — so `width={terminal.columns}` could be replaced with
   * any literal and the rest of the suite would stay green.
   *
   * `ink-testing-library`'s stdout stub reports 100 columns, and at 100 all
   * nine tabs fit on one line while at 80 the strip wraps with `9 system`
   * pushed onto the second. So the *wrap point* is the observable that proves
   * the real terminal width reached the strip.
   *
   * **One-sided by itself**, and deliberately so. It catches every literal
   * below the wrap point but not one above it: the strip's content is 89
   * columns and Ink trims trailing whitespace, so `width` of 90, 100, 120 and
   * 200 render byte-identically (measured). Do not try to close that half with
   * a maximum-line-width assertion here — it would pass because of the
   * trimming, not because the width is right, which is the kind of assertion
   * this branch has had to delete twelve times.
   *
   * The other half lives in `Shell.width.test.tsx`, which stubs `TabStrip` and
   * captures the prop. It needs its own file because every assertion in THIS
   * one needs the strip real.
   */
  it('gives the strip the real terminal width, not a literal', async () => {
    const { lastFrame } = render(<Shell />);
    await mounted();
    const lines = (lastFrame() ?? '').split('\n');
    const first = lines.findIndex((l) => l.includes('1 triage'));
    expect(first).toBeGreaterThan(-1);
    // At the harness's 100 columns the whole strip fits on one line, so a
    // hardcoded 80 pushes `9 system` onto the second one and this fails.
    expect(lines[first]).toContain('9 system');
  });

  it('mounts the tab you jump to and marks it on the strip', async () => {
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();
    // Bare `pgops` opens the cockpit.
    expect(lastFrame()).toContain('LONG-RUNNING');

    await press(stdin, '2');
    expect(lastFrame()).toContain('pgops sessions');
    expect(lastFrame()).toContain('5551');
    expect(lastFrame()).not.toContain('LONG-RUNNING');
    // The strip's highlight follows the mounted view, or the operator cannot
    // tell where they are.
    expect(lastFrame()).toContain('▸ 2 sessions');

    await press(stdin, '3');
    expect(lastFrame()).toContain('pgops locks');
    expect(lastFrame()).toContain('6661');
    expect(lastFrame()).toContain('▸ 3 locks');

    await press(stdin, '4');
    expect(lastFrame()).toContain('pgops top');
    expect(lastFrame()).toContain('UPDATE inventory');
    expect(lastFrame()).toContain('▸ 4 top');

    await press(stdin, '1');
    expect(lastFrame()).toContain('LONG-RUNNING');
    expect(lastFrame()).toContain('▸ 1 triage');
  });

  it('opens on the tab it was given', async () => {
    const { lastFrame } = render(<Shell initialTab="locks" />);
    await mounted();
    expect(lastFrame()).toContain('pgops locks');
    expect(lastFrame()).toContain('▸ 3 locks');
  });

  it('cycles from the mounted view, not from a fixed one', async () => {
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();

    // Two forward steps land on `locks`. A `nextTab` called with a constant
    // instead of the live view would land on `sessions` both times.
    await press(stdin, TAB);
    expect(lastFrame()).toContain('pgops sessions');
    await press(stdin, TAB);
    expect(lastFrame()).toContain('pgops locks');

    await press(stdin, SHIFT_TAB);
    expect(lastFrame()).toContain('pgops sessions');
  });

  it('names the phase that delivers an unbuilt tab, and never claims health', async () => {
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();

    await press(stdin, '5');
    expect(lastFrame()).toContain('space');
    expect(lastFrame()).toContain('Phase 2');
    // Spec §5.3: a tab must never show a ✓ for something unmeasured — the same
    // rule that makes the cockpit render `n/a` for a panel it could not measure.
    // `⚠` is pinned alongside it because it is the glyph most likely to be
    // added here by mistake: spec §5.3 makes it the strip's ESCALATION marker,
    // and a placeholder claiming "act now" for something nobody measured is
    // worse than one claiming health.
    expect(lastFrame()).not.toContain('✓');
    expect(lastFrame()).not.toContain('⚠');
    // …and no view is mounted behind it.
    expect(lastFrame()).not.toContain('pgops');

    // A different phase for a different tab (§9): `system` is Phase 5, not 2.
    // One hardcoded phase string would pass the assertion above and fail here.
    await press(stdin, '9');
    expect(lastFrame()).toContain('system');
    expect(lastFrame()).toContain('Phase 5');
    expect(lastFrame()).not.toContain('Phase 2');
  });

  it('opens doctor on D — a view that is not a tab (R-P9)', async () => {
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();

    await press(stdin, 'D');
    expect(lastFrame()).toContain('doctor');
    expect(lastFrame()).toContain('Phase 3');
    // The strip is still there…
    expect(lastFrame()).toContain('1 triage');
    // …with NOTHING highlighted, because `doctor` holds no digit.
    expect(lastFrame()).not.toContain('▸');
  });

  it('Esc returns to triage from a view and from a placeholder (spec §5.6)', async () => {
    const { stdin, lastFrame } = render(<Shell initialTab="locks" />);
    await mounted();
    expect(lastFrame()).toContain('pgops locks');

    await press(stdin, ESC);
    expect(lastFrame()).toContain('LONG-RUNNING');

    await press(stdin, '6');
    expect(lastFrame()).toContain('vacuum');
    expect(lastFrame()).toContain('Phase 2');
    await press(stdin, ESC);
    expect(lastFrame()).toContain('LONG-RUNNING');
  });

  it('q quits from a placeholder, which has no list navigation to quit for it (R-P10)', async () => {
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();
    await press(stdin, '7');
    expect(lastFrame()).toContain('replication');
    expect(lastFrame()).toContain('Phase 2');

    await press(stdin, 'q');
    // `exit()` unmounts the app, so the next keystroke reaches nothing. Without
    // the placeholder's own `q` handler the app would still be live and `1`
    // would navigate home — which is what "the app looks hung" means here.
    await press(stdin, '1');
    expect(lastFrame()).not.toContain('LONG-RUNNING');
    expect(lastFrame()).toContain('replication');
  });

  it('Ctrl-C quits from a placeholder too', async () => {
    // `ink-testing-library` renders with `exitOnCtrlC: false`, so Ink hands
    // Ctrl-C to the registered handlers instead of exiting for us — which is
    // what makes this branch observable at all. In production Ink's default
    // would exit anyway, so this guard is belt-and-braces (and matches
    // `useListNavigation`); it is tested because the report claims it works.
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();
    await press(stdin, '8');
    expect(lastFrame()).toContain('seq');
    expect(lastFrame()).toContain('Phase 2');

    await press(stdin, String.fromCharCode(3));
    await press(stdin, '1');
    expect(lastFrame()).not.toContain('LONG-RUNNING');
    expect(lastFrame()).toContain('seq');
  });
});

describe('Shell — the cockpit drill (R-P5)', () => {
  beforeEach(() => {
    mockTriage.mockReset().mockResolvedValue(triage);
    mockLocks.mockReset().mockResolvedValue([edge]);
    mockSessions.mockReset().mockResolvedValue([idleInTxn, longActive]);
    mockTop.mockReset().mockResolvedValue([stat]);
  });

  /** Row order in the rendered frame — the only thing that distinguishes the sorts. */
  function order(frame: string): number[] {
    const lines = frame.split('\n');
    return [5551, 5552]
      .map((pid) => ({ pid, at: lines.findIndex((l) => l.includes(String(pid))) }))
      .filter((r) => r.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((r) => r.pid);
  }

  it('Enter on LONG-RUNNING mounts sessions sorted by active runtime', async () => {
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();
    // LONG-RUNNING is the third panel.
    await press(stdin, 'j', 'j');
    expect(lastFrame()).toMatch(/▸\s*LONG-RUNNING/);

    await press(stdin, '\r');
    expect(lastFrame()).toContain('pgops sessions');
    // `sort: 'active'` is the whole payload of this drill. Drop it and the door
    // opens on triage order — the wrong screen, silently.
    expect(order(lastFrame() ?? '')).toEqual([5552, 5551]);
  });

  it('Enter on BLOCKED mounts locks', async () => {
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();
    await press(stdin, 'j', '\r');
    expect(lastFrame()).toContain('pgops locks');
    expect(lastFrame()).toContain('6661');
  });

  it('t drills to top from the cockpit', async () => {
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();
    await press(stdin, 't');
    expect(lastFrame()).toContain('pgops top');
    expect(lastFrame()).toContain('UPDATE inventory');
  });

  it('a plain jump to sessions keeps triage order — the drill sort is the drill’s', async () => {
    // The control for the test above: same view, same rows, default sort. If
    // the shell simply always passed `active`, this goes red.
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();
    await press(stdin, '2');
    expect(order(lastFrame() ?? '')).toEqual([5551, 5552]);
  });

  it('the sort the shell holds keeps describing the screen (review F5)', async () => {
    // `SessionsApp` reads `initialSort` ONCE, in a `useState` initialiser. So a
    // shell that reset its own `sort` on every view change would claim
    // `'triage'` while the mounted view — which does not remount when you press
    // `2` from `sessions` — kept rendering `'active'`. Only a drill writes the
    // sort now, and this test is what holds that: it asserts the screen, not
    // the state, at the two points where they could come apart.
    const { stdin, lastFrame } = render(<Shell />);
    await mounted();
    await press(stdin, 'j', 'j', '\r');
    expect(order(lastFrame() ?? '')).toEqual([5552, 5551]);

    // Same view, no remount: the screen must not change under the operator.
    await press(stdin, '2');
    expect(order(lastFrame() ?? '')).toEqual([5552, 5551]);

    // Leave and come back — this one DOES remount, and it must remount into
    // the order the shell says it is in.
    await press(stdin, '3', '2');
    expect(order(lastFrame() ?? '')).toEqual([5552, 5551]);

    // …and a drill that carries `sort: 'triage'` (the SESSIONS panel) still
    // points it back, or `active` would be a one-way door.
    await press(stdin, '1', '\r');
    expect(order(lastFrame() ?? '')).toEqual([5551, 5552]);
  });
});

describe('Shell — the suppression rule, end to end (spec §5.5)', () => {
  beforeEach(() => {
    mockTriage.mockReset().mockResolvedValue(triage);
    mockLocks.mockReset().mockResolvedValue([edge]);
    mockSessions.mockReset().mockResolvedValue([idleInTxn, longActive]);
    mockTop.mockReset().mockResolvedValue([stat]);
  });

  it('every nav key navigates when nothing owns the keyboard', async () => {
    // The live half of the suppression proof, kept as its own test so the
    // "nothing happened" assertions below cannot pass on a dead stdin: every
    // key in NAV_KEYS provably moves the shell from `locks`.
    const landings: string[] = [];
    for (const key of NAV_KEYS) {
      const { stdin, lastFrame } = render(<Shell initialTab="locks" />);
      await mounted();
      expect(lastFrame()).toContain('pgops locks');
      await press(stdin, key);
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('pgops locks');
      landings.push(frame.includes('pgops') ? (/pgops (\w+)/.exec(frame)?.[1] ?? '?') : 'placeholder');
    }
    expect(landings).toEqual(['triage', 'placeholder', 'placeholder', 'placeholder', 'top', 'sessions', 'triage']);
  });

  it('every nav key is inert while a kill confirmation owns the keyboard', async () => {
    // The reason this rule exists: `ConfirmModal` cancels on ANY key that is
    // not `y`, and Ink fires EVERY registered `useInput` handler for one
    // keypress. With nav live, `4` would cancel the pending kill AND jump to
    // `top`, and the operator could not tell which had happened.
    //
    // One key per armed modal, because that first key also cancels the modal —
    // and that cancellation is the proof the keystroke was DELIVERED, so a
    // silent stdin cannot pass this test either.
    const { stdin, lastFrame } = render(<Shell initialTab="locks" />);
    await mounted();

    // Collected and asserted once at the end rather than per iteration: a
    // per-key `expect` inside the loop stops at the FIRST leak and leaves the
    // remaining keys unproven, which is how a suppression test comes to cover
    // one key and claim seven.
    const outcomes: string[] = [];
    for (const key of NAV_KEYS) {
      await press(stdin, 'x');
      expect(lastFrame()).toContain('Kill pid 6661');

      await press(stdin, key);
      const frame = lastFrame() ?? '';
      outcomes.push(
        // Where the key left us, and whether it was delivered at all: the modal
        // cancels on any key that is not `y`, so a still-open modal means the
        // keystroke never arrived and this test would otherwise pass on a dead
        // stdin.
        [
          /pgops (\w+)/.exec(frame)?.[1] ?? 'no-view',
          frame.includes('▸ 3 locks') ? 'strip-locks' : 'strip-moved',
          frame.includes('Kill pid 6661') ? 'undelivered' : 'delivered',
        ].join(' '),
      );
    }
    expect(outcomes).toEqual(NAV_KEYS.map(() => 'locks strip-locks delivered'));

    // And nav is live again the moment the modal is gone.
    await press(stdin, '1');
    expect(lastFrame()).toContain('LONG-RUNNING');
  });

  it('every nav key is inert while filter mode owns the keyboard', async () => {
    // The second capturing state, and the one an operator hits every day:
    // `useListNavigation` hands the whole keyboard to the search term, so a
    // digit typed into a filter must filter, never navigate.
    const { stdin, lastFrame } = render(<Shell initialTab="sessions" />);
    await mounted();
    await press(stdin, '/');

    await press(stdin, '5');
    expect(lastFrame()).toContain('pgops sessions');
    // Delivered: it went into the filter text, not into navigation.
    expect(lastFrame()).toContain('/5');

    // Same aggregate shape as the modal test: every key accounted for, and each
    // one provably delivered — it lands in the filter text, which is exactly
    // where a digit typed into a search box belongs.
    const typed = ['1', '9', 'D', TAB];
    const outcomes: string[] = [];
    for (const key of typed) {
      await press(stdin, key);
      const frame = lastFrame() ?? '';
      outcomes.push(/pgops (\w+)/.exec(frame)?.[1] ?? 'no-view');
    }
    expect(outcomes).toEqual(typed.map(() => 'sessions'));
    // The filter prompt renders `/<text>█`, so this pins the text EXACTLY:
    // `5`, `1`, `9` and `D` all reached the search term, and `Tab` (which Ink
    // reports as `key.tab` with empty input, so `reduceFilter` drops it) added
    // nothing — it certainly did not cycle the view.
    expect(lastFrame()).toContain('/519D█');

    // Esc leaves filter mode (the filter's own job) rather than reaching the
    // shell — spec §5.6's "after first dismissing any open modal or filter".
    await press(stdin, ESC);
    expect(lastFrame()).toContain('pgops sessions');
    // A second Esc now reaches the shell.
    await press(stdin, ESC);
    expect(lastFrame()).toContain('LONG-RUNNING');
  });

  it('nav revives on the next view once a capturing view has released (R6-1)', async () => {
    // Capture is released by the view, then the shell changes view, then nav
    // must still work. See `Shell.tsx`: the shell also releases capture itself
    // on every view change, which no reachable sequence can distinguish today
    // (a view cannot change while captured, because the keys that change it are
    // the keys capture makes inert) — that reset is defence for the next view
    // that forgets, not for a live path. This test covers the path that IS
    // reachable: release, leave, keep navigating.
    const { stdin, lastFrame } = render(<Shell initialTab="locks" />);
    await mounted();

    await press(stdin, 'x');
    expect(lastFrame()).toContain('Kill pid 6661');
    await press(stdin, 'n'); // not `y`: cancel
    expect(lastFrame()).not.toContain('Kill pid 6661');

    await press(stdin, '5');
    expect(lastFrame()).toContain('space');
    await press(stdin, '1');
    expect(lastFrame()).toContain('LONG-RUNNING');
  });
});
