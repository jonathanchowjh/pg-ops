import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import TablePage from '@/app/db/[name]/tables/[relation]/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { overrides, calls, notFound } = vi.hoisted(() => ({
  overrides: new Map<string, unknown>(),
  calls: [] as { id: string; opts: unknown }[],
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));

const ok = (data: unknown, verdict: unknown = null) => ({ ok: true, data, verdict, measuredAt: 0 });

const TABLE = {
  name: 'public.orders', sizeBytes: 4096, liveRows: 10, deadRows: 2,
  seqScans: 1, idxScans: 9, hitRate: 0.99, lastVacuum: null, lastAnalyze: null,
};

const HEALTHY: Record<string, unknown> = {
  tableList: { tables: [TABLE], total: 1, truncated: false },
  autovacuumDanger: { relations: [{ relation: 'public.orders', xactAge: 100, txnsRemaining: 1 }], total: 1, truncated: false },
  indexList: { indexes: [], total: 0, truncated: false },
  unusedIndexes: { indexes: [], total: 0, truncated: false },
  duplicateIndexes: { pairs: [], total: 0, truncated: false },
  invalidIndexes: { indexes: [], total: 0, truncated: false },
  sequences: { sequences: [], total: 0, truncated: false, worstPctUsed: null, unreadable: 0 },
};

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_n: string, check: { id: string }, opts: unknown) => {
    calls.push({ id: check.id, opts });
    return overrides.get(check.id) ?? ok(HEALTHY[check.id] ?? {});
  }),
  runSeriesFor: vi.fn(async () => ({ ok: true, points: [] })),
}));

vi.mock('next/navigation', () => ({ notFound }));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount(); rendered = undefined;
  overrides.clear(); calls.length = 0; vi.clearAllMocks();
});

const html = async (relation = 'public.orders') => {
  const element = await TablePage({ params: Promise.resolve({ name: 'prod', relation }) });
  rendered = await render(element);
  return rendered.container.innerHTML;
};

describe('the table page', () => {
  /**
   * §5.2, and the reason the whole `relation` opt exists. Every check must be
   * ASKED about this relation. A page that ran the checks unfiltered and
   * picked its row out of the answer would show `—` for every fact about a
   * table that fell outside the cap — "we could not look" rendered for "we
   * did not ask".
   */
  it('asks every check about this relation, not for a list to filter', async () => {
    await html();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.opts, `check ${c.id}`).toMatchObject({ relation: 'public.orders' });
    }
  });

  it('is a 404 when the relation does not exist', async () => {
    overrides.set('tableList', ok({ tables: [], total: 0, truncated: false }));
    await expect(html('public.nope')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('says why a panel could not be read rather than rendering it empty', async () => {
    overrides.set('indexList', {
      ok: false, reason: 'privilege', message: 'permission denied for table pg_index',
    });
    expect(await html()).toContain('permission denied for table pg_index');
  });

  it('links back to the list it came from', async () => {
    expect(await html()).toContain('/db/prod/tables');
  });

  it('shows the relation name as the heading', async () => {
    rendered = await render(await TablePage({
      params: Promise.resolve({ name: 'prod', relation: 'public.orders' }),
    }));
    expect(rendered.text()).toContain('public.orders');
  });

  /**
   * An earlier version of this test locked in the OPPOSITE bug to the one it
   * meant to catch. `worstPctUsed`'s 90% threshold is PER SEQUENCE (the note
   * reads "N% of A COLUMN's range used"), so on a one-table page a real
   * `warn` is a true, actionable statement about that table's own column —
   * stripping it also silently deleted the page's only remediation text
   * ("widen the column"). The genuine defect is `sequences.ts`'s own
   * documented gap: `Verdict` has no third state, so when `worstPctUsed` is
   * null — no readable sequence exists to judge — the check's own `verdict`
   * function still returns `{ level: 'ok' }`, which is the absence of a
   * finding, not a claim the sequences are fine. Both halves are pinned here:
   * a vacuous `ok` shows no badge, and a real `warn` shows its note and its
   * guidance in full.
   */
  it('shows no badge for a vacuous sequence ok, but shows a real sequence warning in full', async () => {
    overrides.set('sequences', {
      ok: true,
      measuredAt: 0,
      data: { sequences: [], total: 0, truncated: false, unreadable: 0, worstPctUsed: null },
      verdict: { level: 'ok' },
    });
    await html();
    expect(rendered!.text()).not.toContain('OK');
    rendered!.unmount();

    overrides.set('sequences', {
      ok: true,
      measuredAt: 0,
      data: { sequences: [], total: 0, truncated: false, unreadable: 0, worstPctUsed: 97.5 },
      verdict: { level: 'warn', note: "97.50% of a column's range used" },
      crossed: {
        level: 'warn', value: 90, unit: 'percent',
        because: "the column overflows before the sequence's own maximum does",
        remedy: 'Widen the column.',
      },
    });

    const out = await html();

    expect(out).toContain("97.50% of a column's range used");
    expect(out).toContain('Why this matters');
    expect(out).toContain('Widen the column.');
  });
});
