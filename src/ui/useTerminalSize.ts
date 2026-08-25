import { useStdout } from 'ink';
import { useLayoutEffect, useState } from 'react';

/**
 * POSIX defaults. Used whenever stdout reports nothing — a pipe, a CI log, a
 * `--snapshot` redirect. Guessing wide would wrap; 80x24 always renders.
 */
const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

/**
 * One row every view must leave unused.
 *
 * Ink does not merely clip a frame that is as tall as the terminal — it takes a
 * different write path for it. `ink/build/ink.js:121` is
 * `if (outputHeight >= this.options.stdout.rows)`, and that branch writes
 * `ansiEscapes.clearTerminal` before the frame instead of an incremental
 * update. So a frame of exactly `rows` lines wipes the terminal **and its
 * scrollback** on every single poll: 2s in the drill-downs, 5s in the cockpit.
 * The screen visibly flashes and anything the operator had scrolled back to —
 * the psql session above pgops, the log line that sent them here — is gone.
 *
 * Note the boundary: the clear fires at `>= rows`, not `> rows`. `24` is
 * already too tall for a 24-row terminal, so the budget is `rows - 1`.
 *
 * This is not the same thing as the chrome each view renders; it is a row that
 * belongs to Ink, so it is subtracted separately and everywhere.
 */
export const INK_CLEAR_RESERVE = 1;

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * The terminal's current size, re-rendering on resize.
 *
 * The only impure piece of the geometry work, and deliberately the thinnest:
 * `ink-testing-library`'s stdout stub exposes `columns` as a prototype getter
 * hardcoded to 100, with no setter and no option, so nothing rendered through
 * that harness can be observed at another width. Every decision that depends on
 * width therefore lives in `solveColumns`/`budgetRows`, which are pure and tested
 * directly, and `Table` accepts explicit overrides so view tests can pin a size.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => ({
    columns: stdout?.columns ?? FALLBACK_COLUMNS,
    rows: stdout?.rows ?? FALLBACK_ROWS,
  });

  const [size, setSize] = useState<TerminalSize>(read);

  // Layout phase, not `useEffect`: the subscription must be in place the moment
  // the component commits. A passive effect runs later, leaving a window where a
  // resize arriving between render and commit is dropped — the UI then keeps
  // rendering at the stale size until the *next* resize.
  //
  // React's own `useSyncExternalStore` tolerates that same window: it subscribes
  // with a passive effect (`mountEffect`/`updateEffect` in react-reconciler), and
  // instead catches missed notifications by re-reading `getSnapshot()` on every
  // render plus a commit-phase consistency check. We have no such check, so we
  // close the window rather than detect it.
  //
  // It also makes the listener observable synchronously after `render()`, which
  // is what the covering test in `useTerminalSize.test.tsx` asserts — swap this
  // back to `useEffect` and that test fails for reasons that look unrelated to
  // the swap.
  useLayoutEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(read);
    stdout.on('resize', onResize);
    // Re-read on mount: the terminal may have been resized between the initial
    // useState and this effect running.
    onResize();
    return () => {
      stdout.off('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);

  return size;
}
