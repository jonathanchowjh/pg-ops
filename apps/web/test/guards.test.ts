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

/**
 * Line comments FIRST, then block comments — not the other order it shipped
 * with. Final review: with block-first, a two-character open-comment marker
 * sitting inside an ordinary `//` comment (not a real block comment at all)
 * fools the non-greedy block regex into opening there anyway, and it then
 * closes on the file's next literal close-comment marker, wherever that
 * happens to be — deleting everything in between, including real code. This
 * is not hypothetical: the text "every /db/(star) URL" (a slash directly
 * followed by an asterisk) inside a `//` line at
 * app/db/[name]/layout.tsx:24 did exactly this, eating roughly thirty lines
 * down to that file's one legitimate JSX comment's own close-comment marker
 * around line 54 — silently blinding every guard in this file that reads
 * that file through `strip()`, including the poll boundary and the kill
 * gate. (This paragraph spells the two markers out rather than writing them,
 * because writing the close-comment one literally would end THIS comment
 * early — the same defect, one level up.) Stripping line comments first
 * removes that whole line, open-comment marker included, before the
 * block-comment pass ever runs, so a stray open-comment marker inside a real
 * line comment can no longer be mistaken for the start of a block comment.
 */
const strip = (code: string) =>
  code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

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
   * A9 drove a password into the rendered HTML, and this is the guard that
   * would have stopped it.
   *
   * `ExplainLink` is a CLIENT component, so whatever is passed to it is
   * serialised into the RSC payload embedded in the page — before the
   * component runs. Redacting inside it is therefore impossible: the raw
   * value has already crossed the boundary. (Same class as 2c2ea5e, a
   * password reaching the payload through a React key.)
   *
   * The Queries page handed it `q.query` straight from
   * `pg_stat_statements`, and `routes.int.test.ts` caught it end to end:
   * `/db/primary/queries leaked the password`. The sibling guard below could
   * not, because A9 bound the value as `const statement = q.query` first —
   * precisely the "lifts the value out first" bypass that guard's own
   * KNOWN LIMITS section documents. Worth recording: the plan text for A9
   * suggested that rename explicitly, as a way to avoid tripping the guard.
   * Renaming a variable to get past a redaction guard is a warning, not a
   * workaround.
   *
   * So this asserts the PERMITTED SHAPE rather than grepping for a
   * violation: every `statement=` prop on an `ExplainLink` must be wrapped
   * in `safeStatement(...)`, which is the one function that collapses a
   * statement to a line and then redacts it — in that order, for the reason
   * `Sql` documents.
   */
  it('every statement handed to a client component is redacted first', () => {
    const offenders: string[] = [];
    for (const file of [...sources(APP), ...sources(COMPONENTS)]) {
      const code = strip(readFileSync(file, 'utf8'));
      for (const tag of code.match(/<ExplainLink[^>]*>/g) ?? []) {
        if (!/statement=\{safeStatement\(/.test(tag)) offenders.push(`${file}: ${tag.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });


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
   * MATCHING BY POSITION is what makes that affordable. The rule used to be
   * "nothing naming `query` inside any brace span", which could not tell
   * `({ query }) => <Sql>{query}</Sql>` from `({ query }) => <pre>{query}</pre>`
   * and so banned both — and, worse, flagged `{ pathname, query }`, which is
   * Next's object href and renders nothing. That false positive was not
   * cosmetic: it is why `withParam` had to live in lib/ rather than beside
   * `SortLink`, a test dictating module layout. A brace span renders only
   * where JSX puts it — after `>`, after `=`, after `$`, after `}` — so the
   * guard now asks where the span sits rather than what it contains. The safe
   * destructure passes (its `<Sql>` span is deleted first, and nothing is
   * left in a rendering position); the unsafe one still fails on `>{query}`.
   * `\b` is what keeps `queryid` and `queryAgeSecs` — both rendered raw, both
   * harmless — out of it.
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
   * Matching by position adds one edge of its own: `prop = {row.query}`, with
   * a space either side of the `=`, is legal JSX that nothing in this
   * codebase writes and no formatter produces, and the `=` branch requires
   * the brace to be adjacent because `const href = { pathname, query }` is
   * otherwise indistinguishable from it.
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
      // MATCHED BY POSITION, not by contents. A brace span RENDERS only where
      // JSX puts it: after `>` (a child), after `=` (a prop value), after `$`
      // (a template substitution) or after `}` (a second child in a row).
      // Everywhere else a brace is an object literal, a type literal or a
      // destructuring pattern, and it renders nothing at all.
      const direct = code.match(/(?:>\s*|[=$}])\{[^{}]*\bquery\b[^{}]*\}/g) ?? [];
      if (direct.length > 0) offenders.push(`${file}: ${direct.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The sessions-page password leak, closed here. A React `key` is not
   * rendered as an HTML attribute, which invites the assumption that it is
   * therefore invisible. Under React Server Components it is NOT invisible:
   * the key is serialized into the Flight payload embedded inside the
   * page's own HTML document, so a secret used as a key is published exactly
   * as if it had been rendered as text. `apps/web/app/db/[name]/sessions/
   * page.tsx` did `<li key={s.queryId ?? statement ?? ''}>` one line above a
   * `<Sql>{statement}</Sql>` that redacted the very same value correctly —
   * and the guard above, which asks whether a `query` field sits in a
   * rendering position, had no notion that a `key={…}` expression IS a
   * rendering position, so it walked straight past. tsc was clean. All 43
   * web tests were green. The change had been through three reviews. It
   * took `routes.int.test.ts` seeding a real password into a real
   * `pg_stat_activity.query` and grepping the served HTML to catch it —
   * because that test reads what actually reached the wire, and nothing
   * else in the suite does.
   *
   * This asks the same field-name question the guard above already asks
   * (`query`, `statement`, a `.sql` accessor — the shapes it already treats
   * as query-ish) of every `key={…}` expression instead of every rendering
   * position. `\bquery\b`/`\bstatement\b` keep `queryid` and `queryAgeSecs`
   * out of it, the same word-boundary reasoning as the guard above.
   */
  it('no key= expression is built from a query-ish field', () => {
    const offenders: string[] = [];
    const FIELD = /\b(query|statement)\b|\.sql\b/;
    for (const file of [...sources(APP), ...sources(COMPONENTS)]) {
      const code = strip(readFileSync(file, 'utf8'));
      // One level of nested braces tolerated, so a template-literal key such
      // as `key={`${w.type}-${w.event ?? ''}`}` is matched as a single span
      // rather than being cut short at its first inner `}`.
      for (const m of code.matchAll(/key\s*=\s*\{(?:[^{}]|\{[^{}]*\})*\}/g)) {
        if (FIELD.test(m[0])) {
          const line = code.slice(0, m.index).split('\n').length;
          offenders.push(`${file}:${line}: ${m[0]}`);
        }
      }
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
   * `killBackend` (the type) or `ACTIONS` (the runtime value). Every member
   * of `ACTIONS` writes to a monitored database by definition, so "imports
   * ACTIONS at all" is the right granularity, not a loosening of the guard.
   *
   * P5 took this from one file to five. The list stays EXACT rather than
   * becoming a pattern over `api/db/[name]/*`: a new action route is a
   * deliberate edit here, which is the point — the question this guard
   * answers is "which files may reach an action at all", and a pattern would
   * answer "any file someone puts in the right directory".
   *
   * Written as "the set of importing files", not "no file other than X
   * imports it": the correct file is a substring of any wrong path under it,
   * and an exclusion written the other way round matched itself in both P0
   * and P1a.
   */
  it('names killBackend or ACTIONS in exactly the five gated routes', () => {
    const API = join(APP, 'api', 'db', '[name]');
    const ROUTES = [
      join(API, 'analyze', 'route.ts'),
      join(API, 'kill', 'route.ts'),
      join(API, 'kill-long-running', 'route.ts'),
      join(API, 'reset-query-stats', 'route.ts'),
      join(API, 'reset-stats', 'route.ts'),
    ].sort();
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
    expect(importers).toEqual(ROUTES);
  });
});

describe('the poll boundary', () => {
  /**
   * `<Refresh>` used to render in app/db/[name]/layout.tsx, which put a
   * 5-second router.refresh() on EVERY route under /db/<name>. That was
   * correct while every such route was an incident page. P2 adds hygiene
   * routes whose queries are catalog scans (index_bloat is a ~140-line CTE;
   * table_sizes touches every relation), and inheriting the poll would run
   * them every five seconds on every open tab, forever.
   *
   * Both directions of getting this wrong are SILENT. An incident page that
   * loses its <Refresh> still renders — it just stops updating, during an
   * incident, with nothing on screen saying so. A hygiene page that keeps it
   * still renders — it just puts a table scan on a timer. Neither throws, so
   * nothing else in the suite would notice.
   *
   * Final review: this used to check only the positive direction (each
   * incident page polls) plus one hand-picked negative (the layout doesn't).
   * That left the actual rule — "no OTHER page polls" — unenforced, on the
   * reasoning that it would range over an empty set until hygiene pages
   * exist. That reasoning does not hold: `sources(APP)` is non-empty today
   * (it already walks every page/component/layout under app/), so a
   * set-equality assertion has a real subject right now, subsumes the old
   * layout-only negative check for free, and — the actual point — fails
   * automatically the moment a future phase adds a polling hygiene page,
   * with nobody needing to remember to extend a list here.
   */
  const INCIDENT_PAGES = [
    join(APP, 'db', '[name]', 'page.tsx'),
    join(APP, 'db', '[name]', 'sessions', 'page.tsx'),
    join(APP, 'db', '[name]', 'locks', 'page.tsx'),
    join(APP, 'db', '[name]', 'queries', 'page.tsx'),
    // The one hygiene-gate route that polls, and the extension is
    // deliberate rather than an oversight this guard failed to catch.
    // /cleanup renders wraparound, replicationLag and slots — all
    // `class: 'incident'` — and a wraparound horizon or a stalled slot gets
    // worse while an operator watches. Its SUB-routes are the opposite:
    // catalog scans that run on visit, and they share this page's layout, so
    // the poll lives on the page and not in the layout. Nothing else under
    // db/[name]/cleanup/ may appear in this list.
    join(APP, 'db', '[name]', 'cleanup', 'page.tsx'),
  ];

  /**
   * The overview polls too, and deliberately NOT at the incident cadence.
   * `worstVerdict` runs twelve checks per database, so a tick here costs
   * twelve times a triage tick times however many databases are configured
   * — the one page where the 5s interval genuinely could become the load it
   * is meant to prevent.
   */
  const OVERVIEW = join(APP, 'page.tsx');

  it('renders <Refresh> in exactly the incident pages and the overview', () => {
    const polling = sources(APP)
      .filter((f) => /<Refresh\b/.test(strip(readFileSync(f, 'utf8'))))
      .sort();
    expect(polling).toEqual([...INCIDENT_PAGES, OVERVIEW].sort());
  });

  /**
   * The cadence, not just the presence. Set equality above would be satisfied
   * by an overview polling at 5s — which is the actual mistake available
   * here, and a silent one: it renders identically and simply multiplies the
   * console's own load by the number of databases configured.
   */
  /**
   * The triage page gained hygiene lines, and this is what keeps them cheap.
   *
   * It polls every five seconds. The checks behind those lines are catalog
   * scans allowed ten seconds each — `table_sizes` alone touches every
   * relation — so the page must read the CACHE the capture tick wrote and
   * never run one itself. The failure this prevents is invisible in a
   * screenshot: the page looks identical either way, and the only evidence
   * is the load arriving at the database this console promises not to
   * burden.
   *
   * Asserted on the page's own source rather than a module graph: the page
   * reaches its data through exactly two seams, `runCheckFor` for the live
   * checks and `hygieneFor` for the cache, and a hygiene check could only
   * get onto it by being named here.
   */
  it('reads hygiene from the cache on the polled page, never by running a check', () => {
    const triage = strip(readFileSync(join(APP, 'db', '[name]', 'page.tsx'), 'utf8'));
    const hygieneIds = Object.values(CHECKS)
      .filter((c) => c.class === 'hygiene')
      .map((c) => c.id);

    for (const id of hygieneIds) {
      expect(triage).not.toMatch(new RegExp(`CHECKS\\.${id}\\b`));
    }
    expect(triage).toMatch(/hygieneFor\(/);
  });

  it('polls the overview strictly slower than an incident page', () => {
    const interval = (file: string): number => {
      const m = /<Refresh\s+intervalMs=\{([0-9_]+)\}/.exec(strip(readFileSync(file, 'utf8')));
      if (m === null) throw new Error(`no <Refresh intervalMs={…}> in ${file}`);
      return Number(m[1]!.replace(/_/g, ''));
    };
    for (const page of INCIDENT_PAGES) {
      expect(interval(OVERVIEW)).toBeGreaterThan(interval(page));
    }
  });
});

const CHECKS_SRC = fileURLToPath(new URL('../../../packages/checks/src', import.meta.url));

describe('the DDL boundary', () => {
  it('confines every DDL statement to store/migrations/', () => {
    // Replaces the old "CLI only" boundary now that migrations run at boot.
    // pgops issues no DDL against a monitored database, ever; the only code
    // that can issue any at all is the migration runner, which runs only when
    // PGOPS_STORE_URL is set and only against that URL.
    // I7 (final review): this walked packages/checks ONLY, while the README
    // claims the guard covers the repo and the comment above says "the only
    // code that can issue any at all is the migration runner". apps/web holds
    // the pools to the MONITORED databases — the exact place a DDL statement
    // would do the damage this guard exists to prevent — and was unscanned.
    //
    // `sources()` and `topLevel()`, not an ad-hoc extension filter: this file
    // already carries a docblock (above `sources`) recording that this repo
    // SHIPPED an `app/status/page.jsx` which slipped a guard filtered to
    // .ts/.tsx, and concluding that a guard whose file list is narrower than
    // the framework's is a guard with a documented hole. `topLevel(WEB_ROOT)`
    // covers instrumentation.ts, proxy.ts and next.config.ts, which the
    // directory walks do not reach.
    //
    // TRUNCATE is anchored on TABLE/ONLY or a bare identifier followed by a
    // semicolon, NOT on `\s+[a-z_"]`: with the `i` flag that looser form
    // matched Tailwind's `truncate` utility class, and this tree already
    // writes `className="max-w-md truncate"` — reordering two CSS classes
    // would have failed a security guard.
    const DDL =
      /\b(?:(?:CREATE|ALTER|DROP)\s+(?:MATERIALIZED\s+)?(?:SCHEMA|TABLE|INDEX|VIEW|EXTENSION|SEQUENCE|FUNCTION|ROLE|USER|DATABASE)\b|TRUNCATE\s+(?:TABLE\b|ONLY\b|"?[a-z_][a-z_0-9]*"?\s*;)|GRANT\s+[A-Z]{2,}\b)/i;
    const roots: [string[], string, string][] = [
      [sources(CHECKS_SRC), CHECKS_SRC, 'packages/checks/src'],
      [sources(APP), APP, 'apps/web/app'],
      [sources(COMPONENTS), COMPONENTS, 'apps/web/components'],
      [sources(LIB), LIB, 'apps/web/lib'],
      [topLevel(WEB_ROOT).filter((f) => /\.(tsx?|jsx?)$/.test(f)), WEB_ROOT, 'apps/web'],
    ];
    const matched = roots.flatMap(([files, root, label]) =>
      files
        .filter((p) => !p.includes(join('store', 'migrations')))
        .filter((p) => DDL.test(strip(readFileSync(p, 'utf8'))))
        // The path RELATIVE to its root, not the basename: two `page.tsx`
        // files under different routes must not report as the same offender.
        .map((p) => `${label}/${p.slice(root.length + 1)}`),
    );
    // run.ts is the ONE expected match, and it issues no DDL: `remedyFor`
    // builds the advice string `CREATE EXTENSION <name>;` that a check with a
    // `requires` block shows the operator when the extension is absent. The
    // regex cannot tell a statement from a sentence about one, so the file is
    // pinned here by exact list equality rather than skipped — a second
    // offender, or this one growing a real statement alongside the string,
    // still fails. Stated because a security guard that asserts a source file
    // contains DDL, with no explanation, reads as the guard having been
    // silenced.
    //
    // tools/advice.ts is the SECOND expected match, for the same reason:
    // `IndexSuggestion.statement` is the index statement handed to the
    // OPERATOR to run through their own migration tooling. #62 `autoindex` —
    // the thing that would run it — is declined. A third file, or a real
    // statement growing in advice.ts beside the string, still fails.
    expect(matched).toEqual(['packages/checks/src/run.ts', 'packages/checks/src/tools/advice.ts']);
  });
});

describe('capture', () => {
  const RESET = /pg_stat_statements_reset|pg_stat_reset\b/i;

  /**
   * The parent spec §4.3 calls this the strongest product claim in the design.
   * pgHero's capture_query_stats calls pg_stat_statements_reset() AS PART OF
   * CAPTURE, which silently breaks every other consumer on the database. The
   * behavioural proof is capture.int.test.ts's monotonicity assertion; this is
   * the cheap source-level tripwire that fails the moment someone types it,
   * without waiting for an integration run.
   *
   * P5 changed this guard's SHAPE, and deliberately not its subject. A blanket
   * ban was the right implementation while pgops had no reset at all. It
   * became the wrong one when P5 shipped a reset an operator has to reach
   * through the tier-2 gate, a typed confirmation and an audit record — so the
   * ban NARROWS to an exact allowlist rather than being deleted or having its
   * regex weakened.
   *
   * Exact list equality, like the DDL guard's run.ts pin: a second file fails
   * even though the first is expected.
   */
  it('names a statistics reset in exactly one file — the gated action', () => {
    const offenders = walk(CHECKS_SRC)
      .filter((p) => p.endsWith('.ts'))
      .filter((p) => RESET.test(strip(readFileSync(p, 'utf8'))))
      .map((p) => p.slice(CHECKS_SRC.length + 1));
    expect(offenders).toEqual([join('actions', 'stats.ts')]);
  });

  /**
   * The claim itself, stated rather than inferred.
   *
   * The allowlist above could be edited to add a file; this names the files
   * that may NEVER do it, which is what the spec's claim is actually about.
   * An allowlist that merely happens to exclude the capture path is weaker
   * than one that says so.
   */
  it('never resets from the capture path', () => {
    for (const f of [
      'capture.ts',
      join('store', 'write.ts'),
      join('store', 'read.ts'),
      join('series', 'query-stats.ts'),
    ]) {
      expect(RESET.test(strip(readFileSync(join(CHECKS_SRC, f), 'utf8'))), f).toBe(false);
    }
  });
});

describe('operator SQL', () => {
  /**
   * `planStatements` is the one path by which text pgops did not write reaches
   * a monitored database — a named statement, read-only, rolled back, its
   * connection destroyed. A second file preparing statements would be a
   * second path with none of that. The behaviour is held by
   * explain.int.test.ts; this is the tripwire that fires without a database.
   */
  it('is prepared in exactly one file', () => {
    const offenders = sources(CHECKS_SRC)
      .filter((p) => /\bPREPARE\s/.test(strip(readFileSync(p, 'utf8'))))
      .map((p) => p.slice(CHECKS_SRC.length + 1));
    expect(offenders).toEqual([join('tools', 'explain.ts')]);
  });
});

/**
 * B11. The Triage band's Throughput line was a span written in the triage
 * page that formatted `commitsPerSec` and `rollbacksPerSec` itself — a
 * second copy of the formatting in `components/throughput.tsx`, whose own
 * docblock says it is shared "rather than written twice". The copy went
 * unnoticed until the console's own-share clause was added to the component
 * and reached every surface except the single line that band renders.
 *
 * The guard is on the FORMATTING, not on the import: a page that renders
 * `<Throughput>` and also hand-builds a rate string beside it is the state
 * this prevents, and that passes any import-only check.
 */
describe('the throughput line', () => {
  const RATE_FIELDS = /\b(commitsPerSec|rollbacksPerSec|tempBytesPerSec|cacheHitPct|ownPerSec)\b/;

  it('is formatted in one component, not re-written by the pages that show it', () => {
    const offenders = [...sources(APP), ...sources(COMPONENTS)]
      .filter((f) => f !== join(COMPONENTS, 'throughput.tsx'))
      .filter((f) => RATE_FIELDS.test(strip(readFileSync(f, 'utf8'))));

    expect(offenders.map((f) => f.replace(WEB_ROOT, ''))).toEqual([]);
  });

  /**
   * And the pages really do render it, so the guard above cannot be
   * satisfied by a page that simply stopped showing throughput at all.
   */
  it('is rendered by both surfaces that carry it', () => {
    for (const page of [join(APP, 'db', '[name]', 'page.tsx'), join(APP, 'db', '[name]', 'queries', 'page.tsx')]) {
      expect(strip(readFileSync(page, 'utf8')), page).toMatch(/<Throughput\b/);
    }
  });
});

describe('the tab sub-navs', () => {
  /**
   * The strip belongs to the tab's LAYOUT. `useSelectedLayoutSegment()`
   * answers relative to the nearest layout, and a page has no segment below
   * it — so for as long as seven Queries pages and five Cleanup pages each
   * rendered their own, the strip highlighted nothing anywhere, and every
   * test that mocked the hook passed anyway. A page rendering one now would
   * also show it twice.
   */
  it('is rendered by a layout, never by a page', () => {
    const offenders = walk(join(APP, 'db'))
      .filter((f) => f.endsWith('page.tsx') && /<SubNav\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    for (const tab of ['queries', 'cleanup']) {
      expect(readFileSync(join(APP, 'db', '[name]', tab, 'layout.tsx'), 'utf8')).toMatch(/<SubNav\b/);
    }
  });
});

/**
 * The README's route table, held against the routes that actually exist.
 *
 * `/db/<name>/tables` and `/db/<name>/tables/<relation>` shipped, were
 * linked from a tab, were covered by tests, and went undocumented for six
 * commits. Nothing could have noticed: the table is prose, and prose has no
 * compiler. `registry.test.ts` already reads the README's parity table for
 * exactly this reason — "a phase that finishes without the README noticing"
 * — and this is the same failure one directory over.
 *
 * BOTH DIRECTIONS, because the two failures are different and only one of
 * them is the one that just happened. A route with no row is undocumented
 * capability, which is what shipped. A row with no route is a promise the
 * console does not keep, which is worse: it sends an operator to a 404
 * during an incident.
 *
 * Pages only. API routes are documented by tier in the operations section,
 * against a different property (what each one is allowed to do), and folding
 * them in here would make one test answer two questions.
 */
describe('the README route table', () => {
  const README = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');

  /**
   * Scoped to the `## Pages` section. The README backticks a route in plenty
   * of prose elsewhere, and a guard that swept the whole file would read
   * those as table rows and then fail for reasons that have nothing to do
   * with the routes.
   */
  function documentedRoutes(): string[] {
    const section = /\n## Pages\n([\s\S]*?)\n## /.exec(README);
    if (section === null) throw new Error('no "## Pages" section in the README');
    // `!` on both: group 1 is not optional in either pattern, so a match
    // always carries it. Same idiom the space and queryid pages use for an
    // index they have already proved is there.
    return [...section[1]!.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]!);
  }

  /**
   * A directory whose name is parenthesised is a route GROUP: Next uses it to
   * scope a layout and leaves it out of the URL. There are none today, and
   * that is precisely why it is handled here rather than later — the first
   * one added would otherwise fail this test for a spelling reason, which is
   * how a guard gets deleted by the next person it annoys.
   */
  function actualRoutes(): string[] {
    return sources(APP)
      .filter((f) => /[/\\]page\.(tsx|ts|jsx|js)$/.test(f))
      .map((f) => f.slice(APP.length).split(/[/\\]/).slice(1, -1)
        .filter((seg) => !seg.startsWith('('))
        .map((seg) => seg.replace(/^\[(?:\.\.\.)?(.+)\]$/, '<$1>'))
        .join('/'))
      .map((r) => `/${r}`.replace(/\/$/, '') || '/');
  }

  it('names every page the app serves', () => {
    const documented = new Set(documentedRoutes());
    expect(actualRoutes().filter((r) => !documented.has(r)).sort()).toEqual([]);
  });

  it('names no page the app does not serve', () => {
    const actual = new Set(actualRoutes());
    expect(documentedRoutes().filter((r) => !actual.has(r)).sort()).toEqual([]);
  });
});
