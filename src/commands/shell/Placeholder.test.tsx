import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { Placeholder, PHASES } from './Placeholder.js';

/**
 * The placeholder measured rather than merely rendered.
 *
 * `Shell.test.tsx` proves the shell mounts this for an unbuilt tab and for
 * `doctor`. What it cannot prove is the two properties that only exist in
 * display columns: that each entry names the RIGHT phase, and that the line
 * still fits the 80-column floor. `ink-testing-library`'s stdout stub pins
 * `columns` to 100, so a line 83 columns wide renders on one line there and
 * wraps on the terminal this product promises to work in — which is exactly how
 * `replication` shipped over the floor and was caught by review, not by a test.
 */

/**
 * The spec §9 phase for every view that has a name and no code. Written out
 * here rather than imported, so this is a genuine second opinion on `PHASES`
 * instead of a restatement of it.
 */
const EXPECTED: Record<string, string> = {
  space: 'Phase 2',
  vacuum: 'Phase 2',
  replication: 'Phase 2',
  seq: 'Phase 2',
  system: 'Phase 5',
  doctor: 'Phase 3',
};

/** The rendered line, ANSI stripped by `string-width`, one entry per row. */
function frameFor(name: string): string {
  const { lastFrame } = render(<Placeholder name={name} />);
  return lastFrame() ?? '';
}

describe('Placeholder', () => {
  it('covers exactly the views that have a name and no code', () => {
    // Guards the two tests below against a seventh entry that is added to
    // `PHASES` and then checked by nothing.
    expect(Object.keys(PHASES).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('names the phase that delivers each one', () => {
    const rendered = Object.keys(EXPECTED).map((name) => {
      const frame = frameFor(name);
      return `${name} ${/Phase \d/.exec(frame)?.[0] ?? 'none'}`;
    });
    expect(rendered).toEqual(Object.entries(EXPECTED).map(([n, p]) => `${n} ${p}`));
  });

  it('fits the 80-column floor on one line, measured in display columns', () => {
    // `stringWidth`, never `.length`: the line carries `—` and `·`, and
    // character count is not display width. Two bugs on this branch came from
    // measuring the wrong one.
    const widths = Object.keys(EXPECTED).map((name) => {
      const lines = frameFor(name).split('\n').filter((l) => l.trim() !== '');
      return { name, lines: lines.length, width: Math.max(...lines.map((l) => stringWidth(l))) };
    });
    for (const w of widths) {
      expect({ ...w, ok: w.width <= 80 && w.lines === 1 }).toEqual({ ...w, ok: true });
    }
  });

  it('never claims health, and never claims escalation', () => {
    for (const name of Object.keys(EXPECTED)) {
      const frame = frameFor(name);
      expect(frame).not.toContain('✓');
      expect(frame).not.toContain('⚠');
    }
  });

  it('says so plainly for a name it has no phase for', () => {
    // `PHASES[name]` is `string | undefined` under noUncheckedIndexedAccess;
    // an unknown view must still render a usable screen rather than `undefined`.
    const frame = frameFor('mcp');
    expect(frame).toContain('mcp — not built yet');
    expect(frame).not.toContain('undefined');
    expect(frame).not.toMatch(/Phase/);
  });
});
