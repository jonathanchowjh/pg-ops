import { useApp, useInput } from 'ink';
import { useState } from 'react';
import { reduceFilter } from './filter.js';

const NAVIGATION_KEYS = new Set(['j', 'k']);

/** Movement is reserved; an action key may never shadow it. */
export function assertActionKeys(actionKeys: string[] = []): void {
  const clash = actionKeys.find((key) => NAVIGATION_KEYS.has(key));
  if (clash) {
    throw new Error(`actionKeys cannot include navigation key "${clash}" — movement is reserved.`);
  }
}

/**
 * A `/`-filter the consumer owns. State lives in the component (so derived rows
 * can feed `itemCount` without a cycle); this hook just drives it from keystrokes.
 */
export interface FilterControl {
  value: string;
  active: boolean;
  setValue: (s: string) => void;
  setActive: (active: boolean) => void;
}

/**
 * Shared key handlers for list-style views (plan: "shared key handlers
 * j/k, /, Enter, s, q"). Each subcommand wires its own action callbacks but
 * inherits consistent navigation and quit behavior.
 */
export interface ListNavigationOptions {
  /** Number of selectable rows. */
  itemCount: number;
  /** Fired on `s` — serialize the current view to a markdown snapshot. */
  onSnapshot?: () => void;
  /** Fired on Enter — drill into the selected row. */
  onSelect?: (index: number) => void;
  /** Fired on an action key (e.g. `k` for kill). */
  onAction?: (key: string, index: number) => void;
  /** Action keys to forward to `onAction`, e.g. ["k"]. */
  actionKeys?: string[];
  /** Disable input while a modal is open. */
  enabled?: boolean;
  /** Opt in to `/`-to-filter; omit and the key is inert (e.g. locks). */
  filter?: FilterControl;
  /** Fired on Esc (outside filter mode) — pop back to the hub. Omit and Esc is inert. */
  onBack?: () => void;
}

export function useListNavigation(opts: ListNavigationOptions) {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);
  const enabled = opts.enabled ?? true;
  assertActionKeys(opts.actionKeys);
  const max = Math.max(0, opts.itemCount - 1);

  useInput(
    (input, key) => {
      // Filter mode owns the keyboard: every keystroke edits the filter text
      // (so you can type 'q', 'j', etc. into it) until Enter/Escape exits.
      if (opts.filter?.active) {
        const next = reduceFilter({ filter: opts.filter.value, filtering: true }, input, key);
        opts.filter.setValue(next.filter);
        if (!next.filtering) opts.filter.setActive(false);
        return;
      }
      if (key.escape) {
        opts.onBack?.();
        return;
      }
      if (input === 'q' || (key.ctrl && input === 'c')) {
        exit();
        return;
      }
      if (opts.filter && input === '/') {
        opts.filter.setActive(true);
        return;
      }
      if (input === 'j' || key.downArrow) {
        setIndex((i) => Math.min(max, i + 1));
        return;
      }
      if (input === 'k') {
        setIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.upArrow) {
        setIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.return) {
        opts.onSelect?.(index);
        return;
      }
      if (input === 's') {
        opts.onSnapshot?.();
        return;
      }
      if (opts.actionKeys?.includes(input)) {
        opts.onAction?.(input, index);
      }
    },
    { isActive: enabled },
  );

  // Keep selection in range if the list shrinks under us.
  if (index > max) setIndex(max);

  return { index, setIndex };
}
