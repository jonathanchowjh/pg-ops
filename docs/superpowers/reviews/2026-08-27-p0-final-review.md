# Final whole-branch review — `feat/web-console` (ec0560a..0df017e, 36 commits)

**Counts: 0 Critical · 5 Important · 5 Minor**

**Verdict: approve the branch, with I1, I2 and I3 fixed before P1 starts.**
Nothing here blocks P0 itself — no shipping code consumes `packages/checks` yet,
so none of these findings can hurt a user today. All three of I1–I3 are contracts
that P1 will build directly on top of, and every one of them is cheaper to fix
now than after a consumer exists.

---

## 0. Verification performed (not read — executed)

| Claim | How verified | Result |
|---|---|---|
| `npm test` green | ran it | 54 files, 470 tests, pass, 7.2 s |
| `npm run typecheck` | ran it | clean |
| `npm run typecheck:test` | ran it | clean |
| `npm run --workspace @pgops/checks typecheck` | ran it | clean |
| Integration suite green | ran `npm run test:int` (PG17, testcontainers, own throwaway container) | 9 files, 37 tests, pass, 17.1 s |
| Every column's declared TS type matches the wire | started a throwaway PG17 container, executed all nine checks' real SQL, dumped `typeof` per column | **all nine match exactly** — see §2 |
| `count(*) OVER ()::int` casts the window function (not something else) | direct probe | `typeof === 'number'`, value 7 |
| The lexicographic trap is real | `SELECT x::text AS x FROM (VALUES (5),(20)) ORDER BY x` | `["20","5"]` — confirmed |
| pg_stat_statements normalises integer literals | direct probe | `SELECT 201..205` → **one** shape `SELECT $1`, calls=5 |
| pg_stat_statements is cluster-wide | direct probe from db `probe` | saw `CREATE DATABASE "test"` issued against another database |
| `runCheck` with a missing `opts` argument | compiled under the package's own strict settings, then ran it | **compiles clean, fails at runtime** — see I1 |
| Audit-log contamination | inspected `~/.pgops/audit.log` before/after `npm run test:int` | **reproduced — four new fabricated `kill` records** |

The developer's `pgops-dev` container (port 55432) was not connected to, stopped,
or otherwise touched. No git write commands were run. No repository file was modified.

---

## 1. Charge (b): the hunt for a fourth instance — negative result, established by execution

**I found no fourth instance, and I am confident about that rather than merely
unable to find one.** The reason for the confidence is that I did not do this by
reading. I started a real PostgreSQL 17, executed the actual SQL of all nine
checks, and dumped the JavaScript `typeof` of every column of every result row.
That closes both halves of the defect class at once: a `::text`-cast column
sorted lexicographically would have to *be* a text column, and a string that
should have been a number would show up as `"string"` where the row interface
declares `number`.

```
connections   {"max_connections":"number","reserved":"number","used":"number"}
wraparound    {"database":"string","xact_age":"number","freeze_max_age":"number"}
blocked       {"blocked":"number","longest_query_age_secs":null,"suspect_pid":null}
sessions      {...,"in_state_secs":"string","query_age_secs":"string","total_matching":"number"}
sessionStates {"state":"string","sessions":"number","longest_secs":"string"}
longRunning   {"pid":"number","running_secs":"string","query":"string","total_matching":"number"}
queryStats    {"queryid":"string","calls":"string","total_ms":"number","mean_ms":"number",
               "stddev_ms":"number","rows":"string","shared_blks_hit":"string",
               "shared_blks_read":"string","total_shapes":"number","requested_sort":"string"}
slots         {"slot_name":"string","active":"boolean","retained_bytes":null}
```

Every one of these matches its declared `*Row` interface. There is no site in the
package where a string is fed to arithmetic or to a relational comparison that
expects a number.

Two specific things worth recording, because reading alone leaves them open:

- **`count(*) OVER ()::int` really does cast the window function**, not the empty
  window spec. Probe: `typeof === 'number'`. This matters more than it looks,
  because had it been wrong the tests would *still* have passed —
  `truncated: totalMatching > rows.length` coerces a numeric string in `>`, so
  `"501" > 500` is `true`. The integration suite could not have caught a broken
  cast here. It is correct, but it is correct-and-unguarded.
- **Every ORDER BY in the package resolves to a numeric source.** Enumerated by
  hand across all nine files: `locks` (`a.xact_start`, qualified → input column),
  `sessions` (raw `query_start`/`state_change`/`pid`), `sessionStates`
  (`ORDER BY sessions` where `sessions` is the `count(*)::int` output alias —
  an integer output column, so numeric), `long-running` (`query_start`),
  `wraparound` (`age(datfrozenxid)`), `blocked` (an interval inside `array_agg`),
  `slots` (`retained_bytes_num`, distinct from the `retained_bytes` text alias —
  and note `\b` after `retained_bytes` correctly refuses to match inside
  `retained_bytes_num`, so the guard does not false-positive here either),
  `query-stats` (every `ORDER` entry `v.`-qualified), `connections` (none).

Two blind spots in `boundaries.test.ts`'s guard that the disclosed limit does not
name. Neither has an instance today; both are worth a line of comment rather than
code:

- It only recognises `::text`. `::varchar`, `::char(n)`, and `to_char(...)`
  produce the same lexicographic hazard and are invisible to it.
- It only scans backtick template literals containing `SELECT`. A SQL string
  assembled with `+` or held in a single-quoted string is not scanned.

---

## 2. Important findings

### I1 — `runCheck` lets you omit an options-bearing check's options, and the mistake compiles

`run.ts:53-57`:

```ts
export async function runCheck<Row, Data, Opts = void>(
  ctx: CheckContext,
  check: Check<Row, Data, Opts>,
  opts: Opts = undefined as Opts,
): Promise<CheckResult<Data>>
```

A parameter with a default is optional. So for the three checks whose `Opts` is a
real object — `sessions`, `longRunning`, `queryStats` — `runCheck(ctx, check)`
typechecks, and `check.sql(undefined)` then dereferences `undefined`.

**Verified both halves.** Compiled a two-line consumer under exactly the
package's own compiler settings (`strict`, `noUncheckedIndexedAccess`,
`NodeNext`): `tsc --noEmit` exits 0. Then ran it:

```
sessions    : {"ok":false,"reason":"error","message":"Cannot read properties of undefined (reading 'limit')"}
queryStats  : {"ok":false,"reason":"error","message":"Cannot read properties of undefined (reading 'sort')"}
longRunning : {"ok":false,"reason":"error","message":"Cannot read properties of undefined (reading 'minSecs')"}
```

**Concrete failure.** A P1 page renders `/db/x/sessions`. The developer writes
`runCheck(ctx, sessions)` — which is exactly what they will write, because it is
what every other call site in the package looks like (`runCheck(ctx, blocked)`,
`runCheck(ctx, locks)`, `runCheck(ctx, connections)`). It compiles, CI is green,
and the sessions panel renders the package's generic failure state carrying the
text "Cannot read properties of undefined (reading 'limit')" — during the
incident the page exists for. `runCheck`'s never-reject contract holds, which is
precisely what turns a loud crash into a quiet, misattributed one: the operator
sees a check reporting failure and has every reason to suspect the database.

This is the promised re-examination of the Task 1 deferred item ("`as never` casts
trade type safety for generic variance; re-examine once real Check
implementations land"). The real implementations have landed and the trade did
not pay. The `as never` casts are a separate, harmless thing; the defect is the
`= undefined as Opts` default, which erases the difference between "this check
takes no options" and "this check takes options and you forgot them".

**Fix shape** (not applied — review only): two overloads, so `Opts = void`
permits two arguments and any other `Opts` requires three. Roughly:

```ts
export async function runCheck<Row, Data>(ctx: CheckContext, check: Check<Row, Data, void>): Promise<CheckResult<Data>>;
export async function runCheck<Row, Data, Opts>(ctx: CheckContext, check: Check<Row, Data, Opts>, opts: Opts): Promise<CheckResult<Data>>;
```

A regression test is cheap and belongs in `run.test.ts` alongside the existing
never-rejects tests.

---

### I2 — `queryStats` is cluster-wide and carries no database identity, on a per-database console

`pg_stat_statements` is a **cluster-wide** view. I proved this rather than
asserting it: connected to database `probe` on a fresh container and read back
`CREATE DATABASE "test"` — a statement issued against a different database
entirely.

`query-stats.ts`'s SQL is:

```sql
WITH toplevel_stats AS MATERIALIZED (SELECT * FROM pg_stat_statements WHERE toplevel)
```

No `dbid` predicate, and `QueryStatRow` carries no `dbid` or `datname` column.
So the check returns the top N statements *of the whole instance*, ranked
together, with nothing on any row saying which database a statement came from.

Three separate things this breaks, each owned by a different task and therefore
invisible to every per-task review:

1. **The spec's routes.** Spec §6.2: `/db/[name]/queries — pg_stat_statements +
   trend charts`. A per-database page. On a shared instance holding `app_prod`
   and `app_staging`, the `app_prod` queries page ranks staging's batch jobs
   against production's, unlabelled, and an operator has no way to tell.
2. **The spec's persistence model.** Spec §4.2:
   `pgops.queries (id, database_id, queryid, query, ...)` and
   `pgops.query_stats (database_id, query_id, captured_at, ...)`. Both keyed on
   `database_id`. P3's capture job cannot populate that column from what this
   check returns, because the check does not return it. That is a schema the
   spec — the binding authority — already committed to.
3. **The parity claim.** `registry.ts` maps #14 `query_stats` → `queryStats`.
   pgHero's own `query_stats` joins `pg_database ON pg_database.oid =
   pg_stat_statements.dbid` and filters to the current database. The registry
   file is scrupulous about exactly this class of divergence elsewhere — it
   spends thirteen lines on why #5 `total_connections` maps despite a
   client-backend scoping difference, and demotes #4 to `planned` rather than
   claim a near-miss. By its own standard, #14's database scope is a bigger
   divergence than #5's and it is unstated.

I want to be fair to the counter-argument, because the package makes it
explicitly for other checks. `vitest.config.ts` argues at length that
`pg_stat_activity`, `pg_locks` and the lock manager are cluster-wide and that
checks reading them *correctly* do not filter by `datname`, because
`max_connections` and the lock manager are cluster-wide too. That argument is
right for those checks. It does not carry here, for two reasons: those views'
rows carry a `pid` and could carry a `datname`, so nothing is *hidden* from the
operator; and no competitor scopes them narrowly. Here the rows carry no
database identity at all, and pgHero scopes narrowly.

**Minimum acceptable resolution** is not necessarily a filter — it is a decision,
written down. Either add `dbid`/`datname` to the row and let the consumer scope,
or filter to `current_database()` and say so, or keep it cluster-wide and record
that ruling in `registry.ts` the way #4 and #5 are recorded. Shipping it
undecided is what makes it a finding.

---

### I3 — `locks.verdict` escalates on a quantity the file's own doc says is not the quantity

`locks.ts:275`:

```ts
const oldest = Math.max(...d.roots.map((r) => r.xactAgeSecs ?? 0));
const crit = t.find((x) => x.level === 'critical');
if (crit && oldest >= crit.value) return { level: 'critical', note };
```

`d.roots` are the **root blockers** — by definition the sessions that are *not*
waiting. And `Waiter.xactAgeSecs` is documented three lines from its own
declaration as: *"Age of this session's transaction. NOT time spent waiting — see
A8."* The threshold it is compared against reads:

> `{ level: 'critical', value: 60, unit: 'seconds', because: 'a minute of
> blocking outlives most application timeouts, so the waiters are already being
> retried and the pile-up is compounding' }`

So the check escalates on how long the *blocker* has had a transaction open, and
justifies the escalation by how long the *waiters* have been waiting. Those are
different numbers, and the relationship between them is one-directional: a lock
is held for the life of its transaction, so blocking duration is always ≤ the
blocker's transaction age. The error is therefore always in the false-positive
direction.

**Concrete failure.** A nightly ETL job holds one transaction open for 40 minutes
doing ordinary work. At minute 40 it takes a lock that blocks one short `SELECT`
for 200 ms. `locks` reports `critical — 1 session(s) blocked` on the incident
triage page. On the same instance at the same instant, `blocked` — which measures
the *blocked* session's own query age — reports `warn`. Two incident-class checks
rendered side by side on `/db/[name]` disagree by two severity levels about the
same event, and the louder one is the one measuring the wrong thing. An operator
paged by this looks for a lock storm and finds a 200 ms wait.

The fix is a one-line change of subject: take the max over the *waiters* (which
`countDistinctWaiters` already walks), not over the roots. That is still a proxy —
A8 established that Postgres exposes no wait-start timestamp — but it is the same
proxy `blocked` already uses, which makes the two checks agree instead of
contradicting each other.

Compounding this: **`locks.verdict` has no test at all.** Not a unit test, not an
integration test. `locks.int.test.ts` is thorough about the graph (advisory-lock
false blockers, queued-blocker nesting, `totalWaiters`) and never calls `verdict`.
Grep confirms zero references to `locks.verdict` anywhere in the repository. See
I5.

---

### I5 — the spec's binding boundary-test rule is unmet for half the threshold-bearing checks

Spec §9 (binding, and the spec outranks the plan):

> **Every threshold, boundary** — Construct database state just below and just
> above each `Threshold.value`; assert the verdict flips exactly there. **This is
> what would have caught A1 — a test that asserts a constant equals itself
> cannot.**

Audit of the six checks carrying thresholds:

| check | boundary coverage |
|---|---|
| `connections` | **full** — `at(warnAt)`, `at(warnAt-1)`, `at(critAt)`, `at(critAt-1)`; textbook |
| `wraparound` | **full** — `at(remaining)` sweep |
| `slots` | **full** — `at(bytes)` sweep |
| `blocked` | partial — asserts at `critAt` and at an arbitrary 5; never just below `critAt` |
| `longRunning` | partial — asserts only `warnAt + 1` and `critAt + 1`; never *at* or below |
| `locks` | **none** |
| `sessionStates` | **none** |

`longRunning`'s gap is the one that bites, and it is the other half of the
deferred Task 10 item about `>=` vs `>`. `longRunning` uses strict `>`; `blocked`,
`locks` and `slots` use `>=`; and `sessionStates` uses **both inside one
function** — `s >= crit.value` for critical but `s > warn.value` for warn
(`sessions.ts:281-283`). Nothing anywhere pins any of these. A future edit
normalising them all to `>=` — a change any reviewer would wave through as
tidying — flips `longRunning` at exactly 60 s and 300 s and no test says a word.

`locks` and `sessionStates` having *zero* verdict coverage is the sharper problem,
because `locks`' untested verdict is I3: the one that measures the wrong thing.
The spec names boundary tests as the countermeasure for exactly the A1 class of
defect this entire branch exists to repair, and the two checks that skipped it are
the two where a calibration error is currently sitting.

---

### I4 — the integration suite writes real kill records into the operator's real audit log

`audit.ts:26`: `process.env.PGOPS_AUDIT_LOG ?? join(homedir(), '.pgops', 'audit.log')`.
`killBackend` always audits. `kill.int.test.ts` performs four real kill attempts.
Nothing in `vitest.config.ts`, the integration project, or the test file sets
`PGOPS_AUDIT_LOG`.

**Reproduced, not theorised.** I inspected `~/.pgops/audit.log`, ran
`npm run test:int`, and inspected it again. Four new records:

```json
{"timestamp":"2026-08-27T03:17:37.340Z","user":"pgops-demo-operator@workstn","action":"kill",
 "subcommand":"sessions","target":{"pid":678,"backend_start":"2026-08-27 03:17:37.334381+00"},
 "reason":"test","result":"terminated"}
```

There were already earlier ones from the Task 13 development run (02:49:18). The
file is 11 KB and part of it is now test noise.

Why this is more than housekeeping: `audit.ts`'s own header calls this file *"the
mitigation for the 'malicious operator' threat — we don't add new attack surface,
we make the existing power traceable."* A record reading `action: kill`,
`subcommand: sessions`, `result: terminated`, against a real pid, signed with the
real username and hostname, is byte-for-byte what a genuine kill writes. The only
thing distinguishing it is the free-text `reason: "test"` — which a real operator
is free to type. Anyone auditing that file after an incident is reading fabricated
entries alongside real ones with no reliable way to separate them. The contrast
makes the omission clear: `audit.test.ts` correctly uses `mkdtemp` for every
single one of its writes. Only the integration path forgot.

One line in `vitest.config.ts`'s integration project closes it:
`env: { PGOPS_AUDIT_LOG: <tmpdir path> }`.

---

## 3. Minor findings

**M1 — `main`/`exports` point at a `dist/` that CI never builds.**
`packages/checks/package.json` declares `main: ./dist/index.js`,
`types: ./dist/index.d.ts`, `exports: { ".": "./dist/index.js" }`. The workspace
`build` script exists but no CI job runs it; the `static` job runs three
typechecks and `npm test`, all `--noEmit`. Meanwhile a stale hand-built `dist/`
sits on disk locally (gitignored, so not a branch defect) containing only
`index/registry/run/types` — its `index.js` still carries the comment *"`redactSecrets`
is Task 5's module and does not exist yet."* The first P1 file that writes
`import { CHECKS } from '@pgops/checks'` gets that stale barrel locally and
`MODULE_NOT_FOUND` in CI. This is the same shape as Ruling 46's already-caught
bug — a config pointing at something nothing produces — and it should be closed
the same way: a `- run: npm run --workspace @pgops/checks build` step, pinned by
`boundaries.test.ts` exactly as the typecheck step already is. Verified nothing
imports the package by name today, which is the only reason this is Minor.

**M2 — `blocked.suspectPid` cannot be handed to `killBackend`.**
`blocked.ts`'s comment says `suspect_pid` *"is the pid an operator is invited to
kill (Task 13 builds exactly that action)"*. But `KillTarget` requires
`backendStart` for the PID-reuse guard, and `BlockedData` returns only
`{ count, longestQueryAgeSecs, suspectPid }` — no `backendStart`. A consumer
passing `backendStart: null` gets `backend_start = NULL` → `NULL` → the CASE
falls to `ELSE NULL` → `session-changed`. So it **fails closed**, which is the
right direction and why this is Minor rather than Important. The workable path
exists — `blocked.suspectPid` → `runCheck(ctx, sessions, { pid })` →
`backendStart` → `killBackend`, and `SessionOpts.pid` was added in a fix round
for precisely this — but it is nowhere written down at the seam where a P1
developer will hit it. One sentence on `BlockedData.suspectPid`.

**M3 — `harness.ts:35-37` `admin.end()` in `finally` lacks the `.catch(() => {})`
its two siblings have.** (Deferred Task 2 item.) The failure it permits, named
concretely: `CREATE DATABASE` succeeds, `admin.end()` then throws (pg's
`Pool.end()` rejects on a double-end or a client error during graceful
shutdown), `withPostgres` rejects out of the `finally` — and the cleanup block
that would `DROP DATABASE` sits *after* that try/finally and never runs. The
just-created database leaks into the one container the whole run now shares, where
`wraparound`'s `FROM pg_database` scan will see it. Low probability; genuinely
inconsistent with the discipline stated three lines away.

**M4 — the query-stats truncation test's stated rationale is false, and its real
margin is accidental.** (Deferred Task 11 item, now settled by execution.) The
comment claims `SELECT 201..205` gives *"five distinct one-literal shapes."* I ran
it: pg_stat_statements normalises integer literals, so all five collapse to **one**
shape, `SELECT $1`, `calls = 5`. The assertion `totalShapes > 2` passes for a
reason nobody wrote down — and it is not the one the deferral note guessed either.
It is not just the harness's own setup statements: `pg_stat_statements` is
cluster-wide, so the baseline includes `CREATE DATABASE`, testcontainers'
readiness probe `SELECT $1 FROM pg_database WHERE datname = $2`, and every sibling
integration file's statements. My probe saw 6 toplevel shapes where the fixture
intended 5 and actually contributed 1. The assertion is valid; nothing anyone
could reasonably do to `harness.ts` would obviously break it. But this test's own
history is *"it used to pass without ever exercising truncation at all"*, and it
is once again resting on incidental state rather than on its own fixture. Two
distinct statement shapes (`SELECT 'a'` / `SELECT 1.5` / a real table query)
would make the fixture mean what the comment says.

**M5 — `long-running`'s tests live in `blocked.test.ts` / `blocked.int.test.ts`.**
Against the plan's File Structure (`test/*.int.test.ts` — one per check). Purely
a discoverability cost, and it is the reason I3's neighbour, `longRunning.verdict`,
is easy to overlook when auditing coverage. Brief-compliant; worth normalising
once, package-wide, rather than piecemeal.

---

## 4. Charge (a): verdict on every deferred item

### Correctly deferred — and here is why it does not matter

**Task 2 — integration project omits `environment: 'node'`.** Correctly deferred.
`node` is Vitest's default; the two projects are behaviourally identical. Nothing
to act on.

**Task 4 — report cites `registry.ts:54` for #7, actual line 132.** Correctly
deferred. Report-only; the claim itself is right, and line numbers in a report
are stale the moment the file is edited anyway.

**Task 5 — `redact.test.ts:145` double quotes.** Correctly deferred. No lint
config exists in the repo, so there is no rule to violate.

**Task 7 — no live assertion that `pctToForcedVacuum` is finite.** Correctly
deferred, and I can now close it stronger than "probably fine." I executed
`wraparound`'s real SQL against PG17 and read the wire types:
`{"xact_age":"number","freeze_max_age":"number"}`. `freeze_max_age` arrives as a
genuine `number` (200000000), not `null` and not a string, so
`Math.round(100 * xactAge / freeze_max_age)` cannot produce `NaN` — the `::int`
cast and the `current_setting` NULL-fold both work as claimed. The suggested
one-line assertion would be a fine addition; its absence permits no failure.

**Task 9 — no test asserts `truncated === false` on a pid lookup.** Correctly
deferred. Provable rather than merely plausible: `count(*) OVER ()` is computed
over rows matching `WHERE`, and `WHERE` includes `pid = $2`; `pid` is unique, so
at most one row matches, so `total_matching ≤ 1` and `rows.length` equals it, so
`totalMatching > rows.length` is unreachable. The path cannot be wrong.

**Task 11 — the cross-role test's two `DROP ROLE` calls in `finally` are
unguarded.** Correctly deferred, and the blast radius is smaller than the note
assumed. The role names carry a per-test random suffix
(`q_owner_${Math.random().toString(36).slice(2,10)}`), and the container is
created and destroyed per `vitest run`. So a leaked role cannot collide with
anything: it dies with the container minutes later, and no second run shares it.
Zero impact.

**Task 12 — the scratch-container leak reproduction was deleted, not checked in.**
Correctly deferred. This is a process observation about how a fix was proved, not
a property of the code. The behaviour it proved is now covered by
`harness.int.test.ts`'s non-interference test and by the fact that the suite runs
clean end to end, which I confirmed.

### These actually matter — elevated to findings

**Task 1 — `run.ts`'s `as never` casts, "re-examine once real Check
implementations land."** → **I1.** The implementations landed and the re-examination
fails. The `as never` casts themselves are harmless; the `opts: Opts = undefined
as Opts` default beside them is not. Concrete failure, compiler and runtime proof
in §I1.

**Task 10 — `>=` vs `>` boundary semantics differ; both checks' tests live in
`blocked.*.test.ts`.** → **I5** and **M5**. The operator inconsistency is real and,
more importantly, *untested at the flip point* — `longRunning` is only ever
asserted at `warnAt + 1` and `critAt + 1`, so the very divergence the note
identified has no test pinning it. This is a violation of a binding spec rule
(§9), not a style preference, which is why I is the right bucket. The file-placement
half is genuinely cosmetic → M5.

**Task 11 — the truncation test's "five distinct one-literal shapes" rationale is
false.** → **M4.** The note was right that the rationale is wrong, and I settled the
mechanism by execution: it is not the harness's setup statements supplying the
baseline, it is cross-database noise, because pg_stat_statements is cluster-wide.
Minor, but worth fixing because this specific assertion has already been vacuous
once before.

**Task 2 — `harness.ts` `admin.end()` lacks its siblings' `.catch()`.** → **M3.**
Correctly characterised as low-probability; the note stopped one step short of the
actual consequence, which is a *leaked database in the shared container*, not just
a masked error — the cleanup block sits outside the try/finally that would throw.

### The two accepted limits

**Ruling 49 — the manual `node -e "import('react')"` wall check cannot hold under
npm workspace hoisting. ACCEPTED CORRECTLY.**
The reasoning is right and the substitute enforcement is the right substitute.
npm hoists `react` to the root `node_modules`, so Node's resolution algorithm will
find it from inside `packages/checks` no matter what that package declares —
runtime resolution genuinely cannot express this constraint in a workspaces
monorepo, and no amount of cleverness changes that. The declaration *is* the
contract, and `boundaries.test.ts` enforces both halves of it: `dependencies`
deep-equals `["pg"]`, and a source scan catches all four import shapes (static
single-quoted, static double-quoted, side-effect, dynamic) with comments stripped
first. I checked the scan's own soundness: it covers `src/**` recursively, which is
exactly the right scope — `@testcontainers/postgresql` is a devDependency imported
only from `test/`, and correctly not flagged. The cost-if-wrong assessment is also
right: a standalone consumer gets true isolation from the declaration, and an
in-repo stray import is caught by the scan. Nothing to change.

The one thing this ruling's enforcement does *not* cover is not about imports at
all — it is that the package's `main`/`exports` name a `dist/` nothing in CI
builds. That is M1, and it is the same *class* of gap as Ruling 46 (a config
covering no file), so I would fold its fix into the same CI step.

**Ruling 50 — the lexicographic-ORDER-BY guard's scope limit (does not follow
`${...}` interpolations). ACCEPTED CORRECTLY, and I can now say so on evidence
rather than on trust.**
I went looking for the fourth instance the limit would hide, and did it by
execution rather than by reading — see §1. There is none. Every ORDER BY in the
package resolves to a numeric source; every column's wire type matches its
declared TypeScript type; `query-stats.ts`'s interpolated `ORDER` map is correct
in all four entries, `v.`-qualified throughout, and directly covered by
`query-stats.int.test.ts`'s "sorts by calls and by cache hit rate too" test — which
is a *behavioural* guard, strictly stronger than the regex one, and which the file's
own comment correctly says fails without the qualifier.

The judgment behind the ruling is also right on its own terms: chasing an
interpolation back through arbitrary TypeScript is a static-analysis problem, not
a regex problem, and a guard honest about its blind spot genuinely does beat one
implying total coverage. I would add only the two *unstated* blind spots from §1
(the guard sees `::text` but not `::varchar`/`::char`/`to_char`, and sees only
backtick literals) to the comment, so the disclosure is complete rather than
partial. Not a code change.

---

## 5. Charge (c): the cross-task seams

Where one task's output feeds another's input, and what a per-task review could
not have seen:

| seam | producer → consumer | status |
|---|---|---|
| `Check.sql(opts)` → `runCheck` | T6–T12 → T1 | **broken — I1.** T1 built the executor before any options-bearing check existed; T9/T10/T11 each added one and neither could see that the executor's signature had stopped enforcing them. |
| `queryStats` → spec routes + `pgops.queries` schema + parity registry | T11 → spec §6.2/§4.2 → T14 | **broken — I2.** Three owners, no single reviewer holding all three. |
| `blocked.suspectPid` → `killBackend(target)` | T8 → T13 | **gap, fails closed — M2.** T8 named the kill target; T13 required an identity token T8 does not emit. Refuses safely; undocumented. |
| `redact.ts` (ported) vs `src/core/snapshot.ts` (origin) | T5 → pre-existing | **clean.** Byte-identical rule tables, verified by diff. No drift between the port and the original that P1 will delete. |
| `sessions.limit` (A7 cap) → `prepareSessions.filter` (A10 lookup) | T9 → T9 fix round | **closed correctly.** This is the seam bug the controller already caught by hand; `SessionOpts.pid` answers it server-side and `sessions.int.test.ts:81` proves it against a real cap of 1. Verified: `truncated` is provably `false` on that path. |
| `packages/checks` barrel → typecheck configs | T14 → T1 | **closed correctly** (Ruling 46), but its sibling is open — `main`/`exports` → `dist/` is built by nothing. **M1.** |
| `killBackend` → `writeAudit` → the operator's real log | T13 → T13 → the filesystem | **broken — I4.** The unit test isolates with `mkdtemp`; the integration test does not, and writes to `~/.pgops/audit.log`. Reproduced. |
| `locks.buildChains` → `locks.verdict` | T8 → T8 | **broken — I3.** The graph builder correctly labels `xactAgeSecs` as *not* wait time; the verdict twelve lines later treats it as wait time. Same task, same file — but no test crosses the boundary, which is how it survived. |
| `CHECKS` / `ACTIONS` → `PGHERO` entries | T6–T13 → T14 | **clean.** `ParityEntry`'s union cannot enforce mutual exclusivity at the type level, and `registry.test.ts` enforces it at runtime over every entry instead — the right call, correctly documented. `ACTIONS`/`ActionId` for #11 is a genuinely good piece of design: it makes "never names an action that does not exist" a checked property rather than a free-form string. |

---

## 6. What the branch gets right

Worth saying, because it is unusual and it is what makes the findings above small.

- **The pre-port defects are genuinely fixed, and fixed at the right level.** A1
  replaced a mis-calibrated ratio with the two numbers that actually mean
  something, and kept the ratio as explicitly informational with a written
  constraint on what must happen before it may ever drive a threshold. A3 counts
  the reserved pool and resolves the PG14-vs-PG16 GUC difference *server-side*, so
  one SQL text runs unchanged across the whole matrix — that is the right place to
  put a version difference. A6 removed a `FILTER (WHERE NOT active)` that excluded
  precisely the failure mode the check exists for.
- **The `killBackend` guard is correct and correctly proved.** Identity and
  backend-type checks live inside the same `CASE` as the terminate, against one
  snapshot — genuinely TOCTOU-free, in a way two statements cannot be. And
  `kill.int.test.ts` proves the *signal was never dispatched* (the non-client
  backend is still present afterwards with an unchanged `backend_start`), not
  merely that a return value read right. That distinction is the difference
  between a real test and a label check.
- **`writeAudit` is hardened for the failure modes that actually occur**, not the
  imagined ones: EPIPE from `pgops kill | head`, circular references and BigInts
  in caller-supplied `target` metadata, and a `finally`-block `await` replacing a
  successful return value. Each guard names the specific thing it prevents.
- **The comments cite defects rather than restate code.** `boundaries.test.ts`'s
  guard comments even explain why the guard self-triggered on the prose describing
  the bug it catches — that is the kind of note that survives contact with the next
  maintainer.
- **`global-setup.ts` is right about Vitest.** Module-scope state under
  `isolate: true` genuinely does not give one-container-per-run, and `globalSetup`
  with `provide`/`inject` genuinely is the only place that guarantee holds. The
  `fileParallelism: false` comment correctly identifies that the flake it prevents
  is structural (cluster-wide views, sibling fixtures) and must not be "optimised"
  away.

## 7. Global constraints — compliance

| constraint | status |
|---|---|
| PG floor 14; CI matrix 14/16/17/18 | met — `.github/workflows/ci.yml` matrix `['14','16','17','18']`, `fail-fast: false` |
| Node floor 22 | met — root `engines`, both CI jobs `node-version: '22'` |
| `packages/checks` `dependencies` === `{ pg }` | met, and machine-enforced (`boundaries.test.ts`) |
| No module-level mutable state | met, and machine-enforced — the guard's own `export let` / bare-`let` widening is a real improvement over the original regex |
| `runCheck` never rejects | met — including the paths I forced in I1, which return `{ok:false}` rather than throwing |
| DDL/DML/`pg_terminate_backend` only in `actions/kill.ts` | met — verified by reading all nine checks plus `audit.ts`; the only other mutation anywhere is `pg_stat_statements_reset()` inside a test fixture, with its carve-out written down |
| Every `Threshold` carries a non-empty `because` | met, and machine-enforced at `> 20` chars |
| `src/` not modified or deleted in P0 | **deviation, benign.** 11 files under `src/` are modified in the range — all in commit `ba614c9`, which predates the plan commit (`f1754eb`) and is the pre-port defect-fix work the plan itself argues from. Not a P0 task touching `src/`; the TUI still runs off its own code. Worth naming so it is a recorded deviation rather than a surprise. |
| 2-space indent, ESM `.js` specifiers, comments explain *why* | met throughout |
