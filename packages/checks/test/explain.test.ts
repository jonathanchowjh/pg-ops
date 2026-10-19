import { describe, expect, it } from 'vitest';
import { relationsOf, type PlanNode } from '../src/tools/explain.js';

const scan = (schema: string, rel: string, plans: PlanNode[] = []): PlanNode =>
  ({ 'Node Type': 'Seq Scan', Schema: schema, 'Relation Name': rel, Plans: plans });

describe('relationsOf', () => {
  it('names every relation node once, schema-qualified and sorted', () => {
    const plan: PlanNode = {
      'Node Type': 'ModifyTable', Schema: 'public', 'Relation Name': 'users',
      Plans: [{ 'Node Type': 'Nested Loop', Plans: [scan('public', 'users'), scan('audit', 'log', [scan('public', 'dup_t')])] }],
    };
    expect(relationsOf(plan)).toEqual(['audit.log', 'public.dup_t', 'public.users']);
  });

  it('is empty for a statement on no table', () => {
    expect(relationsOf({ 'Node Type': 'Result' })).toEqual([]);
  });

  it('skips a node with a name and no schema: a function scan, a CTE', () => {
    const plan: PlanNode = { 'Node Type': 'CTE Scan', 'CTE Name': 'w', Plans: [{ 'Node Type': 'Function Scan', 'Function Name': 'generate_series' }] };
    expect(relationsOf(plan)).toEqual([]);
  });
});
