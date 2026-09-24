# pgops

An on-call console for PostgreSQL. It shows lock chains, slow queries,
connection pressure, replication and vacuum state for one or many databases,
live, from a single container. When a deployment opts in, it can terminate the
backend that is holding everything up, with a confirmation and an audit record.

pgops is audited capability by capability against
[pgHero](https://github.com/ankane/pghero). Of pgHero's 65 capabilities, 60
are shipped and 5 are declined with a stated reason, and a test fails if that
count drifts from the code. See [Parity with pgHero](#parity-with-pghero).

- **Status:** v2.4.0. Tested against Postgres 14, 16, 17 and 18. No published
  image yet; build it from a clone.
- **License:** Apache-2.0.

## Contents

- [Why pgops](#why-pgops)
- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Database permissions](#database-permissions)
- [Pages](#pages)
- [How it works](#how-it-works)
- [Safety model](#safety-model)
- [Parity with pgHero](#parity-with-pghero)
- [Development](#development)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Contributing, security and license](#contributing-security-and-license)

## Why pgops

During a database incident the questions are always the same. Can new
connections get in? Is anything waiting on a lock instead of working? Is the
work itself slow? Can the server keep up with what has already committed?
Answering them by hand means running a dozen catalog queries under time
pressure and remembering which decision each answer implies.

pgops runs those queries continuously, orders the results by that causal
chain, and states a verdict next to every reading: what the number is, why it
matters, and what to do. A check that cannot run says why. It never renders
an unreadable value as zero, and it never renders a database it could not
reach as healthy.

Design constraints that shaped the tool:

- **One container, no agent.** It connects with credentials you give it. It
  runs no DDL against a monitored database, installs no extensions and creates
  no roles. The only schema it owns is in the store you give it.
- **Configuration is read at request time.** The same image runs against any
  database. A smoke test builds an image with one `DATABASE_URL` baked in,
  runs it with another, and asserts the container uses the second.
- **Actions are opt-in and audited.** Without the flag, the action routes do
  not exist. With it, every kill is confirmed, pinned to a session identity
  rather than a pid, and written to an audit log.
- **The console never becomes the problem.** Polls that land while one is in
  flight are skipped, not queued. Explain runs in a read-only transaction that
  is always rolled back. pgops's own sessions are counted, not hidden.

## Features

**Incident pages, polled every 5 seconds**

- Overview of every configured database with its worst verdict.
- Triage page: one band per gate, escalated checks expand into a panel with
  cause and remedy, healthy checks collapse to one line.
- Sessions: live `pg_stat_activity`, connection sources with an SSL breakdown,
  terminate controls.
- Locks: the wait graph as a tree with the root blocker on top and cycles
  marked.
- Queries: `pg_stat_statements` sortable by total, mean or calls, plus a slow
  query panel.
- Cleanup: wraparound horizon, replication role and lag, replication slots,
  server settings.

**Hygiene pages, run on open**

- Indexes: hit rate, missing, unused, duplicate and invalid indexes, index
  bloat, suggested indexes with the exact `CREATE INDEX` statement.
- Tables: hit rate, unused tables, per-table statistics.
- Space: database and relation sizes, largest relations, growth over time.
- Maintenance: running vacuums with progress, last vacuum and analyze per
  table, transaction ID age by relation.
- Sequences: every sequence measured against the ceiling of the column it
  feeds, not its own maximum.
- Explain: paste a statement, read its plan and the index that would serve it.

**History, with a store configured**

- Statement statistics and relation sizes captured every 5 minutes without
  ever resetting shared counters.
- 24-hour charts of execution time and call volume per database and per
  statement shape. 30-day size history per relation.
- Hygiene findings cached on each capture and summarised on the triage page
  with the age of the reading.

**Operations**

- HTTP basic auth over every route. Least-privilege role documented below.
- JSON audit record for every action, to stdout and to a local file.
- Secret redaction on every rendered query and every audit line.
- Follows the operating system's light or dark setting. No font CDN, no
  external requests from the browser.

## Quick start

Requires Docker.

```sh
git clone https://github.com/jonathanchowjh/pg-ops.git
cd pg-ops
docker build -t pgops .

docker run -e DATABASE_URL=postgres://user:pass@host:5432/db -p 8080:8080 pgops
```

Open http://localhost:8080.

Several databases behind basic auth, with history enabled:

```sh
docker run \
  -e PGOPS_DATABASES='[{"name":"prod","url":"postgres://…"},{"name":"analytics","url":"postgres://…"}]' \
  -e PGOPS_STORE_URL=postgres://… \
  -e PGOPS_USERNAME=admin -e PGOPS_PASSWORD=… \
  -p 8080:8080 pgops
```

To enable the terminate, analyze and statistics-reset actions, add
`-e PGOPS_ALLOW_ACTIONS=true`. Read [Safety model](#safety-model) first.

## Configuration

Configuration comes from environment variables, read on every request.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | One database, named `default`. |
| `PGOPS_DATABASES` | JSON array of `{"name","url"}`. `name` becomes a URL path segment and must match `[A-Za-z0-9_-]+` and be unique. |
| `PGOPS_CONFIG_FILE` | Path to a file containing that same JSON array. The only form that keeps connection strings out of the process environment. |
| `PGOPS_STORE_URL` | A Postgres database pgops may create its own `pgops` schema in. Enables history. |
| `PGOPS_USERNAME`, `PGOPS_PASSWORD` | HTTP basic auth over every route. Set both or neither. Setting exactly one is a 503 on every request. |
| `PGOPS_ALLOW_ACTIONS` | `true` enables the action routes. Any other value leaves them absent. |
| `PGOPS_PUBLIC_HOST` | Host name recorded in audit records. Defaults to the request's `Host` header. |
| `PGOPS_AUDIT_LOG` | Path of the local audit log copy. Defaults to `~/.pgops/audit.log`. |
| `PORT` | Listen port. `8080` in the image. |

Database sources take precedence in the order `PGOPS_CONFIG_FILE`, then
`PGOPS_DATABASES`, then `DATABASE_URL`. If none is set, or the value cannot be
parsed, the server starts and every page reports that pgops is not configured,
along with the input it read and the exact parse error.

**Requirements.** Postgres 14 or newer. The `pg_stat_statements` extension
for the Queries page; every other page works without it and the Queries page
states what is missing.

## Database permissions

pgops needs a role with `LOGIN`. These grants cover the reads, terminate and explain:

| Grant | Enables |
|---|---|
| `pg_read_all_stats` | Reading other sessions' query text. Without it those rows read `insufficient privilege` and everything else works. |
| `pg_signal_backend` | Terminating sessions. Without it a kill returns Postgres's permission error in the page. |
| `SELECT` on the tables to be planned, or `pg_read_all_data` | Explain and suggested indexes. Postgres checks `SELECT` even for a plan that reads no rows. Each refused plan names the table. |
| Table ownership, or `MAINTAIN` on Postgres 17 and newer | The analyze action. A table the role cannot analyze is reported as refused, by name, and the rest proceed. |

```sql
CREATE ROLE pgops LOGIN PASSWORD '…';
GRANT pg_read_all_stats, pg_signal_backend, pg_read_all_data TO pgops;
```

pgops never needs superuser. Running it as one is a deployment decision, not a
requirement.

## Pages

| Route | Content | Refresh |
|---|---|---|
| `/` | Every database with its worst verdict. An unreachable database shows `UNKNOWN`, never `OK`. | Every 30 s |
| `/db/<name>` | Triage. One band per gate, escalated checks expanded, cached hygiene findings with their age. | Every 5 s |
| `/db/<name>/sessions` | Live sessions, connection sources, SSL breakdown, terminate controls. | Every 5 s |
| `/db/<name>/locks` | Lock wait graph as a tree. | Every 5 s |
| `/db/<name>/queries` | Statement statistics, slow queries, 24-hour execution time and call charts, statistics reset. | Every 5 s |
| `/db/<name>/queries/<queryid>` | One statement shape over 24 hours: calls, time, rows, blocks read. | On open |
| `/db/<name>/queries/explain` | Plan a pasted statement. | On open |
| `/db/<name>/queries/indexes` | Index hit rate, missing, unused, duplicate and invalid indexes. | On open |
| `/db/<name>/queries/indexes/bloat` | Index bloat estimate. Separate route because the estimate is expensive. | On open |
| `/db/<name>/queries/indexes/suggested` | Suggested indexes for the busiest shapes, with the statement to run. | On open |
| `/db/<name>/queries/tables` | Table hit rate, unused tables, per-table statistics. | On open |
| `/db/<name>/cleanup` | Wraparound horizon, replication role and lag, slots, server settings. | Every 5 s |
| `/db/<name>/cleanup/space` | Database size, size over 30 days, largest relations, 7-day growth. | On open |
| `/db/<name>/cleanup/space/<relation>` | One relation's size over 30 days. | On open |
| `/db/<name>/cleanup/maintenance` | Running vacuums with progress, last vacuum and analyze, transaction ID age. Analyze action. | On open |
| `/db/<name>/cleanup/sequences` | Every sequence against its column's ceiling. | On open |

Every page under `/db/<name>` carries a status line with the database, role,
version, SSL state and replica flag as reported by the server. The header
shows the age of the data on screen, counted from when the request started,
so a stalled poll is visible as a climbing number rather than a frozen one.

## How it works

### The four gates

Every check belongs to one of four gates. A request has to clear them in
order, and the triage page renders them in that order.

```
1 connect   can it get in?          connections, sessions, sources
2 wait      can it get its locks?   blocked sessions, the wait graph
3 work      can it do the work?     long-running queries, statement statistics
4 keep-up   can the server keep up? replication, vacuum, space
```

The order matters for two reasons. Causes run down it and symptoms run up
it: vacuum falls behind at gate 4, tables bloat, queries slow at gate 3,
connections pile up at gate 1. And a failure at one gate disguises itself as
the next: a session blocked at gate 2 is `active` in `pg_stat_activity`, so a
naive tool lists it as a long-running query at gate 3 and offers to terminate
it. pgops marks such a session with the root blocker it is queued behind and
withholds the terminate advice, because killing a waiter frees nothing.

The gate tree is data, in
[packages/checks/src/gates.ts](packages/checks/src/gates.ts). Every check
declares its gate, and a test fails if any capability is added without one.

### Two packages

```
packages/checks    Everything that knows Postgres. One runtime dependency: pg.
apps/web           The Next.js console. Renders what packages/checks returns.
```

`packages/checks` contains every SQL statement, threshold, verdict, action
and redaction rule. It has no React, no HTTP and no knowledge of display. A
test fails if it gains a second runtime dependency or imports from
`apps/web`.

`apps/web` never constructs its own connection pool, never writes SQL and
never calls `pg_terminate_backend`. Every page runs its checks through one
seam, `runCheckFor`, and renders the result. This is what makes the checks
testable against a real Postgres without a browser, and the pages testable
without a database.

### Checks, verdicts and thresholds

A check is one SQL query, a pure function from rows to a result, and a
verdict function that returns `ok`, `warn` or `critical`. Thresholds are data,
not constants in a comparison. Each carries its unit, why the number matters,
and what action it calls for. A threshold with no single safe action carries
no advice.

A check that cannot run returns a failure with the reason: a missing
extension, an insufficient privilege, a server version below what it needs.
The page renders it as `UNKNOWN`, never as green.

### History

With `PGOPS_STORE_URL` set, pgops creates a `pgops` schema in that database
on boot, under an advisory lock so several replicas starting together migrate
once. Every 5 minutes it captures every statement shape and every relation
size, then runs the hygiene checks and caches their findings. Four
properties, each held by a test:

- **It never resets shared counters.** pgHero calls
  `pg_stat_statements_reset()` after each capture, which zeroes the view for
  every other tool. pgops stores cumulative values and differences them at
  read time.
- **A gap is drawn as a gap.** An interval spanning a counter reset is dropped
  from the chart, not clamped to zero or interpolated.
- **A capture that lands while one is running is skipped.**
- **Timestamps come from the store, not the process**, so replicas with
  skewed clocks cannot fabricate discontinuities.

Without the variable there is no scheduler and no DDL anywhere. History
reports itself as unavailable.

## Safety model

pgops can terminate backends, reset statistics and write to a store. The
following holds regardless of how it is deployed.

Actions sit on a ladder. A deployment opts into the whole ladder or none of
it.

| Tier | Actions | Gate |
|---|---|---|
| 0 | Every read, and explaining a statement | Always available |
| 1 | Terminate one session. Analyze tables. | `PGOPS_ALLOW_ACTIONS=true`, plus an inline confirmation with a required reason |
| 2 | Terminate every long-running query. Reset query statistics. Reset database statistics. | Tier 1, plus the database name typed back and checked on the server |
| 3 | Schema changes | Not implemented. See [the declines](#the-five-declines). |

- **Without the flag, the action routes do not exist.** Every method answers
  404, byte-identical to an unknown path. The gate sits in
  [apps/web/proxy.ts](apps/web/proxy.ts) above method dispatch, and an
  integration test asserts it against a running server.
- **Action routes require `Content-Type: application/json`** and answer 415
  otherwise. A cross-origin HTML form cannot set that header, which closes
  the CSRF path that basic-auth credentials would otherwise open.
- **Kills are pinned to session identity, not pid.** The target's
  `backend_start` is captured when the row is selected and compared, inside
  the same statement as the terminate, against `pg_stat_activity`. A recycled
  pid returns `session-changed` and is left alone. The bulk kill is N guarded
  kills with per-session outcomes, never a sweep.
- **Every action is audited**, success or failure, as one JSON line to stdout
  and to `PGOPS_AUDIT_LOG`. The record names the operator, the target, the
  reason and the outcome.
- **Explain plans a statement and never runs it.** The pasted text is prepared
  as a named statement, so Postgres itself refuses a second command after a
  `;`. It runs inside `BEGIN READ ONLY`, is always rolled back, and its
  connection is destroyed rather than returned to the pool. There is no
  `ANALYZE`. Error messages are allowlisted by SQLSTATE.
- **Every rendered query and every audit line is redacted.**
- **No DDL against a monitored database.** A source guard confines every DDL
  statement in the repository to the store's migrations directory.
- **Actions on with auth off is an unauthenticated kill endpoint.** pgops
  warns on stderr the first time such a request arrives and keeps serving,
  because some deployments authenticate at a proxy. If yours does not, set
  `PGOPS_USERNAME` and `PGOPS_PASSWORD` whenever you set
  `PGOPS_ALLOW_ACTIONS`.

Basic auth is a floor. For production, run pgops behind TLS and an
authenticating reverse proxy such as OAuth2 Proxy, an ALB authentication
rule, or Identity-Aware Proxy.

## Parity with pgHero

pgHero is the benchmark. [registry.ts](packages/checks/src/registry.ts) maps
every public method under pgHero 4.0.1's `lib/pghero/methods/`, plus the
dashboard-only capabilities that back no method, onto a shipped check, action,
series or tool. Each of the 65 entries names its pgHero source file and
resolves to exactly one state. The test suite reads this README and fails if
the numbers below drift from what the registry computes.

**60 of the 65 are shipped, 5 are declined on purpose, and 0 remain**.

| State | Count |
|---|---:|
| Shipped | 60 |
| Declined on purpose | 5 |
| Remaining | 0 |

### The five declines

| pgHero capability | Reason |
|---|---|
| `kill_all` | An action with no diagnosis. No incident calls for terminating every session unreviewed. |
| `enable_query_stats`, `disable_query_stats` | Both are DDL against a monitored database. pgops diagnoses the missing extension and prints the statement to run through your own migration tooling. |
| `autoindex` | Builds an index on a monitored database unreviewed. Every pgops suggestion prints the exact statement instead. |
| `system_stats` | CPU, IOPS and disk from cloud monitoring APIs. Per-cloud credentials and an SDK for one panel that is blank for anyone self-hosting. |

### Deliberate differences

Each is documented at the code that implements it.

- **Capture never resets `pg_stat_statements`.** Cumulative values are stored
  and differenced at read time.
- **`replication_lag` is `null` on a primary, not `0`.** Zero is a claim
  about replication made about a server that is not replicating.
- **SSL state reads `pg_stat_ssl`**, a core catalog, not the `sslinfo`
  extension. A read failure renders as `Unknown`, never as `No SSL`.
- **Sizes are bytes, not pretty strings.** Formatting happens at the page,
  so sizes can be thresholded, summed and charted.
- **A reading that could not be taken is `null`, never a sentinel string.**
  pgHero renders an index with no I/O yet as `"Insufficient data"` in a
  column of percentages, which sorts to the top of a page ranked by severity.
- **Settings are one round trip, not fifteen**, and each value is the `SHOW`
  form: `shared_buffers` reads `128MB`, not `16384` with a separate unit.
- **Sequence danger is measured against the column's type.** A bigint
  sequence feeding an `integer` column overflows at 2,147,483,647. Measured
  against its own maximum it reads as effectively unused on the day it fails.
- **Space growth is measured between two stored captures**, not between a
  capture and a live size, so the number is stable between page loads and
  the window is stated beside it.
- **The load chart is written at capture time.** Summing a day of per-shape
  deltas at read time is over a million rows on a large database, on a page
  that polls every 5 seconds. The capture computes one row per interval;
  a day's chart reads 288 rows.
- **Index suggestions read the planner's output, not a parse tree.** pgHero
  parses statements with a native `pg_query` binding and declines any join.
  pgops asks Postgres to plan the statement and advises on every sequential
  scan in the plan, with no added dependency.
- **pgops folds its own relations out of lists and out of nothing else.**
  Pointed at a database that is also its store, the lists hide the console's
  own tables and say how many were hidden. Sizes, hit rates and verdicts count
  them.

## Development

Requires Node 22 or newer, npm and Docker. Docker is used only for the local
Postgres and the integration tests.

```sh
git clone https://github.com/jonathanchowjh/pg-ops.git && cd pg-ops
npm install
git config core.hooksPath .githooks          # one-time: pre-commit and pre-push checks

npm run db:up                                # Postgres 17 on localhost:55432, pg_stat_statements preloaded
export DATABASE_URL='postgres://postgres:secret@localhost:55432/appdb'
export PGOPS_STORE_URL="$DATABASE_URL"       # optional: enables history
export PGOPS_ALLOW_ACTIONS=true              # optional: enables the action routes

npm run --workspace @pgops/web dev           # http://localhost:3000
```

In a second terminal, `npm run db:seed` holds a real lock chain open so the
Locks and Triage pages have something to show. `npm run db:psql` opens
`psql` in the container. `npm run db:down` removes it.

### Tests

| Command | Runs | Docker |
|---|---|---|
| `npm test` | Unit tests in `packages/checks`: pure logic and the source guards | On open |
| `npm run test:web` | Component and route tests for the console | On open |
| `npm run test:int` | Integration tests against a real Postgres in a Testcontainer | Yes |
| `npm run typecheck:test` | TypeScript across the repository, including tests | On open |
| `./scripts/image-smoke.sh` | Builds the image with one `DATABASE_URL`, runs it with another, asserts the second is used | Yes |

The suite is over 1,000 tests. Integration tests run against
Postgres 14, 16, 17 and 18; set `PGOPS_TEST_PG_VERSION` to choose one, or
`PGOPS_HOOK_PG_VERSIONS='14 16 17 18' git push` to run the full matrix from
the pre-push hook.

Several repository invariants are held by tests rather than by convention:

- `packages/checks` has one runtime dependency and never imports from
  `apps/web`.
- Every page renders dynamically. Nothing opts back into static rendering,
  which would freeze build-time environment into HTML.
- Every DDL statement in the repository lives in the store's migrations
  directory.
- Incident pages poll and hygiene pages do not.
- The README's parity numbers match the registry.
- The action routes answer 404 without the flag, verified against a running
  server.

The pre-commit hook runs typechecks, unit and component tests in about a
minute. The pre-push hook runs the integration suite and the image smoke test
in about fifteen minutes. `--no-verify` skips either.

### Stack

| Layer | Choice |
|---|---|
| Language | TypeScript 5, ESM, Node 22 |
| Database client | `pg` (node-postgres) |
| Console | Next.js 16, React 19, Tailwind CSS 4 |
| Tests | Vitest 4 with jsdom, Testcontainers for Postgres |
| Packaging | Multi-stage Docker image on `node:22-alpine`, Next.js standalone output |

## Repository layout

```
packages/checks/src/
  types.ts          Check, Threshold, Verdict, CheckResult, Series, Tool, ActionMeta
  gates.ts          The four gates, as data
  run.ts            runCheck / runSeries / runTool: run one thing, never throw
  registry.ts       CHECKS, ACTIONS, SERIES, TOOLS, and the pgHero parity map
  checks/           One file per area: locks, sessions, indexes, wraparound, ...
  actions/          kill, analyze, statistics resets: the only writes, all audited
  series/           Reads over the store: how a value has moved
  store/            The pgops schema: migrations, read, write, advisory lock
  tools/            explain and index advice
  capture.ts        The five-minute capture tick
  redact.ts         Secret redaction

apps/web/
  app/              One folder per route
  app/api/          Action routes and the explain route
  components/       CheckPanel, ConfirmAction, KillButton, LineChart, Sql, ...
  lib/check.ts      runCheckFor: the seam every page runs a check through
  lib/config.ts     Reads database configuration on every request
  lib/pools.ts      One pool per database URL
  proxy.ts          Basic auth and the 404 gate over the action routes

dba-playbook/       The same diagnostics as standalone psql scripts
docs/design/        Dated design documents each phase was built from
scripts/            dev-db.sh, the lock-chain seeder, the image smoke test
```

## Documentation

| Document | Content |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | Working on the code: setup, how a check flows, the rules the tests enforce, conventions, releasing, and a five-day guide for developers new to the codebase. |
| [dba-playbook/](dba-playbook/) | Six `psql` playbooks covering the same diagnostics by hand. The checks were derived from these and each is kept runnable so any finding can be reproduced without the tool. |
| [docs/design/](docs/README.md) | The design documents, dated and in order, with a note on which supersedes which. |
| [CHANGELOG.md](CHANGELOG.md) | Every release, with the reasoning behind each change. |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability and what is in scope. |

## Contributing, security and license

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. It
describes how a check flows, the rules the tests enforce, and the conventions
for adding one.

Report vulnerabilities privately through GitHub's security reporting for this
repository, as described in [SECURITY.md](SECURITY.md). Do not open a public
issue.

Licensed under [Apache-2.0](LICENSE).
