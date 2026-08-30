# P1a — final whole-branch review

Branch `feat/web-console-p1a`, 20 commits, `d3c1e6c..0685590`. Nothing pushed or merged.
Reviewed against the spec (binding), the plan, and the 29 rulings in
`final-review-attention.md`.

**Counts: 2 Critical · 4 Important · 8 Minor.**

**Verdict: do not hand off as-is.** Both Critical findings sit inside the two
properties this phase claims to rest on, and both are green under every gate the
phase built. Each is a one-file fix; with C1, C2 and I1 addressed the branch is
sound and the architecture underneath it is right.

---

## Baseline, verified by execution

Everything the dispatch claimed is true. Run on this machine, from a clean tree:

| Gate | Result |
|---|---|
| `npm test` | 490 passed / 55 files |
| `npm run test:web` | 43 passed / 9 files |
| `npm run test:int` | 54 passed / 12 files, 86.7s |
| `npm run typecheck` | pass |
| `npm run typecheck:test` | pass |
| `npm run --workspace @pgops/checks typecheck` | pass |
| `npm run --workspace @pgops/web typecheck` | pass |
| `npm run --workspace @pgops/web build` | pass; `/`, `/db/[name]`, `/sessions`, `/locks`, `/queries` all `ƒ (Dynamic)` |

Scope constraints hold: `src/` is untouched (`git diff --stat -- src/` is empty);
`packages/checks` changed only by additive `export type *` lines.

I also booted the artifact P1b will actually ship —
`node apps/web/.next/standalone/apps/web/server.js` with a `DATABASE_URL` that did
not exist at build time — and it served `/` with HTTP 200 rendering `/db/default`.
`pg` is correctly traced into `standalone/node_modules`. That de-risks P1b.

**Everything I broke below was reverted.** Final `git status --short` and
`git diff HEAD` are both empty, and the full sweep above was re-run green afterward.

---

## CRITICAL

### C1 — The overview runs three of nine incident checks with no options, so `/` permanently reports "3 unavailable" and computes its verdict from six checks

`apps/web/app/page.tsx:21`

```ts
Object.values(CHECKS)
  .filter((c) => c.class === 'incident')
  .map((c) => runCheckFor(name, c as Parameters<typeof runCheckFor>[1])),
```

`Parameters<typeof runCheckFor>[1]` resolves against the implementation signature,
so the cast erases the two-overload arity guard. Three of the nine incident checks
build their SQL from options:

```
longRunning    THROWS: Cannot read properties of undefined (reading 'minSecs')
queryStats     THROWS: Cannot read properties of undefined (reading 'sort')
sessions       THROWS: Cannot read properties of undefined (reading 'limit')
```

Confirmed against a real Postgres 17 container, replaying the page's exact call
shape (`runCheck(ctx, check)` with no opts) against a database with nothing wrong:

```
   longRunning    ok:false reason=error "Cannot read properties of undefined (reading 'minSecs')"
   queryStats     ok:false reason=error "Cannot read properties of undefined (reading 'sort')"
   sessions       ok:false reason=error "Cannot read properties of undefined (reading 'limit')"

overview renders: verdict=ok, "3 unavailable" — against a database with NOTHING wrong.
```

**Why this is Critical, not cosmetic.** `/` is the front door — its own docblock
says it answers "is anything wrong anywhere?", and that `"we could not look" and
"we looked and it is fine" must never render the same`. `longRunning` is the check
whose entire job is to escalate a runaway query. On the overview it can never run.
A database with a 40-minute runaway query renders `OK · 3 unavailable`. And the
"3 unavailable" is permanent and false on every healthy database, which trains the
operator to ignore the one number on the page that means "look closer".

This is precisely the defect `packages/checks/src/run.ts` was rewritten to prevent.
Its own I1 docblock names these exact strings:

> `runCheck(ctx, sessions)` typechecked, then `check.sql(undefined)` dereferenced
> undefined at runtime — and since this function never rejects, that TypeError came
> back as an ordinary failed check ("Cannot read properties of undefined (reading
> 'limit')") rendered on the incident page, where it reads as the DATABASE being
> unwell. […] the arity has to be enforced by the compiler.

The compiler *would* have caught it. Removing the cast (verified):

```
app/page.tsx(21,37): error TS2345: Argument of type 'Check<BlockedRow, …> | … ' is not
assignable to parameter of type 'Check<BlockedRow, BlockedData, void>'.
```

Nothing catches it today: `routes.int.test.ts`'s two overview tests assert only
`toContain('primary')` and `/OK|WARN|CRITICAL/`, both of which hold.

Note also that the plan's own Self-Review asserts the opposite: *"`runCheckFor` […]
is used consistently: two arguments for void-opts checks […], three for opts-bearing
ones."* That claim is false at exactly one call site, and the cast is what hid it.

**Fix.** Replace the `Object.values` sweep with an explicit list carrying each
check's opts (the triage page already has the correct spellings), or a small typed
`runIncidentChecks(name)` helper with a switch. Do not reintroduce the cast.

---

### C2 — The redaction guarantee has three unguarded bypasses; the worst is that `components/` is never scanned

`apps/web/test/guards.test.ts:80-90` walks `APP` only, and matches only the literal
shape `{<ident>.query}` / `{<ident>.query ?? …}`.

Three bypasses, each proven: the code **compiles clean** (`tsc --noEmit` exit 0) and
**all four guards plus the full 43-test web suite stay green**.

**(a) Render the query from a component — `components/` is not scanned at all.**
I added `apps/web/components/session-row.tsx` rendering
`<TableCell className="max-w-md truncate">{s.query}</TableCell>` and wired it into
`sessions/page.tsx`. Result: `tsc` clean, `Test Files 9 passed (9) · Tests 43 passed (43)`.

**(b) Destructure the row.**
`{d.sessions.map(({ pid, state, queryAgeSecs, user, app, query }) => … <pre>{query}</pre>)}`
— no `\w+\.` prefix, so the regex never sees it. `tsc` clean, guards green.

**(c) Truncate server-side.** `{s.query?.slice(0, 120)}` — the regex requires `}`
or `??` immediately after `.query`. `tsc` clean, guards green. This is the single
most likely real change: the cell already carries `max-w-md truncate`.

**The concrete leak.** With any of the three in place, a statement caught in
`pg_stat_activity.query` renders verbatim into the HTML at `/db/x/sessions`:

```
raw     : ALTER USER app PASSWORD 'hunter2'
redacted: ALTER USER app PASSWORD ***

raw     : SELECT dblink_connect('postgres://u:hunter2@h/db')
redacted: SELECT dblink_connect('postgres://u:***@h/db')
```

Spec §7.3's entire argument is that this matters more on the web than in the
terminal because *"a screenshot needs a human to take it, a URL forwards itself."*

**On the charge's question — did the narrowing open the hole?** No. The
lookbehind/lookahead from Ruling 29 is correct: it excludes exactly the
`<Sql>…</Sql>` wrapper and nothing else. The hole is that the guard was scoped to
`APP` from the start — the plan's Task 11 text has the same scope — while the
sibling `new Pool` guard in the same file *does* walk `[...walk(APP), ...walk(COMPONENTS)]`.
The redaction guard was simply never given the same list. Bypass (a) is the most
dangerous because this codebase already factors rendering into components
(`check-panel`, `verdict-badge`, `nav`), so the first natural refactor removes the
guarantee silently.

**Fix.** Two changes, both small:
1. Walk `COMPONENTS` as well as `APP`, excluding `sql.tsx` itself.
2. Stop grepping for one spelling of the violation. Assert the allowed shape instead:
   in any file other than `sql.tsx`, no identifier named `query` and no `.query`
   member expression may appear inside JSX braces. Ruling 29's lesson ("exclude the
   correct form first") is right but incomplete — a guard that greps for a *spelling*
   of a violation can only ever catch that spelling.

---

## IMPORTANT

### I1 — Ruling 22 is wrong: the guard does not catch `force-static`, and with build-time config present the build succeeds and bakes in the wrong database

Ruling 22 accepted the `force-static` proof with a caveat, and closed by saying
*"Task 11's source-scanning guard is the complementary protection and now matters
more, not less."* It is not protection. The guard checks only for the **presence**
of `await connection()` or `runCheckFor(`; it never looks at route-segment config
that neutralises them.

Proven. `export const dynamic = 'force-static'` added to `app/page.tsx`, then:

```
--- guards: Test Files 1 passed (1) · Tests 4 passed (4)
--- DATABASE_URL='postgres://…' npm run --workspace @pgops/web build
Route (app)
┌ ○ /                      <-- was ƒ
├ ○ /_not-found
├ ƒ /db/[name]
…
```

and the baked artifact:

```
$ grep -o '/db/[a-z]*' apps/web/.next/server/app/index.html | sort -u
/db/default
```

The build-time database, frozen into HTML, forever. All four guards green; `npm test`,
`npm run test:web` and all four typechecks green.

The plan's own Task 11 Step 2 says *"Add `export const dynamic = 'force-static'` is
not enough"* — so Ruling 22 leans on a guard the plan had already declared inadequate
for this exact case. The only thing that catches it today is
`routes.int.test.ts`'s `expect(html).not.toContain('/db/default')`, which covers `/`
only, and only because the harness happens to build with no env in scope. The four
`/db/[name]*` routes have no equivalent assertion at all. Spec §9's row is *"Build an
image with one `DATABASE_URL`, run it with another, assert it uses the second"* — the
harness builds with **none**, which does not distinguish these cases.

**Fix (three lines, in the repo's own idiom).** In `guards.test.ts`, assert that no
file under `app/` exports `dynamic`, `revalidate`, `fetchCache` or `dynamicParams`
with a static value, and that none contains `'use cache'`. That is spec §6.1's
"enforced by lint rule" expressed the way this repo already expresses such rules,
and it closes the case the current guard was explicitly told it could not cover.

---

### I2 — The refresh ticker delivers none of property 1; the load it exists to prevent is the load it produces

`apps/web/components/refresh.tsx:88-92` ends the "flight" with `setTimeout(…, 0)`
— one macrotask after `router.refresh()`, which is fire-and-forget. The interval is
5000 ms. So `inFlight` is false at every tick, always.

Executed simulation of the effect body verbatim against the exported pure functions,
with a server render taking five intervals:

```
interval=200ms, server render=1000ms
refreshes issued : 10
ticks SKIPPED    : 0   <- property 1 ("skipped, not queued")
peak CONCURRENT server renders against the database: 5
```

On the triage page that is 5 concurrent renders × 8 checks = 40 in-flight queries
against a database already too slow to answer within one interval. Spec §6.3 property
1 exists verbatim *"so the tool cannot add load to the database it is diagnosing"*.

Consequences:
- `onSettle`'s re-arm branch is dead in production: `requested` can only be set by
  the skip branch, which never fires.
- Property 3 has no production trigger in P1a anyway (no operator-facing refresh
  control; the spec frames it as "the refresh fired after a kill", and kill is P1b).
- Property 2 **is** delivered — `startedAt` is stamped at start and the label
  recomputes when the refreshed tree commits.

Ruling 20 correctly diagnosed and fixed the *test* vacuity, and its mutation proofs
are real. But the properties themselves are still not enforced: the tests now pin
pure functions whose interesting branches production never reaches.

**Fix inside P1a's budget.** `startTransition(() => router.refresh())` with
`useTransition`'s `isPending` as `inFlight`. That is exactly the completion signal
the code comment says Next does not expose — it does, through the transition.

---

### I3 — `queries/page.tsx` keys rows by `queryid`, which `pg_stat_statements` does not make unique

`apps/web/app/db/[name]/queries/page.tsx:50` — `key={q.queryid ?? \`row-${i}\`}`.

`pg_stat_statements` is keyed by `(userid, dbid, queryid, toplevel)`. The check's SQL
filters `toplevel` and `dbid` but **not** `userid`, and does not aggregate. Two roles
running the same normalized statement produce two rows with the same `queryid`.

Proven on a real PG 17 container with `pg_stat_statements` loaded, running
`SELECT id FROM widgets WHERE id = $1` as `postgres` and as a second role `reporting`:

```
rows returned      : 3
DUPLICATE queryids : ["5551397081270176873"]
   key=5551397081270176873  calls=1  query="SELECT id FROM widgets WHERE id = $1"
   key=5551397081270176873  calls=1  query="SELECT id FROM widgets WHERE id = $1"
```

Rendered through this repo's own `render` helper, React 19 says:

> Encountered two children with the same key, `5551397081270176873`. Keys should be
> unique so that components maintain their identity across updates. Non-unique keys
> may cause children to be duplicated and/or omitted — the behavior is unsupported
> and could change in a future version.

Both rows mount initially. But this page re-renders every 5 s via `router.refresh()`,
and reconciliation across those updates is explicitly unsupported — so on the page
that ranks queries by cost, calls/total/mean can attach to the wrong row.

**Fix.** `key={\`${q.queryid ?? 'null'}-${i}\`}`. One line.

---

### I4 — The web integration tests are pinned to PG 17 and run twice in every matrix leg

Two problems in one place.

**The matrix does not reach the console.** `apps/web/test/harness.ts:71` and
`apps/web/test/check.int.test.ts:8` both hardcode `postgres:17-alpine`.
`packages/checks/test/global-setup.ts` correctly reads `PGOPS_TEST_PG_VERSION`, and
CI sets it per matrix leg — but the web tests ignore it. So the PG 14 leg (the
declared floor), 16 and 18 all render pages against PG 17. The Global Constraint
"CI matrix 14, 16, 17, 18" does not hold for anything in `apps/web`.

**And the same suite runs twice per leg.** `npm run test:int` already includes the
web files — verified:

```
$ npx vitest list --project integration
[integration] apps/web/test/check.int.test.ts
[integration] apps/web/test/routes.int.test.ts
[integration] packages/checks/test/…  (10 more)
```

CI's `integration` job then adds `npm run --workspace @pgops/web build` plus
`npx vitest run --project integration apps/web/test`, re-running those two files —
and their nine `next build`s — a second time, in all four legs, against a
`timeout-minutes: 20`.

**Fix.** Read `PGOPS_TEST_PG_VERSION` in both files (one line each, same expression
as `global-setup.ts`), and delete the duplicate CI step.

---

## MINOR

**M1 — `@testing-library/react` was never actually uninstalled.** It and
`@testing-library/dom` are still declared in `apps/web/package.json` devDependencies
and still installed, hoisted to `node_modules/@testing-library/react` beside react 18.
Ruling 10 says the package was "DROPPED"; the code stopped importing it, but nothing
stops the next person importing it — the specifier resolves, and they rediscover
"Objects are not valid as a React child" from scratch. Contrast Ruling 13, which did
this properly: `@base-ui/react` is genuinely gone (0 occurrences in `package-lock.json`,
absent from disk) and `badge.test.tsx` keeps it out. Two lines to remove.

**M2 — `lucide-react` is the same trap, still armed.** Declared as a runtime
dependency of `apps/web`, imported by no source file, hoisted to the repo root beside
react 18. It renders React components. The first icon anyone adds reproduces Ruling
13's `"Cannot read properties of null (reading 'useRef')"` in a new file, with no test
guarding it. Either nest it or drop it until something uses it. (`shadcn` in
`dependencies` is fine — `globals.css` imports `shadcn/tailwind.css`.)

**M3 — The mechanism cited in five files' comments is not the mechanism this build
exhibits.** I put `const DEFAULT_LIMIT = Number(process.env.PGOPS_SESSION_LIMIT ?? '50')`
at module scope in `sessions/page.tsx` and built. The server chunk still contains
`process.env.PGOPS_SESSION_LIMIT??"50"` — Turbopack does **not** textually inline
server-side env. The real mechanism is prerender-time *evaluation*: a statically
prerendered route runs `process.env` in the build process and freezes the **result**
into HTML (proved in I1). The discipline is right and the constraint is right; the
stated reason is wrong, and it is repeated in `lib/check.ts`, `app/page.tsx`,
`db/[name]/layout.tsx`, `guards.test.ts` and the plan. A maintainer who checks the
claim will find no inlining and may conclude the `connection()` rule is cargo cult.
One sentence's correction in `lib/check.ts`, which the others cite.

**M4 — Ruling 21 is correct and under-protected.** I verified its factual basis
exactly: changing `from './pools'` to `from './pools.js'` in `lib/check.ts` passes
`tsc --noEmit` **and** all 43 web tests, and fails only at
`next build` — `Module not found: Can't resolve './pools.js'`. So the divergence is
necessary and the failure is invisible to two of three gates. But that makes the
*only* gate the slowest one: CI's `static` job never builds the web app, so a PR that
"fixes" the convention back passes the fast job and fails in the 4-leg integration
matrix. The comments in `check.ts`, `pools.ts` and `check-panel.tsx` are good, but the
five files under `app/` carry no note and there is no repo-level record. This repo's
own idiom is enforcement: four lines in `guards.test.ts` asserting no relative import
under `app/`, `lib/`, `components/` ends in `.js` moves it to the fast job.

**M5 — A malformed URL renders as a database failure.**
`sessions/page.tsx:17-19` validates only `Number.isFinite(parsed) && parsed > 0`.
Verified against real PG 17: `runCheck(ctx, CHECKS.sessions, { limit: 2.5 })` returns
`ok:false … "invalid input syntax for type bigint: \"2.5\""`, so
`/db/x/sessions?limit=2.5` renders the whole page as `Unavailable — error`. Same
misattribution class `run.ts`'s I1 docblock is about. `Number.isInteger` plus an upper
clamp fixes it.

**M6 — The dynamic guard's filename filter is narrower than Next's.** It matches only
`/(page|layout)\.tsx$`. The effective `pageExtensions` is `["tsx","ts","jsx","js"]`,
and Next also renders `template.tsx`, `default.tsx` and `error.tsx`. Any of those
reading configuration is invisible. Cheap to widen while fixing I1.

**M7 — The harness proves the console against a server mode that will not ship.**
Every `withConsole` run prints
`⚠ "next start" does not work with "output: standalone" configuration. Use "node .next/standalone/server.js" instead.`
I booted the real artifact and it works (see Baseline), so this is not a defect — but
the truncation test's own recorded caveat in `task-9-report.md` already traces one
flakiness to `next start`'s ambient connections, which the standalone server does not
have. Recording it so P1b does not rediscover it; switching the harness entrypoint is
a P1b-sized change.

**M8 — Ruling 17 is correct, but its non-E251 path has the wrong shape.** Confirmed
the ruling: a real prerender never reaches the catch — the ordinary build marks every
route `ƒ` (the hanging-promise mechanism working), and under `force-static`
`connection()` resolves rather than throwing (I1's build succeeded). The swallow is
narrow and safe. The shape note: if `connection()` ever *does* throw something other
than E251, `runCheckFor` converts a framework/configuration error into
`{ok:false, reason:'error'}` for every check, and the triage page renders eight
"Unavailable" panels that read as the database being down. A framework
misconfiguration should not be presented as a database failure.

---

## Adjudication of the five flagged rulings

**Ruling 26 (overriding "packages/checks is not modified") — correctly decided.**
Verified rather than reasoned: the runtime export surface is unchanged
(`ACTIONS, CHECKS, PGHERO, parityBacklog, redactSecrets, runCheck` — identical before
and after), there are **no duplicate type names** across the nine re-exported modules
plus `types.ts`, so nothing is silently dropped by `export *`, and the package's 490
unit tests and both boundary assertions are untouched. The structural derivation it
replaced (`ReturnType<typeof CHECKS.locks.map>['roots'][number]['waiters'][number]`)
would have reshaped silently on any change to the check's return type. This was the
right override, made for the right reason, at the right cost.

**Ruling 22 (the force-static proof) — this permits a concrete failure. See I1.**
The caveat you flagged is real, and the protection the ruling falls back on does not
exist. Proven end to end: guards green, build succeeds, `/db/default` baked into
`.next/server/app/index.html`.

**Ruling 17 (swallowing E251) — correctly decided.** Confirmed by two independent
observations, not by reading. See M8 for one shape note that does not change the verdict.

**Ruling 21 (the `.js` divergence) — correctly decided, under-protected.** Factual
basis reproduced exactly. Documentation is adequate for anyone who opens the three
files that carry the note, and absent everywhere else; the only enforcement is the
slowest CI job. See M4 for a four-line fix in the idiom this repo already uses.

**Rulings 10 and 13 (testing-library and Badge) — correctly decided; I could not find
a simpler workspace fix that is legal here.** Verified: `src/` never imports
`react-dom` anywhere, so the root `react-dom@^18.3.1` really is a devDependency
declared purely to steer npm's hoisting — undocumented in `package.json` and not a
contractual guarantee of npm, but it works and `npm ls` confirms
`node_modules/react-dom@18.3.1` beside `apps/web/node_modules/react-dom@19.2.8`.
The only structurally simpler fix is to stop the *root* being a react package at all
— move the Ink TUI into its own workspace (`apps/tui`) so `apps/web`'s react 19
hoists cleanly and testing-library and `@base-ui/react` both resolve correctly. That
would make all four workarounds unnecessary at once. It is forbidden by this plan's
own Global Constraint (`src/` is not modified) and made moot by P1b deleting the TUI,
so deferring was right. npm offers no lighter lever: `overrides` cannot express two
majors, and `nohoist` is a yarn-v1 feature.

Ruling 13 is the stronger of the two, because it also uninstalled the offending
package and pinned the decision with `badge.test.tsx`. Ruling 10 did neither, and
left a live sibling of the same trap in place — see M1 and M2.

## Other rulings

No dispute with 1–9, 11, 12, 14–16, 18–20, 23–25, 27–29. Two observations:

- **Ruling 24's discipline is what would have caught C1.** You checked Tasks 9 and 10's
  field names yourself rather than letting each task rediscover the same class of
  defect, and found four errors. The same class of defect — a call site the compiler
  was supposed to police — went unchecked at `app/page.tsx:21`, because a cast turned
  the compiler off. The plan's Self-Review even asserts the property that call site
  violates. Worth carrying into P1b: *any* `as` cast at a seam the plan claims is
  compiler-enforced deserves the Ruling-24 treatment.
- **Ruling 29's lesson is right but one level too shallow.** "Exclude the correct form
  first" is true. The deeper rule, from C2: a guard that greps for a *spelling* of a
  violation can only ever catch that spelling. Assert the permitted shape, not the
  forbidden one.

---

## What I broke, and confirmation it was reverted

Every experiment below was performed on the working tree and then restored from a
tar snapshot taken before any change.

| Experiment | Expected | Observed |
|---|---|---|
| Remove `await connection()` from `db/[name]/layout.tsx` | guard reddens | reddens (control) |
| Unwrap `<Sql>{s.query}</Sql>` in `sessions/page.tsx` | guard reddens | reddens (control) |
| Destructure `query` and render it raw | HOLE | tsc clean, 4/4 guards green |
| `{s.query?.slice(0, 120)}` | HOLE | tsc clean, 4/4 guards green |
| Render query from `components/session-row.tsx` | HOLE | tsc clean, 43/43 web tests green |
| Page reaching config via `contextFor` only | HOLE | tsc clean, 4/4 guards green |
| `export const dynamic = 'force-static'` on `app/page.tsx` | HOLE | guards green; `/` prerendered with `/db/default` baked in |
| Module-scope `process.env` beside `runCheckFor` | inlined? | guard green, but **not** inlined by Turbopack — see M3 |
| `from './pools.js'` in `lib/check.ts` | build fails | tsc + 43 tests pass; `next build` fails (Ruling 21 confirmed) |
| Remove the `Parameters<…>` cast in `app/page.tsx` | compiler catches | TS2345, as expected (C1) |

Post-review state: `git status --short` empty, `git diff HEAD` empty, and the full
verification sweep re-run green (490/55, 43/9, four typechecks, build with every
route `ƒ`). No git command that writes history was run; the developer's `pgops-dev`
container on 55432 was never contacted. All containers I started were throwaway
testcontainers, all stopped.
