# pgops v1 — the web console — design spec

**Date:** 2026-08-26 · **Status:** proposed, awaiting approval
**Supersedes:** the surface decisions in `2026-08-19-pgops-ops-console-design.md`
(§5 tab strip, §7 views). Its §3 parity matrix, §3.4 divergences, §4 action
ladder and §6 storage intent survive and are carried forward here.

---

## 0. Decisions taken as given

Settled before this document; recorded so the reasoning below is auditable.

| Decision | Value |
|---|---|
| Surface | Next.js web app |
| The Ink TUI | **Deleted.** Not frozen, not maintained — removed. |
| Run model | Deployed service: `docker run -p 8080:8080`, one URL, many databases |
| History store | A `pgops` schema in a designated database; falls back to the monitored database when there is only one |
| Scope of v1 | Full pgHero parity target, including capture and charts |
| Repo shape | npm workspaces monorepo |
| Benchmark | pgHero, and only pgHero. It is the ground truth for what "complete" means. |

---

## 1. The organizing idea

Everything below follows from one sentence:

> **pgops is a function from a database to a set of findings. Everything else is
> transport.**

A finding is the same shape whether it came from `pg_locks` or from a 30-day
size series, whether it renders as an HTML table, a JSON object on stdout, or a
non-zero exit code. Get the result envelope uniform and there is exactly one
renderer, one serializer, one alerting rule — not sixty.

The failure this avoids is the one the current codebase already has: four views,
each owning its own copy of "who is blocked", two of which disagree. That
happened because there was no place where a question was *one thing*.

Two consequences that shape the rest of the document:

1. **The knowledge lives in one package that knows nothing about how it is
   displayed.** No React, no Next, no HTTP.
2. **"Now" and "over time" are different questions and get different
   interfaces.** Forcing a 30-day series through a shape designed for a single
   verdict is how a design becomes incoherent. They are siblings, not variants.

---

## 2. Architecture

```
packages/checks/          pure logic + `pg`. No framework, ever.
  src/checks/             one file per area: locks, sessions, vacuum, indexes…
  src/series/             the "over time" half
  src/store/              pgops schema: DDL, migrations, read/write
  src/actions/            kill, analyze, reset — writes, audited
  src/registry.ts         CHECKS, SERIES, and the pgHero parity map
  src/run.ts              runCheck / runSeries — the only executors

packages/cli/             pgops init | capture | check
  depends on: @pgops/checks

apps/web/                 Next.js App Router
  depends on: @pgops/checks
```

**The dependency direction is the point.** `packages/checks/package.json` lists
`pg` and nothing else, so `import … from 'react'` inside a check does not fail
review — it fails to resolve. That wall is the only reason the layering survives
sixty checks and two consumers.

`store` stays inside `checks` rather than becoming a third package: it is ~300
lines, and both the series readers and the capture writer need it. A package for
it would be ceremony.

---

## 3. The check model

### 3.1 A check

```ts
export interface Check<Row, Data> {
  id: string;                       // 'wraparound', 'unused_indexes'
  title: string;
  class: 'incident' | 'hygiene';    // where it surfaces; see §6.2
  sql: string;
  map: (rows: Row[]) => Data;                          // pure
  verdict?: (data: Data, t: ThresholdSet) => Verdict;  // pure
  thresholds?: Threshold[];
  requires?: Requirement[];         // extension | role | server version
}
```

`map` and `verdict` are pure and testable with no database. `sql` is the only
impure part and it is a string, so it can be linted, diffed, and executed
directly in `psql` by a human who wants to check our work.

### 3.2 Thresholds are data

```ts
export interface Threshold {
  level: 'warn' | 'critical';
  value: number;
  unit: 'seconds' | 'transactions' | 'bytes' | 'percent' | 'count';
  because: string;    // the sentence that justifies this number
}
```

This is not decoration. Six of the eleven defects in
`reviews/2026-08-26-pre-port-review.md` are calibration errors — correct SQL
compared against a constant that means something other than the label claims.
The worst of them shipped a `critical` at 8.38% of the horizon it was named
after, and 363 tests agreed with it because the test asserted the constant
matched itself.

`because` makes that failure hard to write down. Compare:

```ts
// what shipped, as a bare constant:
if (pctOfHorizon >= 90) return { level: 'critical' };

// what the shape forces you to say out loud:
{ level: 'critical', value: 100_000_000, unit: 'transactions',
  because: 'transactions remaining before the server refuses writes; pgHero #44 '
         + 'flags at 10M, we leave room to vacuum a large table first' }
```

`unit` is load-bearing too: it makes a duration labelled "waiting" that actually
measures query age (finding A8) a type-level question rather than a review-level
one.

### 3.3 The result envelope — uniform, and it never throws

```ts
export type CheckResult<D> =
  | { ok: true;  data: D; verdict: Verdict; measuredAt: number }
  | { ok: false; reason: FailureReason; message: string; remedy?: string };

type FailureReason =
  | 'privilege' | 'missing-extension' | 'unsupported-version'
  | 'unreachable' | 'error';
```

**Isolation.** `runCheck` never rejects. This is the existing `fetchTriage`
per-panel design, and across sixty checks on managed Postgres — where any given
one may be denied — it is the only thing that works. One unreadable check must
never blank a page.

**`reason` is machine-readable, and this is what the web can do that the terminal
could not.** `missing-extension` renders a card containing the exact
`CREATE EXTENSION` statement; `privilege` renders the exact `GRANT`. Today that
information exists only as a pattern-match on an error string inside
`top/index.tsx`, and only for one check.

### 3.4 Context — pools are passed in, never reached for

```ts
export interface CheckContext {
  target: Pool;    // the database being examined
  store?: Pool;    // the pgops schema
  serverVersion: number;
}
```

`packages/checks` holds **no module-level state.** The current
`core/connection.ts` keeps `let pool` at module scope, which is why
`fetchTriage()` takes no arguments and can only ever address one database —
incompatible with multi-database (pgHero #60) and with a capture job iterating
targets.

The two-pool split is deliberate and early: history-backed checks read the live
target *and* the recorded series. Retrofitting a second connection into a
one-connection signature after sixty checks exist touches all sixty.

### 3.5 The registry, and parity that cannot drift

```ts
export const CHECKS = { wraparound, blockedSessions, unusedIndexes, /* … */ } as const;

type ParityEntry = { name: string; source: string } & (
  | { check: keyof typeof CHECKS }        // shipped: owned by a real check
  | { planned: Phase }                    // spec'd, not yet built
  | { declined: string }                  // will never be built, with the reason
);

export const PGHERO: Record<number, ParityEntry> = {
  44: { name: 'transaction_id_danger', source: 'methods/maintenance.rb',
        check: 'wraparound' },
  58: { name: 'suggested_indexes', source: 'methods/suggested_indexes.rb',
        planned: 'P6' },
  13: { name: 'kill_all', source: 'methods/kill.rb',
        declined: 'An action with no diagnosis — v0.2 spec §3.4d' },
};
```

The three states exist because parity is claimed at the end of P6, not at P0 — an
entry must be able to say "owned, not yet built" without either lying or failing
the build. Four assertions, no framework, milliseconds:

1. every id `1…60` has an entry, in exactly one of the three states;
2. every `check:` names a key that exists in `CHECKS`;
3. the declined set is exactly `{13}`;
4. every `planned:` names a phase that exists in §10.

The count of `planned` entries is the parity backlog, printed by CI on every run.
**Parity is complete when that count reaches zero** — which makes "strict superset
of pgHero" a number the build reports rather than a claim someone has to audit.

The v0.2 spec called this *"what makes 'strict superset' a property the build
enforces rather than a claim in a document"* and it was never written — because
it was framed as metadata beside the code, and metadata beside code drifts. Here
the map references live check keys: deleting a check breaks the test, and adding
a pgHero capability with no owner breaks it too.

---

## 4. Series and the store

### 4.1 Why this is a separate interface

A check answers *"what is true now"* and yields one verdict. A series answers
*"how has this moved"* and yields many points with no verdict at all. They share
plumbing (pools, requirements, failure envelope) and share nothing else.

```ts
export interface Series<Point> {
  id: string;                 // 'query_time', 'relation_size'
  read: (ctx: CheckContext, range: TimeRange) => Promise<Point[]>;
  requires?: Requirement[];
}
```

### 4.2 Schema

```sql
CREATE SCHEMA pgops;

pgops.schema_version (version int)

pgops.databases   (id, name, created_at)

pgops.queries     (id, database_id, queryid bigint, query text,
                   first_seen, last_seen)      -- text stored once, not per capture

pgops.query_stats (database_id, query_id, captured_at,
                   calls, total_exec_time, rows,
                   shared_blks_hit, shared_blks_read,
                   stats_reset timestamptz)     -- cumulative counters, never deltas

pgops.space_stats (database_id, relation, captured_at, size_bytes)
```

Query text is normalised into `pgops.queries` because a 5,000-shape database
capturing every 5 minutes would otherwise store ~1 kB × 5,000 × 288/day of
duplicated text. pgHero does the same.

`pgops` lives in its own schema, never `public` — v0.2 spec §3.4c, unchanged.

### 4.3 Capture, and the one rule that must not be broken

`pgops capture` runs on external cron or a k8s CronJob every 5 minutes. Not an
in-process timer: two web replicas would double-write, and a server restart would
silently drop the schedule.

> **pgops must never reset a shared statistics view as a side effect of
> capture.**

pgHero's `capture_query_stats` calls `pg_stat_statements_reset()` after each
snapshot — which is how it gets deltas, and which means installing pgHero
silently breaks every other consumer of `pg_stat_statements` on that database.
We store cumulative counters and diff at read time. Resetting stays an explicit
user action. This is the strongest product claim in the whole document and it is
enforced by a test (§9).

Concurrency: capture takes a Postgres advisory lock keyed on the database id, so
overlapping invocations are safe without coordination.

### 4.4 Delta maths and discontinuity detection

Counters are cumulative since the last reset. A delta is the difference between
consecutive snapshots, with two hazards:

- **Explicit reset.** Someone calls `pg_stat_statements_reset()`. Counters drop.
- **LRU eviction.** `pg_stat_statements.max` defaults to 5,000; a shape evicted
  and later re-added restarts from zero, which looks identical to a reset for
  that row.

Rule: an interval is a **discontinuity** and is dropped — not clamped to zero,
not rendered as a spike — when either `stats_reset`
(`pg_stat_statements_info`, PG14+) advanced, or any counter decreased. A gap in
a chart is honest; a spike is a lie that reads as an incident.

### 4.5 Retention

Pruned in the same transaction as the insert, so retention cannot drift from
capture. Defaults: `query_stats` 14 days, `space_stats` 90 days (pgHero's).
Overridable per deployment.

### 4.6 Migrations

`pgops init` executes numbered SQL files and records the level in
`pgops.schema_version`. Forward-only, idempotent, no migration framework. It is
the **only** code path in the entire product permitted to issue DDL, and it lives
in the CLI — never reachable from the web.

---

## 5. Corrections folded into the port

The extraction is not a move; six queries are rewritten. From
`reviews/2026-08-26-pre-port-review.md`:

| # | Correction |
|---|---|
| A1 | Wraparound becomes two numbers: `% to forced autovacuum` (informational) and `transactions until shutdown` (the alarm). Per-table via `age(relfrozenxid)` — pgHero #44. |
| A2 | The wait graph is rebuilt on `pg_blocking_pids()`. Kills the false root blocker and the flat cascade in one change. |
| A3 | Connection headroom subtracts `superuser_reserved_connections` + `reserved_connections`. |
| A4 | `top`'s sort key and its `LIMIT` key become the same key; the discarded count is displayed. |
| A5 | `pg_stat_statements` filters `toplevel` where the column exists. |
| A6 | Slot retention covers active slots; `pg_last_wal_receive_lsn()` on a standby. |
| A7 | `sessions` and `locks` gain bounded result sets. |
| A8–A11 | Unit-accurate labels, `inStateSecs` for idle ordering, pid-searchable filter, one definition of "idle in transaction". |

---

## 6. The web app

### 6.1 Rendering

App Router, Server Components. Pages call `runCheck` directly — no internal HTTP
layer. An API exists only where something outside the process consumes it (§7.3).

**Every check-rendering path is explicitly dynamic.** `await connection()` before
reading configuration or running a check.

> This is not a preference. In a Server Component, `process.env.DATABASE_URL` is
> inlined **at build time** unless the component opts into dynamic rendering. Our
> entire configuration model is `docker run -e DATABASE_URL=…` against an image
> built months earlier. Get this wrong and the container talks to whatever
> database was set when the image was built. Enforced by lint rule and by a
> smoke test that builds an image with one URL and runs it with another.

### 6.2 Routes

```
/                          overview — every database, worst verdict each
/db/[name]                 triage: the incident-class checks on one screen
/db/[name]/sessions        live sessions · kill
/db/[name]/locks           wait graph · kill
/db/[name]/queries         pg_stat_statements + trend charts
/db/[name]/space           sizes + growth
/db/[name]/indexes         unused · duplicate · invalid · bloat · missing
/db/[name]/tables          per-table stats, hit rates, dead tuples
/db/[name]/vacuum          autovacuum state, progress, wraparound per table
/db/[name]/replication     lag, slots, retained WAL
/db/[name]/sequences       exhaustion + invalid constraints
/db/[name]/config          settings review
/db/[name]/doctor          every hygiene finding, one page
```

`class: 'incident'` checks appear on `/db/[name]`; `class: 'hygiene'` checks
appear on their own page and aggregate into `/doctor`. This is the v0.2 spec's
§5.2 urgency rule, kept — it was the best idea in that document and it survives
the surface change intact.

### 6.3 Refresh

Incident pages refresh; hygiene pages do not. A small client component calls
`router.refresh()` on an interval, carrying forward the three properties of
`ui/usePoll.ts` — which is the best-reasoned file in the current codebase:

1. a tick that lands while one is in flight is **skipped, not queued**, so the
   tool cannot add load to the database it is diagnosing;
2. freshness is stamped at request **start**, not at response — a 5 s fetch reads
   "updated 5s ago" the moment it lands, which is true;
3. an operator-requested refresh is re-armed into a single slot, so the refresh
   fired after a kill cannot be swallowed by one that started before it.

No websockets. A refresh interval that skips is exactly right and needs no
transport.

### 6.4 Charts

**Hand-rolled inline SVG, server-rendered. No chart library.**

The charts required are time-series lines and sparklines. That is ~150 lines of
path generation, zero dependencies, zero client JS, and it renders inside the
strict no-external-host posture without an argument. Hover detail uses `<title>`
elements, which need no JavaScript.

We are not going to out-chart a Rails app with an asset pipeline, and we do not
need to. If interaction (zoom, brush) later proves necessary, one library goes in
then — for one page.

---

## 7. Safety

### 7.1 The action ladder

| Tier | Actions | Gate |
|---|---|---|
| 0 | every read | always available |
| 1 | `kill`, `analyze` | `PGOPS_ALLOW_ACTIONS=true` **and** confirm |
| 2 | `reset` stats | tier 1 gate + typed confirmation |
| 3 | DDL (`pgops init` only) | CLI only. Never reachable from the web. |

**Actions are off by default.** A web endpoint that terminates backends is a
materially different object from a keystroke in a terminal session someone had to
SSH into. A deployment that never sets `PGOPS_ALLOW_ACTIONS` cannot reach tiers
1–3 at all — the routes do not exist.

`kill` keeps the guard that already works: the identity check and the side effect
are one statement against one snapshot, so a recycled pid cannot be killed by
mistake.

```sql
SELECT CASE WHEN backend_start = $2::timestamptz
            THEN pg_terminate_backend(pid) ELSE NULL END
FROM pg_stat_activity WHERE pid = $1
```

Every tier ≥ 1 action writes an audit record. In a deployed service the audit log
goes to stdout as JSON (the container convention) as well as to disk.

### 7.2 Auth

`PGOPS_USERNAME` / `PGOPS_PASSWORD` → HTTP basic via middleware, matching
pgHero's shape. The documentation states plainly that basic auth is the floor and
a reverse proxy (OAuth2 Proxy, ALB auth, IAP) is the answer for anything
real — which is what pgHero's own guide says.

### 7.3 Redaction

`redactSecrets` ports unchanged and runs on every rendered query, not just on
export. It matters **more** here than in the terminal: a screenshot needs a human
to take it, a URL forwards itself.

The one JSON surface — `pgops check --format json` — passes through the same
chokepoint.

---

## 8. Configuration and deployment

```sh
# one database
docker run -e DATABASE_URL=postgres://… -p 8080:8080 pgops

# many
docker run -e PGOPS_DATABASES='[{"name":"prod","url":"postgres://…"},…]' \
           -e PGOPS_STORE_URL=postgres://…                              \
           -e PGOPS_USERNAME=… -e PGOPS_PASSWORD=…                      \
           -p 8080:8080 pgops

# capture, on cron
docker run --rm -e PGOPS_DATABASES=… -e PGOPS_STORE_URL=… pgops capture
```

JSON, not YAML or TOML — `JSON.parse` is free and neither alternative earns a
dependency. `PGOPS_CONFIG_FILE` points at the same JSON on disk for deployments
that prefer a mounted file.

Image: multi-stage build on `output: 'standalone'`, running `node server.js` as a
non-root user. Standalone traces only the files actually reached, so the runtime
layer carries no build toolchain.

---

## 9. Testing and CI

The current repo has 363 passing tests, none of which touches a database. That is
precisely why six SQL defects survived to this document. The test strategy is
built around closing that.

| Layer | Test |
|---|---|
| **Every check, real Postgres** | Testcontainers. Seed a fixture, run the check, assert the data. This is the suite that did not exist. |
| **Every threshold, boundary** | Construct database state just below and just above each `Threshold.value`; assert the verdict flips exactly there. This is what would have caught A1 — a test that asserts a constant equals itself cannot. |
| **Version matrix** | PG 14 · 16 · 17 · 18 in CI. Catches `toplevel` (A5), `reserved_connections` (A3), and the recovery-only branches (A6). |
| **Capture is non-destructive** | Run `capture` twice against a live database; assert `pg_stat_statements` counters are monotonically increasing. The §4.3 rule, enforced. |
| **Delta maths** | Synthetic counter series including a mid-series reset and an LRU eviction → interval dropped, never spiked. |
| **Parity registry** | Every pgHero id in exactly one of shipped/planned/declined; declined set is exactly `{kill_all}`; the remaining `planned` count is printed by CI as the parity backlog. Pure, milliseconds. |
| **Runtime env** | Build an image with one `DATABASE_URL`, run it with another, assert it uses the second. Guards §6.1. |
| **Action gating** | With `PGOPS_ALLOW_ACTIONS` unset, tier ≥ 1 routes return 404. Asserted against the route, not the UI. |
| **Web smoke** | Playwright against the built container: every route renders against a seeded database, and against a database where every check is denied. |

**CI does not exist today and is created in P0**: typecheck, unit, integration
matrix, image build.

---

## 10. Phasing

One spec, six phases, each independently shippable.

**P0 — foundation.** Workspace. Extract the ten existing capabilities into
`packages/checks`, **rewriting A1–A6 as part of the extraction, not after**.
Testcontainers harness. Parity registry with the current ten owned. CI.
*No user-visible change; this is the phase that makes the rest safe.*

**P1 — the console exists.** Next app, incident routes, Docker image, auth,
multi-database config, `router.refresh()` polling. `kill` behind the flag.
**The Ink TUI, `src/ui/`, and the Ink/React-terminal dependencies are deleted
here.** This is the phase where pgops stops being a terminal program.

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

**P3 — history.** `pgops init`, the `pgops` schema, `pgops capture`, retention,
delta maths, discontinuity detection.

> **Amended 2026-09-03** — see `2026-09-03-pgops-full-parity-design.md` §11.
> P3 ships BEFORE P2. `pgops init` and `packages/cli` are cut: migrations run
> at boot and capture runs in-process behind an advisory lock, gated on an
> explicit `PGOPS_STORE_URL` with no fallback to a monitored database.

**P4 — charts.** Trend views over P3's data. Query trends, space growth.

**P5 — remaining actions.** `analyze`, `reset`, bulk kill of a filtered
selection.

**P6 — the long tail.** `suggested_indexes` (needs a SQL parser — the riskiest
item, deliberately last), `explain`, `system` (the only capability needing a
cloud SDK), `review` as a CI migration gate.

Parity is claimed at the end of P6, not before.

---

## 11. Cut, and why

Removed from the roadmap entirely. Each was carrying design weight for no user.

| Cut | Reason |
|---|---|
| `mcp` | Not a pgHero capability. No user asking. Adds a protocol surface. |
| `events` (cloud-event correlation) | Not a pgHero capability. Needs per-cloud credentials for a correlation nobody requested. |
| `parts` (pg_partman) | Not a pgHero capability. A separate product. |
| The nine-tab strip and its digit bindings | A keyboard-navigation model for a surface that no longer exists. URLs replace it. `Esc`-to-triage, tab cycling, and the key-suppression rule all go with it. |
| `--snapshot` markdown export | Superseded by a URL. `check --format json` covers the machine case; a link covers the human one. |

Kept but deferred to P6: `system` (#59) and `suggested_indexes` (#58), the two
capabilities that each add a substantial dependency.

---

## 12. What this document does not decide

- Visual design of the pages. Deliberately out of scope; it is not architecture
  and deciding it here would freeze it too early.
- Whether `packages/cli` is published to npm separately from the image.
- Alert delivery (webhook, email). `check --format json` with an exit code is the
  integration point for v1; anything richer waits for a user asking.
