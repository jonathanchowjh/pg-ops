# pgops

An on-call console for PostgreSQL. It shows lock chains, slow queries,
connection pressure, replication and vacuum state for one or many databases,
live, from a single container. When a deployment opts in, it can terminate the
backend that is holding everything up, with a confirmation and an audit record.

pgops is audited capability by capability against
[pgHero](https://github.com/ankane/pghero). Of pgHero's 65 capabilities, 60
are shipped and 5 are declined with a stated reason, and a test fails if that
count drifts from the code. See [Parity with pgHero](#parity-with-pghero).

- **Status:** v2.5.0. Tested against Postgres 14, 16, 17 and 18. No published
  image yet; build it from a clone.
- **License:** Apache-2.0.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Database permissions](#database-permissions)
- [Pages](#pages)
- [Safety model](#safety-model)
- [Parity with pgHero](#parity-with-pghero)
- [Documentation](#documentation)

How it is built and why — the tree, the package boundary, the five
declines, every deliberate difference from pgHero, and how to work on it —
is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Features

**Incident pages, polled every 5 seconds.** The fleet, one row per database
on the clock; each database as a tree on a clock: its tables, the
statements running on them and the sessions running those, with a lock chain
as one finding that names its root and offers Terminate, and a cursor that
pins the page to any moment of the last day; every statement on a scatter
of calls against mean time; and the wraparound horizon, replication
role, lag, standbys and slots.

**The catalog, on the same clock.** Tables, statements and indexes each as a
scatter of the whole population over its rows, and a page per table and per
statement; never-used and duplicate indexes with what covers them, bloat and
index suggestions from a button; every sequence measured against the ceiling
of the column it feeds, not its own; and Explain, which plans a pasted
statement and names the index that would serve it.

**History, with a store configured.** Statement statistics and relation sizes
captured every 5 minutes, never by resetting shared counters. Statement
numbers over any window of the last fourteen days; size history per
relation; the catalog stored on each capture, with hourly counters per table
and index.
A sample of every session not idle each 15 seconds, kept two days, and its
per-minute rollup kept fourteen; without a store the tree's clock holds the
last 15 minutes in memory. One health row per database
per minute, kept 90 days, drawn on Server and judged on the fleet.

**Operations.** HTTP basic auth over every route, a least-privilege role
documented below, a JSON audit record for every action, secret redaction on
every rendered query and audit line, and the operating system's light or dark
setting. No font CDN and no external requests from the browser.

[Pages](#pages) lists every route and what it holds.

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
| `pg_read_all_stats` | Other sessions' query text and state. Without it the tree says sessions are hidden and what to grant, and counts them without reading them. |
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
| `/` | The fleet: one row per database on the clock, its load split by class, its findings as tags, and "unreachable since" when the sampler cannot reach it. Reads the store only. | Every 15 s |
| `/db/<name>` | The tree on the clock: tables, the statements on them, the sessions running those; a lock chain as one finding with Terminate. | Every 5 s |
| `/db/<name>/queries` | Every statement on a scatter of calls against mean time, then the hottest on the clock. | Every 5 s |
| `/db/<name>/queries/<queryid>` | One statement on the clock: its numbers, load, tables and sessions; its plan in place. | Every 5 s |
| `/db/<name>/explain` | Plan a pasted statement. | On open |
| `/db/<name>/tables` | Every table on a scatter of rows written against size, then the rows; unowned sequences at the foot. | On open |
| `/db/<name>/indexes` | Every index on a scatter of scans against size; the list to drop; bloat and index suggestions from a button. | On open |
| `/db/<name>/tables/<relation>` | One table on the clock: load, dead rows, rows written and read, size; its statements, indexes and sequences. Analyze. | Every 5 s |
| `/db/<name>/server` | What the connection sees of the server, on the clock: connections against the limit, replication lag, WAL, transactions, transaction ID age; who holds the connections; the transactions open longest, with Terminate; the settings the pages depend on; recent terminations. Reset statistics. | Every 5 s |

Every page but Explain reads one clock: a window of up to 24 hours on a strip
you drag. A click pins a moment, and a pinned page offers no Terminate. Arrows step
a sample, `[` and `]` hop events, Esc returns to live, and in the tree arrows
walk and fold the rows. Times are clock times, never "ago". Under a database's
name, one line states its database, user, version, SSL and replica role.

## Safety model

pgops can terminate backends, reset statistics and write to a store. The
following holds regardless of how it is deployed.

Actions sit on a ladder. A deployment opts into the whole ladder or none of
it.

| Tier | Actions | Gate |
|---|---|---|
| 0 | Every read, and explaining a statement | Always available |
| 1 | Terminate one session. Analyze a table. | `PGOPS_ALLOW_ACTIONS=true`, plus an inline confirmation with a required reason |
| 2 | Terminate every long-running query. Reset query statistics. Reset database statistics. | Tier 1, plus the database name typed back and checked on the server |
| 3 | Schema changes | Not implemented, deliberately. See [CONTRIBUTING.md](CONTRIBUTING.md#the-five-declines). |

- **Without the flag, the action routes do not exist.** Every method answers
  404, byte-identical to an unknown path.
- **Action routes require `Content-Type: application/json`** and answer 415
  otherwise, which closes the CSRF path basic-auth credentials would
  otherwise open.
- **Kills are pinned to session identity, not pid.** A recycled pid returns
  `session-changed` and is left alone. The bulk kill is N guarded kills with
  per-session outcomes, never a sweep.
- **Every action is audited**, success or failure, as one JSON line to stdout
  and to `PGOPS_AUDIT_LOG`, naming the operator, target, reason and outcome.
- **Explain plans a statement and never runs it.** No `ANALYZE`; read-only
  transaction, always rolled back; a `;` cannot smuggle a second command.
- **Every rendered query and every audit line is redacted.**
- **No DDL against a monitored database.**
- **Actions on with auth off is an unauthenticated kill endpoint.** pgops
  warns on stderr and keeps serving, because some deployments authenticate at
  a proxy. If yours does not, set `PGOPS_USERNAME` and `PGOPS_PASSWORD`
  whenever you set `PGOPS_ALLOW_ACTIONS`.

Each of these is enforced by a test and documented at the code that
implements it; see [CONTRIBUTING.md](CONTRIBUTING.md).

Basic auth is a floor. For production, run pgops behind TLS and an
authenticating reverse proxy such as OAuth2 Proxy, an ALB authentication
rule, or Identity-Aware Proxy.

## Parity with pgHero

pgHero is the benchmark. [registry.ts](packages/checks/src/registry.ts) maps
each of pgHero 4.0.1's 65 capabilities onto a shipped check, action, series
or tool, naming its pgHero source file. A test reads this README and fails if
these numbers drift from what the registry computes.

**60 of the 65 are shipped, 5 are declined on purpose, and 0 remain**.

| State | Count |
|---|---:|
| Shipped | 60 |
| Declined on purpose | 5 |
| Remaining | 0 |

## Documentation

| Document | Content |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to work on it, and why it is shaped this way: setup, how a check flows, the rules the tests enforce, the design record, releasing, and a five-day guide for developers new to the codebase. |
| [CHANGELOG.md](CHANGELOG.md) | Every release, with the reasoning behind each change. |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability and what is in scope. |

Contributions are welcome; read CONTRIBUTING.md first. Report
vulnerabilities privately through GitHub's security reporting for this
repository, never as a public issue.

Licensed under [Apache-2.0](LICENSE).
