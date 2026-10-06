import { afterEach, describe, expect, it } from 'vitest';
import type { Rates } from '@pgops/checks';
import { render, type Rendered } from './render.js';
import { Throughput } from '@/components/throughput';
import type { PageRates } from '@/lib/rates';

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; });

const rates = (over: Partial<PageRates> = {}): PageRates => ({
  seconds: 5, commitsPerSec: 17, rollbacksPerSec: 0, deadlocks: 0,
  tempBytesPerSec: 0, cacheHitPct: null, tuplesPerSec: 0, ownPerSec: 0, ...over,
} satisfies Rates & { ownPerSec: number });

describe('Throughput', () => {
  it('says it needs two readings before it has an interval', async () => {
    rendered = await render(<Throughput rates={null} />);
    expect(rendered.text()).toContain('rates after the next refresh');
  });

  /**
   * B11. The number beside the rate is what stops an operator reading the
   * console's own polling as the application's load. On the dev database,
   * where nothing but pgops is connected, the two are equal — and that
   * equality is the reading, not a rounding artefact.
   */
  it('states the console own read rate beside the database rate', async () => {
    rendered = await render(<Throughput rates={rates({ ownPerSec: 17 })} />);
    const t = rendered.text();
    expect(t).toContain('17 commits/s');
    expect(t).toContain('this console ~17/s');
  });

  /**
   * A database doing real work with a quiet console must not carry a "0 of
   * them" clause: a zero here is noise on a line read at a glance, and the
   * absence says the same thing.
   */
  it('says nothing when the console issued none in the window', async () => {
    rendered = await render(<Throughput rates={rates({ ownPerSec: 0 })} />);
    expect(rendered.text()).not.toContain('this console');
  });

  /**
   * B11, the part that nearly shipped broken. On the Triage page Throughput
   * is compact by construction, and that compact line was a hand-written
   * span listing commits, rollbacks and deadlocks — a second copy of this
   * component's formatting, in the file this component's own docblock says
   * it exists to keep out. So the console's own share reached the Queries
   * page and the loud panel, and not the one line an operator actually reads
   * on the page where "19 commits/s against an idle database" was found.
   *
   * `compact` is that line, owned here: the three readings it carried plus
   * the clause, and none of the detail a one-line slot has no room for.
   */
  it('carries the console share on the compact line too', async () => {
    rendered = await render(<Throughput rates={rates({ ownPerSec: 17 })} compact />);
    // Asserted as the WHOLE line, not with `toContain`. Every string below
    // also appears in the full renderer, so three `toContain`s passed
    // against an unknown `compact` prop that React silently dropped —
    // a test that could not fail, which is how this file first read.
    expect(rendered.text().trim()).toBe(
      '17 commits/s · 0 rollbacks/s · this console ~17/s',
    );
  });

  it('leaves the detail out of a one-line slot', async () => {
    rendered = await render(<Throughput rates={rates({ cacheHitPct: 99.4, tempBytesPerSec: 2048, ownPerSec: 1 })} compact />);
    const t = rendered.text();
    expect(t).not.toContain('cache hit');
    expect(t).not.toContain('temp files');
    expect(t).not.toContain('last 5s');
  });

  it('still says it needs two readings when compact', async () => {
    rendered = await render(<Throughput rates={null} compact />);
    expect(rendered.text()).toContain('rates after the next refresh');
    // In a one-line slot, without the paragraph the loud panel renders.
    expect(rendered.container.querySelector('p')).toBeNull();
  });

  /**
   * The wording is a LABELLED RATE, not a share of the number beside it, and
   * that is the whole reason it reads this way. The first version said
   * "N of them this console's own reads", and driving it put "4 commits/s ·
   * 5 of them this console's own reads" on the Triage page: the console's own
   * accounting runs about one statement ahead of the server snapshot it is
   * compared against — the `databaseActivity` query itself commits after the
   * counters it reports — and the two numbers round independently. A subset
   * claim that exceeds its own total reads as a rendering fault, which is
   * exactly the class of defect this stage exists to remove.
   *
   * As two labelled readings the same numbers are informative and cannot
   * contradict: the database committed about four a second, this console
   * issued about five, so the rate is the console.
   */
  it('does not claim to be a subset of the rate it sits beside', async () => {
    rendered = await render(<Throughput rates={rates({ commitsPerSec: 4, ownPerSec: 5 })} compact />);
    const t = rendered.text();
    expect(t).toContain('4 commits/s');
    expect(t).toContain('this console ~5/s');
    expect(t).not.toContain('of them');
  });
});