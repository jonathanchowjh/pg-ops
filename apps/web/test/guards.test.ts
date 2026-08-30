// This file reads app/ and components/ source off disk and renders no DOM,
// so it doesn't need jsdom. Forcing `node` here (Vitest's per-file
// environment override) matters beyond speed: the `web` project's jsdom
// environment runs Vite's browser-mode transform, which rewrites the literal
// `new URL('../app', import.meta.url)` below into a server-relative asset URL
// instead of a `file://` URL, and `readFileSync`/`readdirSync` then throw.
// Same pattern as scaffold.test.ts.
// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '@pgops/checks';

const APP = fileURLToPath(new URL('../app', import.meta.url));
const COMPONENTS = fileURLToPath(new URL('../components', import.meta.url));
const LIB = fileURLToPath(new URL('../lib', import.meta.url));
// apps/web's own root — NOT walked recursively (see `topLevel`
// below): its subdirectories are `app/`, `components/`, `lib/` and `test/`,
// the first three of which are already the roots above, and `test/` is
// intentionally out of scope for a guard about what SHIPS. What this adds is
// the top-level files that sit directly in apps/web/ and are covered by
// none of the three roots — `proxy.ts` chief among them: it runs on every
// request and already imports from `@/lib/auth`, so it is exactly the kind
// of file a second `ACTIONS.kill` caller could be dropped into unnoticed.
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OVERVIEW = join(APP, 'page.tsx');
const SQL_COMPONENT = join(COMPONENTS, 'sql.tsx');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Files directly inside `dir`, not its subdirectories. See `WEB_ROOT` above. */
function topLevel(dir: string): string[] {
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((p) => statSync(p).isFile());
}

const strip = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * Every file Next will actually render as a route segment, not just the two
 * this guard used to look at.
 *
 * M6: the filter was `/(page|layout)\.tsx$/`. The effective `pageExtensions`
 * is `["tsx","ts","jsx","js"]`, and Next also renders `template`, `default`,
 * `error`, `global-error`, `loading`, `not-found` and `route` — any of which
 * could read configuration, or export route-segment config, entirely
 * invisibly to a guard that only knows about `page` and `layout`.
 */
const RENDERABLE = /\/(page|layout|template|default|error|global-error|loading|not-found|route)\.(tsx|ts|jsx|js)$/;

/**
 * Every extension Next compiles, not just the two TypeScript ones.
 *
 * The re-review shipped `app/status/page.jsx` carrying
 * `export const dynamic = 'force-static'`: it passed 51/51 because `sources`
 * filtered to `.ts|.tsx` while RENDERABLE above already advertised `jsx|js`.
 * The route prerendered with the BUILD machine's database baked into
 * `.next/server/app/status.html`. A guard whose file list is narrower than
 * the framework's is a guard with a documented hole in it.
 */
const sources = (dir: string) => walk(dir).filter((f) => /\.(tsx?|jsx?)$/.test(f));

describe('dynamic rendering', () => {
  /**
   * A statically prerendered route evaluates `process.env` IN THE BUILD PROCESS
   * and freezes the result into HTML (Turbopack does not textually inline it;
   * see lib/check.ts). That happens unless the
   * component opts into dynamic rendering. The entire configuration model is
   * `docker run -e PGOPS_DATABASES=… pgops` against an image built months
   * earlier. Get this wrong and the container talks to whatever database was
   * set when the image was built — silently, forever, with no error anywhere.
   *
   * Every page or layout that reads configuration must therefore either call
   * `connection()` itself or reach configuration only through `runCheckFor`,
   * which awaits it centrally.
   */
  it('every page or layout touching configuration is explicitly dynamic', () => {
    const offenders: string[] = [];
    for (const file of walk(APP)) {
      if (!RENDERABLE.test(file)) continue;
      const code = strip(readFileSync(file, 'utf8'));
      const readsConfig = /databaseNames\s*\(|process\.env/.test(code);
      if (!readsConfig) continue;
      const isDynamic = /await\s+connection\s*\(\s*\)/.test(code) || /runCheckFor\s*\(/.test(code);
      if (!isDynamic) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * I1 (final review): the guard above checks only that a dynamic signal is
   * PRESENT. It never looked at route-segment config, which can neutralise
   * that signal from three lines away — and `export const dynamic =
   * 'force-static'` on `app/page.tsx` was proven to pass all four guards, all
   * four typechecks and the whole web suite, while `next build` (with a
   * `DATABASE_URL` in scope, which is the ordinary case in a deploy pipeline)
   * SUCCEEDED and froze `/db/default` into `.next/server/app/index.html`. The
   * build-time database, baked into the image, forever.
   *
   * `'force-dynamic'` is removed from the source FIRST, because it contains
   * every forbidden spelling below as a substring — the same self-trigger the
   * redaction guard hit (Ruling 29). `dynamicParams` is deliberately NOT
   * listed: it decides whether an unlisted param 404s, not whether the segment
   * renders per request, and `true` (its default) is a legitimate thing to
   * write.
   */
  it('no file under app/ opts a route back into static rendering', () => {
    const offenders: string[] = [];
    for (const file of sources(APP)) {
      const code = strip(readFileSync(file, 'utf8'))
        // The one permitted spelling of `dynamic`, in either quote style.
        .replace(/export\s+const\s+dynamic\s*=\s*(['"])force-dynamic\1/g, '');
      const found = [
        /export\s+const\s+dynamic\s*=/.test(code) ? 'dynamic (not force-dynamic)' : '',
        /export\s+const\s+revalidate\s*=/.test(code) ? 'revalidate' : '',
        /export\s+const\s+fetchCache\s*=/.test(code) ? 'fetchCache' : '',
        /(['"])use cache\1/.test(code) ? "'use cache'" : '',
      ].filter(Boolean);
      if (found.length > 0) offenders.push(`${file}: ${found.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * A page must never build its own Pool: pools live in lib/pools.ts so the
   * process holds exactly one per database. A page-level `new Pool` would open
   * a connection per render against the database this tool exists to diagnose.
   */
  it('no page or component constructs its own Pool', () => {
    const offenders = [...sources(APP), ...sources(COMPONENTS)]
      .filter((f) => /new\s+Pool\s*\(/.test(strip(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

describe('module specifiers', () => {
  /**
   * The repo-wide ESM convention is explicit `.js` on relative imports, and it
   * does NOT hold inside apps/web's own source. Next's bundler resolves
   * relative imports against real files on disk and cannot map `./x.js` onto a
   * sibling `x.tsx`.
   *
   * This guard exists because that failure is invisible to two of the three
   * gates: changing `from './pools'` to `from './pools.js'` in lib/check.ts
   * passes `tsc --noEmit` AND every web test, and fails only at `next build`
   * -- which CI's fast `static` job never runs. Without this, a PR "fixing"
   * the convention back passes the fast job and fails four legs later in the
   * integration matrix, where the cause is far from the symptom.
   *
   * Files under test/ are exempt: they run under vitest, not Next, and keep
   * the repo convention.
   */
  it('uses no .js extension on relative imports in app, lib or components', () => {
    const offenders: string[] = [];
    for (const file of [...walk(APP), ...walk(LIB), ...walk(COMPONENTS)]) {
      if (!/\.tsx?$/.test(file)) continue;
      /**
       * Both quote styles, and BOTH specifier forms. The first version matched
       * single-quoted relative imports only, so it covered 2 files and missed
       * 7: every file under app/ imports through the `@/` alias, and
       * `from "@/lib/check.js"` fails `next build` exactly as `./pools.js`
       * does while passing tsc and every web test.
       */
      for (const m of strip(readFileSync(file, 'utf8')).matchAll(
        /from\s+['"]((?:\.|@\/)[^'"]*\.jsx?)['"]/g,
      )) {
        offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('redaction', () => {
  /**
   * §7.3: every rendered query goes through `redactSecrets`. `Sql` is the one
   * component that calls it, so the enforceable form of the rule is that no
   * page renders a query-shaped field except through `Sql`.
   *
   * Two corrections from the final review (C2), each proven by a bypass that
   * compiled clean with all four guards and all 43 web tests green:
   *
   *  - This walked `APP` only. Its sibling `new Pool` guard in this same file
   *    already walked `[...APP, ...COMPONENTS]`; this one was simply never
   *    given the same list. A `components/session-row.tsx` rendering
   *    `<TableCell>{s.query}</TableCell>`, wired into the sessions page, put an
   *    unredacted `pg_stat_activity.query` on a URL with every gate green —
   *    and this codebase already factors rendering into components, so that is
   *    the first natural refactor, not a contrived one.
   *  - It grepped for ONE SPELLING of the violation — `{x.query}` / `{x.query
   *    ?? …}` — so `{query}` (destructured) and `{s.query?.slice(0, 120)}`
   *    (truncated, on a cell that already carries `truncate`) both walked
   *    straight through. A guard that greps for a spelling of a violation can
   *    only ever catch that spelling, so this now asserts the PERMITTED shape:
   *    `<Sql>…</Sql>` spans are deleted first — Ruling 29's "exclude the
   *    correct form first", which matters because the correct form contains
   *    every violation as a substring — and then NOTHING naming `query` may
   *    remain inside a JSX brace.
   *
   * That makes destructuring `query` out of a row a violation even when the
   * destructured value does reach `<Sql>`: the guard cannot tell that
   * `({ query }) => <Sql>{query}</Sql>` from `({ query }) => <pre>{query}</pre>`
   * once the `<Sql>` span is gone. Keep the field on its row and write
   * `<Sql>{row.query}</Sql>`. `\b` is what keeps `queryid` and `queryAgeSecs`
   * — both rendered raw, both harmless — out of it.
   *
   * A source scan is a heuristic and cannot be the whole protection. The
   * end-to-end proof is routes.int.test.ts's "no page leaks a password caught
   * in pg_stat_activity", which seeds a real password into a real query and
   * fetches every route: that catches a bypass of any shape, which no regex
   * can.
   */
  /**
   * KNOWN LIMITS, stated because a guard that implies more coverage than it
   * has is worse than one that admits its edges.
   *
   * This matcher sees one brace span at a time, so a block-bodied map callback
   * that lifts the value out first --
   *   `.map((s) => { const text = s.query ?? '—'; return <span>{text}</span>; })`
   * -- puts a nested brace between the two and slips through. So do any number
   * of other shapes nobody has thought of. That is the nature of grepping for
   * a violation: the space of spellings is open.
   *
   * This guard is an AUTHORING AID -- it fails fast, in the fast CI job, on
   * the shapes people actually write. The GUARANTEE lives in
   * routes.int.test.ts's "leaks no password on any route that can render a
   * query", which seeds a password into pg_stat_activity and
   * pg_stat_statements, fetches every route that can render query text, and
   * asserts the sentinel appears in none of them. That one is
   * shape-independent because it reads rendered HTML rather than source.
   */
  it('no page or component renders a query field outside the Sql component', () => {
    const offenders: string[] = [];
    for (const file of [...sources(APP), ...sources(COMPONENTS)]) {
      if (file === SQL_COMPONENT) continue;
      const code = strip(readFileSync(file, 'utf8')).replace(/<Sql>[\s\S]*?<\/Sql>/g, '');
      const direct = (code.match(/\{[^{}]*\bquery\b[^{}]*\}/g) ?? []).filter(
        // A TYPE literal, not a JSX interpolation: `{ pid: number; query:
        // string | null }` names `query` and renders nothing. Flagging it made
        // a correct component with a query-bearing props type fail this guard,
        // which is how a guard gets deleted by the next person it annoys. A
        // JSX interpolation does not contain a semicolon.
        (span) => !span.includes(';'),
      );
      if (direct.length > 0) offenders.push(`${file}: ${direct.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the Sql component actually calls redactSecrets', () => {
    const code = readFileSync(SQL_COMPONENT, 'utf8');
    expect(code).toMatch(/redactSecrets\s*\(/);
  });
});

describe('the refresh ticker', () => {
  /**
   * I2 (final review): refresh.test.ts drives `tick` with an `inFlight` the
   * TEST supplies, which is the only way to test that loop — but it therefore
   * cannot notice if the COMPONENT goes back to inventing `inFlight` itself.
   * That is exactly what shipped: `setTimeout(…, 0)` one macrotask after a
   * fire-and-forget `router.refresh()`, against a 5000 ms interval, so
   * `inFlight` was false at every tick and property 1 ("skipped, not queued")
   * held vacuously while the page ran five concurrent server renders against
   * the database it exists to diagnose.
   *
   * `useTransition` is the real completion signal. This pins the wiring, which
   * no test over the pure functions can reach.
   */
  it('ends its flight on the transition, not on a timer', () => {
    const code = strip(readFileSync(join(COMPONENTS, 'refresh.tsx'), 'utf8'));
    expect(code).toMatch(/useTransition\s*\(\s*\)/);
    expect(code).toMatch(/startTransition\s*\(/);
    expect(code).not.toMatch(/setTimeout\s*\(/);
  });
});

describe('the overview covers every incident check', () => {
  /**
   * C1 (final review): the overview used to sweep `Object.values(CHECKS)` with
   * a cast that erased `runCheckFor`'s arity overloads, so three of the nine
   * incident checks ran with no options and failed permanently. The fix is an
   * explicit call per check, which puts every arity back under the compiler —
   * and buys, in exchange, the risk this test exists to remove: a check added
   * to `CHECKS` in a later phase and never added here would simply not be
   * asked about on the front door, silently.
   *
   * Spec §6.2 makes `class` the thing that decides placement, so the registry
   * is the authority and the page must follow it. The page's list is read out
   * of its SOURCE rather than imported: a Next page module may only export the
   * fields Next knows about, so there is nowhere on that module to hang an
   * exported list without arguing with `next build`'s own export validation.
   */
  it('runs every check the registry classes as an incident', () => {
    const source = strip(readFileSync(OVERVIEW, 'utf8'));
    const called = new Set(
      [...source.matchAll(/runCheckFor\s*\(\s*name\s*,\s*CHECKS\.(\w+)/g)].map((m) => m[1]!),
    );
    const incidents = Object.entries(CHECKS)
      .filter(([, c]) => c.class === 'incident')
      .map(([id]) => id);
    expect([...incidents].sort()).toEqual([...called].sort());
  });
});

describe('the kill gate', () => {
  /**
   * `killBackend` is the one destructive call in the codebase. It is easy to
   * add a second caller — a Server Action, a convenience helper — that skips
   * `actionsAllowed`, and nothing about such a call looks wrong in review.
   * The gate is enforced in exactly one file; this asserts that stays true.
   *
   * `@pgops/checks`'s barrel re-exports `killBackend` as a TYPE only
   * (`export type * from './actions/kill.js'`); the runtime path every
   * caller — including this route — actually uses is `ACTIONS.kill`. A guard
   * that greps only for the literal `killBackend` would therefore compare an
   * empty list of importers against a one-element expectation, and would
   * fail for the wrong reason, or — if "fixed" by dropping the assertion
   * instead — would pass while a second caller quietly used `ACTIONS.kill`.
   * So this matches EITHER spelling: a file is an importer if it names
   * `killBackend` (the type) or `ACTIONS` (the runtime value). `ACTIONS` has
   * exactly one member today, and every member of it is destructive by
   * definition, so "imports ACTIONS at all" is the right granularity, not a
   * loosening of the guard.
   *
   * Written as "the set of importing files", not "no file other than X
   * imports it": the correct file is a substring of any wrong path under it,
   * and an exclusion written the other way round matched itself in both P0
   * and P1a.
   */
  it('names killBackend or ACTIONS in exactly one file — the gated route', () => {
    const ROUTE = join(APP, 'api', 'db', '[name]', 'kill', 'route.ts');
    // WEB_ROOT's top-level files join the three roots here — review finding:
    // `proxy.ts` sits at apps/web/proxy.ts, runs on every request, and was
    // invisible to this guard until now. `topLevel`, not `sources`/`walk`:
    // recursing into WEB_ROOT would re-walk APP/COMPONENTS/LIB (harmless,
    // just redundant) and also walk `test/`, which is explicitly out of
    // scope for a guard about shipped code.
    const topLevelSources = topLevel(WEB_ROOT).filter((f) => /\.(tsx?|jsx?)$/.test(f));
    const importers = [...sources(APP), ...sources(COMPONENTS), ...sources(LIB), ...topLevelSources]
      .filter((f) => /\bkillBackend\b|\bACTIONS\b/.test(strip(readFileSync(f, 'utf8'))))
      .sort();
    expect(importers).toEqual([ROUTE]);
  });
});
