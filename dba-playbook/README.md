# The DBA playbook — what a Postgres DBA actually does, by hand

**These are standalone `psql` playbooks. They do not depend on the pgops
console, or on pgops at all** — every file is plain SQL against `pg_catalog`
that you paste into a `psql` session against the database you are looking at.
The cross-references to console routes are a convenience, not a requirement.

This folder is the **manual baseline** for pgops. Before a tool automates a
ritual, a human does it in `psql`: run a query against a `pg_*` view, read the
result, make a decision (wait / kill / reindex / drop), repeat. The console's
five routes are some of these rituals turned into pages — and, as the table
below records, only some.

Read it to answer: *"What would I type if pgops didn't exist?"* Each file is real
SQL you can paste into `psql` and watch work.

## The one thing to understand first

A DBA's on-call job is **catalog introspection under time pressure**. Postgres
exposes its own live internal state as ordinary tables and views in the
`pg_catalog` schema — locks, sessions, query stats, vacuum state, replication
position. You don't attach a debugger; you run `SELECT`s. The skill is knowing
*which view answers which question*, and what decision the answer implies.

So the loop is always the same three beats:

```
  observe  →  SELECT ... FROM pg_<something>
  orient   →  is this normal? who/what is the culprit?
  act      →  wait it out  |  kill a backend  |  change a setting  |  escalate
```

The pgops console compresses the "observe → orient" beats (no remembering the
CTE, no eyeballing columns) so you spend your attention on "act." It compresses
them for the rituals it covers; the rest of this folder is still hand work.

## What a DBA reaches for first (order of this folder)

The numbering is the rough order of *urgency*, not the order you'll read them.
During a page you start at `00`, and the symptom tells you which file is next.

The last column is the console route that answers the same question, where one
exists. It often does not, and the blanks are the honest part of this table:
the console is five routes, not a subcommand per file.

| File | Symptom that sends you here | The decision you're making | Console route |
|------|------------------------------|----------------------------|---------------|
| [`00-first-five-minutes.sql`](00-first-five-minutes.sql) | "The DB feels wrong." | Triage: where *is* the problem? | `/db/<name>` — the Triage page answers most of these at a glance |
| [`01-lock-chain.sql`](01-lock-chain.sql) | "Writes are timing out." | Wait, or `pg_terminate_backend()` the blocker? | `/db/<name>/locks` for the wait graph; the terminate itself lives on `/db/<name>/sessions` |
| [`02-slow-queries.sql`](02-slow-queries.sql) | "Endpoint X is slow (APM said so)." | Add an index, rewrite the query, or accept it? | `/db/<name>/queries` — the same `pg_stat_statements` rows, no EXPLAIN view |
| [`03-autovacuum-bloat.sql`](03-autovacuum-bloat.sql) | "Tables are bloating / disk creeping up." | Tune autovacuum, manual VACUUM, or kill an idle txn? | Wraparound only, on `/db/<name>`. Nothing for bloat — this file is the tool |
| [`04-replication-slots.sql`](04-replication-slots.sql) | "Replica lag alert / disk filling on primary." | Drop an orphan slot, or is the subscriber really alive? | The "Replication slots" panel on `/db/<name>` |
| [`05-migration-safety.sql`](05-migration-safety.sql) | "About to ship a schema change." | Is this migration safe to run on a live table? | None. The console reads a live database, not your migration files |

## How to run these

Spin up the throwaway dev Postgres this repo already uses (Docker required):

```sh
npm run db:up                 # Postgres 17 on :55432, pg_stat_statements preloaded
export DATABASE_URL='postgres://postgres:secret@localhost:55432/appdb'
```

Then open a shell into it and paste any file (or chunks of it):

```sh
npm run db:psql               # psql inside the container
# or, from your host if you have psql:
psql "$DATABASE_URL" -f dba-playbook/01-lock-chain.sql
```

Some files need a *scenario* to observe (you can't see a lock chain without
contention). [`reproduce.sh`](reproduce.sh) manufactures each one. The lock-chain
scenario reuses this repo's existing seeder:

```sh
npm run db:seed               # holds a real lock chain open (Ctrl-C to release)
# in a second terminal, run 01-lock-chain.sql against the same DB
```

When you're done:

```sh
npm run db:down
```

## A note on safety (read before pasting into production)

Everything in `00`–`04` is **read-only** — plain `SELECT`s against catalog views.
They're safe to run anywhere, including production, and they're cheap.

The only **write** actions are called out explicitly and commented OUT:

- `pg_terminate_backend(pid)` in `01` — kills a session. Irreversible.
- `pg_drop_replication_slot(name)` in `04` — drops a slot. Irreversible, and
  dropping a *live* slot breaks replication.
- `VACUUM` / `ALTER TABLE` in `03` / `05` — take locks; the comments say which.

The files never run these for you. You uncomment them deliberately — the same
deliberateness the console asks for around its one write action, which is off
unless the deployment sets `PGOPS_ALLOW_ACTIONS=true`, requires a typed
free-text reason and a second click on the row itself, and is audited whether
it succeeds or fails.

## Further reading

[docs/postgres-for-pgops-deep-dive.pdf](../docs/postgres-for-pgops-deep-dive.pdf)
is the companion to this folder: the planner, WAL, MVCC/vacuum and lock layers
these queries read from, explained with a `psql` lab for each. The deep dive
describes the mechanisms; this folder runs the rituals against them.
