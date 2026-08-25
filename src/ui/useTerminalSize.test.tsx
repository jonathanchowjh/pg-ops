import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { useTerminalSize } from './useTerminalSize.js';

function Probe() {
  const { columns, rows } = useTerminalSize();
  return <Text>{`${columns}x${rows}`}</Text>;
}

describe('useTerminalSize', () => {
  it('reads the current terminal size', () => {
    // ink-testing-library's stdout stub reports columns=100 and no rows, so this
    // also pins the rows fallback. See the plan's harness note: the stub's
    // `columns` is a prototype getter and cannot be varied.
    const { lastFrame, unmount } = render(<Probe />);
    expect(lastFrame()).toBe('100x24');
    unmount();
  });

  it('adds exactly one resize listener of its own, and removes it on unmount', () => {
    // Ink registers its own 'resize' listener on stdout (ink/build/ink.js:77,
    // removed at :79), so the absolute count is never 1. Measure the delta this
    // hook contributes instead — that survives Ink changing its own handling.
    const baseline = render(<Text>no hook</Text>);
    const inkOnly = baseline.stdout.listenerCount('resize');
    baseline.unmount();

    const { stdout, unmount } = render(<Probe />);
    expect(stdout.listenerCount('resize')).toBe(inkOnly + 1);
    unmount();
    expect(stdout.listenerCount('resize')).toBe(0);
  });
});
