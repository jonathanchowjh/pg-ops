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
that problem. You don't need to know which subcommand you need — just run `pgops`.

pgops is **one app with nine tabs**, not nine programs. A tab strip sits under the
status bar on every screen, and every view is one keystroke away from every other:
press `3` for locks, `4` for `top`, `Esc` to come back to triage. A subcommand is
just a shortcut for opening on that tab — `pgops locks` is `pgops` with `3` already
pressed.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ pgops      localhost:55432/ap updated just j/k panels  ·  Enter drill in  ·  t top  ·  s snapshot│
│ triage     pdb                now            ·  q quit                                           │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
▸ 1 triage  2 sessions  3 locks  4 top  5 space  6 vacuum  7 replication  8 seq  9 system

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

> **Status:** v0.2 — the shell. The four built views (the cockpit, `locks`,
> `top`, `sessions`) are now one app: a nine-tab strip, global jump keys, and
> `Esc` back to triage from anywhere. Tabs `5`–`9` are registered and show a
> placeholder naming the phase that delivers them; everything else on the
> roadmap is reached by name or from `doctor` (see the table below).

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

Global — these work from **every** view, built or not:

| Key | Action |
|-----|--------|
| `1` – `9` | jump to a tab: `1` triage, `2` sessions, `3` locks, `4` top, `5` space, `6` vacuum, `7` replication, `8` seq, `9` system |
| `Tab` / `Shift-Tab` | cycle tabs forward / back, wrapping at both ends |
| `D` | the doctor report — hygiene findings that can wait (capital `D`; lowercase `d` does nothing) |
| `Esc` | back to triage |

Tabs `5`–`9` are registered but not built yet: pressing one shows a placeholder
naming the phase that delivers it. `0` is deliberately unbound.

Global keys go **inert** while a view owns the keyboard — while a kill
confirmation is open, or while you are typing a `/` filter. So `4` typed into a
filter is a `4`, not a jump, and a digit pressed at a confirm prompt cannot both
cancel the kill and change tabs. `Esc` dismisses the modal or filter first, and
only returns you to triage once nothing else is holding the keys.

The cockpit (`pgops`, no subcommand):

| Key | Action |
|-----|--------|
| `j` / `k` | move panel focus |
| `Enter` | drill into the focused panel's view (e.g. BLOCKED → `locks`) |
| `t` | jump straight to `top`, from any panel |
| `s` | snapshot the triage screen to a markdown file (prints the path) |
| `q` | quit |

Inside a list view (`locks`, `top`, `sessions`), on top of the global keys above:

| Key | Action | Views |
|-----|--------|-------|
| `j` / `k` | move down / up | all |
| `/` | filter | `top`, `sessions` |
| `o` | cycle sort order | `top`, `sessions` |
| `x` | kill the selected backend (confirm modal; requires `pg_signal_backend`) | `locks`, `sessions` |
| `s` | snapshot the current view to a markdown file (prints the path) | all |
| `q` | quit | all |

> **Changed in v0.2.** `Esc` used to be inert on a directly-invoked view and only
> meant "back" when you had drilled in from the cockpit. Now it always returns to
> triage, because there is always a triage to return to.

## What it does (and what's planned)

| Subcommand | Workflow | Status |
|-----------|----------|--------|
| *(bare)* `pgops`, or `pgops triage` | Triage cockpit — sessions, blocked, long-running, connections, health, drill-in navigation | **done** — **tab `1`** |
| `locks` | Incident lock-chain — root blocker + waiter cascade, kill, snapshot | **done** — **tab `3`** |
| `sessions` | Live sessions — spot & kill idle-in-transaction, sort, filter, snapshot | **done** — **tab `2`** |
| `top` | Live slow-query view over `pg_stat_statements` — sort, filter, snapshot | **done** — **tab `4`** |
| `space` | Table & index size, bloat, growth | planned — **tab `5`** |
| `vacuum` | Autovacuum doctor — bloat + wraparound horizon | planned — **tab `6`** (cockpit's HEALTH card shows a one-line wraparound verdict today) |
| `replication` | Replication lag and slot disk-exhaustion forecast | planned — **tab `7`** (cockpit's HEALTH card shows a one-line slot verdict today) |
| `seq` | Sequence exhaustion — integer PKs about to run out | planned — **tab `8`** |
| `system` | Host & instance metrics | planned — **tab `9`** |
| `doctor` | Hygiene report across every area — findings that can wait | planned — key `D`, no tab |
| `indexes` | Unused, duplicate, and invalid indexes | planned — no tab |
| `tables` | Per-table stats, missing indexes, dead tuples | planned — no tab |
| `config` | Settings review against the workload | planned — no tab |
| `explain` | EXPLAIN plans, from `Enter` on a `top` row | planned — no tab |
| `parts` | Partition manager (`pg_partman`) | planned — no tab |
| `review` | Pre-migration safety check (SQL parser) | planned — no tab |
| `events` | Cloud-event correlation (RDS / EKS) | planned — no tab |
| `mcp` | MCP server wrapping the same query layer for agents | planned — no tab |

**Why some areas have a digit and some don't.** A tab is a single-keystroke jump
during an incident, so it is reserved for areas that can escalate to *act now*.
`indexes`, `tables` and `config` never can — they are things you fix on a Tuesday,
not at 3am — so spending a key on them would waste the one thing the strip is
short of. They are still full subcommands, reachable by name or from `doctor`.
A tab is not a feature; it is a claim about urgency.

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
