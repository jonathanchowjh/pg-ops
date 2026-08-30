# Final review — scoped re-review of the fix round

Range `0df017e..a2ffc50` (9 commits), branch `feat/web-console`. Scope: did these fixes close
the findings they claim to close, without introducing new defects. Nothing else on the branch
was re-reviewed.

Everything below was verified by execution. Where a test claims to pin something, I broke the
production code and watched the test go red, then reverted. **Every such change was reverted;
the tree is clean.**

## Gates, at head, on a clean tree

```
npm test                                      489 passed / 55 files   ✅ (matches the stated target)
npm run typecheck                             exit 0                  ✅
npm run typecheck:test                        exit 0                  ✅
npm run --workspace @pgops/checks typecheck   exit 0                  ✅
npm run test:int                              40 passed / 10 files    ✅ (run twice)
```

`~/.pgops/audit.log`: sha1 `7792dfb5aa8865d3782ef5fbc4f2ad13c2016f68`, 11271 bytes, mtime
1787800657 — **identical before and after two full integration runs**. Never opened for write,
never edited. `pgops-dev` on 55432 was never connected to (still up 27h, untouched); the suite
used its own testcontainers.

---

## Per-finding verdicts

### I1 — `runCheck` arity — **CLOSED**

The `@ts-expect-error` mechanism genuinely works. Reverting `run.ts` to the single signature
with `opts: Opts = undefined as Opts`:

```
packages/checks/test/run.test.ts(142,7): error TS2578: Unused '@ts-expect-error' directive.
npm exit: 2
```

Non-zero exit, so CI catches it. Reverted.

I also probed beyond the shipped test, which only covers `sessions`. Under the new overloads
all of these are compile errors, and the two legitimate calls still compile:

| call | result |
|---|---|
| `runCheck(ctx, longRunning)` | rejected ✅ |
| `runCheck(ctx, queryStats)` | rejected ✅ |
| `runCheck(ctx, queryStats, undefined)` | rejected ✅ (the obvious workaround is closed too) |
| `runCheck(ctx, locks)` | compiles ✅ |
| `runCheck(ctx, longRunning, { minSecs: 1 })` | compiles ✅ |

The first overload keys on `Check<Row, Data, void>`; `sql` is a property, so `strictFunctionTypes`
checks `Opts` contravariantly and no options-bearing check can satisfy it. Probe file deleted.

### I2 — `queryStats` scoped to `dbid` — **CLOSED**

Deleting the `dbid = (SELECT oid FROM pg_database WHERE datname = current_database())` line
turns the new test red against live Postgres:

```
FAIL query-stats.int.test.ts > ranks only the current database's statements (I2)
AssertionError: another database's statement must not be: expected true to be false
```

Reverted. The test is not gameable: the marker is a column **alias** (`SELECT 1 AS i2_foreign_x`),
which survives `pg_stat_statements` normalisation where a literal would not, and it asserts
*both* halves — local marker present, foreign marker absent — so it cannot pass because markers
are simply unfindable. The predicate sits in the `toplevel_stats` CTE, so `total_shapes` is
scoped along with the rows.

### I3 — `locks.verdict` escalates on `waitstart` — **CLOSED**

This was the one I was asked to be hardest on. All four sub-questions check out.

**Does the verdict actually change subject?** Restoring `max(roots[*].xactAgeSecs)` as the
comparison turns three unit tests red, exactly as the fix report claims:

```
× flips to critical exactly at the critical threshold, in seconds WAITED  expected 'warn' to be 'critical'
× does not escalate on the blocker's transaction age (I3)                 expected 'critical' to be 'warn'
× escalates on a genuinely long wait even when the blocker's txn is young expected 'warn' to be 'critical'
```

**Are root blockers' `waitSecs` genuinely `null` rather than accidentally `0`?** Yes, and it is
enforced by a live test rather than by prose. I removed `HAVING count(*) > 0` from the
correlated subquery — the exact mutation that would turn "not waiting" into "waited zero
seconds" — and ran the integration file against real Postgres:

```
FAIL locks.int.test.ts > escalates on how long the waiter has waited... (I3)
AssertionError: expected +0 to be null
```

That is `locks.int.test.ts:162` (`expect(root.waitSecs).toBeNull()`) doing its job. Reverted.
The unit test at `locks.test.ts` asserts the same thing on the ETL fixture
(`expect(d.roots[0].waitSecs).toBeNull()` alongside `xactAgeSecs === 2400`).

**Is `COALESCE(waitstart, now())` → "unknown reads as ~0" what the code does?** Yes:
`EXTRACT(EPOCH FROM (now() - COALESCE(min(l.waitstart), now())))` evaluates to 0 when every
ungranted row has a NULL `waitstart`. One nuance in the fix's favour that the comment
understates: `min()` skips NULLs, so a session with one known and one just-started wait reports
the *known* one rather than collapsing to 0.

**Are the right sessions read?** The subquery keys on `l.pid = a.pid AND NOT l.granted`. Backend
pids are cluster-unique, so this reads the waiting session's own ungranted locks and nothing
else. `longestWaitSecs` cannot recurse forever: cycle back-edges are built by
`toWaiter(row, [], true)` with an empty `waiters` array, so the deliberate no-dedup walk
terminates.

The PG14 gate added in `a2ffc50` is correct and inert on supported servers: `requires` carries
only a `version` entry, so `classify()`'s `42P01 → missing-extension` path is unaffected, and
the whole integration suite (PG on the CI floor of 14) stays green.

### I5 — boundary tests and `>=` — **CLOSED** (see NEW DEFECT N1 for a side effect)

The sweeps are genuine `value-1 / value / value+1` triples, not "near the value". Verified by
reverting both `>=` changes to `>`:

```
FAIL long-running.test.ts > flips at the threshold itself, not one second past it (I5)
  AssertionError: expected 'ok' to be 'warn'
FAIL sessions.test.ts > sessionStates.verdict > flips to warn exactly at the warn threshold
  AssertionError: expected 'ok' to be 'warn'
```

Reverted. Coverage now: `locks` (warn count + critical seconds), `sessionStates`, `blocked`,
`longRunning`, `slots`, `wraparound`, `connections` — each threshold at the value and one unit
either side.

**No `because` string contradicts its operator.** I walked all seven checks. The closest tension
is `blocked`'s critical ("*past* a minute of query age") against `>= 60`, which is wording, not
a mismatch of direction. `connections`' "below a fifth of the pool free" matches its `pct < 20`
exactly.

On the count-down family the implementer's Concern 2 is a fair call, not a deviation:
`connections` uses `<` and `wraparound` uses `<=`, so they still disagree at their exact values.
But §I5's own audit table lists both as already **full** coverage and names only `longRunning`
(both comparisons) and `sessionStates` (warn) as the `>=` outliers — which is precisely what was
changed. Both count-down behaviours are now pinned on both sides, so a future normalisation is a
red test rather than a silent flip.

### I4 — integration audit log — **CLOSED**

`~/.pgops/audit.log` is byte-identical (same sha1, same size, **same mtime**) across two full
`npm run test:int` runs. The four real kill records landed in
`$TMPDIR/pgops-integration-tests/audit.log` (4444 bytes). The guard asserts the *resolved* path
through the newly-exported `defaultAuditPath()`, not merely that an env var exists, and it lives
in `kill.int.test.ts` so it runs under the same environment as the kills.

I also checked the leak cannot come from the unit project, which has no `env` override:
`audit.test.ts` passes explicit `mkdtemp` paths on every call and `kill.test.ts` mocks
`writeAudit` outright. No unit test can reach `defaultAuditPath()`.

### M4 — truncation fixture — **CLOSED, but the fix report's second proof is misstated**

The core claim is confirmed by execution. Restoring the old `SELECT 201..205` fixture under the
new assertion:

```
AssertionError: the fixture must create genuinely distinct normalised shapes: expected 1 to be 6
```

Five varying integer literals really do collapse to **one** normalised shape. The new
arity-varying fixture really does produce six. The `arities.size === SHAPES` assertion is a
tight, non-vacuous guard and it is what makes this finding closed.

**However**, the report's other proof — "lowering `SHAPES` (6) below `LIMIT` (5) ... `expected 5
to be greater than 5`" — does not reproduce as stated. I set `SHAPES = 4`, genuinely below
`LIMIT = 5`, and the entire file still passed. Instrumenting the test shows why:
`totalShapes = SHAPES + 3`, the extra three being the harness's own `CREATE EXTENSION`, its
`SELECT current_setting($1) AS v` probe, and the check's own query. So the truncation assertion
only goes red at `SHAPES <= 2` — which *is* where the quoted message comes from (confirmed:
`SHAPES = 2` → `AssertionError: expected 5 to be greater than 5`).

Net: the truncation assertion carries a 4-unit margin of which only 1 is the fixture's, so it
would tolerate the fixture halving before it noticed. That is a weaker guarantee than the report
implies, but it is **not** the vacuity M4 was about — the `arities` assertion pins the fixture
directly and tightly, which is what the brief actually asked for. Reported here because the
brief's standard is "a test you did not watch fail is not evidence", and this particular
watched-it-fail claim was recorded against the wrong knob.

### M1 — `dist/` built in CI — **CLOSED**

`npm run --workspace @pgops/checks build` emits `dist/index.js` and `dist/index.d.ts`.
`dist/` is ignored (`git check-ignore` → `.gitignore:2`). CI's `static` job runs the build at
`ci.yml:38`, pinned by `boundaries.test.ts` with an anchored `- run:` regex plus a second
assertion tying `main`/`types`/`exports` to the tsconfig `outDir`, so a drifting outDir can't
leave the same hole under a green step. `a2ffc50`'s `rm -rf dist &&` prefix still satisfies
`expect(pkg.scripts.build).toContain('tsc -p tsconfig.json')`.

### M2 / M3 / M5 — **CLOSED**

M2: the `suspectPid` doc names the real path and why `backendStart: null` fails closed.
M3: `.catch(() => {})` is on `harness.ts`'s first `admin.end()`, with the leaked-database
consequence spelled out.
M5: I diffed every `it(` title across all of `packages/checks/test` at `0df017e` vs `a2ffc50`.
Nothing was dropped — the only title missing from the old set is the M4 test, which was renamed
`(A4)` → `(A4, M4)`. Declarations went 138 → 160.

---

## NEW DEFECTS INTRODUCED BY THE FIXES: 1 (minor)

### N1 — `longRunning`'s SQL predicate is still `>` while its verdict is now `>=`, and the default `minSecs` *is* the warn threshold

`packages/checks/src/checks/long-running.ts`:

```
:77   AND now() - query_start > make_interval(secs => $1)
:80   values: [o.minSecs ?? 60, o.limit ?? 10],
:106  { level: 'warn', value: 60, unit: 'seconds', ... }
:135  if (warn && longest >= warn.value) {
```

Before the fix, SQL and verdict both used `>` and agreed. I5 changed the verdict to `>=` and
left the selection predicate alone.

**Concrete scenario.** Default opts; one active client query whose `now() - query_start` is
exactly 60.000s at poll time. The SQL's strict `>` excludes the row, `d.queries` is empty,
`longest` falls back to `0`, and the check reports **`ok`**. But `long-running.test.ts:73`
asserts `at(warnAt) === 'warn'`, and the fix report's behaviour-change #2 states "a query
running exactly 60.0s is now `warn` (was `ok`)". That statement is false for the check's default
configuration — the boundary the new test pins is unreachable through the production path.

Operationally this is harmless: exact float equality on a wall-clock interval is a measure-zero
event, and any caller passing `minSecs < 60` gets the consistent behaviour. But it is a
disagreement introduced *inside one check* by the `>=` standardisation, and it downgrades the new
warn-boundary test from an end-to-end guarantee to a unit-level one. `longRunning` is the only
check with a SQL-level predicate shaped like a threshold — I checked `blocked`, `sessionStates`
and `slots`, none of which filter on their threshold quantity — so the fix is one character:
`>` → `>=` at line 77, or drop the default `minSecs` below 60.

### Observation (not a defect)

The `wait_secs` correlated subquery adds a **third** per-row scan of `pg_locks` on top of the two
already present, for up to 501 rows, during exactly the lock storm this check exists for —
and `pg_lock_status()` touches every lock-manager partition. Same class as the two existing
scans rather than a new kind of problem, but it is roughly a 50% increase in that cost on the
check's worst-case path. Worth a note if `locks` ever shows up in its own slow-query list.

---

## Tree state

**Clean.** `git status --porcelain` is empty, `git stash list` is empty, HEAD is `a2ffc50`.
Every mutation I made to break a test — `run.ts` overloads, `long-running.ts` / `sessions.ts`
comparisons, `locks.ts` verdict subject and `HAVING` clause, `query-stats.ts` `dbid` predicate,
`query-stats.int.test.ts` fixture — was reverted with `git checkout --`, and the temporary
`_tmp_arity_probe.test.ts` was deleted. `.bak` files from `sed -i` were removed. The only
untracked artefact is `packages/checks/dist/`, produced by running the M1 build and covered by
`.gitignore`.

## Verdict

Ten findings, ten closed; one minor new inconsistency (N1) and one misattributed proof in the
fix report (M4's second knob) — neither blocking. This round is sound.
