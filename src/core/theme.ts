/**
 * Shared color palette — GitHub's dark theme.
 * Familiar to developers and accessibility-tested (see plan §C, Visual identity).
 * These map to Ink `color` props (hex is supported in truecolor terminals).
 */
export const theme = {
  bg: '#0d1117', // terminal black
  fg: '#e6edf3', // off-white
  critical: '#f85149', // red
  warning: '#d29922', // amber
  info: '#58a6ff', // blue
  success: '#3fb950', // green
  dim: '#8b949e', // slate
} as const;

export type ThemeColor = keyof typeof theme;

/**
 * A transient status-bar line: an error, a kill outcome, a snapshot path.
 *
 * Lives in core, next to the palette its `color` indexes, because core PRODUCES
 * these — `core/snapshot-file.ts`'s `saveSnapshot` returns one either way. It
 * used to be declared in `ui/StatusBar.tsx`, which made core import from ui and
 * inverted the layering the rest of core maintains: ui depends on core, never
 * the reverse.
 */
export interface StatusMessage {
  text: string;
  color: ThemeColor;
}
