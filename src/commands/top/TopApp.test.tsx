import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabStrip } from '../../ui/TabStrip.js';
import type { QueryStat } from './query.js';

/**
 * The REAL TopApp, mounted directly. `top` has no confirm modal, so its one
 * keyboard-capture state is filter mode — which is the state that matters most
 * here, because it is the one where every printable key belongs to the search
 * term rather than to navigation.
 */

const mockFetch = vi.fn();
vi.mock('./query.js', async (orig) => ({ ...(await orig()), fetchQueryStats: (...a: unknown[]) => mockFetch(...a) }));

const { TopApp } = await import('./index.js');

const stat: QueryStat = {
  queryid: '42',
  query: 'SELECT * FROM orders WHERE id = $1',
  calls: 120,
  totalMs: 5400,
  meanMs: 45,
  stddevMs: 10,
  rows: 120,
  sharedBlksHit: 900,
  sharedBlksRead: 100,
};

async function flush() {
  await new Promise((r) => setTimeout(r, 20));
}

// A raw 0x1B byte doesn't survive markdown; this is the codebase's working
// pattern for Esc (src/ui/useListNavigation.test.tsx). Esc no longer pops back
// — RULING R-P7 gave the shell sole ownership of the key — so its one remaining
// job in this view is leaving filter mode, which is what it is used for below.
const ESC = String.fromCharCode(27);

describe('TopApp', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue([stat]);
  });

  it('renders pg_stat_statements rows', async () => {
    const { lastFrame } = render(<TopApp />);
    await flush();
    expect(lastFrame()).toContain('SELECT * FROM orders');
  });

  it('shows freshness in the status bar once a poll lands', async () => {
    const { lastFrame } = render(<TopApp />);
    await flush();
    expect(lastFrame()).toContain('updated just now');
  });

  it('turns the missing-extension error into an install hint', async () => {
    mockFetch.mockRejectedValue(new Error('relation "pg_stat_statements" does not exist'));
    const { lastFrame } = render(<TopApp />);
    await flush();
    expect(lastFrame()).toContain('shared_preload_libraries');
  });
});

describe('TopApp — shell frame', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue([stat]);
  });

  // Two lines, like the real `TabStrip`, marked with text that appears nowhere
  // else in a top frame — a marker that could occur anyway would leave the
  // assertion below green with the `{strip}` deleted from the JSX.
  const marker = (
    <Box flexDirection="column" height={2}>
      <Text>STRIP-L1</Text>
      <Text>STRIP-L2</Text>
    </Box>
  );

  it('renders the strip it was handed, between the status bar and the table', async () => {
    const { lastFrame } = render(<TopApp strip={marker} />);
    await flush();
    const lines = (lastFrame() ?? '').split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at('STRIP-L1')).toBeGreaterThan(-1);
    expect(at('STRIP-L1')).toBeGreaterThan(at('pgops top'));
    expect(at('STRIP-L1')).toBeLessThan(at('mean ms')); // the table's header row
  });

  /**
   * The `CHROME_LINES` gate. Counts real lines rather than restating the
   * arithmetic: the real `TabStrip` inside the real container, measured against
   * the terminal. `ink-testing-library`'s stdout stub exposes no `rows` at all
   * (`useTerminalSize.ts`), so the hook falls back to the POSIX 24 — this
   * product's floor, so the un-settable stub is the case worth testing.
   *
   * Both bits of keyboard business are load-bearing. The `/o⏎` sets a
   * non-empty filter and then LEAVES filter mode, which is the only state in
   * which `top`'s chrome is complete: `Top` renders its `filter: "…" (N shown)`
   * summary only when the filter is non-empty, and that line is the term
   * `CHROME_LINES` carries for it, while the filter PROMPT is paid for at the
   * call site instead. The 30 `j`s then scroll the selection into the middle of
   * the list: `Table` reserves a line for the `↑` indicator whether or not it
   * shows, so a selection parked on row 0 leaves slack that would absorb an
   * off-by-one.
   */
  it('fills the 80x24 floor exactly with the real strip above it', async () => {
    mockFetch.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({ ...stat, queryid: String(i) })),
    );
    const { stdin, lastFrame } = render(<TopApp strip={<TabStrip active="top" width={80} />} />);
    await flush();
    stdin.write('/');
    await flush();
    stdin.write('o'); // matches every seeded query, so the list still scrolls
    await flush();
    stdin.write('\r'); // confirm: keeps the filter, leaves filter mode
    await flush();
    for (let i = 0; i < 30; i++) stdin.write('j');
    await flush();

    const frame = lastFrame() ?? '';
    // Anchors: the strip rendered, the filter summary line is present, and the
    // table really is scrolled off both ends. Without them the count below
    // proves much less than it looks like it does.
    expect(frame).toContain('3 locks');
    expect(frame).toContain('60 shown');
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

  it('reports keyboard capture while filter mode owns the keyboard', async () => {
    // Filter mode deliberately takes the WHOLE keyboard so you can type `q`,
    // `j`, `1` into a search term. If the shell's nav stayed live, typing `4`
    // into a filter would navigate away mid-word.
    const onCapture = vi.fn();
    const { stdin } = render(<TopApp onCapture={onCapture} />);
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
