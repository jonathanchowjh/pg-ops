# The DBA playbook — what a Postgres DBA actually does, by hand

This folder is the **manual baseline** for pgops. Before a subcommand automates a
ritual, a human does it in `psql`: run a query against a `pg_*` view, read the
result, make a decision (wait / kill / reindex / drop), repeat. Every pgops
subcommand is one of these rituals turned into a TUI.

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

pgops compresses the "observe → orient" beats (no remembering the CTE, no
eyeballing columns) so you spend your attention on "act."

## What a DBA reaches for first (order of this folder)

The numbering is the rough order of *urgency*, not the order you'll read them.
During a page you start at `00`, and the symptom tells you which file is next.

| File | Symptom that sends you here | The decision you're making | pgops subcommand |
|------|------------------------------|----------------------------|------------------|
| [`00-first-five-minutes.sql`](00-first-five-minutes.sql) | "The DB feels wrong." | Triage: where *is* the problem? | (none — the orientation that picks the next file) |
| [`01-lock-chain.sql`](01-lock-chain.sql) | "Writes are timing out." | Wait, or `pg_terminate_backend()` the blocker? | `pgops locks` |
| [`02-slow-queries.sql`](02-slow-queries.sql) | "Endpoint X is slow (APM said so)." | Add an index, rewrite the query, or accept it? | `pgops top` |
| [`03-autovacuum-bloat.sql`](03-autovacuum-bloat.sql) | "Tables are bloating / disk creeping up." | Tune autovacuum, manual VACUUM, or kill an idle txn? | `pgops vacuum` |
| [`04-replication-slots.sql`](04-replication-slots.sql) | "Replica lag alert / disk filling on primary." | Drop an orphan slot, or is the subscriber really alive? | `pgops slots` |
| [`05-migration-safety.sql`](05-migration-safety.sql) | "About to ship a schema change." | Is this migration safe to run on a live table? | `pgops review` |

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

The files never run these for you. You uncomment them deliberately, the same way
pgops puts every write behind a confirm modal and an audit-log entry.

## Where this maps in the plan

This folder is the hands-on companion to **Part 3 §4** of `docs/pgops_plan.pdf`
("The DBA workflows pgops accelerates"). The plan describes the rituals; this runs
them. The catalog views each query reads are catalogued in **Part 3 §2** of the
plan.
