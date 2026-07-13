# pgops

> The Postgres on-call toolkit for your terminal. Run it during the incident.

pgHero is your daily dashboard. pgBadger is your postmortem tool. pganalyze is the
enterprise SaaS. **pgops is what you run during the incident** — terminal-native,
action-shaped, free.

Type `pgops` and you get a live **triage cockpit**: one screen answering the
questions a DBA runs from memory in the first five minutes of an incident — who's
connected and in what state, is anything blocked, what's running long, how much
connection headroom is left, plus one-line wraparound and replication-slot health
verdicts. Every panel is a door: `Enter` drills into the view that can actually fix
that problem, `Esc` comes back. You don't need to know which subcommand you need —
just run `pgops`.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ pgops      localhost:55432/ap updated just j/k panels  ·  Enter drill in  ·  t top  ·  s snapshot│
│ triage     pdb                now            ·  q quit                                           │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
▸ SESSIONS ⚠ oldest idle-in-transaction 138s
    active                           3    2m 17s
    idle in transaction              1    2m 17s

  BLOCKED ⚠ 2 pid(s) waiting
    2 waiting · longest 2m 17s · suspect pid 89

  LONG-RUNNING ⚠
         90   2m 17s UPDATE users SET n = n + 1 WHERE id = 1
         91   2m 17s DELETE FROM users WHERE id = 1

  CONNECTIONS ✓
    5 / 100 used · 95 free

  HEALTH
    ✓ wraparound 0% of horizon
    ✓ slots 0 inactive
```

*(captured live against a seeded lock chain — see "Local development database" below)*

> **Status:** v0.1 — the first-five-minutes triage loop is complete. Bare `pgops`
> (the cockpit), `locks`, `top`, and `sessions` are all built, tested, and
> snapshot-capable. The wider roadmap (`vacuum`, `slots`, `parts`, `review`,
> `explain`, `events`, `mcp`) is still planned; the cockpit's HEALTH cards are
> their only v0.1 presence today (see the table below).

## Install

```sh
# not published to npm yet (still v0.0.0) — run from source for now
git clone <repo> pg-ops && cd pg-ops
npm install
npm run build
npm start                # the cockpit — or: npm run dev
npm start -- locks       # or: npm run dev -- locks
```

### Local development database

No Postgres handy? Start a throwaway one (Docker required):

```sh
npm run db:up           # start Postgres on :55432, print DATABASE_URL
npm run db:seed         # (optional) manufacture a lock chain — lights up the
                         # cockpit's SESSIONS/BLOCKED/LONG-RUNNING panels, and
                         # `locks`/`sessions` directly
export DATABASE_URL='postgres://postgres:secret@localhost:55432/appdb'
npm run dev              # the cockpit
npm run dev -- locks
npm run db:down          # tear it down
```

`db:up` preloads `pg_stat_statements` so the same DB is ready for `top` and the
upcoming `vacuum` subcommand. See [scripts/dev-db.sh](scripts/dev-db.sh).

## Use

```sh
pgops                              # the cockpit: whole-database triage in one screen
pgops --snapshot                   # print the triage screen as markdown and exit
pgops locks                        # lock-chain view (Enter from the BLOCKED panel)
pgops sessions                     # live sessions — spot & kill idle-in-transaction
pgops top                          # slow queries over pg_stat_statements
pgops <view> --snapshot            # any view, one-shot to stdout
pgops locks -d "postgres://..."    # explicit connection string (any view)
```

Every view connects via `$DATABASE_URL` unless you pass `-d`.

### Keys

The cockpit (`pgops`, no subcommand):

| Key | Action |
|-----|--------|
| `j` / `k` | move panel focus |
| `Enter` | drill into the focused panel's view (e.g. BLOCKED → `locks`) |
| `t` | jump straight to `top`, from any panel |
| `s` | snapshot the triage screen to a markdown file (prints the path) |
| `q` | quit |

Inside a drilled-in or directly-invoked view (`locks`, `top`, `sessions`):

| Key | Action | Views |
|-----|--------|-------|
| `j` / `k` | move down / up | all |
| `/` | filter | `top`, `sessions` |
| `o` | cycle sort order | `top`, `sessions` |
| `x` | kill the selected backend (confirm modal; requires `pg_signal_backend`) | `locks`, `sessions` |
| `s` | snapshot the current view to a markdown file (prints the path) | all |
| `Esc` | back to the cockpit — only when you drilled in from it; direct `pgops locks` etc. leaves `Esc` inert | all |
| `q` | quit | all |

## What it does (and what's planned)

| Subcommand | Workflow | Status |
|-----------|----------|--------|
| *(bare)* `pgops` | Triage cockpit — sessions, blocked, long-running, connections, health, drill-in navigation | **done** |
| `locks` | Incident lock-chain — root blocker + waiter cascade, kill, snapshot | **done** |
| `sessions` | Live sessions — spot & kill idle-in-transaction, sort, filter, snapshot | **done** |
| `top` | Live slow-query view over `pg_stat_statements` — sort, filter, snapshot | **done** |
| `vacuum` | Autovacuum doctor — bloat + wraparound horizon | planned (cockpit's HEALTH card shows a one-line wraparound verdict today) |
| `slots` | Replication slot monitor + disk-exhaustion forecast | planned (cockpit's HEALTH card shows a one-line slot verdict today) |
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

Read-only by default. The cockpit itself never writes — you act from the view you
drill into. The only write action today is `x` → kill (available in `locks` and
`sessions`), which goes through a single shared code path: a confirm modal, a
session-identity re-check (so a PID reused between selection and confirm is
refused rather than killed), a call to `pg_terminate_backend()`, and an audit-log
entry. See the security posture in the plan for the least-privilege role grants
per subcommand.

## License

[Apache-2.0](./LICENSE)
