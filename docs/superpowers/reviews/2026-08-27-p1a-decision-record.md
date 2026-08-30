# P1a web console — decision record

Every ruling made while executing `docs/superpowers/plans/2026-08-27-p1a-console-renders.md`,
in the order made. A ruling is a decision the plan or spec did not settle, made rather than
escalated, each with what it costs if it turns out wrong. 39 of them across 11 tasks.

Branch `feat/web-console-p1a`, merge-base `d3c1e6c` (P0 merged). Companion to
`2026-08-27-p0-decision-record.md`, whose Rulings 49 and 55 bind work here.

## Ruling 1 (C1): the `web` vitest project MUST set `resolve.alias` mapping `@` to `apps/web`.

## Ruling 2 (C1b): the `web` project also needs the checks package BUILT, because `sql.tsx` and

## Ruling 3 (C2): T4 must ALSO update the root `test:int` script to build the checks package

## Ruling 4 (C3): the harness in T7 must build the web app itself rather than relying on the

## Ruling 5 (C5): T1's Step 2 RED must run AFTER the `web` project exists, or it reports "no test

## Ruling 6 (C4): T11's CI edit is APPEND-ONLY to the existing `static` and `integration` jobs. The

## Ruling 7 (C6): T8's assertion is weakened from matching `/pg_stat_statements/` to matching

## Ruling 8 (C7): T9's truncation test must CREATE the backends it needs rather than assume them.

## Ruling 9 — I did NOT accept concern 2 ("--legacy-peer-deps was needed; not exercised against a
  rendered react 19 component"). An unproven claim about the one hazard this whole task exists
  to settle is not a concern, it is an open question. I probed it directly with a hooks-using
  component and found THREE separate breakages, each of which would have surfaced at Task 5 as
  a mystery:
    (a) no JSX transform at all in the web project — every .tsx test would have failed at parse
        time. Fixed with @vitejs/plugin-react.
    (b) npm nested react 19 under apps/web but HOISTED react-dom 19 to the root beside react 18
        -> "Cannot read properties of undefined (reading 'S')". Fixed by pinning root react-dom
        to ^18.3.1, which forces npm to nest the app's 19 beside its own react.
    (c) the root vitest config resolves bare specifiers from ITS directory, so react/jsx-runtime
        came from the root's 18 while react-dom was 19 -> "Objects are not valid as a React
        child". Fixed by giving apps/web its own vitest config, rooted there.
  — Cost if wrong: none identified; all three are proven by a probe that now renders.

## Ruling 10 — DROPPED @testing-library/react in favour of a ~25-line local render helper over
  react-dom/client (apps/web/test/render.tsx). — Why: it hoists to the repo root next to react
  18 and its own require('react') finds 18, so every render failed with "Objects are not valid
  as a React child". Alias, dedupe and server.deps.inline all failed because the hoisting is
  PHYSICAL, not a resolution preference. react-dom/client used directly is the app's own copy
  and renders react 19 correctly — proven before the helper was written. This repo already
  declined a chart library on the same reasoning. The plan's Task 5 must be updated to import
  `render` from './render.js' rather than @testing-library/react, and it returns
  {container, text(), find(), unmount()} — NOT screen/getByText. — Cost if wrong: ~25 lines to
  maintain, against a dependency that could not be made to work here at all.

## Ruling 11 — accepted concern 1 (`// @vitest-environment node` on scaffold.test.ts). Under jsdom,
  Vite rewrites `new URL('../package.json', import.meta.url)` to a server-relative asset URL, so
  readFileSync throws. The file touches no DOM. — Cost if wrong: one docblock.

## Ruling 12 — accepted concern 3 (.gitignore gained `.next/` and `next-env.d.ts`). Without them
  hundreds of build-output files stage on every commit.

## Ruling 13 — the implementer's own comment said "do not fix this; wait for P1b or render Badge
  only in the browser". I overrode that. It missed the option shadcn exists FOR: shadcn vendors
  component SOURCE into the repo rather than installing a package, so badge.tsx is ours to own.
  `useRender` was there solely to support a polymorphic `render` prop, and not one Badge in this
  console is polymorphic. Replaced it with a plain <span> keeping every cva variant, and
  UNINSTALLED @base-ui/react rather than leaving it unused. — Why: "a component the test suite
  cannot render" is a hole in the wall for a whole phase, and the alternative on offer was to
  leave VerdictBadge (Task 5) untestable until P1b. — Cost if wrong: we maintain ~10 lines of a
  file shadcn would otherwise regenerate; `shadcn add badge` would overwrite it, which
  badge.test.tsx turns into a red test rather than a silent regression.

## Ruling 14 — accepted shadcn v4 (preset `nova`, base `base`) over the brief's v2 flow, which
  404s against the live registry on `add`. The implementer removed the unrequested button.tsx
  and Geist-font wiring the CLI adds by default. — Cost if wrong: the plan's Step 3 text names
  an init flow that no longer exists; the outcome is what matters and it is verified.

## Ruling 15 — Table needed no change: it is plain HTML plus `cn`, primitive-free as expected.
  The hazard was specific to Badge.

## Ruling 16 — accepted the implementer's signature change from `NodeJS.ProcessEnv` to
  `Record<string, string | undefined>`. Verified the consequence myself rather than reasoning
  about it: compiled a probe calling `readDatabases(process.env)` against apps/web's tsconfig,
  exit 0. `process.env` is assignable, so Task 4's call site is unaffected, and the looser type
  lets tests pass plain object literals without casts. — Cost if wrong: none; the assignability
  is checked by the compiler at every real call site.

## Ruling 17 — ACCEPTED deviation 2, the `connection()` E251 catch, after checking the one thing
  that made it risky. `connection()` throws `__NEXT_ERROR_CODE: 'E251'`
  (next-dynamic-api-wrong-context) only when there is NO request store at all — i.e. never
  during a render. During a real prerender it returns a HANGING PROMISE rather than throwing,
  which is the mechanism that forces dynamic rendering; that path is untouched by this catch.
  The "use cache" and `dynamic = 'error'` paths throw DIFFERENT errors and still become
  ok:false. So the swallow is narrow and the build-time-inlining guarantee holds. — Cost if
  wrong: a Next major renaming E251 makes this seam's own tests go red (loud), not production
  silently wrong. Task 7's "reads its configuration at run time, not build time" test is the
  end-to-end proof and the real net under this ruling.

## Ruling 18 — added a follow-up test the task did not have: `isMissingRequestStore` is now
  exported and pinned by four cases, three of them NEGATIVE. — Why: that predicate decides
  whether a connection() failure is swallowed or surfaced, and it was the only untested branch
  in the seam every page runs through. Swallowing the wrong thing is the dangerous direction —
  it would let a genuine dynamic-rendering failure render as a success. Testing the predicate
  directly avoids mocking `next/server`, which this repo does not do. — Cost if wrong: four
  cheap tests on a pure function.

## Ruling 19 — deviation 1 was MY plan bug, correctly caught: the brief's test read `rows[0]!.v`
  from `SHOW server_version_num`, whose column is `server_version_num`. It would have compared
  serverVersion against NaN and passed vacuously in the direction that matters. Production code
  was right; only the test was wrong. Fixed by the implementer.

## Ruling 20 — the implementer's concern was CORRECT and it exposed a design error in MY plan, not
  in their implementation. `nextTick(state, now)` branches on `inFlight` only and never reads
  `requested`, so the brief's third test ("a requested refresh still refreshes") passed for the
  same reason as the second and would have passed identically with `requested: false`. Property
  3 — the single-slot re-arm — lived only in the component's imperative useEffect, where nothing
  tested it. I split the STATE TRANSITION out beside the decision: `onTick` records a skipped
  tick and stamps startedAt at the start of the work; `onSettle` fires exactly one follow-up when
  a request arrived mid-flight and clears the flag. The component now routes every transition
  through them, so the tested functions are the ones that actually run — testing functions
  nobody calls would have been worse than the original vacuity. — Cost if wrong: two small pure
  functions and six tests; the alternative was shipping a claimed property with no test behind
  it, in the one component whose entire justification is those three properties.
  Both mutation-proven: deleting onSettle's re-arm branch reddens exactly one test, and so does
  making onTick drop the skipped tick.
  I asked for this in the dispatch ("if you believe any of the three properties is NOT actually
  enforced, say so plainly rather than reporting green") and got it. Worth repeating in later
  dispatches where a pure/impure split hides behaviour.

## Ruling 21 — the repo-wide ESM `.js` import convention DOES NOT hold inside apps/web's app, lib
  and components. Next's bundler resolves relative imports against real files on disk and cannot
  map `./x.js` onto a sibling `x.tsx`. Neither tsc nor vitest reproduces it — both rewrite the
  specifier — so it surfaces ONLY at `next build`, which is why Task 7 hit it and Tasks 3-6 did
  not. The implementer fixed lib/ and flagged that components/check-panel.tsx carried the same
  pattern and would fail the moment a page imported it. I fixed that preemptively and PROVED it
  with a throwaway page importing CheckPanel: compiled successfully. — Why fix now: Task 8 wires
  CheckPanel into the triage page and would have burned a fix round on a known defect.
  — Cost if wrong: apps/web diverges from the repo convention; the divergence is documented in
  check-panel.tsx and carried into every remaining dispatch. `apps/web/test` keeps `.js` because
  it runs under vitest, not Next.

## Ruling 22 — accepted the force-static proof with a noted caveat. Adding `dynamic = 'force-static'`
  DID fail both tests, so the assertion is not decorative — but it failed as a BUILD CRASH
  (`ConfigError: No database configured`, static generation evaluating databaseNames() with no
  env at build time) rather than as stale content. That is a stronger failure, not a weaker one:
  the build refuses rather than silently baking in a wrong database. The caveat is that it
  depends on no config being present at build time; a Docker build that happened to set
  DATABASE_URL would prerender successfully. Task 11's source-scanning guard is the complementary
  protection and now matters more, not less. — Cost if wrong: an exotic build configuration could
  prerender; the guard test catches the source-level cause either way.

## Ruling 23 — TWO plan defects in Data field names, found by the compiler as the plan's own
  self-review predicted, and corrected inline by the implementer:
    sessionStates: plan said `d.states` / {state,count,longestSecs}; real StatesData is
      {byState: {state,sessions,longestInStateSecs}[], oldestIdleInTxnSecs}.
    wraparound: plan said `d.pctToForcedVacuum`; real WraparoundData is {worst: WraparoundEntry[]}
      — the field lives on d.worst[0], not on Data.

## Ruling 24 — I then checked Tasks 9 and 10's field names MYSELF against the real interfaces
  rather than letting each task rediscover the same class of defect. Task 9 (sessions, locks)
  is entirely correct, including `Waiter.waitSecs`, which only exists because of P0's Ruling 56.
  Task 10 was WRONG in four ways and is now fixed in the plan:
    d.queries -> d.rows (QueryStatsData has `rows: QueryStatRowData[]`)
    d.truncated -> DOES NOT EXIST; truncation is `rows.length < totalShapes`, because
      totalShapes is every shape visible to the role BEFORE the LIMIT
    q.totalSecs/q.meanSecs -> q.totalMs/q.meanMs, and they are MILLISECONDS: the plan would
      have rendered a 250ms query as "250h 0m" with no test catching it, since formatDuration
      accepts any number
    q.redacted was unhandled — Postgres withholds query TEXT from an unprivileged role but
      keeps the ROW, so the plan would have rendered an empty cell reading as "no query"
  — Cost if wrong: none; each is now compiler-checked at the call site.

## Ruling 25 — Task 10's `/pg_stat_statements/` assertion STAYS, now that the message text is
  known from a real run rather than invented: reason `missing-extension`, message
  `relation "pg_stat_statements" does not exist`, remedy `CREATE EXTENSION pg_stat_statements;`.
  Ruling 7 (weaken it) is discharged.

## Ruling 26 — OVERRODE my own Global Constraint ("packages/checks is not modified by this plan")
  to add per-check type exports to its barrel. The barrel exported the FRAMEWORK (Check,
  CheckResult, Verdict, CHECKS) but none of the shapes those generics resolve to, so a consumer
  rendering CHECKS.locks's output could not name a `Waiter`. The implementer worked around it
  correctly — deriving the type structurally as
  `ReturnType<typeof CHECKS.locks.map>['roots'][number]['waiters'][number]` — but that is
  unreadable and silently reshapes if the check's return type changes. — Why override: the
  constraint exists to stop P1a destabilising a reviewed package, and `export type *` is
  ADDITIVE with no runtime effect; the package's 490 unit tests and its own boundary suite are
  unchanged, and the check objects stay reachable only through CHECKS so no second way to get a
  check appears. The alternative was every page deriving domain types by indexing. — Cost if
  wrong: the package's public surface is wider than P0 designed it; nothing depends on it being
  narrow, and the boundary tests that DO matter (dependencies === ["pg"], no non-pg imports)
  are untouched.

## Ruling 27 — verified the truncation test is DISCRIMINATING myself, since the implementer could
  not prove it on this machine (a single request already opens up to Pool.max=10 backends, so
  ambient state satisfies the >1-backend precondition regardless). Neutered the truncation
  notice in sessions/page.tsx and the test went red on exactly that assertion. So the test pins
  the RENDERING, which is what matters; the two extra connections make its precondition
  deterministic on a quiet machine rather than being load-bearing here.

## Ruling 28 — accepted `url` added to harness.ts's `Console` interface. The corrected truncation
  test needs the container's raw connection string to hold connections open across a fetch, and
  `sql()` opens and closes per call. Reasonable widening of a test helper.

## Ruling 29 — accepted the implementer's fix to MY guard regex, which self-triggered: the brief's
  pattern for "a query rendered outside Sql" matched `<Sql>{s.query}</Sql>` too, because the
  correct code contains the same substring as the violation. It flagged all three legitimate
  usages as offenders. Fixed with a lookbehind/lookahead excluding the wrapper shape. — This is
  the SECOND time in this project a source-scanning guard has self-triggered on correct code
  (P0's import guard matched the phrase `from "no slow queries"` in a comment). The lesson is
  general: a guard that greps for a violation must exclude the correct form FIRST, because the
  correct form usually contains the violation as a substring. — Cost if wrong: none; all four
  violations still redden their own guard and no other.

## Ruling 30 — C1 was MY defect, from the plan: `runCheckFor(name, c as Parameters<typeof
  runCheckFor>[1])` in app/page.tsx. `Parameters<…>[1]` resolves against the IMPLEMENTATION
  signature, so the cast erased the two-overload arity guard and three opts-bearing checks ran
  with no options. Every healthy database rendered a permanent false "3 unavailable", and
  longRunning — the check whose whole job is escalating a runaway query — could never run on the
  front door. It is the SAME defect P0's final review fixed inside packages/checks, reintroduced
  one layer up by a cast, by me, after I wrote the ruling explaining why. Invisible for nine
  tasks because runCheck never rejects: three permanently-broken checks render identically to
  three a database declined to answer. Fixed with nine explicit compiler-policed calls plus a
  guard asserting the page covers every `class: 'incident'` check.

## Ruling 31 — C2's real protection is the END-TO-END test, not the widened regex. The source guard
  walked app/ only and matched one spelling; a components/ file, a destructured `{query}` and a
  sliced `{s.query?.slice(...)}` each put an unredacted pg_stat_activity.query on a URL with
  every gate green. The guard is widened, but the guarantee now rests on an integration test
  that holds two backends open (an idle one whose last statement was CREATE ROLE ... PASSWORD,
  an active one running a connection URI), fetches all five routes and asserts the sentinel
  appears in none — plus a POSITIVE `***` assertion so it cannot pass by rendering nothing.
  — Cost if wrong: a regex can be evaded by a shape nobody thought of; the HTML assertion cannot.

## Ruling 32 — Ruling 22 was REFUTED and is withdrawn. `export const dynamic = 'force-static'`
  passed all four guards, and with DATABASE_URL present at build the build SUCCEEDS and bakes
  /db/default into static HTML. I had fallen back on "the guard is complementary protection" —
  which the plan itself had already said was inadequate for this case. Now guarded directly.

## Ruling 33 — I2: the refresh ticker delivered NONE of property 1. `setTimeout(…, 0)` against a
  5000ms interval means inFlight is false at every tick. Replayed: 10 refreshes issued, 0 ticks
  skipped, 5 concurrent renders — on triage, 40 in-flight queries against a database already too
  slow to answer. Spec §6.3 property 1 exists verbatim "so the tool cannot add load to the
  database it is diagnosing". My Ruling 20 fixed the TEST vacuity and left production untouched;
  the tests pinned pure functions whose interesting branches production never reached. Fixed with
  useTransition — whose isPending IS the completion signal my own comment claimed Next does not
  expose. After: 2 issued, 8 skipped, peak 1.

## Ruling 34 — took M3 and M4 myself rather than a second dispatch. M3: five files claimed
  process.env is TEXTUALLY INLINED at build time; it is not — a build leaves
  `process.env.X??"50"` intact in the server chunk. The real mechanism is EVALUATION at prerender
  time, freezing the result into HTML. Discipline right, stated reason wrong — and a maintainer
  who checks the claim finds no inlining and concludes the rule is cargo cult. M4: the .js-import
  divergence was guarded only by `next build`, which CI's FAST job never runs, so a PR "fixing"
  the convention back passes the fast job and fails four legs later. Both fixed; M4's guard
  proven by making exactly that change and watching it redden. — Cost if wrong: comment-only
  plus one guard.

## Ruling 35 — C2's real defect was not the regex's fourth bypass, it was that the END-TO-END proof
  was DATA-dependent rather than shape-independent. Of the five routes it fetched, only
  /db/primary/sessions rendered any query text: triage renders none, locks had no contention,
  and queries was Unavailable because pg_stat_statements is never created in that container. So
  three of five fetches proved nothing, and a raw-rendered query on locks or queries shipped with
  every gate green. Fixed by making each leak-capable route capable of leaking — CREATE EXTENSION
  before the CREATE ROLE (utility statements are stored VERBATIM in pg_stat_statements; constants
  normalise to $1 only for NON-utility statements, which is exactly why a password reaches that
  page), and real ACCESS EXCLUSIVE contention so locks renders a waiter's query — and by
  extending the positive `***` assertion to all three. Proven: unwrapping one <Sql> on locks now
  fails with "/db/primary/locks leaked the password", on a route the old test fetched and could
  never have caught anything on. — Cost if wrong: the test is slower and needs a table; the
  alternative was a negative assertion that was trivially true on four of five routes.

## Ruling 36 — the regex's fourth bypass (a block-bodied map callback lifting the value out first)
  is NOT chased. Documented beside the guard instead, with the honest statement that the space of
  spellings is open and this is an authoring aid while the guarantee lives in the rendered HTML.
  — Why: an arms race against shapes nobody has thought of cannot be won, and a guard that
  implies more coverage than it has is worse than one that admits its edges. Ruling 35 makes the
  e2e catch it regardless of shape. — Cost if wrong: an exotic shape reaches review; the HTML
  assertion still fails.

## Ruling 37 — the three guard gaps are closed, each verified by introducing the exact violation:
  (a) the .js guard matched single-quoted RELATIVE imports only — 2 files covered, 7 missed,
      because every file under app/ imports through the `@/` alias and `@/lib/check.js` fails
      `next build` exactly as `./pools.js` does;
  (b) `sources()` filtered .ts|.tsx while its own RENDERABLE regex advertised jsx|js, so
      app/status/page.jsx carrying force-static prerendered with the BUILD machine's database
      baked into .next/server/app/status.html;
  (c) the redaction matcher flagged TypeScript TYPE literals naming `query`, so a correct
      component with a query-bearing props type reddened it — which is how a guard gets deleted
      by the next person it annoys. Now skips spans containing a semicolon.

## Ruling 38 — fixed M3's leftover: check.ts still said "the build-time-inlining guarantee" eight
  lines above the paragraph explaining there is no inlining.

## Ruling 39 — PARKED the re-review's two bounded limits on C1's coverage guard, rather than
  chasing them. (a) It hardcodes the identifier `name`, so a behaviour-preserving rename to `db`
  reddens it with a misleading message. (b) It checks MENTION, not participation: a
  feature-flagged `CHECKS.slots` call keeps it green while the check leaves the front door.
  — Why: both are failures in the SAFE direction — (a) fails loudly on a rename, which is
  annoying but visible, and (b) requires someone to deliberately flag a check off the overview,
  which is a code-review question rather than an accident. The alternative is parsing the page's
  AST, which is a large step for a guard whose job is catching a forgotten line. — Cost if
  wrong: a rename costs one confusing test failure; a deliberately flagged-off check reaches
  review unguarded. Recorded so a future maintainer knows the limit is chosen, not missed.
