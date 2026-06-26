# pgops

> The Postgres on-call toolkit for your terminal. Run it during the incident.

pgHero is your daily dashboard. pgBadger is your postmortem tool. pganalyze is the
enterprise SaaS. **pgops is what you run during the incident** — terminal-native,
action-shaped, free.

> **Status:** early development (v0). `locks` is the first vertical slice. The
> shared core (connection pool, snapshot exporter, theming) is built to carry the
> rest of the subcommands listed below.

## Install

```sh
# not published yet — run from source for now
git clone <repo> pg-ops && cd pg-ops
npm install
npm run build
npm start -- locks      # or: npm run dev -- locks
```

### Local development database

No Postgres handy? Start a throwaway one (Docker required):

```sh
npm run db:up           # start Postgres on :55432, print DATABASE_URL
npm run db:seed         # (optional) manufacture a lock chain to see locks light up
export DATABASE_URL='postgres://postgres:secret@localhost:55432/appdb'
npm run dev -- locks
npm run db:down         # tear it down
```

`db:up` preloads `pg_stat_statements` so the same DB is ready for the upcoming
`top` / `vacuum` subcommands. See [scripts/dev-db.sh](scripts/dev-db.sh).

## Use

```sh
pgops locks                       # connect via $DATABASE_URL
pgops locks -d "postgres://..."   # or an explicit connection string
pgops locks --snapshot            # one-shot: print the chain as markdown to stdout, then exit
```

Inside a view:

| Key | Action |
|-----|--------|
| `j` / `k` | move down / up |
| `/` | filter |
| `s` | snapshot the current view to a markdown file (prints the path) |
| `x` | kill the selected backend (confirm modal; requires `pg_signal_backend`) |
| `q` | quit |

## What it does (and what's planned)

| Subcommand | Workflow | Status |
|-----------|----------|--------|
| `locks` | Incident lock-chain — root blocker + waiter cascade, kill, snapshot | **done** |
| `top` | Live slow-query view over `pg_stat_statements` — sort, filter, snapshot | **done** |
| `vacuum` | Autovacuum doctor — bloat + wraparound horizon | planned |
| `slots` | Replication slot monitor + disk-exhaustion forecast | planned |
| `parts` | Partition manager (`pg_partman`) | planned |
| `review` | Pre-migration safety check (SQL parser) | planned |
| `explain` | EXPLAIN plans in a local browser view | planned |
| `events` | Cloud-event correlation (RDS / EKS) | planned |
| `mcp` | MCP server wrapping the same query layer for agents | planned |

## What it doesn't do

- It's not a daily dashboard — that's [pgHero](https://github.com/ankane/pghero).
- It's not an offline log report — that's [pgBadger](https://github.com/darold/pgbadger).
- It doesn't install extensions or manage roles. It tells you what's missing and
  prints the grant SQL; you (or your DBA) decide.
- It doesn't replace `psql`. Run pgops during the incident; stay in `psql` for
  ad-hoc queries.

## Safety

Read-only by default. The only write action today is `locks` → kill, which calls
`pg_terminate_backend()` behind a confirm modal and writes an audit-log entry. See
the security posture in the plan for the least-privilege role grants per subcommand.

## License

[Apache-2.0](./LICENSE)
