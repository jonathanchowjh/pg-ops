import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Bloat from '@/app/db/[name]/queries/indexes/bloat/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { overrides } = vi.hoisted(() => ({ overrides: new Map<string, unknown>() }));

const ok = (data: unknown, verdict: unknown = null) => ({ ok: true, data, verdict, measuredAt: 0 });

const EMPTY = { indexes: [], total: 0, truncated: false };

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) =>
    overrides.get(check.id) ?? ok(EMPTY)),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => 'indexes',
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  overrides.clear();
  vi.clearAllMocks();
});

const html = async () => {
  const element = await Bloat({ params: Promise.resolve({ name: 'prod' }) });
  rendered = await render(element);
  return rendered.container.innerHTML;
};

const row = (over: Record<string, unknown> = {}) => ({
  name: 'public.ix_a',
  table: 'public.t',
  bloatBytes: 52_428_800,
  indexBytes: 209_715_200,
  definition: 'CREATE INDEX ix_a ON public.t USING btree (a)',
  primary: false,
  ...over,
});

describe('the index bloat page', () => {
  /**
   * A 30s budget is long enough that a timeout is a realistic outcome here,
   * unlike on the 10s hygiene checks. It must read as "we could not measure",
   * never as a clean bill of health.
   */
  it('renders a timeout as unavailable, with the message, not as an absence of bloat', async () => {
    overrides.set('indexBloat', {
      ok: false, reason: 'timeout',
      message: 'canceling statement due to statement timeout',
    });

    const out = await html();

    expect(out).toContain('canceling statement due to statement timeout');
    expect(out).not.toContain('No index over');
  });

  /**
   * The empty state names the FLOOR. "No bloat" would be a claim about the
   * whole database; what the check actually establishes is that nothing over
   * 100 MB of waste qualified, and small indexes were never estimated.
   */
  it('names the floor in the empty state rather than claiming there is no bloat', async () => {
    const out = await html();

    expect(out).toContain('No index over');
    expect(out).toContain('100');
    expect(out).toContain('MB');
  });

  it('renders the estimate and the ratio for a bloated index', async () => {
    overrides.set('indexBloat', ok({ indexes: [row()], total: 1, truncated: false }));

    const out = await html();

    expect(out).toContain('public.ix_a');
    expect(out).toContain('public.t');
    // 50 MB wasted of a 200 MB index.
    expect(out).toContain('50 MB');
    expect(out).toContain('200 MB');
    expect(out).toContain('25%');
  });

  /**
   * The ratio is DERIVED here — the transcribed estimator computes
   * `realbloat` and never selects it, so the page divides. A zero-size index
   * would make that division meaningless, and an unmeasurable ratio must read
   * as absent rather than as a confident 0%.
   */
  it('renders a ratio it cannot compute as unknown, never as 0%', async () => {
    overrides.set('indexBloat', ok({
      indexes: [row({ indexBytes: 0, bloatBytes: 0 })], total: 1, truncated: false }));

    const out = await html();

    expect(out).toContain('—');
    expect(out).not.toContain('0%');
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('Infinity');
  });

  it('marks a primary key, for which dropping is not an option', async () => {
    overrides.set('indexBloat', ok({
      indexes: [row({ name: 'public.t_pkey', primary: true })], total: 1, truncated: false }));

    const out = await html();

    expect(out).toContain('primary key');
  });

  it('reports the true total when the list is capped', async () => {
    overrides.set('indexBloat', ok({ indexes: [row()], total: 17, truncated: true }));

    const out = await html();

    expect(out).toContain('Showing 1 of 17');
  });

  it('says nothing about truncation when the list is complete', async () => {
    overrides.set('indexBloat', ok({ indexes: [row()], total: 1, truncated: false }));

    const out = await html();

    expect(out).not.toContain('Showing');
  });

  /** An on-demand check must not acquire a poll by sitting on a page. */
  it('does not poll', async () => {
    const out = await html();
    expect(out).not.toContain('data-refresh');
    expect(out.toLowerCase()).not.toContain('refreshing');
  });

  /**
   * The estimate is an estimate. pgHero's own query reconstructs what an
   * index OUGHT to occupy from column statistics; saying so on the page is
   * the difference between an operator checking and an operator rebuilding a
   * 200 GB index on the strength of a number.
   */
  it('says the figure is an estimate', async () => {
    overrides.set('indexBloat', ok({ indexes: [row()], total: 1, truncated: false }));
    const out = await html();
    // The whole SENTENCE, as rendered text. `toContain('estimate')` also
    // matched the "Estimated bloat" column header, so the caveat could be
    // deleted outright with this test green — a mutation proved it. Asserting
    // the clause alone still allowed the noun to flip to "measurement",
    // which is the one word the sentence exists to say.
    void out;
    expect(rendered!.text()).toContain(
      'These figures are an estimate, reconstructed from column statistics rather than measured');
  });
});
