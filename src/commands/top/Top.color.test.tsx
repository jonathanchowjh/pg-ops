import { describe, expect, it } from 'vitest';
import { theme } from '../../core/theme.js';
import type { QueryRow } from './stats.js';

/**
 * Ink resolves chalk's colour-support level once, at import time, from
 * `process.stdout`. ink-testing-library's fake stdout isn't a TTY, so by
 * default every colour is stripped from `lastFrame()` and there is nothing
 * for a frame assertion to see (finding 2's required test needs the actual
 * ANSI codes). Setting `FORCE_COLOR` here — before `ink`/`ink-testing-library`
 * are ever imported anywhere in this file's module graph — makes chalk emit
 * real truecolor escapes. That's why every ink-touching import below is
 * dynamic: a static import at the top of the file would run before this line
 * and chalk would already have frozen its (colourless) level.
 */
process.env.FORCE_COLOR = '3';

const row = (n: number, query: string): QueryRow => ({
  queryid: String(n),
  query,
  calls: 1,
  totalMs: 1,
  meanMs: 1,
  stddevMs: 0,
  rows: 1,
  sharedBlksHit: 1,
  sharedBlksRead: 0,
  cacheHitPct: 100,
});

describe('Top query cell colour (finding 2)', () => {
  it('brightens the query cell on the selected row and dims it otherwise', async () => {
    const { default: chalk } = await import('chalk');
    const { render } = await import('ink-testing-library');
    const { Top } = await import('./Top.js');

    // The ANSI "open" sequence chalk emits for a given hex colour, isolated
    // from whatever chalk chooses to do at the end (which varies with what
    // follows in the frame) — see the module comment above for why this test
    // needs real ANSI at all.
    const openCodeFor = (hex: string) => {
      const wrapped = chalk.hex(hex)('X');
      return wrapped.slice(0, wrapped.indexOf('X'));
    };

    const rows = [row(1, 'SELECTONE'), row(2, 'SELECTTWO')];
    const { lastFrame } = render(<Top rows={rows} sort="total" selectedIndex={0} />);
    const frame = lastFrame() ?? '';

    // Row 0 is selected: pre-migration QueryRowLine used theme.fg for it.
    expect(frame).toContain(`${openCodeFor(theme.fg)}SELECTONE`);
    // Row 1 is not selected: pre-migration QueryRowLine dimmed it.
    expect(frame).toContain(`${openCodeFor(theme.dim)}SELECTTWO`);
  });
});
