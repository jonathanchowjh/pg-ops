import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { StatusBar } from './StatusBar.js';

describe('StatusBar', () => {
  it('renders a long message and the full hint list intact (no mid-word wrap/truncation)', () => {
    // Realistic locks-shaped props: target + cadence + the full hint list
    // (locks/index.tsx's actual set) plus a real kill message. Threading the
    // message through the same row as subcommand/target/cadence/hints
    // overflows the 96-column interior (paddingX 1 + border 1 per side of a
    // 100-column terminal) and forces Ink to mid-word-wrap everything,
    // including "pgops locks" itself — the bug this test guards against.
    const hints = ['j/k move', 'x kill', 's snapshot', 'q quit'];
    const message = { text: '✓ terminated pid 4711 — 3 waiter(s) released', color: 'success' as const };
    const { lastFrame } = render(
      <StatusBar
        subcommand="locks"
        target="localhost:55432/appdb"
        cadence="every 2s"
        hints={hints}
        message={message}
      />,
    );
    const frame = lastFrame() ?? '';
    // The subcommand title must survive intact — this is what visibly split
    // ("pgops" / "locks" on two lines) when the message competed for space
    // in the same row.
    expect(frame).toContain('pgops locks');
    expect(frame).toContain('localhost:55432/appdb');
    expect(frame).toContain('every 2s');
    // The full message, verbatim and on one line — no mid-word wrap.
    expect(frame).toContain('✓ terminated pid 4711 — 3 waiter(s) released');
    // The full hint list, verbatim and on one line.
    expect(frame).toContain(hints.join('  ·  '));
  });

  it('keeps cadence AND freshness intact on the widest bar (sessions), clipping hints instead', () => {
    // The I2 shape: every view now shows freshness as well as cadence, and
    // sessions carries the longest hint list. The facts must survive whole —
    // a mid-word-wrapped "updated just / now" is exactly the label an operator
    // skims past. Hints are what gives.
    const { lastFrame } = render(
      <StatusBar
        subcommand="sessions"
        target="localhost:55432/appdb"
        cadence="every 2s"
        freshness="updated just now"
        hints={['j/k move', 'o sort', '/ filter', 'x kill', 's snapshot', 'Esc back', 'q quit']}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('pgops sessions');
    expect(frame).toContain('every 2s');
    expect(frame).toContain('updated just now');
  });

  it('renders without a message when none is provided', () => {
    const { lastFrame } = render(
      <StatusBar subcommand="locks" hints={['q quit']} />,
    );
    expect(lastFrame()).toContain('pgops locks');
  });
});
