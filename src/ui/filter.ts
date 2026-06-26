/**
 * Pure reducer for the `/` filter input mode (plan: "/ to filter").
 *
 * Kept separate from the Ink hook so the editing logic — append, backspace,
 * confirm, cancel — is unit-testable without a terminal. The hook just feeds it
 * keystrokes and applies the result, the same way index.tsx feeds rows to
 * prepareRows. Logic in the middle, I/O at the edge.
 */

export interface FilterState {
  filter: string;
  /** True while the user is actively typing a filter. */
  filtering: boolean;
}

/** The subset of Ink's Key we care about (structural — Ink's Key satisfies it). */
export interface FilterKey {
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/** Control characters (C0 + DEL) that must never be appended to the filter text. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function reduceFilter(state: FilterState, input: string, key: FilterKey): FilterState {
  if (key.return) return { filter: state.filter, filtering: false }; // confirm, keep filter
  if (key.escape) return { filter: '', filtering: false }; // cancel, clear filter
  if (key.backspace || key.delete) return { ...state, filter: state.filter.slice(0, -1) };
  // A printable keystroke; ignore control/meta chords (Ctrl-C, ⌘V, ...) and any
  // raw control characters (escape sequences or newlines from a paste).
  if (input && !key.ctrl && !key.meta && !CONTROL_CHARS.test(input)) {
    return { ...state, filter: state.filter + input };
  }
  return state;
}
