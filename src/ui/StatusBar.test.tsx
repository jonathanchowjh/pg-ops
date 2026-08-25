import stringWidth from 'string-width';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
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
    //
    // Seven hints, one more than `sessions` actually renders since the shell
    // took ownership of `Esc` (RULING R-P7 dropped `Esc back`). Kept over-long
    // on purpose: this test is about the facts surviving pressure from the
    // hints, so the pressure should exceed what any real view produces rather
    // than track it.
    const { lastFrame } = render(
      <StatusBar
        subcommand="sessions"
        target="localhost:55432/appdb"
        cadence="every 2s"
        freshness="updated just now"
        hints={['j/k move', 'o sort', '/ filter', 'x kill', 's snapshot', 'Esc back (not a real hint — see above)', 'q quit']}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('pgops sessions');
    expect(frame).toContain('every 2s');
    expect(frame).toContain('updated just now');
  });

  it('costs 3 lines with no message and 4 with one — the number both views budget', () => {
    // `sessions/index.tsx` and `top/index.tsx` subtract this from the table's
    // line budget. The message renders INSIDE the border, so it grows the bar
    // rather than sharing a row: a view that assumed a flat 3 drew one line too
    // many on a 24-row terminal, at exactly the moment a kill outcome was
    // showing. Short props so nothing here can wrap for an unrelated reason.
    const lineCount = (el: ReactElement) => (render(el).lastFrame() ?? '').split('\n').length;
    expect(lineCount(<StatusBar subcommand="top" hints={['q quit']} />)).toBe(3);
    expect(
      lineCount(
        <StatusBar subcommand="top" hints={['q quit']} message={{ text: '✓ terminated pid 4711', color: 'success' }} />,
      ),
    ).toBe(4);
  });

  it('still costs 4 lines when the message is far longer than the terminal is wide', () => {
    // The gap the "costs 4" case above misses: it never gives the message a
    // reason to wrap. `ink-testing-library`'s stdout stub reports a fixed 100
    // columns, so a message has to clear roughly that to prove anything —
    // this one is 132. Before `wrap="truncate"` was added to the message
    // `<Text>` (StatusBar.tsx), Ink's default wrapping split a message this
    // long across two lines, costing 5 — exactly the `snapshot → <absolute
    // path>` case that both `sessions/index.tsx` and `top/index.tsx` budget
    // for as a flat "+1". Revert that `wrap="truncate"` and this goes to 5.
    const message = {
      text: 'snapshot → /Users/pgops-demo-operator/.pgops/snapshots/sessions-1755648000000-a-message-engineered-to-clear-a-100-column-terminal.md',
      color: 'success' as const,
    };
    const lineCount = (el: ReactElement) => (render(el).lastFrame() ?? '').split('\n').length;
    expect(lineCount(<StatusBar subcommand="top" hints={['q quit']} message={message} />)).toBe(4);
  });

  it('renders without a message when none is provided', () => {
    const { lastFrame } = render(
      <StatusBar subcommand="locks" hints={['q quit']} />,
    );
    expect(lastFrame()).toContain('pgops locks');
  });
});

/**
 * `STATUS_BAR_LINES = 3` is asserted as load-bearing in all four containers.
 * This is the case that used to make it false.
 */
describe('StatusBar — a long target must not wrap the bar', () => {
  // An ordinary RDS endpoint. Not a pathological fixture: this is what
  // `safeTarget` produces for a normal managed Postgres.
  const RDS = 'prod-cluster-01.abcdefgh.eu-west-1.rds.amazonaws.com:5432/appdb';

  it('keeps every line inside 80 columns', () => {
    const frame =
      render(
        <StatusBar
          subcommand="sessions"
          target={RDS}
          cadence="every 2s"
          freshness="updated just now"
          hints={['j/k move', 'o sort', '/ filter', 'x kill', 's snapshot', 'q quit']}
          width={80}
        />,
      ).lastFrame() ?? '';

    // WIDTH, not line count — and this is the opposite of the rule that governs
    // every `Table` assertion in this codebase (`ui/geometry.test.tsx`).
    //
    // `Table`'s rows are `<Text>` inside a width-constrained `<Box>`, so Ink
    // *wraps* them and an over-wide row shows up as extra lines, never a long
    // line. The facts row here is `flexShrink={0}`, deliberately, so Ink does
    // not constrain it at all: it *overflows*. Measured before the fix, this
    // frame was 3 lines of [80, 109, 80] — the line count was fine and the
    // content line was 29 columns past the right border. It is the real
    // terminal that wraps that line onto a second row, which is what turns the
    // bar into 4 rows and pushes the table below it off the screen.
    //
    // So here the width assertion is the one that can fail and the line-count
    // assertion is the vacuous one.
    for (const line of frame.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(80);

    // And the bar still identifies the database — truncated, not dropped. An
    // operator with two terminals open has to know which one this is.
    expect(frame).toContain('prod-cluster-01');
    expect(frame).toContain('updated just now');
    // The last fact must not weld itself to the first hint.
    // `justifyContent="space-between"` contributes no gap of its own — it
    // distributes leftover space, and once the target fills the row exactly
    // there is none, so the bar read `updated just nowj/k move`. The explicit
    // `gap` is what keeps them apart.
    expect(frame).not.toMatch(/updated just now\S/);
  });

  it('leaves the target alone when no width is supplied', () => {
    const frame =
      render(<StatusBar subcommand="sessions" target={RDS} hints={['q quit']} />).lastFrame() ?? '';
    expect(frame).toContain(RDS);
  });
});
