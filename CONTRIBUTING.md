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
Locks and Triage pages have something to show. Ctrl-C releases it.
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

It reads as a detour until you try the obvious thing. `git push` opens the
connection to the remote *before* running pre-push, because the hook is fed
each ref's remote SHA on stdin and git can only learn that by asking. A hook
that works for fifteen minutes does so while an idle `git-receive-pack`
session is held open; the remote drops it, and git dies writing the pack to a
closed pipe — exit 141, SIGPIPE, no output at all. That is what this repo did
until 2026-09-25, and `--no-verify` was the only way to push, which made the
gate worse than no gate. Every file's comments explain why each step is
there.

Unlearn the reflex that period trained. `--no-verify` was the only way to push
while the hook was broken; the hook is fixed, and these two hooks are the whole
of this repository's CI. Skipping them no longer routes around a broken hook,
it pushes something nothing verified.

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
  src/types.ts            Check, Threshold, Verdict, CheckResult, Series, Tool, ActionMeta
  src/gates.ts            The four gates: the console's organising model, as data
  src/run.ts              runCheck / runSeries / runTool: run one thing, never throw
  src/registry.ts         CHECKS, ACTIONS, SERIES, TOOLS, and the pgHero parity map
  src/checks/             One file per area: locks, sessions, indexes, wraparound…
  src/actions/            kill, analyze, stats resets: the only writes, all audited
  src/series/             "How has this moved": reads over the store
  src/store/              The pgops schema: migrations, read, write, advisory lock
  src/tools/              explain and index advice: questions the operator asks
  src/capture.ts          The five-minute capture tick
  src/redact.ts           Secret redaction, applied to every rendered query
  test/                   *.test.ts is pure; *.int.test.ts needs Postgres

apps/web/                 The Next.js console. Renders what packages/checks returns.
  app/                    One folder per route; page.tsx renders, layout.tsx holds the sub-nav
  app/api/db/[name]/      The action routes and the explain route
  components/             CheckPanel, Refresh, Sql, ConfirmAction, KillButton, nav…
  lib/check.ts            runCheckFor: the one seam every page runs a check through
  lib/config.ts           Reads DATABASE_URL / PGOPS_DATABASES / PGOPS_CONFIG_FILE per request
  lib/pools.ts            One pool per database URL, the app's only module-level state
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
   `id`, a `title`, a `gate`, a `class`, its `sql`, a pure `map` from rows to
   domain data, and optionally `thresholds` and a pure `verdict`.
2. **`runCheck`** ([run.ts](packages/checks/src/run.ts)) checks the
   requirements, runs the SQL, calls `map`, calls `verdict`, and returns a
   `CheckResult`. It never throws. A failure becomes
   `{ ok: false, reason, message, remedy }`, where `reason` is one of a small
   set (`privilege`, `missing-extension`, `unreachable`…) so a page can render
   the exact remedy.
3. **`runCheckFor`** ([lib/check.ts](apps/web/lib/check.ts)) is the web
   layer's wrapper. It resolves the database name to a pool, marks the route
   dynamic so Next cannot prerender it at build time, and converts
   configuration errors into results that say "the console is misconfigured"
   rather than "your database is down".
4. **`CheckPanel`** ([components/check-panel.tsx](apps/web/components/check-panel.tsx))
   renders the result. The failed case is handled here, once, so a page written
   later cannot forget it. A `verdict` that crossed a threshold renders the
   threshold's `because` and `remedy`.

A `Series` is the same idea for "how has this moved", reading the store and
yielding points with no verdict. A `Tool` is a question the operator asks with
their own input, like explain. An action is a write, and takes the audited
path in `actions/`.

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
| Every check declares a gate, and its gate agrees with the registry | `registry.test.ts` |
| Every pgHero capability resolves to exactly one state; a complete phase owes nothing | `registry.test.ts` |
| The README's parity counts match what the registry computes | `registry.test.ts`, which parses `README.md` |
| Every page is dynamic; nothing opts back into static rendering | `guards.test.ts`, and the image smoke test end to end |
| Only incident pages and the overview render `<Refresh>`; hygiene routes never poll | `guards.test.ts` |
| No page or component constructs a `Pool` or renders a query outside `<Sql>` | `guards.test.ts` |
| DDL appears only under `store/migrations/` | `guards.test.ts` |
| A statistics reset is named in exactly one file, and never on the capture path | `guards.test.ts` |
| Operator SQL is prepared as a named statement in exactly one file | `guards.test.ts` |
| Sub-navigation is rendered by a layout, never by a page | `guards.test.ts` |
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

### The four gates

Every check belongs to one of four gates. A request has to clear them in
order, and the triage page renders them in that order.

```
1 connect   can it get in?          connections, sessions, sources
2 wait      can it get its locks?   blocked sessions, the wait graph
3 work      can it do the work?     long-running queries, statement statistics
4 keep-up   can the server keep up? replication, vacuum, space
```

The order matters for two reasons. Causes run down it and **symptoms run up
it**: vacuum falls behind at gate 4, tables bloat, queries slow at gate 3,
connections pile up at gate 1. And a failure at one gate disguises itself as
the next: a session blocked at gate 2 is `active` in `pg_stat_activity`, so a
naive tool lists it as a long-running query at gate 3 and offers to terminate
it. pgops marks such a session with the root blocker it is queued behind and
withholds the terminate advice, because killing a waiter frees nothing.

The gate tree is data, in
[packages/checks/src/gates.ts](packages/checks/src/gates.ts). Every check
declares its gate, and a test fails if any capability is added without one.

### Why two packages

`packages/checks` contains every SQL statement, threshold, verdict, action
and redaction rule. It has no React, no HTTP and no knowledge of display. A
test fails if it gains a second runtime dependency or imports from
`apps/web`.

`apps/web` never constructs its own connection pool for a check, never writes
SQL and never calls `pg_terminate_backend`. Every page runs its checks through
one seam, `runCheckFor`, and renders the result. This is what makes the checks
testable against a real Postgres without a browser, and the pages testable
without a database.

### Checks, verdicts and thresholds

A check is one SQL query, a pure function from rows to a result, and a
verdict function that returns `ok`, `warn` or `critical`. Thresholds are
data, not constants in a comparison. Each carries its unit, why the number
matters, and what action it calls for. A threshold with no single safe action
carries no advice.

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
  own tables and say how many were hidden. Sizes, hit rates and verdicts
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

- **Comments say why.** Nearly every non-obvious line in this repo has a
  comment naming the defect it prevents or the review finding it answers.
  Keep that up. A comment that restates the code is noise; a comment that
  says what went wrong without it is the project's memory.
- **Light OOP.** Checks, series, tools and actions are plain objects and
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
- **A page never polls a catalog scan.** Incident checks are cheap and poll at
  five seconds; hygiene checks run when the page is opened.
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
   from `parityBacklog()`.
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
| **Verdict** | A check's opinion: `ok`, `warn` or `critical`, with a short note. Some checks only report and have no verdict. |
| **Threshold** | The number a verdict is judged against, with two sentences: `because` (why this number) and `remedy` (what to do). |
| **Gate** | Which of the four stages of a request's life a check measures: `connect`, `wait`, `work` or `keep-up`. Decides which band of the triage page it renders in. |
| **Class** | How a check runs. `incident` runs live and its page polls every five seconds. `hygiene` runs when its page is opened. `on-demand` runs only when the operator clicks through. |
| **Series** | A reading over time, read from the store. Query load per interval, a table's size per day. |
| **Tool** | A question the operator asks with their own input. Explain is a tool. |
| **Action** | A write: terminate a session, reset statistics, analyze tables. Off by default, gated, confirmed, audited. |
| **Store** | A `pgops` schema in a database you nominate with `PGOPS_STORE_URL`. History lives there. Without it there is no history and no DDL anywhere. |
| **Capture** | The tick that writes query statistics and relation sizes to the store, every five minutes. |
| **Registry** | `registry.ts`: the list of every check, action, series and tool, and the map from each pgHero capability to what pgops does about it. |
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
3. In a second terminal, run `npm run db:seed`. Watch the Triage and Locks
   pages change, and find the root blocker: the `batch-worker` session.
4. While the chain is still held, open a third terminal, run
   `npm run db:psql`, and paste in the `sql` from
   `packages/checks/src/checks/locks.ts` and `blocked.ts`. Every panel you
   just saw is one check's query. Match each panel to its query before moving
   on.
5. Terminate the root blocker from the Sessions page, typing any reason. The
   seeder prints that its connection closed and exits, and the dev server's
   terminal prints one JSON audit line naming the target and your reason.
6. Stop the Postgres container with `npm run db:down` while the console is
   still open, and watch what every page does. This is the "we could not
   look" rule: nothing should read as healthy.

On 2.3.0, step 5 has a trap. With actions on, the Sessions page answers 500
as soon as any query has run past 60 seconds, and the seeded waiters cross
that line about a minute after `db:seed` starts. If you hit it, you have
found the bug in the README's known issues. Restart the seeder and terminate
within the first minute, or work from a checkout that has the 2.3.1 fix.

### Day 2: read one check end to end

Read these files in this order, including the comments. They are long because
the comments are the design record.

1. [packages/checks/src/types.ts](packages/checks/src/types.ts) — the shapes.
2. [packages/checks/src/gates.ts](packages/checks/src/gates.ts) — the model.
3. [packages/checks/src/checks/connections.ts](packages/checks/src/checks/connections.ts)
   — a complete check with thresholds and a verdict. Notice the comments
   explaining a `::int` cast and a `missing_ok` argument; both prevented real
   bugs.
4. [packages/checks/test/connections.int.test.ts](packages/checks/test/connections.int.test.ts)
   — how a check is tested: against a real Postgres for the SQL, and by
   calling `verdict` directly at each threshold boundary for the judgement.
5. [packages/checks/src/run.ts](packages/checks/src/run.ts) — how a check is
   run and why it never throws.
6. [apps/web/lib/check.ts](apps/web/lib/check.ts) — the web wrapper.
7. [apps/web/app/db/[name]/locks/page.tsx](apps/web/app/db/%5Bname%5D/locks/page.tsx)
   — a small page that renders one check.
8. [apps/web/components/check-panel.tsx](apps/web/components/check-panel.tsx)
   — where the failed case and the verdict badge render.

### Day 3: run the tests, then break a guard on purpose

```sh
npm test                      # about a second, no Docker
npm run test:web              # builds the checks package first
npm run test:int              # needs Docker; several minutes the first time
```

Now make each of these edits, run the relevant suite, read the failure
message, and revert:

- Add `<Refresh intervalMs={5_000} />` to
  `apps/web/app/db/[name]/queries/tables/page.tsx`. `npm run test:web` fails
  in "the poll boundary". Read the test's comment for why.
- Change the `Shipped` row in the README's parity table to 59. `npm test`
  fails in "the README parity claims".
- Delete the `gate:` line from `connections.ts`. `npm run typecheck:test`
  fails with `TS2741: Property 'gate' is missing`. Now run `npm test`: it
  also fails, but in two registry tests rather than on the type. Vitest strips
  types without checking them, which is why the pre-commit hook runs the
  typechecks as their own steps and why you should too.
- Add `CREATE TABLE x (id int)` as a string constant anywhere under
  `apps/web/lib/`. `npm run test:web` fails in "the DDL boundary".

The point of this exercise is that when a test fails after your real change,
you will recognise the shape of the message and know it is the guard talking,
not a flake.

### Day 4: add a check, end to end

This is a worked example, not a feature request. It adds a hygiene check that
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
  gate: 'work',
  title: 'Temporary files',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: SQL,
  map: (rows) => ({
    files: Number(rows[0]?.temp_files ?? 0),
    bytes: Number(rows[0]?.temp_bytes ?? 0),
  }),
};
```

Notice what the compiler makes you say: a `gate`, a `class`, a `map`. Leave
`verdict` out, and the check reports without judging. If you did add one, you
would add `thresholds` with a non-empty `because` on each, and a test at each
boundary.

**2. Register it.** In `packages/checks/src/registry.ts`, import it and add
`tempFiles` to the `CHECKS` object. Add `export type * from
'./checks/temp-files.js';` to `packages/checks/src/index.ts` so the console
can name `TempFilesData`. Run `npm test`; the registry tests confirm the
check exists and has a gate the triage page renders.

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
      expect(r.verdict).toBeNull();
      expect(r.data.files).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(r.data.bytes)).toBe(true);
    });
  }, 120_000);
});
```

`withPostgres` gives you a fresh database in the shared container. Run
`npm run test:int -- temp-files` to run only this file.

**4. Render it.** The check's gate is `work`, so it belongs under the Queries
tab, and its class is `hygiene`, so it goes on a page that does not poll. The
Tables page already is one. In `apps/web/app/db/[name]/queries/tables/page.tsx`,
add `formatBytes` to the import from `@/lib/format`, add the check to the
page's existing `Promise.all` so it runs alongside the others rather than
after them, and render a panel inside the grid:

```tsx
const [hitRate, unused, stats, caching, temp] = await Promise.all([
  // …the four existing calls…
  runCheckFor(name, CHECKS.tempFiles),
]);
// …
<CheckPanel title="Temporary files" result={temp}>
  {(d) => <p className="text-sm">{formatCount(d.files)} files, {formatBytes(d.bytes)}</p>}
</CheckPanel>
```

The page's own test mocks `runCheckFor` and hands back an empty object for
any check it has no fixture for, so it keeps passing. That is worth noticing:
a new panel is not tested until you add a fixture and an assertion for it in
`apps/web/test/tables-page.test.tsx`.

Do **not** add a `<Refresh>`; the guard will tell you if you do. Run
`npm run test:web` and `npm run --workspace @pgops/web typecheck`.

**5. Look at it.** `npm run --workspace @pgops/web dev`, open the Tables page,
and stop the container to see the panel go `UNAVAILABLE`. That is the whole
path: SQL, map, registry, test, page. Every step above was run against this
repository at 2.3.0 and passes; if one does not for you, the code has moved
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

Comments in the code cite design documents by date and section, for example
`spec 2026-09-03 §2` or `parity §2.1`. Those documents are kept outside the
repository. Treat the comment itself as the record of the decision.

Whichever you pick:

1. Find the existing test closest to what you are about to write and read it
   whole. `sessions-fold.test.tsx` and `check-panel.test.tsx` are good
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
