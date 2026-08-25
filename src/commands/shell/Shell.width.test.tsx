import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageData } from '../home/query.js';

/**
 * One assertion, in its own file, because it needs `TabStrip` stubbed and every
 * other shell test needs it real.
 *
 * `Shell` passing the terminal's actual width to the strip is the single link
 * between `useTerminalSize` and `TabStrip`, and it is invisible to every
 * rendered assertion: the strip's content is 89 columns and Ink trims trailing
 * whitespace, so `width` of 90, 100, 120 and 200 all render byte-identically
 * (measured). A wrap-point assertion catches a literal BELOW the wrap point and
 * nothing above it.
 *
 * Capturing the prop is what closes it. It is a weaker kind of test — it knows
 * about a call rather than about a screen — and it earns that here precisely
 * because the screen cannot tell the difference.
 */

const widths: unknown[] = [];
vi.mock('../../ui/TabStrip.js', () => ({
  TabStrip: ({ width }: { width: number }) => {
    widths.push(width);
    return null;
  },
}));

const triage: TriageData = {
  sessions: { ok: true, data: { byState: [], oldestIdleInTxnSecs: null } },
  blocked: { ok: true, data: { blockedCount: 0, longestWaitSecs: null, suspectPid: null } },
  longRunning: { ok: true, data: [] },
  connections: { ok: true, data: { used: 1, max: 100, headroom: 99 } },
  wraparound: { ok: true, data: { pctOfHorizon: 1 } },
  slots: { ok: true, data: { inactiveCount: 0, retainedBytes: 0, worstSlot: null } },
};

vi.mock('../home/query.js', async (orig) => ({ ...(await orig()), fetchTriage: async () => triage }));
vi.mock('../locks/query.js', async (orig) => ({ ...(await orig()), fetchLockEdges: async () => [] }));
vi.mock('../sessions/query.js', async (orig) => ({ ...(await orig()), fetchSessions: async () => [] }));
vi.mock('../top/query.js', async (orig) => ({ ...(await orig()), fetchQueryStats: async () => [] }));

const { Shell } = await import('./Shell.js');

describe('Shell — the strip gets the real terminal width', () => {
  beforeEach(() => {
    widths.length = 0;
  });

  it('passes terminal.columns, not a literal', async () => {
    render(<Shell />);
    await new Promise((r) => setTimeout(r, 60));
    expect(widths.length).toBeGreaterThan(0);
    // `ink-testing-library`'s stdout stub reports a hardcoded 100 columns with
    // no setter, so that is what `useTerminalSize` must have read. Any literal
    // — 80, 120, 200 — fails here, which is the half a rendered assertion
    // cannot reach.
    for (const w of widths) expect(w).toBe(100);
  });
});
