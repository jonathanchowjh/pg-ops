// Guards: tests that read source off disk and assert a rule about it.
// `node`, not jsdom: under jsdom Vite's browser-mode transform rewrites
// `new URL('../app', import.meta.url)` into a server-relative asset URL, and
// `readFileSync`/`readdirSync` then throw.
// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '@pgops/checks';

const APP = fileURLToPath(new URL('../app', import.meta.url));
const COMPONENTS = fileURLToPath(new URL('../components', import.meta.url));
const LIB = fileURLToPath(new URL('../lib', import.meta.url));
// apps/web's own root, read with `topLevel` and not walked: it adds the files
// directly in apps/web/ (`proxy.ts`, which runs on every request) without
// re-walking the roots above or `test/`, which does not ship.
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SQL_COMPONENT = join(COMPONENTS, 'sql.tsx');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Files directly inside `dir`, not its subdirectories. */
function topLevel(dir: string): string[] {
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((p) => statSync(p).isFile());
}

/**
 * Line comments first, then block comments. Block-first, an open-comment
 * marker inside a `//` line (a slash followed by an asterisk, as in a URL
 * glob) opens a block that runs to the file's next close-comment marker and
 * deletes the real code in between, blinding every guard that reads the file.
 */
const strip = (code: string) =>
  code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every file Next renders as a route segment, in every `pageExtensions`
 * extension: any of them could read configuration, not only `page` and
 * `layout`.
 */
const RENDERABLE = /\/(page|layout|template|default|error|global-error|loading|not-found|route)\.(tsx|ts|jsx|js)$/;

/**
 * Every extension Next compiles, not just the TypeScript ones: a `page.jsx`
 * would otherwise slip past every guard that uses this list.
 */
const sources = (dir: string) => walk(dir).filter((f) => /\.(tsx?|jsx?)$/.test(f));

describe('dynamic rendering', () => {
  /**
   * Catches a route that reads configuration without opting into dynamic
   * rendering. A statically prerendered route evaluates `process.env` in the
   * build process and freezes it into HTML, so the container would silently
   * talk to the build machine's database. Each such file must call
   * `connection()` itself or go through a seam of lib/check.ts, each of which
   * awaits it: a table's page reads `process.env` and reaches the database
   * through `readStore` and `runSeriesFor`, never `runCheckFor`.
   */
  it('every page or layout touching configuration is explicitly dynamic', () => {
    const offenders: string[] = [];
    for (const file of walk(APP)) {
      if (!RENDERABLE.test(file)) continue;
      const code = strip(readFileSync(file, 'utf8'));
      const readsConfig = /databaseNames\s*\(|process\.env/.test(code);
      if (!readsConfig) continue;
      const isDynamic = /await\s+connection\s*\(\s*\)/.test(code)
        || /\b(?:runCheckFor|runSeriesFor|runToolFor|readStore)\s*\(/.test(code);
      if (!isDynamic) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Catches route-segment config that neutralises the dynamic signal the
   * guard above looks for, such as `export const dynamic = 'force-static'`.
   *
   * `'force-dynamic'` is removed first because it contains a forbidden
   * spelling as a substring. `dynamicParams` is not listed: it decides whether
   * an unlisted param 404s, not whether the segment renders per request.
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
   * Pools live in lib/pools.ts, one per database. A page-level `new Pool`
   * would open a connection per render against the database being diagnosed.
   */
  it('no page or component constructs its own Pool', () => {
    const offenders = [...sources(APP), ...sources(COMPONENTS)]
      .filter((f) => /new\s+Pool\s*\(/.test(strip(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

describe('dead code', () => {
  /**
   * The remodel deletes what it replaces. A module only a test imports ships
   * nothing and is still maintained, so a file here needs an importer that is
   * not a test. Route files are Next's to import.
   */
  it('leaves no file in app, components or lib that nothing imports', () => {
    const files = [...sources(APP), ...sources(COMPONENTS), ...sources(LIB)];
    const importers = [...files, ...topLevel(WEB_ROOT).filter((f) => /\.tsx?$/.test(f))];
    const imported = new Set<string>();
    for (const file of importers) {
      for (const m of strip(readFileSync(file, 'utf8')).matchAll(/(?:from\s+|import\s*\(\s*)['"]((?:\.|@\/)[^'"]+)['"]/g)) {
        imported.add(m[1]!.startsWith('@/') ? join(WEB_ROOT, m[1]!.slice(2)) : resolve(dirname(file), m[1]!));
      }
    }
    const orphans = files.filter((f) => !RENDERABLE.test(f) && !imported.has(f.replace(/\.(tsx?|jsx?)$/, '')));
    expect(orphans).toEqual([]);
  });

  it('gives the sequence mark one home', () => {
    const homes = [...sources(APP), ...sources(COMPONENTS), ...sources(LIB)]
      .filter((f) => strip(readFileSync(f, 'utf8')).includes('CHECKS.sequences.thresholds'));
    expect(homes.map((f) => f.slice(WEB_ROOT.length))).toEqual(['lib/catalog.ts']);
  });
});

describe('module specifiers', () => {
  /**
   * The repo's ESM convention is `.js` on relative imports, but not inside
   * apps/web's source: Next's bundler cannot map `./x.js` onto `x.tsx`. That
   * passes `tsc --noEmit` and every web test and fails only at `next build`,
   * so this catches it in the fast job. Files under test/ run under vitest
   * and keep the repo convention.
   */
  it('uses no .js extension on relative imports in app, lib or components', () => {
    const offenders: string[] = [];
    for (const file of [...walk(APP), ...walk(LIB), ...walk(COMPONENTS)]) {
      if (!/\.tsx?$/.test(file)) continue;
      // Both quote styles and both specifier forms: `@/lib/check.js` fails
      // `next build` exactly as `./pools.js` does.
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
   * Catches an unredacted statement passed to `ExplainHere`. It is a client
   * component, so its props are serialised into the RSC payload before it
   * runs and redacting inside it is too late. The guard below cannot see
   * this when the value is first bound to a variable, so this asserts the
   * permitted shape: every `statement=` prop is wrapped in `safeStatement(...)`.
   */
  it('every statement handed to a client component is redacted first', () => {
    const offenders: string[] = [];
    for (const file of [...sources(APP), ...sources(COMPONENTS)]) {
      const code = strip(readFileSync(file, 'utf8'));
      for (const tag of code.match(/<ExplainHere[^>]*>/g) ?? []) {
        if (!/statement=\{safeStatement\(/.test(tag)) offenders.push(`${file}: ${tag.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });


  /**
   * Catches a query field rendered without `redactSecrets`. `Sql` is the one
   * component that calls it, so `<Sql>…</Sql>` spans are deleted first (the
   * correct form contains the violation as a substring) and then nothing
   * naming `query` may remain in a rendering position. `\b` keeps `queryid`
   * and `queryAgeSecs` out of it.
   *
   * Known limits: the matcher sees one brace span at a time, so a callback
   * that first binds the value to a variable slips through, and so does
   * `prop = {row.query}` with spaces round the `=`. This is an authoring aid;
   * the guarantee is routes.int.test.ts, which seeds a password and reads the
   * rendered HTML of every route.
   */
  it('no page or component renders a query field outside the Sql component', () => {
    const offenders: string[] = [];
    for (const file of [...sources(APP), ...sources(COMPONENTS)]) {
      if (file === SQL_COMPONENT) continue;
      const code = strip(readFileSync(file, 'utf8')).replace(/<Sql>[\s\S]*?<\/Sql>/g, '');
      // Matched by position: a brace span renders only after `>` (a child),
      // `=` (a prop value), `$` (a template substitution) or `}` (a second
      // child). Elsewhere it is an object literal, a type or a destructuring
      // pattern, such as Next's `{ pathname, query }` href.
      const direct = code.match(/(?:>\s*|[=$}])\{[^{}]*\bquery\b[^{}]*\}/g) ?? [];
      if (direct.length > 0) offenders.push(`${file}: ${direct.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Catches a query used as a React `key`. A key is not an HTML attribute,
   * but under React Server Components it is serialised into the Flight
   * payload embedded in the page, so a secret used as a key is published.
   */
  it('no key= expression is built from a query-ish field', () => {
    const offenders: string[] = [];
    const FIELD = /\b(query|statement)\b|\.sql\b/;
    for (const file of [...sources(APP), ...sources(COMPONENTS)]) {
      const code = strip(readFileSync(file, 'utf8'));
      // One level of nested braces, so a template-literal key such as
      // `key={`${w.type}-${w.event ?? ''}`}` is matched as a single span.
      for (const m of code.matchAll(/key\s*=\s*\{(?:[^{}]|\{[^{}]*\})*\}/g)) {
        if (FIELD.test(m[0])) {
          const line = code.slice(0, m.index).split('\n').length;
          offenders.push(`${file}:${line}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The tree view and the rows view are client components, so the
   * statements in their `tree` prop are in the page before they run. The
   * page redacts at the call site.
   */
  it('hands the tree to its client views redacted', () => {
    const offenders: string[] = [];
    for (const file of [...sources(APP), ...sources(COMPONENTS)]) {
      const code = strip(readFileSync(file, 'utf8'));
      for (const tag of code.match(/<(?:TreeView|RowsView)\b[\s\S]*?\/>/g) ?? []) {
        if (!/tree=\{redactTree\(/.test(tag)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  /** A scatter is a client component too, and a statement is a point's label on one page. */
  it('redacts a statement before it is a point on the Queries scatter', () => {
    const page = strip(readFileSync(join(APP, 'db', '[name]', 'queries', 'page.tsx'), 'utf8'));
    expect(page).toMatch(/label:\s*clip\(/);
    expect(page).toMatch(/const clip[\s\S]{0,120}safeStatement\(/);
  });

  it('the Sql component actually calls redactSecrets', () => {
    const code = readFileSync(SQL_COMPONENT, 'utf8');
    expect(code).toMatch(/redactSecrets\s*\(/);
  });
});

describe('the refresh ticker', () => {
  /**
   * Catches the component clearing `inFlight` on a timer instead of on
   * `useTransition`, which would let refreshes overlap. refresh.test.ts
   * supplies `inFlight` itself, so it cannot see this wiring.
   */
  it('ends its flight on the transition, not on a timer', () => {
    const code = strip(readFileSync(join(COMPONENTS, 'refresh.tsx'), 'utf8'));
    expect(code).toMatch(/useTransition\s*\(\s*\)/);
    expect(code).toMatch(/startTransition\s*\(/);
    expect(code).not.toMatch(/setTimeout\s*\(/);
  });
});

describe('screen-reader tables', () => {
  /**
   * A table ignores the width and overflow `sr-only` sets, so a hidden table
   * of a panel's numbers lays out at full width and, measured on Server at
   * 390 px, scrolls the page sideways. It goes inside a block that carries
   * the class.
   */
  it('puts no sr-only class on a table itself', () => {
    const offenders = sources(COMPONENTS).filter((f) => /<table\b[^>]*\bsr-only\b/.test(strip(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

describe('one home per setting', () => {
  /** A second copy of an hour is a second place to change it, and the copies drift. */
  it('defines the clock\'s units only in lib/clock.ts', () => {
    const home = join(LIB, 'clock.ts');
    const offenders = [APP, COMPONENTS, LIB].flatMap(sources)
      .filter((f) => f !== home && /\bconst (HOUR_MS|DAY_MS|MINUTE_MS)\b/.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(WEB_ROOT.length));
    expect(offenders).toEqual([]);
  });
});

describe('the kill gate', () => {
  /**
   * Catches a second caller of an action (a Server Action, a helper) that
   * skips `actionsAllowed`. Matches either spelling: `killBackend` is
   * re-exported as a type only, and the runtime path is `ACTIONS`, every
   * member of which writes to a monitored database.
   *
   * The list is exact, not a pattern over the api directory, so a new action
   * route is a deliberate edit here. It is written as the set of importing
   * files because the correct path is a substring of any wrong path under it.
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
    const topLevelSources = topLevel(WEB_ROOT).filter((f) => /\.(tsx?|jsx?)$/.test(f));
    const importers = [...sources(APP), ...sources(COMPONENTS), ...sources(LIB), ...topLevelSources]
      .filter((f) => /\bkillBackend\b|\bACTIONS\b/.test(strip(readFileSync(f, 'utf8'))))
      .sort();
    expect(importers).toEqual(ROUTES);
  });
});

describe('the poll boundary', () => {
  /**
   * Catches `<Refresh>` on the wrong set of pages. Both mistakes are silent:
   * an incident page that loses it stops updating during an incident, and a
   * page of captured reads that gains it (or a layout that renders it) puts
   * a catalog scan on a 5-second timer. Set equality covers both directions.
   */
  const INCIDENT_PAGES = [
    join(APP, 'db', '[name]', 'page.tsx'),
    join(APP, 'db', '[name]', 'queries', 'page.tsx'),
    // A node's page polls: the sessions on it are live. Its catalog comes through lib/catalog.ts.
    join(APP, 'db', '[name]', 'tables', '[relation]', 'page.tsx'),
    join(APP, 'db', '[name]', 'queries', '[queryid]', 'page.tsx'),
    // Who holds the connections and what holds the horizon are live.
    join(APP, 'db', '[name]', 'server', 'page.tsx'),
  ];

  /** The fleet polls at the sample cadence and reads the store only, so its tick costs the monitored databases nothing. */
  const FLEET = join(APP, 'page.tsx');

  it('renders <Refresh> in exactly the incident pages and the fleet', () => {
    const polling = sources(APP)
      .filter((f) => /<Refresh\b/.test(strip(readFileSync(f, 'utf8'))))
      .sort();
    expect(polling).toEqual([...INCIDENT_PAGES, FLEET].sort());
  });

  /**
   * A page that polls every five seconds may run no catalog scan. Its
   * catalog comes through lib/catalog.ts, which reads at most once a
   * minute; catalog.test.ts holds that.
   */
  it('runs no captured read from a polled page', () => {
    for (const file of INCIDENT_PAGES) {
      const code = strip(readFileSync(file, 'utf8'));
      for (const c of Object.values(CHECKS).filter((x) => x.class === 'captured')) {
        expect(code, file).not.toMatch(new RegExp(`CHECKS\\.${c.id}\\b`));
      }
    }
    expect(strip(readFileSync(join(APP, 'db', '[name]', 'page.tsx'), 'utf8'))).toMatch(/tablesFor\(/);
  });

  /** Set equality above would be satisfied by a fleet polling at 5s. */
  it('polls the fleet strictly slower than an incident page', () => {
    const interval = (file: string): number => {
      const m = /<Refresh\s+intervalMs=\{([0-9_]+)\}/.exec(strip(readFileSync(file, 'utf8')));
      if (m === null) throw new Error(`no <Refresh intervalMs={…}> in ${file}`);
      return Number(m[1]!.replace(/_/g, ''));
    };
    for (const page of INCIDENT_PAGES) {
      expect(interval(FLEET)).toBeGreaterThan(interval(page));
    }
  });

  it('polls the fleet at the sample cadence, and never a monitored database', () => {
    const code = strip(readFileSync(FLEET, 'utf8'));
    expect(code).toMatch(/<Refresh\s+intervalMs=\{15_000\}/);
    expect(code).not.toMatch(/runCheckFor|contextFor|CHECKS\./);
  });
});

const CHECKS_SRC = fileURLToPath(new URL('../../../packages/checks/src', import.meta.url));

describe('the DDL boundary', () => {
  it('confines every DDL statement to store/migrations/', () => {
    // Catches DDL anywhere but the migration runner, which runs only when
    // PGOPS_STORE_URL is set and only against that URL. pgops issues no DDL
    // against a monitored database. apps/web is scanned too: it holds the
    // pools to the monitored databases.
    //
    // TRUNCATE is anchored on TABLE/ONLY or a bare identifier followed by a
    // semicolon: with the `i` flag a looser form matches Tailwind's
    // `truncate` class.
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
        // Relative path, not basename: two `page.tsx` files must not report
        // as the same offender.
        .map((p) => `${label}/${p.slice(root.length + 1)}`),
    );
    // The two expected matches issue no DDL; the regex cannot tell a
    // statement from a string about one. run.ts's `remedyFor` builds the
    // advice `CREATE EXTENSION <name>;`, and tools/advice.ts builds the index
    // statement handed to the operator to run themselves. Pinned by exact
    // list equality rather than skipped, so a third file still fails.
    expect(matched).toEqual(['packages/checks/src/run.ts', 'packages/checks/src/tools/advice.ts']);
  });
});

describe('capture', () => {
  const RESET = /pg_stat_statements_reset|pg_stat_reset\b/i;

  /**
   * `health` is optional on SchedulerDeps, so forgetting it at boot is
   * silent: the console would capture and never write a health row.
   */
  it('wires the health tick into the scheduler at boot', () => {
    const code = strip(readFileSync(fileURLToPath(new URL('../instrumentation.ts', import.meta.url)), 'utf8'));
    expect(code).toMatch(/health:\s*async/);
    expect(code).toMatch(/captureHealth\(/);
  });

  /** `sample` is optional too, and the sampler must start with no store at all. */
  it('wires the sampler into the scheduler at boot, store or no store', () => {
    const code = strip(readFileSync(fileURLToPath(new URL('../instrumentation.ts', import.meta.url)), 'utf8'));
    expect(code).toMatch(/sample:\s*sampleTick/);
    expect(code).not.toMatch(/if\s*\(store === null\)\s*\{[^}]*return/);
  });

  /** `place` is optional too; without it no statement nobody is running is ever put under a table. */
  it('wires the placement tick into the scheduler at boot', () => {
    const code = strip(readFileSync(fileURLToPath(new URL('../instrumentation.ts', import.meta.url)), 'utf8'));
    expect(code).toMatch(/place:\s*placeTick/);
  });

  /**
   * Catches a statistics reset outside the gated action. Resetting
   * pg_stat_statements as part of capture, as pgHero does, breaks every other
   * consumer on the database. The behavioural proof is capture.int.test.ts;
   * this is the source-level tripwire. Exact list equality, so a second file
   * fails.
   */
  it('names a statistics reset in exactly one file — the gated action', () => {
    const offenders = walk(CHECKS_SRC)
      .filter((p) => p.endsWith('.ts'))
      .filter((p) => RESET.test(strip(readFileSync(p, 'utf8'))))
      .map((p) => p.slice(CHECKS_SRC.length + 1));
    expect(offenders).toEqual([join('actions', 'stats.ts')]);
  });

  /** The allowlist above could be edited; this names the files that may never reset. */
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
   * Catches a second path for operator-written SQL. `planStatements` is the
   * one path: a named statement, read-only, rolled back, its connection
   * destroyed. explain.int.test.ts holds the behaviour.
   */
  it('is prepared in exactly one file', () => {
    const offenders = sources(CHECKS_SRC)
      .filter((p) => /\bPREPARE\s/.test(strip(readFileSync(p, 'utf8'))))
      .map((p) => p.slice(CHECKS_SRC.length + 1));
    expect(offenders).toEqual([join('tools', 'explain.ts')]);
  });
});

/**
 * Catches the README's route table drifting from the pages that exist, in
 * both directions: a route with no row is undocumented, and a row with no
 * route sends an operator to a 404. Pages only; API routes are documented by
 * tier in the operations section.
 */
describe('the README route table', () => {
  const README = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');

  /** Scoped to the `## Pages` section: the README backticks routes in prose elsewhere. */
  function documentedRoutes(): string[] {
    const section = /\n## Pages\n([\s\S]*?)\n## /.exec(README);
    if (section === null) throw new Error('no "## Pages" section in the README');
    // `!` on both: group 1 is not optional in either pattern.
    return [...section[1]!.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]!);
  }

  /**
   * A parenthesised directory is a route group, which Next leaves out of the
   * URL. There are none today; handled so the first one does not fail this test.
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
