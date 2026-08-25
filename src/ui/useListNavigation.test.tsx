import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { assertActionKeys, useListNavigation } from './useListNavigation.js';

/** A minimal host that exposes the hook's filter state as text we can assert on. */
function Harness() {
  const [value, setValue] = useState('');
  const [active, setActive] = useState(false);
  useListNavigation({ itemCount: 3, filter: { value, active, setValue, setActive } });
  return <Text>mode:{active ? 'filter' : 'nav'} q:{value || '_'}</Text>;
}

const ESC = String.fromCharCode(27);
const ENTER = '\r';

/** Give Ink time to attach its stdin listener before the first keystroke. */
const mount = () => new Promise((r) => setTimeout(r, 120));

/**
 * Type one key at a time with a gap between them. Ink re-subscribes useInput on
 * re-render; a real user types with gaps, so we do too (back-to-back synchronous
 * writes would all hit the same pre-render closure).
 */
async function type(stdin: { write: (s: string) => void }, keys: string): Promise<void> {
  for (const ch of keys) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** Poll the frame until it contains `text` — robust to Ink's async re-render. */
async function waitForFrame(lastFrame: () => string | undefined, text: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((lastFrame() ?? '').includes(text)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`frame never contained "${text}"; last was ${JSON.stringify(lastFrame())}`);
}

describe('assertActionKeys', () => {
  it('accepts non-navigation action keys', () => {
    expect(() => assertActionKeys(['x', 'o'])).not.toThrow();
    expect(() => assertActionKeys(undefined)).not.toThrow();
  });
  it('rejects an action key that shadows navigation', () => {
    expect(() => assertActionKeys(['k'])).toThrow(/navigation key "k"/);
    expect(() => assertActionKeys(['j'])).toThrow(/navigation key "j"/);
  });
});

describe('useListNavigation — / filter integration', () => {
  it('enters filter mode on /, types characters, and confirms on Enter', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await mount();

    await type(stdin, '/');
    await waitForFrame(lastFrame, 'mode:filter');

    await type(stdin, 'us');
    await waitForFrame(lastFrame, 'q:us');

    await type(stdin, ENTER);
    await waitForFrame(lastFrame, 'mode:nav');
    expect(lastFrame()).toContain('q:us'); // filter kept after confirming
  });

  it('treats q as a character while filtering, not a quit', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await mount();

    await type(stdin, '/');
    await waitForFrame(lastFrame, 'mode:filter');
    await type(stdin, 'q');
    await waitForFrame(lastFrame, 'q:q');
    expect(lastFrame()).toContain('mode:filter'); // still filtering, did not quit
  });

  it('clears the filter on Escape', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await mount();

    await type(stdin, '/');
    await waitForFrame(lastFrame, 'mode:filter');
    await type(stdin, 'x');
    await waitForFrame(lastFrame, 'q:x');

    await type(stdin, ESC);
    await waitForFrame(lastFrame, 'q:_'); // cleared
    expect(lastFrame()).toContain('mode:nav');
  });
});

/*
 * There is no `Esc-to-back` suite any more. `onBack` is gone from the hook
 * (RULING R-P7 gave the shell sole ownership of Esc), and the half of that test
 * which still had an owner — Esc leaves filter mode — is already asserted by
 * `clears the filter on Escape` above. Re-stating it here would have been a
 * second measurement of the same thing rather than new coverage.
 *
 * The hook's remaining `if (key.escape) return;` is deliberately untested; the
 * comment on it in `useListNavigation.ts` explains why a test for it would
 * pass with the line deleted.
 */
