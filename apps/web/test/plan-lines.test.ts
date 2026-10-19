import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanNode } from '@pgops/checks';
import { planLines } from '@/components/explain-form';

/**
 * Each case is one statement's `EXPLAIN (FORMAT JSON, VERBOSE)` and its
 * `EXPLAIN (VERBOSE)` text, captured together from Postgres 17. Only node
 * lines (the ones carrying a cost) are compared; detail lines are a subset by
 * design (no `Output:`) and are held by the hand-written cases at the foot.
 */
const CASES = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'plans-pg17.json'), 'utf8')) as
  { statement: string; json: PlanNode; text: string[] }[];

const nodeLines = (lines: string[]) => lines.filter((l) => l.includes('(cost='));

describe('planLines against real EXPLAIN output', () => {
  it.each(CASES.map((c) => [c.statement, c] as const))('%s', (_s, c) => {
    expect(nodeLines(planLines(c.json))).toEqual(nodeLines(c.text));
  });
});

describe('planLines', () => {
  it('renders a plan the way EXPLAIN text does', () => {
    expect(planLines({
      'Node Type': 'Limit', 'Startup Cost': 1, 'Total Cost': 2.5, 'Plan Rows': 5, 'Plan Width': 33,
      Plans: [{
        'Node Type': 'Index Scan', 'Index Name': 'orders_pkey', 'Relation Name': 'orders', Schema: 'public',
        Alias: 'o', 'Startup Cost': 0.29, 'Total Cost': 8.3, 'Plan Rows': 1, 'Plan Width': 33,
        'Index Cond': '(o.id = $1)', Filter: '(o.status = $2)',
        Plans: [{ 'Node Type': 'Result' }],
      }],
    })).toEqual([
      'Limit  (cost=1.00..2.50 rows=5 width=33)',
      '  ->  Index Scan using orders_pkey on public.orders o  (cost=0.29..8.30 rows=1 width=33)',
      '        Index Cond: (o.id = $1)',
      '        Filter: (o.status = $2)',
      '        ->  Result',
    ]);
  });
  it('joins array-valued details, and omits an alias equal to the relation', () => {
    expect(planLines({ 'Node Type': 'Seq Scan', 'Relation Name': 't', Schema: 's', Alias: 't', 'Sort Key': ['a DESC', 'b'] }))
      .toEqual(['Seq Scan on s.t', '  Sort Key: a DESC, b']);
  });
});
