import { Box, Text, useApp, useInput } from 'ink';
import type { ReactNode } from 'react';
import { theme } from '../../core/theme.js';

/**
 * The view for a tab that has a name and a key but no implementation yet
 * (spec §5.3: *"Tabs for views not yet built open a one-line placeholder naming
 * the phase that delivers them. A tab must never show a ✓ for something
 * unmeasured."*).
 *
 * **It renders no verdict, no glyph, no tick.** That is the same rule the
 * cockpit follows when a panel's query fails — `src/commands/home/index.tsx`'s
 * `unmeasured()` returns six `{ ok: false }` panels rather than zeroed data,
 * "because an incident tool that fabricates 'all clear' while the database is
 * down is worse than one that shows nothing". An unbuilt view has measured
 * exactly as much as a failed one.
 */

/**
 * Which phase delivers each view that has a name but no code (spec §9).
 *
 * `space`, `vacuum`, `replication` and `seq` are all Phase 2 ("parity, live");
 * `system` is Phase 5 ("environment") because its checks are billed HTTP calls
 * to a cloud metrics API rather than SQL; `doctor` is Phase 3, and is here
 * rather than in `TABS` because it holds no digit (RULING R-P9).
 *
 * A plain lookup, not a field on `Tab`: `doctor` is not a tab, so a per-tab
 * field could not carry it, and the registry would then own a fact about a view
 * that is deliberately not in it.
 *
 * Exported so the tests measure and pin THIS table rather than a copy of it —
 * a copy is how an entry comes to be added here and checked nowhere.
 */
export const PHASES: Record<string, string> = {
  space: 'Phase 2',
  vacuum: 'Phase 2',
  replication: 'Phase 2',
  seq: 'Phase 2',
  system: 'Phase 5',
  doctor: 'Phase 3',
};

export interface PlaceholderProps {
  /** The view name — a tab name, or `doctor`. */
  name: string;
  /** The tab strip, handed down by the shell exactly as the real views take it. */
  strip?: ReactNode;
}

export function Placeholder({ name, strip }: PlaceholderProps) {
  const { exit } = useApp();

  /*
   * RULING R-P10: this view owns `q` itself.
   *
   * Every built view quits through `useListNavigation`, which this one does not
   * render — it has no list. Without this handler `q` would do nothing on an
   * unbuilt tab and the app would look hung, one keystroke away from every
   * working screen. Quit deliberately does NOT live in `useGlobalNav`: that
   * would put a second `exit()` alongside `useListNavigation`'s on every built
   * view, and Ink fires every registered handler for a keypress.
   */
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) exit();
  });

  const phase = PHASES[name];

  return (
    <Box flexDirection="column">
      {strip}
      {/*
        ONE line, and it has to stay one line at the 80-column FLOOR — spec §5.3
        says "a one-line placeholder", and `<Text>` wraps hard, so a line 83
        columns wide is two lines on the terminal this product promises to work
        in. The longest name (`replication`) is what sets the budget; the review
        that caught this measured 83 for it, which is why the phase now reads
        `· Phase 2` rather than `· Phase 2 delivers it`.

        No rendering test can catch a regression here — `ink-testing-library`'s
        stdout stub pins `columns` to 100 — so `Placeholder.test.tsx` measures
        every entry of `PHASES` with `stringWidth` (display columns, NOT
        `.length`, which has already shipped two bugs on this branch).
      */}
      <Text color={theme.dim}>
        {' '}
        {name} — not built yet{phase ? ` · ${phase}` : ''} · 1-9 jump · Esc triage · q quit
      </Text>
    </Box>
  );
}
