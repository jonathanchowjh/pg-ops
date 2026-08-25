import { Box, Text } from 'ink';
import { theme } from '../core/theme.js';
import { TABS } from './tabs.js';

/**
 * The tab strip: `1 triage  2 sessions  3 locks  …`, the active tab
 * highlighted, unbuilt tabs dimmed.
 *
 * **Presentational, like `Table`**: takes `width` as a prop and passes it
 * straight through to the root `<Box>` (see `Table.tsx`'s `MIN_WIDTH`
 * comment) — it does NOT call `useTerminalSize`. Containers read the
 * terminal once and supply real values; a component with its own fallback is
 * how `sessions` and `top` previously diverged on the same migration.
 *
 * **RULING R-P8 — exactly two lines at every width, never one, never three.**
 * Task 6 grows every view's `CHROME_LINES` constant by the strip's height and
 * subtracts it from the terminal height for the table's line budget. A
 * width-dependent strip height (1 line when the nine tab names happen to fit,
 * 2 when they wrap) makes no single constant correct: budget +1 and the
 * 80-column floor overflows; budget +2 and a wide terminal wastes a line.
 *
 * The mechanism: `flexWrap="wrap"` lets Ink wrap tabs onto a second row when
 * they don't fit (true at the 80-column floor — nine names plus one 2-column
 * gutter per tab total 89 display columns, comfortably over 80). A bare
 * `height={2}` on the same `Box` is what guarantees the SECOND line exists
 * even when the content fits on one row (a 100- or 160-column terminal) — Ink
 * pads the reserved second row with blank space rather than collapsing it.
 * `width={width}` on the same `Box` is what makes `flexWrap` measure against
 * the CALLER's width rather than `ink-testing-library`'s fixed 100-column
 * stub — without it, `flexWrap` has nothing narrow to wrap against and every
 * width test would silently measure the same 100-column layout three times.
 *
 * All three of `flexWrap`, `width`, and `height` are independently load-
 * bearing, each verified by deleting it and watching a real assertion go red
 * (review round 1, F1/F2 — see `TabStrip.test.tsx`'s per-tab content check at
 * width 80 and 160, and the task report for the captured before/after
 * frames): drop `flexWrap` and the Box falls back to Ink's default row
 * layout, which does not move whole tabs to a second line but instead
 * squeezes and mid-word-wraps each `<Text>`'s own content into whatever
 * column budget it's given — every name shreds at the 80-column floor,
 * silently, because nothing was asserting on names at that width before this
 * fix. Drop `width` and `flexWrap` has no narrow box to wrap against, so it
 * falls back to the 100-column test stub and never wraps at 80 either.
 *
 * **Below ~60 columns, `height={2}` CLIPS rather than growing to a third
 * line** — at width 20 only tabs 1-2 are visible, at width 40 only 1-7; the
 * remaining tabs are simply not drawn, not truncated mid-name and not spilled
 * onto a line 3 that then gets cut off. That is deliberate, not a gap: a
 * third line would keep `CHROME_LINES` honest at no width, since the whole
 * point of a FIXED height is that Task 6 can subtract a CONSTANT from the
 * terminal height and trust it. Clipping is what keeps the constant true
 * everywhere; growing a third line would make it a lie exactly when a
 * narrower-than-usual terminal needs it least. This is moot in practice — the
 * pgops floor is 80 columns, where all nine tabs still fit across the two
 * rows — but it is why `height={2}` is fixed rather than "at least 2".
 *
 * Each tab is one `<Text>` — an atomic flex item — so Ink only ever wraps
 * BETWEEN tabs, never mid-name, as long as `flexWrap` and `width` are both
 * present (see above for what happens when they aren't).
 */
export function TabStrip({ active, width }: { active: string; width: number }) {
  return (
    <Box flexWrap="wrap" width={width} height={2}>
      {TABS.map((t) => {
        // RULING R-P9: `active` may name something that isn't a tab at all
        // (a later task's doctor view). `isActive` is simply false for every
        // tab in that case — no tab highlighted, nothing crashes.
        const isActive = t.name === active;
        return (
          <Text
            key={t.key}
            inverse={isActive}
            bold={isActive}
            color={!isActive && !t.built ? theme.dim : undefined}
          >
            {/*
              ONE spacing mechanism, not two (review round 1, F5): the only gap
              between tabs is this leading 2-column gutter — `'▸ '` on the
              active tab, `'  '` otherwise, same convention as `Table`'s
              selection marker. There is no trailing pad, so `inverse` (which
              wraps this whole `<Text>`) ends exactly where the tab's name
              ends, not two columns past it. A previous version paired this
              gutter with a trailing 2-space pad on every tab, doubling the
              gap to 4 columns and running the highlight bar past the name.
            */}
            {isActive ? '▸ ' : '  '}
            {t.key} {t.name}
          </Text>
        );
      })}
    </Box>
  );
}
