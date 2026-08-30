# pgops

> The Postgres on-call console. Run it during the incident.

pgHero is your daily dashboard. pgBadger is your postmortem tool. pganalyze is the
enterprise SaaS. **pgops is what you run during the incident** — and unlike all
three, it can act, not only watch.

It is a small web console you deploy next to your databases. One URL, many
databases, no agent to install and nothing to schedule. You open it when the
pager goes off, it answers the questions a DBA runs from memory in the first five
minutes — who's connected and in what state, is anything blocked, what's running
long, how much connection headroom is left — and then, if you switch the safety
off, it can terminate the backend that is holding everything up.

```sh
docker build -t pgops .
docker run -e DATABASE_URL=postgres://… -p 8080:8080 pgops
```

## What's here

Five routes. That is the whole console today.

| Route | What it answers |
|---|---|
| `/` | **Overview** — every configured database, each with its worst verdict across the nine incident checks. "Is anything wrong anywhere?", nothing more. A check that could not *run* is reported separately from a check that ran and was fine; "we could not look" and "we looked and it's fine" must never render the same. |
| `/db/<name>` | **Triage** — one screen per database: connections and headroom, sessions by state, what's blocked, long-running queries, the lock picture, wraparound horizon, replication slots, and top queries. |
| `/db/<name>/sessions` | **Sessions** — live `pg_stat_activity`, and the one place an action can be taken (see Safety). |
| `/db/<name>/locks` | **Locks** — the wait graph: who is blocking whom, and the root blocker at the top of the chain. |
| `/db/<name>/queries` | **Queries** — `pg_stat_statements`, sortable by total, mean or calls. |

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

## Safety

pgops can terminate a backend. Everything below exists because of that.

- **Actions are off by default, and the route does not exist without the flag.**
  With `PGOPS_ALLOW_ACTIONS` unset, `POST /api/db/<name>/kill` answers **404**,
  not 403 — a 403 advertises a kill endpoint that is merely switched off. The
  gate is checked before the body is read and before any database is resolved,
  so a deployment without the flag is indistinguishable from a build without
  the file. The route also requires `Content-Type: application/json` and
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

pgops does not install extensions, manage roles, or run DDL. Give its role the
least privilege that works: `pg_read_all_stats` to see other sessions' queries,
and `pg_signal_backend` only if you intend to use `kill`. Without
`pg_signal_backend` the console still reads everything; a kill returns the
permission error Postgres gave, in the page, rather than a blank.

## Requirements

- **Postgres 14 or newer.** Tested against 14, 16, 17 and 18 in CI on every push.
- `pg_stat_statements` for the Queries route. Everything else works without it,
  and the route says what is missing rather than rendering empty.
- Docker, to build and run the image — there is no published one yet.

## Development

```sh
npm install
npm run db:up                      # throwaway Postgres on :55432, prints DATABASE_URL
npm run db:seed                    # optional: manufacture a lock chain to look at
export DATABASE_URL='postgres://postgres:secret@localhost:55432/appdb'
npm run --workspace @pgops/web dev # http://localhost:3000
npm run db:down                    # tear it down
```

`db:up` preloads `pg_stat_statements`, so the Queries route has something to
show. See [scripts/dev-db.sh](scripts/dev-db.sh).

The repo is two workspaces: `packages/checks`, a framework-free package holding
every SQL check and the one code path that issues `pg_terminate_backend`; and
`apps/web`, the Next.js console that renders them. The checks package knows
nothing about React.

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

There is no `pgops` binary in this release. A CLI returns in the next phase as
`pgops check --format json` — one-shot, exit-coded, meant for scripts and alert
pipelines rather than for watching — as its own package alongside
`packages/checks`. If you came here from the old README looking for `pgops
locks`, that is where it went.

Nothing was ever published to npm, so no installed version was taken away.

## License

[Apache-2.0](./LICENSE)
