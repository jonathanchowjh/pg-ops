# P1a — scoped re-review of the fix round

Range `0685590..043d1ce` (2 commits) on `feat/web-console-p1a`, against
`final-review.md`'s C1, C2, I1–I4, M1–M8 and the decisions in `final-fix-brief.md`.
Scope: did these fixes close what they claim, without introducing new defects.
Nothing else on the branch was re-reviewed.

Everything below was verified by execution. Every probe was reverted; the tree is
clean (`git status --short` empty, `git diff HEAD` empty) and the full sweep was
re-run green afterward. No writing git command was run. The developer's `pgops-dev`
container on 55432 was never contacted; the only containers used were the suites'
own throwaway testcontainers, and the only servers started were `next start` on
port 3199 against a throwaway build, all stopped.

---

## Verdicts

| Finding | Verdict |
|---|---|
| C1 — overview arity cast | **closed** (guard has two bounded limitations, below) |
| C2 — redaction bypasses | **NOT CLOSED** — a fourth shape defeats the new guard, and the end-to-end test is not shape-independent; also **closed-with-a-new-problem** (false positives) |
| I1 — `force-static` | **closed with a gap** — `.jsx`/`.js` route files are not scanned |
| I2 — refresh ticker's dead skip path | **closed**, confirmed in a real browser |
| I3 — duplicate React keys | **closed** |
| I4 — PG pinning + duplicated CI run | **closed** |
| M1/M2 — hoisted react-18 traps | **closed** |
| M8 — framework-vs-database error shape | **closed** |
| M3 — the prerender mechanism | **closed with one leftover** |
| M4 — `.js`-import guard | **NOT CLOSED** — two unguarded spellings, both proven to break `next build` |

**New defects introduced by the fixes: 1** (the redaction guard's new false-positive class).

**Tree: clean.**

---

## C1 — closed

The cast is gone; nine explicit calls put every arity back under the compiler. The
new coverage guard behaves as claimed, and better than I expected on the brittleness
question:

- **Reddens on a registry addition.** Added `fakeNewIncident: blocked` to
  `packages/checks/src/registry.ts`, ran `npm run test:web` (which rebuilds the
  package first): `1 failed | 50 passed`, naming `+ "fakeNewIncident"`. Reverted.
- **Survives reformatting.** Reversed the order of all nine calls and broke three of
  them across four lines each (`runCheckFor(\n  name,\n  CHECKS.wraparound,\n)`):
  8/8 green. `\s*` in the matcher and the `Set`+`sort` on both sides make it
  order- and whitespace-independent. Not brittle in the dimension asked about.

Two bounded limitations worth recording, neither of which reopens C1:

1. **It hardcodes the identifier `name`.** Renaming the parameter
   `worstVerdict(name)` → `worstVerdict(db)` — behaviour-preserving, tsc clean —
   reddens the guard with `expected [] to deeply equal [ 'blocked', … ]`, i.e. it
   reports that the overview runs *no* incident checks. It fails closed, but the
   message points at the page rather than at the guard, which is the shape that
   gets a guard deleted rather than fixed.
2. **It checks mention, not participation.** Replacing
   `runCheckFor(name, CHECKS.slots),` with
   `...(process.env.PGOPS_SLOTS === '1' ? [runCheckFor(name, CHECKS.slots)] : []),`
   leaves the guard green (8/8) and `tsc` clean while `slots` never runs on the
   front door in production. A source scan can only see the identifier.

Observation, not a defect: because `queryStats` is now genuinely called, `/` will
read `1 unavailable` permanently on any database without `pg_stat_statements`. That
is honest ("we could not look"), unlike the old permanent-and-false `3 unavailable`,
but it is the same number an operator learns to ignore.

## C2 — NOT CLOSED

### The three proven bypasses are caught

Re-ran all three against the new guard, one at a time:

| Injected | New guard |
|---|---|
| `components/session-row.tsx` rendering `{s.query}`, wired into the sessions page | **red** |
| `d.sessions.map(({ pid, state, queryAgeSecs, user, app, query }) => … <pre>{query}</pre>)` | **red** |
| `<TableCell className="max-w-md truncate">{s.query?.slice(0, 120)}</TableCell>` | **red** |

The end-to-end test also catches the raw sessions-page case: with the fourth shape
below applied to `sessions/page.tsx` it failed with
`/db/primary/sessions leaked the password: … not to contain 'hunter2sentinel'`.

### A fourth shape the guard does not catch

The matcher is `/\{[^{}]*\bquery\b[^{}]*\}/`, so it only sees a brace span that
contains **no nested brace**. Converting an arrow-expression body to a block body —
the single most ordinary React refactor, the one you make the moment you want a
local — puts a brace between the `query` reference and the closing `}`:

```tsx
{d.sessions.map((s) => {
  const text = s.query ?? '—';
  return (
    …
    <TableCell className="max-w-md truncate">{text}</TableCell>
  );
})}
```

Applied verbatim to `apps/web/app/db/[name]/sessions/page.tsx`:
`npx vitest run --project web` → **51 passed (51)**, `@pgops/web typecheck` → clean.
An unredacted `pg_stat_activity.query` on a URL, with the redaction guard green.

(A second variant with the same property: hoisting
`const texts = d.sessions.map((s) => s.query);` above the JSX.)

### The end-to-end test is not shape-independent — it is data-dependent

The claim under `describe('the two properties, end to end')` is that it "catches a
bypass of ANY shape". It catches any shape **on one route**. Of the five routes it
fetches, only `/db/primary/sessions` renders any query string under the conditions
it seeds:

- `/db/primary` (triage) renders no query text at all — the `blocked`, `locks` and
  `longRunning` panels render pids and counts only (`app/db/[name]/page.tsx:60–95`).
- `/db/primary/locks` seeds no lock contention, so the wait graph is empty.
- `/db/primary/queries` is `Unavailable` in that container: `pg_stat_statements` is
  preloaded but never created — deliberately, so the sibling "says the extension is
  missing" test stays honest. The `CREATE EXTENSION` happens in the *other* test's
  *other* container.
- `/` renders no query text.

Proven: I replaced `<Sql>{w.query}</Sql>` / `<Sql>{r.query}</Sql>` on the locks page
and `<Sql>{q.query}</Sql>` on the queries page with `<pre>{…}</pre>` — three raw
renders — and the end-to-end redaction test passed, green, `1 passed | 10 skipped`.

### The two combine into a fully green leak

Applying the fourth shape to `apps/web/app/db/[name]/queries/page.tsx`
(`const text = q.query ?? ''` in a block body, rendered as `<pre>{text}</pre>`),
every gate is green while `/db/x/queries` renders `pg_stat_statements.query`
verbatim:

```
npx vitest run --project web                    51 passed (51)   <- redaction guard green
npm run --workspace @pgops/web typecheck        clean
npx vitest run --project integration apps/web   16 passed (16)   <- includes the e2e proof
next build                                      succeeds (run inside withConsole)
```

`pg_stat_statements` normalizes parameters but records *utility* statements
verbatim, which is exactly how `ALTER USER … PASSWORD '…'` reaches that page.

### And the fix introduced a new problem: false positives

The guard now flags **any** brace-delimited construct naming `query` outside an
`<Sql>` span — including TypeScript type literals. The offender list from bypass (a)
shows it firing on the props type, not just the render:

```
components/session-row.tsx: { pid: number; query: string | null }, {s.query}
```

So writing a perfectly correct component —
`function Row({ s }: { s: { pid: number; query: string | null } }) { … <Sql>{s.query}</Sql> … }`
— reddens the guard on the *type annotation*. The fix report's concern #2
acknowledges destructuring; the actual surface is wider (type literals, object
literals, any `{ … query … }` with no nested brace). No current file trips it, and
the codebase has no shared row type yet — but the first one added will.

**What would actually close C2.** Only two things do: (a) assert the permitted shape
on an AST rather than on brace spans, or (b) make the end-to-end proof render query
text on every route it fetches — seed a blocked session for `/locks`, and
`CREATE EXTENSION pg_stat_statements` in the same container for `/queries`, both
carrying the sentinel.

## I1 — closed for the proven case, with a gap

Controls and bypass attempts, one at a time on `app/page.tsx`:

- `export const dynamic = 'force-static'` → **red** (control confirmed).
- `const mode = 'force-static'; export { mode as dynamic };` → guard **green**, but
  Next itself rejects it: `Next.js can't recognize the exported 'dynamic' field in
  route. It mustn't be reexported.` Not a hole — Next requires the literal
  `export const X = …` form the matcher targets.
- `export const dynamicParams = false` + `generateStaticParams()` on
  `app/db/[name]/layout.tsx` (the guard deliberately excludes `dynamicParams`) →
  guard green, build green, all routes still `ƒ`. Built with
  `PGOPS_DATABASES=[{name:'buildtime'}]`, started with `[{name:'primary'}]`:
  `/` 200, `/db/primary` **200**, `/db/buildtime` 404. The build-time param list is
  *not* honoured once the segment cannot be prerendered. The exclusion is correct,
  and now verified rather than argued.

**The gap.** The static-directive guard iterates `sources(APP)`, and
`sources = walk(dir).filter(f => /\.tsx?$/.test(f))` — `.ts`/`.tsx` only. Its own
`RENDERABLE` regex advertises `(tsx|ts|jsx|js)` (the M6 widening), but that regex is
used by the *first* guard, which walks every file. So a `.jsx` or `.js` route file —
both in Next's default `pageExtensions` — is invisible to the force-static guard and
to the redaction guard.

Proven. `apps/web/app/status/page.jsx`:

```jsx
export const dynamic = 'force-static';
export default async function Status() {
  const names = databaseNames();
  const r = await runCheckFor(names[0], CHECKS.connections);
  return <pre>{names.join(',')} {r.ok ? 'ok' : 'no'}</pre>;
}
```

`npx vitest run --project web` → **51 passed (51)** (both dynamic-rendering guards
green, because `runCheckFor(` satisfies the first one and the file is not in
`sources()`). Then
`PGOPS_DATABASES='[{"name":"buildtimedb",…}]' npm run --workspace @pgops/web build`:

```
└ ○ /status          <- prerendered as static content
$ grep -o buildtimedb apps/web/.next/server/app/status.html
buildtimedb
```

The build-time database, frozen into HTML — I1's exact failure, through a file
extension. One-word fix: give the two `sources()`-based guards the same
`/\.(tsx?|jsx?)$/` filter the first guard's `RENDERABLE` already claims.

## I2 — closed, and reachable in production

This is the one I could not settle from source, so I settled it in a real browser
against a real production build.

Setup: a 12 s delay in `runCheckFor` (temporary probe, reverted) so one server
render spans two and a bit intervals; `next start` on port 3199 with
`PGOPS_DATABASES` pointing at a dead port; Chromium via Playwright on
`/db/primary`; count `\/db\/primary\?_rsc=` resource timings.

**Shipped (pre-fix) `refresh.tsx`, restored from `0685590` as the control:**

```
refreshes at t = 17.0s (12.0s), 22.0s (12.0s), 27.0s (12.0s), 32.0s (12.0s)
→ one every interval, up to three server renders in flight at once
```

**Current `refresh.tsx`:**

```
refreshes at t = 17.1s (12.0s), 29.1s (12.0s)
→ strictly serialised; peak concurrency 1; the next flight starts on the
  falling edge of isPending, i.e. the re-arm branch fires
```

So the skip path is genuinely reached in production, `useTransition`'s `isPending`
does stay true across `router.refresh()` (Next's `refresh()` wraps its dispatch in
its own nested `React.startTransition`, which does not detach the outer pending
flag), and `onSettle`'s re-arm — dead code before — now runs. Property 1 holds.

The fix report's concern #4 is right that jsdom cannot exercise this and that the
source guard is only a source guard; the browser run above is the missing evidence.
`TickState.inFlight` is now vestigial (`tick` overrides it from its parameter and
the component never reads it back) — cosmetic, not a defect.

## I3, I4, M1/M2, M8 — closed

- **I3** `key={`${q.queryid ?? 'null'}-${i}`}`. Index makes it unique regardless of
  `(userid, dbid)` duplicates; `queryid` in front keeps it changing when the ranking
  changes. Closed.
- **I4** Both `harness.ts` and `check.int.test.ts` now read `PGOPS_TEST_PG_VERSION`
  at module scope, same expression as `global-setup.ts`, and CI sets it on the one
  `npm run test:int` step — the env var demonstrably reaches that process
  (`PGOPS_TEST_PG_VERSION=999 npx vitest run --project integration …` →
  `failed to resolve reference "docker.io/library/postgres:999"`). The duplicate `vitest run --project integration
  apps/web/test` step and the redundant `@pgops/web build` step are gone;
  `withConsole` runs that build itself, which is what makes its run-time-configuration
  proof meaningful. Closed.
- **M1/M2** `@testing-library/react`, `@testing-library/dom` and `lucide-react` are
  absent from `package-lock.json` (0 occurrences) and from `node_modules/`, and
  `scaffold.test.ts` now pins all three out. Closed to Ruling 13's standard.
- **M8** A non-E251 `connection()` failure now returns *"pgops console error — the
  database was not contacted…"*. `FailureReason` genuinely has no vocabulary for
  "the web layer is misconfigured", so carrying it in the message is the right call
  inside this phase's constraints. Closed.

## M3 — closed with one leftover

`lib/check.ts` now states the mechanism correctly (prerender-time *evaluation*, not
textual inlining), and `guards.test.ts`, `harness.ts`, `routes.int.test.ts` and the
plan cite it. `app/page.tsx` and `lib/config.ts` already used "evaluated"/"baked"
wording and needed no change.

One survivor, in the file that is now the cited authority:
`apps/web/lib/check.ts:32` — *"so the build-time-**inlining** guarantee is untouched
by this branch"*. A maintainer who follows the citation lands eight lines above the
paragraph that says there is no inlining.

## M4 — NOT CLOSED

The guard is `/from\s+'(\.[^']*\.js)'/`. Two spellings it cannot see, both proven:

1. **Double quotes.** `import { contextFor } from "./pools.js";` in `lib/check.ts`:
   guard **8/8 green**, all 51 web tests green — and
   `next build` → `Module not found: Can't resolve './pools.js'`.
2. **The `@/` alias — which is the form every file under `app/` actually uses.**
   `import { runCheckFor } from '@/lib/check.js';` in `app/page.tsx`: guard **8/8
   green**, `@pgops/web typecheck` clean — and `next build` →
   `Module not found: Can't resolve '@/lib/check.js'`.

The second is the one that matters: `lib/check.ts` and `lib/pools.ts` are the only
files using relative specifiers at all, so the guard covers two files and misses the
seven that import through the alias. The fix moved the fast-job protection exactly as
far as the two files it was tested on. Widening the matcher to
`/from\s+["']([^"']*\.js)["']/` (and allowing the `@/` prefix) is a one-line change.

---

## What I broke, and confirmation it was reverted

| Experiment | Expected | Observed |
|---|---|---|
| `components/session-row.tsx` rendering `{s.query}` | guard reddens | red (and flags the props type too) |
| destructured `({ …, query }) => <pre>{query}</pre>` | guard reddens | red |
| `{s.query?.slice(0, 120)}` | guard reddens | red |
| block-bodied `const text = s.query` → `{text}` (sessions) | HOLE | 51/51 green, tsc clean; e2e test red |
| raw `<pre>{…}</pre>` on locks + queries pages | e2e catches | **e2e GREEN** — neither route renders query text |
| block-bodied alias on the queries page | HOLE | 51/51, tsc, 16/16 integration, `next build` all green |
| `fakeNewIncident` added to `CHECKS` | C1 guard reddens | red, naming it |
| reorder + multi-line the nine overview calls | C1 guard survives | 8/8 green |
| rename `name` → `db` in the overview | ? | reddens, with a misleading message |
| feature-flagged `CHECKS.slots` call | ? | guard green, check silently off the front door |
| `export const dynamic = 'force-static'` on `app/page.tsx` | guard reddens | red (control) |
| `export { mode as dynamic }` | HOLE? | guard green, but Next rejects the form |
| `dynamicParams = false` + `generateStaticParams` | HOLE? | `/db/primary` still 200 at run time — no hole |
| `app/status/page.jsx` with `force-static` | HOLE | 51/51 green; `/status` prerendered, `buildtimedb` baked in |
| `from "./pools.js"` (double quotes) | HOLE | guard green; `next build` fails |
| `from '@/lib/check.js'` | HOLE | guard green, tsc clean; `next build` fails |
| 12 s delay in `runCheckFor` + browser timing | measurement | pre-fix 4 refreshes/3 concurrent vs post-fix 2 serialised |

Post-review state: `git status --short` empty, `git diff HEAD` empty,
`.playwright-mcp/` removed, `@pgops/checks` rebuilt, `next start` on 3199 stopped.
Final sweep re-run green: `npm test` 490/55, `npx vitest run --project web` 51/9,
`npm run test:int` 56/12, four typechecks, `npm run --workspace @pgops/web build`
with `/`, `/db/[name]`, `/db/[name]/sessions`, `/db/[name]/locks`,
`/db/[name]/queries` all `ƒ (Dynamic)`.
