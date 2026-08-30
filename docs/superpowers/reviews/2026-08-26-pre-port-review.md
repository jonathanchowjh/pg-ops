# Pre-port review — the query layer that becomes `packages/checks` (2026-08-26)

**Context.** pgops is moving from an Ink TUI to a Next.js web app (decision:
2026-08-26). The TUI is being deleted; the SQL and the pure transforms are being
extracted into `packages/checks` and reused by the web app and by a
`pgops capture` CLI.

**Why this review exists.** A defect in the UI layer dies with the UI layer. A
defect in the query layer gets carried into the registry and inherited by every
future consumer. This review sorts the current implementation on exactly that
line, so the port is a decision rather than an accident.

**Method.** Every finding below was verified by execution against a live
PostgreSQL 17 (`scripts/dev-db.sh`), not inferred from reading. Where a finding
is a calibration claim, the verifying query is included so it can be re-run.

**Status of the test suite at time of review:** 44 files / 363 tests passing,
`build`, `typecheck`, and `typecheck:test` all clean. None of the findings below
is caught by any existing test — see §D.

---

## A. Findings that port into `packages/checks`

### A1. The wraparound card measures the wrong horizon — **critical**

`home/query.ts`'s `WRAPAROUND_SQL` computes
`100 * max(age(datfrozenxid)) / autovacuum_freeze_max_age`, and
`home/model.ts`'s `verdictWraparound` returns `critical` at `>= 90`.

`autovacuum_freeze_max_age` (default 200,000,000) is the age at which Postgres
**forces a routine anti-wraparound autovacuum**. It is a maintenance trigger, not
a danger line; a busy database crosses it as normal operation. Actual wraparound
shutdown occurs near 2^31 ≈ 2,147,483,647.

Verified:

```sql
SELECT (0.90 * current_setting('autovacuum_freeze_max_age')::bigint)::bigint
         AS age_when_pgops_says_critical,
       round(100.0*(0.90*current_setting('autovacuum_freeze_max_age')::bigint)
             / 2147483647.0, 2) AS pct_of_real_horizon_at_that_point;

 age_when_pgops_says_critical | pct_of_real_horizon_at_that_point
                    180000000 |                              8.38
```

Two consequences, in opposite directions:

- **False criticals.** The card reports an emergency at 8.4% of the real horizon,
  on databases that are behaving exactly as designed.
- **No true signal.** A database at 2.0 billion — hours from refusing new
  transactions — renders as "1000% of horizon" on a scale whose critical
  threshold was already passed five times over. Nothing in pgops is calibrated
  to the failure it is named after.

pgHero's `transaction_id_danger` (capability #44) measures transactions
*remaining*, which is the actionable number.

**Fix.** Two independent measurements, not one ratio:

| number | meaning | class |
|---|---|---|
| `age(datfrozenxid) / autovacuum_freeze_max_age` | how close to a forced freeze vacuum | informational |
| `2147483647 - age(datfrozenxid)` | transactions until shutdown | the alarm |

Per-table (`age(relfrozenxid)`) is what makes it actionable — pgHero #44 — and is
already spec'd to the `vacuum` view.

### A2. The lock wait-graph produces false root blockers and flat cascades — **high**

Documented in full earlier this session; restated here because it ports.
`locks/query.ts` joins `pg_locks` to itself on
`(locktype, database, relation, transactionid)`.

**Defect 1 — omitted key columns.** The join ignores `page`, `tuple`, `classid`,
`objid`, and `objsubid`. Advisory locks are identified entirely by
`classid`/`objid`, so every advisory lock in a database matches every other one.
Verified with three sessions (A holds key 1, B holds key 2, C waits on key 2):

```
GROUND TRUTH (pg_blocking_pids)      pgops locks --snapshot
 108 holder-key-2   {}               ## Root blocker: pid 108   ← correct
 109 holder-key-1   {}               ## Root blocker: pid 109   ← FALSE
 110 waiter-key-2   {108}              - advise: consider waiting
```

An uninvolved session is named as a root blocker, on the one view with a kill key
bound to it. The same class of error applies to `tuple` locks on different rows
of one relation.

**Defect 2 — granted-only edges.** `WHERE NOT blocked.granted AND blocking.granted`
means an edge exists only when the blocker's own lock is granted. A *queued*
blocker can therefore never be an intermediate node. Verified with the classic
migration pile-up (long reader ← `ACCESS EXCLUSIVE` migration ← two readers):

```
truth:  117 ──> 119 ──> {120, 121}
pgops:  117 ──> {119, 120, 121}        (flat)
```

The migration — the amplifier turning one slow query into an outage — renders as
a peer of the sessions it is blocking. This is the exact shape the view exists to
show, and the basis of the README's claim to beat pgHero's one-hop view.

**Fix.** `pg_blocking_pids()`, which is aware of hard blocks, soft blocks (queue
position), parallel workers, and prepared transactions. It is **already in use**
40 lines away in `home/query.ts`'s `BLOCKED_SQL`; the two views currently
disagree about who is blocked.

Measured cost at 74 backends: 3.59 ms for the existing `BLOCKED_SQL` shape
(which calls the function twice per row), 2.59 ms for a `LATERAL` single-call
variant. Both negligible at any poll cadence; the performance objection does not
hold.

### A3. Connection headroom over-reports by the reserved pool — **medium**

`CONNECTIONS_SQL` computes `max_connections - count(client backends)` and ignores
`superuser_reserved_connections` (default 3) and `reserved_connections` (PG16+).

Verified:

```
 pgops_reports_free | actually_usable_by_app
                 96 |                     93
```

`verdictConnections` criticals below 10% headroom, so on a default
`max_connections = 100` the alarm fires three connections later than the pool an
ordinary application role can actually draw from. This is the single panel whose
purpose is to warn before `FATAL: too many connections`.

### A4. `top`'s sort keys do not match its truncation — **medium**

`TOP_SQL` ends `ORDER BY total_exec_time DESC LIMIT 100`. `top/stats.ts` then
sorts those 100 rows client-side by `total | mean | calls | cache`.

Verified: `pg_stat_statements.max = 5000` (the default). So the table holds up to
5,000 query shapes and the view considers 100 of them, chosen by a metric the
operator may not have selected.

`▼mean ms` therefore means *"the worst mean among the 100 highest-total"*. A
query that is catastrophic per call but rare — the twice-daily report that takes
four minutes — can sit at rank 3,000 by total time and is unreachable under
every sort the UI offers. The column header asserts something the query cannot
deliver.

**Fix.** Push the sort into SQL (the sort key and the `LIMIT` key must be the
same), or fetch a superset and document the bound. Whichever is chosen, the
bound must be visible — the current UI gives no indication that 4,900 shapes were
discarded.

### A5. `top` double-counts nested statements — **medium**

`pg_stat_statements` exposes a `toplevel` boolean (PG14+, verified present on the
review server). `TOP_SQL` does not filter on it, so when
`pg_stat_statements.track = all`, a PL/pgSQL function and every statement
executed inside it are counted as separate rows. Total time then sums past 100%
of wall-clock, and a function competes against its own internals for the top
slot.

### A6. The slots card is blind to two real failure modes — **medium**

`SLOTS_SQL`:

- `retained_bytes` is computed under `FILTER (WHERE NOT active)`. An **active**
  slot whose consumer is connected but not advancing — the ordinary logical
  replication stall — retains unbounded WAL and reports `0`. That is the failure
  mode that fills a primary's disk.
- `pg_current_wal_lsn()` raises `recovery is in progress` on a standby, so the
  entire card degrades to `n/a` on every replica. `pg_last_wal_receive_lsn()` is
  the recovery-safe call; a version-aware branch on `pg_is_in_recovery()` is
  needed.

### A7. Unbounded result sets on the two incident-critical queries — **low**

`top/query.ts` has `LIMIT 100`. `sessions/query.ts` and `locks/query.ts` have no
`LIMIT` at all. On a 2,000-connection instance mid-incident, `sessions` returns
2,000 rows each carrying up to `track_activity_query_size` (default 1 kB) of
query text, every 2 seconds.

The two queries with no cap are the two run when the database is already
struggling.

### A8. "Waiting for" is measured from `query_start` — **low**

Both `BLOCKED_SQL` (`longest_wait_secs`) and `locks/query.ts`
(`blocked_for_secs`) derive the wait from `query_start` / `xact_start`. A query
that ran productively for ten minutes and then blocked five seconds ago reports a
ten-minute wait.

`pg_stat_activity` exposes no wait-start timestamp, so this is the conventional
proxy and there is no better one available. The defect is the **label**, not the
measurement: it should read "query age" or "transaction age", not "waiting".

### A9. Idle sessions are ordered by a meaningless number — **low**

`sessions/model.ts`'s comparator falls back to `runningSecs` for every session
that is not idle-in-transaction. For an `idle` session, `runningSecs` is time
since its *last* query finished, so the idle group's ordering carries no
information. `inStateSecs` is the meaningful key.

### A10. The filter cannot match a pid — **low**

`prepareSessions` filters across `user`, `app`, `state`, and `query`. An operator
arriving from a log line, an alert, or another view almost always holds a pid and
nothing else.

### A11. Two implementations of "is this idle in transaction" — **low**

`home/query.ts`'s `mapSessionsPanel` uses `state.startsWith('idle in transaction')`.
`sessions/model.ts`'s `triageRank` enumerates both literals explicitly. One
concept, two implementations, no shared definition — the same divergence pattern
that produced A2's disagreement between `locks` and the cockpit.

---

## B. Findings that die with the TUI — do not spend effort

| finding | note |
|---|---|
| `useTerminalSize` uses `??` where it needs `\|\|` | A detached pty reports `columns: 0`, and `0 ?? 80` is `0`. Verified; renders the cockpit as a 4-column smear. Irrelevant after the port. |
| `StatusBar` clips its own hint list at 100 columns | `q quit` becomes invisible. Irrelevant after the port. |
| Duration formatting splits mid-screen | `oldest idle-in-transaction 339s` beside `5m 39s`. The helper (`core/format.ts`) is correct and ports; only the call sites that bypassed it were wrong. |
| `locks` TUI flattens the cascade the markdown renderer nests | A rendering choice in a renderer being deleted. Note that A2 must still be fixed — the *data* is wrong independently of how it is drawn. |

---

## C. What to preserve

These are the parts worth carrying across deliberately, because nobody
re-derives them by accident.

**`ui/usePoll.ts` — the polling semantics.** The hook itself is React and does
not port. Its three properties must:

1. An in-flight tick is **skipped, not queued**, so a slow database cannot be
   made slower by the tool observing it.
2. Freshness is stamped at poll **start** — when the database measured the
   numbers — not at resolve. A poll that took 5 s reads "updated 5s ago" the
   instant it lands, which is true.
3. An operator-requested refresh is re-armed into a **single slot** rather than
   dropped, so the poll fired straight after a kill cannot be swallowed by a
   scheduled poll that started before it.

`pgops capture` and the web app's refresh path both need all three.

**`core/kill.ts` — the PID-reuse guard.** The comparison and the side effect are
one statement against one snapshot:

```sql
SELECT CASE WHEN backend_start = $2::timestamptz
            THEN pg_terminate_backend(pid) ELSE NULL END
FROM pg_stat_activity WHERE pid = $1
```

Check-then-act in the client would reopen a TOCTOU window. The three-valued
return also distinguishes *terminated* / *refused* / *already gone*, which a
boolean cannot.

**`core/snapshot.ts` — `redactSecrets`.** Ports, and matters **more** on the web
than in a terminal: a screenshot needs a human to take it, a URL forwards itself.
The rules already handle doubled quotes, `E'…'` escapes, dollar-quoting, and
literals clipped by `track_activity_query_size`.

**Per-panel isolation in `fetchTriage`.** Each panel resolves to
`{ ok: false, error }` rather than failing the whole fetch. This is precisely the
right shape for a registry of 60 checks running against managed Postgres, where
any individual check may lack privileges.

---

## D. What this implies for the registry design

**D1. The port is a rewrite of six queries, not a move.** A1–A6 all require
changing SQL, not relocating it. This belongs in the implementation plan's
estimate rather than being discovered mid-port.

**D2. Thresholds must be data on the check, not constants in a transform.**
Six of the eleven porting findings are calibration errors: the SQL executes
correctly and the transform does what it says, but the constant it compares
against means something other than the label claims.

`home/model.ts` carries the comment *"Thresholds are the contract — do not adjust
without updating model.test.ts"*, and `model.test.ts` asserts the thresholds
match themselves. That is a change-detector, not a check. It passed 363 times
while `critical` meant 8.38% of the real horizon.

A check should therefore carry its threshold as data — value, unit, and the
sentence justifying it — and the real-Postgres test should assert the **boundary
condition in the database**, not the constant in the source.

**D3. There is no integration test anywhere in the repo.** All 363 tests are
pure-function or `ink-testing-library` renders; nine files mock the connection
layer. Every SQL string in the project is unverified, which is why A1–A6 survived
to now. `packages/checks` is where that gap gets closed, and it is the reason the
package must not depend on Next or React — an integration suite that drags a
frontend toolchain into scope is an integration suite that gets skipped.

**D4. Units belong in the type.** A8 is a labelling error that a `Seconds`
branded type or an explicit `{ value, unit }` shape would have made visible at
the call site.
