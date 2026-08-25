import { useInput } from 'ink';
import { type Tab, tabForKey } from './tabs.js';

/**
 * The shell's global navigation keys (spec §5.5): `1`-`9` jump, `Tab` /
 * `Shift-Tab` cycle, `D` opens doctor, `Esc` goes home.
 *
 * No state is shared here, so this is a bare hook over `useInput` and nothing
 * else — the shell owns the active view.
 *
 * **`enabled` is a correctness guard, not a convenience.** Ink fires *every*
 * registered `useInput` handler for a keypress; there is no capture phase and
 * nothing to stop propagation. `ConfirmModal` treats any key that is not `y` as
 * cancel, and filter mode (`useListNavigation`) treats every key as text. So
 * while either has focus a global `4` would cancel a pending kill *and*
 * navigate away, or navigate mid-word. Passing `{ isActive: enabled }` means
 * Ink never routes the key here at all — an early `return` inside the handler
 * would look equivalent today and stop being equivalent the moment someone adds
 * a branch above it.
 */
export interface GlobalNavOptions {
  /**
   * False while a modal or filter has captured the keyboard. Required, not
   * optional-with-a-default: the guard is the correctness property, so a caller
   * that forgets it should be a type error rather than silently permissive.
   */
  enabled: boolean;
  /** Fired on `1`-`9` with the registered tab. `0` is unbound (spec §5.3). */
  onJump: (tab: Tab) => void;
  /** Fired on Tab (`1`, forward) and Shift-Tab (`-1`, back). */
  onCycle: (dir: 1 | -1) => void;
  /** Fired on capital `D` — the doctor view is not a tab (R-P9). */
  onDoctor: () => void;
  /** Fired on Esc — the shell always returns to triage (spec §5.6). */
  onEscape: () => void;
}

export function useGlobalNav(opts: GlobalNavOptions) {
  const { enabled } = opts;

  useInput(
    (input, key) => {
      // Tab and Shift-Tab both arrive as `key.tab` with an empty `input`
      // (Shift-Tab is CSI Z), so the shift flag is the only thing separating
      // the two directions.
      if (key.tab) {
        opts.onCycle(key.shift ? -1 : 1);
        return;
      }
      if (key.escape) {
        opts.onEscape();
        return;
      }
      // Capital only. Lowercase `d` is left free for a per-view binding, and a
      // destructive-adjacent key that fires on either case is a key that fires
      // by accident.
      if (input === 'D') {
        opts.onDoctor();
        return;
      }
      // Ask the registry rather than indexing by digit: that is what keeps `0`
      // unbound instead of silently resolving to an empty tenth slot.
      const tab = tabForKey(input);
      if (tab) opts.onJump(tab);
    },
    { isActive: enabled },
  );
}
