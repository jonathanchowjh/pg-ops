# pgops

> **On-call console for Postgres** — watches lock chains, slow queries and
> replication, live.

A small web console you deploy next to your databases, built to be opened
while the pager is going off. One container, one URL, many databases, no agent
to install and nothing to schedule. It can act as well as watch: behind a flag
it terminates the backend holding everything up, and every action is audited.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/triage-dark.png">
  <img alt="The triage page for a database called shop. Down the left is a numbered rail: 1 Sessions, is there room for the next request; 2 Locks, is anything waiting instead of working; 3 Queries, is the work itself taking too long; 4 Replication and cleanup, can the server keep up with what already committed. Each carries a link to its own page, and a hairline rule runs from it across the band beside it. Two panels are boxed, tinted red and marked CRITICAL: Lock wait graph, naming root blocker 489 with the statement it is holding and two sentences on why it matters and what to do; and Long-running, listing four backends, two of them marked blocked by 489. Beneath Queries a cached hygiene line reads Indexes, 1 unused index, 10s ago, WARN on an amber ground. Every healthy check is an unboxed row on the page background carrying its value and a green OK badge." src="docs/screenshots/triage-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/queries-dark.png">
  <img alt="The Queries page. Above the statistics table, two line charts sit side by side over the same twenty-four hours: Execution time per capture interval, ruled 1.4ms to 4.5s across four labelled gridlines, and Calls per capture interval, ruled 11 to 681. Both are labelled minus 23h 57m, minus 11h 58m and now along the time axis, and both carry a clean break where captures are missing, drawn as a gap rather than a straight line through it. A tall spike partway across the execution-time chart is absent from the calls chart beside it: the database got slower, it did not get busier. Below, a table of statement shapes with calls, total, mean, a since-last-capture column and the normalised SQL." src="docs/screenshots/queries-light.png">
</picture>

In scope it is a [pgHero](https://github.com/ankane/pghero) superset, and that
claim is checked rather than asserted:
[registry.ts](packages/checks/src/registry.ts) maps all 65 capabilities of
pgHero 4.0.1 onto a shipped check, action, series or tool, and the test suite
fails if the numbers below drift from what the registry computes.
**60 of the 65 are shipped, 5 are declined on purpose, and 0 remain** — see
[Parity with pgHero](#parity-with-pghero).

```sh
docker build -t pgops .
docker run -e DATABASE_URL=postgres://… -p 8080:8080 pgops
# open http://localhost:8080
```

**Where to go next**

| You want to… | Read |
|---|---|
| Run it against your databases | [Running it](#running-it), [Safety](#safety) |
| Understand the screen | [The model](#the-model), [The pages](#the-pages) |
| Work on the code, including as a first project | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Do the same work by hand in `psql` | [dba-playbook/](dba-playbook/) |
| Read why it was built this way | [docs/](docs/README.md) |
| Report a vulnerability | [SECURITY.md](SECURITY.md) |
| See what changed in each release | [CHANGELOG.md](CHANGELOG.md) |

## The model

Everything on the triage screen comes from one idea. A query arriving at
Postgres has to clear four gates, **in this order**:

```
A query arrives
│
├─ 1 connect   can it get IN?            connections · sessions · sources
│              stuck → nothing runs at all: "too many clients already"
│
├─ 2 wait      can it get its LOCKS?     blocked · the wait graph
│              stuck → it is waiting, not slow. It does zero work.
│
├─ 3 work      can it do the WORK fast?  long-running · statement stats
│              stuck → genuinely slow: the plan, a missing index, the volume
│
└─ 4 keep-up   can the server KEEP UP?   replication · vacuum · space
               failing → not an outage today; it is tomorrow's outage
```

Two things follow, and they are why the order is fixed in place.

**Causes run down it; symptoms run up it.** Vacuum falls behind (4), tables
bloat, queries get slow (3), connections pile up behind them (1). What pages
you is near the top. What you have to fix is usually further down.

**A failure at one gate disguises itself as the next.** A session blocked at
gate 2 is `state = 'active'` in `pg_stat_activity`, so it also appears at gate
3 as a long-running query — and the console used to offer to terminate it,
directly under a panel saying never to terminate a waiter. Naming the gates is
what lets the page say which one a session is actually stuck at.

The tree is data, not prose: [gates.ts](packages/checks/src/gates.ts). Every
check declares its gate, the triage page's bands are the gates rendered in
order, and every one of the 65 pgHero capabilities carries one, so nothing can
arrive with nowhere to live. The one placement that is not a gate is
`server` — version, role and settings describe the machine rather than a
request's progress through it, and they render in the status line under the
page heading.

## The pages

One tab per gate, plus an overview. The incident pages poll; the hygiene
pages run their catalog scans when you open them and never poll, and a test
holds that boundary from both directions.

With a store configured, those same hygiene checks also run on the capture
tick — every five minutes, each bounded at ten seconds — and the triage page
reports what they found as one line per area, with the age of the reading.
That is the one thing pgHero's dashboard did that this console did not: a
duplicate index or a sequence near its ceiling used to be invisible until
somebody opened the page that looks for it. Without a store nothing is
scheduled, the lines say so once, and the pages behave exactly as before.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/indexes-dark.png">
  <img alt="The Indexes page, one of the hygiene pages. Index cache hit rate, Invalid indexes and Unvalidated constraints are plain headings with a green OK badge and a one-line reading beneath each. Only Unused indexes is boxed, tinted amber and given a left bar: it is marked WARN, one unused index, and holds a table naming public.order_items_sku_idx on public.order_items at 36 MB, beside two sentences on why the 10 MB floor was adopted and what to confirm before dropping it. Below, Duplicate indexes, Tables that may need an index and Index usage by table each carry a plain count chip and a table of relations." src="docs/screenshots/indexes-light.png">
</picture>

| Route | Answers | Polls |
|---|---|---|
| `/` | **Overview.** Every configured database with its worst verdict across every incident check. A database that could not be read at all says `UNKNOWN`, never `OK`. | 30 s |
| `/db/<name>` | **Triage.** One band per gate. A check that needs attention takes a full panel and explains itself; a healthy one collapses to one line. With a store, each band also carries its cached hygiene areas, with the age of the reading. | 5 s |
| `/db/<name>/sessions` | **Sessions.** Live `pg_stat_activity`, connection sources with an SSL breakdown, and the terminate controls. pgops's own connections are folded away, counted rather than hidden. | 5 s |
| `/db/<name>/locks` | **Locks.** The wait graph as a tree: root blocker at the top, waiters indented under what they wait on, cycles marked. | 5 s |
| `/db/<name>/queries` | **Queries.** `pg_stat_statements` sortable by total, mean or calls; a slow-queries panel; with a store, two charts over twenty-four hours — the database's total execution time and its calls, side by side, because time alone cannot say whether the database got slower or busier — and what each shape did since the last capture. The statistics resets live here. | 5 s |
| `/db/<name>/queries/<queryid>` | One shape, named by its statement: calls, total time and rows over twenty-four hours. | — |
| `/db/<name>/queries/explain` | Paste a statement, read its plan and the index that would serve it. | — |
| `/db/<name>/queries/indexes` | Index hit rate and caching, missing, unused, duplicate and invalid indexes. pgops's own indexes are folded away, counted rather than hidden. | — |
| `/db/<name>/queries/indexes/bloat` | Index bloat, estimated. On its own route because the estimate is expensive. | — |
| `/db/<name>/queries/indexes/suggested` | Suggested indexes for the busiest shapes, each with the exact statement to run. | — |
| `/db/<name>/queries/tables` | Table hit rate and caching, unused tables, per-table statistics. pgops's own tables are folded away, counted rather than hidden. | — |
| `/db/<name>/cleanup` | **Cleanup.** Wraparound horizon, replication role and lag, replication slots, and the server's settings in a disclosure. | 5 s |
| `/db/<name>/cleanup/space` | Database size, largest relations and tables, seven-day growth. Sizes are never filtered; the lists fold pgops's own relations away, counted rather than hidden. | — |
| `/db/<name>/cleanup/space/<relation>` | One relation's captured size over thirty days. | — |
| `/db/<name>/cleanup/maintenance` | Running vacuums with progress, last vacuum and analyze per table, transaction-ID age by relation. The analyze action lives here. | — |
| `/db/<name>/cleanup/sequences` | Every sequence against the ceiling of the column it feeds. pgops's own sequences are folded away, counted rather than hidden. | — |

### What the pages have in common

**"We could not look" never renders as "we looked and it's fine."** A check
that cannot run says why — a missing extension, a role without the privilege,
a server below the version it needs — instead of rendering as zero. On the
overview an unreadable database is grey `UNKNOWN`, not green. Colour is
reserved for verdicts, and every badge spells its level out in words.

**Every verdict says why, and what to do.** Each threshold in
[packages/checks/src/checks](packages/checks/src/checks) carries two sentences
beside its number: why that number matters, and the action it calls for. A
check that escalates renders both. A threshold with no single safe action
carries no advice rather than a guess.

> **Why this matters** — five minutes of idle-in-transaction blocks autovacuum
> from reclaiming anything newer, so bloat starts accumulating on top of the
> locking.
>
> Terminate it: at this age it blocks autovacuum as well as holding locks. Set
> `idle_in_transaction_session_timeout` on that role so Postgres does this
> without you.

**One incident, one card.** When two checks describe the same session — a
stuck transaction escalates both `blocked` and `locks` — the corroborating
panel collapses to a one-line strip. Each long-running query that is really a
lock waiter is marked with the root blocker it is queued behind, and the
"terminate it" advice is withheld, because killing a waiter frees nothing.

**Live, and honest about how live.** The header says how old what you are
reading is, counted from when the request started. The clock keeps ticking
between polls, so a stalled poll shows as a number climbing past the interval
rather than a reading frozen at zero. A tick that lands while one is in flight
is skipped, not queued: the console must never be the reason a database runs
out of connections. There is a Refresh button for the moment after a
terminate.

**The server gets one line to answer.** Every `/db/<name>` page carries a
status line with the database and role the server itself reports, its
version, whether the connection is encrypted, and a `replica` flag. Everywhere
else the database is called by the name you gave it. An SSL status pgops
could not read says `SSL unknown`, never `no SSL`.

**A wrong URL is a 404, not a 500.** Naming a database this console is not
configured for lists the names that would have worked.

**No theme toggle, no font CDN.** The console follows the operating system's
light or dark setting, and the fonts are the system stack, so nothing is
fetched from a network a locked-down deployment cannot reach.

## Running it

There is no published image yet. Build it from a clone:

```sh
docker build -t pgops .

# one database
docker run -e DATABASE_URL=postgres://… -p 8080:8080 pgops

# many databases, behind basic auth
docker run -e PGOPS_DATABASES='[{"name":"prod","url":"postgres://…"},{"name":"analytics","url":"postgres://…"}]' \
           -e PGOPS_USERNAME=… -e PGOPS_PASSWORD=… \
           -p 8080:8080 pgops

# with history
docker run -e DATABASE_URL=postgres://… -e PGOPS_STORE_URL=postgres://… -p 8080:8080 pgops
```

Configuration is read **at request time, not build time**. The same image
works against any database you point it at, and `scripts/image-smoke.sh`
proves it by building an image with one `DATABASE_URL` baked in, running it
with another, and asserting the running container uses the second. The
pre-push hook runs it.

### Configuration

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | One database, named `default`. The simplest form. |
| `PGOPS_DATABASES` | A JSON array of `{name, url}`. Each `name` becomes a URL path segment, so it must match `[A-Za-z0-9_-]+` and be unique. |
| `PGOPS_CONFIG_FILE` | Path to a file holding that same JSON array. Takes precedence over both of the above, and is the only form that keeps connection strings out of the process environment, where `docker inspect` can read them. |
| `PGOPS_STORE_URL` | A Postgres database pgops may create its own `pgops` schema in. Enables history. See [History](#history). |
| `PGOPS_USERNAME`, `PGOPS_PASSWORD` | HTTP basic auth over every route. Set both or neither; setting exactly one is a hard 503, not an open door. |
| `PGOPS_ALLOW_ACTIONS` | `true` enables the actions. Case and surrounding whitespace are ignored. Anything else, including `false`, leaves them off. See [Safety](#safety). |
| `PGOPS_PUBLIC_HOST` | The host recorded in audit records. Falls back to the request's `Host` header. Set it if you read your audit log. |
| `PGOPS_AUDIT_LOG` | Path for the local audit-log copy. Defaults to `~/.pgops/audit.log`. |
| `PORT` | Port the server listens on. `8080` in the image. |

Precedence for databases is `PGOPS_CONFIG_FILE`, then `PGOPS_DATABASES`, then
`DATABASE_URL`. If none is set, or what you set cannot be parsed, the server
still comes up and every page renders **"pgops is not configured"** with the
reason: which input pgops looked at, the file path it tried, or the exact JSON
error.

### The database role

pgops runs no DDL against a monitored database, installs no extensions and
manages no roles. Give it the least privilege that works:

| Grant | Needed for |
|---|---|
| `pg_read_all_stats` | Seeing other sessions' queries. Without it, those rows read `insufficient privilege` and everything else still works. |
| `pg_signal_backend` | Terminating sessions. Without it, a kill returns the permission error Postgres gave, in the page. |
| `SELECT` on the tables you want planned, or `pg_read_all_data` | Explain and suggested indexes. Postgres checks `SELECT` even for a plan that reads no rows, and each refused plan says which table it was refused on. |

### History

`PGOPS_STORE_URL` turns on the half of pgHero that needs somewhere to write.
On boot pgops creates a `pgops` schema in that database (six tables,
forward-only migrations, under an advisory lock so several replicas starting
together migrate once), then captures every statement shape and every
relation size, once immediately and every five minutes after that. Each pass
also runs the hygiene checks and caches what they found, in its own
transactions after the capture has committed — a ten-second catalog scan has
no business holding the store's write path open. That cache keeps one row per
check, not a history: the question it answers is what the last pass found.
Without the variable there is no scheduler, no schema and no DDL anywhere;
history reports itself as unavailable and never guesses at a database to
write to.

Four properties are each held by a test:

- **It never resets a counter.** pgHero calls `pg_stat_statements_reset()`
  after each capture, which zeroes the view for every other tool watching that
  database. pgops stores cumulative numbers and subtracts at read time.
- **A gap is drawn as a gap.** When a counter goes backwards, the interval
  spanning it is dropped rather than clamped. A spike that never happened
  reads as an incident, and this is a tool you open during one.
- **A tick that lands while one is running is skipped, not queued.**
- **Snapshots are timestamped by the store, not the process**, so replicas
  with skewed clocks cannot make every interval look like a discontinuity.

### Requirements

- **Postgres 14 or newer.** The integration suite runs against 14, 16, 17 and 18.
- `pg_stat_statements` for the Queries tab. Everything else works without it,
  and the tab says what is missing rather than rendering empty.
- Docker, to build and run the image.

### Fixed in 2.3.1

With `PGOPS_ALLOW_ACTIONS=true`, 2.2.0 and 2.3.0 answered 500 on
`/db/<name>/cleanup/maintenance` on every load, and on `/db/<name>/sessions`
whenever a query had run past the long-running floor. Both pages passed a
function from a server component into a client component, which React refuses
to serialise. Fixed in 2.3.1, and the integration suite now renders those
pages with actions on — the gap that let it ship twice. Deployments with
actions off were unaffected.

## Safety

pgops can terminate backends, reset statistics and write to a monitored
database. Everything in this section exists because of that.

Actions sit on a ladder, and a deployment opts in to the whole ladder or none
of it. **`PGOPS_ALLOW_ACTIONS` is unset by default, and while it is unset the
action routes do not exist** — every method answers 404, byte-identical to a
path with no route at all, which an integration test asserts against a real
server.

| Tier | Actions | Gate |
|---|---|---|
| 0 | Every read, and explaining a statement | Always available |
| 1 | Terminate one session; analyze tables | The flag, **and** an inline confirmation with a required reason |
| 2 | Terminate every long-running query; reset query statistics; reset database statistics | Tier 1, **and** the database name typed back, checked on the server |
| 3 | Schema changes | **Unreachable.** Not gated, absent. See the declines under [Parity](#parity-with-pghero). |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/kill-confirm-dark.png">
  <img alt="A row in the sessions table with the terminate control open: a reason field, a red-outlined Confirm button shown greyed out and disabled, a Cancel button, and the note reason required, it is audited." src="docs/screenshots/kill-confirm-light.png">
</picture>

- **The route does not exist without the flag.** A 403 would advertise a kill
  endpoint that is merely switched off. The gate sits in `proxy.ts`, above
  method dispatch, so `GET` answers 404 rather than the 405 Next would
  otherwise give a `POST`-only route. Every action route also requires
  `Content-Type: application/json` and answers 415 otherwise, because a
  cross-origin HTML form cannot set that header and basic-auth credentials
  ride cross-site automatically.
- **Actions on with auth off is an unauthenticated kill endpoint.** pgops
  warns on stderr the first time such a request arrives but keeps serving,
  because some deployments put an authenticating proxy in front. If yours does
  not, set `PGOPS_USERNAME` and `PGOPS_PASSWORD` whenever you set
  `PGOPS_ALLOW_ACTIONS`.
- **Kills are pinned to the session identity, not the pid.** The target's
  `backend_start` is captured when you select the row and compared, inside the
  same statement as the terminate, against `pg_stat_activity`. A recycled pid
  comes back `session-changed` and is left alone. Killing a blocker never
  cascades to its waiters, and the bulk kill is N guarded kills with
  per-session outcomes, never a sweep.
- **Every action is audited**, success or failure, as one JSON line to stdout
  and, best-effort, to `PGOPS_AUDIT_LOG`. The record names the operator, the
  target, the free-text reason and the outcome.
- **Explain plans a statement; it never runs one.** The pasted text takes one
  path, is prepared as a named statement so Postgres itself refuses a second
  command after a `;`, runs inside `BEGIN READ ONLY`, is always rolled back,
  and its connection is destroyed rather than returned to the pool. There is
  no `ANALYZE`. Error messages are allowlisted by SQLSTATE so a failed plan
  cannot echo a value back.
- **Every rendered query is redacted.** `redactSecrets` runs on every query
  the console displays and on every audit record before it is written.
- **No DDL against a monitored database.** A source guard confines every DDL
  statement in the repo to `packages/checks/src/store/migrations/`, which runs
  only against `PGOPS_STORE_URL`.
- **Basic auth is the floor, not the answer.** For anything real, put a
  reverse proxy in front (OAuth2 Proxy, ALB auth, IAP) and run it behind TLS.

## Parity with pgHero

pgHero is the benchmark, and the audit is in the repo rather than in a claim.
`registry.ts` was compiled against a fresh clone of pgHero 4.0.1 by
enumerating every public method under `lib/pghero/methods/`, plus the
dashboard-only capabilities that back no method. Each of the 65 entries names
its source file and resolves to exactly one state, checked on every test run.

| State | Count |
|---|---:|
| Shipped | 60 |
| Declined on purpose | 5 |
| Remaining | 0 |

Every phase, P0 through P6, is complete. With every phase complete, the phase
gate fails any entry added as `planned`, so a capability pgHero adds later has
to arrive shipped or declined, with its reason.

### The five declines

| pgHero capability | Why |
|---|---|
| `kill_all` | An action with no diagnosis. There is no incident in which "terminate every session, unreviewed" is the correct first move. |
| `enable_query_stats`, `disable_query_stats` | Both are DDL against a monitored database. pgops diagnoses the absent extension and hands you the statement to run through your own migration tooling. Removing the extension is worse than installing it: it destroys every query statistic, including what pgops's own capture reads. |
| `autoindex` | Builds an index on a monitored database, unreviewed. Every pgops suggestion carries the exact statement instead. |
| `system_stats` | CPU, IOPS and free space from CloudWatch, Azure Monitor or GCP monitoring: per-cloud credentials and an SDK for one panel that is blank for everyone self-hosting. |

### Where pgops deliberately differs

Each is documented at the code that implements it.

- **Capture never resets shared statistics.** See [History](#history).
- **`kill` is guarded**, and `kill_long_running_queries` is N guarded kills
  with per-session outcomes. See [Safety](#safety).
- **`replication_lag` is `null` on a primary, not `0`.** `0` reads as
  "perfectly caught up", a claim about replication made about a server that is
  not replicating. `replication.ts`
- **`ssl_in_use` reads `pg_stat_ssl`**, a core catalog, rather than the
  `sslinfo` extension. `connection_security_breakdown` keeps pgHero's four
  values and adds `Unknown`, so a read failure can never render as a confirmed
  "No SSL". `connections.ts`
- **Sizes are bytes, not `pretty_size` strings.** `"8192 MB"` cannot be
  thresholded, summed or charted; formatting happens at the page. `space.ts`
- **A reading we could not take is `null`, never a sentinel.** pgHero renders
  an index with no I/O yet as `"Insufficient data"` in a column of
  percentages, which sorts to the top of a page ranked by how bad the reading
  is. `indexes.ts`, `tables.ts`
- **Settings are one round trip, not fifteen**, and the value is the
  `SHOW`-equivalent: `shared_buffers` reads `128MB`, not `16384` with a
  separate unit. `settings.ts`
- **`sequence_danger` measures against the column's type, not the sequence's
  own maximum.** A bigint sequence feeding an `integer` column overflows at
  2,147,483,647; measured against its own maximum it reads as 0.00000002% used
  on the day it starts failing. `sequences.ts`
- **`autovacuum_danger` is a list, not a second alarm.** The database-wide
  wraparound check already reads the minimum over every relation; the
  per-relation list is what you open after it fires, to decide what to vacuum
  first. It also reads the TOAST relation's frozen xid, which freezes
  independently of the heap. `maintenance.ts`
- **`maintenance_info` is answered by `table_stats`.** Same view, same eight
  fields, one check. `tables.ts`
- **`space_growth` measures between two stored captures**, not between a
  stored capture and a live size. pgHero's number moves every time the page is
  rendered; here both endpoints come from the store and the last capture time
  is shown beside them. A window too thin to measure says so once, above the
  list, with the number of captures that explains it — not once per row.
  `store/read.ts`
- **The load chart is written at capture time, never summed at read time.**
  "How busy has this database been today" spans every shape and every capture
  in the window, which for a large database is over a million rows to
  difference on a page that polls every five seconds. The capture that already
  holds both snapshots does the arithmetic once and stores one row, so the
  chart reads 288. An interval pgops could not measure — one spanning a
  `pg_stat_statements_reset()` or an eviction — is a gap in the chart rather
  than a zero. `store/migrations/004-query-load.ts`
- **pgops folds its own relations out of the lists, and out of nothing else.**
  Pointed at a database that is also its store, every catalog scan returns the
  console's own tables, indexes and sequences. The lists hide them and say how
  many were hidden; the readings — sizes, hit rates — and the checks' own
  verdicts count them, because a tool that removed itself from its own numbers
  would be lying about the thing it measures. `lib/fold.ts`
- **Index suggestions read the planner's plan, not a parse tree.** pgHero
  parses each statement with a native `pg_query` binding and answers any join
  with "JOIN not supported yet". pgops asks Postgres to plan the statement and
  advises on every sequential scan the plan names, with no added dependency.
  `tools/advice.ts`
- **Explain has no `ANALYZE`** and no link to an external plan viewer. Its
  error messages are allowlisted by SQLSTATE. `tools/explain.ts`
- **Suggestions read live statistics**, so they work with no store; the page
  names the window it read.

## What happened to the terminal UI

pgops began as an Ink terminal program. It was removed in v1.0: an incident
tool that can only be reached by ssh-ing to a box with the right
`DATABASE_URL` is reachable by one person at a time, and the checks it ran
deserved a surface the whole on-call rotation can open. The SQL, thresholds,
redaction and kill guard were lifted into `packages/checks` and are what the
console runs today. There is no `pgops` binary and none is planned; nothing
was ever published to npm. The reasoning is in the
[web console design](docs/design/2026-08-26-pgops-web-design.md).

## License

[Apache-2.0](./LICENSE)
