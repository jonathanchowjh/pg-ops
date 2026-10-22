# Contributing to pgops

This is the guide for working on the code. If you want to *run* pgops, the
[README](README.md) is the place. If you are new to this codebase, or new to
professional software work in general, start at
[Your first week](#your-first-week-a-guide-for-junior-developers) and come
back to the sections above it as you need them.

## Setup

You need **Node 22 or newer**, **npm** and **Docker**. Docker is only for the
throwaway Postgres and the integration tests; unit and component tests run
without it.

```sh
git clone <this repo> && cd pg-ops
npm install
git config core.hooksPath .githooks        # one-time: the hooks below
npm run db:up                             # Postgres 17 on localhost:55432, pg_stat_statements preloaded
export DATABASE_URL='postgres://postgres:secret@localhost:55432/appdb'
export PGOPS_STORE_URL="$DATABASE_URL"    # optional: turns history on
export PGOPS_ALLOW_ACTIONS=true           # optional: turns the terminate controls on
npm run --workspace @pgops/web dev        # http://localhost:3000
```

In a second terminal, `npm run db:seed` holds a real lock chain open so the
database's tree has a chain to show. Ctrl-C releases it.
`npm run db:psql` opens `psql` inside the container, and `npm run db:down`
removes it.

## Everyday commands

| Command | What it runs | Needs Docker |
|---|---|---|
| `npm test` | Unit tests in `packages/checks`: pure logic and the source guards | No |
| `npm run test:web` | The console's component and route tests | No |
| `npm run test:int` | Integration tests against a real Postgres, one container for the whole run | Yes |
| `npm run gate` | `test:int` and the image smoke test, then records the commit as pushable | Yes |
| `npm run typecheck:test` | Types across the repo, including test files | No |
| `npm run --workspace @pgops/checks typecheck` | The checks package as it is built for `dist/` | No |
| `npm run --workspace @pgops/web typecheck` | The console | No |
| `npm run test:watch` | Vitest in watch mode | No |

Git hooks run these for you, so the `core.hooksPath` line in
[Setup](#setup) is what makes them happen. [.githooks/pre-commit](.githooks/pre-commit)
runs the fast ones — typechecks, unit and component tests, about a minute.

The slow ones are a script you run yourself: `npm run gate`
([scripts/gate.sh](scripts/gate.sh)) runs the integration suite and the image
smoke test, needs Docker and takes about fifteen minutes. It records the
commit it passed on, and [.githooks/pre-push](.githooks/pre-push) — which is
instant — refuses to push any commit without that record. Commit again after
gating and the record no longer covers you, so you re-gate.

The gate is a separate step because `git push` opens the connection to the
remote *before* running pre-push. A hook that works for fifteen minutes holds
that connection idle until the remote drops it, and the push dies with exit
141 and no output.

These two hooks are the whole of this repository's CI. `--no-verify` pushes
something nothing verified.

Two things the hooks do not do, which a server-side CI used to:

- **They run on your machine, not on Linux.** The last bug that reached the
  default branch was invisible on macOS — `npm run` puts `sh` between the test
  harness and `next`, and only on Linux does a `SIGTERM` to npm orphan the
  server still holding the port. Every integration leg failed on Linux; every
  one passed locally.
- **They run one Postgres version, not four in parallel.** The default is 17.
  Before anything you would have let CI gate, run the real matrix:
  `PGOPS_HOOK_PG_VERSIONS='14 16 17 18' npm run gate`.

Two things about the test setup catch people:

- **`apps/web` imports `@pgops/checks` from its built `dist/`.** `test:web`,
  `test:int` and `dev` all build it first. If you run vitest directly and see
  a stale or missing export, run `npm run --workspace @pgops/checks build`.
- **The checks package's `dist/` is shared by everything.** Its build starts
  with `rm -rf dist`, so a test run in one terminal briefly breaks a dev
  server in another, which logs `Module not found: Can't resolve
  '@pgops/checks'` and recovers on the next request. The same goes for two
  test runs at once.
- **Integration tests share one container.** They run files serially on
  purpose, because `pg_stat_activity` and the lock manager are cluster-wide.
  An orphaned dev server on the test port produces failures that look like
  code bugs and are not. If a failure moves between runs, suspect the
  machine before the code.

## The shape of the repo

```
packages/checks/          Everything that knows Postgres. No React, no Next, no HTTP.
  src/types.ts            Check, Threshold, CheckResult, Tool, ActionMeta
  src/run.ts              runCheck / runTool: run one thing, never throw
  src/registry.ts         CHECKS, ACTIONS, TOOLS, and the pgHero parity map
  src/checks/             One file per area: locks, sessions, catalog, wraparound…
  src/checks/shared.ts    What the checks share: list cap, schema filter, threshold comparison
  src/actions.ts          kill, analyze, stats resets: the only writes, all through audited()
  src/audit.ts            The audit record every action writes, to stdout and a file
  src/store/              The pgops schema: migrations, read, write, advisory lock
  src/deltas.ts           Cumulative counters differenced into intervals, a reset or an eviction a gap
  src/tools/              explain and index advice: questions the operator asks
  src/capture.ts          The five-minute capture tick
  src/health.ts           The one-minute health sample
  src/redact.ts           Secret redaction, applied to every rendered query
  test/                   *.test.ts is pure; *.int.test.ts needs Postgres

apps/web/                 The Next.js console. Renders what packages/checks returns.
  app/                    One folder per route; page.tsx renders, layout.tsx holds the sidebar
  app/api/db/[name]/      The action routes and the explain route
  components/             Clock, TreeView, Scatter, Panel, Sql, ConfirmAction, KillButton…
  lib/check.ts            runCheckFor, readStore: the one seam every page reads through
  lib/config.ts           Every environment variable the console reads, read per request
  lib/pools.ts            One pool per database URL, and the count of statements sent through it
  lib/action-route.ts     The preamble every action route shares: flag, CSRF, reason, confirmation
  proxy.ts                Basic auth, and the 404 gate over the action routes
  test/                   Component tests, route tests, and guards.test.ts

scripts/                  dev-db.sh, the lock-chain seeder, the image smoke test, gate.sh
```

The line between the two packages is the most important fact about the
layout. `packages/checks` has exactly one runtime dependency, `pg`, and a test
fails if it gains another or imports anything from `apps/web`. The console
never constructs its own `Pool`, never writes SQL, and never touches
`pg_terminate_backend`; it calls `runCheckFor` and renders the result.

## How a check flows

Every reading on every page follows one path. Trace it once and the rest of
the codebase is variations.

1. **A check is an object**, not a class:
   [`Check<Row, Data, Opts>`](packages/checks/src/types.ts). It carries an
   `id`, a `home`, a `class`, its `sql`, a pure `map` from rows to domain
   data, and optionally `thresholds`.
2. **`runCheck`** ([run.ts](packages/checks/src/run.ts)) checks the
   requirements, runs the SQL, calls `map`, and returns a
   `CheckResult`. It never throws. A failure becomes
   `{ ok: false, reason, message, remedy }`, where `reason` is one of a small
   set (`privilege`, `missing-extension`, `unreachable`…) so a page can render
   the exact remedy.
3. **`runCheckFor`** ([lib/check.ts](apps/web/lib/check.ts)) is the web
   layer's wrapper. It resolves the database name to a pool, marks the route
   dynamic so Next cannot prerender it at build time, and converts
   configuration errors into results that say "the console is misconfigured"
   rather than "your database is down".
4. **The page** renders the result where its rows would be. A read that
   failed says so in that place, never an empty list: `ReadAlert` for the
   sessions, a line for anything else. A finding past its mark is a line in
   the tree's answer, with the way to its node.

A `Tool` is a question the operator asks with their own input, like explain.
An action is a write, and takes the audited path in `actions.ts`.

## The rules the tests enforce

This repo holds its claims with guards rather than with memory. Most live in
[apps/web/test/guards.test.ts](apps/web/test/guards.test.ts) and
[packages/checks/test/boundaries.test.ts](packages/checks/test/boundaries.test.ts),
and each carries a comment saying which defect it caught. Before you change
something a guard forbids, read that comment; the guard is usually the cheaper
of two ways the project tried.

| Rule | Held by |
|---|---|
| `packages/checks` depends on `pg` and nothing else, and imports nothing from the app | `boundaries.test.ts` |
| Every check declares a home, and every parity entry names a check that exists | `registry.test.ts` |
| Every pgHero capability resolves to exactly one state, and none is owed | `registry.test.ts` |
| The README's parity counts match what the registry computes | `registry.test.ts`, which parses `README.md` |
| Every page is dynamic; nothing opts back into static rendering | `guards.test.ts`, and the image smoke test end to end |
| Only pages of live reads and the fleet render `<Refresh>`; a captured read never runs on a poll | `guards.test.ts` |
| No page or component constructs a `Pool` or renders a query outside `<Sql>` | `guards.test.ts` |
| DDL appears only in `store/migrate.ts` | `guards.test.ts` |
| A statistics reset is named in exactly one file, and never on the capture path | `guards.test.ts` |
| Operator SQL is prepared as a named statement in exactly one file | `guards.test.ts` |
| Every threshold is tested one unit either side of its line | Each check's `*.int.test.ts` |

## Design record

Why pgops is shaped the way it is. This lived in the README until it was
2,800 words of rationale in front of the one instruction most readers came
for; it belongs here, with the people it is written for. Each item is also
documented at the code that implements it — this is the index, not the
authority.

### Four design constraints

- **One container, no agent.** It connects with credentials you give it. It
  runs no DDL against a monitored database, installs no extensions and
  creates no roles. The only schema it owns is in the store you give it.
- **Configuration is read at request time.** The same image runs against any
  database. A smoke test builds an image with one `DATABASE_URL` baked in,
  runs it with another, and asserts the container uses the second.
- **Actions are opt-in and audited.** Without the flag, the action routes do
  not exist. With it, every kill is confirmed, pinned to a session identity
  rather than a pid, and written to an audit log.
- **The console never becomes the problem.** Polls that land while one is in
  flight are skipped, not queued. Explain runs in a read-only transaction
  that is always rolled back. pgops's own sessions and statements are
  counted, not hidden.

### The tree

Every check declares a `home`: the node its finding belongs to. The nodes are
one tree, and the database's page is that tree on a clock.

```
Database                  one configured connection
├─ Table
│   ├─ Query              a statement shape that reads or writes this table
│   │   └─ Session        a connection running that statement now
│   ├─ Index
│   └─ Sequence
├─ not on any table       BEGIN, SET, idle in transaction holding nothing
└─ its Server             connections, replication, WAL, transaction ID age
```

A finding is stated once, on its node, and every finding surfaces at the top
of the tree, worst first. A lock chain is one finding on the table fought
over, naming its root, with Terminate on the root alone. A session waiting on
a lock is `active` in `pg_stat_activity`, so a naive tool lists it as a
long-running query and offers to terminate it; pgops ties it to its root and
offers nothing on it, because killing a waiter frees nothing.

The tree is built in one pure function,
[apps/web/lib/tree.ts](apps/web/lib/tree.ts), with its tests beside it, and
`guards.test.ts` fails if a check's home draws it nowhere.

### Why two packages

`packages/checks` contains every SQL statement, threshold, action
and redaction rule. It has no React, no HTTP and no knowledge of display. A
test fails if it gains a second runtime dependency or imports from
`apps/web`.

`apps/web` never constructs its own connection pool for a check, never writes
SQL and never calls `pg_terminate_backend`. Every page runs its checks through
one seam, `runCheckFor`, and renders the result. This is what makes the checks
testable against a real Postgres without a browser, and the pages testable
without a database.

### Checks and thresholds

A check is one SQL query and a pure function from rows to a result. It
reports and never judges: the tree judges, over the window, against the
checks' thresholds (`MARKS` in `apps/web/lib/samples.ts`), so a finding has
one judge. Thresholds are data, not constants in a comparison. Each carries the sentence that
justifies the number.

A check that cannot run returns a failure with the reason: a missing
extension, an insufficient privilege, a server version below what it needs.
The page renders it as `UNKNOWN`, never as green.

### History

With `PGOPS_STORE_URL` set, pgops creates a `pgops` schema in that database
on boot, under an advisory lock so several replicas starting together migrate
once. Every 5 minutes it captures every statement shape and every relation
size, then reads the catalog (tables, indexes, sequences) and stores its
rows, with what each table and index did in the hour. Four
properties, each held by a test:

- **It never resets shared counters.** pgHero calls
  `pg_stat_statements_reset()` after each capture, which zeroes the view for
  every other tool. pgops stores cumulative values and differences them at
  read time.
- **A gap is drawn as a gap.** An interval spanning a counter reset is
  dropped from the chart, not clamped to zero or interpolated.
- **A capture that lands while one is running is skipped.**
- **Timestamps come from the store, not the process**, so replicas with
  skewed clocks cannot fabricate discontinuities.

Without the variable there is no scheduler and no DDL anywhere. History
reports itself as unavailable.

### The five declines

pgHero is the benchmark, and five of its 65 capabilities are declined rather
than owed. The README carries the parity count; these are the reasons.

| pgHero capability | Reason |
|---|---|
| `kill_all` | An action with no diagnosis. No incident calls for terminating every session unreviewed. |
| `enable_query_stats`, `disable_query_stats` | Both are DDL against a monitored database. pgops diagnoses the missing extension and prints the statement to run through your own migration tooling. |
| `autoindex` | Builds an index on a monitored database unreviewed. Every pgops suggestion prints the exact statement instead. |
| `system_stats` | CPU, IOPS and disk from cloud monitoring APIs. Per-cloud credentials and an SDK for one panel that is blank for anyone self-hosting. |

### Deliberate differences from pgHero

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
  own tables and say how many were hidden. Sizes, hit rates and findings
  count them. Its own statements are marked and excluded from the statement
  ranking the same way, and the count of what was hidden is always stated.

### Stack

| Layer | Choice |
|---|---|
| Language | TypeScript 5, ESM, Node 22 |
| Database client | `pg` (node-postgres) |
| Console | Next.js 16, React 19, Tailwind CSS 4 |
| Tests | Vitest 4 with jsdom, Testcontainers for Postgres |
| Packaging | Multi-stage Docker image on `node:22-alpine`, Next.js standalone output |

## Conventions

- **Comments say why, briefly.** A comment states the constraint the code
  answers to: a Postgres behaviour, a hazard, an invariant. It does not
  restate the code, tell the history of a change, or cite a plan or review
  that is not in the repository. History belongs in the commit message.
- **Light OOP.** Checks, tools and actions are plain objects and
  functions, not classes. A class earns its place only when several functions
  keep passing the same values around. No inheritance beyond subclassing
  `Error`, no dependency injection; if a test needs a seam, override the
  method on the instance or mock the module, as the page tests mock
  `@/lib/check`.
- **Type what actually arrives.** Postgres `int4` columns arrive as JS
  numbers; `int8` (bigint) columns arrive as strings, and are converted with
  `Number(...)` in `map` with a comment saying why. Cast in SQL where you can.
- **Relative imports end in `.js` inside `packages/checks`** and have **no
  extension inside `apps/web`**. Both are forced by the respective toolchains
  and a guard holds the second.
- **`null` means "we could not look".** Never substitute `0`, `ok` or a
  sentinel string for a reading that was not taken.
- **A page never polls a catalog scan.** Live reads are cheap and poll at
  five seconds; a captured read is stored by the capture and read back.
- **Commit messages** follow `type(scope): summary`, for example
  `feat(checks): …`, `fix(web): …`, `docs: …`. The summary says what changed
  in the product, not which file was edited. A commit carries its author's
  name and no `Co-Authored-By` trailer for a tool; `.githooks/commit-msg`
  strips those, which is why the `core.hooksPath` line in
  [Setup](#setup) is worth running.
- **One claim, one test.** A README sentence that states a property has a
  test that holds it. If you add the sentence, add the test.

## Releasing

1. Bump `version` in the root `package.json`, `packages/checks/package.json`
   and `apps/web/package.json` together, and the README's `**Status:** vX.Y.Z`
   line with them. That line is a fourth copy of the same fact and the one a
   release forgets, because no build reads it. `boundaries.test.ts` fails while
   the four disagree.
2. Add the release to [CHANGELOG.md](CHANGELOG.md): what shipped, what was
   declined and why, what diverges from pgHero, and the parity counts read
   from the registry.
3. Update the README's parity table and headline if the counts moved. The
   test suite fails until they agree. Remove anything the release fixed from
   the README's known issues.
4. Gate on **every** supported Postgres version, not the default one:

   ```sh
   PGOPS_HOOK_PG_VERSIONS='14 16 17 18' npm run gate
   ```

   `npm run gate` alone runs 17, so a green default says nothing about 14 —
   the floor the README promises, the permissions table assumes and the
   integration matrix exists for. This is not hypothetical: v2.5.0 was cut
   with a test that published its statistics through
   `pg_stat_force_next_flush()`, which arrived in Postgres 15, so it had never
   once passed on 14. Four gate runs on the default version had reported green.
5. Tag `vX.Y.Z`, then push the branch and the tag. A tag is how a release is
   found later, and pushing the branch does not carry it —
   `git push origin main vX.Y.Z`. v2.3.1 and v2.4.0 sat tagged locally and
   absent from the remote for days because this step said only "tag".

Patch releases fix without changing meaning. Minor releases add routes or
controls without removing any. A major release is reserved for the console
changing shape, as v2 did when the nav gained a tab.

---

## Your first week: a guide for junior developers

This section assumes you can write TypeScript, have used git, and have run a
SQL query before, and not much else. Everything else you need is in this
repo. Plan on about a week to go from clone to a merged change, and do not
skip the reading days to get to the coding day faster; the reading is where
the codebase stops looking like magic.

### What pgops is, in three sentences

Postgres exposes its own internal state as ordinary tables in the
`pg_catalog` schema: who is connected, who is waiting on whom, which queries
are expensive, how far behind vacuum is. A DBA on call runs `SELECT`s against
those tables, reads the answer, and decides whether to wait, kill a session or
change a setting. pgops runs those `SELECT`s for you, every five seconds, and
puts the decision on a web page with the reasoning written beside it.

### Words you will meet

| Word | Meaning here |
|---|---|
| **Check** | One question about a database, as one SQL query plus the code that turns rows into an answer. `connections`, `locks`, `wraparound` are checks. |
| **Threshold** | The number a finding is judged against, with one sentence, `because`: why this number. |
| **Home** | The node a check's finding belongs to: `database`, `table`, `query`, `session`, `index`, `sequence` or `server`. |
| **Class** | How a check runs. `live` may run on a page's five-second poll. `captured` is a catalog scan: the capture stores its rows, a table's own page asks about that table, and a button runs the bloat estimate. |
| **Tool** | A question the operator asks with their own input. Explain is a tool. |
| **Action** | A write: terminate a session, reset statistics, analyze a table. Off by default, gated, confirmed, audited. |
| **Store** | A `pgops` schema in a database you nominate with `PGOPS_STORE_URL`. History lives there. Without it there is no history and no DDL anywhere. |
| **Capture** | The tick that writes query statistics and relation sizes to the store, every five minutes. |
| **Registry** | `registry.ts`: the list of every check, action and tool, and the map from each pgHero capability to what pgops does about it. |
| **Parity** | The claim that pgops answers every question pgHero answers. Checked by a test, not asserted. |
| **Guard** | A test that scans source files for a rule, rather than running code. "No page renders `<Refresh>` unless it is an incident page" is a guard. |
| **Tier** | Where an action sits on the safety ladder. Tier 0 is a read. Tier 1 needs the flag and a reason. Tier 2 also needs the database name typed back. Tier 3 does not exist. |
| **pgHero** | The Ruby dashboard pgops measures itself against. You do not need to run it, but its source is worth a look when a comment cites it. |

### Day 1: run it and break it

1. Do the [Setup](#setup) above with `PGOPS_STORE_URL` and
   `PGOPS_ALLOW_ACTIONS` both set.
2. Open http://localhost:3000 and click through every page. Note which ones
   show a freshness readout that ticks and which do not; that is the poll
   boundary, and it is the single most important design rule in the console.
3. In a second terminal, run `npm run db:seed`. Watch the database's tree
   change, and find the root blocker: the answer line names it.
4. While the chain is still held, open a third terminal, run
   `npm run db:psql`, and paste in the `sql` from
   `packages/checks/src/checks/sessions.ts`. The whole tree you just saw is
   that one query, sampled. Match its columns to the rows before moving on.
5. Terminate the root blocker from the answer line, typing any reason. The
   seeder prints that its connection closed and exits, and the dev server's
   terminal prints one JSON audit line naming the target and your reason.
6. Stop the Postgres container with `npm run db:down` while the console is
   still open, and watch what every page does. This is the "we could not
   look" rule: nothing should read as healthy.

### Day 2: read one check end to end

Read these files in this order, including the comments.

1. [packages/checks/src/types.ts](packages/checks/src/types.ts) — the shapes.
2. [apps/web/lib/tree.ts](apps/web/lib/tree.ts) — the model.
3. [packages/checks/src/checks/connections.ts](packages/checks/src/checks/connections.ts)
   — a complete check with thresholds. Notice the comments
   explaining a `::int` cast and a `missing_ok` argument; both prevented real
   bugs.
4. [packages/checks/test/connections.int.test.ts](packages/checks/test/connections.int.test.ts)
   — how a check is tested: against a real Postgres for the SQL. The
   judgement against its thresholds is tested on the tree, in
   `apps/web/test/tree.test.ts`.
5. [packages/checks/src/run.ts](packages/checks/src/run.ts) — how a check is
   run and why it never throws.
6. [apps/web/lib/check.ts](apps/web/lib/check.ts) — the web wrapper.
7. [apps/web/app/db/[name]/server/page.tsx](apps/web/app/db/%5Bname%5D/server/page.tsx)
   — a page that renders the server's reads, live and on the clock.
8. [apps/web/components/panel.tsx](apps/web/components/panel.tsx)
   — one fact about a node across the clock's window.

### Day 3: run the tests, then break a guard on purpose

```sh
npm test                      # about a second, no Docker
npm run test:web              # builds the checks package first
npm run test:int              # needs Docker; several minutes the first time
```

Now make each of these edits, run the relevant suite, read the failure
message, and revert:

- Add `<Refresh intervalMs={5_000} />` to
  `apps/web/app/db/[name]/tables/page.tsx`. `npm run test:web` fails
  in "the poll boundary". Read the test's comment for why.
- Change the `Shipped` row in the README's parity table to 59. `npm test`
  fails in "the README parity claims".
- Delete the `home:` line from `connections.ts`. `npm run typecheck:test`
  fails with `TS2741: Property 'home' is missing`. Now run `npm test`: it
  also fails, but in the registry tests rather than on the type. Vitest strips
  types without checking them, which is why the pre-commit hook runs the
  typechecks as their own steps and why you should too.
- Add `CREATE TABLE x (id int)` as a string constant anywhere under
  `apps/web/lib/`. `npm run test:web` fails in "the DDL boundary".

The point of this exercise is that when a test fails after your real change,
you will recognise the shape of the message and know it is the guard talking,
not a flake.

### Day 4: add a check, end to end

This is a worked example, not a feature request. It adds a live check that
reports how many temporary files the current database has spilled to disk,
which is a reading a DBA looks at when `work_mem` is suspected to be too low.
It does not ship; it exists to walk the path. If you want to keep it, that is
a conversation to have in a pull request.

**1. The check.** Create `packages/checks/src/checks/temp-files.ts`:

```ts
import type { Check } from '../types.js';

export interface TempFilesRow {
  database: string;
  // bigint columns arrive from node-pg as strings, not numbers, so the
  // driver cannot lose precision above 2^53. Convert in `map`.
  temp_files: string;
  temp_bytes: string;
}

export interface TempFilesData {
  files: number;
  bytes: number;
}

const SQL = `
SELECT datname AS database, temp_files, temp_bytes
FROM pg_stat_database
WHERE datname = current_database()`;

/**
 * Temporary files written since the statistics were last reset. A large
 * number relative to the workload means sorts and hashes are spilling past
 * work_mem. Reports only: what counts as "large" depends on the workload, so
 * no threshold is right for everyone, and a check must not invent one.
 */
export const tempFiles: Check<TempFilesRow, TempFilesData> = {
  id: 'tempFiles',
  home: 'server',
  class: 'live',
  sql: SQL,
  map: (rows) => ({
    files: Number(rows[0]?.temp_files ?? 0),
    bytes: Number(rows[0]?.temp_bytes ?? 0),
  }),
};
```

Notice what the compiler makes you say: a `home`, a `class`, a `map`. A
check reports and never judges. Were this one to become a finding, you would
add `thresholds` with a non-empty `because` on each, a mark in `MARKS`, and a
tree test at each boundary.

**2. Register it.** In `packages/checks/src/registry.ts`, import it and add
`tempFiles` to the `CHECKS` object. Add `export type * from
'./checks/temp-files.js';` to `packages/checks/src/index.ts` so the console
can name `TempFilesData`. Run `npm test`; the registry tests confirm the
check exists and has a home.

**3. Test it.** Create `packages/checks/test/temp-files.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { tempFiles } from '../src/checks/temp-files.js';
import { withPostgres } from './harness.js';

describe('tempFiles', () => {
  it('reads a number, and zero on a fresh database is a reading, not a gap', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, tempFiles);
      if (!r.ok) throw new Error(r.message);
      expect(r.data.files).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(r.data.bytes)).toBe(true);
    });
  }, 120_000);
});
```

`withPostgres` gives you a fresh database in the shared container. Run
`npm run test:int -- temp-files` to run only this file.

**4. Render it.** The check is live, so it may go on a page that polls. Its
home is `server`, so it belongs on `/server`; `apps/web/test/guards.test.ts`
fails until some page of its home names it. In
`apps/web/app/db/[name]/server/page.tsx`, add it to the page's `Promise.all`
under `live ?`, and render it as a section with the others:

```tsx
    live ? runCheckFor(name, CHECKS.tempFiles) : null,  // last in the Promise.all; name it `temp`
// …
<h2 className={SECTION}>Temporary files<small className={NOTE}>since the statistics were reset</small></h2>
{temp === null ? null : !temp.ok ? <p className="text-muted-foreground">Temporary files could not be read: {temp.message}</p>
  : <p>{formatCount(temp.data.files)} files, {formatBytes(temp.data.bytes)}</p>}
```

The page's own test mocks `runCheckFor` and hands back an empty object for
any check it has no fixture for, so it keeps passing. That is worth noticing:
a new section is not tested until you add a fixture and an assertion for it in
`apps/web/test/server-page.test.tsx`.

Run `npm run test:web` and `npm run --workspace @pgops/web typecheck`.

**5. Look at it.** `npm run --workspace @pgops/web dev`, open Server,
and stop the container to see the section say it could not be read. That is the whole
path: SQL, map, registry, test, page. Every step above was run against this
repository at 2.5.0 and passes; if one does not for you, the code has moved
and this guide needs a fix, which is itself a good first pull request.

### Day 5: pick up real work

Open work is tracked in this repository's issues and, once underway, under
`[Unreleased]` in [CHANGELOG.md](CHANGELOG.md). Pick the smallest item that
touches one component or one page.

**Study the 2.3.1 fix before you write anything.** It is the best model of
how work is done here. Two pages crashed because a server component passed a
function to a client component, which React cannot serialise. The fix landed
with the test that would have caught it: an integration test that boots the
console with actions on, because the existing suite only ever ran with them
off. Read that diff in this order: the changelog entry, the new test, then
the fix. That order is the one to copy.

Some test comments cite design documents by date and section, for example
`spec 2026-09-03 §2` or `parity §2.1`. Those documents are kept outside the
repository. Treat the comment itself as the record of the decision.

Whichever you pick:

1. Find the existing test closest to what you are about to write and read it
   whole. `tree-page.test.tsx` and `tree-view.test.tsx` are good
   starting points for page and component tests.
2. Write the test first and watch it fail for the reason you expect. Then
   make it pass. Every fix in the changelog was built this way.
3. Keep the pull request to the one task. Anything that touches the store
   schema, the capture tick and a page together is a later contribution, not
   a first.

### How to ask for help

When something does not make sense, the comment above it usually explains
why. When it does not, search the changelog for the file name; most
non-obvious decisions have an entry. When that fails, ask, with three things:
what you expected, what happened, and the smallest command that shows the
difference. "The poll boundary guard fails after I added a panel to the
Space page, here is the diff" gets an answer in one round; "tests are broken"
does not.

### What a good pull request looks like here

- One phase or one fix, not both.
- A test for every sentence the change adds to the README or the changelog.
- Comments that say why, at the line that needs them, in the same voice as
  the ones around it.
- A changelog entry under the next version, written for an operator deciding
  whether to upgrade.
