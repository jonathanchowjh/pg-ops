import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUGGESTION_DEFAULTS } from '@pgops/checks';
import { render, type Rendered } from './render.js';
import Suggested from '@/app/db/[name]/queries/indexes/suggested/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { result } = vi.hoisted(() => ({ result: { current: undefined as unknown } }));

vi.mock('@/lib/check', () => ({
  runToolFor: vi.fn(async () => result.current),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => 'indexes',
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.clearAllMocks();
});

const show = async () => {
  const element = await Suggested({ params: Promise.resolve({ name: 'prod' }) });
  rendered = await render(element);
  return rendered;
};

const ok = (data: unknown) => ({ ok: true, data, verdict: null, measuredAt: 0 });
const suggestion = (columns: string[]) => ({
  schema: 'public', table: 'orders', using: 'btree', columns,
  statement: `CREATE INDEX CONCURRENTLY ON "public"."orders" (${columns.map((c) => `"${c}"`).join(', ')})`,
});
const data = (over: Record<string, unknown> = {}) => ({
  indexes: [], byQuery: [], examined: 12, totalShapes: 12, statsResetAt: null, ...over,
});

describe('the suggested indexes page', () => {
  it('shows each index as the statement to run, with the queries that want it', async () => {
    result.current = ok(data({
      indexes: [{ ...suggestion(['customer_id']), queries: [
        { queryid: '42', query: 'SELECT * FROM orders WHERE customer_id = $1' },
        { queryid: null, query: "ALTER USER app PASSWORD 'hunter2'" },
      ] }],
    }));
    const r = await show();
    expect(r.text()).toContain('CREATE INDEX CONCURRENTLY ON "public"."orders" ("customer_id")');
    expect(r.text()).toContain('SELECT * FROM orders WHERE customer_id = $1');
    expect(r.container.innerHTML).toContain('/db/prod/queries/42');
    // Every query renders through <Sql>, which redacts.
    expect(r.text()).not.toContain('hunter2');
  });

  it('names the thresholds when nothing is suggested, rather than calling the database clean', async () => {
    result.current = ok(data({ byQuery: [{ queryid: '1', query: 'SELECT 1', calls: 60, meanMs: 30, advice: [] }] }));
    const r = await show();
    expect(r.text()).toContain(`No index suggested for the 1 shape planned over ${SUGGESTION_DEFAULTS.minMeanMs} ms and ${SUGGESTION_DEFAULTS.minCalls} calls`);
    expect(r.text()).not.toContain('could not be planned');
  });

  /**
   * With the README's least-privilege role every shape fails to plan, and
   * "no index suggested for 40 shapes" would read as forty shapes checked and
   * found fine. Only the shapes actually planned can have been cleared.
   */
  it('counts only planned shapes as cleared, and says how many were not planned', async () => {
    const denied = (id: string) => ({ queryid: id, query: `SELECT ${id}`, calls: 60, meanMs: 30,
      error: 'permission denied for table orders.', advice: [] });
    result.current = ok(data({ byQuery: [denied('1'), denied('2'),
      { queryid: '3', query: 'SELECT 3', calls: 60, meanMs: 30, advice: [] }] }));
    const r = await show();
    expect(r.text()).toContain(`No index suggested for the 1 shape planned over ${SUGGESTION_DEFAULTS.minMeanMs} ms`);
    expect(r.text()).toContain('2 shapes could not be planned');
  });

  it('lists every shape examined, with its error or its advice', async () => {
    result.current = ok(data({
      byQuery: [
        { queryid: '1', query: 'SET application_name = $1', calls: 60, meanMs: 30, error: 'syntax error at or near "SET"', advice: [] },
        { queryid: '2', query: 'SELECT * FROM tiny WHERE v = $1', calls: 60, meanMs: 30,
          advice: [{ schema: 'public', table: 'tiny', found: false, explanation: 'No index needed if less than 500 rows' }] },
      ],
      examined: 100, totalShapes: 4_000,
    }));
    const r = await show();
    const details = r.container.querySelector('details')!;
    expect(details.textContent).toContain('Shapes examined (2)');
    // What was NOT read is said, so "examined" is not taken for "all of them".
    expect(details.textContent).toContain('Read the 100 busiest of 4,000 shapes by total time; 2 cleared the thresholds.');
    expect(details.innerHTML).toContain('/db/prod/queries/2');
    expect(details.textContent).toContain('syntax error at or near "SET"');
    expect(details.textContent).toContain('No index needed if less than 500 rows');
  });

  /**
   * AN AGE, NOT A TIMESTAMP. This page printed
   * `2026-09-20 10:00:00+00` — a claim about a clock the server cannot see,
   * to a precision no operator has ever wanted from a statistics reset. The
   * clock is pinned here because the rendered string is now relative to it.
   */
  it('names the window it read — live statistics since the last reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T10:00:00Z'));
    try {
      result.current = ok(data({ statsResetAt: '2026-09-20 10:00:00+00' }));
      const r = await show();
      expect(r.text()).toContain('since statistics were last reset');
      expect(r.text()).toContain('2d ago');
      expect(r.text()).not.toContain('2026-09-20');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a missing extension as the panel renders any failure, remedy included', async () => {
    result.current = { ok: false, reason: 'missing-extension', message: 'relation "pg_stat_statements" does not exist',
      remedy: 'CREATE EXTENSION pg_stat_statements;' };
    const r = await show();
    expect(r.text()).toContain('Unavailable — missing-extension');
    expect(r.text()).toContain('CREATE EXTENSION pg_stat_statements;');
  });
});
