import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Space from '@/app/db/[name]/cleanup/space/page';
import Maintenance from '@/app/db/[name]/cleanup/maintenance/page';
import Sequences from '@/app/db/[name]/cleanup/sequences/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { overrides } = vi.hoisted(() => ({ overrides: new Map<string, unknown>() }));

const ok = (data: unknown, verdict: unknown = null) => ({ ok: true, data, verdict, measuredAt: 0 });

const HEALTHY: Record<string, unknown> = {
  databaseSize: { sizeBytes: 8_589_934_592 },
  relationSizes: { relations: [], total: 0, truncated: false },
  // `relations`, not `tables`. TableSizeData names it `relations` even
  // though the check lists only relkind 'r' — and the first draft of this
  // fixture said `tables`, which no test could catch: the mock IS the shape,
  // so a page reading a field the check never returns renders happily here.
  // Only `npm run --workspace @pgops/web typecheck` sees it.
  tableSizes: { relations: [], total: 0, truncated: false },
  tableStats: { tables: [], total: 0, truncated: false },
  autovacuumDanger: { relations: [], total: 0, truncated: false },
  vacuumProgress: { vacuums: [] },
  sequences: { sequences: [], total: 0, truncated: false, unreadable: 0, worstPctUsed: null },
};

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) =>
    overrides.get(check.id) ?? ok(HEALTHY[check.id] ?? {})),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => 'space',
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered = undefined;
  overrides.clear();
  vi.clearAllMocks();
});

type Page = (props: { params: Promise<{ name: string }> }) => Promise<React.ReactElement>;

const show = async (page: Page) => {
  const element = await page({ params: Promise.resolve({ name: 'prod' }) });
  rendered = await render(element);
  return rendered;
};

describe('/cleanup/space', () => {
  /**
   * §3's divergence, held at the surface it exists for. The checks return
   * BYTES where pgHero returns `pretty_size(...)` strings, precisely so the
   * numbers can be thresholded, summed and charted — which only pays off if
   * formatting happens here. Asserting the raw digits are ABSENT is the half
   * that catches a page rendering `{d.sizeBytes}` next to a formatted sibling.
   */
  it('formats bytes at the edge and never prints the raw count', async () => {
    const r = await show(Space);
    expect(r.text()).toContain('8 GB');
    expect(r.text()).not.toContain('8589934592');
  });

  it('says why a check could not run instead of rendering it empty', async () => {
    overrides.set('relationSizes', {
      ok: false, reason: 'privilege', message: 'permission denied for table pg_class',
    });
    const r = await show(Space);
    expect(r.text()).toContain('permission denied for table pg_class');
  });

  /**
   * The tableSizes panel with rows in it, which the empty fixture could not
   * exercise: an empty list renders the same whatever field the page reads,
   * so a page reading `d.tables` from a check that returns `d.relations`
   * passed every test here until the typecheck said otherwise.
   */
  it('renders the largest tables from the field the check actually returns', async () => {
    overrides.set('tableSizes', ok({
      relations: [{ name: 'public.orders', sizeBytes: 2_147_483_648 }],
      total: 1, truncated: false,
    }));
    const r = await show(Space);
    expect(r.text()).toContain('public.orders');
    expect(r.text()).toContain('2 GB');
  });

  it('renders a real relation size formatted, not as digits', async () => {
    overrides.set('relationSizes', ok({
      relations: [{ name: 'public.events', type: 'table', sizeBytes: 3_221_225_472 }],
      total: 1, truncated: false,
    }));
    const r = await show(Space);
    expect(r.text()).toContain('3 GB');
    expect(r.text()).not.toContain('3221225472');
  });
});

describe('/cleanup/maintenance', () => {
  /**
   * `null` is "never vacuumed", which is the finding on a keep-up page. A
   * blank cell is indistinguishable from a column the page forgot to render.
   */
  it('renders a never-vacuumed table as never, not as a blank cell', async () => {
    overrides.set('tableStats', ok({
      tables: [{
        table: 'public.forgotten', liveRows: 5_000, deadRows: 4_000,
        lastVacuum: null, lastAutovacuum: null, lastAnalyze: null, lastAutoanalyze: null,
      }],
      total: 1, truncated: false,
    }));
    const r = await show(Maintenance);
    expect(r.text()).toContain('public.forgotten');
    expect(r.text()).toContain('never');
  });

  it('says no vacuum is running rather than showing an empty table', async () => {
    const r = await show(Maintenance);
    expect(r.text()).toContain('No vacuum is running');
  });

  it('reports a running vacuum with its progress', async () => {
    overrides.set('vacuumProgress', ok({
      vacuums: [{
        pid: 4242, phase: 'scanning heap', relation: 'public.big',
        blksTotal: 1000, blksScanned: 400, pctScanned: 40,
      }],
    }));
    const r = await show(Maintenance);
    expect(r.text()).toContain('public.big');
    expect(r.text()).toContain('40%');
    expect(r.text()).toContain('scanning heap');
  });

  /**
   * A vacuum in the `initializing` phase reports `heap_blks_total = 0`, and
   * `pctScanned` is null for it. `0%` would say the vacuum is stuck; this is
   * the most likely vacuum for an operator to be looking at.
   */
  it('renders an unknown vacuum progress as not yet known, never as 0%', async () => {
    overrides.set('vacuumProgress', ok({
      vacuums: [{
        pid: 7, phase: 'initializing', relation: 'public.t',
        blksTotal: 0, blksScanned: 0, pctScanned: null,
      }],
    }));
    const r = await show(Maintenance);
    expect(r.text()).not.toContain('0%');
    expect(r.text()).toContain('not yet known');
  });

  /**
   * Ruling 1: #44 `wraparound` owns the alarm and reads the database-wide
   * `datfrozenxid`, the minimum over every relation. Two badges on one fact
   * would disagree the moment either set of numbers was tuned.
   */
  it('renders no verdict badge on the per-relation xid list', async () => {
    overrides.set('autovacuumDanger', ok({
      relations: [{ relation: 'public.t', xactAge: 1_000, txnsRemaining: 2_147_482_647 }],
      total: 1, truncated: false,
    }));
    const r = await show(Maintenance);
    // VerdictBadge's own labels, matched exactly — it renders `OK`, `WARN` or
    // `CRITICAL` as text precisely so colour is never the only signal, which
    // makes the text the thing to assert on. `runCheck` yields
    // `verdict: null` for a check with no `verdict`, so a badge here could
    // only come from the page synthesising one of its own.
    expect(r.text()).not.toContain('CRITICAL');
    expect(r.text()).not.toContain('WARN');
    expect(r.text()).not.toContain('OK');
  });

  /**
   * The other half, and the one that makes the assertion above falsifiable:
   * a check that DOES judge still shows its badge on this page. Without it,
   * "renders no badge" would also pass on a page that dropped CheckPanel's
   * badge entirely.
   */
  it('still shows a badge for a check that does carry a verdict', async () => {
    overrides.set('tableStats', ok({ tables: [], total: 0, truncated: false },
      { level: 'critical', note: 'invented for this test' }));
    const r = await show(Maintenance);
    expect(r.text()).toContain('CRITICAL');
  });
});

describe('/cleanup/sequences', () => {
  /**
   * The check's whole point. A bare `93%` is meaningless without the ceiling
   * it is a percentage OF — the same sequence is 93% of an integer column and
   * 0.0000002% of a bigint one, and the second is not a problem.
   */
  it('names the column type beside the percentage', async () => {
    overrides.set('sequences', ok({
      sequences: [{
        name: 'public.orders_id_seq', table: 'public.orders', column: 'id',
        columnType: 'integer', maxValue: 2_147_483_647, lastValue: 2_000_000_000,
        pctUsed: 93.1, readable: true,
      }],
      total: 1, truncated: false, unreadable: 0, worstPctUsed: 93.1,
    }));
    const r = await show(Sequences);
    expect(r.text()).toContain('93.1%');
    expect(r.text()).toContain('integer');
  });

  it('renders an unreadable sequence as unreadable, never as 0%', async () => {
    overrides.set('sequences', ok({
      sequences: [{
        name: 'public.hidden_seq', table: null, column: null, columnType: null,
        maxValue: 9_223_372_036_854_776_000, lastValue: null, pctUsed: null, readable: false,
      }],
      total: 1, truncated: false, unreadable: 1, worstPctUsed: null,
    }));
    const r = await show(Sequences);
    expect(r.text()).toContain('not readable');
    expect(r.text()).not.toMatch(/\b0(\.0)?%/);
  });

  it('distinguishes a readable sequence nothing has called from an unreadable one', async () => {
    overrides.set('sequences', ok({
      sequences: [{
        name: 'public.fresh_seq', table: 'public.t', column: 'id', columnType: 'integer',
        maxValue: 2_147_483_647, lastValue: 1, pctUsed: null, readable: true,
      }],
      total: 1, truncated: false, unreadable: 0, worstPctUsed: null,
    }));
    const r = await show(Sequences);
    expect(r.text()).toContain('never used');
    expect(r.text()).not.toContain('not readable');
  });

  it('explains the unreadable count in terms of the privilege that would fix it', async () => {
    overrides.set('sequences', ok({
      sequences: [], total: 0, truncated: false, unreadable: 3, worstPctUsed: null,
    }));
    const r = await show(Sequences);
    expect(r.text()).toContain('3');
    expect(r.text()).toContain('role');
    // The two privileges by name. Postgres exposes last_value to SELECT *or*
    // USAGE, so naming only one would send an operator to grant the wrong
    // thing — and "check your permissions" would not be advice at all.
    expect(r.text()).toContain('select or usage');
  });

  it('says nothing about unreadable sequences when there are none', async () => {
    const r = await show(Sequences);
    expect(r.text()).not.toMatch(/could not be read/i);
  });
});

describe('every cleanup sub-route', () => {
  const PAGES: ReadonlyArray<[string, Page]> = [
    ['space', Space as Page],
    ['maintenance', Maintenance as Page],
    ['sequences', Sequences as Page],
  ];

  it.each(PAGES)('%s carries the sub-navigation back to the tab', async (_n, page) => {
    const hrefs = [...(await show(page)).container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('/db/prod/cleanup');
    expect(hrefs).toContain('/db/prod/cleanup/space');
    expect(hrefs).toContain('/db/prod/cleanup/maintenance');
    expect(hrefs).toContain('/db/prod/cleanup/sequences');
  });

  /**
   * None of these polls. They run catalog scans on visit, and guards.test.ts
   * holds the same fact from the source side — this is the rendered half: no
   * <Refresh> control mounted anywhere on the page.
   */
  it.each(PAGES)('%s does not poll', async (_n, page) => {
    const r = await show(page);
    const buttons = [...r.container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).not.toContain('Refresh');
  });
});
