# Tables in Explore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first vertical slice of the Explore object layer — one
sortable, filterable, searchable Tables list, and a Table page that gathers
everything pgops knows about one relation.

**Architecture:** A new `tableList` check is the table inventory the console
has never had (the `indexes` area has had `indexList` since parity; the
`tables` area has four findings and no inventory). It produces every column
the list sorts on from ONE query with a closed `ORDER BY` whitelist, so the
sort happens before the `LIMIT`. An optional `relation` filter, bound as a
nullable parameter ahead of the cap, turns the same check into the Table
page's first panel. Five existing checks gain the same `relation` filter so
the Table page can ask about indexes and sequences. The web layer gets two
small shared components — one entity link, one sort link — and two new routes.

**Tech Stack:** TypeScript, Next.js 16.3.3 App Router (React Server
Components), `pg`, Vitest (`unit` / `integration` / `web` projects),
testcontainers for integration, Tailwind v4.

**Spec:** `docs/design/2026-09-23-pgops-information-architecture-design.md` —
§5.1 (three pages are sorts), §5.2 (an entity page asks about one relation),
§5.3 (the Table page), §6.1–6.3 (the standard patterns), §8 (this slice).

---

## Global Constraints

Copied from the spec and from the project's standing rules. Every task's
requirements implicitly include this section.

- **No DDL against a monitored database, ever.** `guards.test.ts` confines DDL
  strings to `run.ts`. A `remedy` is prose, lower case, and must not match
  `/\b(?:CREATE|ALTER|DROP|REINDEX)\s+(?:INDEX|TABLE)\b/`.
- **`pg_stat_statements` is never reset** by anything this plan adds.
- **Every field of a hygiene check's `Opts` must stay optional.**
  `packages/checks/src/capture.ts:447-456` runs every hygiene check as
  `runCheck(ctx, check, {})`. A required opt breaks the scheduler.
- **A capped list carries its true total** via `count(*) OVER ()`, never
  `rows.length`. Filters go in the `WHERE`, so the total counts post-filter
  and pre-`LIMIT`.
- **`verdict: null` is not `ok`.** "We could not look" and "we looked and it is
  fine" render differently. An entity page must never show `—` for a fact it
  simply did not ask for.
- **Sorting happens in SQL, before the `LIMIT`** (spec §6.2). Sorting rows
  that survived a cap yields the ranking of a population the page cannot name.
- **`ORDER BY` must not reference a `::text` alias.**
  `packages/checks/test/boundaries.test.ts:164-194` slices from the first
  `ORDER BY` to the end of the statement and fails on one. Order by the
  underlying numeric expression instead.
- **Every `/ nullif(` numerator must contain `::numeric` or `sum(`.**
  `boundaries.test.ts:100-113`.
- **`packages/checks` has exactly one runtime dependency (`pg`)** and no
  module-level `let`/`var`. `boundaries.test.ts:15-18, 66-77`.
- **Never name a relation with `::regclass::text` or `::regnamespace`.** Both
  parse identifier syntax and break on a schema named `"Weird Schema"`. See
  the docblocks at `indexes.ts:67-93` and `sequences.ts:99-103`. Compare
  against the concatenated `nspname || '.' || relname` value.
- **Every `class: 'hygiene'` check belongs to exactly one area.**
  `packages/checks/test/areas.test.ts:37-52`.
- **In `apps/web`, relative and `@/` imports carry no `.js` extension**
  (`guards.test.ts:181-199`). Files under `apps/web/test/` DO use `.js`.
- **A check declared with an `Opts` type must be called with `{}`.**
  `runCheckFor` dispatches on `opts === undefined`
  (`apps/web/lib/check.ts:128`).
- **Code style:** light OOP. No interfaces-as-abstraction, no inheritance, no
  factories, no DI plumbing. A helper stays a bare function. Few focused files.
- **Commits carry no co-author trailer.**

---

## Correction to the spec, §5.2

The spec says the Table page needs "no new checks". That is true of the Table
*page* and false of the Tables *list*, and the plan corrects it here rather
than quietly building something else.

The list must sort on size, dead rows, vacuum age, cache hit rate and live
rows. Those five columns live in four different checks (`tableSizes`,
`tableStats`, `tableCaching`, `indexUsage`), each independently capped at
`DEFAULT_LIMIT = 100`. Joining them in JavaScript and sorting the result
re-creates the exact trap §5.2 exists to close: a list whose membership was
decided by "top 100 by size", re-sorted by dead rows, is not "the 100 tables
with the most dead rows", and nothing on the page could tell the difference.

One query with one `ORDER BY` and one `LIMIT` is the only correct shape. So
the slice adds `tableList` — and it is not a new idea in this codebase, it is
a missing half: `AREAS` (`packages/checks/src/checks/areas.ts:33-49`) gives
the `indexes` area an inventory (`indexList`, "Indexes", no verdict) and gives
the `tables` area four findings and no inventory at all.

The existing four checks are NOT deleted. They carry the triage-band verdicts
and the hygiene cache, and `tableList` has no verdict, exactly as `indexList`
has none.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `packages/checks/src/checks/table-list.ts` | The `tableList` check: the table inventory, its sort whitelist and its filters. Its own file because `tables.ts` is already four checks and this one carries a `Record<TableSort, string>` that belongs beside nothing else. |
| `packages/checks/test/table-list.test.ts` | Unit: the map function, the sort whitelist, truncation. |
| `packages/checks/test/table-list.int.test.ts` | Integration: sort order, the relation filter's immunity to the cap, the unused and search filters. |
| `apps/web/components/entity-link.tsx` | The one entity-link convention (spec §6). A relation name looks and behaves the same on every page that renders one. |
| `apps/web/components/sort-link.tsx` | A sortable column heading: a link that carries the current query and flips one parameter. |
| `apps/web/app/db/[name]/tables/page.tsx` | The Tables list: presets, sort, search. |
| `apps/web/app/db/[name]/tables/[relation]/page.tsx` | The Table page (spec §5.3). |
| `apps/web/test/entity-link.test.tsx` | Unit: encoding, and that a pgops relation still links. |
| `apps/web/test/sort-link.test.tsx` | Unit: the query is carried, one parameter flips. |
| `apps/web/test/tables-list-page.test.tsx` | The list page: presets, capped totals, failure rendering. |
| `apps/web/test/table-page.test.tsx` | The Table page: the `verdict: null` rule, and that a panel says when it could not look. |

**Modified**

| File | Change |
|---|---|
| `packages/checks/src/checks/maintenance.ts` | `relation` opt on `autovacuumDanger`. |
| `packages/checks/src/checks/indexes.ts` | `relation` opt on `indexList`, `invalidIndexes`, `unusedIndexes`, `duplicateIndexes`. |
| `packages/checks/src/checks/sequences.ts` | `relation` opt on `sequences`, filtering on the OWNED table. |
| `packages/checks/src/registry.ts` | Import and register `tableList`. |
| `packages/checks/src/checks/areas.ts` | `tableList` joins the `tables` area; area `href`s move to the new routes. |
| `packages/checks/src/index.ts` | Export `tableList`'s value-level names. |
| `apps/web/components/sub-nav.tsx` | Items may carry an absolute `href`, so a tab's strip can point outside itself. |
| `apps/web/components/nav.tsx` | A `Tables` tab. This is the documented consequence of Decision 2 — see Task 6. |
| `apps/web/app/db/[name]/queries/tables/page.tsx`, `cleanup/space/page.tsx`, `cleanup/space/[relation]/page.tsx`, `cleanup/maintenance/page.tsx` | Become redirects to the new routes. |
| `apps/web/test/nav.test.tsx` | "Carries no tab that is not a gate" is rewritten, not deleted. |
| `apps/web/test/areas.test.ts`, `sub-nav-layouts.test.tsx`, `routes.int.test.ts`, `guards.test.ts` fixtures | Updated to the new shape, deliberately. |

---

## Task 1: the `tableList` check

The table inventory, with the sort and filters the list page needs. Package
only — nothing in `apps/web` changes in this task, and it ends green and
committable on its own.

**Files:**
- Create: `packages/checks/src/checks/table-list.ts`
- Create: `packages/checks/test/table-list.test.ts`
- Create: `packages/checks/test/table-list.int.test.ts`
- Modify: `packages/checks/src/registry.ts` (imports ~line 161-190, `CHECKS` 192-227)
- Modify: `packages/checks/src/checks/areas.ts` (`tables` members, ~line 46-49)
- Modify: `packages/checks/src/index.ts` (add a value export line)

**Interfaces:**
- Consumes: `ListOpts`-style conventions, `DEFAULT_LIMIT` and `visibleSchemas`
  from `./indexes.js`; `Check`, `SqlQuery` from `../types.js`.
- Produces, for Tasks 4 and 5:
  ```ts
  export type TableSort = 'size' | 'dead' | 'vacuum' | 'cache' | 'rows' | 'name';
  export const TABLE_SORTS: readonly TableSort[];
  export interface TableListOpts {
    limit?: number; sort?: TableSort; unusedOnly?: boolean;
    search?: string; relation?: string;
  }
  export interface TableListEntry {
    name: string; sizeBytes: number; liveRows: number; deadRows: number;
    seqScans: number; idxScans: number; hitRate: number | null;
    lastVacuum: Date | null; lastAnalyze: Date | null;
  }
  export interface TableListData {
    tables: TableListEntry[]; total: number; truncated: boolean;
  }
  export function toTableList(rows: TableListRow[]): TableListData;
  export const tableList: Check<TableListRow, TableListData, TableListOpts>;
  ```

- [ ] **Step 1: Write the failing unit test**

Create `packages/checks/test/table-list.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TABLE_SORTS, tableList, toTableList, type TableListRow } from '../src/checks/table-list.js';

const row: TableListRow = {
  name: 'public.orders',
  size_bytes: '4096',
  live_rows: '120',
  dead_rows: '7',
  seq_scans: '3',
  idx_scans: '900',
  hit_rate: '0.994',
  last_vacuum: new Date('2026-09-20T00:00:00Z'),
  last_analyze: null,
  total: 1,
};

describe('toTableList', () => {
  it('reads the pre-LIMIT total rather than the row count', () => {
    const data = toTableList([{ ...row, total: 250 }]);
    expect(data).toMatchObject({ total: 250, truncated: true });
    expect(data.tables).toHaveLength(1);
  });

  it('is empty and untruncated when nothing came back', () => {
    expect(toTableList([])).toEqual({ tables: [], total: 0, truncated: false });
  });

  /**
   * A hit rate of null means "no heap I/O has been recorded for this table",
   * which is not the same as a hit rate of zero. Zero is a table being read
   * entirely from disk — the worst reading there is — and rendering "we have
   * not looked" as the worst reading there is would send an operator to fix
   * a table nobody has touched.
   */
  it('keeps an unmeasured hit rate null rather than folding it to zero', () => {
    expect(toTableList([{ ...row, hit_rate: null }]).tables[0]!.hitRate).toBeNull();
    expect(toTableList([{ ...row, hit_rate: '0' }]).tables[0]!.hitRate).toBe(0);
  });

  it('converts the text-carried counters to numbers', () => {
    const t = toTableList([row]).tables[0]!;
    expect(t).toMatchObject({
      name: 'public.orders', sizeBytes: 4096, liveRows: 120, deadRows: 7,
      seqScans: 3, idxScans: 900,
    });
  });
});

describe('the tableList check', () => {
  /**
   * §2.2: an inventory is a table an operator reads, not a finding. Asserted
   * rather than assumed, because adding a verdict here would also break
   * areas.test.ts's exact list of areas that escalate.
   */
  it('reports without judging', () => {
    expect(tableList.verdict).toBeUndefined();
    expect(tableList.thresholds).toBeUndefined();
  });

  it('is hygiene, on the work gate, with the shared hygiene timeout', () => {
    expect(tableList.class).toBe('hygiene');
    expect(tableList.gate).toBe('work');
    expect(tableList.timeoutMs).toBe(10_000);
  });

  /**
   * THE SORT IS A CLOSED SET, and this is why it is interpolated safely.
   * query-stats.ts:349-355 states the rule for the only other interpolated
   * ORDER BY in the package: it is safe because the key comes from a closed
   * Record and the type must never be widened to `string`. This test is the
   * mechanical half of that promise — every member of the union has an entry,
   * and nothing else can reach the interpolation.
   */
  it('has an ORDER BY for every sort it admits, and admits nothing else', () => {
    const q = (sort: unknown) =>
      (tableList.sql as (o: unknown) => { text: string })({ sort });
    for (const sort of TABLE_SORTS) {
      expect(q(sort).text, `sort ${sort}`).toMatch(/ORDER BY \S/);
    }
    expect(() => q('; DROP TABLE orders --')).toThrow(/unknown sort/i);
  });

  it('defaults to the largest tables first', () => {
    const text = (tableList.sql as (o: unknown) => { text: string })({}).text;
    expect(text).toContain('size_num DESC');
  });

  /**
   * Every field optional, because capture.ts:447-456 runs every hygiene check
   * as `runCheck(ctx, check, {})`. A required opt does not fail a type check
   * there — the scheduler casts — it fails at runtime, on the scheduler, in
   * production.
   */
  it('runs with no options at all', () => {
    expect(() => (tableList.sql as (o: unknown) => unknown)({})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit table-list`
Expected: FAIL — `Cannot find module '../src/checks/table-list.js'`.

- [ ] **Step 3: Write the check**

Create `packages/checks/src/checks/table-list.ts`:

```ts
import type { Check, SqlQuery } from '../types.js';
import { DEFAULT_LIMIT, visibleSchemas, type ListOpts } from './indexes.js';

/**
 * THE TABLE INVENTORY, and the half of the console that was missing.
 *
 * `AREAS` gives the `indexes` area an inventory — `indexList`, titled
 * "Indexes", no verdict — beside its findings. The `tables` area had four
 * findings and nothing to read: `tableCaching`, `unusedTables`, `tableStats`
 * and `tableHitRate` each answer a question, and none of them lists the
 * tables. So "show me this database's tables, biggest first" had no check
 * behind it, and the console answered it with three separate pages that were
 * each one ORDER BY of a list nobody could see whole.
 *
 * ONE QUERY, because the sort must happen before the cap. The columns this
 * list sorts on live in four checks today, each capped at DEFAULT_LIMIT
 * independently. Joining those four in JavaScript and sorting the result
 * gives the ranking of whichever population the first cap admitted — "the 100
 * biggest tables, re-sorted by dead rows" is not "the 100 deadest tables",
 * and the page could not tell the difference to say so. See the design of
 * 2026-09-23 §6.2.
 */

export type TableSort = 'size' | 'dead' | 'vacuum' | 'cache' | 'rows' | 'name';

/** The closed set, exported so the web layer validates against it. */
export const TABLE_SORTS: readonly TableSort[] = ['size', 'dead', 'vacuum', 'cache', 'rows', 'name'];

/**
 * The ORDER BY for each sort.
 *
 * INTERPOLATED, not bound, and safe for exactly one reason: the key is a
 * member of a closed union and this Record is total over it. query-stats.ts
 * carries the same construction and the same warning — do not widen
 * `TableSort` to `string`, and do not reach into this map with an unchecked
 * value. `sqlFor` below is the only reader, and it throws on a miss rather
 * than returning undefined into a template literal.
 *
 * Every clause sorts on the underlying NUMERIC expression, never on the
 * `::text` alias the SELECT list declares. boundaries.test.ts:164-194 fails
 * on a `::text` alias referenced from an ORDER BY, and it is right to: the
 * text form of 9 sorts before the text form of 10.
 *
 * Each clause ends in `s.name` so the order is total. Without it a page of
 * tables that share a dead-row count of zero comes back in a different order
 * on every poll, which reads as the list churning.
 */
const ORDER: Record<TableSort, string> = {
  size: 'sz.size_num DESC NULLS LAST, s.name',
  dead: 's.n_dead_tup DESC, s.name',
  // NULLS FIRST: a table that has never been vacuumed is the most overdue
  // one there is, not the least. `greatest` because autovacuum and a manual
  // VACUUM are the same event to a reader asking when it last happened.
  vacuum: 'greatest(s.last_vacuum, s.last_autovacuum) ASC NULLS FIRST, s.name',
  // ASC: worst first, which is the only direction anyone asks for. NULLS LAST
  // keeps "no heap I/O recorded" out of the alarming end of a list it has no
  // reading for.
  cache: '(io.heap_blks_hit::numeric / nullif(io.heap_blks_hit + io.heap_blks_read, 0)) ASC NULLS LAST, s.name',
  rows: 's.n_live_tup DESC, s.name',
  name: 's.name ASC',
};

export interface TableListOpts extends ListOpts {
  /** Defaults to `size`. */
  sort?: TableSort;
  /** The `Unused` preset: tables no index scan has ever touched. */
  unusedOnly?: boolean;
  /** Case-insensitive substring of the schema-qualified name. */
  search?: string;
  /**
   * ONE relation, exactly, and the reason it exists.
   *
   * The Table page must not be assembled by filtering a capped list: a table
   * outside the cap would render every fact as `—`, which is the display for
   * "we could not look" being used for "we did not ask". Bound as a nullable
   * parameter applied in the WHERE, so the filter runs in Postgres ahead of
   * the LIMIT and is immune to it — the same construction as `sessions.pid`
   * (sessions.ts:100-126).
   */
  relation?: string;
}

export interface TableListRow {
  name: string;
  size_bytes: string;
  live_rows: string;
  dead_rows: string;
  seq_scans: string;
  idx_scans: string;
  hit_rate: string | null;
  last_vacuum: Date | null;
  last_analyze: Date | null;
  total: number;
}

export interface TableListEntry {
  name: string;
  sizeBytes: number;
  liveRows: number;
  deadRows: number;
  seqScans: number;
  idxScans: number;
  /** null means no heap I/O has been recorded — NOT a hit rate of zero. */
  hitRate: number | null;
  /** The later of the manual and automatic events, or null for neither. */
  lastVacuum: Date | null;
  lastAnalyze: Date | null;
}

export interface TableListData {
  tables: TableListEntry[];
  /** The pre-`LIMIT`, post-filter total from `count(*) OVER ()`. */
  total: number;
  truncated: boolean;
}

export function toTableList(rows: TableListRow[]): TableListData {
  const total = rows[0]?.total ?? 0;
  return {
    tables: rows.map((r) => ({
      name: r.name,
      sizeBytes: Number(r.size_bytes),
      liveRows: Number(r.live_rows),
      deadRows: Number(r.dead_rows),
      seqScans: Number(r.seq_scans),
      idxScans: Number(r.idx_scans),
      hitRate: r.hit_rate === null ? null : Number(r.hit_rate),
      lastVacuum: r.last_vacuum,
      lastAnalyze: r.last_analyze,
    })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * `pg_stat_user_tables` is the spine because it is the one view with a row
 * per table an operator cares about; size and heap I/O are LEFT JOINed onto
 * it so a table with neither still appears. An INNER JOIN here would silently
 * drop a table that has had no heap I/O since the last stats reset, which is
 * exactly the newly created table someone is looking for.
 */
const SELECT = `
WITH s AS (
  SELECT schemaname || '.' || relname AS name,
         n_live_tup, n_dead_tup, seq_scan, idx_scan,
         last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
  FROM pg_stat_user_tables
  WHERE ${visibleSchemas('schemaname')}
), io AS (
  SELECT schemaname || '.' || relname AS name, heap_blks_hit, heap_blks_read
  FROM pg_statio_user_tables
  WHERE ${visibleSchemas('schemaname')}
), sz AS (
  SELECT n.nspname || '.' || c.relname AS name, pg_total_relation_size(c.oid) AS size_num
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND ${visibleSchemas('n.nspname')}
)
SELECT s.name,
       coalesce(sz.size_num, 0)::text AS size_bytes,
       s.n_live_tup::text AS live_rows,
       s.n_dead_tup::text AS dead_rows,
       s.seq_scan::text   AS seq_scans,
       s.idx_scan::text   AS idx_scans,
       (io.heap_blks_hit::numeric / nullif(io.heap_blks_hit + io.heap_blks_read, 0))::text AS hit_rate,
       greatest(s.last_vacuum, s.last_autovacuum)   AS last_vacuum,
       greatest(s.last_analyze, s.last_autoanalyze) AS last_analyze,
       count(*) OVER ()::int AS total
FROM s
LEFT JOIN io ON io.name = s.name
LEFT JOIN sz ON sz.name = s.name
WHERE ($2::text IS NULL OR s.name = $2)
  AND ($3::boolean IS NOT TRUE OR s.idx_scan = 0)
  AND ($4::text IS NULL OR s.name ILIKE '%' || $4 || '%')`;

/**
 * The three filters sit in the WHERE, so `count(*) OVER ()` counts what
 * survived them and the LIMIT caps what the operator is shown — "Showing 100
 * of 250" then means 250 MATCHING tables, which is the number a search box
 * has to report to be worth having.
 */
export function sqlFor(o: TableListOpts): SqlQuery {
  const sort = o.sort ?? 'size';
  const order = ORDER[sort];
  // Not a defensive nicety: without it an unknown key interpolates the string
  // "undefined" into the statement and Postgres answers with a syntax error
  // an operator cannot act on. The web layer validates against TABLE_SORTS
  // before it ever gets here; this is what makes that validation load-bearing
  // rather than merely customary.
  if (order === undefined) throw new Error(`unknown sort: ${String(sort)}`);
  return {
    text: `${SELECT}\nORDER BY ${order}\nLIMIT $1`,
    values: [
      o.limit ?? DEFAULT_LIMIT,
      o.relation ?? null,
      o.unusedOnly ?? null,
      o.search === undefined || o.search === '' ? null : o.search,
    ],
  };
}

export const tableList: Check<TableListRow, TableListData, TableListOpts> = {
  id: 'tableList',
  title: 'Tables',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: sqlFor,
  map: toTableList,
  // No verdict: §2.2, and the same ruling `indexList` carries. An inventory
  // is read, not judged — the four table findings beside it in the `tables`
  // area are what escalate, and adding a verdict here would also break
  // areas.test.ts's exact list of areas that can.
};
```

- [ ] **Step 4: Register it**

In `packages/checks/src/registry.ts`, add to the import block (alphabetical,
near the other `./checks/` imports around line 161-190):

```ts
import { tableList } from './checks/table-list.js';
```

and add `tableList,` to the `CHECKS` object (alphabetical — between
`tableHitRate` and `tableSizes`, line ~227):

```ts
  tableCaching,
  tableHitRate,
  tableList,
  tableSizes,
  tableStats,
```

In `packages/checks/src/checks/areas.ts`, add it to the `tables` area's
members (line ~46-49):

```ts
  {
    id: 'tables',
    label: 'Tables',
    href: 'queries/tables',
    band: 'work',
    members: ['tableHitRate', 'tableCaching', 'unusedTables', 'tableStats', 'tableList'],
  },
```

In `packages/checks/src/index.ts`, after the `export type *` block, add the
value export (types come free via `export type * from './checks/...'`, values
do not — see lines 71-80 for the precedent):

```ts
export { TABLE_SORTS } from './checks/table-list.js';
export type * from './checks/table-list.js';
```

- [ ] **Step 5: Run the unit tests**

Run: `npx vitest run --project unit table-list registry areas boundaries`
Expected: PASS. If `areas.test.ts` fails with a member mismatch, the check was
not added to `MEMBERS`. If `boundaries.test.ts` fails on the `ORDER BY` guard,
a clause in `ORDER` is referencing a `::text` alias.

- [ ] **Step 6: Write the integration test**

Create `packages/checks/test/table-list.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { tableList } from '../src/checks/table-list.js';
import { withPostgres, seed } from './harness.js';

describe('tableList against a real server', () => {
  it('lists the largest table first and reports the true total', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE small_a (v int)');
      await seed(pool, 'CREATE TABLE small_b (v int)');
      await seed(pool, 'CREATE TABLE large (v text)');
      await seed(pool, "INSERT INTO large SELECT repeat('x', 200) FROM generate_series(1, 20000)");
      await seed(pool, 'ANALYZE');

      const all = await runCheck(ctx, tableList, {});
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.data.total).toBe(3);
      expect(all.data.truncated).toBe(false);
      expect(all.data.tables[0]!.name).toBe('public.large');

      const capped = await runCheck(ctx, tableList, { limit: 1 });
      expect(capped.ok).toBe(true);
      if (!capped.ok) return;
      expect(capped.data.tables).toHaveLength(1);
      expect(capped.data.total).toBe(3);
      expect(capped.data.truncated).toBe(true);
    });
  });

  /**
   * THE POINT OF THE WHOLE CHECK. A sort must re-rank the population, not the
   * page. If sorting happened after the cap this passes only by luck: ask for
   * one row by size and one row by name, and a cap-then-sort implementation
   * returns the same table twice.
   */
  it('sorts the whole population, not the capped page', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE zzz_big (v text)');
      await seed(pool, "INSERT INTO zzz_big SELECT repeat('x', 200) FROM generate_series(1, 20000)");
      await seed(pool, 'CREATE TABLE aaa_small (v int)');
      await seed(pool, 'ANALYZE');

      const bySize = await runCheck(ctx, tableList, { limit: 1, sort: 'size' });
      const byName = await runCheck(ctx, tableList, { limit: 1, sort: 'name' });
      expect(bySize.ok && byName.ok).toBe(true);
      if (!bySize.ok || !byName.ok) return;
      expect(bySize.data.tables[0]!.name).toBe('public.zzz_big');
      expect(byName.data.tables[0]!.name).toBe('public.aaa_small');
    });
  });

  /**
   * §5.2: the Table page asks about one relation, and the answer must not
   * depend on where that relation fell in a ranking. `limit: 1` with a sort
   * that puts the wanted table last is the shape of the bug — a filter
   * applied after the cap returns nothing here.
   */
  it('finds a relation the cap would have excluded', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE zzz_big (v text)');
      await seed(pool, "INSERT INTO zzz_big SELECT repeat('x', 200) FROM generate_series(1, 20000)");
      await seed(pool, 'CREATE TABLE aaa_small (v int)');
      await seed(pool, 'ANALYZE');

      const one = await runCheck(ctx, tableList, { limit: 1, sort: 'size', relation: 'public.aaa_small' });
      expect(one.ok).toBe(true);
      if (!one.ok) return;
      expect(one.data.tables).toHaveLength(1);
      expect(one.data.tables[0]!.name).toBe('public.aaa_small');
      expect(one.data.total).toBe(1);
      expect(one.data.truncated).toBe(false);
    });
  });

  it('answers with nothing, not an error, for a relation that does not exist', async () => {
    await withPostgres(async (ctx) => {
      const none = await runCheck(ctx, tableList, { relation: 'public.no_such_table' });
      expect(none.ok).toBe(true);
      if (!none.ok) return;
      expect(none.data.tables).toEqual([]);
      expect(none.data.total).toBe(0);
    });
  });

  it('counts matches, not the whole database, when searching', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE orders (v int)');
      await seed(pool, 'CREATE TABLE order_items (v int)');
      await seed(pool, 'CREATE TABLE customers (v int)');

      const found = await runCheck(ctx, tableList, { search: 'ORDER' });
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.data.total).toBe(2);
      expect(found.data.tables.map((t) => t.name).sort())
        .toEqual(['public.order_items', 'public.orders']);
    });
  });

  it('keeps a table with no recorded heap I/O, with a null hit rate', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE untouched (v int)');
      const out = await runCheck(ctx, tableList, { relation: 'public.untouched' });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.data.tables).toHaveLength(1);
      expect(out.data.tables[0]!.hitRate).toBeNull();
    });
  });
});
```

- [ ] **Step 7: Run the integration test**

Nothing else may be running against the test port or `dist/` — a concurrent
run fakes a code failure.

Run: `npx vitest run --project integration table-list`
Expected: PASS (testcontainers pulls `postgres:17` on the first run).

- [ ] **Step 8: Run the whole gate and commit**

```bash
npx vitest run --project unit
npx vitest run --project integration
git add packages/checks/src/checks/table-list.ts packages/checks/test/table-list.test.ts \
        packages/checks/test/table-list.int.test.ts packages/checks/src/registry.ts \
        packages/checks/src/checks/areas.ts packages/checks/src/index.ts
git commit -m "feat: the table inventory the tables area never had

AREAS gives the indexes area an inventory — indexList, no verdict — beside
its findings, and gives the tables area four findings and nothing to read.
So \"this database's tables, biggest first\" had no check behind it, and the
console answered it with three pages that were each one ORDER BY of a list
nobody could see whole.

One query, because the sort has to happen before the cap. The columns this
list sorts on live in four independently capped checks today; joining those
in JavaScript and sorting the result gives the ranking of whichever
population the first cap admitted, and the page could not tell the
difference to say so.

The relation filter is bound as a nullable parameter in the WHERE, the same
construction as sessions.pid, so it runs ahead of the LIMIT and is immune to
it. Proved by asking for a relation with limit 1 and a sort that puts it
last."
```

---

## Task 2: `relation` on the checks the Table page asks

Five checks gain the same nullable-bind filter, so the Table page can ask
about one relation's indexes and sequences without filtering a capped list.
Package only.

**Files:**
- Modify: `packages/checks/src/checks/maintenance.ts` (`autovacuumDanger`, ~line 75-121)
- Modify: `packages/checks/src/checks/indexes.ts` (`indexList` ~138-184, `invalidIndexes` ~294-348, `unusedIndexes` ~381-425, `duplicateIndexes` ~523-588)
- Modify: `packages/checks/src/checks/sequences.ts` (`sequences`, ~138-227)
- Modify: `packages/checks/test/indexes.int.test.ts`, `maintenance.int.test.ts`, `sequences.int.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, for Task 5:
  ```ts
  // indexes.ts
  export interface RelationOpts extends ListOpts { relation?: string }
  // and these four checks retyped from ListOpts to RelationOpts:
  //   indexList, invalidIndexes, unusedIndexes, duplicateIndexes
  // maintenance.ts: autovacuumDanger  : Check<…, …, RelationOpts>
  // sequences.ts:   sequences         : Check<…, …, RelationOpts>
  ```

- [ ] **Step 1: Write the failing integration test for one check first**

Append to `packages/checks/test/indexes.int.test.ts`:

```ts
describe('the relation filter', () => {
  /**
   * §5.2. The filter must run in Postgres ahead of the LIMIT, so a table's
   * indexes are findable however that table ranked. `limit: 1` with the
   * wanted table sorted last is the shape that fails if the filter were
   * applied to the returned page.
   */
  it('lists one table\'s indexes however that table ranked', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE zzz_big (v text)');
      await seed(pool, "INSERT INTO zzz_big SELECT repeat('x', 200) FROM generate_series(1, 20000)");
      await seed(pool, 'CREATE INDEX zzz_big_v_idx ON zzz_big (v)');
      await seed(pool, 'CREATE TABLE aaa_small (v int)');
      await seed(pool, 'CREATE INDEX aaa_small_v_idx ON aaa_small (v)');

      const out = await runCheck(ctx, indexList, { limit: 1, relation: 'public.aaa_small' });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.data.indexes.map((i) => i.name)).toEqual(['public.aaa_small_v_idx']);
      expect(out.data.total).toBe(1);
      expect(out.data.truncated).toBe(false);
    });
  });

  it('is unfiltered when no relation is given', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE a (v int)');
      await seed(pool, 'CREATE INDEX a_v_idx ON a (v)');
      await seed(pool, 'CREATE TABLE b (v int)');
      await seed(pool, 'CREATE INDEX b_v_idx ON b (v)');

      const out = await runCheck(ctx, indexList, {});
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.data.indexes.map((i) => i.name).sort())
        .toEqual(['public.a_v_idx', 'public.b_v_idx']);
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration indexes`
Expected: FAIL — TypeScript rejects `relation` on `ListOpts`.

- [ ] **Step 3: Add the opt type and thread it through `indexes.ts`**

In `packages/checks/src/checks/indexes.ts`, below `ListOpts` (line ~10):

```ts
/**
 * A list check that can be asked about ONE relation.
 *
 * Every field optional, because capture.ts runs every hygiene check as
 * `runCheck(ctx, check, {})`. The filter is bound as a nullable parameter
 * and applied in the WHERE, so it runs ahead of the LIMIT — the same
 * construction as `sessions.pid`, and for the same reason stated there: a
 * filter applied to an already-capped page cannot find what the server never
 * sent.
 *
 * Compared against the concatenated `nspname || '.' || relname` rather than
 * a cast. `::regclass::text` and `::regnamespace` both parse identifier
 * syntax and break on a schema named "Weird Schema" — see the docblocks on
 * `visibleSchemas` and in sequences.ts.
 */
export interface RelationOpts extends ListOpts { relation?: string }
```

Change `INDEX_LIST_SQL`'s `WHERE` (line ~151) and the check's `sql` and type:

```ts
WHERE ${visibleSchemas('n.nspname')}
  AND ($2::text IS NULL OR n.nspname || '.' || t.relname = $2)
ORDER BY pg_relation_size(i.indexrelid) DESC, c.relname
LIMIT $1`;

export const indexList: Check<IndexListRow, IndexListData, RelationOpts> = {
  id: 'indexList',
  title: 'Indexes',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: INDEX_LIST_SQL, values: [o.limit ?? DEFAULT_LIMIT, o.relation ?? null] }),
  map: toIndexList,
};
```

Apply the identical two-line change to `invalidIndexes` (its `WHERE NOT
i.indisvalid` clause gains the same `AND (…)`, `values` becomes `[o.limit ??
DEFAULT_LIMIT, o.relation ?? null]`) and to `unusedIndexes` (which already
binds two parameters, so the relation is `$3`:
`values: [UNUSED_INDEX_FLOOR_BYTES, o.limit ?? DEFAULT_LIMIT, o.relation ?? null]`
and the clause reads `AND ($3::text IS NULL OR n.nspname || '.' || t.relname = $3)`).

For `duplicateIndexes` the filter belongs in the `ix` CTE's `WHERE` (so both
sides of the self-join are restricted to the one table, which is what "this
table's duplicates" means), with the relation as `$2`:

```ts
    WHERE i.indexprs IS NULL
      AND i.indisvalid
      AND ($2::text IS NULL OR n.nspname || '.' || t.relname = $2)
      AND ${visibleSchemas('n.nspname')}
```
and `values: [o.limit ?? DEFAULT_LIMIT, o.relation ?? null]`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run --project integration indexes`
Expected: PASS.

- [ ] **Step 5: Do the same for `autovacuumDanger`**

In `packages/checks/src/checks/maintenance.ts`, import `RelationOpts`
alongside the existing names (line ~1) and change the SQL's `WHERE` and the
check's type:

```ts
WHERE c.relkind IN ('r', 'm')
  AND ${visibleSchemas('n.nspname')}
  AND ($2::text IS NULL OR n.nspname || '.' || c.relname = $2)
ORDER BY a.xact_age DESC, relation
LIMIT $1`;

export const autovacuumDanger: Check<AutovacuumDangerRow, AutovacuumDangerData, RelationOpts> = {
  // …unchanged…
  sql: (o) => ({ text: AUTOVACUUM_DANGER_SQL, values: [o.limit ?? DEFAULT_LIMIT, o.relation ?? null] }),
  // …unchanged…
};
```

Note the opt is `relation` and the ROW's column is also `relation`; they do
not collide, but do not be tempted to rename either — the column name is
asserted in `maintenance.int.test.ts`.

- [ ] **Step 6: Do the same for `sequences`, filtering on the OWNED table**

A sequence's own name is not what a Table page asks about — `orders_id_seq`
belongs to `orders`. The filter therefore matches `o.table_name`, and the
final `SELECT` gains a `WHERE` it does not currently have, placed before the
`ORDER BY`:

```ts
FROM seq s
LEFT JOIN owned o ON o.seqoid = s.seqoid
LEFT JOIN pg_sequences ps ON ps.schemaname = s.nsp AND ps.sequencename = s.rel
CROSS JOIN LATERAL (
  …unchanged…
) v
WHERE ($2::text IS NULL OR o.table_name = $2)
ORDER BY (v.val / v.ceiling) DESC NULLS LAST, s.name
LIMIT $1`;
```

with `values: [o.limit ?? DEFAULT_LIMIT, o.relation ?? null]` and the check
retyped to `Check<SequenceRow, SequenceData, RelationOpts>`.

The `unreadable` and `worst_pct` window functions are computed after the
`WHERE`, so a Table page asking about one table gets that table's worst
percentage, not the database's — which is correct, and is the reason the
verdict must not be read from a relation-scoped call. Add a comment saying so
directly above the new `WHERE`.

- [ ] **Step 7: Write the sequences and maintenance integration tests**

Append to `packages/checks/test/sequences.int.test.ts`:

```ts
it('asks about one table\'s sequences, by the table that owns them', async () => {
  await withPostgres(async (ctx, pool) => {
    await seed(pool, 'CREATE TABLE orders (id bigserial PRIMARY KEY)');
    await seed(pool, 'CREATE TABLE customers (id bigserial PRIMARY KEY)');

    const out = await runCheck(ctx, sequences, { relation: 'public.orders' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.sequences.map((s) => s.name)).toEqual(['public.orders_id_seq']);
  });
});
```

Append to `packages/checks/test/maintenance.int.test.ts`:

```ts
it('reports transaction age for one relation', async () => {
  await withPostgres(async (ctx, pool) => {
    await seed(pool, 'CREATE TABLE a (v int)');
    await seed(pool, 'CREATE TABLE b (v int)');

    const out = await runCheck(ctx, autovacuumDanger, { relation: 'public.a' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.relations.map((r) => r.relation)).toEqual(['public.a']);
    expect(out.data.total).toBe(1);
  });
});
```

- [ ] **Step 8: Run everything and commit**

```bash
npx vitest run --project unit
npx vitest run --project integration
git add packages/checks/src/checks/indexes.ts packages/checks/src/checks/maintenance.ts \
        packages/checks/src/checks/sequences.ts packages/checks/test/indexes.int.test.ts \
        packages/checks/test/maintenance.int.test.ts packages/checks/test/sequences.int.test.ts
git commit -m "feat: five checks can be asked about one relation

The construction is sessions.pid's, and the reason is the one stated there:
a filter applied to an already-capped page cannot find what the server never
sent. So the filter is a nullable bind in the WHERE, ahead of the LIMIT, and
count(*) OVER () counts what survived it.

Without this an entity page can only be assembled by filtering the cached
top-N lists, and a table outside every cap renders every fact as an em dash
— the display for \"we could not look\" used for \"we did not ask\". That is
verdict: null served as ok, on the page whose whole job is gathering what is
known about one thing.

sequences filters on the OWNED table, because orders_id_seq is a fact about
orders. Its worst-percentage window is computed after the WHERE, so a
relation-scoped call yields that table's worst reading and not the
database's — noted in the source, because the verdict must not be read from
such a call."
```

---

## Task 3: the two shared web components

One entity link and one sort link, both tiny, both pure enough to test
without a database. Spec §6 asks that "all these UI things should be standard
throughout"; these two are what "standard" is made of.

**A correction to spec §6.1, noted here so the next reader is not misled:**
the spec says `Findings` "already names the entity … it simply is not
rendered as a link". The first half is true — `subject` names it — but
`Findings` does not render the cells at all: it calls
`children(item)` and the CALL SITE returns the `<TableRow>` with its
`<TableCell>`s (`components/findings.tsx:70-76`). So the link belongs in a
component the call sites use, not inside `Findings`. `Findings` is unchanged
by this slice.

**Files:**
- Create: `apps/web/components/entity-link.tsx`
- Create: `apps/web/components/sort-link.tsx`
- Create: `apps/web/test/entity-link.test.tsx`
- Create: `apps/web/test/sort-link.test.tsx`

**Interfaces:**
- Produces, for Tasks 4 and 5:
  ```ts
  export function EntityLink({ database, name }: { database: string; name: string }): ReactElement;
  export function withParam(
    pathname: string,
    params: Record<string, string | undefined>,
    key: string,
    value: string | undefined,
  ): { pathname: string; query: Record<string, string> };
  export function SortLink({ label, column, current, pathname, params, align }: {
    label: string; column: string; current: string;
    pathname: string; params: Record<string, string | undefined>;
    align?: 'right';
  }): ReactElement;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/entity-link.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { render, type Rendered } from './render.js';
import { EntityLink } from '@/components/entity-link';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; });

const href = async (name: string) => {
  rendered = await render(<EntityLink database="prod" name={name} />);
  return rendered.container.querySelector('a')?.getAttribute('href');
};

describe('EntityLink', () => {
  it('links a relation to its own page', async () => {
    expect(await href('public.orders')).toBe('/db/prod/tables/public.orders');
  });

  /**
   * ENCODED HERE, DECODED BY NEXT, and encoded exactly once. The space page's
   * docblock records the other half of this contract: `relation` arrives
   * already decoded from Next, and decoding again corrupts a name containing
   * a literal percent. A relation name is an arbitrary identifier — a slash
   * or a percent in one is legal Postgres and would otherwise route somewhere
   * else entirely, or 404.
   */
  it('encodes a name that would otherwise change the route', async () => {
    expect(await href('public.a/b')).toBe('/db/prod/tables/public.a%2Fb');
    expect(await href('public.100%')).toBe('/db/prod/tables/public.100%25');
  });

  it('shows the name as written', async () => {
    rendered = await render(<EntityLink database="prod" name="public.order_items" />);
    expect(rendered.text()).toBe('public.order_items');
  });
});
```

Create `apps/web/test/sort-link.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { render, type Rendered } from './render.js';
import { SortLink, withParam } from '@/components/sort-link';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; });

describe('withParam', () => {
  /**
   * The same promise `foldFrom` makes and for the same reason: flipping one
   * control on a page reached with a search and a fold must not silently
   * discard either. A sort link that drops `q` turns "sort these four
   * matches" into "sort the whole database", which looks like the search
   * having been ignored.
   */
  it('carries every other parameter', () => {
    expect(withParam('/db/prod/tables', { q: 'order', pgops: 'show' }, 'sort', 'dead'))
      .toEqual({ pathname: '/db/prod/tables', query: { q: 'order', pgops: 'show', sort: 'dead' } });
  });

  it('replaces the parameter it is given rather than appending it', () => {
    expect(withParam('/p', { sort: 'size' }, 'sort', 'name').query).toEqual({ sort: 'name' });
  });

  it('drops the parameter when the value is undefined or empty', () => {
    expect(withParam('/p', { sort: 'size', q: 'x' }, 'q', undefined).query).toEqual({ sort: 'size' });
    expect(withParam('/p', { sort: 'size', q: 'x' }, 'q', '').query).toEqual({ sort: 'size' });
  });

  it('drops empty incoming values too, so the URL does not grow noise', () => {
    expect(withParam('/p', { q: '', sort: undefined }, 'sort', 'size').query).toEqual({ sort: 'size' });
  });
});

describe('SortLink', () => {
  const props = { pathname: '/db/prod/tables', params: { q: 'order' } };

  it('marks the active column for a screen reader, not by colour alone', async () => {
    rendered = await render(
      <SortLink label="Dead rows" column="dead" current="dead" {...props} />,
    );
    const el = rendered.container.querySelector('[aria-sort]');
    expect(el?.getAttribute('aria-sort')).toBe('descending');
    expect(rendered.text()).toContain('Dead rows');
  });

  it('leaves an inactive column unsorted', async () => {
    rendered = await render(
      <SortLink label="Size" column="size" current="dead" {...props} />,
    );
    expect(rendered.container.querySelector('[aria-sort]')?.getAttribute('aria-sort')).toBe('none');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project web entity-link sort-link`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Write `entity-link.tsx`**

```tsx
import Link from 'next/link';

/**
 * THE ONE WAY a relation name is rendered when it can be clicked.
 *
 * Spec §6: "all these UI things should be standard throughout". Eight pages
 * render a relation name today and each styles it by hand, so the same table
 * looks like three different kinds of thing depending on which page found it.
 * One component makes the convention mechanical rather than remembered.
 *
 * `encodeURIComponent` HERE, and decoded by Next on the way in — exactly
 * once, in each direction. A relation name is an arbitrary identifier: a
 * slash in one routes somewhere else entirely, and a percent in one becomes
 * a mangled name if anything decodes twice. The receiving page's docblock
 * (app/db/[name]/tables/[relation]/page.tsx) carries the other half of this
 * contract.
 *
 * Deliberately NOT parameterised by kind yet. An index page does not exist
 * in this slice, and a link that reliably 404s is worse than a name that is
 * not yet a link.
 */
export function EntityLink({ database, name }: { database: string; name: string }) {
  return (
    <Link
      href={`/db/${database}/tables/${encodeURIComponent(name)}`}
      className="font-mono underline decoration-border underline-offset-2 hover:decoration-foreground"
    >
      {name}
    </Link>
  );
}
```

- [ ] **Step 4: Write `sort-link.tsx`**

```tsx
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Replace one query parameter, carrying every other one along.
 *
 * The same promise `foldFrom` makes in lib/fold.ts, and made the same way,
 * because a page now has three controls in the URL — the fold, the sort and
 * the search — and any one of them quietly resetting the other two is the
 * failure all three share. Returns Next's object href form rather than a
 * string so the query is escaped by the router and not by hand.
 */
export function withParam(
  pathname: string,
  params: Record<string, string | undefined>,
  key: string,
  value: string | undefined,
): { pathname: string; query: Record<string, string> } {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k !== key && v !== undefined && v !== '') query[k] = v;
  }
  if (value !== undefined && value !== '') query[key] = value;
  return { pathname, query };
}

/**
 * A column heading that sorts.
 *
 * `aria-sort` on the `<th>`, not a caret glyph alone: the active column must
 * be announced, and it must be distinguishable without colour. Every sort
 * this console offers is single-direction and chosen to be the direction
 * anyone asks for — biggest first, worst cache hit first, longest unvacuumed
 * first — so there is no ascending/descending toggle to carry. That is a
 * deliberate narrowing, not an omission: a second click that reverses
 * "biggest tables" into "smallest tables" answers a question nobody has
 * during an incident, and it doubles the sort surface the check must
 * whitelist.
 */
export function SortLink({ label, column, current, pathname, params, align }: {
  label: string;
  column: string;
  current: string;
  pathname: string;
  params: Record<string, string | undefined>;
  align?: 'right';
}) {
  const active = column === current;
  return (
    <th
      scope="col"
      aria-sort={active ? 'descending' : 'none'}
      className={cn(
        'h-9 px-2 text-left align-middle font-medium text-muted-foreground',
        align === 'right' && 'text-right',
      )}
    >
      <Link
        href={withParam(pathname, params, 'sort', column)}
        className={cn(
          'underline-offset-4 hover:underline',
          active && 'font-semibold text-foreground underline',
        )}
      >
        {label}
      </Link>
    </th>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project web entity-link sort-link`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/entity-link.tsx apps/web/components/sort-link.tsx \
        apps/web/test/entity-link.test.tsx apps/web/test/sort-link.test.tsx
git commit -m "feat: one way to link a relation, one way to sort a column

Eight pages render a relation name and each styles it by hand, so the same
table looks like three kinds of thing depending on which page found it.
These two components are what \"standard throughout\" is made of.

The encoding contract is stated in both directions: encoded here, decoded by
Next on the way in, exactly once each way. A relation name is an arbitrary
identifier — a slash routes somewhere else entirely and a percent is mangled
by a second decode.

withParam carries every other parameter, which is foldFrom's promise for the
same reason: the page now has three controls in the URL and any one of them
resetting the others is the failure all three share."
```

---

## Task 4: the Tables list page

**Files:**
- Create: `apps/web/app/db/[name]/tables/page.tsx`
- Create: `apps/web/test/tables-list-page.test.tsx`

**Interfaces:**
- Consumes: `CHECKS.tableList` and `TABLE_SORTS` (Task 1); `EntityLink`,
  `SortLink`, `withParam` (Task 3); the existing `Findings`, `CheckPanel`,
  `foldFrom`, `formatBytes`, `formatCount`, `formatAgo`.
- Produces: the route `/db/<name>/tables`, which Task 6 redirects three old
  routes onto.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/tables-list-page.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Tables from '@/app/db/[name]/tables/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { overrides, calls } = vi.hoisted(() => ({
  overrides: new Map<string, unknown>(),
  calls: [] as { id: string; opts: unknown }[],
}));

const ok = (data: unknown, verdict: unknown = null) => ({ ok: true, data, verdict, measuredAt: 0 });

const entry = (name: string, over: Record<string, unknown> = {}) => ({
  name, sizeBytes: 4096, liveRows: 10, deadRows: 0, seqScans: 0, idxScans: 5,
  hitRate: 0.99, lastVacuum: null, lastAnalyze: null, ...over,
});

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }, opts: unknown) => {
    calls.push({ id: check.id, opts });
    return overrides.get(check.id) ?? ok({ tables: [], total: 0, truncated: false });
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => 'tables',
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount(); rendered = undefined;
  overrides.clear(); calls.length = 0; vi.clearAllMocks();
});

const html = async (search: Record<string, string> = {}) => {
  const element = await Tables({
    params: Promise.resolve({ name: 'prod' }),
    searchParams: Promise.resolve(search),
  });
  rendered = await render(element);
  return rendered.container.innerHTML;
};

describe('the tables list', () => {
  it('asks the check for the largest tables by default', async () => {
    await html();
    expect(calls.find((c) => c.id === 'tableList')?.opts).toMatchObject({ sort: 'size' });
  });

  /**
   * THE WHOLE POINT OF SERVER-SIDE SORTING (spec §6.2). The sort must reach
   * the check, because the check applies it before its LIMIT. A page that
   * accepted `?sort=` and sorted the returned rows would pass a rendering
   * test and still show the ranking of the wrong population.
   */
  it('passes the requested sort to the check rather than sorting rows itself', async () => {
    await html({ sort: 'dead' });
    expect(calls.find((c) => c.id === 'tableList')?.opts).toMatchObject({ sort: 'dead' });
  });

  /**
   * An unknown sort is interpolated into an ORDER BY by the check, which
   * throws on a miss. The page must never let one through — this is the test
   * that makes `TABLE_SORTS` load-bearing rather than decorative.
   */
  it('ignores a sort it does not recognise instead of passing it on', async () => {
    await html({ sort: '; DROP TABLE orders --' });
    expect(calls.find((c) => c.id === 'tableList')?.opts).toMatchObject({ sort: 'size' });
  });

  it('passes the search and the unused filter to the check', async () => {
    await html({ q: 'order', only: 'unused' });
    expect(calls.find((c) => c.id === 'tableList')?.opts)
      .toMatchObject({ search: 'order', unusedOnly: true });
  });

  it('links each table to its own page', async () => {
    overrides.set('tableList', ok({ tables: [entry('public.orders')], total: 1, truncated: false }));
    const out = await html();
    expect(out).toContain('/db/prod/tables/public.orders');
  });

  it('reports the true total when the list is capped', async () => {
    overrides.set('tableList', ok({
      tables: Array.from({ length: 100 }, (_, n) => entry(`public.t${n}`)),
      total: 250, truncated: true,
    }));
    expect(await html()).toContain('Showing 100 of 250');
  });

  it('says why the check could not run instead of rendering an empty list', async () => {
    overrides.set('tableList', {
      ok: false, reason: 'privilege',
      message: 'permission denied for view pg_stat_user_tables',
    });
    expect(await html()).toContain('permission denied for view pg_stat_user_tables');
  });

  /**
   * `hitRate: null` is "no heap I/O has been recorded", not a hit rate of
   * zero. Rendering it as 0% claims the worst reading there is for a table
   * nobody has read.
   */
  it('renders an unmeasured hit rate as unknown, never as 0%', async () => {
    overrides.set('tableList', ok({
      tables: [entry('public.fresh', { hitRate: null })], total: 1, truncated: false,
    }));
    const out = await html();
    expect(out).not.toMatch(/0(\.0)?%/);
  });

  it('offers the presets as links that carry the search', async () => {
    const out = await html({ q: 'order' });
    expect(out).toContain('sort=vacuum');
    expect(out).toContain('only=unused');
    expect(out).toContain('q=order');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project web tables-list-page`
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Write the page**

Create `apps/web/app/db/[name]/tables/page.tsx`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS, TABLE_SORTS, type TableSort } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { Findings } from '@/components/findings';
import { EntityLink } from '@/components/entity-link';
import { SortLink, withParam } from '@/components/sort-link';
import { foldFrom } from '@/lib/fold';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { formatAgo, formatBytes, formatCount } from '@/lib/format';

/**
 * The presets, and why they are links rather than a default sort plus a hint.
 *
 * Space, Maintenance and the unused half of the Tables page were each one
 * ORDER BY of this list (design §5.1). Collapsing them into a sortable table
 * without these would turn a one-click answer into "find the column, click
 * it" — slower, during an incident, than what it replaced. Each is a URL, so
 * it is shareable and back-buttonable, and none of them is a second code
 * path: they all land on this page with different parameters.
 */
const PRESETS = [
  { label: 'Biggest', key: 'sort', value: 'size' },
  { label: 'Needs vacuum', key: 'sort', value: 'vacuum' },
  { label: 'Worst cache hit', key: 'sort', value: 'cache' },
  { label: 'Unused', key: 'only', value: 'unused' },
] as const;

export async function generateMetadata(
  { params }: { params: Promise<{ name: string }> },
): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Tables` };
}

export default async function Tables({ params, searchParams }: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ sort?: string; q?: string; only?: string; pgops?: string }>;
}) {
  const { name } = await params;
  const query = await searchParams;
  const pathname = `/db/${name}/tables`;
  const fold = foldFrom(pathname, query);

  // VALIDATED HERE, and this is the line that makes the check's closed
  // `Record<TableSort, string>` safe to interpolate. `sqlFor` throws on a
  // miss rather than interpolating `undefined`; this is what ensures it
  // never has to.
  const sort: TableSort = TABLE_SORTS.includes(query.sort as TableSort)
    ? (query.sort as TableSort)
    : 'size';
  const search = query.q === undefined || query.q === '' ? undefined : query.q;
  const unusedOnly = query.only === 'unused';

  const result = await runCheckFor(name, CHECKS.tableList, { sort, search, unusedOnly });

  // NOT `cacheChecks`. Every other hygiene page caches its result under the
  // check's id so the triage page can read the same reading — but those pages
  // run their checks unfiltered, with `{}`. This one runs a sorted, filtered,
  // searched query, and writing that under `tableList` would hand the triage
  // page one operator's search results as the database's state.

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="font-medium">Tables</h1>
        <p className="text-sm text-muted-foreground">
          Every table in this database, with what pgops knows about each.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {PRESETS.map((p) => {
          // A preset is active when its own parameter is the chosen one, so
          // `Unused` and `Biggest` can be lit at once — they are a filter and
          // an order, not two options in a list.
          const active = p.key === 'sort' ? sort === p.value : unusedOnly;
          return (
            <Link
              key={p.label}
              href={withParam(pathname, query, p.key, active ? undefined : p.value)}
              aria-pressed={active}
              className={active
                ? 'rounded-md bg-muted px-2.5 py-1 font-medium text-foreground'
                : 'rounded-md px-2.5 py-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground'}
            >
              {p.label}
            </Link>
          );
        })}
        <form action={pathname} className="ml-auto flex items-center gap-2">
          {/* The other controls travel as hidden fields, so searching from a
              page reached by a preset keeps the preset. Without them a search
              silently resets the order the operator chose. */}
          {sort === 'size' ? null : <input type="hidden" name="sort" value={sort} />}
          {unusedOnly ? <input type="hidden" name="only" value="unused" /> : null}
          {fold.show ? <input type="hidden" name="pgops" value="show" /> : null}
          <label htmlFor="q" className="sr-only">Search table names</label>
          <input
            id="q"
            name="q"
            defaultValue={query.q ?? ''}
            placeholder="Search tables"
            className="w-48 rounded border px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </form>
      </div>

      <CheckPanel title={CHECKS.tableList.title} result={result}>
        {(d: { tables: TableListEntry[]; total: number }) => (d.tables.length === 0
          ? (
            <p className="text-sm text-muted-foreground">
              {search === undefined && !unusedOnly
                ? 'No tables.'
                : 'No tables match that.'}
            </p>
          )
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortLink label="Table" column="name" current={sort} pathname={pathname} params={query} />
                  <SortLink label="Size" column="size" current={sort} pathname={pathname} params={query} align="right" />
                  <SortLink label="Rows" column="rows" current={sort} pathname={pathname} params={query} align="right" />
                  <SortLink label="Dead" column="dead" current={sort} pathname={pathname} params={query} align="right" />
                  <SortLink label="Cache hit" column="cache" current={sort} pathname={pathname} params={query} align="right" />
                  <SortLink label="Vacuumed" column="vacuum" current={sort} pathname={pathname} params={query} align="right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* `Findings` is not used here: it owns the fold and the
                    truncation sentence but renders a header of plain strings,
                    and every heading on this table is a link. The two notes it
                    would have contributed are rendered directly below. */}
                {foldRows(d.tables, fold.show).map((t) => (
                  <TableRow key={t.name}>
                    <TableCell><EntityLink database={name} name={t.name} /></TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(t.sizeBytes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(t.liveRows)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(t.deadRows)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {/* null is "no heap I/O recorded", which is NOT 0%. */}
                      {t.hitRate === null ? '—' : `${(t.hitRate * 100).toFixed(1)}%`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAgo(t.lastVacuum) ?? 'never'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ))}
      </CheckPanel>
    </div>
  );
}
```

Add the two small helpers at the bottom of the same file — they are used
nowhere else, and a file per two-line function is the split this codebase
avoids:

```ts
import { isOurs } from '@/lib/fold';
import type { TableListEntry } from '@pgops/checks';

/** The fold, applied to this page's own rows. See lib/fold.ts. */
function foldRows(tables: readonly TableListEntry[], show: boolean): TableListEntry[] {
  return show ? [...tables] : tables.filter((t) => !isOurs(t.name));
}
```

- [ ] **Step 4: Render the truncation and fold notes**

`Findings` is not used, so its two sentences must be rendered here or the
page silently drops them. Immediately after `</Table>` inside the
`CheckPanel` children, add:

```tsx
{d.total > d.tables.length ? (
  <p className="mt-2 text-sm text-muted-foreground">
    Showing {formatCount(d.tables.length)} of {formatCount(d.total)}. Narrow
    the search or raise the cap to see the rest.
  </p>
) : null}
<FoldNote mine={d.tables.filter((t) => isOurs(t.name)).length} fold={fold} />
```

with `import { FoldNote } from '@/components/fold-note';` added at the top.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project web tables-list-page`
Expected: PASS. Then `npx vitest run --project web guards` — the new page
must not trip the dynamic-rendering or import-extension guards.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/db/[name]/tables/page.tsx apps/web/test/tables-list-page.test.tsx
git commit -m "feat: one Tables list, sorted and filtered in SQL

The sort is a URL parameter validated against TABLE_SORTS and handed to the
check, which applies it before its LIMIT. A page that accepted ?sort= and
re-ordered the rows it had been given would pass every rendering test and
still show the ranking of a population it could not name.

The presets are what makes collapsing three pages safe: Biggest, Needs
vacuum, Worst cache hit and Unused are each one URL onto this page, so the
one-click answer survives and there is still only one code path drawing the
rows.

It does NOT cacheChecks. Every other hygiene page writes its result under
the check id for the triage page to read, and every other hygiene page runs
its check unfiltered. Writing a searched, sorted result under tableList
would hand triage one operator's search results as the database's state."
```

---

## Task 5: the Table page

Spec §5.3. Every panel comes from a check asked about one relation.

**Files:**
- Create: `apps/web/app/db/[name]/tables/[relation]/page.tsx`
- Create: `apps/web/test/table-page.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–3, plus `SERIES.relationSpace` and
  `runSeriesFor` exactly as `cleanup/space/[relation]/page.tsx:42-44` uses
  them, and `LineChart`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/table-page.test.tsx`:

```tsx
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
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project web table-page`
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Write the page**

Create `apps/web/app/db/[name]/tables/[relation]/page.tsx`. The shape follows
`cleanup/space/[relation]/page.tsx` — which is the simplest page idiom in the
app and is this page's own first panel.

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CHECKS, SERIES } from '@pgops/checks';
import { runCheckFor, runSeriesFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { LineChart } from '@/components/line-chart';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAgo, formatBytes, formatCount } from '@/lib/format';

const DAYS = 30;
const MAX_POINTS = 500;

export async function generateMetadata(
  { params }: { params: Promise<{ name: string; relation: string }> },
): Promise<Metadata> {
  const { name, relation } = await params;
  return { title: `${name} · ${relation}` };
}

/**
 * ONE TABLE, and everything pgops knows about it (design §5.3).
 *
 * Eight pages render a relation name and none of them was about that
 * relation; this is the page that is. Every panel below comes from a check
 * ASKED about this one relation rather than from filtering a capped list —
 * see §5.2, and `RelationOpts` in packages/checks/src/checks/indexes.ts. A
 * table outside every cap would otherwise render every fact as an em dash,
 * which is this console's display for "we could not look" and would be
 * showing it for "we did not ask".
 *
 * `relation` arrives ALREADY DECODED from Next — `EntityLink` encoded it, and
 * decoding again would corrupt a name containing a literal percent.
 *
 * No `<Refresh>`: nothing here moves in five seconds, and guards.test.ts
 * holds that from the source side.
 */
export default async function TablePage({ params }: {
  params: Promise<{ name: string; relation: string }>;
}) {
  const { name, relation } = await params;
  const opts = { relation };

  const [table, xid, indexes, unused, duplicates, invalid, seqs, history] = await Promise.all([
    runCheckFor(name, CHECKS.tableList, opts),
    runCheckFor(name, CHECKS.autovacuumDanger, opts),
    runCheckFor(name, CHECKS.indexList, opts),
    runCheckFor(name, CHECKS.unusedIndexes, opts),
    runCheckFor(name, CHECKS.duplicateIndexes, opts),
    runCheckFor(name, CHECKS.invalidIndexes, opts),
    runCheckFor(name, CHECKS.sequences, opts),
    runSeriesFor(name, SERIES.relationSpace,
      { from: new Date(Date.now() - DAYS * 24 * 3_600_000), to: new Date() },
      { databaseName: name, relation, maxPoints: MAX_POINTS }),
  ]);

  // A 404 only when the check SUCCEEDED and found nothing. `ok: false` is
  // "we could not look", and answering that with "no such table" would send
  // an operator to correct a name that was right.
  if (table.ok && table.data.tables.length === 0) notFound();

  return (
    <div className="grid gap-4">
      <div>
        <Link href={`/db/${name}/tables`} className="text-sm underline underline-offset-2">
          ← All tables
        </Link>
        <h1 className="mt-2 font-mono font-medium">{relation}</h1>
      </div>

      <CheckPanel title="This table" result={table}>
        {(d) => {
          const t = d.tables[0];
          if (t === undefined) return null;
          return (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <Fact label="Size" value={formatBytes(t.sizeBytes)} />
              <Fact label="Live rows" value={formatCount(t.liveRows)} />
              <Fact label="Dead rows" value={formatCount(t.deadRows)} />
              <Fact
                label="Cache hit"
                value={t.hitRate === null ? 'no heap I/O recorded' : `${(t.hitRate * 100).toFixed(1)}%`}
              />
              <Fact label="Last vacuum" value={formatAgo(t.lastVacuum) ?? 'never'} />
              <Fact label="Last analyze" value={formatAgo(t.lastAnalyze) ?? 'never'} />
              <Fact label="Index scans" value={formatCount(t.idxScans)} />
              <Fact label="Sequential scans" value={formatCount(t.seqScans)} />
            </dl>
          );
        }}
      </CheckPanel>

      <CheckPanel title="Transaction age" result={xid}>
        {(d) => {
          const r = d.relations[0];
          return r === undefined
            ? <p className="text-sm text-muted-foreground">No reading for this relation.</p>
            : (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <Fact label="Transaction age" value={formatCount(r.xactAge)} />
                <Fact label="Transactions remaining" value={formatCount(r.txnsRemaining)} />
              </dl>
            );
        }}
      </CheckPanel>

      <CheckPanel title="Indexes" result={indexes}>
        {(d) => (d.indexes.length === 0
          ? <p className="text-sm text-muted-foreground">No indexes on this table.</p>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Index</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.indexes.map((i) => (
                  <TableRow key={i.name}>
                    <TableCell className="font-mono text-xs">{i.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(i.sizeBytes)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {flagsFor(i.name, { unused, duplicates, invalid }).join(' · ') || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ))}
      </CheckPanel>

      <CheckPanel title="Sequences" result={seqs}>
        {(d) => (d.sequences.length === 0
          ? <p className="text-sm text-muted-foreground">No sequence feeds a column of this table.</p>
          : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              {d.sequences.map((s) => (
                <Fact
                  key={s.name}
                  label={s.column === null ? s.name : `${s.name} → ${s.column}`}
                  value={s.pctUsed === null ? 'unreadable' : `${s.pctUsed.toFixed(2)}% of its range`}
                />
              ))}
            </dl>
          ))}
      </CheckPanel>

      <Growth relation={relation} history={history} />
    </div>
  );
}
```

Then the three helpers, at the bottom of the same file:

```tsx
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/**
 * The flags on one index, from the three finding checks.
 *
 * A check that FAILED contributes no flag and no silence: it is rendered as
 * its own panel above only when it fails alone, so the honest thing here is
 * to say the flags are incomplete rather than to imply the index is clean.
 * `verdict: null` is not `ok`, and neither is a finding list nobody could
 * read.
 */
function flagsFor(
  index: string,
  checks: { unused: unknown; duplicates: unknown; invalid: unknown },
): string[] {
  const out: string[] = [];
  const has = (r: unknown, pick: (d: never) => readonly { name: string }[]) => {
    const res = r as { ok: boolean; data?: unknown };
    if (!res.ok) return null;
    return pick(res.data as never).some((x) => x.name === index);
  };
  const add = (label: string, hit: boolean | null) => {
    if (hit === true) out.push(label);
    if (hit === null) out.push(`${label}?`);
  };
  add('unused', has(checks.unused, (d: { indexes: { name: string }[] }) => d.indexes));
  add('duplicate', has(checks.duplicates, (d: { pairs: { name: string }[] }) => d.pairs));
  add('invalid', has(checks.invalid, (d: { indexes: { name: string }[] }) => d.indexes));
  return out;
}

/** Copied in shape from cleanup/space/[relation], which this panel replaces. */
function Growth({ relation, history }: {
  relation: string;
  history: Awaited<ReturnType<typeof runSeriesFor<{ capturedAt: Date; sizeBytes: number }>>>;
}) {
  if (!history.ok) {
    return (
      <div className="rounded border p-3 text-sm">
        <p>{history.message}</p>
        {history.remedy === undefined ? null : (
          <p className="mt-1 text-muted-foreground">{history.remedy}</p>
        )}
      </div>
    );
  }
  if (history.points.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough history captured yet for {relation}.
      </p>
    );
  }
  return (
    <div>
      <h2 className="mb-2 border-b pb-2 font-medium">Size over {DAYS} days</h2>
      <LineChart
        points={history.points.map((p) => ({ at: p.capturedAt, value: p.sizeBytes }))}
        label={`${relation} size over ${DAYS} days`}
        format={formatBytes}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web table-page guards`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/db/[name]/tables/[relation]/page.tsx" apps/web/test/table-page.test.tsx
git commit -m "feat: a page that is about a table

Eight pages render a relation name and none of them was about that relation.
This is the one that is.

Every panel comes from a check asked about this one relation rather than
from filtering a capped list. A table outside every cap would otherwise show
an em dash for every fact — this console's display for \"we could not look\"
— while the truth was that nothing had asked.

The 404 fires only when the check SUCCEEDED and found nothing. ok: false is
\"we could not look\", and answering that with \"no such table\" sends an
operator to correct a name that was right.

An index whose finding check failed is flagged \"unused?\", not left blank:
a flag list nobody could read is not the same as a clean index."
```

---

## Task 6: navigation, redirects, and the tests that encode the old shape

The slice is invisible until the console links to it, and three old routes
now have a better answer. This task is where spec §4's named consequence
lands: **the tabs stop being 1:1 with gates.**

**Files:**
- Modify: `apps/web/components/nav.tsx`
- Modify: `apps/web/test/nav.test.tsx` (rewrite one test, deliberately)
- Modify: `apps/web/app/db/[name]/queries/tables/page.tsx` → redirect
- Modify: `apps/web/app/db/[name]/cleanup/space/page.tsx` → redirect
- Modify: `apps/web/app/db/[name]/cleanup/space/[relation]/page.tsx` → redirect
- Modify: `apps/web/app/db/[name]/cleanup/maintenance/page.tsx` → redirect
- Modify: `apps/web/app/db/[name]/queries/layout.tsx`, `cleanup/layout.tsx` (sub-nav items)
- Modify: `apps/web/test/sub-nav-layouts.test.tsx` (exact href lists)
- Modify: `packages/checks/src/checks/areas.ts` (area `href`s)
- Delete: `apps/web/test/space-detail-page.test.tsx`, `cleanup-subroutes.test.tsx`'s space
  and maintenance cases — the pages they test become redirects.

- [ ] **Step 1: Add the tab**

In `apps/web/components/nav.tsx`, add to `TABS` after `queries`:

```ts
  { segment: 'tables', href: '/tables', label: 'Tables' },
```

and extend the component's docblock:

```
 * THE TAB STRIP IS NO LONGER THE FOUR GATES, and that is a decision rather
 * than a drift. The design of 2026-09-23 §4 splits the console on LIVENESS:
 * the gates are what is wrong right now, and they survive as the bands on
 * the triage page; Tables is an object, it carries history, it does not
 * poll, and it belongs to three gates at once — which is exactly why no gate
 * could own it and why it had no page until now. test/nav.test.tsx holds the
 * half of the old property that is still true.
```

- [ ] **Step 2: Rewrite the nav test**

In `apps/web/test/nav.test.tsx`, keep `has a tab for every gate` unchanged.
Replace `carries no tab that is not a gate` with:

```tsx
  /**
   * REWRITTEN, NOT DELETED. The old form asserted that the tab strip carried
   * the four gates and nothing else, which was gates.ts's claim and stopped
   * being true on purpose — see the design of 2026-09-23 §4, which names this
   * as the consequence to accept. What survives is the property that actually
   * protects the strip: nothing appears on it by accident. Every tab is
   * either a gate or a named member of the object layer, and a route promoted
   * to the top level by mistake is neither.
   */
  it('carries only gates and the object pages named here', async () => {
    rendered = await render(<Nav name="prod" />);
    const hrefs = [...rendered.container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '');
    const gates = GATE_ORDER.map((g) => (GATE_TAB[g] === '' ? '/db/prod' : `/db/prod/${GATE_TAB[g]}`));
    const objects = ['/db/prod/tables'];
    expect(hrefs.filter((h) => !new Set([...gates, ...objects]).has(h))).toEqual(['/db/prod']);
  });
```

- [ ] **Step 3: Run the nav tests**

Run: `npx vitest run --project web nav`
Expected: PASS.

- [ ] **Step 4: Replace the three superseded pages with redirects**

Replace the whole body of `apps/web/app/db/[name]/queries/tables/page.tsx`:

```tsx
import { redirect } from 'next/navigation';

/**
 * SUPERSEDED, not deleted, because a bookmark is a promise.
 *
 * This page was the unused-tables half of the work gate. Both of its
 * questions are orderings of the Tables list now (design §5.1): "unused" is
 * a filter, and the caching reading is a column. A permanent redirect is the
 * honest answer — the page did not vanish, it became a parameter.
 */
export default async function Tables({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  redirect(`/db/${name}/tables?only=unused`);
}
```

`cleanup/space/page.tsx` redirects to `/db/${name}/tables?sort=size`;
`cleanup/maintenance/page.tsx` to `/db/${name}/tables?sort=vacuum`;
`cleanup/space/[relation]/page.tsx` to
`` `/db/${name}/tables/${encodeURIComponent(relation)}` `` — re-encoding
because `redirect` takes a URL and the param arrived decoded.

- [ ] **Step 5: Update the sub-nav strips and their test**

In `apps/web/app/db/[name]/queries/layout.tsx`, remove the `tables` item. In
`cleanup/layout.tsx`, remove `space` and `maintenance`, leaving `sequences`.

In `apps/web/test/sub-nav-layouts.test.tsx`, update both exact href lists:

```tsx
      expect(hrefs(rendered)).toEqual([
        '/db/prod/queries', '/db/prod/queries/indexes', '/db/prod/queries/explain',
      ]);
```
```tsx
      expect(hrefs(rendered)).toEqual([
        '/db/prod/cleanup', '/db/prod/cleanup/sequences',
      ]);
```

Note the Queries strip's active-segment assertion still points at `indexes`,
which the mock returns, so it is unchanged.

- [ ] **Step 6: Move the area hrefs**

In `packages/checks/src/checks/areas.ts`, the `href` is what the triage band
links to. Three areas now answer at the new route:

```ts
  { id: 'tables',      label: 'Tables',      href: 'tables',              band: 'work',    members: [...] },
  { id: 'space',       label: 'Space',       href: 'tables?sort=size',    band: 'keep-up', members: [...] },
  { id: 'maintenance', label: 'Maintenance', href: 'tables?sort=vacuum',  band: 'keep-up', members: [...] },
```

- [ ] **Step 7: Retire the superseded page tests**

Delete `apps/web/test/space-detail-page.test.tsx` and remove the space and
maintenance cases from `apps/web/test/cleanup-subroutes.test.tsx`. Add one
test in their place, in `apps/web/test/tables-list-page.test.tsx`:

```tsx
/**
 * A bookmark is a promise. These three routes were each one ordering of the
 * Tables list; they now say so rather than 404ing, and the parameter they
 * carry is the ordering they used to be.
 */
describe('the superseded routes', () => {
  it('redirect to the ordering they used to be', async () => {
    const { default: OldSpace } = await import('@/app/db/[name]/cleanup/space/page');
    await expect(OldSpace({ params: Promise.resolve({ name: 'prod' }) }))
      .rejects.toThrow(/NEXT_REDIRECT/);
  });
});
```

with `redirect` mocked alongside `notFound` in that file's
`vi.mock('next/navigation', …)`.

- [ ] **Step 8: Run everything, and run the app**

```bash
npx vitest run --project unit
npx vitest run --project web
npx vitest run --project integration
npm run build --workspace=apps/web
```

Then DRIVE IT, which is the step that finds what the suite cannot: start the
console against a seeded database, open `/db/<name>/tables`, and check by
hand —

- the page scrolls to its end with a wheel, and the terminator rule is visible;
- each preset changes the order and stays lit;
- a search narrows the list and the "Showing N of M" line reports matches;
- clicking a table name opens its page, and the browser's back button returns
  to the same sort and search;
- a table name containing a percent or a slash still opens;
- at 768px nothing scrolls sideways — measure
  `document.documentElement.scrollWidth` against `clientWidth`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: Tables gets a tab, and three routes become parameters

The design of 2026-09-23 §4 names this as the consequence to accept: the tab
strip stops being 1:1 with the gates. Tables is an object — it carries
history, it does not poll, and it belongs to three gates at once, which is
exactly why no gate could own it and why it had no page until now. The gates
survive as the triage bands.

nav.test.tsx's \"carries no tab that is not a gate\" is REWRITTEN, not
deleted. What survives is the property that actually protects the strip:
nothing appears on it by accident.

queries/tables, cleanup/space and cleanup/maintenance redirect rather than
404, carrying the ordering they used to be. A bookmark is a promise, and
those pages did not vanish — they became parameters."
```

---

## Self-review

**Spec coverage.** §5.1's collapse → Tasks 4 and 6. §5.2's one-relation rule →
Tasks 1, 2, 5, and its test in Task 5 Step 1. §5.3's panel table → Task 5,
with two panels deferred and named below. §6.1 → Task 3, with the spec's
claim about `Findings` corrected in place. §6.2 → Tasks 1 and 4. §6.3 →
Task 4. §8's slice definition → all six tasks.

**Deferred from §5.3, deliberately, and recorded rather than silently
dropped:** the *suggested index* panel (`missingIndexes` has no `relation`
opt in this plan — it is keyed by table and could gain one, but its reading
is a whole-database ranking and a single-relation call would report a
suggestion without the comparison that justifies it), and the *ANALYZE*
action (the actions layer is flag-gated and has its own confirm flow; wiring
it belongs with the other actions, not with a read-only slice). Both belong in
the next slice, and neither is a placeholder here: the Table page ships
without them and says nothing false in their absence.

**Type consistency.** `TableListEntry` / `TableListData` / `TableSort` /
`TABLE_SORTS` / `TableListOpts` are used with the same names in Tasks 1, 4
and 5. `RelationOpts` is defined once in `indexes.ts` (Task 2) and imported by
`maintenance.ts` and `sequences.ts`. `withParam` and `EntityLink` signatures
in Task 3 match their call sites in Tasks 4 and 5. `sqlFor` is exported from
`table-list.ts` because the unit test reaches `tableList.sql` through it.

**One known gap the executor must not paper over.** Task 4's page imports
`TableListEntry` as a type from `@pgops/checks`; that works only because
`index.ts` carries `export type * from './checks/table-list.js'`, which
Task 1 Step 4 adds. If the type does not resolve, the export line is missing —
add it rather than re-declaring the shape in the web layer.
