# pgops

> **On-call console for Postgres** — watches lock chains, slow queries and
> replication, live.

A small web console you deploy next to your databases, built to be opened while
the pager is going off. It can act, not only watch. In scope it is a pgHero
superset: everything pgHero answers, plus the half pgHero does not.

TypeScript and Next.js, one container, no agent to install and nothing to
schedule.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/triage-dark.png">
  <img alt="The triage page for a database called prod, in four bands — Sessions, Locks, Queries, Replication & cleanup, each with the question it answers written beside it. Checks that need attention take a full-width panel with a red or amber accent bar, a badge, and, beside the reading, two sentences: why the threshold matters and what to do about it. Under Locks one panel names the root blocker 18389 and a second, Blocked, is collapsed to a one-line strip because it measures the same incident. Under Slow queries the two long-running queries are each marked blocked by 18389, with a note reading Not slow — waiting. Healthy checks collapse to a single compact line carrying their value and an OK badge." src="docs/screenshots/triage-light.png">
</picture>

That superset claim is checked rather than asserted.
[packages/checks/src/registry.ts](packages/checks/src/registry.ts) maps all 65
capabilities of pgHero 4.0.1 onto a shipped check, a shipped action, a platform
feature, or a numbered phase, and the test suite fails if a phase marked
complete still owes one. **52 of the 65 are shipped, 1 is declined on purpose,
and 12 remain** — see [Parity with pgHero](#parity-with-pghero).

One URL, many databases. What is built so far is what you need in the first
five minutes — who's connected and in what state, is
anything blocked, what's running long, how much connection headroom is left,
which server you are actually pointed at — and then, if you switch the safety
off, it can terminate the backend that is holding everything up. Point it at a
store and it also records history — query statistics and relation sizes,
captured every five minutes, without ever resetting a counter another tool is
reading. The hygiene half is here too — indexes, bloat, table and database
size, sequence exhaustion, vacuum and analyze, and the server's own settings —
on its own tab, behind its own pages, and never polling a catalog scan.

```sh
docker build -t pgops .
docker run -e DATABASE_URL=postgres://… -p 8080:8080 pgops
```

## The model

Everything on the triage screen comes from one idea, and it is worth two
minutes because the rest of the console is derived from it. A query arriving
at Postgres has to clear four gates, **in this order**:

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

Two things follow, and they are the reason the order is worth fixing in place.

**Causes run down it; symptoms run up it.** Vacuum falls behind (4), tables
bloat, queries get slow (3), connections pile up behind them (1). What pages
you is near the top. What you have to fix is usually further down.

**A failure at one gate disguises itself as the next.** A session blocked at
gate 2 is `state = 'active'` in `pg_stat_activity`, so it also appears at gate
3 as a long-running query — and the console used to offer to terminate it,
directly below a panel saying, correctly, never to terminate a waiter. Naming
the gates is what lets the page say which one a session is actually stuck at.

The tree is **data, not prose**:
[packages/checks/src/gates.ts](packages/checks/src/gates.ts). Every check
declares its gate, the triage page's bands are `GATE_ORDER` rendered in
order with their headings read out of `GATES`, and **all 65 pgHero
capabilities carry one — including the 40 not built yet**, so nothing can
arrive later with nowhere to live. A capability whose gate disagrees with its
check fails the build, and so does one added without a gate at all.

`server` is the one placement that is not a gate: the server's version, role
and settings describe the machine rather than a request's progress through
it, and they render in the status line under the page heading.

## What's here

Five routes. That is the whole console today.

| Route | What it answers |
|---|---|
| `/` | **Overview** — every configured database, each with its worst verdict across every incident check. "Is anything wrong anywhere?", nothing more. A check that could not *run* is reported separately from a check that ran and was fine, and a database where *nothing* could be read reads `UNKNOWN` rather than `OK`: "we could not look" and "we looked and it's fine" must never render the same. |
| `/db/<name>` | **Triage** — one screen per database, one band per gate (see [The model](#the-model)): **Sessions** (connections and headroom, sessions by state), **Locks** (what's blocked, the root blockers), **Queries** (what's running long, statement shapes), and **Replication & cleanup** (role, lag, slots, wraparound horizon). Each band carries the question it answers and links to the route that goes deeper into it. Bands never move; what changes is size. A check that needs attention takes a full panel and explains itself; a healthy one collapses to one line. |
| `/db/<name>/sessions` | **Sessions** — live `pg_stat_activity`; connection sources grouped by database/user/app/IP with an SSL breakdown; and the one place an action can be taken (see Safety). pgops's own connections are folded away by default, counted rather than hidden. |
| `/db/<name>/locks` | **Locks** — the wait graph: who is blocking whom, and the root blocker at the top of the chain. |
| `/db/<name>/queries` | **Queries** — `pg_stat_statements`, sortable by total, mean or calls, plus a slow-queries panel scoped to what was actually fetched. With a store configured, each row also carries what it did **since the last capture**. |

### The front door

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-dark.png">
  <img alt="The pgops overview listing three databases: prod and analytics each with a red CRITICAL badge and a red accent bar, and staging showing 12 checks unavailable with a grey UNKNOWN badge. Above them, a summary line reading 2 of 3 databases need attention, 1 could not be assessed at all, and to the right of the title a freshness readout with a Refresh button." src="docs/screenshots/overview-light.png">
</picture>

Three states, and the third is the point. `staging` is not healthy and not
unhealthy — it could not be read at all, so it says `UNKNOWN` in grey rather
than borrowing the colour of either answer. Colour is reserved for verdicts;
its absence means there is no verdict to report. Every badge also spells its
level out in words, so none of this depends on seeing colour.

Open that database and the same rule applies one level down. When every check
on the page fails **the same way**, the page says it once — the database is
unreachable, and here is what Postgres said — instead of repeating one
connection error across nine panels laid out as though there were something to
triage. When the failures differ from one another, each panel keeps its own,
because then they are nine different things you need to read.

A URL naming a database this console is not configured for is a **404**, not a
500: you mistyped, pgops is not broken. The 404 lists the names that would have
worked, since pgops is the only thing that knows them.

### Every verdict says why, and what to do

A red badge is not a diagnosis. Each threshold in
[packages/checks](packages/checks/src/checks) carries two sentences alongside
its number — the reason that number is the number, and the action it calls
for — and a check that escalates renders both:

> **Why this matters** — five minutes of idle-in-transaction blocks autovacuum
> from reclaiming anything newer, so bloat starts accumulating on top of the
> locking.
>
> Terminate it: at this age it blocks autovacuum as well as holding locks. Set
> `idle_in_transaction_session_timeout` on that role so Postgres does this
> without you.

The sentence follows the level, so the same check reads differently at `WARN`
and at `CRITICAL` — it is the crossed threshold talking, not the check. A
threshold with no single safe action carries no advice rather than a guess, and
a healthy check says nothing at all: nothing was crossed, so there is nothing to
explain.

### One incident, one card — and a waiter is not a slow query

Nine checks run against different catalogs and none of them knows the others
exist. The triage page is the only thing holding every result, so it is the
only thing that can notice when two of them are describing the same session.
It does that in two places, and both were screens that contradicted
themselves before it did.

A stuck transaction escalates `blocked` (which counts its waiters) and `locks`
(which walks the chain that produced them), so the Locks band drew two
full cards, two red accent bars and two four-line explanations of one problem.
The accent bars are the part that misleads: they exist to be counted in
peripheral vision before a word is read, so two bars for one incident
overstates the page's own headline. The corroborating panel now collapses to a
one-line strip — the count and the longest wait are kept, the duplicate
paragraph is not — but only when both checks actually ran. A check that
*failed* is never demoted: "we could not look" is not a supporting detail of
anything.

The second is sharper. `long-running` selects `state = 'active'`, and a
session blocked on a lock **is** active in `pg_stat_activity` — so every
waiter in a chain is also a long-running query, always, by construction. The
console said "Terminate the ROOT blocker, not a waiter. Killing a waiter frees
nothing" in one band and, one band below, offered those exact waiters with
"terminating this backend usually frees work nobody is waiting for". Neither
check was wrong; the page was. Each long-running query that appears in the
wait graph is now marked with the **root** it is queued behind — not its
immediate blocker, which in any chain longer than two is itself a waiter — and
when every one of them is a waiter, the threshold's remedy is withheld and the
panel says what is actually happening instead.

Where a ratio decides a verdict, the ratio is drawn. The connection panel is a
[bullet graph](https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf) —
occupancy against a linear scale, shaded with the check's own warn and critical
bands, derived from the thresholds themselves so the picture cannot disagree
with the badge.

### Sessions

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/sessions-dark.png">
  <img alt="The sessions page: a table of three live backends with pid, state, age, user, application and query columns and a Terminate link per row, followed by a line reading 9 of pgops's own connections hidden, with a show them link. Beneath it a Connection sources panel groups connections by database, user, source and IP, listing pgops among the sources, with an SSL breakdown at the foot." src="docs/screenshots/sessions-light.png">
</picture>

Live `pg_stat_activity`, one row per backend, with `user` and `application` as
separate columns because "which app is doing this?" is the question actually
being asked. Underneath, connections grouped by database, user, source and IP,
and an SSL breakdown that counts `Unknown` separately from `No SSL` — a
connection whose encryption pgops could not read is never reported as one it
confirmed was plaintext.

pgops names its own backends `pgops` and folds them out of this table by
default. Before it did, a console watching a quiet database showed three
application sessions among nineteen of its own idle connections — each with its
own `Terminate` link, offering to kill the console. They are counted and one
click away, never silently dropped: polling every five seconds is real load on
this database, and the page that exists to show load must not exempt itself
from it. If your connection string sets its own `application_name`, that wins —
pgops then has no way to recognise itself, and every row stays visible.

### The wait graph

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/locks-dark.png">
  <img alt="The locks page showing a lock chain: pid 9401, a batch-worker session idle in transaction, blocking pid 9403 (cron-cleanup), which in turn has pid 9402 (web-api) waiting behind it. Each row is indented under the session it waits on and shows the SQL it is running." src="docs/screenshots/locks-light.png">
</picture>

Nested, not flat. `long read <- ACCESS EXCLUSIVE <- readers` renders as three
unrelated rows in a flat table, which is exactly how a migration pile-up hides
its amplifier — the root blocker sits at the top of the chain and the sessions
queued behind it are indented under the thing they are waiting on.

### Queries

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/queries-dark.png">
  <img alt="The queries page, with sortable calls, total and mean column headers, the active total column marked with a downward caret, a since-last-capture column, and rows showing means in milliseconds. One row is tinted and tagged with an amber SLOW badge, matching the count in the Slow queries panel above the table." src="docs/screenshots/queries-light.png">
</picture>

The three column headers are the sort control; the active one carries a caret
and an `aria-sort`. Sort order lives in the URL, so a ranking is shareable and
survives the back button. With a store configured, each row also carries what
it did since the last capture.

The slow-queries panel counts the shapes past both bounds — 20ms mean over 100+
calls — and the rows it counted are tagged `SLOW` in the table beneath it, so
the sentence and the row are joined rather than left three inches apart for you
to re-derive by eye.

One honest limit: `pg_stat_statements` records no `application_name`, so pgops
**cannot** fold its own statements out of this page the way it can on Sessions.
Its checks and, if you point `PGOPS_STORE_URL` at a database it also monitors,
its captures appear here as ordinary shapes. Giving pgops its own role, and a
store on a separate database, keeps this page about your application.

Every `/db/<name>` page carries a status line under the heading: the database
and role the server itself reports, its version, whether the connection is
encrypted, and a `replica` flag. Everywhere else in the console a database is
called by the name **you** gave it in `PGOPS_DATABASES`; that line is the only
place the server gets to answer, and it sits directly above a button that can
terminate backends. An SSL status pgops could not read says `SSL unknown`, never
`no SSL`.

The console follows your operating system's light or dark setting. There is no
theme toggle and no preference to set — at 3am the right answer is whichever
one everything else on the machine is already using. Fonts are the system UI
stack, so nothing is fetched from a font CDN a locked-down network cannot
reach, and there is no reflow on a page you are trying to read quickly.

### Live, and honest about how live

The four incident routes re-fetch every five seconds, and the overview every
thirty — it runs twelve checks per database, so its tick costs twelve times a
triage tick multiplied by however many databases are configured, and it
answers a question that changes on a slower clock than a lock chain does. The
header says how old what you are reading is — counted from when the request **started**, not
when it landed, so a five-second fetch reads "updated 5s ago" the moment it
arrives, which is true. The clock keeps ticking between polls, so a poll that
has stalled shows up as a number climbing past the interval rather than a
reading frozen at zero. There is a Refresh button for the moment you do not
want to wait out the interval — after a terminate, usually.

A tick that lands while one is still in flight is **skipped, not queued**. The
console must never be the reason a database runs out of connections, and that
rule holds for the button as much as the timer: pressing Refresh during a fetch
re-arms exactly one follow-up rather than adding a second concurrent render.

Hygiene routes will not poll when they land — their queries are catalog scans,
and a test fails the build if one ever inherits the timer.

A check that cannot run says so and says why — a missing `pg_stat_statements`
extension, a server below the version it needs — instead of rendering as zero.
"We could not look" and "we looked and it's fine" never render the same. Where
Postgres itself withholds a row from your role rather than failing the query,
the check still runs and that row reads `insufficient privilege`.

## Running it

**There is no published image yet.** Nothing is pushed to a registry, so build
it from a clone first — every `docker run` below assumes you have:

```sh
docker build -t pgops .
```

```sh
# one database
docker run -e DATABASE_URL=postgres://… -p 8080:8080 pgops

# many
docker run -e PGOPS_DATABASES='[{"name":"prod","url":"postgres://…"},…]' \
           -e PGOPS_USERNAME=… -e PGOPS_PASSWORD=…                      \
           -p 8080:8080 pgops

# with history
docker run -e DATABASE_URL=postgres://…      \
           -e PGOPS_STORE_URL=postgres://…   \
           -p 8080:8080 pgops
```

Configuration is read **at request time, not build time**. The same image works
against any database you point it at, and CI proves it: it builds an image with
one `DATABASE_URL` baked in, runs it with a different one, and asserts the
running container uses the second.

### Configuration

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | One database, named `default`. The simplest form. |
| `PGOPS_DATABASES` | A JSON array of `{name, url}` for several databases. Each `name` becomes a URL path segment, so it must match `[A-Za-z0-9_-]+` and be unique. |
| `PGOPS_CONFIG_FILE` | Path to a file holding that same JSON array. Takes precedence over both of the above — it is the most deliberate of the three, and the only one that keeps connection strings out of the process environment, where `docker inspect` and `/proc/<pid>/environ` can read them. |
| `PGOPS_STORE_URL` | A Postgres database pgops may create its own `pgops` schema in. Setting it enables history: the schema is migrated at boot, a capture runs immediately, and another every five minutes after that. Leaving it unset means no DDL anywhere, no scheduler, and history reporting as unavailable — there is **no** fallback to a monitored database. |
| `PGOPS_USERNAME` | Username for HTTP basic auth. |
| `PGOPS_PASSWORD` | Password for HTTP basic auth. Set both to require auth, or neither to run without it; setting exactly one is a hard 503, not an open door. |
| `PGOPS_ALLOW_ACTIONS` | Set to `true` to enable actions — surrounding whitespace and case are ignored, so `TRUE` works too. Anything else, including the string `false`, leaves them off; the value is compared against `true`, never tested for truthiness. |
| `PGOPS_PUBLIC_HOST` | The host recorded in audit records. Falls back to the request's `Host` header, which is the caller's own claim about this console's address rather than an operator-configured, resolvable one. Set it if you read your audit log. |
| `PGOPS_AUDIT_LOG` | Path for the local audit-log copy. Defaults to `~/.pgops/audit.log`. |
| `PORT` | Port the server listens on. Defaults to `8080` in the image. |

Precedence for databases is `PGOPS_CONFIG_FILE`, then `PGOPS_DATABASES`, then
`DATABASE_URL`. If none is set — or if what you set cannot be read or parsed —
the server still comes up (configuration is read per request, not at boot) and
every page renders **"pgops is not configured"** with the reason: which of the
three inputs pgops looked at, the file path it tried, or the exact JSON error.
The message names the input you actually set, so you do not have to go digging
in the container log to find out which one is wrong.

### History

`PGOPS_STORE_URL` turns on the half of pgHero that needs somewhere to write.
On boot pgops creates a `pgops` schema in that database — five tables, one
forward-only migration, taken under an advisory lock so several replicas
starting together migrate once — then captures every statement shape and
every relation size, once immediately and every five minutes after that. The
capture at boot is not a nicety: a deployment restarting pods faster than the
interval would otherwise record nothing at all, ever, and nothing would say so.

Four properties are worth stating because they are the ones easy to get
wrong, and each is held by a test:

- **It never resets a counter.** pgHero calls `pg_stat_statements_reset()`
  after each capture, which silently zeroes the view for every other tool
  watching that database. pgops stores the cumulative numbers and subtracts
  at read time.
- **A gap is drawn as a gap.** When a counter goes backwards — someone reset
  the view, or `pg_stat_statements` evicted the shape and it restarted from
  zero — the interval spanning it is dropped rather than clamped. A spike
  that never happened reads as an incident, and this is a tool you open
  during one.
- **A tick that lands while one is still running is skipped, not queued.**
  The console must never be the reason a database runs out of connections.
- **Snapshots are timestamped by the store, not by the process.** Several
  replicas can run this; with a clock skew wider than the capture interval,
  process-side timestamps would sort out of order and every interval would be
  discarded as a discontinuity.

Without the variable there is no scheduler, no schema, and no DDL anywhere;
history reports itself as unavailable and the queries page simply does not
draw the column. It never guesses at a database to write to.

## What v2 adds

**v1 was the incident half of pgHero, and only that half.** v2 is the other
half: indexes, bloat, table and database size, sequence exhaustion, vacuum and
analyze, and the server's own settings. It ships as a whole class rather than
as panels appearing one release at a time, for the reason the v1 boundary
existed in the first place — a console that answers "are your indexes healthy?"
with a half-built screen is worse than one that does not answer it at all.

The shape of the console changed, which is why this is a major version. The nav
had four gates and three tabs; `keep-up` — *Replication & cleanup* — had no
destination. It has one now:

| Route | What it answers |
|---|---|
| `/db/<name>/cleanup` | Wraparound horizon, replication role and lag, replication slots |
| `/db/<name>/cleanup/space` | Database size, largest relations, largest tables, seven-day growth |
| `/db/<name>/cleanup/space/<relation>` | One relation's captured size over thirty days |
| `/db/<name>/cleanup/maintenance` | Running vacuums, last vacuum and analyze, transaction-ID age by relation |
| `/db/<name>/cleanup/sequences` | Every sequence against the ceiling of the column it feeds |
| `/db/<name>/queries/indexes` | Index usage, missing and unused indexes, duplicates, invalid indexes |
| `/db/<name>/queries/indexes/bloat` | Index bloat, estimated — on its own route, run on request |
| `/db/<name>/queries/tables` | Table hit rate, caching, unused tables, table statistics |
| `/db/<name>/queries/<queryid>` | One statement shape's calls and total time over twenty-four hours |

**The poll boundary is the load-bearing distinction.** `/cleanup` renders
incident checks and refreshes every five seconds, because a wraparound horizon
and a stalled replication slot both get worse while you watch. Everything under
it runs catalog scans and refreshes only when you ask. A guard in the test
suite holds that from both directions: a hygiene route that starts polling
fails, and so does an incident page that stops.

The divergences from pgHero that arrived with these routes are catalogued with
the rest of them under [Parity with pgHero](#parity-with-pghero), beside the
code that implements each one.

## Parity with pgHero

pgHero is the benchmark, and the audit is in the repo rather than in a claim.
`registry.ts` was compiled against a fresh clone of pgHero 4.0.1 by enumerating
every public method under `lib/pghero/methods/`, plus the dashboard-only
capabilities that back no method at all. Each of the 65 entries names its source
file and resolves to exactly one state, checked on every test run.

| State | Count |
|---|---:|
| Shipped | 52 |
| Declined on purpose | 1 |
| Remaining | 12 |

The remaining work is phased, and `parityBacklog(phase)` reports each phase's
size rather than leaving it to be counted by hand: **P5 owes 6 and
P6 owes 6** — the `reset_stats` and `analyze` actions, `EXPLAIN`, and index
suggestions. P0, P1, P2, P3 and P4 are done. Build order is data in `PHASE_ORDER`, which is why P3, the store and the
capture scheduler, shipped ahead of P2.

Every number above comes from `registry.ts`. If one of them is wrong, the test
suite is wrong with it — `parityBacklog` is what the phase gate reads, and a
phase marked complete that still owes an entry fails by name.

Thirteen deliberate divergences, all of them documented at the code that
implements them — six from v1, six that arrived with the hygiene routes, and
one with the trends:

- **`kill` is guarded.** pgHero's is a bare `pg_terminate_backend` behind a
  button. See [Safety](#safety).
- **`ssl_in_use` needs no extension.** pgHero calls `ssl_is_used()` from
  `sslinfo`, so it reports SSL only where somebody installed that extension.
  pgops reads `pg_stat_ssl`, a core catalog since 9.5, for its own backend —
  which is readable without `pg_read_all_stats`.
- **`kill_all` is declined**, permanently. There is no incident in which
  "terminate every session, unreviewed" is the correct first move; it is an
  action with no diagnosis.
- **`replication_lag` is `null` on a primary, not `0`.** pgHero answers 0 —
  on a dashboard that reads as "perfectly caught up", a claim about
  replication health made about a server that is not replicating. pgops's
  `null` means "not a meaningful question." See `replication.ts`.
- **`connection_security_breakdown` keeps pgHero's four-value scheme and
  adds a fifth.** pgHero classifies each connection as SSL / No SSL / Socket
  / Internal Process; pgops keeps all four and adds `Unknown` for a
  connection `pg_stat_ssl` had no row for, so a read failure can never
  render as a confirmed "No SSL" finding. See `sslStatus`.
- **Capture does not reset shared statistics.** pgHero's `capture_query_stats`
  calls `pg_stat_statements_reset()`, which silently breaks every other
  consumer on that database. pgops stores the cumulative counters and
  differences them at read time instead. Two tests hold it: an integration
  test captures twice and asserts the counters only ever climb, and a source
  guard fails the moment any file in `packages/checks` so much as names a
  reset function.
- **Sizes are bytes, not `pretty_size` strings.** pgHero returns `"8192 MB"`,
  which cannot be thresholded, summed or charted. pgops returns the number and
  formats it at the page that renders it. See `space.ts`.
- **A reading we could not take is `null`, never a sentinel.** pgHero renders
  an index with no I/O yet as `"Insufficient data"` in a column of percentages,
  and a table nothing has read as `0%` cached. Both sort to the top of a page
  ranked by how bad the reading is. See `indexes.ts` and `tables.ts`.
- **Settings are one round trip, not fifteen.** pgHero issues `SHOW <name>` per
  setting; pgops reads `pg_settings` once. The value is the `SHOW`-equivalent,
  so `shared_buffers` reads `128MB` rather than `16384` with a separate `8kB`
  unit hanging off it. pgHero's version branch is also dropped rather than
  copied: it exists because `SHOW` errors on a setting the server does not
  have, and `pg_settings` returns no row instead. See `settings.ts`.
- **`sequence_danger` measures against the COLUMN's type, not the sequence's
  own maximum.** A bigint sequence feeding an `integer` column overflows at
  2,147,483,647 — the column's ceiling is the one that breaks writes. Measured
  against the sequence's own `max_value` it reads as 0.00000002% used on the
  day it starts failing. See `sequences.ts`.
- **`autovacuum_danger` ships as a list, not an alarm.** `transaction_id_danger`
  already reads the database-wide `datfrozenxid`, which is the minimum over
  every relation, so it cannot miss what the per-relation list would find. Two
  badges on one fact would disagree the moment either was tuned. The list is
  what you open after the alarm fires, to decide what to vacuum first. It also
  reads the TOAST relation's frozen xid, which freezes independently of the
  heap — read the heap alone and a table whose TOAST holds the oldest xid in
  the database reports an age of zero. See `maintenance.ts`.
- **`maintenance_info` is answered by `table_stats`.** The two read the same
  view and return the same eight fields, so #43 and #36 resolve to one check
  rather than two answers to one question. See `tables.ts`.
- **`space_growth` measures between two stored captures, not against a live
  size.** pgHero takes the oldest size in the window and subtracts it from the
  relation's size *right now*, re-measured against the monitored database. That
  mixes a stored reading with a live one — up to one capture interval of change
  is attributed to the whole window, and the number moves every time the page is
  re-rendered, so two operators looking at the same "7-day growth" see different
  figures. Both endpoints come from the store, and the last capture time is
  rendered beside them. See `store/read.ts`.


## Safety

pgops can terminate a backend. Everything below exists because of that.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/kill-confirm-dark.png">
  <img alt="A row in the sessions table with the terminate control open: a reason field, a red-outlined Confirm button shown greyed out and disabled, a Cancel button, and the note reason required, it is audited." src="docs/screenshots/kill-confirm-light.png">
</picture>

Terminate is a two-step inline control, not a modal. The reason field is not a
formality and Confirm stays disabled until it has one — the text is written to
the audit record, so a kill with no stated reason is a kill nobody can account
for afterwards. The panel opens leftward over the row rather than widening the
table, so the button never lands off the edge of the screen.

- **Actions are off by default, and the route does not exist without the flag.**
  With `PGOPS_ALLOW_ACTIONS` unset, **every** method on `/api/db/<name>/kill`
  answers **404**, not 403 — a 403 advertises a kill endpoint that is merely
  switched off. Every method matters and is the part that is easy to get
  wrong: the route file exports only `POST`, so Next answers `GET` with a 405
  *before* any handler runs, and a 405 where a missing route would say 404 is
  itself the disclosure. The gate therefore sits in `proxy.ts`, above method
  dispatch; the route keeps its own copy so the property does not rest on a
  matcher. A flagless deployment is byte-identical to a build without the
  file, and a test asserts exactly that rather than merely asserting 404.
  The route also requires `Content-Type: application/json` and
  answers **415** otherwise, because a cross-origin HTML form cannot set that
  header and basic-auth credentials ride cross-site automatically.
- **`PGOPS_ALLOW_ACTIONS=true` with no `PGOPS_USERNAME` is an unauthenticated
  kill endpoint.** The action gate and basic auth are independent safeguards,
  and neither one covers this combination: with actions on and auth off,
  anyone who can reach the port can terminate backends, and the audit record
  simply says `anonymous`. pgops warns on stderr the first time such a request arrives but
  does not refuse to serve — some deployments legitimately put an
  authenticating proxy in front. If yours does not, set `PGOPS_USERNAME` and
  `PGOPS_PASSWORD` whenever you set `PGOPS_ALLOW_ACTIONS`.
- **`kill` is pinned to the session identity, not the pid.** The target's
  `backend_start` is captured when you select the row and compared, inside the
  same statement as the terminate, against a snapshot of `pg_stat_activity`. A
  pid that Postgres recycled between your click and your confirmation comes back
  `session-changed` and is left alone. Killing a blocker never cascades to its
  waiters.
- **Every kill is audited**, success or failure, as one JSON line to **stdout**
  — the channel your log shipper already reads, and the record's real home,
  since a container's local filesystem is not durable — and, best-effort, to
  `~/.pgops/audit.log`. The record names the authenticated operator, the target,
  a required free-text reason, and the outcome. A failed write goes to stderr;
  it never silently disappears and never turns a successful kill into a
  reported failure.
- **Every rendered query is redacted.** `redactSecrets` runs on every query this
  console displays, and on every audit record before it is written. This matters
  more on the web than in a terminal: a screenshot needs a human to take it, a
  URL forwards itself.
- **Basic auth is the floor, not the answer.** `PGOPS_USERNAME` /
  `PGOPS_PASSWORD` give you HTTP basic auth over every route that can read or
  change a database. For anything real, put a reverse proxy in front — OAuth2
  Proxy, ALB auth, IAP. That is what pgHero's own guide says, and it is what
  this project's spec says too. Run it behind TLS; basic auth over plaintext is
  a password in every request.

pgops runs no DDL against a monitored database. Given `PGOPS_STORE_URL` it
creates and migrates its own `pgops` schema in that store, and nowhere else —
a source guard confines every DDL statement in the repo to
`packages/checks/src/store/migrations/`. It does not install extensions or
manage roles. Give its role the least privilege that works:
`pg_read_all_stats` to see other sessions' queries, and `pg_signal_backend`
only if you intend to use `kill`. Without `pg_signal_backend` the console
still reads everything; a kill returns the permission error Postgres gave, in
the page, rather than a blank.

## Requirements

- **Postgres 14 or newer.** Tested against 14, 16, 17 and 18 in CI on every push.
- `pg_stat_statements` for the Queries route. Everything else works without it,
  and the route says what is missing rather than rendering empty.
- A Postgres database for `PGOPS_STORE_URL` if you want history. It can be one
  of the databases you monitor, but pgops will not pick one for you: without
  that variable it writes nothing anywhere.
- Docker, to build and run the image — there is no published one yet.

## Development

```sh
npm install
npm run db:up                      # throwaway Postgres on :55432, prints DATABASE_URL
npm run db:seed                    # optional: manufacture a lock chain to look at
export DATABASE_URL='postgres://postgres:secret@localhost:55432/appdb'
export PGOPS_STORE_URL="$DATABASE_URL" # optional: enables history
npm run --workspace @pgops/web dev     # http://localhost:3000
npm run db:down                        # tear it down
```

`db:up` preloads `pg_stat_statements`, so the Queries route has something to
show. See [scripts/dev-db.sh](scripts/dev-db.sh).

The repo is two workspaces: `packages/checks`, a framework-free package holding
every SQL check, the history store and the one code path that issues
`pg_terminate_backend`; and `apps/web`, the Next.js console that renders them.
The checks package knows nothing about React.
[dba-playbook/](dba-playbook/) is neither: it is the hand-written SQL the
checks were derived from, kept runnable so a finding can be reproduced in
`psql` without trusting this tool.

```sh
npm test                                    # unit — checks, pure logic, source guards
npm run test:web                            # the console's component and route tests
npm run test:int                            # integration, against a real Postgres (Docker)
npm run typecheck:test                      # types across packages/, including test files
npm run --workspace @pgops/checks typecheck
npm run --workspace @pgops/web typecheck
```

## What happened to the terminal UI

pgops began as an Ink terminal program: a tab strip, keystrokes, an ASCII
cockpit. **That UI was removed in this release.** The reasoning is in the design
spec — an incident tool that can only be reached by ssh-ing to a box with the
right `DATABASE_URL` in its environment is reachable by one person at a time,
and the checks it ran deserved a surface the whole on-call rotation can open. The
SQL, the thresholds, the redaction and the kill guard were not rewritten; they
were lifted into `packages/checks` and are what the console runs today.

There is no `pgops` binary, and one is no longer planned. The CLI this README
once promised — `pgops check --format json`, plus a `pgops init` to create the
history schema — was cut when the store landed: migrations run at boot and
capture runs in-process behind an advisory lock, so the package would have
existed only to wrap a function the server already calls. `captureOnce` takes a
context and returns, so if a CLI is ever wanted it is a wrapper, not a rewrite.
If you came here from the old README looking for `pgops locks`, it is the
`/db/<name>/locks` route.

Nothing was ever published to npm, so no installed version was taken away.

## License

[Apache-2.0](./LICENSE)
