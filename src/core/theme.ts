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
