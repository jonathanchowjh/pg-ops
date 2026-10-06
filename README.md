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

How it is built and why — the four gates, the package boundary, the five
declines, every deliberate difference from pgHero, and how to work on it —
is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Features

**Incident pages, polled every 5 seconds.** Every configured database with
its worst verdict; a triage page with one band per gate, where an escalated
check expands into a panel carrying cause and remedy and a healthy one
collapses to a line; live sessions with connection sources and an SSL
breakdown; the lock wait graph as a tree, root blocker on top and cycles
marked; `pg_stat_statements` sortable three ways with a slow-query panel; and
the wraparound horizon, replication role, lag, standbys and slots.

**Hygiene pages, run on open.** Index hit rate and the missing, unused,
duplicate, invalid and bloated ones, with the exact `CREATE INDEX` to run;
every table in one SQL-sorted list with presets, and a page per relation;
database and relation sizes with growth; running vacuums with progress and
the last vacuum per table; every sequence measured against the ceiling of the
column it feeds, not its own; and Explain, which plans a pasted statement and
names the index that would serve it.

**History, with a store configured.** Statement statistics and relation sizes
captured every 5 minutes, never by resetting shared counters. 24-hour charts
of execution time and call volume, per database and per statement shape;
30-day size history per relation; hygiene findings cached on each capture and
summarised on triage with the age of the reading.

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
| `/db/<name>/tables` | Every table, sorted and searched in SQL: size, rows, dead rows, cache hit, last vacuum. Presets for biggest, needs vacuum, worst cache hit, unused. | On open |
| `/db/<name>/tables/<relation>` | One relation: 30 days of size, its indexes and which are unused, duplicate or invalid, its sequences, its transaction ID age. | On open |
| `/db/<name>/cleanup` | Wraparound horizon, replication role and lag, slots, server settings. | Every 5 s |
| `/db/<name>/cleanup/space` | Database size, size over 30 days, largest relations, 7-day growth. | On open |
| `/db/<name>/cleanup/space/<relation>` | One relation's size over 30 days. | On open |
| `/db/<name>/cleanup/maintenance` | Running vacuums with progress, last vacuum and analyze, transaction ID age. Analyze action. | On open |
| `/db/<name>/cleanup/sequences` | Every sequence against its column's ceiling. | On open |

Every page under `/db/<name>` carries a status line with the database, role,
version, SSL state and replica flag as the server reports them, and the age
of the data on screen — so a stalled poll climbs rather than freezing.

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
