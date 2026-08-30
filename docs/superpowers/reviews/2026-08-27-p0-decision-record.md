# P0 web-console foundation — decision record

Every ruling made while executing `docs/superpowers/plans/2026-08-26-web-console-p0-foundation.md`,
in the order made. A ruling is a decision the plan or spec did not settle, made rather than
escalated, each with what it costs if it turns out wrong. 64 of them across 14 tasks.

Branch `feat/web-console`, merge-base `ec0560a`. Nothing here is a code comment: these are
the judgement calls behind the code, kept because the code cannot explain why it is not
something else.

## Ruling 1 (C1): Task 4 creates `registry.ts` with NO check imports and `CHECKS = {}`;
all 60 pgHero entries are `planned:`. Task 14 adds the eight imports and flips the nine
shipped capabilities to `check:`. — Why: the spec makes each task independently green
and committable, and T14's stated charter is already "imports now resolve"; deferring
T4 instead would forfeit its real value, the re-audit against current pgHero source
landing before any check is written. `keyof typeof CHECKS` is `never` at T4, which
correctly makes `check:` unusable there. — Cost if wrong: T14 grows by one edit to a
file it already modifies; no rework elsewhere.

## Ruling 2 (C2): Task 1 adds `'packages/**/test/**/*.test.ts'` to the existing root
`vitest.config.ts` `include` array (leaving the `test` script alone). Task 2 then
replaces the file wholesale with the `projects` form as written, so its "Modify" label
becomes accurate. — Why: without it T1's RED step reports "no test files found" rather
than a real failure, which is not a watched failure. — Cost if wrong: one throwaway
line in a file T2 overwrites anyway.

## Ruling 3: `tsconfig.test.json` gains `packages/*/test/**/*` in Task 1's `include`.
— Why: `typecheck:test` is an existing repo gate; leaving the new tests outside it
means type errors in 14 test files ship silently. — Cost if wrong: trivial to revert.

## Ruling 4 — accept the implementer's extension of Ruling 3 (`"rootDir": "."` added to
  tsconfig.test.json compilerOptions). Verified the counterfactual myself: without it,
  `npm run typecheck:test` fails unconditionally with TS6059 ("packages/checks/test/run.test.ts
  is not under rootDir .../src"), regardless of any real type error — so Ruling 3 as written was
  unimplementable. — Why: the extension is the single mechanical answer, not a design choice.
  — Cost if wrong: one line in a config file; the alternative is a permanently red gate.

## Ruling 5 — the plan-mandated Important finding (untested `unreachable` + AggregateError
  branches in runCheck) is FIXED now, not deferred. — Why: "runCheck never rejects" is the
  phase's load-bearing guarantee, no later task covers the connection-failure path (Task 2's
  harness is Testcontainers-only), and the test is cheap and container-free — a Pool aimed at a
  closed port. The brief's authorship does not exempt its own test suite from the gap it leaves.
  — Cost if wrong: ~20 lines of test in a file that is already the right home for them.

## Ruling 6 — round 2 splits the coverage in two: keep the real-pool test (portable
  content assertion on ECONNREFUSED, proves never-rejects + classify end to end) and ADD a
  deterministic test that feeds `messageOf` a hand-built AggregateError matching the shape
  already observed from the real dial. — Why: my round-1 instruction banned fabricated errors
  because a fake would test the implementer's model of the failure rather than the failure.
  That objection is now retired — the real shape has been captured independently twice (empty
  own `.message`, `errors[]` of ECONNREFUSED Errors), so pinning it is recording a measurement,
  not guessing. And it is the only way to get coverage that holds on single-stack CI, where the
  real dial yields a plain Error and the unwrap branch never runs. — Cost if wrong: a unit test
  whose fixture could drift from reality; the retained real-pool test is what catches that drift.

## Ruling 7 — accept the implementer's correction of the BRIEF's own example SQL. The plan
  text wrote `SELECT current_setting($1)::text AS v` with nothing bound to $1; against real
  Postgres that raises "there is no parameter $1". The implementer changed the literal to the
  parameterless form and documented why. — Why: the plan is the spec's argument, not an
  authority over Postgres; a demonstrably broken statement in it is a plan defect. Worth
  recording that the harness caught a genuine SQL defect on its first execution, in the plan's
  own illustrative test — which is precisely the class of bug 370 unit tests never caught and
  the reason this phase exists. — Cost if wrong: one literal in one test.

## Ruling 8 — FIX the container-reuse defect now, before Task 3 builds CI on it. The brief's
  harness claims "one container per worker process"; Vitest 4 defaults isolate:true and gives each
  test file a fresh module graph, so the module-level `let container` is never reused and every
  integration file starts its own container. Tasks 6-13 add 10+ such files across a 4-version
  matrix. — Why: the claim is false as written, the cost is multiplied by every later task, and
  Task 3 is about to encode the matrix on top of it. Requirement is "one container per run,
  demonstrated"; mechanism is the implementer's to verify empirically (globalSetup+provide
  preferred over isolate:false because it holds regardless of pool type). — Cost if wrong: a
  slower integration suite, or a globalSetup that needs reworking in Task 3.

## Ruling 9 — PROMOTE the deferred minor "no DROP DATABASE" into this fix round. Harmless
  while each file has its own container; not harmless once Ruling 8 makes one container serve
  30+ databases — Task 7's `wraparound` check reads pg_database across ALL databases, so
  abandoned per-test databases would contaminate its results. — Cost if wrong: one DROP in a
  finally block.

## Ruling 10 — FIX the harness test's failure to prove isolation. It asserts the harness
  starts, not that two withPostgres calls get non-interfering databases, which is the property
  Tasks 6-13 rely on for fixture isolation. — Cost if wrong: ~10 lines of test.

## Ruling 11 — bump actions/checkout and actions/setup-node from the brief's v4 to v7.
  Verified independently against the GitHub releases API: checkout is v7.0.1, setup-node v7.0.0,
  so the brief pinned three majors back. — Why: the plan's pin reflects stale knowledge at
  authoring time — the same staleness class Task 4 exists to guard against for pgHero. Old
  action majors run deprecated runner node versions and emit deprecation warnings, and we hold
  "pristine output" as a standard elsewhere in this plan. The bump is safe: checkout is invoked
  with no inputs, and setup-node uses only node-version and cache, both stable across majors.
  Addressed pre-review as a correctness concern rather than as a fix round. — Cost if wrong:
  revert two version strings.

## Ruling 12 — PATCH the missing CI guards now rather than accept them as a known gap.
  The brief's YAML has no `concurrency:` group and no `timeout-minutes`. With
  `push: {branches: ['**']}` plus a bare `pull_request` trigger, every push to a branch with an
  open PR fires CI twice with nothing cancelling the superseded run — up to 8 concurrent
  integration legs per push instead of 4. And with no job timeout, a hung Testcontainers image
  pull inherits GitHub's 360-minute default, across a 4-way matrix. — Why: this branch will be
  pushed shortly, so the waste is imminent, not theoretical; the fix is four lines; and a stuck
  6-hour job is exactly the failure that goes unnoticed until the bill. — Cost if wrong: a
  timeout too tight would fail a legitimate slow run, which is loud and one-line to raise.

## Ruling 13 — fold the Minor (`permissions: { contents: read }`) into the same dispatch.
  Not a loop extension: the fix round is already happening for Ruling 12, and least-privilege on
  a workflow is cheaper to set on day one than to retrofit. No step here uses GITHUB_TOKEN.
  — Cost if wrong: a later step needing write scope must declare it, which is the point.

## Ruling 14 — the index.ts/redactSecrets gap is real and mine; my preflight scan checked
  registry.ts's imports but not index.ts's contents. The brief's index.ts exports redactSecrets
  from './redact.js', which Task 5 creates; neither Task 5's nor Task 14's brief re-adds the
  export. RESOLUTION: Task 5 adds `export { redactSecrets } from './redact.js';` to index.ts when
  it creates the module. — Why: the task that creates a module is the natural owner of its export,
  and Task 5 already touches nothing else. — Cost if wrong: one line, caught by Task 14's boundary
  tests if missed.

## Ruling 15 — #62 `autoindex` stays `planned:`, NOT declined. The implementer flagged it as
  a decline candidate (auto-DDL from a heuristic). — Why: the user's directive is full pgHero
  parity and they approved exactly ONE decline (#13 kill_all); declining a second on my own
  initiative narrows scope the user chose. The safety concern is real but is a design constraint
  for the phase that builds it — when built it must be gated behind explicit confirmation like
  `kill`, never fire unattended — not grounds to drop the capability. Surfaced to the user in the
  final rulings list. — Cost if wrong: the user declines it later and parityBacklog drops by one.

## Ruling 16 — accept the implementer's phase placement for the ~5 capabilities (#1,#3,#7,
  #18,#48) the spec's §10 does not explicitly assign. — Why: phases are a sequencing convenience,
  cheap to move, and the task asked for exactly this judgment. — Cost if wrong: a capability
  builds one phase early or late.

## Ruling 17 — the re-audit is REDONE systematically across all pgHero method files, with
  the per-file public-method enumeration written into the report so it is checkable rather than
  asserted. — Why: a 3-file sample found a miss in the file the auditor had open. That is not a
  near-miss to wave through; it is evidence the method was "read the file and notice things"
  rather than "enumerate and tick off", and the same method covered 13 unsampled files. This
  registry's only value is being trustworthy about scope; a table that is approximately right is
  worse than none, because it will be believed. — Cost if wrong: one expensive task redone; the
  alternative is declaring parity against a list we never actually verified.

## Ruling 18 — folding a method into another entry is allowed but must be DOCUMENTED in the
  file comment with its reason (the existing `_enabled?` probe convention is fine). Silent
  omission is not. — Why: it keeps "we decided this isn't a separate capability" distinguishable
  from "we missed it", which is the whole difference between an honest backlog and a wrong one.
  — Cost if wrong: a few lines of comment.

## Ruling 19 — fold the Minor (comment noting ParityEntry's mutual exclusivity is enforced
  by the runtime test, not the type — tsc accepts an object with both `check` and `planned`)
  into this fix round. Not a loop extension; the round is already happening, and Task 14 extends
  this exact contract. — Cost if wrong: one comment line.

## Ruling 20 — fix both Importants AND fold in all three Minors in one round. The gaps are
  (a) unquoted key=value trailing text never proven to survive, (b) dollar-quote tag
  back-reference never tested against a competing $...$, (c) doubled-quote untested for the
  key=value rule specifically, (d) multi-line scoping unproven, (e) four of the six KEYS
  alternatives (secret/passwd/pwd/api_key) never positively redacted — only password and token.
  — Why: this is a credential redactor; every rule in it exists because it once leaked, and the
  source comments say so by name. A rule with no test is the one that silently stops matching in
  a later refactor, and "stops matching" here means "leaks". (e) is inherited from the original
  test file and the brief mandated a verbatim port — but the port is of the IMPLEMENTATION;
  adding tests neither changes behaviour nor violates it. All five are cheap tests in one file,
  and folding them costs nothing beyond the round already happening. — Cost if wrong: a handful
  of extra test cases in a security-critical file, which is not a cost.

## Ruling 21 — fix the Important AND fold in all three Minors. Normally minors defer; here
  two of them are defects in a TEMPLATE that Tasks 7-12 copy. (a) negative/zero-headroom
  uncovered — the one scenario this check exists for, and a future edit clamping pct at 0 would
  silently defeat escalation; (b) *Row fields typed `string` when every column is ::int and
  node-pg returns number — a wrong shape propagated into six more Row interfaces; (c) thresholds
  located by non-null-asserted .find(), which throws at runtime rather than failing typecheck the
  moment a copied check has a different threshold set. — Why: fixing the pattern once costs one
  round; fixing it after replication costs seven files and seven reviews. — Cost if wrong: a
  slightly more verbose template.

## Ruling 22 — accept the implementer's two deviations from the brief's SAMPLE code:
  `xact_age` typed number (age(xid) is int4) rather than cast to string, and no non-null
  assertions on threshold lookup. — Why: both are the template conventions I explicitly required
  in the dispatch (conventions 1 and 2 from connections.ts). Where the brief's illustrative code
  and the reviewed template disagree, the template wins — it is the shape six checks copy, and it
  was reviewed; the brief's sample was not. Verbatim SQL, field names, thresholds, `because`
  strings and HARD_LIMIT were all preserved. — Cost if wrong: two type/lookup edits.

## Ruling 23 — fix both Importants and fold in both Minors. (a) the report's 409/409 came
  from an unscoped `vitest run`, which executes BOTH projects and starts a container — it is not
  the unit-suite number it is presented as; re-run scoped and report separately. (b) document
  that autovacuum_freeze_max_age is read from the global GUC and ignores per-table/per-database
  overrides — harmless because pctToForcedVacuum is informational and never reaches a threshold,
  but five more checks will copy `current_setting()` and one of them may put it somewhere
  load-bearing. (c) ORDER BY has no tiebreaker, so which databases occupy the worst-10 is
  unstable among ties — cheap to fix and a latent flaky test. (d) numeric conversion happens in
  JS here but server-side in connections.ts — an unexplained divergence the next five checks
  would copy inconsistently. — Why (c)+(d) don't wait: both are template-consistency defects, and
  the Task 6 lesson is that these cost one round now and seven files later. — Cost if wrong:
  a tiebreaker column and a cast moved into SQL.

## Ruling 24 — standardize on SERVER-SIDE numeric casting (connections.ts's way) as the
  convention, and state it in a comment. — Why: it keeps the NULL-folding pattern and the
  version-conditional pattern in one place, and makes row types honest about what arrives.
  — Cost if wrong: a cast on the other side of the wire.

## Ruling 25 — the implementer's flagged double-count IS worth fixing, and it is NOT rare.
  pg_blocking_pids() returns an ARRAY: a backend is blocked by every session whose lock conflicts
  with the one it wants. A DDL statement queued behind three ACCESS SHARE readers is blocked by
  all three — an ordinary incident shape, not a corner case. Each root then builds its tree with
  a locally-fresh visited set, so that one waiter is counted three times in totalWaiters, which
  is what the verdict threshold fires on. Severity is overstated in exactly the situation the
  check exists for. RESOLUTION: keep the trees as they are — a waiter genuinely IS blocked by
  several roots, and showing it under each is accurate — but compute totalWaiters as the
  cardinality of the DISTINCT set of waiting pids rather than the sum of tree sizes. That sidesteps
  the ownership question the implementer correctly declined to answer unilaterally. — Cost if
  wrong: the aggregate counts distinct stuck sessions instead of distinct block relationships,
  which is what an operator means by "how many sessions are stuck".

## Ruling 26 — accept the two self-found corrections: the `byPid.has(pid)` guard for a
  blocker with no row of its own (a parallel worker excluded by backend_type = 'client backend'
  is a real occurrence, and it crashed), and removal of the brief's non-null threshold assertion
  per convention 3. Both were caught in self-review with their own RED/GREEN. — Cost if wrong:
  nil; the guard prevents a crash and the assertion removal matches the reviewed template.

## Ruling 27 — fix the LIMIT defect. `LIMIT 500` with no ORDER BY means (a) which 500 rows
  survive is arbitrary, and if a waiter's own row is dropped, walk()'s `if (!row) continue`
  silently amputates its whole subtree; (b) nothing in LocksData distinguishes a truncated graph
  from a complete one. Both bite hardest during a large incident — the only time this check
  matters. Plan-mandated (identical to the brief's SQL), but wraparound.ts already set the
  precedent of ordering before LIMIT. RESOLUTION: ORDER BY oldest transaction first (biases
  retention toward likely root blockers) with a deterministic tiebreak, fetch LIMIT 501 and expose
  `truncated: boolean` on LocksData. — Cost if wrong: one extra row fetched and one boolean.

## Ruling 28 — fold in three Minors: the int-test teardown gap (clients opened BEFORE the
  try block, so a failure in the second open leaks the first's open transaction and hangs
  DROP DATABASE — presents as a mysterious CI timeout, not a test failure); the `as RootBlocker`
  cast, which is the first type assertion in this package and a new pattern later checks would
  copy; and a 3+-node cycle test, since only a 2-node cycle is pinned. — Cost if wrong: trivial.

## Ruling 29 — accept `sessions: Check<SessionRow, SessionsData, SessionOpts>` where
  SessionsData = { sessions, truncated }, instead of the brief's bare SessionRow[]. — Why:
  convention 6 (established in Task 8's review) requires a truncation signal, and A7 is literally
  the same defect as Task 8's LIMIT finding; a pure map(rows) cannot express "there were more"
  without either a wrapper or an array carrying an extra property, and the latter is type-hostile
  and silently lost across spread/slice/map. It is also the CONSISTENT choice: LocksData is
  already { roots, truncated }. — Cost if wrong: Task 14 reads r.data.sessions / r.data.truncated
  instead of r.data. One line. **Task 14 dispatch must carry this.**

## Ruling 30 — fix ORDER BY pid. Deterministic but not severity-meaningful: during the exact
  2,000-connection incident A7 describes, the surviving 500 are simply the lowest pids regardless
  of state, and since Postgres assigns pids roughly monotonically, a fresh burst of
  idle-in-transaction sessions has the HIGHEST pids and is dropped wholesale before
  prepareSessions' triage rank ever sees it. Order by the same priority rank() applies, age desc,
  pid as final tiebreak. — Cost if wrong: an ORDER BY clause.

## Ruling 31 — CONTROLLER-FOUND, not in the review: A7's fix defeats A10's fix. The SQL caps
  at LIMIT ordered by pid; prepareSessions filters CLIENT-SIDE over the already-capped rows. So
  the operator A10 exists for — arriving from an alert holding pid 91234 and nothing else — gets
  an empty result whenever 500 lower pids exist, because the row never left the server. The fix
  presents as "no such session", which is worse than the original defect it replaced.
  RESOLUTION: add `SessionOpts.pid?: number` and an `AND ($2::int IS NULL OR pid = $2)` predicate,
  so a pid lookup is answered server-side and cannot be truncated away. The general substring
  filter stays client-side over the now severity-ordered page, with the interaction documented.
  — Why narrow rather than pushing the whole filter into SQL: the pid case is A10's entire
  justification and is exactly expressible; the general substring filter is well-tested where it
  is, and moving it would trade a real fix for a larger rewrite. — Cost if wrong: one optional
  opt and one predicate.

## Ruling 32 — `longRunning`'s Data becomes LongRunningData { queries, truncated }, not the
  brief's bare LongRunning[]. Identical situation to Ruling 29: it has `LIMIT $2` with a RUNTIME
  limit option and a severity-meaningful ORDER BY, but no truncation signal, so a caller cannot
  tell a complete list from a clipped one. Convention 6 applies, and LocksData/SessionsData are
  already { …, truncated }. Use the count(*) OVER () technique — the limit is a runtime opt, so
  map() (pure over rows alone) cannot see it, exactly as in sessions.ts. — Cost if wrong: Task 14
  reads r.data.queries. **Task 14 dispatch must carry this alongside Ruling 29.**
  (`blocked` needs no signal — it is a single-row aggregate, not a list.)

## Ruling 33 — add live-Postgres fixtures that actually exercise the detection paths. Today
  blocked.int.test.ts runs the SQL against a quiet database, which proves it parses, not that it
  detects a block; and there is no long-running integration test at all. The pattern already
  exists in locks.int.test.ts (holder clients, cleanup registered at creation). — Why: `blocked`
  exists to find blocked sessions, so "runs cleanly when nothing is blocked" is the one result
  that cannot distinguish a working check from a broken one. — Cost if wrong: two fixtures using
  an established pattern.

## Ruling 34 — accept the three brief corrections: the critical threshold's `because` had
  relocated A8's mislabeling into prose ("the waiters have exceeded most application timeouts"),
  BlockedRow.blocked was typed string despite an ::int cast (conventions 1-2), and both verdicts
  used t.find(...)! (convention 3, explicitly forbidden). — Why: the `because` catch is the best of
  the three; fixing field names while leaving the same wrong claim in the justification text would
  have left A8 half-fixed in the place an operator actually reads. — Cost if wrong: nil.

## Ruling 35 — CONTROLLER-FOUND, generalised from the implementer's flaky-fixture report.
  The integration project runs test FILES in parallel against ONE shared container, and
  pg_stat_activity is cluster-wide — deliberately unscoped by datname, because an operator cares
  about the whole instance (max_connections is cluster-wide, not per-database). So every check
  reading session state (sessions, locks, blocked, longRunning, and whatever Tasks 11-13 add) can
  see sibling test files' backends. The implementer worked around it by polling in one fixture;
  that is a per-test tax on a structural problem. RESOLUTION: set `fileParallelism: false` on the
  integration project in vitest.config.ts. — Why: one line removes the whole class instead of each
  future fixture rediscovering it, and the integration suite is already serialized on a single
  container, so the wall-clock cost is small. — Cost if wrong: a slower integration run; revert is
  one line.

## Ruling 36 — `blocked.ts`'s CTE must filter `backend_type = 'client backend'`, matching
  every sibling check. Three reasons, in order of weight: (1) `suspect_pid` is the pid an operator
  is invited to KILL, and Task 13 builds that action — a non-client backend must never be offered
  as a kill target; (2) the thresholds are calibrated for client work, so counting background
  workers changes what the number means without changing what it is called; (3) consistency — one
  population across checks is the A11 lesson, and an unremarked divergence is indistinguishable
  from an oversight. An autovacuum worker blocked on a lock IS operationally serious, but it
  belongs to the vacuum/wraparound area with its own calibration, not folded into "blocked
  sessions". Document the choice in a comment either way. — Cost if wrong: a genuinely blocked
  background worker goes unreported by THIS check until the vacuum area ships.

## Ruling 37 — fold in two Minors: `suspect_pid` cast `::text` then Number()-ed back, where
  every other pid in the package is native int4 (conventions 1-2, and the report claimed full
  compliance); and `array_agg(... ORDER BY now() - query_start DESC)[1]` has no tiebreak, unlike
  every sibling ORDER BY, so which blocker is named flips between polls under exact ties.
  — Cost if wrong: trivial.

## Ruling 38 — CORRECTS my own Ruling 36 reasoning. The implementer correctly observed that
  filtering the CTE restricts the WAITER population but not `blockers[1]`, which comes from
  pg_blocking_pids and can still be an autovacuum worker (autovacuum takes locks and routinely
  blocks DDL). So suspect_pid can still name a non-client backend, and the kill-target argument I
  used to justify the filter is not satisfied by the filter.
  RESOLUTION: do NOT hide non-client blockers from suspect_pid. An autovacuum blocker is precisely
  what an operator needs to SEE — suppressing it would trade a diagnosis for a safety property we
  can get more cheaply elsewhere. The guard belongs at the ACTION: Task 13's kill must refuse any
  target whose backend_type is not 'client backend', checked at kill time inside the same guarded
  statement. That is also more robust than filtering here, because a pid read now and killed a
  moment later may have been recycled — a TOCTOU the SQL guard closes and a pre-filter cannot.
  The waiter-population filter STANDS on its other two grounds (threshold calibration, one
  population across checks). locks.ts has the identical exposure, mitigated JS-side.
  — Cost if wrong: nil here; the requirement moves to Task 13, whose dispatch must carry it.
  **Task 13 dispatch must carry this.**

## Ruling 39 — accept all three brief deviations. (a) Added the `cache` sort key that A4's
  own defect text names but the draft's ORDER map omitted — a fix for "the sort doesn't offer what
  the header promises" that omits one of the promised sorts is not a fix. (b) REAL BUG in the
  draft: `ORDER BY calls DESC` resolves against the ::text-cast OUTPUT alias, not the numeric
  input column, because Postgres resolves unqualified ORDER BY names against output aliases first
  — so "sort by calls" would have sorted lexicographically, ranking "9" above "100". That is a
  fresh instance of A4 (the sort key not meaning what it says) hiding inside the fix for A4, and
  it would have passed any test that only checked rows came back in some order. (c)
  QueryStatsData.sort was hardcoded 'total' regardless of the requested key, so the response
  misreported which sort produced it. — Cost if wrong: nil; each is demonstrably more correct than
  the draft.

## Ruling 40 — REMOVE the row-level privilege filter. CONTROLLER-VERIFIED EMPIRICALLY on
  live PG 17.11: a role with neither ownership nor pg_read_all_stats sees 4 rows, 3 of them owned
  by another user, with query = '<insufficient privilege>', queryid NULL, and every statistic
  intact. Postgres redacts the TEXT; it does not drop the ROW. The brief's
  `AND (userid = ... OR pg_has_role(..., 'pg_read_all_stats', ...))` drops the row, which is
  strictly more restrictive than Postgres's own model. In the deployment this check targets — a
  monitoring role distinct from the application roles — it would silently return almost nothing
  and defeat A4's entire purpose, with no error and no signal: the same silent-failure shape the
  missing-extension path exists to prevent. It is also structurally untestable by the current
  suite, which connects as a single superuser, so `userid = current_user` is always true and the
  OR branch never runs. Plan-mandated (task-11-brief.md:127-128). RESOLUTION: delete the clause and
  let Postgres enforce its own policy; the row types already allow `query`/`queryid` to be null, so
  the redacted case is already tolerated. Surface the redaction rather than hiding it — a row whose
  text you cannot read but whose cost you can see is actionable ("grant pg_read_all_stats").
  — Cost if wrong: the check shows rows whose text is redacted, which is what Postgres shows.

## Ruling 41 — fold in all three Minors: no direct ordering assertion for sort:'total' (the
  one key in the closed record left unproven); `totalShapes >= rows.length` is trivially true even
  with no truncation, inherited from the brief's draft test; and trim the repeated totalShapes/
  map-purity rationale to one canonical home with pointers — KEEPING the two load-bearing long
  comments (the alias hazard and the count(*) OVER () cost judgement), which the reviewer
  explicitly said earn their length. — Cost if wrong: trivial.

## Ruling 42 — accept all three brief corrections. (a) The draft's `ORDER BY 5` sorted the
  ::text-cast retained-bytes column lexicographically, so "5..." would outrank "20..." — 5 GB
  ranked above 20 GB. This is the THIRD instance of the same class in this plan (Task 11's
  ORDER BY output-alias bug, and its sibling keys). The bigint-safety convention requires casting
  counters to text, and text columns sort lexicographically: the two correct decisions keep
  producing a wrong one. (b) The draft's fixture never attached a consumer, so its slot never
  became `active` — meaning the test for the active-slot half of A6 would never have exercised the
  active branch, the exact "passes under the old behaviour" failure this plan keeps catching. The
  implementer rewrote it to open a real replication-protocol connection. It also omitted
  immediately_reserve, leaving restart_lsn NULL. (c) Two non-null assertions removed per
  convention 3. — Cost if wrong: nil; each is demonstrably more correct than the draft.

## Ruling 43 — CONTROLLER-FOUND, urgent: `npm run typecheck:test` is RED with two errors in
  Task 11's query-stats.int.test.ts (TS6133 unused `ctx`; TS2345 string|undefined). CI's static job
  runs that script, so the branch would fail CI today. Task 11 reported "typecheck clean" and its
  reviewer agreed — both ran `tsc -p packages/checks/tsconfig.json`, which EXCLUDES test/, rather
  than the repo's tsconfig.test.json. My dispatches said "typecheck clean" without naming which,
  so the ambiguity is mine. RESOLUTION: fix both errors now, folded into Task 12's round since the
  agent is already working in that directory and the fixes are mechanical; and every remaining
  dispatch must require BOTH `npm run typecheck` and `npm run typecheck:test` by name.
  — Cost if wrong: nil; the gate is objectively red.

## Ruling 44 — fix the fixture leak. Slot creation and replClient.connect() sit OUTSIDE the
  try whose finally drops the slot, so a failed replication connect (pg_hba rejection, wal_level,
  max_wal_senders exhaustion) leaks a CLUSTER-WIDE physical slot that withPostgres cannot clean up
  — it drops the per-test database only — and that slot then retains WAL for every later test file
  in the run. This is the THIRD instance of the setup-phase-leak pattern (Task 8's clients, Task
  11's roles, now this), and the most damaging, because a retained slot degrades the whole run
  rather than one file. — Cost if wrong: nil.

## Ruling 45 — fold in both Minors: the test named "...so it survives a standby" only does a
  string-containment check on the SQL text, which overstates what it proves — the exact thing the
  dispatch forbade — and an imprecise comment about which cast is needed. — Cost if wrong: nil.

## Ruling 46 — CONTROLLER-FOUND CI GAP, assigned to Task 14. Neither CI typecheck script
  covers `packages/checks/src/**`. Root tsconfig.json includes only `src/**` (the TUI);
  tsconfig.test.json adds `packages/*/test/**`, which pulls package source in only TRANSITIVELY,
  via test imports. I proved the hole empirically: appending `const __probe: number = "not a
  number"` to packages/checks/src/index.ts produces ZERO errors from `npm run typecheck:test`,
  because index.ts — the package's public barrel — is imported by no test. So the entry point every
  future consumer imports is the one file CI never checks. RESOLUTION: Task 14 adds a CI step (or
  a root script) that typechecks the package's own source, e.g. `npm run --workspace @pgops/checks
  typecheck`, and its boundary tests should treat this as part of "the wall holds". — Cost if
  wrong: one CI step. — Cost if ignored: a type error in the public API ships green.

## Ruling 47 — fix the audit-path rejection hazard, with defence in depth (both halves).
  writeAudit's JSON.stringify/redactSecrets/process.stdout.write sequence is unguarded, unlike the
  deliberately-wrapped file write — so EPIPE (real: `pgops kill ... | head`) or a circular/BigInt
  value in caller-supplied meta.extra makes it reject, contradicting its own "never rejects"
  comment. killBackend's finally awaits it with no catch ON THAT PREMISE, and an exception thrown
  from an await inside `finally` REPLACES the try block's return value — so a genuine successful
  kill would surface to the caller as a thrown error. Same "outcome doesn't match reality" class
  this task exists to prevent, inverted: kill succeeded, reported as failed. An operator seeing an
  exception after a successful kill retries; the retry is safe here (the guards would return
  session-changed or gone) but the report is still a lie. RESOLUTION: guard the sequence inside
  writeAudit so its stated contract becomes true, AND restore an outer catch around the writeAudit
  call in kill.ts — which is what the pre-port src/core/kill.ts:80-87 did. Both, because the inner
  guard keeps the contract honest and the outer one means no future edit to writeAudit can ever
  replace a kill's return value. — Cost if wrong: two try/catches on a logging path.

## Ruling 48 — fold in the meta.extra ordering Minor: `extra` is spread AFTER pid and
  backend_start, so a caller-supplied extra.pid silently overwrites the real pid in the audit
  record. For the one destructive action in the phase, an audit trail whose subject can be
  overwritten by caller input is not an audit trail. Spread extra first, or omit those keys.
  — Cost if wrong: nil.

## Ruling 49 — accept that the brief's manual `node -e "import('react')"` check cannot hold
  here. npm workspace hoisting puts react in the shared root node_modules, so it resolves from
  inside packages/checks regardless of that package's declared deps. Runtime resolution therefore
  cannot enforce the wall in a workspaces monorepo; the DECLARATION is the contract, and the
  automated dependencies === ["pg"] test is the real enforcement. — Cost if wrong: a future
  consumer installing the package standalone gets the true isolation the declaration promises;
  in-repo, a stray import would be caught by the import-scan assertion instead.

## Ruling 50 — accept the lexicographic-ORDER-BY guard's disclosed scope limit (it does not
  follow ${...}-interpolated ORDER BY fragments back to source, so query-stats.ts's ORDER lookup
  table is outside it). — Why: it still catches the literal-ORDER-BY shape that produced two of the
  three instances, query-stats' map is now correct and directly tested, and a guard that is honest
  about its blind spot beats one that implies total coverage. Flagged for the final review.
  — Cost if wrong: a future interpolated ORDER BY over a text-cast column ships unguarded.

## Ruling 51 — the reviewer's #4 finding is CORRECT and I verified it independently by
  fetching pgHero's methods/connections.rb myself: `connections` is a per-connection list
  (pid, datname, usename, application_name, client_addr, state, ssl), not an aggregate. Our
  `connections` check returns {max, used, reserved, headroom}. Remap #4 to `planned: 'P2'`
  (alongside its sibling #7 connection_sources), NOT to `sessions`. — Why: `sessions` is the
  closest shipped analog but still not an answer — it lacks datname and ssl, and caps at 500
  rows where pgHero's list is unbounded. Claiming it would be the third generous mapping in a
  registry whose entire job is being right about parity. Honest `planned:` beats a near-miss
  `check:`. Backlog goes 54 -> 55; check: entries 9 -> 8. — Cost if wrong: we understate
  delivered parity by one entry, which is the safe direction to be wrong in.

## Ruling 52 — fix the two wall-guard blind spots rather than disclose them. The imports
  regex only matched single-quoted `from '...'`, and the module-state regex only matched
  `^let `/`^var ` — so `import x from "pkg"`, a bare `import 'pkg'`, `await import(...)`, and
  `export let cache = 0` all walked straight through. These came verbatim from the brief, but
  `export let` is the MOST dangerous module-state form (mutable and visible to every consumer),
  and a guard that misses it is worse than no guard because it implies coverage. Broadening the
  regexes is a few characters; the brief's exact-values rule does not extend to a template that
  provably fails to hold the wall. — Cost if wrong: none identified; the broader regexes are
  strictly supersets and every current file already passes.

## Ruling 53 — fold the three minors into the same round (CI-guard anchored to a real
  `- run:` line rather than matching inside a comment; the id-existence test's range widened
  1..60 -> 1..65 to cover the entries the file's own audit note added; #5's client-backend
  scope difference disclosed in the registry comment). — Why: same three files, same round,
  and each is one line. Deferring them costs a second round to save nothing.

## Ruling 54 — skipped the scoped re-review and verified the fix round MYSELF instead.
  Read all five changes directly, then mutation-tested every guard: injected `import z from
  "react"`, `import 'react'`, `await import('react')`, `export let cache = 0`, `export var
  cache2 = 0` into blocked.ts and a commented-out CI step into ci.yml — all six FAIL the
  boundaries suite, tree clean afterward. — Why: the diff is three files of mechanical regex
  work whose only load-bearing claim is "the guard now fails on these shapes", and executing
  that claim is strictly stronger evidence than a reviewer reading it. A review seat here buys
  an opinion where I already have a result. — Cost if wrong: I inspected the same diff a
  reviewer would have; the whole-branch review still covers these files.

## Ruling 55 — I2: scope queryStats to the current database via
  `dbid = (SELECT oid FROM pg_database WHERE datname = current_database())` rather than adding
  a datname column and leaving it cluster-wide. — Why: pgHero's #14 scopes by dbid, the spec's
  route is /db/[name]/queries (§6.2) and its pgops.queries table is keyed by database_id
  (§4.2). All three are per-database; a P3 capture job knows its own connection's database and
  can stamp the id itself. — Cost if wrong: an operator loses cluster-wide ranking, recoverable
  later by adding an opt. The reverse error ships an unlabelled cross-database ranking on a
  per-database page.

## Ruling 56 — I3: escalate locks.verdict on `pg_locks.waitstart` (PG14+, floor is 14),
  COALESCEd to now() when NULL, not on the root blocker's xact age. — Why: the code contradicted
  BOTH its own type doc ("NOT time spent waiting") and its own threshold `because` ("the waiters
  are already being retried"). Under-reporting a wait that genuinely just started is the safe
  direction; over-reporting is the finding. — Cost if wrong: a wait in waitstart's brief NULL
  window reads as ~0s and escalates one poll later.

## Ruling 57 — I5: standardize every check on `>=` at the threshold rather than
  documenting the `>=`/`>` divergence. — Why: a threshold is the value AT WHICH the condition
  becomes a problem, which is how every `because` string in the package is already worded; the
  new boundary tests pin it. — Cost if wrong: one check escalates one unit earlier than before,
  a behavior change noted in the commit message.

## Ruling 58 — did NOT touch ~/.pgops/audit.log. The integration suite wrote real
  action:"kill" records into the developer's own audit log (I4); the fix stops it recurring via
  PGOPS_AUDIT_LOG in the integration project's env, but the existing stray records stay. — Why:
  that file is the developer's data and editing an audit log is exactly the thing an audit log
  exists to make impossible. Theirs to decide. — Cost if wrong: nothing; it is reversible by
  them and irreversible by me.
Note (recorded deviation, not a defect): commit ba614c9 — the FIRST commit in the range and
  predating both the spec and plan commits — carries 12 files of the developer's own pre-P0 TUI
  work under src/. The Global Constraint "src/ is not modified in P0" is not violated by any
  P0 task, but the branch does carry that work. The developer should know it rides along.
Final fix round: dispatched (model opus). Brief: final-fix-brief.md. All ten findings, with the
  I2/M4 interaction flagged. Result not yet seen.

## Ruling 59 — concerns 1 and 4 I fixed MYSELF rather than spending another round
  (commit a2ffc50). (1) `locks` now declares `requires: [{kind:'version', min:140000}]` because
  the verdict reads `pg_locks.waitstart`; query-stats.ts already declares the identical floor,
  so this is consistency, not novelty. On PG13 the check now says `unsupported-version` in
  words instead of a raw `42703 column "waitstart" does not exist`. Written TDD: test appended,
  watched fail, then the one line. (4) `build` is now `rm -rf dist && tsc`. — Why do it myself:
  two one-line changes with an existing pattern to copy; a dispatch costs more than the edit.
  — Cost if wrong: both are additive and pinned by tests; unit 489/55 and int 40/10 green after.

## Ruling 60 — PARKED concern 2: `connections` (`<`) and `wraparound` (`<=`) still
  disagree on their boundary operator. — Why: Ruling 57 standardized the RISING-quantity family
  (more sessions/waiters/age = worse). These two are FALLING quantities — headroom, transactions
  remaining — where the operator means something different, and normalizing them under a ruling
  aimed at the other family would be a change without an argument. Both are now pinned on both
  sides, so any future normalization shows up as a red test rather than a silent flip. The
  implementer was right to leave it. — Cost if wrong: a reader comparing the two files sees an
  inconsistency the tests say is deliberate.

## Ruling 61 — PARKED concern 3: the I3 integration test's result depends on wall clock
  rather than constructed state. — Why: it is testing "a long wait escalates and a short one
  does not", which IS a statement about elapsed time; there is no way to construct that without
  a clock. Margins are wide and it passed on PG17. — Cost if wrong: a flake on a loaded CI
  runner on one matrix leg. Named here so a future flake is diagnosed in seconds, not hours.

## Ruling 62 — dispatched a scoped re-review (opus) of 0df017e..a2ffc50 despite having
  verified the suites myself. — Why: unlike Task 14's fix round (three files of regex work),
  this one changed SQL and verdict SEMANTICS in I2/I3/I5. "The suite is green" is the weakest
  possible evidence for a semantics change — green is what it was before the fix too. — Cost
  if wrong: one review seat.
Verified independently at a2ffc50: unit 489/55, integration 40/10 (own throwaway containers),
all three typechecks green, tree clean, packages/checks/dist gitignored.

## Ruling 63 — fixed N1 myself (commit 10d5c88). Ruling 57's `>=` standardization left
  long-running disagreeing with ITSELF: the SQL filtered `now() - query_start > minSecs` while
  the verdict escalated at `>=`, and minSecs DEFAULTS to the warn threshold — so a query at
  exactly 60.000s was dropped by the SQL before the verdict could see it, and the check said
  `ok`. longRunning is the only check with a threshold-shaped SQL predicate, which is why it
  was the only one. Pinned at the SOURCE, not with a live query: there is no way to construct
  exactly 60.000000s against a real server, and a disagreement no test can reach is precisely
  the kind that survives. Written TDD: assertion first, watched fail, then the operator.
  — Cost if wrong: none identified; the boundary row is measure-zero in practice, so this is
  a consistency fix rather than a behavior change anyone will observe.

## Ruling 64 — PARKED the re-review's perf observation: the wait_secs subquery adds a
  third per-row pg_locks scan over up to 501 rows, during exactly the lock storm the check
  exists to diagnose. — Why: correctness first, and the shape is bounded (501 rows, one extra
  scan) with no measurement showing it matters. Optimizing an unmeasured path in the last
  commit of a branch is how correct code becomes wrong code. — Cost if wrong: the locks view
  is slower than it needs to be during an incident. Recorded as the first thing to measure if
  P1 finds the locks page sluggish.
