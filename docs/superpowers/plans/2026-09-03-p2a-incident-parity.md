# P2a — Incident Parity and the Poll Boundary: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six incident-class capabilities carrying a P2 tag (#4, #7, #17, #49, #51, #65) and move the 5-second poll out of the database layout onto the incident pages, so the hygiene pages P2b adds can never inherit it.

**Architecture:** Two of the three new capabilities need no new SQL. `#17 slow_queries` is a pure predicate over `queryStats` data that already ships; `#4`/`#7`/`#65` are three derivations of one `pg_stat_activity` round trip, exactly as pgHero's own controller derives them and as `identity.ts` already backs four capabilities from one query. Only `replication.ts` is a genuinely new query. Everything derived is a pure exported function, unit-tested without a database.

**Tech Stack:** TypeScript 5.7, `@pgops/checks` (workspace), Next 16 App Router, React 19 Server Components, Vitest 4 (`unit` / `integration` / `web` projects), Testcontainers.

**Spec:** `docs/superpowers/specs/2026-09-03-pgops-p2-hygiene-design.md` — §1.2 (the six incident-class capabilities), §3 (divergences), §4.2 (moving the poll), §4.3 (the overview), §8 (closing the drift). The spec is the binding authority; this plan argues from it.

**Parent spec:** `docs/superpowers/specs/2026-08-26-pgops-web-design.md` §10.

**Prior art in this repo, both binding:**
- `docs/superpowers/reviews/2026-08-27-p0-decision-record.md` — rulings behind `packages/checks`.
- `docs/superpowers/reviews/2026-08-27-p1a-decision-record.md` — rulings behind `apps/web`.

## Global Constraints

- **Node floor 22. PostgreSQL floor 14.** CI matrix is 14, 16, 17, 18. Any SQL added here must run unchanged across all four, or branch on `ctx.serverVersion` explicitly.
- **`packages/` uses `.js` import specifiers; `apps/web` does NOT.** `apps/web`'s tsconfig sets `moduleResolution: "bundler"`, under which Next's resolver will not map `./x.js` onto a sibling `x.tsx`.
- **`packages/checks` dependencies stay exactly `["pg"]`.** Any change to that list is a finding to report, not a task to do.
- **`null` means "we could not look" and is never collapsed into a value.** Use `??`, never `||`, when defaulting a field that can legitimately be `false` or `0`. This is the `identity.ts` `ssl` rule and it applies to every field added here.
- **Every rendering path calls `await connection()` from `next/server` before reading configuration.** Unchanged from P1a; `runCheckFor` already does this.
- **A check with `class: 'incident'` MUST appear in `apps/web/app/page.tsx`'s `worstVerdict` list.** `test/guards.test.ts` enforces it. Two tasks here add incident checks and will turn that guard red until the page is updated — that is the guard working, not a regression.
- **Thresholds are data with a non-empty `because`.** No new threshold is introduced in this plan; see the Ruling below.
- 2-space indent, ESM. Comments explain *why*, and cite the defect they prevent.

## Ruling: no verdict on replication lag

Spec §2.1 lists seven thresholds and none is for `#49 replication_lag`; §2.2's
list of verdict-less checks covers only the 25 hygiene capabilities, so the
spec is silent on the two incident-class replication checks. Resolved here
under the spec's governing decision — mirror pgHero's escalation surface —
and pgHero has no replication-lag threshold: `replication_lag` returns a
number and `replicating` a count, **neither carries a `verdict`**. They
report; they never escalate.

Cost if wrong: a standby falling behind shows a growing number on the triage
page but does not colour the overview. Adding a threshold later is additive
and breaks nothing.

## Four verified facts this plan is built on

Each was checked against source, not recalled.

1. **`#17 slow_queries` is a filter, not a query.** pgHero: `query_stats.select { |q| q[:calls] >= slow_query_calls && q[:average_time] >= slow_query_ms }`, defaults 100 and 20 (`lib/pghero.rb:44-45`). pgops already ships `queryStats` with `calls: number` and `meanMs: number` on `QueryStatRowData`.
2. **`#4`, `#7`, `#65` come from one query.** pgHero's `home_controller.rb#connections` calls `@database.connections` once, then derives sources and the SSL breakdown from those rows in Ruby.
3. **`<Refresh>` is rendered in `app/db/[name]/layout.tsx`, not in the pages.** So it currently applies to all four incident pages by inheritance.
4. **`test/guards.test.ts` reads page *source* off disk** (`strip()` + regex on `runCheckFor\(\s*name\s*,\s*CHECKS\.(\w+)`), because a Next page module cannot export an arbitrary list without arguing with `next build`'s export validation. New guards follow that pattern.

---

## File Structure

**Created:**
- `packages/checks/src/checks/replication.ts` — #49, #51. One query, one check, no verdict.
- `packages/checks/test/replication.test.ts` — unit tests for `map`.
- `packages/checks/test/replication.int.test.ts` — behaviour against a real primary.
- `packages/checks/test/connection-detail.test.ts` — unit tests for the three derivations.

**Modified:**
- `apps/web/app/db/[name]/layout.tsx` — `<Refresh>` removed.
- `apps/web/app/db/[name]/page.tsx` — `<Refresh>` added; replication panel added.
- `apps/web/app/db/[name]/sessions/page.tsx` — `<Refresh>` added; connection-detail panels added.
- `apps/web/app/db/[name]/locks/page.tsx` — `<Refresh>` added.
- `apps/web/app/db/[name]/queries/page.tsx` — `<Refresh>` added; slow-query panel added.
- `apps/web/app/page.tsx` — `replicationLag` and `connectionDetail` added to `worstVerdict`.
- `apps/web/test/guards.test.ts` — new poll-boundary guard.
- `packages/checks/src/checks/connections.ts` — second check `connectionDetail` + three pure derivations.
- `packages/checks/src/checks/query-stats.ts` — `slowQueries` pure function.
- `packages/checks/src/registry.ts` — six entries re-pointed; `CHECKS` gains two.
- `packages/checks/src/index.ts` — new type exports.
- `README.md`, parent spec §10 — counts corrected (Task 5).

---

## Task 1: Move the poll onto the incident pages

Nothing else in this plan may land first. Once hygiene routes exist, a
layout-level poll is a five-second `index_bloat` scan on every open tab, and
the mistake is invisible — the page renders correctly either way.

**Files:**
- Modify: `apps/web/app/db/[name]/layout.tsx` (remove `<Refresh>` and its import)
- Modify: `apps/web/app/db/[name]/page.tsx`, `sessions/page.tsx`, `locks/page.tsx`, `queries/page.tsx` (add `<Refresh>`)
- Test: `apps/web/test/guards.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: `Refresh` from `@/components/refresh`, unchanged — `{ intervalMs?: number }`, default 5000.
- Produces: `INCIDENT_PAGES`, a `const` array of page-source paths inside the guard test, which Task 5 of P2b extends with the hygiene page list.

### Why the obvious version of this test cannot fail

The natural guard is "`<Refresh>` appears in the incident pages and in no
hygiene page". The second half is **vacuous today** — there are no hygiene
pages, so it agrees with any implementation, including one that leaves
`<Refresh>` in the layout. A test whose subject set is empty is a test that
passes for free.

So the assertion that carries this task is the *first* half plus an explicit
negative on the layout, both of which have a real subject right now:

- each of the four incident page sources contains `<Refresh`, and
- `layout.tsx` does not.

The hygiene half is added in P2b, when it has something to range over.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/guards.test.ts`:

```ts
describe('the poll boundary', () => {
  /**
   * `<Refresh>` used to render in app/db/[name]/layout.tsx, which put a
   * 5-second router.refresh() on EVERY route under /db/<name>. That was
   * correct while every such route was an incident page. P2 adds hygiene
   * routes whose queries are catalog scans (index_bloat is a ~140-line CTE;
   * table_sizes touches every relation), and inheriting the poll would run
   * them every five seconds on every open tab, forever.
   *
   * Both directions of getting this wrong are SILENT. An incident page that
   * loses its <Refresh> still renders — it just stops updating, during an
   * incident, with nothing on screen saying so. A hygiene page that keeps it
   * still renders — it just puts a table scan on a timer. Neither throws, so
   * nothing else in the suite would notice.
   *
   * The hygiene half of this rule (no hygiene page may render <Refresh>)
   * arrives in P2b with the pages it ranges over. Asserting it here, over an
   * empty set, would pass for free — including against the very layout-level
   * poll this task removes.
   */
  const INCIDENT_PAGES = [
    join(APP, 'db', '[name]', 'page.tsx'),
    join(APP, 'db', '[name]', 'sessions', 'page.tsx'),
    join(APP, 'db', '[name]', 'locks', 'page.tsx'),
    join(APP, 'db', '[name]', 'queries', 'page.tsx'),
  ];
  const DB_LAYOUT = join(APP, 'db', '[name]', 'layout.tsx');

  it.each(INCIDENT_PAGES)('polls on %s', (page) => {
    expect(strip(readFileSync(page, 'utf8'))).toMatch(/<Refresh\b/);
  });

  it('does not poll from the layout, which hygiene routes will also use', () => {
    expect(strip(readFileSync(DB_LAYOUT, 'utf8'))).not.toMatch(/<Refresh\b/);
  });
});
```

- [ ] **Step 2: Run it and watch all five fail**

Run: `npm run test:web -- -t "the poll boundary"`

Expected: FAIL. The four `polls on ...` cases fail because no page renders
`<Refresh>` yet; `does not poll from the layout` fails because the layout
still does. Five failures is the correct RED — if the layout case passes,
something has already removed it and this task needs re-reading.

- [ ] **Step 3: Remove `<Refresh>` from the layout**

In `apps/web/app/db/[name]/layout.tsx`, delete the `Refresh` import and
collapse the header, which no longer needs the flex row it used to balance:

```tsx
      <header className="mb-2">
        {/* The operator's label, then what the server itself answers. The
            order is deliberate: the label is what they navigated by, the
            line under it is what that label turned out to mean. */}
        <h1 className="text-xl font-semibold">{name}</h1>
        <StatusBar result={who} />
      </header>
```

- [ ] **Step 4: Add `<Refresh>` to each of the four incident pages**

Each page imports it and renders it once, at the top of its own returned
tree. For `app/db/[name]/page.tsx`, wrap the existing `<div className="grid
gap-4">` so the control sits above the panels:

```tsx
import { Refresh } from '@/components/refresh';
```

```tsx
  return (
    <div className="grid gap-4">
      {/* Task 1: the poll lives on the incident pages, not the layout —
          hygiene routes share that layout and must not inherit a 5s
          catalog scan. test/guards.test.ts holds this. */}
      <div className="flex justify-end"><Refresh intervalMs={5_000} /></div>
      <CheckPanel title="Connections" result={connections}>
```

`sessions/page.tsx`, `locks/page.tsx` and `queries/page.tsx` each return a
single `<CheckPanel>` rather than a grid. Wrap each in a fragment:

```tsx
  return (
    <>
      <div className="mb-2 flex justify-end"><Refresh intervalMs={5_000} /></div>
      <CheckPanel title="Sessions" result={result}>
        {/* ... existing body, unchanged ... */}
      </CheckPanel>
    </>
  );
```

- [ ] **Step 5: Run the guard and the full web suite**

Run: `npm run test:web`

Expected: PASS, all five new cases plus the 97 existing. If any existing test
asserted on the layout's header markup, fix that test to the new structure —
it is asserting on the thing this task deliberately changed.

- [ ] **Step 6: Typecheck**

Run: `npm run --workspace @pgops/web typecheck && npm run typecheck:test`

Expected: clean. An unused `Refresh` import left in the layout is a TS error
here, which is the compiler catching a half-done Step 3.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/db apps/web/test/guards.test.ts
git commit -m "fix(web): move the 5s poll from the layout onto the incident pages

Hygiene routes share app/db/[name]/layout.tsx. Left there, the poll would
run index_bloat and table_sizes every five seconds on every open tab.

Both failure directions are silent — a page that stops polling still
renders, and so does one that polls a table scan — so the move ships with
a guard. The guard asserts only what has a subject today: the four
incident pages poll, and the layout does not. The hygiene half arrives in
P2b with the pages it ranges over; asserted now, over an empty set, it
would pass for free.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `replication.ts` — #49 replication_lag, #51 replicating

**Files:**
- Create: `packages/checks/src/checks/replication.ts`
- Create: `packages/checks/test/replication.test.ts`
- Create: `packages/checks/test/replication.int.test.ts`
- Modify: `packages/checks/src/registry.ts`, `packages/checks/src/index.ts`
- Modify: `apps/web/app/page.tsx`, `apps/web/app/db/[name]/page.tsx`

**Interfaces:**
- Produces: `replicationLag: Check<ReplicationRow, ReplicationData>` with
  `ReplicationData = { inRecovery: boolean | null; lagSeconds: number | null; standbys: number | null }`,
  registered in `CHECKS` as `replicationLag`. `class: 'incident'`, no `verdict`.

### The divergence this task must get right

pgHero returns **`0`** for replication lag on a primary
(`methods/replication.rb`: `CASE WHEN NOT pg_is_in_recovery() ... THEN 0`).
That conflates two different facts — "this server is a primary, lag is not a
meaningful question" and "this standby is perfectly caught up" — into the same
number. pgops returns **`null`** for the first and `0` for the second, the
same distinction `identity.ts` draws for `ssl`.

- [ ] **Step 1: Write the failing unit test**

Create `packages/checks/test/replication.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { replicationLag } from '../src/checks/replication.js';

describe('replicationLag', () => {
  const primary = { in_recovery: false, lag_seconds: null, standbys: 2 };

  it('reports a primary with standbys attached', () => {
    expect(replicationLag.map([primary])).toEqual({
      inRecovery: false, lagSeconds: null, standbys: 2,
    });
  });

  /**
   * THE divergence from pgHero, and the reason this file exists. pgHero
   * answers 0 for a primary, which reads on a dashboard as "perfectly caught
   * up" — a claim about replication health made about a server that is not
   * replicating at all. `null` is "not a meaningful question here"; `0` is
   * reserved for a standby that genuinely has no lag.
   */
  it('reports no lag figure at all on a primary, rather than zero', () => {
    expect(replicationLag.map([primary]).lagSeconds).toBeNull();
    expect(replicationLag.map([primary]).lagSeconds).not.toBe(0);
  });

  it('reports zero lag on a caught-up standby', () => {
    const caughtUp = { in_recovery: true, lag_seconds: 0, standbys: 0 };
    expect(replicationLag.map([caughtUp]).lagSeconds).toBe(0);
  });

  it('reports a lagging standby in seconds', () => {
    const behind = { in_recovery: true, lag_seconds: 12.5, standbys: 0 };
    expect(replicationLag.map([behind])).toEqual({
      inRecovery: true, lagSeconds: 12.5, standbys: 0,
    });
  });

  /**
   * `standbys: 0` is "nothing is streaming from me" — a finding. A missing
   * row is "we could not look". Written `?? null` these stay apart; written
   * `|| null` a real zero would launder itself into unknown.
   */
  it('keeps a genuine zero standby count distinct from unknown', () => {
    expect(replicationLag.map([{ ...primary, standbys: 0 }]).standbys).toBe(0);
    expect(replicationLag.map([]).standbys).toBeNull();
  });

  it('reports every field unknown when there is no row at all', () => {
    expect(replicationLag.map([])).toEqual({
      inRecovery: null, lagSeconds: null, standbys: null,
    });
  });

  it('never escalates — pgHero has no lag threshold and neither do we', () => {
    expect(replicationLag.verdict).toBeUndefined();
    expect(replicationLag.thresholds).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit packages/checks/test/replication.test.ts`

Expected: FAIL with `Cannot find module '../src/checks/replication.js'`.

- [ ] **Step 3: Write the check**

Create `packages/checks/src/checks/replication.ts`:

```ts
import type { Check } from '../types.js';

export interface ReplicationRow {
  in_recovery: boolean;
  /**
   * `EXTRACT(EPOCH FROM ...)` returns `numeric` (OID 1700), which node-pg
   * hands back as a STRING to preserve arbitrary precision — unlike the int4
   * columns in connections.ts. The query below casts it to
   * `double precision` (float8, OID 701), which node-pg does parse to a JS
   * number. Typed as what actually arrives, per this package's convention.
   */
  lag_seconds: number | null;
  standbys: number;
}

export interface ReplicationData {
  /** `null` is "we could not look", never "no". */
  inRecovery: boolean | null;
  /**
   * Seconds behind the primary, or `null`.
   *
   * `null` covers two cases that are both "not a meaningful question": this
   * server is a primary, or it is a standby that has not yet replayed
   * anything (`pg_last_xact_replay_timestamp()` is NULL until the first
   * replayed transaction). It is NEVER used for "caught up" — that is 0.
   *
   * pgHero answers 0 for a primary. On a dashboard that reads as "perfectly
   * caught up", which is a claim about replication health made about a server
   * that is not replicating.
   */
  lagSeconds: number | null;
  /**
   * Walsenders currently streaming from this server, per `pg_stat_replication`.
   *
   * Row visibility follows the same rule as `pg_stat_activity`: a role
   * without `pg_read_all_stats` sees only its own backends, so a low count
   * can mean "not replicating" OR "not permitted to see the walsenders".
   * `sessions` carries the identical caveat. Do not read 0 as proof.
   */
  standbys: number | null;
}

/**
 * `pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()` is pgHero's own
 * caught-up test and it is the right one: comparing replay position to the
 * PRIMARY's current LSN would require a connection to the primary, which this
 * check does not have. Both functions are safe on a primary — they return
 * NULL rather than raising, unlike `pg_current_wal_lsn()`, which raises
 * "recovery is in progress" on a standby (see slots.ts's A6 note for the
 * mirror image of this hazard).
 *
 * The whole CASE is guarded by `pg_is_in_recovery()` regardless, so the
 * standby-only functions are never the deciding branch on a primary.
 */
const SQL = `
SELECT pg_is_in_recovery() AS in_recovery,
       (SELECT count(*)::int FROM pg_stat_replication) AS standbys,
       CASE
         WHEN NOT pg_is_in_recovery() THEN NULL
         WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
         ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())
       END::double precision AS lag_seconds`;

export const replicationLag: Check<ReplicationRow, ReplicationData> = {
  id: 'replicationLag',
  title: 'Replication',
  class: 'incident',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    // `??` throughout, never `||`: `false` for in_recovery and `0` for both
    // lag_seconds and standbys are all FINDINGS, and `||` would launder every
    // one of them into "we could not look".
    return {
      inRecovery: r?.in_recovery ?? null,
      lagSeconds: r?.lag_seconds ?? null,
      standbys: r?.standbys ?? null,
    };
  },
};
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run --project unit packages/checks/test/replication.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Register it**

In `packages/checks/src/registry.ts`, import `replicationLag`, add it to
`CHECKS`, and re-point the two entries:

```ts
  49: { name: 'replication_lag', source: 'methods/replication.rb', check: 'replicationLag' },
  50: { name: 'replication_slots', source: 'methods/replication.rb', check: 'slots' },
  // `SELECT state FROM pg_stat_replication` in pgHero, reduced to `.any?`.
  // Folded into #49's round trip as a count rather than a boolean: "two
  // standbys attached" and "one" are different operational facts, and the
  // boolean throws that away for nothing.
  51: { name: 'replicating', source: 'methods/replication.rb', check: 'replicationLag' },
```

In `packages/checks/src/index.ts`:

```ts
export type * from './checks/replication.js';
```

- [ ] **Step 6: Add it to the overview and watch the existing guard go green**

Run first: `npm run test:web -- -t "runs every check the registry classes as an incident"`

Expected: **FAIL**, `expected [ ... 'replicationLag' ] to deeply equal [ ... ]`.
This is the P1c guard doing exactly its job — a new incident check that the
front door does not ask about. Then add to `worstVerdict` in
`apps/web/app/page.tsx`, keeping the list alphabetical:

```ts
    runCheckFor(name, CHECKS.queryStats, { sort: 'total' }),
    // Carries no verdict (see the Ruling in the P2a plan: pgHero has no lag
    // threshold), so it can never worsen the overview — but it CAN be
    // unavailable, which this page counts separately.
    runCheckFor(name, CHECKS.replicationLag),
    runCheckFor(name, CHECKS.sessions, {}),
```

- [ ] **Step 7: Render it on triage**

In `apps/web/app/db/[name]/page.tsx`, add `runCheckFor(name, CHECKS.replicationLag)`
to the destructured `Promise.all`, and a panel:

```tsx
      <CheckPanel title="Replication" result={replication}>
        {(d) => (
          <p>
            {d.inRecovery === null
              ? 'role unknown'
              : d.inRecovery
                ? d.lagSeconds === null
                  ? 'standby · nothing replayed yet'
                  : `standby · ${formatDuration(d.lagSeconds)} behind`
                : 'primary'}
            {' · '}
            {d.standbys === null ? 'standbys unknown' : `${formatCount(d.standbys)} streaming`}
          </p>
        )}
      </CheckPanel>
```

- [ ] **Step 8: Write the integration test**

Create `packages/checks/test/replication.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { replicationLag } from '../src/checks/replication.js';
import { withPostgres } from './harness.js';

describe('replicationLag', () => {
  /**
   * The harness runs a single-node primary, so this proves the primary branch
   * and the divergence that matters: `lagSeconds` is NULL, not 0. It cannot
   * prove the standby branch — there is no second node to stream to — and
   * that limitation is stated rather than papered over with a structural
   * assertion about the SQL text.
   */
  it('reads a real primary as a primary, with no lag figure', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, replicationLag);
      if (!r.ok) throw new Error(r.message);
      expect(r.data.inRecovery).toBe(false);
      expect(r.data.lagSeconds).toBeNull();
      expect(r.data.standbys).toBe(0);
    });
  }, 120_000);

  /**
   * The CASE contains two functions that raise on the wrong node type. This
   * asserts Postgres accepts and evaluates the whole expression against a
   * live primary — the failure this catches is a query that parses but
   * errors at execution, which would reach the operator as an ordinary
   * unavailable panel rather than as a bug in pgops.
   */
  it('evaluates the recovery-guarded CASE on a primary without erroring', async () => {
    await withPostgres(async (_ctx, pool) => {
      const { rows } = await pool.query<{ lag: number | null }>(
        `SELECT (CASE
                   WHEN NOT pg_is_in_recovery() THEN NULL
                   WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
                   ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())
                 END)::double precision AS lag`,
      );
      expect(rows[0]!.lag).toBeNull();
    });
  }, 120_000);
});
```

- [ ] **Step 9: Run everything**

```bash
npm test && npm run test:web && npm run typecheck:test
npm run test:int   # ~250s; run in background and poll for "exited with code"
```

Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add packages/checks apps/web/app
git commit -m "feat(checks): replication lag and standby count (#49, #51)

pgHero answers 0 for replication lag on a primary, conflating 'not a
meaningful question' with 'perfectly caught up'. pgops answers null and
reserves 0 for a standby that genuinely has no lag — the same rule
identity.ts draws for ssl.

#51 replicating is pgHero's `SELECT state FROM pg_stat_replication`
reduced to .any?; folded into #49's round trip as a count instead, since
'two standbys attached' and 'one' differ operationally and a boolean
discards that for nothing.

No verdict: pgHero has no lag threshold, and the spec's governing
decision is to mirror its escalation surface rather than invent one.

Parity: 49 remaining -> 47.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `connectionDetail` — #4, #7, #65 from one round trip

**Files:**
- Modify: `packages/checks/src/checks/connections.ts` (append; do not touch the existing `connections` check)
- Create: `packages/checks/test/connection-detail.test.ts`
- Modify: `packages/checks/src/registry.ts`, `apps/web/app/page.tsx`, `apps/web/app/db/[name]/sessions/page.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: `connectionDetail: Check<ConnectionDetailRow, ConnectionDetailData, ConnectionDetailOpts>`, registered as `connectionDetail`. `class: 'incident'`, no `verdict`. `ConnectionDetailOpts = { limit?: number }`.
- Produces: `sslStatus(row: ConnectionDetailRow): SslStatus` — exported pure function, `SslStatus = 'SSL' | 'No SSL' | 'Socket' | 'Internal Process'`.

### Why one query

pgHero's `home_controller.rb#connections` calls `@database.connections` once
and derives `@connection_sources` and `@connections_by_ssl_status` from those
rows. Issuing three queries would give three inconsistent snapshots of a table
that changes between them — the source breakdown would not sum to the
connection list. `identity.ts` established this pattern for #1/#2/#3/#48.

- [ ] **Step 1: Write the failing unit test**

Create `packages/checks/test/connection-detail.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { connectionDetail, sslStatus } from '../src/checks/connections.js';

const row = {
  pid: 42, database: 'appdb', user: 'app', source: 'web-1',
  ip: '10.0.0.7', state: 'active', ssl: true, total_matching: 1,
};

describe('sslStatus', () => {
  it('reports an encrypted connection as SSL', () => {
    expect(sslStatus(row)).toBe('SSL');
  });

  /**
   * A backend with no database is an auxiliary process (checkpointer,
   * walwriter, autovacuum launcher). It is not an unencrypted client and
   * must not be counted as a security finding — pgHero draws exactly this
   * distinction and it is the reason this is a four-value status, not a
   * boolean.
   */
  it('reports a backend with no database as an internal process', () => {
    expect(sslStatus({ ...row, ssl: false, database: null })).toBe('Internal Process');
  });

  /**
   * No IP but a known state means a unix-socket connection: local, and not
   * meaningfully "insecure". No IP and NO state means the query could not
   * read this backend's details at all — it may be TCP, it may be a socket,
   * we cannot tell. Reporting the second as "Socket" would invent a
   * reassurance out of missing data.
   */
  it('separates a unix socket from a connection it cannot see', () => {
    expect(sslStatus({ ...row, ssl: false, ip: null, state: 'idle' })).toBe('Socket');
    expect(sslStatus({ ...row, ssl: false, ip: null, state: null })).toBe('No SSL');
  });

  it('reports an unencrypted TCP client as No SSL', () => {
    expect(sslStatus({ ...row, ssl: false })).toBe('No SSL');
  });

  /**
   * `ssl` is NULL when pg_stat_ssl has no row for this backend. That is "we
   * could not look", and the LEFT JOIN makes it reachable. It must not
   * render as SSL.
   */
  it('does not claim encryption when ssl is unknown', () => {
    expect(sslStatus({ ...row, ssl: null })).not.toBe('SSL');
  });
});

describe('connectionDetail', () => {
  it('lists connections, groups sources, and counts by ssl status in one pass', () => {
    const d = connectionDetail.map([
      row,
      { ...row, pid: 43, ssl: false, total_matching: 1 },
      { ...row, pid: 44, source: 'web-2', ssl: true, total_matching: 1 },
    ]);
    expect(d.connections.map((c) => c.pid)).toEqual([42, 43, 44]);
    expect(d.bySslStatus).toEqual({ SSL: 2, 'No SSL': 1 });
    // web-1 appears twice (pids 42 and 43) under one source row; web-2 once.
    expect(d.sources).toEqual([
      { database: 'appdb', user: 'app', source: 'web-1', ip: '10.0.0.7', connections: 2 },
      { database: 'appdb', user: 'app', source: 'web-2', ip: '10.0.0.7', connections: 1 },
    ]);
  });

  /**
   * Convention 6, and the trap the spec calls out in §5: a capped list whose
   * consumer reads rows.length reports a truncated total as the real one.
   * total_matching is the pre-LIMIT count carried on every row by
   * `count(*) OVER ()`, exactly as sessions.ts does it.
   */
  it('reports the true total when the list is truncated', () => {
    const d = connectionDetail.map([{ ...row, total_matching: 900 }]);
    expect(d.total).toBe(900);
    expect(d.truncated).toBe(true);
    expect(d.connections).toHaveLength(1);
  });

  it('is not truncated when the list is complete', () => {
    expect(connectionDetail.map([{ ...row, total_matching: 1 }]).truncated).toBe(false);
  });

  it('reports an empty server without inventing a total', () => {
    const d = connectionDetail.map([]);
    expect(d).toEqual({
      connections: [], sources: [], bySslStatus: {}, total: 0, truncated: false,
    });
  });

  it('never escalates — headroom is the connections check\'s job', () => {
    expect(connectionDetail.verdict).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit packages/checks/test/connection-detail.test.ts`

Expected: FAIL — `connectionDetail` and `sslStatus` are not exported from
`connections.js`.

- [ ] **Step 3: Implement, appended to `packages/checks/src/checks/connections.ts`**

```ts
export interface ConnectionDetailOpts { limit?: number }

export interface ConnectionDetailRow {
  pid: number;
  /** NULL for auxiliary backends, which have no database. */
  database: string | null;
  user: string | null;
  /** `application_name`; empty string when the client never set one. */
  source: string | null;
  /** NULL for unix-socket connections AND when unreadable — see `sslStatus`. */
  ip: string | null;
  state: string | null;
  /** NULL when pg_stat_ssl has no row for this backend: "we could not look". */
  ssl: boolean | null;
  /**
   * Pre-LIMIT count, carried on every row. `count(*)` is bigint, but the
   * query casts it `::int` and this is typed `number` to match sessions.ts
   * line 114 exactly — the same figure, computed the same way, in the sibling
   * check. A connection count cannot approach 2^31.
   */
  total_matching: number;
}

export type SslStatus = 'SSL' | 'No SSL' | 'Socket' | 'Internal Process';

export interface ConnectionSource {
  database: string | null;
  user: string | null;
  source: string | null;
  ip: string | null;
  connections: number;
}

export interface ConnectionDetailData {
  connections: ConnectionDetailRow[];
  sources: ConnectionSource[];
  bySslStatus: Partial<Record<SslStatus, number>>;
  /** Pre-LIMIT total. Read this, never `connections.length`. */
  total: number;
  truncated: boolean;
}

/**
 * pgHero's classification (home_controller.rb#connections, params[:security]),
 * kept because each branch encodes a real distinction:
 *
 *  - no database  → an auxiliary process (checkpointer, walwriter, autovacuum
 *    launcher). Not an unencrypted client; counting it as one would put a
 *    permanent false finding on every server.
 *  - no ip, known state → a unix socket. Local, and not meaningfully insecure.
 *  - no ip, no state → we could not read this backend at all. Might be TCP,
 *    might be a socket. "No SSL" is the honest answer; "Socket" would invent
 *    a reassurance out of missing data.
 *
 * `ssl === true` rather than truthiness: NULL means pg_stat_ssl had no row,
 * and must never render as encrypted.
 */
export function sslStatus(row: ConnectionDetailRow): SslStatus {
  if (row.ssl === true) return 'SSL';
  if (!row.database) return 'Internal Process';
  if (row.ip === null) return row.state === null ? 'No SSL' : 'Socket';
  return 'No SSL';
}

/**
 * ONE query backs #4 (the list), #7 (sources) and #65 (the security
 * breakdown), because pgHero's own controller derives all three from one
 * `@database.connections` call. Three queries would be three snapshots of a
 * table that changes between them, and the source counts would not sum to
 * the list. Same reasoning as identity.ts backing #1/#2/#3/#48.
 *
 * `count(*) OVER ()` carries the pre-LIMIT total on every row: Postgres
 * evaluates window functions before ORDER BY/LIMIT, so the figure survives
 * the clip. See sessions.ts, where this was established.
 */
const DETAIL_SQL = `
SELECT a.pid,
       a.datname       AS database,
       a.usename       AS "user",
       a.application_name AS source,
       host(a.client_addr) AS ip,
       a.state,
       s.ssl,
       count(*) OVER ()::int AS total_matching
FROM pg_stat_activity a
LEFT JOIN pg_stat_ssl s ON s.pid = a.pid
ORDER BY a.pid
LIMIT $1`;

export const connectionDetail: Check<ConnectionDetailRow, ConnectionDetailData, ConnectionDetailOpts> = {
  id: 'connectionDetail',
  title: 'Connections',
  class: 'incident',
  sql: (o) => ({ text: DETAIL_SQL, values: [o.limit ?? 500] }),
  map: (rows) => {
    const bySslStatus: Partial<Record<SslStatus, number>> = {};
    const sourceIndex = new Map<string, ConnectionSource>();
    for (const r of rows) {
      const status = sslStatus(r);
      bySslStatus[status] = (bySslStatus[status] ?? 0) + 1;
      const key = `${r.database}\0${r.user}\0${r.source}\0${r.ip}`;
      const existing = sourceIndex.get(key);
      if (existing) existing.connections += 1;
      else sourceIndex.set(key, {
        database: r.database, user: r.user, source: r.source, ip: r.ip, connections: 1,
      });
    }
    // `?? 0` on an empty result, not `?? null`: zero connections is a fact we
    // measured, not a thing we failed to look at. An empty pg_stat_activity
    // cannot happen (we are in it), so this is the no-rows-at-all case. No
    // `Number(...)` — the column is cast `::int` in SQL and arrives a number,
    // per sessions.ts and this package's "type what actually arrives" rule.
    const total = rows[0]?.total_matching ?? 0;
    return {
      connections: rows,
      sources: [...sourceIndex.values()],
      bySslStatus,
      total,
      truncated: total > rows.length,
    };
  },
};
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run --project unit packages/checks/test/connection-detail.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Register, and re-point three entries**

In `registry.ts`, import `connectionDetail`, add to `CHECKS`, and:

```ts
  4: { name: 'connections', source: 'methods/connections.rb', check: 'connectionDetail' },
  5: { name: 'total_connections', source: 'methods/connections.rb', check: 'connections' },
  6: { name: 'connection_states', source: 'methods/connections.rb', check: 'sessionStates' },
  7: { name: 'connection_sources', source: 'methods/connections.rb', check: 'connectionDetail' },
```

and, at the bottom:

```ts
  // Dashboard-only — no lib/pghero/methods/ file backs this; it is Ruby
  // post-processing over the connections list in home_controller.rb's
  // params[:security] branch. Derived here in `map` from the same round
  // trip, as `bySslStatus`. See `sslStatus` for the four-value scheme and
  // why a boolean would be wrong.
  65: { name: 'connection_security_breakdown', source: 'app/controllers/pg_hero/home_controller.rb', check: 'connectionDetail' },
```

Delete the now-stale top-of-file note claiming #4 is unbacked, and the comment
at the old line 128 saying "so #4 is `planned: 'P2'`".

- [ ] **Step 6: Add to the overview**

The incident guard will be red again. In `apps/web/app/page.tsx`:

```ts
    runCheckFor(name, CHECKS.connections),
    runCheckFor(name, CHECKS.connectionDetail, {}),
```

- [ ] **Step 7: Render on the sessions page**

In `apps/web/app/db/[name]/sessions/page.tsx`, run the check and add two
panels below the existing sessions table — sources, and the SSL breakdown:

```tsx
  const detail = await runCheckFor(name, CHECKS.connectionDetail, {});
```

```tsx
      <CheckPanel title="Connection sources" result={detail}>
        {(d) => (
          <>
            {d.truncated ? (
              <p className="mb-2 text-sm text-muted-foreground">
                Showing {d.connections.length} of {formatCount(d.total)} connections.
              </p>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Database</TableHead><TableHead>User</TableHead>
                  <TableHead>Source</TableHead><TableHead>IP</TableHead>
                  <TableHead className="text-right">Connections</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.sources.map((s) => (
                  <TableRow key={`${s.database}/${s.user}/${s.source}/${s.ip}`}>
                    <TableCell>{s.database ?? '—'}</TableCell>
                    <TableCell>{s.user ?? '—'}</TableCell>
                    <TableCell>{s.source || '—'}</TableCell>
                    <TableCell>{s.ip ?? 'socket'}</TableCell>
                    <TableCell className="text-right">{formatCount(s.connections)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-sm text-muted-foreground">
              {Object.entries(d.bySslStatus)
                .map(([status, n]) => `${formatCount(n)} ${status}`)
                .join(' · ')}
            </p>
          </>
        )}
      </CheckPanel>
```

Add `formatCount` to the existing `@/lib/format` import.

- [ ] **Step 8: Run everything**

```bash
npm test && npm run test:web && npm run typecheck:test
npm run --workspace @pgops/web typecheck
```

Expected: all green, including the incident guard.

- [ ] **Step 9: Commit**

```bash
git add packages/checks apps/web/app
git commit -m "feat(checks): connection list, sources and SSL breakdown (#4, #7, #65)

One pg_stat_activity round trip backs all three, because pgHero's own
controller derives sources and the security breakdown from a single
@database.connections call. Three queries would be three snapshots of a
table that changes between them, and the source counts would not sum to
the list.

sslStatus keeps pgHero's four-value scheme rather than a boolean: a
backend with no database is an auxiliary process, not an unencrypted
client, and a connection with no IP and no readable state is 'No SSL'
rather than 'Socket' — claiming socket there would invent a reassurance
out of missing data. ssl === true, never truthiness: NULL means
pg_stat_ssl had no row.

total_matching carries the pre-LIMIT count per sessions.ts, so a
truncated list still reports an honest total.

Parity: 47 remaining -> 44.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `slowQueries` — #17

**Files:**
- Modify: `packages/checks/src/checks/query-stats.ts` (append one exported function)
- Modify: `packages/checks/test/query-stats.test.ts` (append a `describe`)
- Modify: `packages/checks/src/registry.ts`, `apps/web/app/db/[name]/queries/page.tsx`

**Interfaces:**
- Consumes: `QueryStatsData`, `QueryStatRowData` from `query-stats.ts` — `{ rows: QueryStatRowData[]; totalShapes: number }`, rows carrying `calls: number` and `meanMs: number`.
- Produces: `slowQueries(data: QueryStatsData, opts?: SlowQueryOpts): QueryStatRowData[]` and `SLOW_QUERY_DEFAULTS: { minCalls: number; minMeanMs: number }`.

### Why this is a function and not a `Check`

pgHero's `slow_queries` takes `query_stats` and filters it —
`calls >= slow_query_calls && average_time >= slow_query_ms`. Making it a
`Check` would issue a second `pg_stat_statements` scan to re-derive rows the
queries page already has. It is a derivation, so it registers against
`check: 'queryStats'`, the precedent being #5 `total_connections` →
`check: 'connections'`.

- [ ] **Step 1: Write the failing test**

Append to `packages/checks/test/query-stats.test.ts`:

```ts
describe('slowQueries', () => {
  const q = (calls: number, meanMs: number): QueryStatRowData => ({
    queryid: `${calls}-${meanMs}`, query: 'SELECT 1', calls, totalMs: calls * meanMs,
    meanMs, stddevMs: 0, rows: calls, cacheHitPct: 100, redacted: false,
  });
  const data = (rows: QueryStatRowData[]): QueryStatsData => ({ rows, totalShapes: rows.length });

  /**
   * pgHero's defaults, verbatim: PGHERO_SLOW_QUERY_CALLS=100 and
   * PGHERO_SLOW_QUERY_MS=20 (lib/pghero.rb:44-45). Both conditions must
   * hold — a query called twice that takes a second is a one-off, and a
   * query called a million times at 1ms is the database working.
   */
  it('needs BOTH enough calls and enough mean time', () => {
    const rows = [q(100, 20), q(99, 20), q(100, 19), q(1, 5000), q(1e6, 1)];
    expect(slowQueries(data(rows)).map((r) => r.queryid)).toEqual(['100-20']);
  });

  it('treats each default as inclusive at its exact value', () => {
    expect(slowQueries(data([q(100, 20)]))).toHaveLength(1);
    expect(slowQueries(data([q(99, 20)]))).toHaveLength(0);
    expect(slowQueries(data([q(100, 19.999)]))).toHaveLength(0);
  });

  it('takes overrides for both bounds', () => {
    const rows = [q(5, 50)];
    expect(slowQueries(data(rows), { minCalls: 5, minMeanMs: 50 })).toHaveLength(1);
    expect(slowQueries(data(rows), { minCalls: 6, minMeanMs: 50 })).toHaveLength(0);
  });

  /**
   * A row Postgres redacted still carries full cost figures — only queryid
   * and query text are withheld (see QueryStatRowData.redacted). Dropping it
   * would hide the operator's slowest query precisely when it is one they
   * lack privilege to name, which is the case they most need told.
   */
  it('keeps a redacted row whose cost qualifies', () => {
    const redacted = { ...q(500, 100), queryid: null, query: null, redacted: true };
    expect(slowQueries(data([redacted]))).toHaveLength(1);
  });

  it('exposes the pgHero defaults it applies', () => {
    expect(SLOW_QUERY_DEFAULTS).toEqual({ minCalls: 100, minMeanMs: 20 });
  });
});
```

Add `slowQueries`, `SLOW_QUERY_DEFAULTS` and the types to the file's existing
import from `../src/checks/query-stats.js`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit packages/checks/test/query-stats.test.ts -t slowQueries`

Expected: FAIL — `slowQueries is not a function`.

- [ ] **Step 3: Implement, appended to `query-stats.ts`**

```ts
export interface SlowQueryOpts {
  minCalls?: number;
  minMeanMs?: number;
}

/**
 * pgHero's defaults (lib/pghero.rb:44-45), adopted rather than re-derived —
 * the same provenance rule the hygiene thresholds follow in the P2 spec §2.1.
 */
export const SLOW_QUERY_DEFAULTS = { minCalls: 100, minMeanMs: 20 } as const;

/**
 * pgHero's #17, which is a FILTER over query_stats, not a query of its own
 * (`query_stats.select { |q| q[:calls] >= slow_query_calls && q[:average_time]
 * >= slow_query_ms }`). Implemented the same way: a second
 * pg_stat_statements scan to re-derive rows the caller already has would cost
 * a round trip and give a second, inconsistent snapshot.
 *
 * Both bounds must hold. Either alone is a bad filter: a query called twice
 * that takes a second is a one-off, and a query called a million times at 1ms
 * is the database doing its job.
 *
 * Inherits `queryStats`'s LIMIT, exactly as pgHero's inherits its
 * `query_stats(**options)` limit — a slow shape outside the top N by the
 * caller's sort is not surfaced. Sort by `mean` to make this list definitive.
 */
export function slowQueries(data: QueryStatsData, opts: SlowQueryOpts = {}): QueryStatRowData[] {
  const minCalls = opts.minCalls ?? SLOW_QUERY_DEFAULTS.minCalls;
  const minMeanMs = opts.minMeanMs ?? SLOW_QUERY_DEFAULTS.minMeanMs;
  return data.rows.filter((r) => r.calls >= minCalls && r.meanMs >= minMeanMs);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run --project unit packages/checks/test/query-stats.test.ts`

Expected: PASS, existing cases plus 5 new.

- [ ] **Step 5: Re-point the registry entry**

```ts
  // A FILTER over #14's rows, not a query: pgHero's slow_queries selects
  // from query_stats on calls >= 100 && average_time >= 20ms. Derived by
  // `slowQueries(data)` in query-stats.ts — same precedent as #5, where an
  // aggregate this package already computes answers a pgHero capability
  // without a check of its own.
  17: { name: 'slow_queries', source: 'methods/query_stats.rb', check: 'queryStats' },
```

- [ ] **Step 6: Render on the queries page**

In `apps/web/app/db/[name]/queries/page.tsx`, sort by mean so the filter is
definitive over what was fetched, and show the slow set above the full table:

```tsx
import { CHECKS, slowQueries, SLOW_QUERY_DEFAULTS } from '@pgops/checks';
```

```tsx
      <CheckPanel title="Slow queries" result={result}>
        {(d) => {
          const slow = slowQueries(d);
          return slow.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No shape averages {SLOW_QUERY_DEFAULTS.minMeanMs}ms or more over{' '}
              {SLOW_QUERY_DEFAULTS.minCalls}+ calls.
            </p>
          ) : (
            <p className="text-sm">
              {formatCount(slow.length)} of {formatCount(d.rows.length)} shapes average{' '}
              {SLOW_QUERY_DEFAULTS.minMeanMs}ms or more over {SLOW_QUERY_DEFAULTS.minCalls}+ calls.
            </p>
          );
        }}
      </CheckPanel>
```

`slowQueries` and `SLOW_QUERY_DEFAULTS` are values, not types, so
`packages/checks/src/index.ts` needs a value export beside the existing
`export type *`:

```ts
export { slowQueries, SLOW_QUERY_DEFAULTS } from './checks/query-stats.js';
```

- [ ] **Step 7: Run everything and commit**

```bash
npm test && npm run test:web && npm run typecheck:test
git add packages/checks apps/web
git commit -m "feat(checks): slow query filter (#17)

pgHero's slow_queries is a filter over query_stats, not a query — calls
>= 100 && average_time >= 20ms, both defaults from lib/pghero.rb:44-45.
Implemented as a pure function over QueryStatsData for the same reason:
a second pg_stat_statements scan would cost a round trip and produce a
second, inconsistent snapshot of rows the page already holds.

Registers against check: 'queryStats', the precedent being #5
total_connections -> check: 'connections'.

Parity: 44 remaining -> 43.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Close the drift

Spec §8. This is the deliverable that started the whole thread, and it gets
its own gate because it is the one change nothing else in the plan verifies.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-26-pgops-web-design.md` §10
- Modify: `README.md`

**Interfaces:**
- Consumes: `parityBacklog(phase?: Phase): number` from `packages/checks/src/registry.ts`, unchanged.

- [ ] **Step 1: Read the real numbers out of the registry**

```bash
npm run --workspace @pgops/checks build
node -e "
const {parityBacklog, PGHERO} = require('./packages/checks/dist/registry.js');
const shipped = Object.values(PGHERO).filter(e => 'check' in e || 'action' in e || 'platform' in e).length;
const declined = Object.values(PGHERO).filter(e => 'declined' in e).length;
console.log({shipped, declined, backlog: parityBacklog(), p2: parityBacklog('P2')});
"
```

Use the printed values; do not carry the numbers from this plan's commit
messages, which were written before the tasks ran.

- [ ] **Step 2: Rewrite parent spec §10's P2 paragraph**

Replace the existing paragraph with one that names all ten areas and cites no
hand-written count:

```markdown
**P2 — the hygiene class.** `indexes`, `tables`, `space`, `sequences`,
`settings`, `maintenance`, `constraints`, plus the incident-class capabilities
that were scheduled here rather than classified here: `replication`,
per-connection detail, and `slow_queries`. Its size is
`parityBacklog('P2')` — the registry is the authority, and a count written
into prose is a second copy that nothing compares to the first. See
`docs/superpowers/specs/2026-09-03-pgops-p2-hygiene-design.md`.

The CLI surface this phase used to carry — `pgops check --format json` with
exit codes — was cut on 2026-09-03. P2 is web only. The consequence is
recorded in that spec's §0: with no cron surface, a hygiene finding arrives
when someone opens the page.
```

- [ ] **Step 3: Update the README's parity counts**

Replace the shipped/declined/remaining figures and the P2 sizing with the
values from Step 1. Leave the four documented divergences as they are and add
the two this plan introduced: replication lag is `null` on a primary where
pgHero answers `0`, and the connection security breakdown keeps pgHero's
four-value scheme.

- [ ] **Step 4: Verify no stale count survives**

```bash
grep -rn "~24\|24 gaps\|9 of 65\|15 of 65\|49 remaining" README.md docs/superpowers/specs/ || echo "clean"
```

Expected: `clean`. Any hit is a count this task exists to remove.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs
git commit -m "docs: name P2's real scope, and stop writing its size down

Parent spec §10 said 'seven areas, ~24 gaps'. The registry said 31 across
ten source files; the prose predated the 2026-08-26 re-audit and nothing
compared the two. The count is now cited as parityBacklog('P2') rather
than restated, because a number copied into prose is a second copy that
nothing keeps honest — which is the entire defect this closes.

Records the CLI cut and its consequence: with no cron surface, a hygiene
finding arrives when someone opens the page.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage.** §1.2's six capabilities: #49/#51 → Task 2, #4/#7/#65 →
Task 3, #17 → Task 4. §3's divergences: replication `null`-vs-`0` is Task 2
Step 3; the four-value SSL scheme is Task 3 Step 3. §4.2 (the poll) → Task 1.
§4.3 (overview guard goes red, then green) → Task 2 Step 6 and Task 3 Step 6.
§5's `count(*) OVER ()` rule → Task 3, `total_matching`. §8 → Task 5.
**Not covered here, by design:** §1.1's 25 hygiene capabilities, §2's
thresholds, §4.1's six routes, §6's integration grouping — all P2b.

**2. Placeholder scan.** No TBD/TODO. Every code step carries the real code.
The one deliberate deferral is the hygiene half of Task 1's guard, which is
argued rather than hand-waved: it has no subject until P2b creates one.

**3. Type consistency.** `ConnectionDetailRow` is the row type in both the
check and `sslStatus`, and `connections: ConnectionDetailRow[]` in the data —
the list is passed through unmapped, so the two agree by construction.
`total_matching` is `string` (bigint) on the row and `Number(...)`-converted
in `map`, matching `sessions.ts`. `QueryStatsData`/`QueryStatRowData` are used
as already defined; Task 4 adds no field to either. `replicationLag` is the
`CHECKS` key in Task 2 Steps 5, 6 and 7 alike.

**One gap found and left open deliberately:** Task 3's `connectionDetail` has
no integration test. The three derivations are pure and unit-tested, and the
SQL is a `LEFT JOIN` over two catalog views that `identity.int.test.ts`
already proves are readable in the harness. Adding a file to a 244-second
suite to assert a join parses is not worth the wall-clock. Recorded here so
the reviewer sees it was decided, not forgotten.
