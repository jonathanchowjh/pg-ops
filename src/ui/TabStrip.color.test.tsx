import { describe, expect, it } from 'vitest';
import { theme } from '../core/theme.js';

/**
 * Ink resolves chalk's colour-support level once, at import time, from
 * `process.stdout`. ink-testing-library's fake stdout isn't a TTY, so by
 * default every colour is stripped from `lastFrame()` and there is nothing
 * for a frame assertion to see. Setting `FORCE_COLOR` here — before
 * `ink`/`ink-testing-library` are ever imported anywhere in this file's
 * module graph — makes chalk emit real truecolor escapes. That's why every
 * ink-touching import below is dynamic: a static import at the top of this
 * file would run before this line and chalk would already have frozen its
 * (colourless) level. Mirrors `src/commands/top/Top.color.test.tsx`.
 */
process.env.FORCE_COLOR = '3';

describe('TabStrip colour (review round 1 F4, round 2 F4/F5)', () => {
  it('dims unbuilt tabs and leaves built, non-active tabs undecorated', async () => {
    const { default: chalk } = await import('chalk');
    const { render } = await import('ink-testing-library');
    const { TabStrip } = await import('./TabStrip.js');

    const openCodeFor = (hex: string) => {
      const wrapped = chalk.hex(hex)('X');
      return wrapped.slice(0, wrapped.indexOf('X'));
    };
    const dimOpen = openCodeFor(theme.dim);
    const dimClose = '\x1B[39m'; // SGR "default foreground colour" — closes a hex-colour span

    // active="locks" (a built tab) so neither "locks" nor any other built tab
    // is the one under test for dimming — only the unbuilt tabs should carry
    // theme.dim.
    const { lastFrame } = render(<TabStrip active="locks" width={100} />);
    const frame = lastFrame() ?? '';

    // Ink coalesces adjacent same-styled runs into a single escape pair, so
    // the five consecutive unbuilt tabs (space..system) share ONE dim span
    // rather than repeating the open code before each — assert the span
    // exists and both endpoints of it fall inside, rather than requiring the
    // escape to reappear immediately before every dimmed tab.
    const dimStart = frame.indexOf(dimOpen);
    expect(dimStart).toBeGreaterThanOrEqual(0);
    const dimEnd = frame.indexOf(dimClose, dimStart);
    expect(dimEnd).toBeGreaterThan(dimStart);

    const spaceIdx = frame.indexOf('5 space');
    const systemIdx = frame.indexOf('9 system');
    const triageIdx = frame.indexOf('1 triage');

    // Both unbuilt tabs fall inside the dim span.
    expect(spaceIdx).toBeGreaterThan(dimStart);
    expect(spaceIdx).toBeLessThan(dimEnd);
    expect(systemIdx).toBeGreaterThan(dimStart);
    expect(systemIdx).toBeLessThan(dimEnd);
    // The built, non-active "triage" tab sits entirely outside it.
    expect(triageIdx < dimStart || triageIdx > dimEnd).toBe(true);
  });

  it('highlights the active tab with inverse video and bold, ending exactly at the name (review round 2, F4/F5)', async () => {
    const { default: stringWidth } = await import('string-width');
    const { render } = await import('ink-testing-library');
    const { TABS } = await import('./tabs.js');
    const { TabStrip } = await import('./TabStrip.js');

    const { lastFrame } = render(<TabStrip active="locks" width={100} />);
    const frame = lastFrame() ?? '';

    const inverseOpen = '\x1B[7m';
    const inverseClose = '\x1B[27m';
    const boldOpen = '\x1B[1m';
    const boldClose = '\x1B[22m';
    const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');

    // Ink's inverse video is SGR 7, closed by SGR 27. Whatever exact escape
    // chalk/Ink chooses, the active tab's text must be wrapped in SOME
    // reverse-video sequence that the other tabs are not.
    expect(frame).toContain(inverseOpen);
    const activeIdx = frame.indexOf('3 locks');
    const inverseIdx = frame.lastIndexOf(inverseOpen, activeIdx);
    const closeIdx = frame.indexOf(inverseClose, inverseIdx);
    // The inverse span opened before "3 locks" must close at or after it —
    // i.e. "3 locks" itself sits inside the inverse span, not merely
    // somewhere in a frame that happens to contain inverse video elsewhere.
    expect(inverseIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(activeIdx);

    // F4 (round 2): `bold` was undertested — deleting `bold={isActive}` left
    // every prior assertion green, because nothing checked for SGR 1 at all.
    // The bold escape must appear nested inside the same inverse span (Ink
    // renders it `\x1B[7m\x1B[1m…\x1B[22m\x1B[27m`), not merely anywhere in
    // the frame.
    const span = frame.slice(inverseIdx, closeIdx + inverseClose.length);
    expect(span).toContain(boldOpen);
    expect(span).toContain(boldClose);

    // F5 (round 2): the ORIGINAL visible defect — a trailing pad inside the
    // active tab's inverse span, running the highlight bar 2 columns past
    // the name — had zero regression coverage; the reviewer reintroduced
    // exactly that bug (layout width untouched, so F1-F3 stayed green) and
    // the whole suite passed. Pin it directly: the inverse span's own
    // visible content (ANSI stripped) must be EXACTLY the active tab's
    // label — `▸ ` + key + ' ' + name — no more, no less. Measured in
    // display columns via `stringWidth`, not `.length`, per house rule.
    const locks = TABS.find((t) => t.name === 'locks');
    if (!locks) throw new Error("'locks' missing from TABS — test fixture assumption broken");
    const expectedLabel = `▸ ${locks.key} ${locks.name}`;
    const visibleSpan = stripAnsi(span.slice(inverseOpen.length, span.length - inverseClose.length));
    expect(stringWidth(visibleSpan)).toBe(stringWidth(expectedLabel));
    expect(visibleSpan).toBe(expectedLabel);
  });
});
