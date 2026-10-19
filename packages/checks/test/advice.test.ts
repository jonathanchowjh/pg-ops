import { describe, expect, it } from 'vitest';
import {
  chooseIndex, parseConjunct, parseSortKeys, rowEstimate, scansOf, splitConjuncts,
  type IndexAdvice, type RelationFacts, type Scan,
} from '../src/tools/advice.js';
import { groupSuggestions } from '../src/tools/suggested-indexes.js';
import type { PlanNode } from '../src/tools/explain.js';

describe('splitConjuncts', () => {
  it('splits a top-level AND and unwraps each part', () => {
    expect(splitConjuncts("((o.customer_id = 42) AND (o.status = 'paid'::text))"))
      .toEqual(['o.customer_id = 42', "o.status = 'paid'::text"]);
  });
  it('unwraps a single condition', () => {
    expect(splitConjuncts("(status = 'new'::text)")).toEqual(["status = 'new'::text"]);
  });
  it('leaves a single cast condition whole', () => {
    expect(splitConjuncts("((status)::text = 'x'::text)")).toEqual(["(status)::text = 'x'::text"]);
  });
  it('does not split inside a string literal or a nested OR', () => {
    expect(splitConjuncts("((a = 'x AND y'::text) AND ((b = 1) OR (c = 2)))"))
      .toEqual(["a = 'x AND y'::text", '(b = 1) OR (c = 2)']);
  });
  // The literal must sit at depth 0 for quote tracking to matter: inside a
  // conjunct's own parentheses, depth alone protects it.
  it('does not split a literal at depth 0', () => {
    expect(splitConjuncts("(a = 'x AND y'::text)")).toEqual(["a = 'x AND y'::text"]);
  });
  it('does not let a parenthesis inside a literal move the depth', () => {
    expect(splitConjuncts("((a = 'x) AND (y'::text) AND (b = 1))")).toEqual(["a = 'x) AND (y'::text", 'b = 1']);
  });
  // Unwrapping `(a = 1) OR (b = 2)` without checking that the first paren
  // encloses the whole string yields `a = 1) OR (b = 2`, which parses as an
  // equality on `a` — a suggestion for a filter an index on `a` cannot serve.
  it('leaves a lone OR whole', () => {
    expect(splitConjuncts('((a = 1) OR (b = 2))')).toEqual(['(a = 1) OR (b = 2)']);
  });
  it('survives a doubled quote inside a literal', () => {
    expect(splitConjuncts("((a = 'it''s AND'::text) AND (b = 1))")).toEqual(["a = 'it''s AND'::text", 'b = 1']);
  });
  it('does not split inside a quoted identifier', () => {
    expect(splitConjuncts('(("x AND y" = 1) AND (b = 1))')).toEqual(['"x AND y" = 1', 'b = 1']);
  });
});

describe('parseConjunct', () => {
  it.each([
    ['o.customer_id = 42', { column: 'customer_id', op: '=' }],
    ['customer_id = $1', { column: 'customer_id', op: '=' }],
    ["(o.status)::text = 'x'::text", { column: 'status', op: '=' }],
    ["customer_id = ANY ('{1,2,3}'::integer[])", { column: 'customer_id', op: '=' }],
    ['o.created_at >= $2', { column: 'created_at', op: '>=' }],
    ['o.created_at <> $2', { column: 'created_at', op: '<>' }],
    ['email ~~ $3', { column: 'email', op: '~~' }],
    ['email ~~* $3', { column: 'email', op: '~~*' }],
    ['email IS NULL', { column: 'email', op: 'null' }],
    ['o.email IS NOT NULL', { column: 'email', op: 'not_null' }],
    ['o."Mixed Case" = 1', { column: 'Mixed Case', op: '=' }],
    ['"o".id = 1', { column: 'id', op: '=' }],
  ])('%s', (part, expected) => {
    expect(parseConjunct(part, 'o')).toEqual(expected);
  });

  it.each([
    ["lower(email) = 'x'::text"], // an expression, not a column
    ['(b = 1) OR (c = 2)'], // a disjunction
    ['other.customer_id = 1'], // qualified by a different alias
    ['email !~~ $1'], // NOT LIKE: no index serves it
    ['42 = customer_id'], // constant on the left: pgHero does not read it either
  ])('skips %s', (part) => {
    expect(parseConjunct(part, 'o')).toBeNull();
  });
});

describe('parseSortKeys', () => {
  it('reads direction and drops NULLS placement', () => {
    expect(parseSortKeys(['o.created_at DESC NULLS LAST', 'id'], 'o'))
      .toEqual([{ column: 'created_at', direction: 'desc' }, { column: 'id', direction: 'asc' }]);
  });
  it('drops every key if any key is an expression — pgHero rescues to []', () => {
    expect(parseSortKeys(['lower(email)', 'id'], 'o')).toEqual([]);
  });
  it('treats a missing Sort Key as no sort', () => {
    expect(parseSortKeys(undefined, 'o')).toEqual([]);
  });
});

const seq = (over: Partial<PlanNode>): PlanNode => ({
  'Node Type': 'Seq Scan', 'Relation Name': 'orders', Schema: 'public', Alias: 'orders', ...over,
});

describe('scansOf', () => {
  it('reads the filter and the sort of a single-table plan', () => {
    const plan: PlanNode = {
      'Node Type': 'Limit',
      Plans: [{
        'Node Type': 'Sort',
        'Sort Key': ['orders.created_at DESC'],
        Plans: [seq({ Filter: '((orders.customer_id = 42) AND (orders.status = $1))' })],
      }],
    };
    expect(scansOf(plan)).toEqual([{
      schema: 'public', table: 'orders',
      where: [{ column: 'customer_id', op: '=' }, { column: 'status', op: '=' }],
      sort: [{ column: 'created_at', direction: 'desc' }],
    }]);
  });

  it('advises on every relation of a join, and on no sort', () => {
    const plan: PlanNode = {
      'Node Type': 'Sort',
      'Sort Key': ['o.id'],
      Plans: [{
        'Node Type': 'Hash Join',
        Plans: [
          seq({ Alias: 'o', Filter: "(o.status = 'new'::text)" }),
          { 'Node Type': 'Hash', Plans: [seq({ 'Relation Name': 'customers', Alias: 'c', Filter: "(c.region = 'r3'::text)" })] },
        ],
      }],
    };
    const scans = scansOf(plan);
    expect(scans.map((s) => [s.table, s.where])).toEqual([
      ['orders', [{ column: 'status', op: '=' }]],
      ['customers', [{ column: 'region', op: '=' }]],
    ]);
    expect(scans.every((s) => s.sort.length === 0)).toBe(true);
  });

  it('reads nothing from a disjunction', () => {
    expect(scansOf(seq({ Filter: '((orders.a = 1) OR (orders.b = 2))' }))[0]!.where).toEqual([]);
  });

  it('keeps a scan with no filter — "No columns to index" is an answer', () => {
    expect(scansOf(seq({}))).toEqual([{ schema: 'public', table: 'orders', where: [], sort: [] }]);
  });

  it('ignores index scans: the planner already found an index', () => {
    expect(scansOf({ 'Node Type': 'Index Scan', 'Relation Name': 'orders', Schema: 'public' })).toEqual([]);
  });
});

const facts = (
  rows: number, cols: Record<string, readonly [number, number]>, indexes: RelationFacts['indexes'] = [],
): RelationFacts => ({
  rows,
  indexes,
  columns: new Map(Object.entries(cols).map(([c, [nullFrac, nDistinct]]) => [c, { nullFrac, nDistinct }])),
});
const scanOf = (where: [string, string][], sort: [string, 'asc' | 'desc'][] = []): Scan => ({
  schema: 'public',
  table: 'orders',
  where: where.map(([column, op]) => ({ column, op: op as never })),
  sort: sort.map(([column, direction]) => ({ column, direction })),
});
// null_frac, n_distinct — shaped like the measured orders table.
const ORDERS = {
  status: [0, 4], customer_id: [0, 5000], created_at: [0, -1], email: [0.1, -1], a: [0, 100], b: [0, 2], c: [0, 50],
} as const;

describe('rowEstimate — pgHero row_estimates, verbatim', () => {
  const s = { nullFrac: 0, nDistinct: 4 };
  it('divides by n_distinct for equality', () => expect(rowEstimate(s, 100_000, 100_000, '=')).toBe(25_000));
  it('takes a tenth for a range', () => expect(rowEstimate(s, 100_000, 100_000, '>')).toBe(12_500));
  it('subtracts for inequality', () => expect(rowEstimate(s, 100_000, 100_000, '<>')).toBe(75_000));
  it('reads a negative n_distinct as a fraction of the rows', () =>
    expect(rowEstimate({ nullFrac: 0, nDistinct: -1 }, 100_000, 100_000, '=')).toBe(1));
  it('uses null_frac for IS NULL and IS NOT NULL', () => {
    expect(rowEstimate({ nullFrac: 0.1, nDistinct: 4 }, 100, 100, 'null')).toBe(10);
    expect(rowEstimate({ nullFrac: 0.1, nDistinct: 4 }, 100, 100, 'not_null')).toBe(90);
  });
  it('discounts nulls before an equality', () =>
    expect(rowEstimate({ nullFrac: 0.5, nDistinct: 4 }, 100, 100, '=')).toBe(12.5));
});

describe('chooseIndex', () => {
  it('stops at a column that leaves fewer than 50 rows', () => {
    const a = chooseIndex(scanOf([['status', '='], ['customer_id', '=']]), facts(100_000, ORDERS));
    expect(a.found).toBe(true);
    expect(a.suggestion?.columns).toEqual(['customer_id']);
    expect(a.suggestion?.statement).toBe('CREATE INDEX CONCURRENTLY ON "public"."orders" ("customer_id")');
    expect(a.rowProgression).toEqual([100_000, 20]);
  });

  it('stops at a range condition', () => {
    const a = chooseIndex(scanOf([['status', '='], ['created_at', '>']]), facts(100_000, ORDERS));
    expect(a.suggestion?.columns).toEqual(['created_at']);
  });

  it('keeps a second column when it cuts the remaining rows by at least 70%', () => {
    // a: 100,000 → 1,000; c: 1,000 → 20.
    expect(chooseIndex(scanOf([['a', '='], ['c', '=']]), facts(100_000, ORDERS)).suggestion?.columns)
      .toEqual(['a', 'c']);
  });

  it('prunes a second column that cuts by less than 70%', () => {
    // a: 100,000 → 1,000; b: 1,000 → 500, and 500 > 1,000 × 0.3.
    const got = chooseIndex(scanOf([['a', '='], ['b', '=']]), facts(100_000, ORDERS));
    expect(got.suggestion?.columns).toEqual(['a']);
    expect(got.rowProgression).toEqual([100_000, 1000, 500]);
  });

  it('suggests a trigram gist index when the most selective condition is a LIKE', () => {
    const a = chooseIndex(scanOf([['email', '~~']]), facts(100_000, ORDERS));
    expect(a.suggestion).toMatchObject({ using: 'gist', columns: ['email'] });
    expect(a.suggestion?.statement)
      .toBe('CREATE INDEX CONCURRENTLY ON "public"."orders" USING gist ("email" gist_trgm_ops)');
  });

  it('serves a sort, truncated after its first descending key', () => {
    const a = chooseIndex(scanOf([], [['created_at', 'desc'], ['id', 'asc']]), facts(100_000, { ...ORDERS, id: [0, -1] }));
    expect(a.rowEstimates).toEqual({ 'created_at (sort)': 1 });
    expect(a.suggestion?.columns).toEqual(['created_at']);
  });

  it('quotes every identifier in the statement it hands over', () => {
    const a = chooseIndex({ ...scanOf([['we"ird', '=']]), schema: 'My Schema' }, facts(100_000, { 'we"ird': [0, 5000] }));
    expect(a.suggestion?.statement).toBe('CREATE INDEX CONCURRENTLY ON "My Schema"."orders" ("we""ird")');
  });

  it.each([
    ['No columns to index', scanOf([]), facts(100_000, ORDERS)],
    ['Stats not found', scanOf([['status', '=']]), facts(100_000, {})],
    ['Stats not found', scanOf([['status', '=']]), undefined],
    ['No index needed if less than 500 rows', scanOf([['status', '=']]), facts(499, ORDERS)],
  ] as const)('explains itself: %s', (explanation, s, f) => {
    expect(chooseIndex(s, f)).toMatchObject({ found: false, explanation });
  });

  it('never advises on a system catalog', () => {
    expect(chooseIndex({ ...scanOf([['relname', '=']]), schema: 'pg_catalog' }, facts(100_000, {})))
      .toMatchObject({ found: false, explanation: 'System table' });
  });

  it('reports an existing btree index whose leading columns match as covering', () => {
    const a = chooseIndex(scanOf([['customer_id', '=']]), facts(100_000, ORDERS,
      [{ name: 'orders_customer_id_status_idx', using: 'btree', columns: ['customer_id', 'status'] }]));
    expect(a).toMatchObject({ found: true, coveredBy: 'orders_customer_id_status_idx' });
    expect(a.explanation).toBe('Covered by index on (customer_id, status)');
  });

  it('does not count an index whose columns merely include the suggestion', () => {
    const a = chooseIndex(scanOf([['customer_id', '=']]), facts(100_000, ORDERS,
      [{ name: 'x', using: 'btree', columns: ['status', 'customer_id'] }]));
    expect(a.coveredBy).toBeUndefined();
  });

  it('does not let a trigram index cover a btree suggestion', () => {
    const a = chooseIndex(scanOf([['customer_id', '=']]), facts(100_000, ORDERS,
      [{ name: 'g', using: 'gist', columns: ['customer_id gist_trgm_ops'] }]));
    expect(a.coveredBy).toBeUndefined();
  });

  it('lets a trigram index cover a trigram suggestion', () => {
    const a = chooseIndex(scanOf([['email', '~~']]), facts(100_000, ORDERS,
      [{ name: 'g', using: 'gist', columns: ['email gist_trgm_ops'] }]));
    expect(a.coveredBy).toBe('g');
  });

  it('lets a hash index cover equality-only conditions, and nothing with a sort', () => {
    const hash = [{ name: 'h', using: 'hash', columns: ['customer_id'] }];
    expect(chooseIndex(scanOf([['customer_id', '=']]), facts(100_000, ORDERS, hash)).coveredBy).toBe('h');
    expect(chooseIndex(scanOf([['customer_id', '=']], [['created_at', 'asc']]), facts(100_000, ORDERS, hash)).coveredBy)
      .toBeUndefined();
    expect(chooseIndex(scanOf([['customer_id', '='], ['status', '<>']]), facts(100_000, ORDERS, hash)).coveredBy)
      .toBeUndefined();
  });
});

describe('groupSuggestions — pgHero suggested_indexes over suggested_indexes_by_query', () => {
  const s = (cols: string[]) => ({
    schema: 'public', table: 'orders', using: 'btree' as const, columns: cols,
    statement: `CREATE INDEX CONCURRENTLY ON "public"."orders" (${cols.map((c) => `"${c}"`).join(', ')})`,
  });
  const q = (id: string, advice: IndexAdvice[]) => ({ queryid: id, query: `q${id}`, calls: 1, meanMs: 1, advice });
  const at = { schema: 'public', table: 'orders' };

  it('groups queries by the index they want, and drops covered and not-found advice', () => {
    const got = groupSuggestions([
      q('1', [{ ...at, found: true, suggestion: s(['b']) }]),
      q('2', [{ ...at, found: true, suggestion: s(['a']) }]),
      q('3', [{ ...at, found: true, suggestion: s(['a']) }]),
      q('4', [{ ...at, found: true, suggestion: s(['c']), coveredBy: 'x' }]),
      q('5', [{ ...at, found: false, explanation: 'Stats not found' }]),
    ]);
    expect(got.map((g) => [g.columns, g.queries.map((x) => x.queryid)]))
      .toEqual([[['a'], ['2', '3']], [['b'], ['1']]]);
  });

  it('lists a query once even when two of its scans want the same index', () => {
    const got = groupSuggestions([q('1', [{ ...at, found: true, suggestion: s(['a']) }, { ...at, found: true, suggestion: s(['a']) }])]);
    expect(got[0]!.queries).toHaveLength(1);
  });
});
