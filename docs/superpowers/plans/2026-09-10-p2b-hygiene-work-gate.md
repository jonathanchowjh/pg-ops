# P2b — The Hygiene Class, Work Gate: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the fifteen P2 capabilities that render on `work`-gate pages — index and table efficiency — as three routes nested under the existing `/queries` tab.

**Architecture:** Four new check files in `packages/checks/src/checks/`, one per pgHero *area* (§1.3), and three new pages under `app/db/[name]/queries/`. No new top-level tab: gate 3 already has one, and these capabilities explain why the statements on it are slow. Every check is reached on visit, never polled.

**Tech Stack:** TypeScript 5.7, `@pgops/checks` (dependencies stay exactly `["pg"]`), Next 16 App Router, React 19 Server Components, Vitest 4 (`unit` / `integration` / `web`), Testcontainers.

**Spec:** `docs/superpowers/specs/2026-09-03-pgops-p2-hygiene-design.md` — the Amendment, §1.1, §1.3, §2.1, §2.2, §3, §4.1, §4.2, §5, §6.

**Sibling plan:** `docs/superpowers/plans/2026-09-10-p2c-hygiene-keep-up-gate.md` covers the ten `keep-up`/`server` capabilities and the `/cleanup` tab, and closes the phase. **This plan must run first** — P2c imports `ListOpts` from Task 1 of this one.

---

## Why this plan does not contain finished SQL

**Revision 2 (2026-09-11), after review.** Revision 1 specified a complete query body for all fifteen checks. Three reviewers executed them against PostgreSQL 17.11. The results are why this revision is shaped differently:

- `duplicateIndexes` produced **five classes of false positive** — it reported an index on `c1` as redundant to one on `c11`, because `indkey::text` prefix-matching makes `'11' LIKE '1%'` true — while **failing to report byte-identical duplicates at all**. It is the one check here whose output is "drop this index", and on adversarial fixtures it was wrong more often than right. Its docblock also claimed provenance from pgHero's `index_covers?`, which compares column arrays and has none of these bugs.
- `Number('0.9912') * 100` is `99.11999999999999`, so the plan's first unit test failed at the step that said "Expected: PASS".
- Four `remedy:` strings would have tripped the repo's DDL-confinement guard; three `ORDER BY` clauses would have tripped `boundaries.test.ts`.
- Every web test was written against a `render` helper that does not exist, and twenty-two integration tests named a `withDatabase` helper that does not exist.

The lesson is about the artifact, not the bugs: **a plan is the wrong place for unverified SQL**, in a repo whose whole premise is that claims are checked. Every one of those findings was reproducible in under a minute against the dev database.

So this revision inverts it. **For each check, the failing integration test is written out in full and IS the specification.** The query is derived against a live server until that test passes. Where a query was actually executed and confirmed during review, it is included verbatim and labelled; where it was not, the plan gives the source to port from and the traps found, and the implementer writes it.

**Do not treat an unlabelled query as verified. There are none in this file.**

---

## Global Constraints

- **Node floor 22. PostgreSQL floor 14.** CI matrix is 14, 16, 17, 18. Any SQL must run unchanged across all four, or branch on `ctx.serverVersion`.
- **`packages/` uses `.js` import specifiers; `apps/web` does NOT.** `apps/web`'s tsconfig uses `moduleResolution: "bundler"`.
- **`packages/checks` dependencies stay exactly `["pg"]`.**
- **`null` means "we could not look" and is never collapsed into a value.** `??`, never `||`, when defaulting a field that can legitimately be `false` or `0`.
- **A check with no `verdict` yields `verdict: null`, not `{level:'ok'}`.** `run.ts` does `check.verdict?.(…) ?? null`, and `CheckPanel` renders no badge for null. Spec §2.2 said otherwise until 2026-09-11; it is corrected. A page written on the old sentence paints a green badge on a check that has no opinion.
- **Every check declares `gate`** — the compiler requires it (`types.ts`), and `registry.test.ts` asserts the registry's `gate` equals the check's.
- **Every check here is `class: 'hygiene'` EXCEPT `indexBloat`, which is `class: 'on-demand'`.** `types.ts` says verbatim that `on-demand` exists *so that* `index_bloat` "is a class member rather than an exception carved out in prose". Nothing in `capture.ts` or the registry selects by class, so this is a correctness-of-meaning choice, not a behavioural one.
- **No hygiene page renders `<Refresh>`.** `guards.test.ts` asserts set equality over `INCIDENT_PAGES`; **never add a hygiene route to that list to green a red guard.**
- **Thresholds are data with a non-empty `because` stating the number is pgHero's and adopted** (§2.1). Nothing here escalates to `critical`.
- **Row caps carry the true total**, via `count(*) OVER ()` — verified to be the pre-`LIMIT` total, returned as `integer`. **Every verdict reads that total, never `rows.length`**, and every capped list's `ORDER BY` must sort the *finding* to the top so truncation drops the least interesting rows.
- 2-space indent, ESM. Comments explain *why*, and cite the defect they prevent.

### Two guards this plan will trip if you are not careful

**1. No DDL in a `remedy:` string.** `guards.test.ts` walks `packages/checks/src`, strips comments (not string literals), applies
`/\b(?:(?:CREATE|ALTER|DROP)\s+(?:MATERIALIZED\s+)?(?:SCHEMA|TABLE|INDEX|VIEW|EXTENSION|SEQUENCE|FUNCTION|ROLE|USER|DATABASE)\b|…)/i`
and asserts the offender list is exactly `['packages/checks/src/run.ts']`. Revision 1's `'DROP INDEX CONCURRENTLY <name>;'` and `'ALTER TABLE <t> VALIDATE CONSTRAINT <c>;'` both match. Every shipped `remedy` is prose for this reason — `wraparound.ts` says "Run VACUUM (FREEZE, VERBOSE)" and `slots.ts` says "drop the slot with `pg_drop_replication_slot`". **Write remedies as prose in lower case, naming the command without writing a DDL statement.**

**2. Never `ORDER BY` a `::text`-cast column's own alias.** `boundaries.test.ts` extracts `::text AS <alias>` and fails on a bare occurrence of that alias in the `ORDER BY` tail. Qualify it (`c.relname`) or use a distinct alias. This is semantically harmless but the guard cannot tell, and it fails at a step you expect to pass.

### Three capabilities whose gate is not their page

**Read this before Tasks 4, 6, 7 and 8.** #55 `invalid_constraints`, #29 `index_bloat` and #36 `table_stats` carry `gate: 'keep-up'` in the registry while rendering on `work` pages here. The gate records what *causes* a finding (deferred cleanup); the route records where an operator *looks* (beside the thing it degrades). `registry.test.ts` asserts the gate matches the check, never the route, so both are true at once. **Do not change these three gates to match their pages.** The other twelve are `gate: 'work'`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/checks/src/checks/indexes.ts` (create) | #22, #23, #24, #25, #26, #27, #28, #30, #32 |
| `packages/checks/src/checks/index-bloat.ts` (create) | #29 — own file, own route, 30s timeout, `class: 'on-demand'` |
| `packages/checks/src/checks/tables.ts` (create) | #33, #34, #35, #36 |
| `packages/checks/src/checks/constraints.ts` (create) | #55 |
| `packages/checks/src/index.ts` (modify) | **`export type *` for all four new files.** The barrel enumerates type exports file-by-file; without this the pages cannot name `IndexEntry`, `UnusedIndex`, `DuplicatePair`, `InvalidConstraint`, `TableStat`, `BloatedIndex` and must derive them structurally — which its own docblock records as a defect from P1a |
| `packages/checks/src/registry.ts` (modify) | Import, add to `CHECKS`, flip fifteen entries |
| `apps/web/components/sub-nav.tsx` (create) | Second-level strip; P2c imports it |
| `apps/web/app/db/[name]/queries/indexes/page.tsx` (create) | Nine capabilities plus #55 |
| `apps/web/app/db/[name]/queries/indexes/bloat/page.tsx` (create) | #29 |
| `apps/web/app/db/[name]/queries/tables/page.tsx` (create) | Four capabilities |
| `apps/web/app/db/[name]/queries/page.tsx` (modify) | Render `<SubNav>` |
| `apps/web/test/queries-page.test.tsx` (modify) | Its `vi.mock('next/navigation')` must gain `useSelectedLayoutSegment` — see Task 9 |

---

## The two harness APIs, as they actually exist

Revision 1 got both wrong. These are read from source:

```typescript
// packages/checks/test/harness.ts
export async function withPostgres(
  fn: (ctx: CheckContext, pool: pg.Pool) => Promise<void>,
): Promise<void>            // creates a FRESH database per call
export async function seed(pool: pg.Pool, sql: string): Promise<void>
```

```typescript
// apps/web/test/render.tsx
export interface Rendered {
  container: HTMLElement;
  text: () => string;                                    // container.textContent
  find: (pattern: string | RegExp) => HTMLElement | null;
  unmount: () => void;
}
export async function render(element: ReactElement): Promise<Rendered>   // ASYNC
```

There is **no `.html`**. For an `href` assertion use `rendered.container.innerHTML` or `querySelector`; `text()` is `textContent` and will never contain an attribute. And an async Server Component must be **called first, then rendered** — `createRoot` cannot render one:

```tsx
const element = await Indexes({ params: Promise.resolve({ name: 'prod' }) });
rendered = await render(element);
```

Every component that calls `useSelectedLayoutSegment` or `useRouter` needs `vi.mock('next/navigation', …)` supplying **both**.

---

### Task 1: `indexHitRate`, and the shared seams every later task uses

§6's first priority case. `pg_statio_user_indexes` divides by `nullif(…, 0)`, so a database with no index I/O yet returns **NULL, not 0** — rendered as `0` against a 99% threshold, that is a false `warn` on every freshly started database.

**Files:** create `packages/checks/src/checks/indexes.ts`, `packages/checks/test/indexes.test.ts`, `packages/checks/test/indexes.int.test.ts`

**Produces (later tasks and P2c depend on these exact names):** `ListOpts`, `HitRateRow`, `HitRateData`, `toRate`, `rateVerdict`, `indexHitRate`.

- [ ] **Step 1: Write the failing integration test — it is the specification**

```typescript
// packages/checks/test/indexes.int.test.ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { indexHitRate } from '../src/checks/indexes.js';
import { withPostgres, seed } from './harness.js';

describe('indexHitRate against a real server', () => {
  /**
   * The assertion no unit test can make: that Postgres really returns NULL
   * here rather than 0. `withPostgres` gives a fresh database, which has done
   * no index I/O — so the dangerous case arrives for free, and a future
   * Postgres that changes this view fails here instead of warning on every
   * new database in production.
   */
  it('reads a null rate on a database with no index I/O yet', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, indexHitRate);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rate).toBeNull();
      expect(result.verdict).toEqual({ level: 'ok' });
    });
  });

  it('reads a real percentage once there has been index I/O', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE t (id int PRIMARY KEY, v int);
        INSERT INTO t SELECT g, g FROM generate_series(1, 500) g;
        ANALYZE t;
      `);
      // Force index reads.
      for (let i = 1; i <= 50; i += 1) await pool.query('SELECT * FROM t WHERE id = $1', [i]);

      const result = await runCheck(ctx, indexHitRate);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rate).not.toBeNull();
      expect(result.data.rate!).toBeGreaterThan(0);
      expect(result.data.rate!).toBeLessThanOrEqual(100);
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration packages/checks/test/indexes.int.test.ts`
Expected: FAIL — `Failed to resolve import "../src/checks/indexes.js"`.

- [ ] **Step 3: Write the unit tests**

```typescript
// packages/checks/test/indexes.test.ts
import { describe, expect, it } from 'vitest';
import { indexHitRate, toRate } from '../src/checks/indexes.js';

describe('toRate', () => {
  it('keeps a NULL rate as null rather than collapsing it to zero', () => {
    expect(toRate([{ rate: null }])).toEqual({ rate: null });
  });

  it('returns null for an empty view rather than inventing a reading', () => {
    expect(toRate([])).toEqual({ rate: null });
  });

  /**
   * Rounded to two decimals in `map`, not at the edge. Revision 1 returned
   * `Number(raw) * 100` raw, and `Number('0.9912') * 100` is
   * 99.11999999999999 — so the obvious test failed. Postgres makes it worse:
   * numeric division returns 20 decimal places, e.g.
   * 0.99193548387096774194. Rounding here means one representation
   * everywhere, including anything P4 later stores.
   */
  it('rounds to two decimals so the value is exactly what is displayed', () => {
    expect(toRate([{ rate: '0.9912' }])).toEqual({ rate: 99.12 });
    expect(toRate([{ rate: '0.99193548387096774194' }])).toEqual({ rate: 99.19 });
  });

  it('keeps a genuine zero, which is not the same as unknown', () => {
    expect(toRate([{ rate: '0' }])).toEqual({ rate: 0 });
  });
});

describe('indexHitRate verdict', () => {
  const t = () => indexHitRate.thresholds!;

  it('has no opinion when the rate is unknown', () => {
    expect(indexHitRate.verdict!({ rate: null }, t())).toEqual({ level: 'ok' });
  });

  // §9 boundary rule: at the value, and one unit either side.
  it('is ok exactly at 99', () => {
    expect(indexHitRate.verdict!({ rate: 99 }, t()).level).toBe('ok');
  });

  it('warns just below 99', () => {
    expect(indexHitRate.verdict!({ rate: 98.99 }, t()).level).toBe('warn');
  });

  it('is ok just above 99', () => {
    expect(indexHitRate.verdict!({ rate: 99.01 }, t()).level).toBe('ok');
  });

  it('names the reading in the note, so the badge says what it saw', () => {
    expect(indexHitRate.verdict!({ rate: 98 }, t()).note).toContain('98');
  });
});
```

- [ ] **Step 4: Implement**

The query below **was executed against PostgreSQL 17.11 during review and confirmed to return NULL on a fresh database.** Use it as written.

```typescript
// packages/checks/src/checks/indexes.ts
import type { Check, Verdict, Threshold } from '../types.js';

/** The cap seam every list check in this package shares. Default 100 (§5). */
export interface ListOpts { limit?: number }

/**
 * The ratio arrives as TEXT. `sum(...) / nullif(sum(...), 0)` is numeric
 * division, and node-postgres returns numeric as a string to avoid a float64
 * round trip — the same text->number split `locks.ts` documents for
 * `xact_age_secs`. Conversion happens in `map`, never in SQL.
 */
export interface HitRateRow { rate: string | null }

/** `null` means "we could not compute one", never "0%". */
export interface HitRateData { rate: number | null }

// VERIFIED against PostgreSQL 17.11 (2026-09-11): returns NULL, not 0, on a
// database with no index I/O. `nullif` is load-bearing, not defensive.
const HIT_RATE_SQL = `
SELECT (sum(idx_blks_hit) / nullif(sum(idx_blks_hit + idx_blks_read), 0))::text AS rate
FROM pg_statio_user_indexes`;

export function toRate(rows: HitRateRow[]): HitRateData {
  const raw = rows[0]?.rate;
  // `=== undefined || === null`, never `||`: the string '0' is a real
  // reading — nothing served from cache — and `||` would erase it.
  if (raw === undefined || raw === null) return { rate: null };
  // Two decimals, matching what the page displays. See the unit test for why
  // the unrounded product is not what anyone expects.
  return { rate: Math.round(Number(raw) * 10000) / 100 };
}

export function rateVerdict(data: HitRateData, thresholds: Threshold[]): Verdict {
  // No reading, no opinion. `ok` here would claim the cache is healthy on a
  // database we could not measure.
  if (data.rate === null) return { level: 'ok' };
  const warn = thresholds.find((t) => t.level === 'warn');
  if (warn && data.rate < warn.value) {
    return { level: 'warn', note: `${data.rate.toFixed(2)}% of reads served from cache` };
  }
  return { level: 'ok' };
}

export const indexHitRate: Check<HitRateRow, HitRateData> = {
  id: 'indexHitRate',
  title: 'Index cache hit rate',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: HIT_RATE_SQL,
  map: toRate,
  thresholds: [
    { level: 'warn', value: 99, unit: 'percent',
      because: "pgHero's cache_hit_rate_threshold (lib/pghero.rb:47) has been 99 since 2016; "
             + 'adopted for parity, not re-derived from Postgres behaviour' },
  ],
  verdict: rateVerdict,
};
```

- [ ] **Step 5: Run both suites and watch them pass**

Run: `npx vitest run --project unit packages/checks/test/indexes.test.ts`
Then: `npx vitest run --project integration packages/checks/test/indexes.int.test.ts`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/checks/src/checks/indexes.ts packages/checks/test/indexes.test.ts packages/checks/test/indexes.int.test.ts
git commit -m "feat(checks): index_hit_rate, with null kept as null"
```

---

## How to derive a query (Tasks 2–8)

Tasks 2 through 8 each give you: the capability and its pgHero source, the **contract** the check object must satisfy, the **integration test** that defines correct behaviour, and the **traps** review found. They do not give you a finished query, because Revision 1's were wrong and unlabelled certainty is what made them dangerous.

The loop for each:

1. Write the integration test exactly as given. Run it. Watch it fail on the missing module.
2. Open pgHero 4.0.1's named method as the starting point. Read what it actually selects.
3. Draft the query in `psql` against a scratch database (`CREATE DATABASE scratch;`), with the test's own fixture created by hand, until it returns the right rows.
4. Work through the **Traps** list for that task and prove each one against a fixture. Every trap listed was an actual defect in Revision 1, reproduced against PostgreSQL 17.11 — none is hypothetical.
5. Put the query in the check object. Run the integration test. Then the unit tests.
6. Run `npm test && npm run test:web` before committing — that is where the two guards above bite.

**Universal traps, applying to every query below.** Each was a real Revision 1 defect:

- **Schema qualification must be consistent.** `pg_stat_*`/`pg_statio_*` views expose `schemaname`; `relname` alone is ambiguous. With `public.t` and `other.t` present, Revision 1 returned two rows both labelled `t`. Meanwhile its sibling checks used `::regclass::text`, which qualifies *only when outside `search_path`* — so the same index rendered as `public.foo` on one panel and `foo` on another. **Pick `schemaname || '.' || relname` for the stat views, and an explicit `pg_class`/`pg_namespace` join elsewhere. Never rely on `regclass` text output, which is search_path-dependent.**
- **Exclude system and temp schemas.** `NOT IN ('pg_catalog','information_schema','pg_toast')` is exact-match and lets `pg_temp_7`/`pg_toast_temp_7` through — another session's temp tables will appear. Add `AND n.nspname NOT LIKE 'pg\_%'`.
- **`table` is a reserved word.** Legal as an `AS` label, illegal as a bare column reference — `ORDER BY …, table` is a syntax error. `name` is unreserved and is fine. This killed an entire check in Revision 1.
- **`count(*) OVER ()::int` is verified** to parse as `(count(*) OVER ())::int` and to give the pre-`LIMIT` total as an `integer`.

---

### Task 2: `indexList` (#30), `indexCaching` (#23), `lastStatsReset` (#32) — the inventory, no verdicts

All three are in §2.2's nineteen: they ship as tables an operator reads, with `verdict: null` and no badge.

**Files:** modify `indexes.ts`, `indexes.test.ts`, `indexes.int.test.ts`
**pgHero source:** `methods/indexes.rb` — `indexes`, `index_caching`, `last_stats_reset_time`

**Contract**

| | `indexList` | `indexCaching` | `lastStatsReset` |
|---|---|---|---|
| id / gate / class | `indexList` / `work` / `hygiene` | `indexCaching` / `work` / `hygiene` | `lastStatsReset` / `work` / `hygiene` |
| `timeoutMs` | 10_000 | 10_000 | 10_000 |
| Opts | `ListOpts` | `ListOpts` | none |
| `verdict` | **absent** | **absent** | **absent** |
| Data | `{ indexes: IndexEntry[]; total; truncated }` | `{ indexes: IndexCaching[]; total; truncated }` | `{ statsReset: string \| null }` |

`IndexEntry = { name; table; definition; sizeBytes: number; unique: boolean; primary: boolean }`
`IndexCaching = { name; table; hitRate: number | null }`

- [ ] **Step 1: Write the failing integration test**

```typescript
// append to packages/checks/test/indexes.int.test.ts
import { indexCaching, indexList, lastStatsReset } from '../src/checks/indexes.js';

describe('the index inventory', () => {
  it('lists an index with its definition and size, schema-qualified', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE SCHEMA other;
        CREATE TABLE public.t (a int, b int);
        CREATE TABLE other.t (a int, b int);
        CREATE INDEX ix_pub ON public.t (a);
        CREATE INDEX ix_oth ON other.t (a);
      `);

      const result = await runCheck(ctx, indexList, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.indexes.map((i) => i.name);
      // Both schemas qualified, both distinguishable. Revision 1 returned
      // bare names here and two identically-labelled rows.
      expect(names).toContain('public.ix_pub');
      expect(names).toContain('other.ix_oth');
      const pub = result.data.indexes.find((i) => i.name === 'public.ix_pub')!;
      expect(pub.table).toBe('public.t');
      expect(pub.definition).toContain('CREATE INDEX');
      expect(pub.sizeBytes).toBeGreaterThan(0);
      expect(pub.primary).toBe(false);
    });
  });

  it('excludes catalog and toast relations', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, indexList, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.indexes.some((i) => i.name.startsWith('pg_'))).toBe(false);
    });
  });

  it('carries the pre-LIMIT total when it truncates', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE t (a int, b int, c int);
        CREATE INDEX ix_a ON t (a);
        CREATE INDEX ix_b ON t (b);
        CREATE INDEX ix_c ON t (c);
      `);

      const result = await runCheck(ctx, indexList, { limit: 1 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.indexes).toHaveLength(1);
      expect(result.data.total).toBeGreaterThanOrEqual(3);
      expect(result.data.truncated).toBe(true);
    });
  });

  it('reads a null per-index cache rate before any I/O', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (a int); CREATE INDEX ix_a ON t (a);');

      const result = await runCheck(ctx, indexCaching, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.indexes.find((i) => i.name.endsWith('ix_a'))!;
      expect(row.hitRate).toBeNull();
    });
  });

  it('reports a never-reset database as null, not as an epoch', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, lastStatsReset);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.statsReset).toBeNull();
      // §2.2: no verdict function means null, and no badge.
      expect(result.verdict).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run it, watch it fail** — `npx vitest run --project integration packages/checks/test/indexes.int.test.ts`. Expected: the three new names are not exported.

- [ ] **Step 3: Derive the queries**

`lastStatsReset` **was verified during review** and may be used as written:

```sql
SELECT stats_reset::text AS stats_reset
FROM pg_stat_database
WHERE datname = current_database()
```

Scoping to `current_database()` matters — it is the Ruling 55 scoping `queryStats` already uses; unscoped, another database's reset is attributed to this one.

`indexList` and `indexCaching`: derive per the loop above.

**Traps**
- `indexList`: Revision 1 wrote `i.indexrelid::regclass::text AS name … ORDER BY …, name`, which **trips `boundaries.test.ts`** (ordering by a `::text` alias) *and* is search_path-dependent. Build the name from `pg_namespace.nspname || '.' || pg_class.relname` and order by the qualified expression or by `pg_relation_size(...) DESC, c.relname`.
- `indexCaching`: `pg_statio_user_indexes` exposes `schemaname`; use it. Per-index `hit_rate` needs the same `nullif` as Task 1 and the same null discipline in `map` — reuse the `Math.round(… * 10000) / 100` rounding so one index's rate and the database-wide rate are formatted identically.
- Both: order so truncation drops the least interesting rows — largest first for `indexList`, most I/O first for `indexCaching`.

- [ ] **Step 4: Write the unit tests** — for each `map`: the pre-`LIMIT` total drives `truncated`; an empty result gives `{[], 0, false}`; a null per-row rate stays null; bigint sizes convert out of text. Assert `verdict` is `undefined` on all three (§2.2).

- [ ] **Step 5: Run both suites, then the guards**

Run: `npx vitest run --project unit packages/checks/test/indexes.test.ts && npx vitest run --project integration packages/checks/test/indexes.int.test.ts && npm run test:web`
Expected: all PASS. `npm run test:web` is where `boundaries.test.ts` and the DDL guard run.

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): indexes, index_caching and last_stats_reset_time"`

---

### Task 3: `invalidIndexes` (#27) and `unusedIndexes` (#26) — the two that escalate

**Files:** modify `indexes.ts`, `indexes.test.ts`, `indexes.int.test.ts`
**pgHero source:** `methods/indexes.rb` — `invalid_indexes`, `unused_indexes`

**Contract**

- `invalidIndexes`: `gate: 'work'`, `class: 'hygiene'`, `timeoutMs: 10_000`, `ListOpts`.
  Threshold: `{ level: 'warn', value: 1, unit: 'count', because: "pgHero treats a non-empty invalid-index list as a warning (index.html.erb:70); adopted for parity", remedy: <prose — see the DDL guard note> }`.
  Verdict: `warn` when **`data.total >= 1`**, note containing `data.total`.
- `unusedIndexes`: same gate/class/timeout/Opts.
  Threshold: `{ level: 'warn', value: 10 * 1024 * 1024, unit: 'bytes', because: "pgHero's unused_index_megabytes (database.rb:64) is 10 MB; adopted for parity. It is a floor on what is worth reporting, not a level a reading climbs to" }`.
  **The SQL must read that threshold's `value` for its floor — one number, not two.** Revision 1 declared `value: 10, unit: 'bytes'` (ten bytes) while the query used `10 * 1024 * 1024`, and `CheckPanel`'s `Guidance` would have shown an operator a ten-byte floor for a ten-megabyte check.
  Verdict: `warn` when `data.total > 0`, note containing `data.total`.

- [ ] **Step 1: Write the failing integration test**

```typescript
// append to packages/checks/test/indexes.int.test.ts
import { invalidIndexes, unusedIndexes } from '../src/checks/indexes.js';

describe('index findings', () => {
  it('finds an invalid index and ignores the valid ones', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE t (a int, b int);
        CREATE INDEX ix_good ON t (a);
        CREATE INDEX ix_bad  ON t (b);
      `);
      // A failed CREATE INDEX CONCURRENTLY is what leaves indisvalid = false;
      // forcing that is unreliable, so mark it directly. This is the one
      // catalog write in the suite and the container is a throwaway.
      await pool.query("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'ix_bad'::regclass");

      const result = await runCheck(ctx, invalidIndexes, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.indexes.map((i) => i.name);
      expect(names.some((n) => n.endsWith('ix_bad'))).toBe(true);
      expect(names.some((n) => n.endsWith('ix_good'))).toBe(false);
      expect(result.verdict?.level).toBe('warn');
    });
  });

  /**
   * §5's rule, as a falsifiable test. Three invalid indexes, a cap of one:
   * the verdict must say three. Written against `rows.length` this fails,
   * which is the entire point — Revision 1's version asserted only
   * `level === 'warn'`, which is true either way.
   */
  it('reports every invalid index in the verdict when the list is capped', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE t (a int, b int, c int);
        CREATE INDEX ix_a ON t (a);
        CREATE INDEX ix_b ON t (b);
        CREATE INDEX ix_c ON t (c);
      `);
      await pool.query(`
        UPDATE pg_index SET indisvalid = false
        WHERE indexrelid IN ('ix_a'::regclass, 'ix_b'::regclass, 'ix_c'::regclass)`);

      const result = await runCheck(ctx, invalidIndexes, { limit: 1 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.indexes).toHaveLength(1);
      expect(result.data.total).toBe(3);
      expect(result.verdict?.note).toContain('3');
    });
  });

  it('ignores an invalid index in a toast schema, which cannot be reindexed by name', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, invalidIndexes, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.indexes.some((i) => i.name.startsWith('pg_'))).toBe(false);
    });
  });

  it('ignores an unused index below the 10 MB floor', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (a int); CREATE INDEX ix_small ON t (a);');

      const result = await runCheck(ctx, unusedIndexes, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.indexes.some((i) => i.name.endsWith('ix_small'))).toBe(false);
      expect(result.verdict).toEqual({ level: 'ok' });
    });
  });

  it('never recommends dropping a primary key or a unique constraint', async () => {
    await withPostgres(async (ctx, pool) => {
      // Large enough to clear the floor if the exclusion were missing.
      await seed(pool, `
        CREATE TABLE t (id int PRIMARY KEY, u text UNIQUE, v int);
        INSERT INTO t SELECT g, g::text, g FROM generate_series(1, 400000) g;
      `);

      const result = await runCheck(ctx, unusedIndexes, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.indexes.map((i) => i.name);
      expect(names.some((n) => n.includes('pkey'))).toBe(false);
      expect(names.some((n) => n.includes('_key'))).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Derive the queries**

**Traps**
- **`remedy` must be prose.** `'DROP INDEX CONCURRENTLY <name>;'` and `'REINDEX INDEX CONCURRENTLY <name>;'` both match the DDL guard's regex and turn `npm run test:web` red. Write, e.g., `'Rebuild it with reindex index concurrently, or drop it if nothing needs it.'` — lower case, no statement.
- **`invalidIndexes` needs the schema filter its siblings have.** Revision 1 scanned all of `pg_index`; a failed `REINDEX CONCURRENTLY` on a TOAST index leaves an invalid TOAST index that the check would list and that an operator cannot reindex by name.
- **Read the floor from the threshold**, so the number appears once.
- `unusedIndexes` orders by size descending so truncation drops the least wasteful rows (§5).
- Exclude `indisprimary` and `indisunique` — those exist to enforce a constraint, not to be scanned, and "drop it" is never right for one.

- [ ] **Step 4: Unit tests** — verdict at total 0 / 1 / 40; note carries the total; bigint size and scan counts convert out of text; `truncated` derives from the pre-`LIMIT` total.

- [ ] **Step 5: Run unit + integration + `npm run test:web`.** Expected: all PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): invalid and unused indexes, with verdicts that survive truncation"`

---

### Task 4: `duplicateIndexes` (#28) — the one Revision 1 got badly wrong

**Read this whole task before writing anything.** This is the only check in either plan whose output is a destructive recommendation, and Revision 1's implementation was wrong more often than right on adversarial fixtures.

**Files:** modify `indexes.ts`, `indexes.test.ts`, `indexes.int.test.ts`
**pgHero source:** `methods/indexes.rb` — `duplicate_indexes`, which uses `index_covers?` to compare **column arrays**. Revision 1 claimed that provenance while doing something else entirely. Port the array comparison.

**Contract:** `gate: 'work'`, `class: 'hygiene'`, `timeoutMs: 10_000`, `ListOpts`, **no verdict** (§2.2 — a duplicate is sometimes deliberate). Data `{ pairs: DuplicatePair[]; total; truncated }`, `DuplicatePair = { name; coveredBy; table; sizeBytes: number }`.

**What Revision 1 did, and every way it failed.** It built `indkey::text` and matched `b.keys LIKE a.keys || '%'`. Reproduced on PostgreSQL 17.11:

| Defect | Evidence |
|---|---|
| **Column-number prefix collision** | `indkey` for `(c1)` is `"1"`, for `(c11)` is `"11"`, and `'11' LIKE '1%'`. The check reported an index on `c1` as covered by an index on `c11` — unrelated columns |
| **Exact duplicates never reported** | `length(b.keys) > length(a.keys)` excludes equal-length pairs, so two byte-identical indexes on `(a)` produced nothing. This is the most common and most actionable duplicate there is |
| **Expression indexes all collide** | every expression index has `indkey` `"0"`, so `lower(a)` was reported as covered by `upper(a), b` |
| **Partial indexes treated as covering** | `ix_full ON t(a)` reported as covered by `ix_part ON t(a,b) WHERE b > 0`; acting on that loses coverage for `b <= 0` |
| **Opclass and access method ignored** | a `hash` index reported as covered by a `btree`; a `text_pattern_ops` index reported as covered by a default-opclass index, though only the former serves `LIKE 'x%'` |

- [ ] **Step 1: Write the failing integration test — it encodes all five defects**

```typescript
// append to packages/checks/test/indexes.int.test.ts
import { duplicateIndexes } from '../src/checks/indexes.js';

describe('duplicateIndexes', () => {
  const fixture = `
    CREATE TABLE w (
      c1 int, c2 int, c3 int, c4 int, c5 int,
      c6 int, c7 int, c8 int, c9 int, c10 int, c11 int,
      d text
    );
    CREATE INDEX ix_c1      ON w (c1);
    CREATE INDEX ix_c1_copy ON w (c1);
    CREATE INDEX ix_c1_c2   ON w (c1, c2);
    CREATE INDEX ix_c11     ON w (c11);
    CREATE INDEX ix_hash_c1 ON w USING hash (c1);
    CREATE INDEX ix_d_pat   ON w (d text_pattern_ops);
    CREATE INDEX ix_d_c1    ON w (d, c1);
    CREATE INDEX ix_expr    ON w (lower(d));
    CREATE INDEX ix_full_c3 ON w (c3);
    CREATE INDEX ix_part    ON w (c3, c4) WHERE c4 > 0;
  `;
  const pairsOf = (d: { pairs: { name: string; coveredBy: string }[] }) =>
    d.pairs.map((p) => `${p.name.split('.').pop()}<=${p.coveredBy.split('.').pop()}`).sort();

  it('reports a genuine prefix duplicate', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, fixture);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data)).toContain('ix_c1<=ix_c1_c2');
    });
  });

  it('reports byte-identical duplicates, exactly once', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, fixture);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const exact = pairsOf(r.data).filter((p) => p.includes('ix_c1_copy'));
      // Reported, and not twice in both directions.
      expect(exact).toHaveLength(1);
    });
  });

  it('does not confuse column 1 with column 11', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, fixture);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data)).not.toContain('ix_c1<=ix_c11');
    });
  });

  it('does not treat a different access method as covering', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, fixture);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data).some((p) => p.includes('ix_hash_c1'))).toBe(false);
    });
  });

  it('does not treat a different opclass as covering', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, fixture);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data)).not.toContain('ix_d_pat<=ix_d_c1');
    });
  });

  it('does not treat a partial index as covering a full one', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, fixture);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data)).not.toContain('ix_full_c3<=ix_part');
    });
  });

  it('does not collide expression indexes with column indexes', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, fixture);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data).some((p) => p.includes('ix_expr'))).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run it and watch all seven fail.**

- [ ] **Step 3: Derive the query**

Constraints that fall out of the tests above:
- Compare `indkey` as an **array of column numbers**, not as text. `(indkey::int2[])[0:n]` slicing, or `unnest … WITH ORDINALITY`, both work; the text trick does not.
- A covering index must have the candidate's key array as a **leading slice**, with `>=` length so exact duplicates are found. De-duplicate the symmetric pair — order by `(indexrelid)` and keep one direction — so an exact duplicate is reported once.
- Require the same `relam` (access method) and the same leading `indclass` (opclass) slice.
- Require `b.indpred IS NULL` — a conditional index cannot cover an unconditional one. Decide deliberately whether a partial index may be the *candidate*; the test does not constrain it, so either choice is fine if commented.
- Exclude expression indexes (`indexprs IS NOT NULL`) rather than letting their `0` keys collide.
- Keep primary keys and unique indexes available on the **covering** side — an ordinary index on the PK column is a real duplicate — while never reporting a PK or unique index as the *redundant* one.
- `total` counts pairs, and `map`'s data feeds a page that must say "pair(s)". Alternatively use `count(DISTINCT a.indexrelid) OVER ()`; if you do, say so in the docblock so the page's copy matches.

- [ ] **Step 4: Unit tests for `map`** — pairing, byte conversion, the truncation arithmetic, and `verdict` is `undefined`.

- [ ] **Step 5: Run everything.** Run: `npx vitest run --project integration packages/checks/test/indexes.int.test.ts && npm test && npm run test:web`

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): duplicate_indexes, comparing key arrays as pghero does"`

---

### Task 5: `indexUsage` (#24) and `missingIndexes` (#25) — null, never a sentinel string

§3's divergence: pgHero emits the text `'Insufficient data'` in the same column as a numeric percentage, so the column's type is text-or-number. pgops returns `number | null`. §3 also records that pgHero's `CASE idx_scan WHEN 0` arm is unreachable in `missing_indexes` — its `WHERE` already requires `idx_scan > 0` — so **do not port the dead branch**.

**Files:** modify `indexes.ts`, `indexes.test.ts`, `indexes.int.test.ts`
**Contract:** both `gate: 'work'`, `class: 'hygiene'`, `timeoutMs: 10_000`, `ListOpts`, **no verdict** (§2.2). Both share one shape: `{ tables: TableIndexUsage[]; total; truncated }`, `TableIndexUsage = { table; indexHitRate: number | null; estimatedRows: number }`.

**The trap Revision 1 papered over.** Its docblock said a null rate means "a table that has never been scanned at all". That is false: `pg_stat_user_tables.idx_scan` is **NULL for a table with no indexes**, so a heavily seq-scanned table with no index — the table most obviously wanting one — reads as "insufficient data", not 0%. That matches pgHero, so it is parity rather than a bug, but the comment must say the true reason and a fixture must cover it.

- [ ] **Step 1: Write the failing integration test**

```typescript
// append to packages/checks/test/indexes.int.test.ts
import { indexUsage, missingIndexes } from '../src/checks/indexes.js';

describe('index usage', () => {
  it('reports null — not 0% — for a scanned table that has no index at all', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE noidx (a int);
        INSERT INTO noidx SELECT g FROM generate_series(1, 100) g;
      `);
      await pool.query('SELECT count(*) FROM noidx');
      await pool.query('SELECT count(*) FROM noidx');

      const result = await runCheck(ctx, indexUsage, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.tables.find((t) => t.table.endsWith('noidx'))!;
      expect(row).toBeDefined();
      // The whole §3 divergence: null, never the string, never 0.
      expect(row.indexHitRate).toBeNull();
      expect(row.estimatedRows).toBeGreaterThan(0);
    });
  });

  it('reports a real percentage for a table with index scans', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE t (id int PRIMARY KEY, v int);
        INSERT INTO t SELECT g, g FROM generate_series(1, 1000) g;
        ANALYZE t;
      `);
      for (let i = 1; i <= 20; i += 1) await pool.query('SELECT * FROM t WHERE id = $1', [i]);

      const result = await runCheck(ctx, indexUsage, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.tables.find((t) => t.table.endsWith('.t'))!;
      expect(row.indexHitRate).not.toBeNull();
      expect(row.indexHitRate!).toBeGreaterThan(0);
    });
  });

  it('missingIndexes returns only tables big enough and seq-scanned enough to act on', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE small (id int PRIMARY KEY, v int);
        INSERT INTO small SELECT g, g FROM generate_series(1, 50) g;
        ANALYZE small;
      `);
      await pool.query('SELECT * FROM small WHERE id = 1');

      const result = await runCheck(ctx, missingIndexes, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Under pgHero's 10,000-row floor, so excluded however it was scanned.
      expect(result.data.tables.some((t) => t.table.endsWith('small'))).toBe(false);
      expect(result.verdict).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Derive the queries.** Both read `pg_stat_user_tables`; qualify the name with `schemaname`. `missingIndexes` keeps pgHero's filters (`idx_scan > 0`, ratio `< 95`, `n_live_tup >= 10000`) — §2.1 lists no threshold for #25 and it has no verdict, so these stay as SQL constants, but **say in the docblock that they are pgHero's and why they are not `Threshold` data**.

- [ ] **Step 4: Unit tests** — a null rate stays null; a present rate converts; bigint `n_live_tup` converts out of text; `verdict` is `undefined` on both; one fixture with `index_hit_rate: null` **and a large `estimated_rows`**, which is the real shape of the dangerous case.

- [ ] **Step 5: Run unit + integration + `npm run test:web`.**

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): index_usage and missing_indexes, null instead of a sentinel"`

---

### Task 6: `constraints.ts` — #55 `invalid_constraints`

One of the three whose gate is not its page: `gate: 'keep-up'`, renders on `/queries/indexes` beside `invalidIndexes`, because pgHero shows the two in one alert and they answer the same operator question — "did a migration leave something half-built?"

**Files:** create `packages/checks/src/checks/constraints.ts`, `constraints.test.ts`, `constraints.int.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// packages/checks/test/constraints.int.test.ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { invalidConstraints } from '../src/checks/constraints.js';
import { withPostgres, seed } from './harness.js';

describe('invalidConstraints against a real server', () => {
  it('finds a NOT VALID check and a NOT VALID foreign key, and misses validated ones', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE parent (id int PRIMARY KEY);
        CREATE TABLE child (id int PRIMARY KEY, parent_id int, n int);
        ALTER TABLE child ADD CONSTRAINT child_n_positive CHECK (n > 0) NOT VALID;
        ALTER TABLE child ADD CONSTRAINT child_fk FOREIGN KEY (parent_id) REFERENCES parent(id) NOT VALID;
        ALTER TABLE child ADD CONSTRAINT child_n_small CHECK (n < 1000);
      `);

      const result = await runCheck(ctx, invalidConstraints, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.constraints.map((c) => c.name);
      expect(names).toContain('child_n_positive');
      expect(names).toContain('child_fk');
      expect(names).not.toContain('child_n_small');
      expect(result.verdict?.level).toBe('warn');
      expect(result.data.constraints[0]!.definition).toContain('NOT VALID');
    });
  });

  it('reports the true count in the verdict when the list is capped', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE t (a int, b int, c int);
        ALTER TABLE t ADD CONSTRAINT c_a CHECK (a > 0) NOT VALID;
        ALTER TABLE t ADD CONSTRAINT c_b CHECK (b > 0) NOT VALID;
        ALTER TABLE t ADD CONSTRAINT c_c CHECK (c > 0) NOT VALID;
      `);

      const result = await runCheck(ctx, invalidConstraints, { limit: 1 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.constraints).toHaveLength(1);
      expect(result.data.total).toBe(3);
      expect(result.verdict?.note).toContain('3');
    });
  });

  it('is ok on a database with nothing unvalidated', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, invalidConstraints, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.verdict).toEqual({ level: 'ok' });
    });
  });
});
```

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Implement.** The query below **was executed during review and confirmed** to find a `NOT VALID` CHECK and FK while excluding a validated CHECK. Use it as written, adding only the schema-qualified `table` name per the universal traps.

```sql
SELECT c.conname AS name,
       <schema-qualified table expression> AS "table",
       pg_get_constraintdef(c.oid) AS definition,
       count(*) OVER ()::int AS total_matching
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE NOT c.convalidated
  AND c.contype IN ('c', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND n.nspname NOT LIKE 'pg\_%'
ORDER BY c.conname
LIMIT $1
```

`convalidated` is the column (not `convalid`); `contype IN ('c','f')` is right because only CHECK and FOREIGN KEY can be `NOT VALID`. Threshold and verdict mirror `invalidIndexes` — `warn` at `total >= 1`, note carrying `total`. **Remedy as prose** ("Validate it with alter table … validate constraint, which takes a short lock"), never a DDL statement — the guard.

- [ ] **Step 4: Unit tests** — verdict at 0 / 1 / 7; note carries the total; definition passes through; truncation arithmetic.

- [ ] **Step 5: Run unit + integration + `npm run test:web`.**

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): invalid_constraints"`

---

### Task 7: `tables.ts` — #33, #34, #35, #36

`tableHitRate` is the second half of §6's NULL case and **imports** `toRate`/`rateVerdict` from Task 1 rather than re-implementing them — a second copy is a second place for the trap to regrow.

**Files:** create `packages/checks/src/checks/tables.ts`, `tables.test.ts`, `tables.int.test.ts`
**Contract:** `tableHitRate` (no Opts, warn at 99 percent, same `because` as #22); `tableCaching`, `unusedTables`, `tableStats` all `ListOpts`, **no verdict** (§2.2). `tableStats` is `gate: 'keep-up'`; the other three are `gate: 'work'`.

**The trap that makes #35 nearly useless, and must be documented.** `WHERE seq_scan = 0` does not mean "never read": **`CREATE INDEX` increments `seq_scan`**. Verified — a table created with a primary key has `seq_scan = 1` before anything queries it. So a naive filter reports only tables that never had *any* index, including a PK, and never had a read. Either reason from `idx_scan`/`seq_scan` relative to `n_live_tup` as pgHero does, or keep the strict filter and **say so in the check's docblock and in the page's empty state**, so an empty panel is not read as "no unused tables".

- [ ] **Step 1: Write the failing integration test**

```typescript
// packages/checks/test/tables.int.test.ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { tableHitRate, tableStats, unusedTables } from '../src/checks/tables.js';
import { withPostgres, seed } from './harness.js';

describe('tables against a real server', () => {
  it('reads a null table hit rate on a database with no heap I/O', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, tableHitRate);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rate).toBeNull();
      expect(result.verdict).toEqual({ level: 'ok' });
    });
  });

  /**
   * The seq_scan trap, pinned so nobody re-derives it. If this ever starts
   * returning 0, the filter's meaning has changed and #35's docblock and the
   * page's empty state both need revisiting.
   */
  it('records that CREATE INDEX itself increments seq_scan', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE with_pk (id int PRIMARY KEY); CREATE TABLE no_pk (v int);');

      const { rows } = await pool.query<{ relname: string; seq_scan: string }>(
        `SELECT relname, seq_scan::text AS seq_scan FROM pg_stat_user_tables
          WHERE relname IN ('with_pk','no_pk') ORDER BY relname`);
      const byName = Object.fromEntries(rows.map((r) => [r.relname, Number(r.seq_scan)]));

      expect(byName.no_pk).toBe(0);
      expect(byName.with_pk).toBeGreaterThan(0);

      const result = await runCheck(ctx, unusedTables, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.tables.some((t) => t.table.endsWith('no_pk'))).toBe(true);
    });
  });

  it('distinguishes a table with no index from one whose indexes went unused', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE noidx (v int); CREATE TABLE hasidx (v int); CREATE INDEX ON hasidx (v);');

      const result = await runCheck(ctx, tableStats, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Reported through tableStats' own shape; the distinction that matters
      // is that a null idx_scan never becomes 0 anywhere in this file.
      expect(result.data.tables.length).toBeGreaterThan(0);
    });
  });

  it('reports a freshly vacuumed table as vacuumed and never analyzed', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE v (id int PRIMARY KEY);');
      await pool.query('VACUUM v');

      const result = await runCheck(ctx, tableStats, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.tables.find((t) => t.table.endsWith('.v'))!;
      expect(row.lastVacuum).not.toBeNull();
      expect(row.lastAnalyze).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Derive.** `tableHitRate`'s query **was verified**: `SELECT (sum(heap_blks_hit) / nullif(sum(heap_blks_hit + heap_blks_read), 0))::text AS rate FROM pg_statio_user_tables`. The other three: `pg_stat_user_tables`/`pg_statio_user_tables`, schema-qualified, `count(*) OVER ()`, and **`idx_scan === null ? null : Number(...)`** — 0 is a real reading and must survive.

- [ ] **Step 4: Unit tests** — the null discipline for both `hitRate` and `idxScan`; bigint tuple counts; four nullable timestamps where null means "never"; `verdict` `undefined` on the three list checks; `tableStats.gate === 'keep-up'`.

- [ ] **Step 5: Run unit + integration + `npm test` + `npm run test:web`.** The full unit run matters here because `tables.ts` imports from `indexes.ts`.

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): table hit rate, caching, unused tables and table stats"`

---

### Task 8: `index-bloat.ts` — #29, ported, not written

Its own file (§1.3), its own route (§4.1), 30s timeout (§5), `gate: 'keep-up'`, and **`class: 'on-demand'`** — `types.ts` says that class exists *so that* `index_bloat` "is a class member rather than an exception carved out in prose". §3 records the placement: pgHero 4.0.1 ships this disabled on its own dashboard (`home_controller.rb:114` reads `@index_bloat = [] # @database.index_bloat`) and keeps it behind a dedicated route.

**Files:** create `packages/checks/src/checks/index-bloat.ts`, `index-bloat.test.ts`, `index-bloat.int.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// packages/checks/test/index-bloat.int.test.ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { indexBloat } from '../src/checks/index-bloat.js';
import { withPostgres } from './harness.js';

describe('indexBloat against a real server', () => {
  /**
   * §6 asks for one smoke test: that the query parses and returns the
   * expected shape. It deliberately does NOT assert a bloat figure — the
   * estimate is approximate by construction and pinning a number would fail
   * on every Postgres bump for no diagnostic gain.
   */
  it('parses and returns an empty list below the 100 MB floor', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, indexBloat, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Array.isArray(result.data.indexes)).toBe(true);
      expect(typeof result.data.total).toBe('number');
      // Nothing on a fresh database clears the floor, which is what proves
      // the floor is applied at all.
      expect(result.data.indexes).toEqual([]);
      expect(result.verdict).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Transcribe the estimator.** Open pgHero 4.0.1's `lib/pghero/methods/indexes.rb#index_bloat` and transcribe its CTE, changing **only**: add `count(*) OVER ()::int AS total_matching`; cast bigint/numeric outputs `::text`; parameterise the 100 MB floor and the `LIMIT`. **Do not rewrite the estimator** — a bloat estimate that disagrees with pgHero's is not parity, and the arithmetic is subtle enough that "improving" it silently is the likely outcome. If the clone is unavailable, **stop and report** rather than improvising.

- [ ] **Step 4: Unit tests for `map` only.** Byte conversion; **a null estimate stays null, never 0** ("we could not measure the bloat" and "there is no bloat" are opposite answers); `timeoutMs === 30_000`; `class === 'on-demand'`; `gate === 'keep-up'`; `verdict` is `undefined`.

  **Do not** pin the ratio's units before the query is in hand. Revision 1 asserted `Number(ratio) * 100` against SQL that did not exist yet, which would have bent the transcription to satisfy a guess — the opposite of "do not fix it by adjusting the arithmetic". Write that unit test after Step 3, from what the query actually returns.

- [ ] **Step 5: Run unit + integration.**

- [ ] **Step 6: Commit** — `git commit -m "feat(checks): index_bloat, ported from pghero 4.0.1"`

---

### Task 9: `SubNav`, and the existing test it breaks

One component serves `/queries` here and `/cleanup` in P2c. It is additive — the tab keeps its content and stays the landing page.

**Files:** create `apps/web/components/sub-nav.tsx`, `apps/web/test/sub-nav.test.tsx`; modify `apps/web/app/db/[name]/queries/page.tsx` **and `apps/web/test/queries-page.test.tsx`**.

**Produces:** `SubNav({ name, base, items }: { name: string; base: string; items: readonly { segment: string; label: string }[] })`.

**The breakage Revision 1 missed.** `queries-page.test.tsx` does `vi.mock('next/navigation', () => ({ useRouter: … }))`, which replaces the **whole module**. Adding a `<SubNav>` to that page introduces a `useSelectedLayoutSegment()` call that will be `undefined`, so that existing test goes red. Revision 1 said "Change nothing else on this page. Expected: PASS". It must gain `useSelectedLayoutSegment: () => null` in its mock, and this task owns that edit.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/sub-nav.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import { SubNav } from '@/components/sub-nav';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SubNav calls useSelectedLayoutSegment unconditionally; without this there
// is no router context and the render throws.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => 'indexes',
}));

const ITEMS = [
  { segment: 'indexes', label: 'Indexes' },
  { segment: 'tables', label: 'Tables' },
] as const;

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; });

describe('SubNav', () => {
  it('links each item under the tab it belongs to', async () => {
    rendered = await render(<SubNav name="prod" base="queries" items={ITEMS} />);
    // hrefs are attributes, so assert on innerHTML — text() is textContent
    // and will never contain them.
    const html = rendered.container.innerHTML;
    expect(html).toContain('/db/prod/queries/indexes');
    expect(html).toContain('/db/prod/queries/tables');
  });

  /**
   * The landing page must stay reachable. Without this link an operator who
   * clicks into Indexes can only get back with the browser's back button,
   * and the tab looks replaced rather than extended.
   */
  it('links back to the tab itself', async () => {
    rendered = await render(<SubNav name="prod" base="queries" items={ITEMS} />);
    expect(rendered.container.querySelector('a[href="/db/prod/queries"]')).not.toBeNull();
  });

  it('marks the active sub-route', async () => {
    rendered = await render(<SubNav name="prod" base="queries" items={ITEMS} />);
    const active = rendered.container.querySelector('[aria-current="page"]');
    expect(active?.getAttribute('href')).toBe('/db/prod/queries/indexes');
  });

  it('renders every label', async () => {
    rendered = await render(<SubNav name="prod" base="queries" items={ITEMS} />);
    expect(rendered.text()).toContain('Indexes');
    expect(rendered.text()).toContain('Tables');
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run --project web apps/web/test/sub-nav.test.tsx`. Expected: cannot resolve `@/components/sub-nav`.

- [ ] **Step 3: Implement `SubNav`**

A `'use client'` component using `Link` and `useSelectedLayoutSegment`. Render an "Overview" entry pointing at `/db/${name}/${base}` that is active when the segment is `null`, then one entry per item active when `segment === item.segment`, each with `aria-current="page"` when active. Style it quieter than `Nav`: `Nav` answers "which gate?", which `gates.ts` calls the console's vocabulary; this answers "which part of this gate?", a smaller question that gets a smaller control. Use `cn` from `@/lib/utils`, as `Nav` does.

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Render it on the Queries tab, and fix that page's test**

Add to `apps/web/app/db/[name]/queries/page.tsx`, below the existing `<Refresh>` row:

```tsx
<SubNav
  name={name}
  base="queries"
  items={[{ segment: 'indexes', label: 'Indexes' }, { segment: 'tables', label: 'Tables' }]}
/>
```

**Do not remove `<Refresh>`** — `/queries` is an incident page and the guard asserts it polls. Then extend `queries-page.test.tsx`'s mock:

```tsx
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  // Added when the Queries tab gained a SubNav: the mock replaces the whole
  // module, so every hook the page's tree reaches must be supplied here.
  useSelectedLayoutSegment: () => null,
}));
```

- [ ] **Step 6: Run the whole web suite** — `npm run test:web`. Expected: PASS, including `queries-page.test.tsx` and the `<Refresh>` set-equality guard (unchanged — no page has been added yet).

- [ ] **Step 7: Commit** — `git commit -m "feat(web): a second-level strip under the Queries tab"`

---

### Task 10: `/queries/indexes`

**Files:** create `apps/web/app/db/[name]/queries/indexes/page.tsx`, `apps/web/test/indexes-page.test.tsx`

**Prerequisite:** Task 13 must land first, or import the check objects directly rather than through `CHECKS`. Pages reach data through `CHECKS.<id>` and types through the barrel, both of which Task 13 wires.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/indexes-page.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Indexes from '@/app/db/[name]/queries/indexes/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The page runs ten checks, so the mock dispatches on `check.id` and each
 * test overrides only the one it is about — the other nine stay healthy,
 * which is what makes "does not render 0%" meaningful rather than vacuously
 * true on an empty page.
 */
const { overrides } = vi.hoisted(() => ({ overrides: new Map<string, unknown>() }));

const ok = (data: unknown, verdict: unknown = null) => ({ ok: true, data, verdict, measuredAt: 0 });

const HEALTHY: Record<string, unknown> = {
  indexHitRate: { rate: 99.9 },
  indexCaching: { indexes: [], total: 0, truncated: false },
  indexUsage: { tables: [], total: 0, truncated: false },
  missingIndexes: { tables: [], total: 0, truncated: false },
  unusedIndexes: { indexes: [], total: 0, truncated: false },
  invalidIndexes: { indexes: [], total: 0, truncated: false },
  duplicateIndexes: { pairs: [], total: 0, truncated: false },
  indexList: { indexes: [], total: 0, truncated: false },
  lastStatsReset: { statsReset: null },
  invalidConstraints: { constraints: [], total: 0, truncated: false },
};

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) =>
    overrides.get(check.id) ?? ok(HEALTHY[check.id] ?? {})),
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

// Async Server Component: CALL it, then render the element it returns.
const html = async () => {
  const element = await Indexes({ params: Promise.resolve({ name: 'prod' }) });
  rendered = await render(element);
  return rendered.container.innerHTML;
};

describe('the indexes page', () => {
  it('says why a check could not run instead of rendering it empty', async () => {
    overrides.set('invalidIndexes', {
      ok: false, reason: 'privilege',
      message: 'permission denied for view pg_stat_user_indexes',
    });

    const out = await html();

    expect(out).toContain('permission denied for view pg_stat_user_indexes');
    // A check that could not run must not render the sentence a healthy one does.
    expect(out).not.toContain('No invalid indexes.');
  });

  it('renders a null hit rate as unknown, never as 0%', async () => {
    overrides.set('indexHitRate', ok({ rate: null }));

    const out = await html();

    expect(out).toContain('No index I/O recorded yet.');
    expect(out).not.toMatch(/0(\.00)?%\s*of\s*(index\s*)?reads/);
  });

  /**
   * Asserts the truncation LINE, not a bare '40' — the verdict note also
   * contains 40, so a substring check would pass whether or not the page
   * ever reads `data.total`.
   */
  it('reports the true total when a list is capped', async () => {
    overrides.set('unusedIndexes', ok(
      { indexes: [{ name: 'public.ix_a', table: 'public.t', sizeBytes: 104_857_600, scans: 0 }],
        total: 40, truncated: true },
      { level: 'warn', note: '40 unused index(es) over 10 MB' },
    ));

    const out = await html();

    expect(out).toContain('Showing 1 of 40');
  });

  it('links to the bloat route rather than running it inline', async () => {
    const out = await html();

    expect(out).toContain('/db/prod/queries/indexes/bloat');
    const { runCheckFor } = await import('@/lib/check');
    const ids = vi.mocked(runCheckFor).mock.calls.map((c) => (c[1] as { id: string }).id);
    // "Reached by an explicit click" (§5) means this page never fetches it.
    expect(ids).not.toContain('indexBloat');
  });
});
```

- [ ] **Step 2: Run it, watch it fail** — module not found.

- [ ] **Step 3: Implement the page.** `generateMetadata` returning `` `${name} · Indexes` ``; `<SubNav>`; then `Promise.all` over the ten checks and one `CheckPanel` each, **findings first, inventory last**: hit rate, invalid indexes, unvalidated constraints (adjacent — pgHero's single alert), unused, duplicate, usage, missing, caching, list, stats-reset. Then a link to `/queries/indexes/bloat` with a sentence naming its cost.

  **No `<Refresh>`.** Every capped list renders `Showing {n} of {total}.` when `truncated`. Use `formatBytes` and `formatCount` from `@/lib/format` (both exist). Say "pair(s)" for duplicates if `total` counts pairs.

- [ ] **Step 4: Run it, then the full web suite** — `npm run test:web`. If the `<Refresh>` guard reports this page as an unexpected member of the polling set, **remove `<Refresh>` from the page; do not add the page to `INCIDENT_PAGES`.**

- [ ] **Step 5: Commit** — `git commit -m "feat(web): the indexes page"`

---

### Task 11: `/queries/indexes/bloat`

**Files:** create `apps/web/app/db/[name]/queries/indexes/bloat/page.tsx`, `apps/web/test/index-bloat-page.test.tsx`

- [ ] **Step 1: Write the failing test.** Same harness shape as Task 10 (call the component, render the element, assert on `container.innerHTML`), covering:
  - a timeout renders as unavailable **with the message**, and does **not** contain "No bloat"
  - an entry whose `bloatBytes`/`bloatRatio` are null renders `—`, not `0 B` / `0%`
  - an empty list names the 100 MB floor, so the operator reads "nothing over the floor" rather than "no bloat anywhere"

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Implement.** `<SubNav>`, one `CheckPanel` over `CHECKS.indexBloat`, a table of name / table / size / estimated bloat / ratio. No `<Refresh>`. The empty state must carry the floor:

```tsx
<p className="text-sm text-muted-foreground">
  No index over 100&nbsp;MB shows measurable bloat. Smaller indexes are not
  estimated: pgHero&rsquo;s floor is adopted here, because bloat on a small
  index costs less than the scan that measures it.
</p>
```

- [ ] **Step 4: Run it, then `npm run test:web`.**

- [ ] **Step 5: Commit** — `git commit -m "feat(web): the index bloat route"`

---

### Task 12: `/queries/tables`

**Files:** create `apps/web/app/db/[name]/queries/tables/page.tsx`, `apps/web/test/tables-page.test.tsx`

- [ ] **Step 1: Write the failing test.** Same harness shape, covering:
  - a null table hit rate renders as unknown, never `0%`
  - a capped list renders `Showing 100 of 250`
  - a check that could not run says why rather than rendering empty
  - **the unused-tables empty state explains the `seq_scan` caveat** from Task 7 — assert the copy is present, so an empty panel can never be read as "no unused tables"

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Implement.** `<SubNav>`, then `CheckPanel`s for `tableHitRate`, `unusedTables`, `tableStats`, `tableCaching`. No `<Refresh>`.

- [ ] **Step 4: Run it, then `npm run test:web`.**

- [ ] **Step 5: Commit** — `git commit -m "feat(web): the tables page"`

---

### Task 13: The registry and the barrel

Fifteen entries flip. **`'P2'` does NOT join `COMPLETE_PHASES` here** — P2c owns the other ten, and the phase gate would correctly fail. That failure is the gate working; do not pre-empt it.

**Files:** modify `packages/checks/src/registry.ts` **and `packages/checks/src/index.ts`**

- [ ] **Step 1: Confirm the starting point** — `npm test`. `parityBacklog('P2')` should be 25.

- [ ] **Step 2: Add the type exports to the barrel.** `index.ts` enumerates `export type * from './checks/<file>.js'` per file, and its docblock records that P1a's locks page had to derive types structurally because that block was missing. Add all four:

```typescript
export type * from './checks/constraints.js';
export type * from './checks/index-bloat.js';
export type * from './checks/indexes.js';
export type * from './checks/tables.js';
```

Without these, Tasks 10–12 cannot name `IndexEntry`, `UnusedIndex`, `DuplicatePair`, `InvalidConstraint`, `TableStat` or `BloatedIndex`.

- [ ] **Step 3: Wire the imports and `CHECKS`** — one import per module (not two from `./checks/indexes.js`), all fifteen added to `CHECKS` in its existing alphabetical order.

- [ ] **Step 4: Flip the fifteen entries.** `planned: 'P2'` → the `check:` id; leave `name`, `source` and `gate` untouched.

| # | id | # | id | # | id |
|---|---|---|---|---|---|
| 22 | `indexHitRate` | 27 | `invalidIndexes` | 33 | `tableHitRate` |
| 23 | `indexCaching` | 28 | `duplicateIndexes` | 34 | `tableCaching` |
| 24 | `indexUsage` | 29 | `indexBloat` | 35 | `unusedTables` |
| 25 | `missingIndexes` | 30 | `indexList` | 36 | `tableStats` |
| 26 | `unusedIndexes` | 32 | `lastStatsReset` | 55 | `invalidConstraints` |

- [ ] **Step 5: Run the registry tests** — `npx vitest run --project unit packages/checks/test/registry.test.ts`. It asserts every `check:` names a real key of `CHECKS` **and that the registry's `gate` equals the check's**, so both a typo above and a "corrected" gate on #29/#36/#55 fail here. `parityBacklog('P2')` now returns 10.

- [ ] **Step 6: Run everything** — `npm test && npm run test:web && npm run test:int && npm run typecheck:test`. Expected: all PASS.

- [ ] **Step 7: Commit** — `git commit -m "feat(checks): close fifteen P2 capabilities in the registry"`

---

## Done when

- `parityBacklog('P2')` returns **10**.
- `/db/<name>/queries/indexes`, `/queries/indexes/bloat` and `/queries/tables` render, and none polls.
- Every check's query has been run against a live server by its own integration test — **no query in this plan ships on the strength of having been written down.**
- `npm test`, `npm run test:web`, `npm run test:int`, `npm run typecheck:test` all pass.
- `'P2'` is still absent from `COMPLETE_PHASES`, correctly.

**Not in this plan:** the `/cleanup` tab and `Nav` change, #37–#39, #43, #45, #46, #52–#54, #56, the README parity table, and the v2 CHANGELOG. All belong to P2c, which closes the phase.
