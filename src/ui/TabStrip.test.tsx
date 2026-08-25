import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TABS } from './tabs.js';
import { TabStrip } from './TabStrip.js';

describe('TabStrip', () => {
  // Review round 1, F1/F2: this must run at 80 and 160, not only 100. At 100
  // the nine tabs happen to fit on one flex row unwrapped, so a content
  // assertion there alone can't distinguish "wraps whole tabs between names"
  // from "no wrapping at all, or wrapping/shrinking mid-name" — every width
  // was measuring the same no-wrap layout. 80 is where the strip's own
  // content is wide enough to force a wrap (so a missing `flexWrap` shreds
  // names into fragments, caught here); 160 is where `width` itself becomes
  // load-bearing, since without it `flexWrap` has no narrow box to wrap
  // against and falls back to the fixed 100-column test stub.
  it.each([80, 100, 160])('renders every tab with its key intact at width %i', (width) => {
    const frame = render(<TabStrip active="triage" width={width} />).lastFrame() ?? '';
    for (const t of TABS) expect(frame).toContain(`${t.key} ${t.name}`);
  });

  // Review round 1, F2 (second pass): the content check above still does not
  // pin `width` on its own. All nine tabs (89 display columns) fit on ONE
  // flex row under ink-testing-library's fixed 100-column stub — so if the
  // `width` prop were silently dropped from the root `<Box>`, Ink falls back
  // to that 100-column stub for EVERY requested width, including 80, and
  // still renders every name intact on one line: the assertion above stays
  // green with `width` entirely disconnected from the component. Confirmed
  // by deleting `width={width}` from `TabStrip.tsx` and rerunning: all tests
  // above stayed green (see the task report).
  //
  // What actually distinguishes "80 columns honoured" from "100-column
  // stub, `width` ignored" is WHERE the wrap happens: at a true 80-column
  // box the content (89 columns) doesn't fit and "9 system" wraps to the
  // second line; at 160 — or at the 100-column stub `width` would fall
  // back to — it fits and stays on the first line with the rest.
  it('wraps "9 system" onto line two at width 80 but keeps it with the rest at width 160', () => {
    const [line1at80] = (render(<TabStrip active="triage" width={80} />).lastFrame() ?? '').split('\n');
    expect(line1at80).not.toContain('9 system');

    const [line1at160] = (render(<TabStrip active="triage" width={160} />).lastFrame() ?? '').split('\n');
    expect(line1at160).toContain('9 system');
  });

  // RULING R-P8 overrides the brief's `toBeLessThanOrEqual(2)`: the strip must
  // be EXACTLY two lines at every width, not "at most two". Task 6 grows a
  // CONSTANT (CHROME_LINES) by the strip's height; a width-dependent height
  // (1 line when the content fits, 2 when it wraps) makes no single constant
  // correct — budget +1 and the 80-column floor overflows, budget +2 and wide
  // terminals waste a line. Tested at 80 (where the strip's own content is
  // wide enough to wrap on its own) and at 100 and 160 (where it is not, and
  // the fixed height is the only thing keeping it at two lines rather than one).
  it.each([80, 100, 160])('is exactly two lines at width %i', (width) => {
    const lines = (render(<TabStrip active="triage" width={width} />).lastFrame() ?? '').split('\n');
    expect(lines.length).toBe(2);
  });

  // RULING R-P9: `active` may name something that is not a tab at all (a
  // later task binds `D` to a doctor view, which is not one of the nine
  // tabs). TabStrip must not crash, must still render all nine tabs, and
  // must highlight none of them.
  it('renders all nine tabs with none highlighted when active names no tab, and stays two lines', () => {
    const frame = render(<TabStrip active="doctor" width={100} />).lastFrame() ?? '';
    for (const t of TABS) expect(frame).toContain(`${t.key} ${t.name}`);
    // '▸ ' is the highlight marker (see the "highlights the active tab" test
    // below) — its absence here is what "no tab highlighted" cashes out to.
    expect(frame).not.toContain('▸');
    expect((frame.match(/\n/g) ?? []).length + 1).toBe(2);
  });

  // Not in the brief, but load-bearing for the assertion above: if TabStrip
  // never highlighted anything at all, "none highlighted when active names no
  // tab" would pass vacuously. This proves the marker exists and moves with
  // `active` for a real tab, so its absence for "doctor" actually means something.
  it('highlights exactly the active tab, and only it', () => {
    const frame = render(<TabStrip active="locks" width={100} />).lastFrame() ?? '';
    expect(frame).toContain('▸ 3 locks');
    expect(frame).not.toContain('▸ 1 triage');
    expect(frame).not.toContain('▸ 2 sessions');
  });

  // spec §5.2: a warning glyph means "act now"; until `useVerdicts` exists
  // there is nothing honest to show. This is a deliberate regression fence
  // for a later plan — do not delete it to make room for a glyph without
  // first re-reading why it's here.
  it('carries no verdict glyph — a warning must mean "act now" (spec §5.2)', () => {
    for (const active of TABS.map((t) => t.name)) {
      const frame = render(<TabStrip active={active} width={100} />).lastFrame() ?? '';
      expect(frame).not.toMatch(/[⚠✓]/);
    }
  });
});
