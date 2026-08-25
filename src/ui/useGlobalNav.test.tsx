import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Tab } from './tabs.js';
import { type GlobalNavOptions, useGlobalNav } from './useGlobalNav.js';

/**
 * Escape sequences as this terminal (and `ink-testing-library`'s stdin) actually
 * delivers them — verified with a throwaway probe that printed the `key` object:
 *
 *   TAB      -> input '',   key.tab
 *   ESC+'[Z' -> input '',   key.tab + key.shift   (xterm's Shift-Tab, CSI Z)
 *   ESC      -> input '',   key.escape (+ key.meta)
 *   'D'      -> input 'D',  key.shift
 *
 * Shift-Tab is reachable through this harness; the reverse-direction test below
 * really does exercise `key.shift`, not a stand-in for it.
 */
const TAB = String.fromCharCode(9);
const ESC = String.fromCharCode(27);
const SHIFT_TAB = ESC + '[Z';

type Handlers = Omit<GlobalNavOptions, 'enabled'>;

const spies = () => ({
  onJump: vi.fn<(tab: Tab) => void>(),
  onCycle: vi.fn<(dir: 1 | -1) => void>(),
  onDoctor: vi.fn<() => void>(),
  onEscape: vi.fn<() => void>(),
});

function Probe({ enabled = true, ...rest }: { enabled?: boolean } & Handlers) {
  useGlobalNav({ enabled, ...rest });
  return <Text>probe</Text>;
}

/** Give Ink time to attach its stdin listener before the first keystroke. */
const mount = () => new Promise((r) => setTimeout(r, 120));

/** One key (or escape sequence) at a time, with a gap — a real user types with gaps. */
async function press(stdin: { write: (s: string) => void }, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** Every key this hook claims, in one sequence — used by the suppression test. */
const ALL_KEYS = ['1', '5', '9', 'D', TAB, SHIFT_TAB, ESC];

describe('useGlobalNav', () => {
  it('jumps on 1-9 and ignores 0', async () => {
    const s = spies();
    const { stdin } = render(<Probe {...s} />);
    await mount();

    await press(stdin, '1', '4', '9');
    // The digit is resolved through the tab registry, not by position in some
    // local list: assert the Tab that came back, not just the call count.
    expect(s.onJump.mock.calls.map(([tab]) => tab.name)).toEqual(['triage', 'top', 'system']);

    // `0` is deliberately unbound (spec §5.3) — an implementation that tested
    // /[0-9]/ instead of asking the registry would fire here.
    await press(stdin, '0');
    expect(s.onJump).toHaveBeenCalledTimes(3);
  });

  it('cycles forward on Tab and backward on Shift-Tab', async () => {
    const s = spies();
    const { stdin } = render(<Probe {...s} />);
    await mount();

    await press(stdin, TAB);
    expect(s.onCycle.mock.calls).toEqual([[1]]);

    await press(stdin, SHIFT_TAB);
    expect(s.onCycle.mock.calls).toEqual([[1], [-1]]);
  });

  it('opens doctor on D, not on lowercase d', async () => {
    const s = spies();
    const { stdin } = render(<Probe {...s} />);
    await mount();

    await press(stdin, 'd');
    expect(s.onDoctor).not.toHaveBeenCalled(); // case matters (spec §5.5)

    await press(stdin, 'D');
    expect(s.onDoctor).toHaveBeenCalledTimes(1);
  });

  it('escapes on Esc', async () => {
    const s = spies();
    const { stdin } = render(<Probe {...s} />);
    await mount();

    await press(stdin, ESC);
    expect(s.onEscape).toHaveBeenCalledTimes(1);
  });

  it('is completely inert when disabled — the suppression rule (spec §5.5)', async () => {
    // First prove the harness really delivers all of these keys, so the
    // "zero calls" half below cannot pass for the wrong reason.
    const live = spies();
    const on = render(<Probe enabled {...live} />);
    await mount();
    await press(on.stdin, ...ALL_KEYS);
    expect(live.onJump).toHaveBeenCalledTimes(3);
    expect(live.onCycle).toHaveBeenCalledTimes(2);
    expect(live.onDoctor).toHaveBeenCalledTimes(1);
    expect(live.onEscape).toHaveBeenCalledTimes(1);

    // Same keys, `enabled: false`. This is the test that stops a digit typed
    // into a filter from navigating, and a digit pressed with a ConfirmModal
    // open from both cancelling the kill and changing tab.
    const s = spies();
    const off = render(<Probe enabled={false} {...s} />);
    await mount();
    await press(off.stdin, ...ALL_KEYS);
    for (const spy of Object.values(s)) expect(spy).not.toHaveBeenCalled();
  });
});
