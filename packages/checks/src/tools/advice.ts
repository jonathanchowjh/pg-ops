import type { CheckContext } from '../types.js';
// Type-only: explain.ts imports adviseOn from here, so a value import back would be a cycle.
import type { PlanNode } from './explain.js';
import { ownSql } from '../run.js';

/**
 * Index advice, read from the planner's plan rather than from a parse of the
 * statement as pgHero does. A plan names every relation it scans with its
 * own filter, so joins are advised on, and a statement an index already
 * serves shows no `Seq Scan` and gets no advice.
 *
 * The column choice is pgHero's heuristic, transcribed below so it diffs
 * against its source. The filters parsed here are Postgres's `ruleutils.c`
 * deparse; anything not recognised is skipped, so a surprise costs a missed
 * suggestion, not a wrong one.
 */

type Op = '=' | '<>' | '<' | '<=' | '>' | '>=' | '~~' | '~~*' | 'null' | 'not_null';
interface Conjunct { column: string; op: Op }
interface SortKey { column: string; direction: 'asc' | 'desc' }
/** One sequential scan the planner chose, and what it filtered and sorted by. */
export interface Scan { schema: string; table: string; where: Conjunct[]; sort: SortKey[] }

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = new RegExp(String.raw`^(?:(${IDENT})\.)?(${IDENT})$`);
// ruleutils prints a cast of a column as `(col)::type`.
const CAST = /^\((.+)\)::[^()]+$/;
const NULL_TEST = /^(.+) IS (NOT )?NULL$/;
// `= ANY (...)`, an IN list, arrives as `=` with an ANY right-hand side and
// counts as equality.
const COMPARISON = /^(.+?) (=|<>|<=|>=|<|>|~~\*|~~) (.+)$/;
const SORT_KEY = /^(.+?)( DESC)?(?: NULLS (?:FIRST|LAST))?$/;

function unquote(id: string): string {
  return id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id;
}

/** The column an expression names, or null when it is anything but a column of `alias`. */
function columnOf(expr: string, alias: string): string | null {
  const bare = CAST.exec(expr)?.[1] ?? expr;
  const m = QUALIFIED.exec(bare);
  if (!m) return null;
  if (m[1] !== undefined && unquote(m[1]) !== alias) return null;
  return unquote(m[2]!);
}

/**
 * Walk `s`, calling `at(i, depth)` at every character outside a string
 * literal or quoted identifier. `at` may return an index to resume from.
 */
function walk(s: string, at: (i: number, depth: number) => number | undefined): void {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote !== null) {
      if (ch === quote) {
        if (s[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    const resume = at(i, depth);
    if (resume !== undefined) i = resume;
  }
}

/** Remove one pair of parentheses, and only when it encloses the whole string. */
function unwrap(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith('(') || !s.endsWith(')')) return s;
  let closesEarly = false;
  walk(s, (i, depth) => {
    if (depth === 0 && i < s.length - 1) closesEarly = true;
    return undefined;
  });
  return closesEarly ? s : s.slice(1, -1).trim();
}

/** A deparsed `Filter`, split on its top-level ANDs, each part unwrapped. */
export function splitConjuncts(filter: string): string[] {
  const s = unwrap(filter);
  const parts: string[] = [];
  let start = 0;
  walk(s, (i, depth) => {
    if (depth !== 0 || !s.startsWith(' AND ', i)) return undefined;
    parts.push(s.slice(start, i));
    start = i + 5;
    return i + 4;
  });
  parts.push(s.slice(start));
  return parts.map(unwrap);
}

/** One conjunct as a column and an operator, or null when no simple index could serve it. */
export function parseConjunct(part: string, alias: string): Conjunct | null {
  const nullTest = NULL_TEST.exec(part);
  if (nullTest) {
    const column = columnOf(nullTest[1]!, alias);
    return column === null ? null : { column, op: nullTest[2] ? 'not_null' : 'null' };
  }
  const cmp = COMPARISON.exec(part);
  if (!cmp) return null;
  const column = columnOf(cmp[1]!, alias);
  return column === null ? null : { column, op: cmp[2] as Op };
}

/** A `Sort Key` list; empty if any key is not a plain column. */
export function parseSortKeys(keys: unknown, alias: string): SortKey[] {
  if (!Array.isArray(keys)) return [];
  const out: SortKey[] = [];
  for (const key of keys) {
    const m = typeof key === 'string' ? SORT_KEY.exec(key) : null;
    const column = m ? columnOf(m[1]!, alias) : null;
    if (column === null) return [];
    out.push({ column, direction: m![2] ? 'desc' : 'asc' });
  }
  return out;
}

function nodesOf(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
}

/**
 * Every `Seq Scan` in a plan, with its filter and, when it is the plan's
 * only scan, the sort above it. With two relations, whether an index would
 * serve the ORDER BY depends on a join order the planner may not pick.
 *
 * `Parallel Seq Scan` is `Seq Scan` with `"Parallel Aware": true` in JSON, so
 * it is included without a case of its own.
 */
export function scansOf(plan: PlanNode): Scan[] {
  const nodes = nodesOf(plan);
  const seqs = nodes.filter((n) => n['Node Type'] === 'Seq Scan' && typeof n['Relation Name'] === 'string');
  const onlyScan = nodes.filter((n) => n['Node Type'].endsWith('Scan')).length === 1;
  const sortNode = onlyScan ? nodes.find((n) => n['Node Type'] === 'Sort') : undefined;
  return seqs.map((n) => {
    const table = n['Relation Name'] as string;
    const alias = typeof n.Alias === 'string' ? n.Alias : table;
    return {
      schema: String(n.Schema),
      table,
      where: typeof n.Filter === 'string'
        ? splitConjuncts(n.Filter).map((p) => parseConjunct(p, alias)).filter((c): c is Conjunct => c !== null)
        : [],
      sort: sortNode ? parseSortKeys(sortNode['Sort Key'], alias) : [],
    };
  });
}

interface ColumnStats { nullFrac: number; nDistinct: number }
/** `columns` normalized to `column` or `column opclass` — see relationFacts. */
interface ExistingIndex { name: string; using: string; columns: string[] }
export interface RelationFacts { rows: number; columns: Map<string, ColumnStats>; indexes: ExistingIndex[] }

export interface IndexSuggestion {
  schema: string;
  table: string;
  using: 'btree' | 'gist';
  columns: string[];
  /**
   * The statement for the operator to run through their own migration
   * tooling. pgops never runs it. guards.test.ts allows this file in the DDL
   * guard for this string.
   */
  statement: string;
}

export interface IndexAdvice {
  schema: string;
  table: string;
  found: boolean;
  suggestion?: IndexSuggestion;
  /** An existing index already serves the suggestion; `found` stays true. */
  coveredBy?: string;
  explanation?: string;
  rows?: number;
  rowEstimates?: Record<string, number>;
  rowProgression?: number[];
}

// No `BETWEEN`: Postgres deparses it as two conjuncts.
const RANGE: ReadonlySet<Op> = new Set<Op>(['>', '>=', '<', '<=', '~~', '~~*']);
const LIKE: ReadonlySet<Op> = new Set<Op>(['~~', '~~*']);

/** pgHero's `row_estimates`, transcribed, approximations included. */
export function rowEstimate(stats: ColumnStats, totalRows: number, rowsLeft: number, op: Op | undefined): number {
  if (op === 'null') return rowsLeft * stats.nullFrac;
  if (op === 'not_null') return rowsLeft * (1 - stats.nullFrac);
  const left = rowsLeft * (1 - stats.nullFrac);
  let ret: number;
  if (stats.nDistinct === 0) ret = 0;
  else if (stats.nDistinct < 0) ret = totalRows > 0 ? (-1 / stats.nDistinct) * (left / totalRows) : 0;
  else ret = left / stats.nDistinct;
  if (op !== undefined && RANGE.has(op)) return (left + ret) / 10;
  if (op === '<>') return left - ret;
  return ret;
}

// Always quoted: a column named `order` or `user` must survive a paste.
const quoted = (id: string) => `"${id.replace(/"/g, '""')}"`;

function suggest(scan: Scan, using: 'btree' | 'gist', columns: string[]): IndexSuggestion {
  const keys = using === 'gist' ? `${quoted(columns[0]!)} gist_trgm_ops` : columns.map(quoted).join(', ');
  const method = using === 'gist' ? ' USING gist' : '';
  return {
    schema: scan.schema,
    table: scan.table,
    using,
    columns,
    statement: `CREATE INDEX CONCURRENTLY ON ${quoted(scan.schema)}.${quoted(scan.table)}${method} (${keys})`,
  };
}

/**
 * pgHero's covering rule: an existing index of the same method (or, with no
 * sort, any gist or brin, and hash when every condition is equality) whose
 * leading columns are the suggestion's.
 */
function coveringIndex(s: IndexSuggestion, scan: Scan, existing: readonly ExistingIndex[]): ExistingIndex | undefined {
  const methods = new Set<string>([s.using]);
  if (scan.sort.length === 0) {
    methods.add('gist');
    methods.add('brin');
    if (scan.where.every((c) => c.op === '=')) methods.add('hash');
  }
  const wanted = s.using === 'gist' ? s.columns.map((c) => `${c} gist_trgm_ops`) : s.columns;
  return existing.find((i) => methods.has(i.using) && wanted.every((c, k) => i.columns[k] === c));
}

function found(advice: IndexAdvice, scan: Scan, facts: RelationFacts, s: IndexSuggestion): IndexAdvice {
  const cover = coveringIndex(s, scan, facts.indexes);
  return cover
    ? {
      ...advice, found: true, suggestion: s, coveredBy: cover.name,
      explanation: `Covered by index on (${cover.columns.join(', ')})`,
    }
    : { ...advice, found: true, suggestion: s };
}

export const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * pgHero's `best_index_helper`, transcribed for one scan: the column order,
 * the 500-row floor, the stop at fewer than 50 rows or two columns or a range,
 * and the pruning of a trailing column that cuts less than 70%. Kept close to
 * its source so it diffs against it. The departures are the input (a plan,
 * not a parse tree) and an explanation where pgHero leaves one blank.
 */
export function chooseIndex(scan: Scan, facts: RelationFacts | undefined): IndexAdvice {
  const base: IndexAdvice = { schema: scan.schema, table: scan.table, found: false };
  if (scan.schema.startsWith('pg_') || scan.schema === 'information_schema') {
    return { ...base, explanation: 'System table' };
  }
  // Keyed operator first: an operator never contains a space, so the key is unambiguous.
  const seen = new Set<string>();
  const where = scan.where.filter((c) => {
    const k = `${c.op} ${c.column}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const columns = [...new Set([...where, ...scan.sort].map((c) => c.column))];
  if (columns.length === 0) return { ...base, explanation: 'No columns to index' };
  if (facts === undefined || !columns.every((c) => facts.columns.has(c))) {
    return { ...base, explanation: 'Stats not found' };
  }

  const total = facts.rows;
  const est = (c: { column: string; op?: Op }, left: number) =>
    rowEstimate(facts.columns.get(c.column)!, total, left, c.op);
  const firstDesc = scan.sort.findIndex((s) => s.direction === 'desc');
  const sort = firstDesc >= 0 ? scan.sort.slice(0, firstDesc + 1) : scan.sort;
  // A sort key has no operator: it estimates as equality, as in pgHero.
  const ordered: { column: string; op?: Op }[] = [
    ...[...where].sort((a, b) => est(a, total) - est(b, total) || byName(a.column, b.column)),
    ...sort.map((s) => ({ column: s.column })),
  ];
  const rowEstimates = Object.fromEntries(
    ordered.map((c) => [`${c.column} (${c.op ?? 'sort'})`, Math.round(est(c, total))]),
  );
  const advice: IndexAdvice = { ...base, rows: total, rowEstimates };
  if (total < 500) return { ...advice, explanation: 'No index needed if less than 500 rows' };

  const first = ordered[0]!;
  if (first.op !== undefined && LIKE.has(first.op)) {
    return found({ ...advice, rowProgression: [total, Math.round(est(first, total))] }, scan, facts,
      suggest(scan, 'gist', [first.column]));
  }

  let rowsLeft = total;
  const finalWhere: string[] = [];
  const progression = [rowsLeft];
  for (const c of ordered.filter((o) => o.op === undefined || !LIKE.has(o.op))) {
    if (finalWhere.includes(c.column)) continue;
    finalWhere.push(c.column);
    rowsLeft = est(c, rowsLeft);
    progression.push(rowsLeft);
    if (rowsLeft < 50 || finalWhere.length >= 2 || (c.op !== undefined && RANGE.has(c.op))) break;
  }
  const rowProgression = progression.map(Math.round);

  // Drop trailing columns that cut less than 70%.
  const reversed = [...progression].reverse();
  for (let i = 0; i < reversed.length - 1; i++) {
    if (reversed[i]! > reversed[i + 1]! * 0.3) finalWhere.pop();
    else break;
  }
  if (finalWhere.length === 0) {
    return { ...advice, rowProgression, explanation: 'No column narrows the rows enough to be worth an index' };
  }
  return found({ ...advice, rowProgression }, scan, facts, suggest(scan, 'btree', finalWhere));
}

const RELATIONS = 'unnest($1::text[], $2::text[]) AS r(schema, relname)';

// reltuples is -1 before the first ANALYZE on PG 14+; clamped to 0.
const ROWS_SQL = ownSql(`SELECT n.nspname::text AS schema, c.relname::text AS relname, greatest(c.reltuples, 0)::float8 AS rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN ${RELATIONS} ON r.schema = n.nspname AND r.relname = c.relname`);

// Not inherited: the scan is of this relation, not of its inheritance tree.
const STATS_SQL = ownSql(`SELECT s.schemaname::text AS schema, s.tablename::text AS relname, s.attname::text AS column,
       s.null_frac::float8 AS null_frac, s.n_distinct::float8 AS n_distinct
FROM pg_stats s
JOIN ${RELATIONS} ON r.schema = s.schemaname AND r.relname = s.tablename
WHERE NOT s.inherited`);

/**
 * Every valid, non-partial index on the relations named, one key column per
 * array element.
 *
 * The per-column `pg_get_indexdef(oid, k, true)` omits a non-default
 * opclass, so the opclass is joined from pg_opclass through `indclass`,
 * which is 0-based where `k` is 1-based. Invalid and partial indexes are
 * excluded: neither can be relied on to cover a suggestion.
 */
const INDEXES_SQL = ownSql(`SELECT n.nspname::text AS schema, t.relname::text AS relname, ic.relname::text AS name, am.amname::text AS using,
       array(SELECT pg_get_indexdef(i.indexrelid, k, true)
               FROM generate_series(1, i.indnkeyatts) k ORDER BY k) AS keys,
       array(SELECT CASE WHEN o.opcdefault THEN '' ELSE o.opcname::text END
               FROM generate_series(1, i.indnkeyatts) k
               JOIN pg_opclass o ON o.oid = i.indclass[k - 1]
              ORDER BY k) AS opclasses
FROM pg_index i
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_am am ON am.oid = ic.relam
JOIN ${RELATIONS} ON r.schema = n.nspname AND r.relname = t.relname
WHERE i.indisvalid AND i.indpred IS NULL`);

const WHOLE_IDENT = new RegExp(`^${IDENT}$`);
const keyOf = (schema: string, table: string) => JSON.stringify([schema, table]);

/** A key column as the covering rule compares it: unquoted, plus its opclass unless default or inet_ops. */
function normalize(key: string, opclass: string): string {
  const column = WHOLE_IDENT.test(key) ? unquote(key) : key;
  return opclass === '' || opclass === 'inet_ops' ? column : `${column} ${opclass}`;
}

async function relationFacts(
  ctx: CheckContext,
  relations: readonly { schema: string; table: string }[],
): Promise<Map<string, RelationFacts>> {
  const facts = new Map<string, RelationFacts>();
  if (relations.length === 0) return facts;
  const values = [relations.map((r) => r.schema), relations.map((r) => r.table)];
  const [rows, stats, indexes] = await Promise.all([
    ctx.target.query<{ schema: string; relname: string; rows: number }>(ROWS_SQL, values),
    ctx.target.query<{ schema: string; relname: string; column: string; null_frac: number; n_distinct: number }>(
      STATS_SQL, values,
    ),
    ctx.target.query<{ schema: string; relname: string; name: string; using: string; keys: string[]; opclasses: string[] }>(
      INDEXES_SQL, values,
    ),
  ]);
  for (const r of rows.rows) facts.set(keyOf(r.schema, r.relname), { rows: r.rows, columns: new Map(), indexes: [] });
  for (const s of stats.rows) {
    facts.get(keyOf(s.schema, s.relname))?.columns.set(s.column, { nullFrac: s.null_frac, nDistinct: s.n_distinct });
  }
  for (const i of indexes.rows) {
    facts.get(keyOf(i.schema, i.relname))?.indexes.push({
      name: i.name, using: i.using, columns: i.keys.map((k, n) => normalize(k, i.opclasses[n] ?? '')),
    });
  }
  return facts;
}

/**
 * Advice for every sequential scan in every plan, one array per plan, from
 * one catalog read (three queries) covering all the relations they name.
 */
export async function adviseOn(ctx: CheckContext, plans: readonly PlanNode[]): Promise<IndexAdvice[][]> {
  const scans = plans.map(scansOf);
  const relations = new Map(scans.flat().map((s) => [keyOf(s.schema, s.table), { schema: s.schema, table: s.table }]));
  const facts = await relationFacts(ctx, [...relations.values()]);
  return scans.map((list) => list.map((s) => chooseIndex(s, facts.get(keyOf(s.schema, s.table)))));
}
