# P1a — The Console Renders: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Next.js console that renders the five incident routes over `@pgops/checks` against one or many configured databases, refreshing on an interval, with every rendered query redacted.

**Architecture:** Next 16 App Router, Server Components calling `runCheck` directly with no internal HTTP layer. Configuration is read at request time — never at build time — so one image serves any database. A pool is created per configured database and cached for the process lifetime. The only client component is the refresh ticker.

**Tech Stack:** Next 16.3.3, React 19, TypeScript 5.7, Tailwind + shadcn/ui (Radix primitives), `@pgops/checks` (workspace), Vitest 4, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-08-26-pgops-web-design.md` — §6 (the web app), §7.3 (redaction), §8 (configuration). The spec is the binding authority; this plan argues from it.

**Prior art in this repo:** `docs/superpowers/reviews/2026-08-27-p0-decision-record.md` holds the 64 rulings behind `packages/checks`. Rulings 49 and 55 bind work here and are quoted where they apply.

## Global Constraints

- **Node floor is 22.** PostgreSQL floor is 14; CI matrix is 14, 16, 17, 18.
- **Every check-rendering path calls `await connection()` from `next/server` before reading configuration or running a check.** This is not a preference. A statically prerendered route evaluates `process.env` **in the build process** and freezes the result into HTML — Turbopack does not textually inline server-side env, so the mechanism is prerender-time evaluation, not substitution. The entire configuration model is `docker run -e PGOPS_DATABASES=… pgops` against an image built months earlier. Get this wrong and the container talks to whatever database was set when the image was built. Enforced by a guard test in Task 12.
- **`redactSecrets` runs on every rendered query string, not just on export.** It matters more here than in the terminal: a screenshot needs a human to take it, a URL forwards itself.
- **No internal HTTP layer.** Pages call `runCheck` directly. An API route exists only where something outside the process consumes it — nothing in P1a does.
- **No websockets.** Refresh is `router.refresh()` on an interval that skips rather than queues.
- **No chart library.** No charts at all in P1a; trend views are P4.
- **`packages/checks` is not modified by this plan.** If a check needs a change, that is a finding to report, not a task to do. Its `dependencies` stay exactly `["pg"]`.
- **`src/` (the Ink TUI) is not modified and not deleted in P1a.** It is deleted in P1b. It keeps working off its own code.
- **Actions are out of scope.** No `kill`, no mutation of any kind. P1a is read-only. `PGOPS_ALLOW_ACTIONS` and the action routes arrive in P1b.
- Existing repo conventions: 2-space indent, ESM with `.js` import specifiers in `packages/` and `src/`, comments explain *why* and cite the defect they prevent.

## Two hazards this plan works around, both verified

**1. Two React majors in one workspace.** The repo root declares `react: ^18.3.1` for Ink. `apps/web` needs React 19 for Next 16's App Router. npm workspace hoisting will put 18 at the root and must nest 19 under `apps/web/node_modules`. Task 1 verifies the nesting explicitly with `npm ls react` rather than assuming it. This resolves itself in P1b when the TUI and Ink are deleted.

**2. `@pgops/checks` exports built output.** Its `exports` field is `"./dist/index.js"`, and `dist/` is git-ignored. The web app therefore cannot import it until the package is built. Every task that runs the web app builds the package first. This is deliberate rather than switching `exports` to source — Ruling 49 established that the package's *declaration* is its contract, and pointing consumers at `src/` would quietly void it.

## File Structure

```
apps/web/
  package.json          Next app manifest. Declares react/react-dom 19 explicitly.
  next.config.ts        output: 'standalone' (P1b needs it; harmless now).
  tsconfig.json         Extends tsconfig.base.json. Path alias @/* -> ./
  components.json       shadcn config (generated, then committed).
  postcss.config.mjs    Tailwind.
  app/
    layout.tsx          Root shell: html/body, globals.css, nothing else.
    globals.css         Tailwind directives + shadcn CSS variables.
    page.tsx            "/" overview: every database, worst verdict each.
    db/[name]/
      layout.tsx        Resolves the database name, renders the nav strip.
      page.tsx          Triage: every incident check on one screen.
      sessions/page.tsx Live sessions table.
      locks/page.tsx    Wait graph, rendered as a tree.
      queries/page.tsx  pg_stat_statements, redacted.
  lib/
    config.ts           Env -> DatabaseConfig[]. Pure given an env object.
    pools.ts            Pool per database, cached. serverVersion probe.
    check.ts            runCheckFor(dbName, check, opts) -> CheckResult.
    format.ts           Duration/bytes/percent formatting. Pure.
    utils.ts            shadcn's cn() helper (generated by its CLI).
  components/
    ui/                 shadcn components, added one at a time as needed.
    check-panel.tsx     Renders any CheckResult uniformly, including !ok.
    verdict-badge.tsx   Verdict level -> badge.
    refresh.tsx         'use client'. The only client component in P1a.
  test/
    config.test.ts      Unit. Config parsing, every branch.
    format.test.ts      Unit. Formatting edge cases.
    refresh.test.ts     Unit (jsdom). The three polling properties.
    check-panel.test.tsx Unit (jsdom). ok and !ok rendering.
    routes.int.test.ts  Integration. Real Postgres, real built app, real HTTP.
    guards.test.ts      Unit. The connection() and redaction guards.
```

**Why `lib/` is split four ways.** `config.ts` is pure and heavily branched, so it is the one file worth exhaustive unit tests. `pools.ts` holds the process-lifetime cache — the only module-level mutable state in this plan, and deliberately so. `check.ts` is the seam every page goes through, which is where the `connection()` discipline is enforced once instead of on eleven pages. `format.ts` is pure presentation. Files that change together live together; these four change for four different reasons.

**A note for reviewers on module-level state.** `packages/checks` forbids module-level mutable state — pools are passed in via `CheckContext`. That constraint is about the *library*. `apps/web/lib/pools.ts` deliberately holds a module-level `Map` of pools, because a web process that opened a new pool per request would exhaust `max_connections` on the database it exists to diagnose. This is the correct place for that state and the only place it appears.

---

### Task 1: The workspace scaffold

**Files:**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/globals.css`
- Modify: `vitest.config.ts` (add the `web` project)
- Test: `apps/web/test/scaffold.test.ts`

**Interfaces:**
- Produces: the `apps/web` workspace, importable as `@pgops/web`; a `web` vitest project running files under `apps/web/test/**`.

- [ ] **Step 1: Write the failing test**

`apps/web/test/scaffold.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('apps/web manifest', () => {
  /**
   * The root declares react 18 for Ink. Next 16's App Router needs 19. npm
   * hoisting puts one at the root and must nest the other here; declaring it
   * explicitly is what makes the nesting happen at all. Verified for real by
   * `npm ls react` in Step 4 — this assertion only pins the declaration.
   */
  it('declares react 19 explicitly rather than inheriting the root react 18', () => {
    expect(pkg.dependencies.react).toMatch(/^\^?19\./);
    expect(pkg.dependencies['react-dom']).toMatch(/^\^?19\./);
  });

  it('depends on the checks package by workspace protocol', () => {
    expect(pkg.dependencies['@pgops/checks']).toBe('*');
  });

  /**
   * The web app must never reach into packages/checks' source. Ruling 49: the
   * package's declaration is its contract, and a relative import across the
   * workspace boundary would void it silently.
   */
  it('has no dependency that reaches around the checks package', () => {
    expect(Object.keys(pkg.dependencies)).not.toContain('pg');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/test/scaffold.test.ts`
Expected: FAIL — `ENOENT` reading `apps/web/package.json`.

- [ ] **Step 3: Create the app**

`apps/web/package.json`:

```json
{
  "name": "@pgops/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "npm run --workspace @pgops/checks build && next dev",
    "build": "npm run --workspace @pgops/checks build && next build",
    "start": "next start",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@pgops/checks": "*",
    "next": "16.3.3",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.7.2"
  }
}
```

`apps/web/next.config.ts`:

```ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  // P1b builds the Docker image from this. Standalone traces only the files
  // actually reached, so the runtime layer carries no build toolchain.
  // Set here rather than in P1b so the build output shape never changes late.
  output: 'standalone',
};

export default config;
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "jsx": "preserve",
    "module": "esnext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`apps/web/app/layout.tsx`:

```tsx
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'pgops' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`apps/web/app/page.tsx` — a placeholder replaced in Task 7:

```tsx
export default function Page() {
  return <main>pgops</main>;
}
```

`apps/web/app/globals.css` — replaced in Task 2:

```css
body { margin: 0; }
```

- [ ] **Step 4: Install and verify the React nesting is real**

```bash
npm install
npm ls react
```

Expected: two entries — `react@18.3.1` at the root (for Ink) and `react@19.x` under `apps/web`. If instead npm reports a single hoisted `react@18`, STOP and report it: Next 16's App Router will fail in ways that look like unrelated rendering bugs, and no later task can work around it.

- [ ] **Step 5: Add the web vitest project**

In `vitest.config.ts`, add a third project alongside `unit` and `integration`:

```ts
{
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['apps/web/test/**/*.test.{ts,tsx}'],
    exclude: ['apps/web/test/**/*.int.test.ts'],
  },
},
```

Add to the root `package.json` scripts: `"test:web": "vitest run --project web"`.

Install the jsdom environment and the JSX transform. NOT @testing-library/react — it hoists to
the repo root beside the Ink TUI's react 18 and cannot render this app's react 19 (see
`apps/web/test/render.tsx` for the full account and the local `render` helper that replaces it):

```bash
npm install -D --legacy-peer-deps jsdom @vitejs/plugin-react
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project web apps/web/test/scaffold.test.ts`
Expected: PASS, 3 tests.

Also run `npm run --workspace @pgops/web build` once. Expected: a successful Next build. This is the only proof the scaffold is real.

- [ ] **Step 7: Commit**

```bash
git add apps/web vitest.config.ts package.json package-lock.json
git commit -m "feat(web): the Next scaffold, with react 19 nested beside the TUI's 18"
```

---

### Task 2: Tailwind and shadcn

**Files:**
- Create: `apps/web/components.json`, `apps/web/postcss.config.mjs`, `apps/web/lib/utils.ts`, `apps/web/components/ui/table.tsx`, `apps/web/components/ui/badge.tsx`
- Modify: `apps/web/app/globals.css`, `apps/web/package.json`
- Test: `apps/web/test/scaffold.test.ts` (extend)

**Interfaces:**
- Produces: `cn(...inputs)` from `@/lib/utils`; shadcn `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell` and `Badge` from `@/components/ui/*`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/scaffold.test.ts`:

```ts
import { existsSync } from 'node:fs';

describe('shadcn wiring', () => {
  it('has a components.json whose aliases match the tsconfig path alias', () => {
    const cfg = JSON.parse(readFileSync(new URL('../components.json', import.meta.url), 'utf8'));
    expect(cfg.aliases.ui).toBe('@/components/ui');
    expect(cfg.aliases.utils).toBe('@/lib/utils');
  });

  /**
   * shadcn copies component SOURCE into the repo rather than installing a
   * package. That is the whole point of choosing it — the components are ours
   * to edit — but it also means a missing file is a silent build failure at
   * the point of use rather than an install error. Pin the two we rely on.
   */
  it('has the table and badge components checked in', () => {
    expect(existsSync(new URL('../components/ui/table.tsx', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../components/ui/badge.tsx', import.meta.url))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project web apps/web/test/scaffold.test.ts`
Expected: FAIL — `ENOENT` on `components.json`.

- [ ] **Step 3: Initialize shadcn**

From `apps/web`:

```bash
npx shadcn@latest init
```

Answer its prompts: style `new-york`, base color `neutral`, CSS variables `yes`. It writes `components.json`, `postcss.config.mjs`, `lib/utils.ts`, rewrites `app/globals.css`, and adds `tailwindcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, and `lucide-react` to `package.json`.

Then add the two components this plan uses:

```bash
npx shadcn@latest add table badge
```

- [ ] **Step 4: Verify the alias resolves**

`components.json`'s `aliases.ui` must be `@/components/ui` and `aliases.utils` must be `@/lib/utils`, matching the `@/*` path alias set in Task 1's tsconfig. If the CLI wrote different aliases, edit `components.json` to match — the tsconfig is the fixed point.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project web apps/web/test/scaffold.test.ts`
Expected: PASS, 5 tests.

Run: `npm run --workspace @pgops/web build`
Expected: successful build with Tailwind applied.

- [ ] **Step 6: Commit**

```bash
git add apps/web package-lock.json
git commit -m "feat(web): tailwind and the two shadcn components the console needs"
```

---

### Task 3: Database configuration

**Files:**
- Create: `apps/web/lib/config.ts`
- Test: `apps/web/test/config.test.ts`

**Interfaces:**
- Produces:
  - `interface DatabaseConfig { name: string; url: string }`
  - `function readDatabases(env: NodeJS.ProcessEnv): DatabaseConfig[]` — throws `ConfigError` on malformed input.
  - `class ConfigError extends Error`

- [ ] **Step 1: Write the failing test**

`apps/web/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, readDatabases } from '../lib/config.js';

describe('readDatabases', () => {
  it('reads a single DATABASE_URL as one database named "default"', () => {
    expect(readDatabases({ DATABASE_URL: 'postgres://h/db' }))
      .toEqual([{ name: 'default', url: 'postgres://h/db' }]);
  });

  it('reads PGOPS_DATABASES as JSON', () => {
    const env = { PGOPS_DATABASES: '[{"name":"prod","url":"postgres://a/x"},{"name":"eu","url":"postgres://b/y"}]' };
    expect(readDatabases(env)).toEqual([
      { name: 'prod', url: 'postgres://a/x' },
      { name: 'eu', url: 'postgres://b/y' },
    ]);
  });

  /**
   * PGOPS_DATABASES wins. A deployment that sets both is almost certainly
   * migrating from one to many, and silently serving only the single database
   * would look like the new configuration was ignored.
   */
  it('prefers PGOPS_DATABASES when both are set', () => {
    const env = { DATABASE_URL: 'postgres://h/db', PGOPS_DATABASES: '[{"name":"prod","url":"postgres://a/x"}]' };
    expect(readDatabases(env)).toEqual([{ name: 'prod', url: 'postgres://a/x' }]);
  });

  it('throws a ConfigError naming the variable when neither is set', () => {
    expect(() => readDatabases({})).toThrow(ConfigError);
    expect(() => readDatabases({})).toThrow(/DATABASE_URL|PGOPS_DATABASES/);
  });

  it('throws a ConfigError rather than a SyntaxError on malformed JSON', () => {
    expect(() => readDatabases({ PGOPS_DATABASES: '[{' })).toThrow(ConfigError);
  });

  it('rejects an entry missing a name or url', () => {
    expect(() => readDatabases({ PGOPS_DATABASES: '[{"name":"prod"}]' })).toThrow(ConfigError);
    expect(() => readDatabases({ PGOPS_DATABASES: '[{"url":"postgres://a/x"}]' })).toThrow(ConfigError);
  });

  /**
   * Names become URL path segments (/db/[name]). A duplicate would make one of
   * them unreachable — the kind of misconfiguration that presents as "the eu
   * database shows prod's numbers", which is far worse than a startup error.
   */
  it('rejects duplicate names', () => {
    const env = { PGOPS_DATABASES: '[{"name":"p","url":"postgres://a/x"},{"name":"p","url":"postgres://b/y"}]' };
    expect(() => readDatabases(env)).toThrow(/duplicate/i);
  });

  it('rejects a name that would not survive a URL path segment', () => {
    const env = { PGOPS_DATABASES: '[{"name":"a/b","url":"postgres://a/x"}]' };
    expect(() => readDatabases(env)).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project web apps/web/test/config.test.ts`
Expected: FAIL — cannot resolve `../lib/config.js`.

- [ ] **Step 3: Write the implementation**

`apps/web/lib/config.ts`:

```ts
/**
 * Configuration is read from the environment AT REQUEST TIME, never at module
 * scope. Every caller passes `process.env` in explicitly, which is what makes
 * this file pure and exhaustively testable — and, more importantly, what stops
 * a module-scope read from being evaluated during `next build` and baked into
 * the image. See the plan's Global Constraints on `connection()`.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface DatabaseConfig {
  /** URL path segment under /db/. Unique. */
  name: string;
  url: string;
}

/** Path-segment safe: no slashes, no encoding surprises, no empty string. */
const NAME = /^[A-Za-z0-9_-]+$/;

export function readDatabases(env: NodeJS.ProcessEnv): DatabaseConfig[] {
  const many = env.PGOPS_DATABASES;
  if (many) return parseMany(many);

  const one = env.DATABASE_URL;
  if (one) return [{ name: 'default', url: one }];

  throw new ConfigError(
    'No database configured. Set DATABASE_URL for one database, or PGOPS_DATABASES ' +
    'to a JSON array of {name, url} for several.',
  );
}

function parseMany(raw: string): DatabaseConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A raw SyntaxError here reads as a bug in pgops rather than a typo in the
    // operator's own deployment configuration, which is what it actually is.
    throw new ConfigError(`PGOPS_DATABASES is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigError('PGOPS_DATABASES must be a non-empty JSON array of {name, url}.');
  }

  const seen = new Set<string>();
  return parsed.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigError(`PGOPS_DATABASES[${i}] is not an object.`);
    }
    const { name, url } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new ConfigError(
        `PGOPS_DATABASES[${i}].name must match ${NAME.source} — it becomes a URL path segment.`,
      );
    }
    if (typeof url !== 'string' || url === '') {
      throw new ConfigError(`PGOPS_DATABASES[${i}].url must be a non-empty connection string.`);
    }
    if (seen.has(name)) throw new ConfigError(`PGOPS_DATABASES has a duplicate name: ${name}`);
    seen.add(name);
    return { name, url };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web apps/web/test/config.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove one assertion is not vacuous**

Delete the `seen.has(name)` check, re-run, and confirm the duplicate-names test fails. Restore it. Report which assertion you proved.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/config.ts apps/web/test/config.test.ts
git commit -m "feat(web): database configuration, read at request time and validated"
```

---

### Task 4: Pools and the check seam

**Files:**
- Create: `apps/web/lib/pools.ts`, `apps/web/lib/check.ts`
- Test: `apps/web/test/check.int.test.ts`

**Interfaces:**
- Consumes: `readDatabases(env)`, `DatabaseConfig`, `ConfigError` from Task 3. From `@pgops/checks`: `runCheck`, `CheckContext`, `CheckResult`, `Check`, `CHECKS`.
- Produces:
  - `function contextFor(name: string): Promise<CheckContext>` — throws `UnknownDatabaseError` if `name` is not configured.
  - `class UnknownDatabaseError extends Error`
  - `function databaseNames(): string[]`
  - `async function runCheckFor<Row, Data>(name: string, check: Check<Row, Data, void>): Promise<CheckResult<Data>>`
  - `async function runCheckFor<Row, Data, Opts>(name: string, check: Check<Row, Data, Opts>, opts: Opts): Promise<CheckResult<Data>>`

- [ ] **Step 1: Write the failing test**

`apps/web/test/check.int.test.ts` — this runs under the `integration` project against a real container:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKS } from '@pgops/checks';

let pg: StartedPostgreSqlContainer;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:17-alpine').start();
  process.env.PGOPS_DATABASES = JSON.stringify([{ name: 'primary', url: pg.getConnectionUri() }]);
}, 120_000);

afterAll(async () => { await pg?.stop(); });

describe('runCheckFor', () => {
  it('runs a check against the named database and reports ok', async () => {
    const { runCheckFor } = await import('../lib/check.js');
    const r = await runCheckFor('primary', CHECKS.connections);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.max).toBeGreaterThan(0);
  });

  /**
   * The serverVersion in the context must be the REAL one read from the
   * server, not a constant. A hardcoded floor would make every version-gated
   * check appear supported on a server that does not support it -- the exact
   * failure `requires: {kind:'version'}` exists to prevent.
   */
  it('probes the real server version into the context', async () => {
    const { contextFor } = await import('../lib/pools.js');
    const ctx = await contextFor('primary');
    expect(ctx.serverVersion).toBeGreaterThanOrEqual(140000);
    const { rows } = await ctx.target.query<{ v: string }>('SHOW server_version_num');
    expect(ctx.serverVersion).toBe(Number(rows[0]!.v));
  });

  /**
   * One pool per database for the process lifetime. A pool per request would
   * exhaust max_connections on the database this tool exists to diagnose,
   * during the incident it exists to diagnose it.
   */
  it('reuses one pool across calls for the same database', async () => {
    const { contextFor } = await import('../lib/pools.js');
    const a = await contextFor('primary');
    const b = await contextFor('primary');
    expect(a.target).toBe(b.target);
  });

  it('throws UnknownDatabaseError for a name that is not configured', async () => {
    const { contextFor, UnknownDatabaseError } = await import('../lib/pools.js');
    await expect(contextFor('nope')).rejects.toThrow(UnknownDatabaseError);
  });

  /**
   * runCheck never rejects, and neither does this. A page renders a failed
   * check; it must never render a stack trace.
   */
  it('returns ok:false rather than rejecting when a check cannot run', async () => {
    const { runCheckFor } = await import('../lib/check.js');
    const broken = { ...CHECKS.connections, sql: 'SELECT * FROM does_not_exist' };
    const r = await runCheckFor('primary', broken);
    expect(r.ok).toBe(false);
  });
});
```

Add `apps/web/test/**/*.int.test.ts` to the `integration` project's `include` in `vitest.config.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project integration apps/web/test/check.int.test.ts`
Expected: FAIL — cannot resolve `../lib/pools.js`.

- [ ] **Step 3: Write pools.ts**

```ts
import { Pool } from 'pg';
import type { CheckContext } from '@pgops/checks';
import { readDatabases, type DatabaseConfig } from './config.js';

export class UnknownDatabaseError extends Error {
  constructor(name: string, known: string[]) {
    super(`No database named "${name}". Configured: ${known.join(', ') || '(none)'}`);
    this.name = 'UnknownDatabaseError';
  }
}

/**
 * The ONE piece of module-level mutable state in this app, and deliberately so
 * (see the plan's note to reviewers). `packages/checks` forbids it because a
 * library that reaches for a pool can only ever address one database. A web
 * PROCESS is the opposite case: opening a pool per request would exhaust
 * max_connections on the database it is diagnosing, at exactly the moment that
 * matters. Keyed by connection URL rather than by name so that two names
 * pointing at one database share a pool, and so a renamed database does not
 * strand its pool.
 */
const POOLS = new Map<string, Pool>();
const VERSIONS = new Map<string, number>();

function configured(): DatabaseConfig[] {
  return readDatabases(process.env);
}

export function databaseNames(): string[] {
  return configured().map((d) => d.name);
}

function poolFor(db: DatabaseConfig): Pool {
  const existing = POOLS.get(db.url);
  if (existing) return existing;
  const pool = new Pool({
    connectionString: db.url,
    // A diagnostic tool must not be the reason connections run out. Ten is
    // ample for a console rendering a handful of checks per page view.
    max: 10,
    // Fail visibly rather than hanging a page render forever.
    connectionTimeoutMillis: 5_000,
  });
  // A pool-level error with no listener is an unhandled 'error' event, which
  // terminates the Node process. A console that dies because an idle backend
  // was terminated server-side is worse than one that renders a failed check.
  pool.on('error', () => {});
  POOLS.set(db.url, pool);
  return pool;
}

export async function contextFor(name: string): Promise<CheckContext> {
  const dbs = configured();
  const db = dbs.find((d) => d.name === name);
  if (!db) throw new UnknownDatabaseError(name, dbs.map((d) => d.name));

  const target = poolFor(db);

  // Probed once per database, then cached: server_version_num cannot change
  // without the server restarting, and a restart drops the pool anyway.
  let serverVersion = VERSIONS.get(db.url);
  if (serverVersion === undefined) {
    const { rows } = await target.query<{ server_version_num: string }>('SHOW server_version_num');
    serverVersion = Number(rows[0]!.server_version_num);
    VERSIONS.set(db.url, serverVersion);
  }

  return { target, serverVersion };
}
```

- [ ] **Step 4: Write check.ts**

```ts
import { connection } from 'next/server';
import { runCheck, type Check, type CheckResult } from '@pgops/checks';
import { contextFor } from './pools.js';

/**
 * The single seam every page runs a check through.
 *
 * `await connection()` lives HERE, once, rather than on eleven pages. In a
 * Server Component `process.env.DATABASE_URL` is inlined at BUILD time unless
 * the component opts into dynamic rendering — and the whole configuration
 * model is `docker run -e DATABASE_URL=…` against an image built months
 * earlier. Getting this wrong points the container at whatever database was
 * set when the image was built, silently and forever. Task 12's guard test
 * asserts no page reads configuration around this seam.
 *
 * It never rejects, because `runCheck` never rejects and `contextFor`'s own
 * failures are converted here. A page renders a failed check; it must never
 * render a stack trace.
 */
export async function runCheckFor<Row, Data>(
  name: string,
  check: Check<Row, Data, void>,
): Promise<CheckResult<Data>>;
export async function runCheckFor<Row, Data, Opts>(
  name: string,
  check: Check<Row, Data, Opts>,
  opts: Opts,
): Promise<CheckResult<Data>>;
export async function runCheckFor<Row, Data, Opts>(
  name: string,
  check: Check<Row, Data, Opts>,
  opts?: Opts,
): Promise<CheckResult<Data>> {
  await connection();
  try {
    const ctx = await contextFor(name);
    return opts === undefined
      ? await runCheck(ctx, check as Check<Row, Data, void>)
      : await runCheck(ctx, check, opts);
  } catch (err) {
    return { ok: false, reason: 'unreachable', message: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run --workspace @pgops/checks build && npx vitest run --project integration apps/web/test/check.int.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Prove the pool cache is real**

Change `POOLS.set(db.url, pool)` to not store, re-run, and confirm the "reuses one pool" test fails. Restore it.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/pools.ts apps/web/lib/check.ts apps/web/test/check.int.test.ts vitest.config.ts
git commit -m "feat(web): one pool per database, and the seam every page runs checks through"
```

---

### Task 5: Rendering a CheckResult

**Files:**
- Create: `apps/web/lib/format.ts`, `apps/web/components/verdict-badge.tsx`, `apps/web/components/check-panel.tsx`
- Test: `apps/web/test/format.test.ts`, `apps/web/test/check-panel.test.tsx`

**Interfaces:**
- Consumes: `CheckResult`, `Verdict`, `VerdictLevel` from `@pgops/checks`.
- Produces:
  - `function formatDuration(secs: number | null): string` — `null` renders as `—`.
  - `function formatCount(n: number): string`
  - `<VerdictBadge verdict={Verdict} />`
  - `<CheckPanel title={string} result={CheckResult<T>}>{(data: T, verdict: Verdict) => ReactNode}</CheckPanel>`

- [ ] **Step 1: Write the failing tests**

`apps/web/test/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatDuration } from '../lib/format.js';

describe('formatDuration', () => {
  it('renders null as an em dash rather than "0s" or "null"', () => {
    expect(formatDuration(null)).toBe('—');
  });
  it('renders sub-minute durations in seconds', () => {
    expect(formatDuration(45)).toBe('45s');
  });
  it('renders minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2m 5s');
  });
  it('renders hours and minutes, dropping seconds', () => {
    expect(formatDuration(100_366)).toBe('27h 52m');
  });
  /** A negative age means clock skew between client and server, not a bug worth crashing on. */
  it('clamps a negative duration to 0s', () => {
    expect(formatDuration(-5)).toBe('0s');
  });
});
```

`apps/web/test/check-panel.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { CheckPanel } from '../components/check-panel.js';

describe('CheckPanel', () => {
  it('renders the children with the data when the check succeeded', async () => {
    const r = await render(
      <CheckPanel
        title="Connections"
        result={{ ok: true, data: { used: 5 }, verdict: { level: 'ok' }, measuredAt: 0 }}
      >
        {(d) => <span>{d.used} used</span>}
      </CheckPanel>,
    );
    expect(r.text()).toContain('5 used');
  });

  /**
   * The !ok path is the one that matters. runCheck never rejects, so a denied
   * or broken check arrives here as data — and if this component rendered
   * nothing for it, the page would show a silently missing panel, which reads
   * as "everything is fine" during an incident. It must say what went wrong.
   */
  it('renders the failure reason and message when the check failed', async () => {
    const r = await render(
      <CheckPanel
        title="Query statistics"
        result={{ ok: false, reason: 'missing-extension', message: 'pg_stat_statements is not installed' }}
      >
        {() => <span>never rendered</span>}
      </CheckPanel>,
    );
    expect(r.text()).toContain('pg_stat_statements is not installed');
    expect(r.text()).not.toContain('never rendered');
  });

  it('renders the remedy when the failure carries one', async () => {
    const r = await render(
      <CheckPanel
        title="Query statistics"
        result={{ ok: false, reason: 'missing-extension', message: 'not installed', remedy: 'CREATE EXTENSION pg_stat_statements' }}
      >
        {() => null}
      </CheckPanel>,
    );
    expect(r.text()).toContain('CREATE EXTENSION pg_stat_statements');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project web apps/web/test/format.test.ts apps/web/test/check-panel.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write format.ts**

```ts
/**
 * Ported in spirit from the TUI's formatDuration. Hours drop seconds because a
 * 27-hour transaction's second count is noise, and the column it sits in is
 * narrow on every surface that renders it.
 */
export function formatDuration(secs: number | null): string {
  if (secs === null) return '—';
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}
```

- [ ] **Step 4: Write verdict-badge.tsx**

```tsx
import type { Verdict } from '@pgops/checks';
import { Badge } from '@/components/ui/badge';

const LABEL = { ok: 'OK', warn: 'WARN', critical: 'CRITICAL' } as const;

/**
 * Colour is never the only signal: the level is spelled out in text too. An
 * operator on a projector, colour-blind, or reading a screenshot in grayscale
 * still gets the verdict.
 */
export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const variant = verdict.level === 'critical' ? 'destructive'
    : verdict.level === 'warn' ? 'secondary'
    : 'outline';
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant={variant}>{LABEL[verdict.level]}</Badge>
      {verdict.note ? <span className="text-sm text-muted-foreground">{verdict.note}</span> : null}
    </span>
  );
}
```

- [ ] **Step 5: Write check-panel.tsx**

```tsx
import type { ReactNode } from 'react';
import type { CheckResult, Verdict } from '@pgops/checks';
import { VerdictBadge } from './verdict-badge.js';

/**
 * Every check on every page renders through here, so the failed case is
 * handled exactly once and cannot be forgotten on a page written later.
 *
 * `runCheck` never rejects: a denied, unsupported, or broken check arrives as
 * `{ok: false}` data. A panel that rendered nothing for that case would leave
 * a hole on the page that reads as "nothing to report" — the most dangerous
 * possible misreading during an incident. So the failure is rendered as
 * prominently as the success.
 */
export function CheckPanel<T>({
  title,
  result,
  children,
}: {
  title: string;
  result: CheckResult<T>;
  children: (data: T, verdict: Verdict) => ReactNode;
}) {
  return (
    <section className="rounded-lg border p-4">
      <header className="mb-3 flex items-center justify-between gap-4">
        <h2 className="font-semibold">{title}</h2>
        {result.ok ? <VerdictBadge verdict={result.verdict} /> : null}
      </header>
      {result.ok ? (
        children(result.data, result.verdict)
      ) : (
        <div className="text-sm">
          <p className="font-medium">Unavailable — {result.reason}</p>
          <p className="text-muted-foreground">{result.message}</p>
          {result.remedy ? <pre className="mt-2 overflow-x-auto rounded bg-muted p-2">{result.remedy}</pre> : null}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project web apps/web/test/format.test.ts apps/web/test/check-panel.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 7: Prove the failure path assertion is not vacuous**

Change `CheckPanel` to render `null` in the `!ok` branch, re-run, and confirm both failure tests fail. Restore.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/format.ts apps/web/components apps/web/test
git commit -m "feat(web): render any CheckResult uniformly, failures included"
```

---

### Task 6: The refresh ticker

**Files:**
- Create: `apps/web/components/refresh.tsx`
- Test: `apps/web/test/refresh.test.ts`

**Interfaces:**
- Produces:
  - `function nextTick(state: TickState, now: number): TickDecision` — the pure decision function.
  - `interface TickState { inFlight: boolean; requested: boolean; startedAt: number | null }`
  - `type TickDecision = { act: 'skip' } | { act: 'refresh' }`
  - `<Refresh intervalMs={number} />` — the client component.

**Why a pure function beside the component.** The three properties below are the whole value of this component, and they are properties of a *decision*, not of React. Testing them through a rendered component would mean fake timers, act() wrappers, and a mocked router — a test that mostly exercises the test harness. The decision function is testable in nine lines, and the component becomes a thin shell over it. This is `ui/usePoll.ts`'s logic, carried forward.

- [ ] **Step 1: Write the failing test**

`apps/web/test/refresh.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextTick } from '../components/refresh.js';

describe('nextTick', () => {
  /**
   * Property 1: a tick landing while one is in flight is SKIPPED, not queued.
   * A queue would let a slow database accumulate refreshes and then receive a
   * burst of them — the tool adding load to the database it is diagnosing, at
   * the moment that database is least able to take it.
   */
  it('skips a tick that lands while one is already in flight', () => {
    expect(nextTick({ inFlight: true, requested: false, startedAt: 1000 }, 2000)).toEqual({ act: 'skip' });
  });

  it('refreshes when nothing is in flight', () => {
    expect(nextTick({ inFlight: false, requested: false, startedAt: null }, 2000)).toEqual({ act: 'refresh' });
  });

  /**
   * Property 3: an operator-requested refresh is re-armed into a single slot,
   * so it cannot be swallowed by an in-flight refresh that started BEFORE the
   * operator acted. Without this, a refresh fired right after an action shows
   * pre-action data and looks like the action did nothing.
   */
  it('refreshes once the in-flight one lands when a refresh was requested during it', () => {
    expect(nextTick({ inFlight: false, requested: true, startedAt: null }, 2000)).toEqual({ act: 'refresh' });
  });

  it('collapses several requests during one in-flight refresh into a single re-arm', () => {
    let s = { inFlight: true, requested: false, startedAt: 1000 };
    s = { ...s, requested: true };
    s = { ...s, requested: true };
    expect(s.requested).toBe(true);
    expect(nextTick(s, 1500)).toEqual({ act: 'skip' });
    expect(nextTick({ ...s, inFlight: false }, 1600)).toEqual({ act: 'refresh' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project web apps/web/test/refresh.test.ts`
Expected: FAIL — `nextTick` is not exported.

- [ ] **Step 3: Write the component**

`apps/web/components/refresh.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export interface TickState {
  inFlight: boolean;
  /** An operator asked for a refresh while one was already running. */
  requested: boolean;
  /** When the in-flight refresh STARTED. Freshness is stamped here, not on arrival. */
  startedAt: number | null;
}

export type TickDecision = { act: 'skip' } | { act: 'refresh' };

/**
 * The three properties this carries forward from the TUI's usePoll.ts:
 *
 *  1. A tick that lands while one is in flight is SKIPPED, not queued — so the
 *     tool cannot add load to the database it is diagnosing.
 *  2. Freshness is stamped at request START, not at response. A 5s fetch reads
 *     "updated 5s ago" the moment it lands, which is true. Stamping on arrival
 *     would claim "0s ago" for data that is already five seconds stale.
 *  3. An operator-requested refresh is re-armed into a single slot, so the
 *     refresh fired after an action cannot be swallowed by one that started
 *     before it.
 *
 * Pure, so all three are testable without fake timers or a mocked router.
 */
export function nextTick(state: TickState, _now: number): TickDecision {
  if (state.inFlight) return { act: 'skip' };
  return { act: 'refresh' };
}

export function Refresh({ intervalMs = 5_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const state = useRef<TickState>({ inFlight: false, requested: false, startedAt: null });
  const [startedAt, setStartedAt] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const decision = nextTick(state.current, Date.now());
      if (decision.act === 'skip') {
        // Property 3: remember that a tick was due, so it fires once the
        // in-flight refresh lands rather than being lost.
        state.current.requested = true;
        return;
      }
      // Property 2: stamp BEFORE the work, not after.
      const now = Date.now();
      state.current = { inFlight: true, requested: false, startedAt: now };
      setStartedAt(now);
      router.refresh();
      // router.refresh() resolves when the server render lands. Next does not
      // expose a completion promise, so the flag is released on the next
      // macrotask — which is enough to prevent the burst that property 1 is
      // about, without pretending to know when React finished committing.
      setTimeout(() => {
        const wasRequested = state.current.requested;
        state.current = { inFlight: false, requested: false, startedAt: state.current.startedAt };
        if (wasRequested) router.refresh();
      }, 0);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, router]);

  return (
    <span className="text-sm text-muted-foreground" suppressHydrationWarning>
      {startedAt === null ? 'live' : `updated ${Math.round((Date.now() - startedAt) / 1000)}s ago`}
    </span>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web apps/web/test/refresh.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove property 1's test is not vacuous**

Change `nextTick` to always return `{ act: 'refresh' }`, re-run, confirm the skip test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/refresh.tsx apps/web/test/refresh.test.ts
git commit -m "feat(web): the refresh ticker, skipping rather than queueing"
```

---

### Task 7: The overview route and the HTTP test harness

**Files:**
- Create: `apps/web/test/harness.ts`, `apps/web/test/routes.int.test.ts`
- Modify: `apps/web/app/page.tsx`
- Test: `apps/web/test/routes.int.test.ts`

**Interfaces:**
- Consumes: `runCheckFor`, `databaseNames` (Task 4), `CheckPanel`, `VerdictBadge` (Task 5).
- Produces: `withConsole(fn)` test harness — starts one Postgres container and one built Next server, passes `{ baseUrl, sql }` to `fn`.

**Why an HTTP integration test rather than component tests for pages.** These are async Server Components. Rendering one in isolation means stubbing Next's request context, at which point the test proves nothing about whether the page works. Fetching real HTML from a real server pointed at a real Postgres is both simpler and stronger, and matches how `packages/checks` was tested.

- [ ] **Step 1: Write the harness**

`apps/web/test/harness.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

export interface Console {
  baseUrl: string;
  sql: (text: string) => Promise<void>;
}

async function waitForPort(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`console did not start within ${timeoutMs}ms: ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * One container and one server per calling test file. Starting the server is
 * the expensive part (a Next production start), so tests share it and each
 * asserts against its own seeded state rather than restarting.
 *
 * The server is started with `next start` against a build made in the same
 * call, because the whole point of the dynamic-rendering constraint is that
 * the built artifact must read DATABASE_URL at RUN time — a dev server would
 * not prove that.
 */
export async function withConsole(fn: (c: Console) => Promise<void>): Promise<void> {
  let pg: StartedPostgreSqlContainer | undefined;
  let server: ChildProcess | undefined;
  try {
    pg = await new PostgreSqlContainer('postgres:17-alpine').start();
    const url = pg.getConnectionUri();
    const port = 3100 + Math.floor(Number(process.env.VITEST_WORKER_ID ?? 1));

    server = spawn('npm', ['run', '--workspace', '@pgops/web', 'start', '--', '--port', String(port)], {
      env: { ...process.env, PGOPS_DATABASES: JSON.stringify([{ name: 'primary', url }]), NODE_ENV: 'production' },
      stdio: 'inherit',
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForPort(baseUrl);

    await fn({
      baseUrl,
      sql: async (text: string) => {
        const c = new Client({ connectionString: url });
        await c.connect();
        try { await c.query(text); } finally { await c.end().catch(() => {}); }
      },
    });
  } finally {
    server?.kill('SIGTERM');
    await pg?.stop().catch(() => {});
  }
}
```

- [ ] **Step 2: Write the failing test**

`apps/web/test/routes.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withConsole } from './harness.js';

describe('/ overview', () => {
  it('lists every configured database with a verdict', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(baseUrl)).text();
      expect(html).toContain('primary');
      expect(html).toMatch(/OK|WARN|CRITICAL/);
    });
  }, 180_000);

  /**
   * The build baked in NOTHING about which database to talk to: the harness
   * builds the app, then starts it with PGOPS_DATABASES pointing at a
   * container that did not exist at build time. If the page rendered without
   * `connection()`, `process.env` would have been inlined during the build and
   * this test would show an empty or wrong database list.
   */
  it('reads its database configuration at run time, not build time', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(baseUrl)).text();
      expect(html).toContain('primary');
      expect(html).not.toContain('default');
    });
  }, 180_000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run --workspace @pgops/checks build && npm run --workspace @pgops/web build && npx vitest run --project integration apps/web/test/routes.int.test.ts`
Expected: FAIL — the placeholder page renders `pgops`, not `primary`.

- [ ] **Step 4: Write the overview page**

`apps/web/app/page.tsx`:

```tsx
import Link from 'next/link';
import { CHECKS, type Verdict, type VerdictLevel } from '@pgops/checks';
import { databaseNames } from '@/lib/pools';
import { runCheckFor } from '@/lib/check';
import { VerdictBadge } from '@/components/verdict-badge';

const RANK: Record<VerdictLevel, number> = { ok: 0, warn: 1, critical: 2 };

/**
 * The overview answers one question — "is anything wrong anywhere?" — so it
 * shows the WORST verdict per database rather than a list of every check. A
 * check that could not run is not a verdict and does not count toward the
 * worst: it is reported separately, because "we could not look" and "we looked
 * and it is fine" must never render the same.
 */
async function worstVerdict(name: string): Promise<{ verdict: Verdict; unavailable: number }> {
  const results = await Promise.all(
    Object.values(CHECKS)
      .filter((c) => c.class === 'incident')
      .map((c) => runCheckFor(name, c as Parameters<typeof runCheckFor>[1])),
  );
  let worst: Verdict = { level: 'ok' };
  let unavailable = 0;
  for (const r of results) {
    if (!r.ok) { unavailable++; continue; }
    if (RANK[r.verdict.level] > RANK[worst.level]) worst = r.verdict;
  }
  return { verdict: worst, unavailable };
}

export default async function Overview() {
  const names = databaseNames();
  const rows = await Promise.all(names.map(async (name) => ({ name, ...(await worstVerdict(name)) })));

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-xl font-semibold">pgops</h1>
      <ul className="divide-y rounded-lg border">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center justify-between gap-4 p-4">
            <Link href={`/db/${r.name}`} className="font-medium underline-offset-4 hover:underline">
              {r.name}
            </Link>
            <span className="flex items-center gap-3">
              {r.unavailable > 0 ? (
                <span className="text-sm text-muted-foreground">{r.unavailable} unavailable</span>
              ) : null}
              <VerdictBadge verdict={r.verdict} />
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

Note: `databaseNames()` reads `process.env`, so this page must be dynamic. It is — every `runCheckFor` call awaits `connection()`. Task 12 adds the guard that keeps it that way.

- [ ] **Step 5: Run tests to verify they pass**

Run the command from Step 3 again.
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/page.tsx apps/web/test/harness.ts apps/web/test/routes.int.test.ts
git commit -m "feat(web): the overview route, and a real-HTTP test harness behind it"
```

---

### Task 8: The database shell and the triage page

**Files:**
- Create: `apps/web/app/db/[name]/layout.tsx`, `apps/web/app/db/[name]/page.tsx`, `apps/web/components/nav.tsx`
- Modify: `apps/web/test/routes.int.test.ts`

**Interfaces:**
- Consumes: `runCheckFor`, `databaseNames`, `UnknownDatabaseError` (Task 4); `CheckPanel`, `VerdictBadge`, `formatDuration`, `formatCount` (Task 5); `Refresh` (Task 6).
- Produces: the `/db/[name]` shell every later route nests inside.

**Note on params.** In Next 16 App Router, `params` is a Promise and must be awaited: `const { name } = await params`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/routes.int.test.ts`:

```ts
describe('/db/[name] triage', () => {
  it('renders every incident check on one screen', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(`${baseUrl}/db/primary`)).text();
      for (const title of ['Connections', 'Sessions', 'Blocked', 'Long-running', 'Lock wait graph']) {
        expect(html).toContain(title);
      }
    });
  }, 180_000);

  /**
   * An unknown database must be a 404, not a 500 and not an empty page. A 500
   * reads as "pgops is broken"; a 404 reads as "you typed the wrong name",
   * which is what actually happened.
   */
  it('404s for a database that is not configured', async () => {
    await withConsole(async ({ baseUrl }) => {
      const r = await fetch(`${baseUrl}/db/nope`);
      expect(r.status).toBe(404);
    });
  }, 180_000);

  /**
   * A check that cannot run must render as unavailable, NOT be omitted. An
   * omitted panel reads as "nothing to report" during an incident. Proven by
   * revoking the privilege pg_stat_statements needs rather than by mocking.
   */
  it('renders an unavailable check rather than omitting it', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(`${baseUrl}/db/primary`)).text();
      // pg_stat_statements is not installed in the plain postgres image, so
      // queryStats necessarily fails here.
      expect(html).toContain('Query statistics');
      expect(html).toMatch(/Unavailable/);
    });
  }, 180_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace @pgops/web build && npx vitest run --project integration apps/web/test/routes.int.test.ts`
Expected: FAIL — `/db/primary` 404s; the route does not exist.

- [ ] **Step 3: Write the nav**

`apps/web/components/nav.tsx`:

```tsx
import Link from 'next/link';

const TABS = [
  { href: '', label: 'Triage' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/locks', label: 'Locks' },
  { href: '/queries', label: 'Queries' },
] as const;

export function Nav({ name }: { name: string }) {
  return (
    <nav className="mb-4 flex gap-4 border-b pb-2 text-sm">
      {TABS.map((t) => (
        <Link key={t.label} href={`/db/${name}${t.href}`} className="underline-offset-4 hover:underline">
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Write the layout**

`apps/web/app/db/[name]/layout.tsx`:

```tsx
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { databaseNames } from '@/lib/pools';
import { Nav } from '@/components/nav';
import { Refresh } from '@/components/refresh';

export default async function DbLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ name: string }>;
}) {
  // Reads process.env via databaseNames() — see the plan's Global Constraints.
  await connection();
  const { name } = await params;
  // An unconfigured name is a 404, not a 500: the operator mistyped, pgops is
  // not broken, and the distinction is the whole difference between "check the
  // URL" and "page the on-call for the tool itself".
  if (!databaseNames().includes(name)) notFound();

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-2 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">{name}</h1>
        <Refresh intervalMs={5_000} />
      </header>
      <Nav name={name} />
      {children}
    </main>
  );
}
```

- [ ] **Step 5: Write the triage page**

`apps/web/app/db/[name]/page.tsx`:

```tsx
import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { formatCount, formatDuration } from '@/lib/format';

export default async function Triage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  const [connections, sessionStates, blocked, longRunning, locks, wraparound, slots, queryStats] =
    await Promise.all([
      runCheckFor(name, CHECKS.connections),
      runCheckFor(name, CHECKS.sessionStates),
      runCheckFor(name, CHECKS.blocked),
      runCheckFor(name, CHECKS.longRunning, {}),
      runCheckFor(name, CHECKS.locks),
      runCheckFor(name, CHECKS.wraparound),
      runCheckFor(name, CHECKS.slots),
      runCheckFor(name, CHECKS.queryStats, { sort: 'total' }),
    ]);

  return (
    <div className="grid gap-4">
      <CheckPanel title="Connections" result={connections}>
        {(d) => <p>{formatCount(d.used)} / {formatCount(d.max)} used · {formatCount(d.headroom)} free</p>}
      </CheckPanel>

      <CheckPanel title="Sessions" result={sessionStates}>
        {(d) => (
          <ul className="text-sm">
            {d.states.map((s) => (
              <li key={s.state ?? 'unknown'} className="flex justify-between">
                <span>{s.state ?? 'unknown'}</span>
                <span>{formatCount(s.count)} · {formatDuration(s.longestSecs)}</span>
              </li>
            ))}
          </ul>
        )}
      </CheckPanel>

      <CheckPanel title="Blocked" result={blocked}>
        {(d) =>
          d.count === 0
            ? <p className="text-sm text-muted-foreground">Nothing waiting on a lock.</p>
            : <p>{formatCount(d.count)} waiting · longest {formatDuration(d.longestQueryAgeSecs)} · suspect pid {d.suspectPid}</p>
        }
      </CheckPanel>

      <CheckPanel title="Long-running" result={longRunning}>
        {(d) =>
          d.queries.length === 0
            ? <p className="text-sm text-muted-foreground">No long-running queries.</p>
            : <ul className="text-sm">{d.queries.map((q) => (
                <li key={q.pid}>{q.pid} · {formatDuration(q.runningSecs)}</li>
              ))}</ul>
        }
      </CheckPanel>

      <CheckPanel title="Lock wait graph" result={locks}>
        {(d) =>
          d.roots.length === 0
            ? <p className="text-sm text-muted-foreground">No blocking.</p>
            : <p>{formatCount(d.roots.length)} root blocker(s)</p>
        }
      </CheckPanel>

      <CheckPanel title="Wraparound" result={wraparound}>
        {(d) => <p>{d.pctToForcedVacuum}% of horizon</p>}
      </CheckPanel>

      <CheckPanel title="Replication slots" result={slots}>
        {(d) => <p>{formatCount(d.slots.length)} slot(s)</p>}
      </CheckPanel>

      <CheckPanel title="Query statistics" result={queryStats}>
        {(d) => <p>{formatCount(d.totalShapes)} statement shape(s)</p>}
      </CheckPanel>
    </div>
  );
}
```

**Before writing this, read the actual `Data` types** in `packages/checks/src/checks/*.ts` and correct any field name that differs. The types above are written from the exported interfaces, but the compiler is the authority — `npm run --workspace @pgops/web typecheck` must pass, and a field that does not exist is a plan defect to report, not to work around with `any`.

- [ ] **Step 6: Run tests to verify they pass**

Run the command from Step 2.
Expected: PASS. Then `npm run --workspace @pgops/web typecheck` — expected clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/db apps/web/components/nav.tsx apps/web/test/routes.int.test.ts
git commit -m "feat(web): the database shell and the triage page"
```

---

### Task 9: Sessions and locks routes

**Files:**
- Create: `apps/web/app/db/[name]/sessions/page.tsx`, `apps/web/app/db/[name]/locks/page.tsx`
- Modify: `apps/web/test/routes.int.test.ts`

**Interfaces:**
- Consumes: `runCheckFor`, `CheckPanel`, `formatDuration`, shadcn `Table` components.

**Batched deliberately.** These two are the same shape of work — one check, one table, one truncation notice — and a reviewer who accepted one would accept the other. The wait graph's tree rendering is the only judgment call, and it is small.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/routes.int.test.ts`:

```ts
describe('/db/[name]/sessions and /locks', () => {
  it('lists live sessions with pid, state and age', async () => {
    await withConsole(async ({ baseUrl, sql }) => {
      await sql("SELECT pg_sleep(0)");
      const html = await (await fetch(`${baseUrl}/db/primary/sessions`)).text();
      expect(html).toContain('pid');
      expect(html).toMatch(/active|idle/);
    });
  }, 180_000);

  /**
   * Truncation must be VISIBLE. A partial list an operator knows is partial is
   * useful; one they believe is complete is worse than nothing — they will
   * conclude the session they are hunting does not exist.
   */
  it('says so when the session list was truncated', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(`${baseUrl}/db/primary/sessions?limit=1`)).text();
      expect(html).toMatch(/showing|truncated|more/i);
    });
  }, 180_000);

  it('renders the wait graph, and says so when nothing is blocking', async () => {
    await withConsole(async ({ baseUrl }) => {
      const html = await (await fetch(`${baseUrl}/db/primary/locks`)).text();
      expect(html).toContain('Lock wait graph');
      expect(html).toMatch(/No blocking/i);
    });
  }, 180_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace @pgops/web build && npx vitest run --project integration apps/web/test/routes.int.test.ts`
Expected: FAIL — both routes 404.

- [ ] **Step 3: Write the sessions page**

`apps/web/app/db/[name]/sessions/page.tsx`:

```tsx
import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { formatDuration } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default async function Sessions({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ limit?: string }>;
}) {
  const { name } = await params;
  const { limit } = await searchParams;
  const parsed = Number(limit);
  const result = await runCheckFor(name, CHECKS.sessions, {
    limit: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
  });

  return (
    <CheckPanel title="Sessions" result={result}>
      {(d) => (
        <>
          {d.truncated ? (
            <p className="mb-2 text-sm text-muted-foreground">
              Showing the first {d.sessions.length} — more sessions matched than are displayed.
            </p>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>pid</TableHead><TableHead>state</TableHead><TableHead>age</TableHead>
                <TableHead>user@app</TableHead><TableHead>query</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.sessions.map((s) => (
                <TableRow key={s.pid}>
                  <TableCell>{s.pid}</TableCell>
                  <TableCell>{s.state ?? '—'}</TableCell>
                  <TableCell>{formatDuration(s.queryAgeSecs)}</TableCell>
                  <TableCell>{s.user ?? '—'}@{s.app ?? '—'}</TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs">{s.query ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </CheckPanel>
  );
}
```

- [ ] **Step 4: Write the locks page**

`apps/web/app/db/[name]/locks/page.tsx`:

```tsx
import { CHECKS, type Waiter } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { formatDuration } from '@/lib/format';

/**
 * The graph is a tree, so it renders as nested lists rather than a flat table.
 * The flat table is what the old TUI's blocked panel showed, and it is exactly
 * what hid the amplifier in a migration pile-up: long read <- ACCESS EXCLUSIVE
 * <- readers renders as three unrelated rows unless the nesting is visible.
 *
 * `cycle` marks a back-edge to an ancestor — a deadlock in flight. It is
 * labelled rather than recursed into, or this function would not terminate.
 */
function WaiterTree({ waiters }: { waiters: Waiter[] }) {
  if (waiters.length === 0) return null;
  return (
    <ul className="ml-4 border-l pl-4 text-sm">
      {waiters.map((w) => (
        <li key={`${w.pid}-${w.cycle}`} className="py-1">
          <span className="font-mono">{w.pid}</span>{' '}
          <span className="text-muted-foreground">
            {w.user ?? '—'}@{w.app ?? '—'} · waiting {formatDuration(w.waitSecs)}
            {w.cycle ? ' · DEADLOCK (cycle back to an ancestor)' : ''}
          </span>
          {w.cycle ? null : <WaiterTree waiters={w.waiters} />}
        </li>
      ))}
    </ul>
  );
}

export default async function Locks({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const result = await runCheckFor(name, CHECKS.locks);

  return (
    <CheckPanel title="Lock wait graph" result={result}>
      {(d) => (
        <>
          {d.truncated ? (
            <p className="mb-2 text-sm text-muted-foreground">
              Partial graph — more lock rows matched than were fetched.
            </p>
          ) : null}
          {d.roots.length === 0 ? (
            <p className="text-sm text-muted-foreground">No blocking.</p>
          ) : (
            <ul className="space-y-3">
              {d.roots.map((r) => (
                <li key={r.pid}>
                  <p>
                    <span className="font-mono font-medium">{r.pid}</span>{' '}
                    <span className="text-muted-foreground">
                      {r.user ?? '—'}@{r.app ?? '—'} · {r.state ?? '—'} · open {formatDuration(r.xactAgeSecs)} ·
                      blocking {r.totalWaiters}
                    </span>
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">{r.query ?? '—'}</p>
                  <WaiterTree waiters={r.waiters} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </CheckPanel>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run the command from Step 2, then `npm run --workspace @pgops/web typecheck`.
Expected: PASS and clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/db apps/web/test/routes.int.test.ts
git commit -m "feat(web): the sessions table and the lock wait graph"
```

---

### Task 10: The queries route, and redaction everywhere

**Files:**
- Create: `apps/web/app/db/[name]/queries/page.tsx`, `apps/web/components/sql.tsx`
- Modify: `apps/web/app/db/[name]/sessions/page.tsx`, `apps/web/app/db/[name]/locks/page.tsx`, `apps/web/app/db/[name]/page.tsx`
- Test: `apps/web/test/redaction.test.tsx`, `apps/web/test/routes.int.test.ts`

**Interfaces:**
- Consumes: `redactSecrets` from `@pgops/checks`; `runCheckFor`; shadcn `Table`.
- Produces: `<Sql>{string | null}</Sql>` — **the only component in this app permitted to render a query string.**

**Why a component rather than calling `redactSecrets` at each site.** Spec §7.3 requires redaction on every rendered query, and "remember to call it" is not a mechanism. One component that redacts internally makes the rule enforceable by a test that greps for query fields rendered outside it, which Task 12 adds. This is the same argument `CheckPanel` makes for the failure path.

- [ ] **Step 1: Write the failing test**

`apps/web/test/redaction.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { Sql } from '../components/sql.js';

describe('Sql', () => {
  /**
   * §7.3: redaction matters MORE on the web than in the terminal. A screenshot
   * needs a human to take it; a URL forwards itself. A connection string in a
   * rendered query reaches everyone the link reaches.
   */
  it('redacts a password in a rendered query', async () => {
    const r = await render(<Sql>{"SELECT dblink_connect('postgres://u:hunter2@h/db')"}</Sql>);
    expect(r.text()).not.toContain('hunter2');
  });

  it('renders an em dash for a null query rather than the word null', async () => {
    const r = await render(<Sql>{null}</Sql>);
    expect(r.text()).toBe('—');
  });

  it('leaves an ordinary query intact', async () => {
    const r = await render(<Sql>{'SELECT 1'}</Sql>);
    expect(r.text()).toBe('SELECT 1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project web apps/web/test/redaction.test.tsx`
Expected: FAIL — `../components/sql.js` not found.

- [ ] **Step 3: Write the Sql component**

`apps/web/components/sql.tsx`:

```tsx
import { redactSecrets } from '@pgops/checks';

/**
 * THE ONLY component permitted to render a query string.
 *
 * Spec §7.3 requires `redactSecrets` on every rendered query, not just on
 * export — and "remember to call it" is not a mechanism. Routing every query
 * through one component makes the rule mechanically checkable: Task 12's guard
 * asserts that no page renders a `query` field outside this component.
 */
export function Sql({ children }: { children: string | null | undefined }) {
  if (children == null || children === '') return <span>—</span>;
  return <code className="block max-w-full overflow-x-auto font-mono text-xs">{redactSecrets(children)}</code>;
}
```

- [ ] **Step 4: Route the existing pages through it**

In `sessions/page.tsx`, replace the query cell body with `<Sql>{s.query}</Sql>`.
In `locks/page.tsx`, replace both `{r.query ?? '—'}` and any waiter query with `<Sql>{r.query}</Sql>`.
In `db/[name]/page.tsx`, the triage page renders no query text today — if you added any, route it through `Sql` too.

- [ ] **Step 5: Write the queries page**

`apps/web/app/db/[name]/queries/page.tsx`:

```tsx
import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { Sql } from '@/components/sql';
import { formatCount, formatDuration } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const SORTS = ['total', 'mean', 'calls'] as const;
type Sort = (typeof SORTS)[number];

/**
 * Ruling 55: `queryStats` is scoped to the CURRENT database by dbid, which is
 * what makes this route coherent — pg_stat_statements is cluster-wide, and an
 * unlabelled cross-database ranking on a per-database page would attribute one
 * database's load to another.
 */
export default async function Queries({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const { name } = await params;
  const { sort } = await searchParams;
  const chosen: Sort = SORTS.includes(sort as Sort) ? (sort as Sort) : 'total';
  const result = await runCheckFor(name, CHECKS.queryStats, { sort: chosen });

  return (
    <CheckPanel title="Query statistics" result={result}>
      {(d) => (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            {formatCount(d.totalShapes)} statement shape(s)
            {d.statsResetAt ? ` · stats reset ${d.statsResetAt}` : ''}
            {/* There is no `truncated` flag on QueryStatsData: totalShapes is
                every shape visible to this role BEFORE the LIMIT, so a short
                rows array against a larger totalShapes IS the truncation. */}
            {d.rows.length < d.totalShapes ? ` · showing ${d.rows.length}` : ''}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>calls</TableHead><TableHead>total</TableHead>
                <TableHead>mean</TableHead><TableHead>query</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.rows.map((q, i) => (
                <TableRow key={q.queryid ?? `row-${i}`}>
                  <TableCell>{formatCount(q.calls)}</TableCell>
                  {/* totalMs/meanMs are MILLISECONDS, not seconds. */}
                  <TableCell>{formatDuration(q.totalMs / 1000)}</TableCell>
                  <TableCell>{formatDuration(q.meanMs / 1000)}</TableCell>
                  <TableCell className="max-w-xl">
                    {/* `redacted` means Postgres withheld the text from this
                        role — the ROW still counts, so say so rather than
                        rendering an empty cell that reads as "no query". */}
                    {q.redacted ? <span className="text-xs italic">insufficient privilege</span> : <Sql>{q.query}</Sql>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </CheckPanel>
  );
}
```

**Read the real `QueryStatsData` and `QueryStat` types** before writing this and correct any field name that differs. `queryid` may be null (pg_stat_statements redacts it for statements the role cannot see), which is why the key falls back to the index. The compiler is the authority.

- [ ] **Step 6: Add the integration assertion**

Append to `apps/web/test/routes.int.test.ts`:

```ts
describe('/db/[name]/queries', () => {
  /**
   * pg_stat_statements is not installed in the plain postgres image, so this
   * check necessarily fails — and that is the assertion worth making: the page
   * must say the extension is missing, not render an empty table that reads as
   * "this database runs no queries".
   */
  it('says the extension is missing rather than showing an empty table', async () => {
    await withConsole(async ({ baseUrl }) => {
      const r = await fetch(`${baseUrl}/db/primary/queries`);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toMatch(/Unavailable/);
      // Observed for real in Task 8, not invented: reason `missing-extension`,
      // message `relation "pg_stat_statements" does not exist`, remedy
      // `CREATE EXTENSION pg_stat_statements;`.
      expect(html).toMatch(/pg_stat_statements/);
    });
  }, 180_000);
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run --project web apps/web/test/redaction.test.tsx` — expected PASS, 3 tests.
Run: `npm run --workspace @pgops/web build && npx vitest run --project integration apps/web/test/routes.int.test.ts` — expected PASS.
Run: `npm run --workspace @pgops/web typecheck` — expected clean.

- [ ] **Step 8: Prove the redaction test is not vacuous**

Change `Sql` to render `children` without calling `redactSecrets`, re-run, and confirm the password test fails. Restore it.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): the queries route, and one chokepoint for every rendered query"
```

---

### Task 11: The dynamic-rendering and redaction guards

**Files:**
- Create: `apps/web/test/guards.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing at runtime. These are source-scanning tests, in the same idiom as `packages/checks/test/boundaries.test.ts`.

**Why source scanning rather than ESLint.** The spec says "enforced by lint rule". This repo has no ESLint configuration at all — the P0 final review confirmed it — so a lint rule means adopting and configuring a whole toolchain to express two assertions. `boundaries.test.ts` already established the cheaper idiom in this repo: a test that reads source and asserts a property. Same enforcement, same CI gate, no new toolchain. **This is a deliberate deviation from the spec's stated mechanism, not from its requirement.** Record it as such.

- [ ] **Step 1: Write the failing test**

`apps/web/test/guards.test.ts`:

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('../app', import.meta.url));
const COMPONENTS = fileURLToPath(new URL('../components', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const strip = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('dynamic rendering', () => {
  /**
   * In a Server Component `process.env` is inlined AT BUILD TIME unless the
   * component opts into dynamic rendering. The entire configuration model is
   * `docker run -e DATABASE_URL=…` against an image built months earlier. Get
   * this wrong and the container talks to whatever database was set when the
   * image was built — silently, forever, with no error anywhere.
   *
   * Every page or layout that reads configuration must therefore either call
   * `connection()` itself or reach configuration only through `runCheckFor`,
   * which awaits it centrally.
   */
  it('every page or layout touching configuration is explicitly dynamic', () => {
    const offenders: string[] = [];
    for (const file of walk(APP)) {
      if (!/\/(page|layout)\.tsx$/.test(file)) continue;
      const code = strip(readFileSync(file, 'utf8'));
      const readsConfig = /databaseNames\s*\(|process\.env/.test(code);
      if (!readsConfig) continue;
      const isDynamic = /await\s+connection\s*\(\s*\)/.test(code) || /runCheckFor\s*\(/.test(code);
      if (!isDynamic) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * A page must never build its own Pool: pools live in lib/pools.ts so the
   * process holds exactly one per database. A page-level `new Pool` would open
   * a connection per render against the database this tool exists to diagnose.
   */
  it('no page or component constructs its own Pool', () => {
    const offenders = [...walk(APP), ...walk(COMPONENTS)]
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /new\s+Pool\s*\(/.test(strip(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

describe('redaction', () => {
  /**
   * §7.3: every rendered query goes through `redactSecrets`. `Sql` is the one
   * component that calls it, so the enforceable form of the rule is that no
   * page renders a query-shaped field except through `Sql`.
   */
  it('no page renders a query field outside the Sql component', () => {
    const offenders: string[] = [];
    for (const file of walk(APP)) {
      if (!file.endsWith('.tsx')) continue;
      const code = strip(readFileSync(file, 'utf8'));
      // `{x.query}` or `{x.query ?? '—'}` rendered directly in JSX.
      const direct = code.match(/\{\s*\w+\.query\s*(\?\?[^}]*)?\}/g) ?? [];
      if (direct.length > 0) offenders.push(`${file}: ${direct.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the Sql component actually calls redactSecrets', () => {
    const code = readFileSync(join(COMPONENTS, 'sql.tsx'), 'utf8');
    expect(code).toMatch(/redactSecrets\s*\(/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails, for the right reason**

Run: `npx vitest run --project web apps/web/test/guards.test.ts`

If it passes immediately, the guards are not yet proven. **Prove each one by introducing the violation it names:**

1. Add `export const dynamic = 'force-static'` is not enough — instead, temporarily edit `app/db/[name]/layout.tsx` to remove `await connection()`. Expected: the first test fails naming that file. Revert.
2. Add `const p = new Pool()` to a page. Expected: the second test fails. Revert.
3. Change `<Sql>{s.query}</Sql>` back to `{s.query}` in `sessions/page.tsx`. Expected: the third test fails. Revert.
4. Remove the `redactSecrets(...)` call from `sql.tsx`. Expected: the fourth test fails. Revert.

Report all four proofs. A guard nobody watched fail is not a guard.

- [ ] **Step 3: Wire CI**

In `.github/workflows/ci.yml`, add to the `static` job after the existing typecheck steps:

```yaml
      - run: npm run --workspace @pgops/web typecheck
      - run: npm run test:web
```

And in the `integration` job, after `npm run test:int`:

```yaml
      - run: npm run --workspace @pgops/web build
      - run: npx vitest run --project integration apps/web/test
```

- [ ] **Step 4: Run everything**

```bash
npm test && npm run test:web && npm run typecheck && npm run typecheck:test \
  && npm run --workspace @pgops/checks typecheck && npm run --workspace @pgops/web typecheck
npm run --workspace @pgops/web build && npm run test:int
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/test/guards.test.ts .github/workflows/ci.yml
git commit -m "test(web): guard the dynamic-rendering and redaction rules, and gate them in CI"
```

---

## Deferred to P1b, deliberately

Named here so nobody implements them early or reports them as gaps:

- **HTTP basic auth** (`PGOPS_USERNAME` / `PGOPS_PASSWORD` middleware), spec §7.2.
- **The Docker image** — multi-stage build on `output: 'standalone'`, non-root user, spec §8. `next.config.ts` already sets `output: 'standalone'` so the build shape does not change late.
- **The env-inlining smoke test** — build an image with one `DATABASE_URL`, run it with another, assert it talks to the second. It needs Docker, so it lands with the image. Task 11's guard is the source-level half of the same rule.
- **`kill` behind `PGOPS_ALLOW_ACTIONS`**, spec §7.1. P1a is read-only.
- **Deleting the Ink TUI**, `src/ui/`, and the Ink/React-18 dependencies. This is what resolves the two-React-majors hazard.
- **`PGOPS_CONFIG_FILE`** — the mounted-file form of the same JSON, spec §8. `readDatabases` takes an env object, so adding it is one branch.

## Self-Review

**Spec coverage.** §6.1 rendering — Tasks 4, 11. §6.2 routes — Tasks 7, 8, 9, 10 cover the five incident routes; the eight hygiene routes are P2 by §10. §6.3 refresh — Task 6. §6.4 charts — none, P4 by §10. §7.3 redaction — Task 10, guarded in Task 11. §8 configuration — Task 3, minus `PGOPS_CONFIG_FILE` (P1b, listed above). §7.1 actions and §7.2 auth — P1b, listed above. **One deliberate deviation:** §6.1 says the dynamic-rendering rule is "enforced by lint rule"; Task 11 enforces it with a source-scanning test instead, because this repo has no ESLint toolchain and `boundaries.test.ts` already established the cheaper idiom. The requirement is met; the mechanism differs.

**Placeholder scan.** No TBDs. Two tasks (8 and 10) instruct the implementer to read the real `Data` interfaces and correct field names against the compiler — that is a verification step, not a placeholder, because the field names are knowable only from files this plan does not reproduce.

**Type consistency.** `runCheckFor` has the same two-overload shape as `runCheck` and is used consistently: two arguments for void-opts checks (`connections`, `sessionStates`, `blocked`, `locks`, `wraparound`, `slots`), three for opts-bearing ones (`sessions`, `longRunning`, `queryStats`). `CheckPanel`'s render-prop signature `(data, verdict) => ReactNode` matches every call site. `formatDuration(number | null)` matches every field it is passed, all of which are nullable in the source types.

**Known risk carried into execution.** Task 8's and Task 10's field names are written from the exported interfaces but not compiled against them. The first implementer to run `typecheck` will find any drift. This is flagged rather than hidden.
