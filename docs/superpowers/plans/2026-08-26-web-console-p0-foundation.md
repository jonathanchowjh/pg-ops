# pgops Web Console — P0 Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the nine existing pgops capabilities into a framework-free `@pgops/checks` package — rewriting the six defective queries as part of the extraction — behind a real-Postgres integration suite and CI.

**Architecture:** An npm workspaces monorepo. `packages/checks` depends on `pg` and nothing else; that dependency list is the wall that keeps SQL and thresholds separate from any renderer. Every check is a data object carrying its SQL, a pure `map`, thresholds-as-data, and its requirements. One executor (`runCheck`) turns a check into a uniform result envelope that never throws. A parity registry maps pgHero's 60 capabilities onto checks and reports the remaining backlog.

**Tech Stack:** TypeScript 5.7 (ESM, `NodeNext`), Node 22+, `pg` 8, Vitest 4, `@testcontainers/postgresql` 12, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-26-pgops-web-design.md`

**Prior review this plan implements fixes from:** `docs/superpowers/reviews/2026-08-26-pre-port-review.md` (findings A1–A11)

## Global Constraints

- **PostgreSQL floor is 14.** PG13 reached EOL in November 2025 and lacks `pg_stat_statements.toplevel`. CI matrix is **14, 16, 17, 18**.
- **Node floor is 22.**
- `packages/checks/package.json` `dependencies` contains **exactly one entry: `pg`**. Adding any framework, UI, or HTTP dependency to this package is a plan violation.
- **No module-level mutable state in `packages/checks`.** Pools are passed in via `CheckContext`. No `let pool` anywhere.
- `runCheck` **never rejects.** All failure paths return `{ ok: false }`.
- **No code path in this phase issues DDL, DML, or `pg_terminate_backend` except `packages/checks/src/actions/kill.ts`.**
- Every `Threshold` MUST carry a non-empty `because` string. A threshold without a written justification is a plan violation.
- The existing `src/` TUI tree is **not modified and not deleted in P0.** It keeps working off its own code. Deletion happens in P1.
- Existing repo conventions: 2-space indent, ESM with `.js` import specifiers, comments explain *why* and cite the defect they prevent.

---

## File Structure

```
package.json                          root: workspaces, shared scripts
tsconfig.base.json                    shared compiler options
vitest.config.ts                      root: projects for unit + integration
.github/workflows/ci.yml              typecheck · unit · integration matrix

packages/checks/
  package.json                        deps: { pg }
  tsconfig.json
  src/types.ts                        Check, Threshold, Verdict, CheckResult, CheckContext
  src/run.ts                          runCheck — the only executor
  src/registry.ts                     CHECKS map + PGHERO parity map
  src/checks/sessions.ts              sessions list + state census
  src/checks/connections.ts           headroom (A3)
  src/checks/blocked.ts               blocked count + suspect (A8)
  src/checks/locks.ts                 wait graph via pg_blocking_pids (A2)
  src/checks/long-running.ts          longest active queries
  src/checks/query-stats.ts           pg_stat_statements (A4, A5)
  src/checks/wraparound.ts            two numbers, not one ratio (A1)
  src/checks/slots.ts                 replication slots (A6)
  src/actions/kill.ts                 the CASE-guarded terminate
  src/redact.ts                       redactSecrets, ported verbatim
  test/harness.ts                     withPostgres — Testcontainers
  test/*.int.test.ts                  one per check, real Postgres
  test/*.test.ts                      pure unit tests
```

Files split by **question answered**, not by technical layer: a check's SQL, mapping, and thresholds live in one file because they change together.

---

### Task 1: Workspace skeleton and the core types

**Files:**
- Create: `packages/checks/package.json`, `packages/checks/tsconfig.json`, `packages/checks/src/types.ts`, `packages/checks/src/run.ts`
- Create: `tsconfig.base.json`
- Modify: `package.json` (add `workspaces`)
- Test: `packages/checks/test/run.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Check<Row, Data, Opts>`, `Threshold`, `Verdict`, `VerdictLevel`, `CheckResult<D>`, `FailureReason`, `CheckContext`, `SqlQuery`, `runCheck(ctx, check, opts?)`

- [ ] **Step 1: Write the failing test**

`packages/checks/test/run.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import type { Check, CheckContext } from '../src/types.js';

/** A fake pool: only `query` is ever called by runCheck. */
function fakeCtx(impl: () => Promise<{ rows: unknown[] }>): CheckContext {
  return { target: { query: impl } as never, serverVersion: 170000 };
}

const doubler: Check<{ n: string }, number> = {
  id: 'doubler',
  title: 'Doubler',
  class: 'incident',
  sql: 'SELECT 1 AS n',
  map: (rows) => Number(rows[0]?.n ?? 0) * 2,
};

describe('runCheck', () => {
  it('returns the mapped data and the time the query started', async () => {
    const before = Date.now();
    const r = await runCheck(fakeCtx(async () => ({ rows: [{ n: '21' }] })), doubler);
    expect(r).toMatchObject({ ok: true, data: 42 });
    if (r.ok) expect(r.measuredAt).toBeGreaterThanOrEqual(before);
  });

  it('never rejects — a thrown driver error becomes ok:false', async () => {
    const r = await runCheck(
      fakeCtx(async () => { throw new Error('boom'); }),
      doubler,
    );
    expect(r).toMatchObject({ ok: false, reason: 'error', message: 'boom' });
  });

  it('classifies a missing extension as missing-extension, with a remedy', async () => {
    const r = await runCheck(
      fakeCtx(async () => {
        const e = new Error('relation "pg_stat_statements" does not exist') as Error & { code: string };
        e.code = '42P01';
        throw e;
      }),
      { ...doubler, requires: [{ kind: 'extension', name: 'pg_stat_statements' }] },
    );
    expect(r).toMatchObject({ ok: false, reason: 'missing-extension' });
    if (!r.ok) expect(r.remedy).toBe('CREATE EXTENSION pg_stat_statements;');
  });

  it('classifies insufficient privilege, with the GRANT as the remedy', async () => {
    const r = await runCheck(
      fakeCtx(async () => {
        const e = new Error('permission denied') as Error & { code: string };
        e.code = '42501';
        throw e;
      }),
      { ...doubler, requires: [{ kind: 'role', name: 'pg_read_all_stats' }] },
    );
    expect(r).toMatchObject({ ok: false, reason: 'privilege' });
    if (!r.ok) expect(r.remedy).toBe('GRANT pg_read_all_stats TO CURRENT_USER;');
  });

  it('refuses to run below the check’s minimum server version', async () => {
    const r = await runCheck(
      { ...fakeCtx(async () => ({ rows: [] })), serverVersion: 130000 },
      { ...doubler, requires: [{ kind: 'version', min: 140000 }] },
    );
    expect(r).toMatchObject({ ok: false, reason: 'unsupported-version' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/checks/test/run.test.ts`
Expected: FAIL — `Cannot find module '../src/run.js'`

- [ ] **Step 3: Write the types**

`packages/checks/src/types.ts`:

```ts
import type { Pool } from 'pg';

export type VerdictLevel = 'ok' | 'warn' | 'critical';
export interface Verdict { level: VerdictLevel; note?: string }

/**
 * A threshold is DATA, not a constant in a comparison.
 *
 * Six of the eleven defects in the pre-port review were calibration errors:
 * correct SQL compared against a number that meant something other than the
 * label claimed. The worst shipped a `critical` at 8.38% of the horizon it was
 * named after, and 363 tests agreed with it because the test asserted the
 * constant equalled itself. `because` makes that hard to write down; `unit`
 * makes a seconds-vs-transactions mix-up a type question, not a review question.
 */
export interface Threshold {
  level: 'warn' | 'critical';
  value: number;
  unit: 'seconds' | 'transactions' | 'bytes' | 'percent' | 'count';
  /** The sentence justifying this number. MUST NOT be empty. */
  because: string;
}

export type Requirement =
  | { kind: 'extension'; name: string }
  | { kind: 'role'; name: string }
  | { kind: 'version'; min: number };

export interface SqlQuery { text: string; values?: unknown[] }

export interface Check<Row, Data, Opts = void> {
  id: string;
  title: string;
  /** `incident` renders on the triage page; `hygiene` renders on its own page and in doctor. */
  class: 'incident' | 'hygiene';
  sql: string | ((opts: Opts) => SqlQuery);
  /** Pure. Row shape in, domain data out. */
  map: (rows: Row[]) => Data;
  /** Pure. Absent means this check reports but never escalates. */
  verdict?: (data: Data, thresholds: Threshold[]) => Verdict;
  thresholds?: Threshold[];
  requires?: Requirement[];
}

export type FailureReason =
  | 'privilege' | 'missing-extension' | 'unsupported-version'
  | 'unreachable' | 'error';

export type CheckResult<D> =
  | { ok: true; data: D; verdict: Verdict; measuredAt: number }
  | { ok: false; reason: FailureReason; message: string; remedy?: string };

/**
 * Pools are passed in, never reached for. The TUI kept `let pool` at module
 * scope, which is why `fetchTriage()` took no arguments and could only ever
 * address one database — incompatible with multi-database and with a capture
 * job iterating targets.
 */
export interface CheckContext {
  target: Pool;
  /** The pgops schema. Only history-backed checks need it; absent in P0. */
  store?: Pool;
  /** `server_version_num`, e.g. 170000. */
  serverVersion: number;
}
```

- [ ] **Step 4: Write the executor**

`packages/checks/src/run.ts`:

```ts
import type { Check, CheckContext, CheckResult, FailureReason, Requirement, SqlQuery } from './types.js';

/** Postgres SQLSTATEs we can turn into an actionable remedy. */
const UNDEFINED_TABLE = '42P01';
const INSUFFICIENT_PRIVILEGE = '42501';

function remedyFor(reason: FailureReason, requires: Requirement[] = []): string | undefined {
  if (reason === 'missing-extension') {
    const ext = requires.find((r) => r.kind === 'extension');
    return ext ? `CREATE EXTENSION ${ext.name};` : undefined;
  }
  if (reason === 'privilege') {
    const role = requires.find((r) => r.kind === 'role');
    return role ? `GRANT ${role.name} TO CURRENT_USER;` : undefined;
  }
  return undefined;
}

function classify(err: unknown, requires: Requirement[] = []): FailureReason {
  const code = (err as { code?: string })?.code;
  if (code === UNDEFINED_TABLE && requires.some((r) => r.kind === 'extension')) return 'missing-extension';
  if (code === INSUFFICIENT_PRIVILEGE) return 'privilege';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return 'unreachable';
  return 'error';
}

/**
 * Node raises an AggregateError with an empty `.message` when a host resolves
 * to several addresses and every connect attempt fails (::1 and 127.0.0.1 both
 * refused — the ordinary "database is down" case). Unwrap it, or the operator
 * sees an unexplained failure at exactly the moment they need the reason.
 */
function messageOf(err: unknown): string {
  const e = err as { message?: string; errors?: unknown[] };
  if (e?.message) return e.message;
  if (Array.isArray(e?.errors)) {
    const parts = e.errors.map((x) => (x as Error | undefined)?.message).filter(Boolean);
    if (parts.length > 0) return parts.join('; ');
  }
  return String(err);
}

function toQuery<Opts>(sql: Check<never, never, Opts>['sql'], opts: Opts): SqlQuery {
  return typeof sql === 'string' ? { text: sql } : sql(opts);
}

/**
 * Run one check. NEVER rejects.
 *
 * Isolation is the point: across sixty checks on managed Postgres, any given
 * one may be denied. One unreadable check must never blank a page.
 */
export async function runCheck<Row, Data, Opts = void>(
  ctx: CheckContext,
  check: Check<Row, Data, Opts>,
  opts: Opts = undefined as Opts,
): Promise<CheckResult<Data>> {
  const version = check.requires?.find((r) => r.kind === 'version');
  if (version && ctx.serverVersion < version.min) {
    return {
      ok: false,
      reason: 'unsupported-version',
      message: `${check.id} requires server_version_num >= ${version.min}, found ${ctx.serverVersion}`,
    };
  }

  // Stamp when the database MEASURED the numbers, not when the promise settled.
  // A poll that took 5s then reads "5s ago" the moment it lands, which is true.
  const measuredAt = Date.now();
  try {
    const { text, values } = toQuery(check.sql as never, opts);
    const result = await ctx.target.query(text, values as never[]);
    const data = check.map(result.rows as Row[]);
    const verdict = check.verdict?.(data, check.thresholds ?? []) ?? { level: 'ok' as const };
    return { ok: true, data, verdict, measuredAt };
  } catch (err) {
    const reason = classify(err, check.requires);
    return { ok: false, reason, message: messageOf(err), remedy: remedyFor(reason, check.requires) };
  }
}
```

- [ ] **Step 5: Wire the workspace**

Root `package.json` — add these keys (keep the existing `scripts` and the existing `dependencies`/`devDependencies` for the still-live TUI):

```json
{
  "workspaces": ["packages/*", "apps/*"],
  "engines": { "node": ">=22" }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`packages/checks/package.json` — **`dependencies` has exactly one entry, by design:**

```json
{
  "name": "@pgops/checks",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "pg": "^8.13.1" },
  "devDependencies": { "@types/pg": "^8.11.10", "@testcontainers/postgresql": "^12.1.0" }
}
```

`packages/checks/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

Then run: `npm install`

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/checks/test/run.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.base.json packages/checks
git commit -m "feat(checks): the check model and its executor

runCheck never rejects: every failure becomes a typed reason plus, where we
can name one, the exact SQL that fixes it. Thresholds are data carrying the
sentence that justifies them — the pre-port review found six calibration
defects that a bare constant made easy to write and impossible to test."
```

---

### Task 2: The real-Postgres harness

**Files:**
- Create: `packages/checks/test/harness.ts`
- Create: `packages/checks/test/harness.int.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: `CheckContext` (Task 1)
- Produces: `withPostgres(fn: (ctx: CheckContext, pool: Pool) => Promise<void>): Promise<void>`, `seed(pool, sql)`

- [ ] **Step 1: Write the failing test**

`packages/checks/test/harness.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { withPostgres } from './harness.js';
import type { Check } from '../src/types.js';

const version: Check<{ v: string }, number> = {
  id: 'version', title: 'Server version', class: 'incident',
  sql: 'SELECT current_setting($1)::text AS v',
  map: (rows) => Number(rows[0]?.v ?? 0),
};

describe('the integration harness', () => {
  it('gives every test a live Postgres and a real CheckContext', async () => {
    await withPostgres(async (ctx) => {
      expect(ctx.serverVersion).toBeGreaterThanOrEqual(140000);
      const r = await runCheck(ctx, version);
      expect(r.ok).toBe(true);
    });
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/checks/test/harness.int.test.ts`
Expected: FAIL — `Cannot find module './harness.js'`

- [ ] **Step 3: Write the harness**

`packages/checks/test/harness.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { CheckContext } from '../src/types.js';

const { Pool } = pg;

/** Image tag comes from the CI matrix; defaults to the current stable. */
const IMAGE = `postgres:${process.env.PGOPS_TEST_PG_VERSION ?? '17'}`;

let container: StartedPostgreSqlContainer | undefined;

async function start(): Promise<StartedPostgreSqlContainer> {
  if (container) return container;
  container = await new PostgreSqlContainer(IMAGE)
    // pg_stat_statements must be preloaded; several checks read it.
    .withCommand(['postgres', '-c', 'shared_preload_libraries=pg_stat_statements'])
    .start();
  return container;
}

/**
 * Run `fn` against a live Postgres with a fresh, isolated database.
 *
 * One container per worker process, one DATABASE per test: starting a
 * container per test costs ~3s each and a suite of thirty would take longer
 * than anyone will wait for, which is how integration suites get skipped.
 */
export async function withPostgres(
  fn: (ctx: CheckContext, pool: pg.Pool) => Promise<void>,
): Promise<void> {
  const c = await start();
  const admin = new Pool({ connectionString: c.getConnectionUri(), max: 1 });
  const dbName = `t_${Math.random().toString(36).slice(2, 10)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const uri = new URL(c.getConnectionUri());
  uri.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: uri.toString(), max: 4, application_name: 'pgops-test' });
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    const { rows } = await pool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
    await fn({ target: pool, serverVersion: Number(rows[0]!.v) }, pool);
  } finally {
    await pool.end();
  }
}

/** Run setup SQL, one statement per call. Keeps failures attributable. */
export async function seed(pool: pg.Pool, sql: string): Promise<void> {
  await pool.query(sql);
}
```

- [ ] **Step 4: Split unit and integration runs**

`vitest.config.ts` at the repo root:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'packages/**/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/test/**/*.int.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
```

Add to the root `package.json` scripts:

```json
{
  "test": "vitest run --project unit",
  "test:int": "vitest run --project integration"
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project integration packages/checks/test/harness.int.test.ts`
Expected: PASS (first run pulls the postgres image — allow a few minutes)

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json packages/checks/test
git commit -m "test(checks): a real Postgres for the layer that talks to Postgres

363 tests passed while six SQL defects shipped, because not one of them
touched a database. One container per worker, one database per test, so the
suite stays fast enough that nobody is tempted to skip it."
```

---

### Task 3: CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `test` / `test:int` scripts (Task 2)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push: { branches: ['**'] }
  pull_request:

jobs:
  static:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run typecheck:test
      - run: npm test

  integration:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        pg: ['14', '16', '17', '18']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm }
      - run: npm ci
      - run: npm run test:int
        env:
          PGOPS_TEST_PG_VERSION: ${{ matrix.pg }}
```

- [ ] **Step 2: Verify locally that every referenced script exists**

Run: `npm run typecheck && npm run typecheck:test && npm test`
Expected: all three exit 0

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck, unit, and a 14/16/17/18 integration matrix

The version matrix is not thoroughness for its own sake: pg_stat_statements
.toplevel is PG14+, reserved_connections is PG16+, and the slots query has a
recovery-only branch. Each of those is a defect the matrix catches and a
single-version run does not."
```

---

### Task 4: The parity registry

**Files:**
- Create: `packages/checks/src/registry.ts`, `packages/checks/src/index.ts`
- Test: `packages/checks/test/registry.test.ts`

**Interfaces:**
- Consumes: `Check` (Task 1)
- Produces: `CHECKS`, `PGHERO`, `Phase`, `ParityEntry`, `parityBacklog(): number`

- [ ] **Step 1: Write the failing test**

`packages/checks/test/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CHECKS, PGHERO, parityBacklog } from '../src/registry.js';

const PHASES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

describe('the pgHero parity registry', () => {
  it('has an entry for every capability id 1..60', () => {
    const missing = Array.from({ length: 60 }, (_, i) => i + 1).filter((id) => !(id in PGHERO));
    expect(missing).toEqual([]);
  });

  it('puts every entry in exactly one of shipped / planned / declined', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      const states = ['check', 'planned', 'declined'].filter((k) => k in e);
      expect(states, `capability ${id}`).toHaveLength(1);
    }
  });

  it('never names a check that does not exist', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      if ('check' in e) expect(CHECKS, `capability ${id}`).toHaveProperty(e.check);
    }
  });

  it('declines exactly one capability — kill_all (#13)', () => {
    const declined = Object.entries(PGHERO).filter(([, e]) => 'declined' in e).map(([id]) => Number(id));
    expect(declined).toEqual([13]);
  });

  it('only plans phases that exist', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      if ('planned' in e) expect(PHASES, `capability ${id}`).toContain(e.planned);
    }
  });

  it('reports the remaining backlog — parity is complete when this is 0', () => {
    expect(parityBacklog()).toBe(Object.values(PGHERO).filter((e) => 'planned' in e).length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/checks/test/registry.test.ts`
Expected: FAIL — `Cannot find module '../src/registry.js'`

- [ ] **Step 3: Write the registry**

`packages/checks/src/registry.ts`. Populate all 60 entries from
`docs/superpowers/specs/2026-08-19-pgops-ops-console-design.md` §3.2 — **but
re-audit against current pgHero source first (see Task 4, Step 4).** The nine
checks built in this phase are wired as `check:`; everything else is `planned:`
with the phase from the P0–P6 table in the web design spec §10.

```ts
import type { Check } from './types.js';
import { sessions, sessionStates } from './checks/sessions.js';
import { connections } from './checks/connections.js';
import { blocked } from './checks/blocked.js';
import { locks } from './checks/locks.js';
import { longRunning } from './checks/long-running.js';
import { queryStats } from './checks/query-stats.js';
import { wraparound } from './checks/wraparound.js';
import { slots } from './checks/slots.js';

export const CHECKS = {
  sessions, sessionStates, connections, blocked,
  locks, longRunning, queryStats, wraparound, slots,
} satisfies Record<string, Check<never, never, never>>;

export type CheckId = keyof typeof CHECKS;
export type Phase = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';

export type ParityEntry = { name: string; source: string } & (
  | { check: CheckId }
  | { planned: Phase }
  | { declined: string }
);

export const PGHERO: Record<number, ParityEntry> = {
  1:  { name: 'server_version',        source: 'methods/basic.rb',       planned: 'P1' },
  2:  { name: 'database_name',         source: 'methods/basic.rb',       planned: 'P1' },
  3:  { name: 'ssl_in_use',            source: 'methods/basic.rb',       planned: 'P2' },
  4:  { name: 'connections',           source: 'methods/connections.rb', check: 'sessions' },
  5:  { name: 'total_connections',     source: 'methods/connections.rb', check: 'connections' },
  6:  { name: 'connection_states',     source: 'methods/connections.rb', check: 'sessionStates' },
  7:  { name: 'connection_sources',    source: 'methods/connections.rb', planned: 'P2' },
  8:  { name: 'running_queries',       source: 'methods/queries.rb',     check: 'sessions' },
  9:  { name: 'long_running_queries',  source: 'methods/queries.rb',     check: 'longRunning' },
  10: { name: 'blocked_queries',       source: 'methods/queries.rb',     check: 'locks' },
  11: { name: 'kill',                  source: 'methods/kill.rb',        planned: 'P1' },
  12: { name: 'kill_long_running',     source: 'methods/kill.rb',        planned: 'P5' },
  13: { name: 'kill_all',              source: 'methods/kill.rb',
        declined: 'An action with no diagnosis; there is no incident in which '
                + '"terminate every session, unreviewed" is the correct first move. '
                + 'Web design spec §11; v0.2 spec §3.4d.' },
  14: { name: 'query_stats',           source: 'methods/query_stats.rb', check: 'queryStats' },
  // … ids 15–43 and 45–60 follow the same shape; see Step 4.
  44: { name: 'transaction_id_danger', source: 'methods/maintenance.rb', check: 'wraparound' },
  50: { name: 'replication_slots',     source: 'methods/replication.rb', check: 'slots' },
};

/** Capabilities owned but not yet built. Parity is complete when this is 0. */
export function parityBacklog(): number {
  return Object.values(PGHERO).filter((e) => 'planned' in e).length;
}
```

`packages/checks/src/index.ts`:

```ts
export * from './types.js';
export * from './run.js';
export * from './registry.js';
export { redactSecrets } from './redact.js';
```

- [ ] **Step 4: Re-audit against current pgHero before filling in the remaining ids**

The 60-capability audit in the v0.2 spec was taken on 2026-08-19; pgHero 3.8.0
shipped in April 2026. **Do not copy the old matrix blind.**

```bash
git clone --depth 1 https://github.com/ankane/pghero /tmp/pghero
ls /tmp/pghero/lib/pghero/methods/
sed -n '1,80p' /tmp/pghero/CHANGELOG.md
```

For each file in `lib/pghero/methods/`, list its public methods and confirm every
one appears in `PGHERO`. Any method with no entry is a capability the audit
missed — add it as `planned`, in the phase matching its area in web design spec
§10. Record the pgHero version audited in a comment at the top of `registry.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/checks/test/registry.test.ts`
Expected: PASS, 6 tests. `parityBacklog()` should be 51 (60 − 9 built, minus 1
declined, plus any capability the re-audit added).

- [ ] **Step 6: Commit**

```bash
git add packages/checks/src/registry.ts packages/checks/src/index.ts packages/checks/test/registry.test.ts
git commit -m "feat(checks): a parity registry the build can enforce

The v0.2 spec called this 'what makes strict superset a property the build
enforces rather than a claim in a document', then never wrote it — because it
was framed as metadata beside the code, and metadata beside code drifts. Here
the map references live check keys, so deleting a check breaks the test and
adding a pgHero capability with no owner breaks it too. The remaining planned
count IS the parity backlog."
```

---

### Task 5: `redactSecrets`, ported verbatim

**Files:**
- Create: `packages/checks/src/redact.ts`
- Test: `packages/checks/test/redact.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `redactSecrets(text: string): string`

- [ ] **Step 1: Copy the existing tests first**

Copy `src/core/snapshot.test.ts`'s `redactSecrets` describe block into
`packages/checks/test/redact.test.ts`, changing only the import to
`from '../src/redact.js'`. Add one case the web makes newly important:

```ts
it('masks a password caught in flight in a rendered query', () => {
  expect(redactSecrets("ALTER USER app PASSWORD 'hunter2'"))
    .toBe('ALTER USER app PASSWORD ***');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/checks/test/redact.test.ts`
Expected: FAIL — `Cannot find module '../src/redact.js'`

- [ ] **Step 3: Copy the implementation**

Copy the `KEYS` constant, the `CREDENTIAL_RULES` array, and the `redactSecrets`
function from `src/core/snapshot.ts` (lines 17–94) into
`packages/checks/src/redact.ts`, **including every explanatory comment**. Those
comments name the specific fuzz inputs each rule exists for — doubled quotes,
`E'…'` escapes, dollar-quoting, literals clipped by `track_activity_query_size`
— and a future reader who deletes a rule without them will reintroduce a leak.

Do not copy `buildSnapshot` or `SnapshotMeta`: markdown export is cut (web
design spec §11).

Add at the top:

```ts
/**
 * Ported from src/core/snapshot.ts. Matters MORE on the web than it did in the
 * terminal: a screenshot needs a human to take it, a URL forwards itself.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/checks/test/redact.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/checks/src/redact.ts packages/checks/test/redact.test.ts
git commit -m "feat(checks): port redactSecrets

Unchanged rules, unchanged comments. A caught-in-flight ALTER USER ... PASSWORD
rendered on a shared URL is a worse outcome than the same string in a terminal."
```

---

### Task 6: `connections` — headroom that counts the reserved pool (A3)

**Files:**
- Create: `packages/checks/src/checks/connections.ts`
- Test: `packages/checks/test/connections.int.test.ts`

**Interfaces:**
- Consumes: `Check`, `runCheck`, `withPostgres`
- Produces: `connections: Check<ConnectionsRow, ConnectionsData>`, `ConnectionsData = { max, used, reserved, headroom }`

- [ ] **Step 1: Write the failing test**

`packages/checks/test/connections.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { connections } from '../src/checks/connections.js';
import { withPostgres } from './harness.js';

describe('connections', () => {
  it('subtracts the reserved pool from headroom (A3)', async () => {
    await withPostgres(async (ctx, pool) => {
      const r = await runCheck(ctx, connections);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const { rows } = await pool.query<{ max: string; su: string }>(
        `SELECT current_setting('max_connections') AS max,
                current_setting('superuser_reserved_connections') AS su`,
      );
      const max = Number(rows[0]!.max);
      const su = Number(rows[0]!.su);

      expect(r.data.max).toBe(max);
      expect(r.data.reserved).toBeGreaterThanOrEqual(su);
      // The defect: headroom used to be max - used, ignoring the reserved pool.
      expect(r.data.headroom).toBe(max - r.data.reserved - r.data.used);
    });
  }, 120_000);

  it('escalates on the boundary, in the database, not on the constant', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, connections);
      if (!r.ok) throw new Error(r.message);
      // An idle test database has almost all of its pool free.
      expect(r.verdict.level).toBe('ok');

      // Drive the verdict directly at each documented boundary.
      const t = connections.thresholds!;
      const warnAt = t.find((x) => x.level === 'warn')!.value;
      const critAt = t.find((x) => x.level === 'critical')!.value;
      const at = (pct: number) => connections.verdict!(
        { max: 100, used: 100 - pct, reserved: 0, headroom: pct }, t,
      ).level;

      expect(at(warnAt)).toBe('ok');        // exactly at the line is not over it
      expect(at(warnAt - 1)).toBe('warn');
      expect(at(critAt)).toBe('warn');
      expect(at(critAt - 1)).toBe('critical');
    });
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project integration packages/checks/test/connections.int.test.ts`
Expected: FAIL — `Cannot find module '../src/checks/connections.js'`

- [ ] **Step 3: Write the check**

`packages/checks/src/checks/connections.ts`:

```ts
import type { Check, Threshold, Verdict } from '../types.js';

export interface ConnectionsRow {
  max_connections: string;
  reserved: string;
  used: string;
}

export interface ConnectionsData {
  max: number;
  used: number;
  /** superuser_reserved_connections + reserved_connections. */
  reserved: number;
  /** What an ordinary application role can still open. */
  headroom: number;
}

/**
 * Pre-port review A3: headroom was `max_connections - count(client backends)`,
 * which ignores superuser_reserved_connections (default 3) and, on PG16+,
 * reserved_connections. On a default max_connections=100 the alarm fired three
 * connections later than the pool an app role can actually draw from — on the
 * one check whose entire purpose is warning before "FATAL: too many
 * connections".
 *
 * `current_setting(_, true)` is missing_ok: reserved_connections does not exist
 * below PG16, and this check must run on PG14.
 */
const SQL = `
SELECT current_setting('max_connections')::int AS max_connections,
       current_setting('superuser_reserved_connections')::int
         + COALESCE(NULLIF(current_setting('reserved_connections', true), '')::int, 0) AS reserved,
       (SELECT count(*)::int FROM pg_stat_activity
         WHERE backend_type = 'client backend') AS used`;

export const connections: Check<ConnectionsRow, ConnectionsData> = {
  id: 'connections',
  title: 'Connection headroom',
  class: 'incident',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    const max = Number(r?.max_connections ?? 0);
    const used = Number(r?.used ?? 0);
    const reserved = Number(r?.reserved ?? 0);
    return { max, used, reserved, headroom: max - reserved - used };
  },
  thresholds: [
    { level: 'warn', value: 20, unit: 'percent',
      because: 'below a fifth of the pool free, a normal traffic spike can exhaust it '
             + 'before anyone reacts' },
    { level: 'critical', value: 10, unit: 'percent',
      because: 'below a tenth, connection refusals are minutes away and the fix '
             + '(pgbouncer, or killing idle-in-transaction) takes longer than that' },
  ],
  verdict: (d, t): Verdict => {
    const pct = d.max > 0 ? (d.headroom / d.max) * 100 : 100;
    const crit = t.find((x) => x.level === 'critical')!;
    const warn = t.find((x) => x.level === 'warn')!;
    if (pct < crit.value) return { level: 'critical', note: `${d.headroom} connections left` };
    if (pct < warn.value) return { level: 'warn', note: `${d.headroom} connections left` };
    return { level: 'ok' };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project integration packages/checks/test/connections.int.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add packages/checks/src/checks/connections.ts packages/checks/test/connections.int.test.ts
git commit -m "fix(checks): headroom counts the reserved pool (A3)

max_connections - used over-reports by superuser_reserved_connections plus
reserved_connections, so the critical fired three connections late on a default
config — on the one check whose job is warning before FATAL: too many
connections."
```

---

### Task 7: `wraparound` — two numbers, not one ratio (A1)

**Files:**
- Create: `packages/checks/src/checks/wraparound.ts`
- Test: `packages/checks/test/wraparound.int.test.ts`

**Interfaces:**
- Consumes: `Check`, `runCheck`, `withPostgres`
- Produces: `wraparound: Check<WraparoundRow, WraparoundData>`, `WraparoundData = { worst: { database, xactAge, txnsUntilShutdown, pctToForcedVacuum }[] }`

- [ ] **Step 1: Write the failing test**

`packages/checks/test/wraparound.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { wraparound } from '../src/checks/wraparound.js';
import { withPostgres } from './harness.js';

const HARD_LIMIT = 2_147_483_647;

describe('wraparound', () => {
  it('reports transactions remaining, not a ratio of the autovacuum trigger', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, wraparound);
      if (!r.ok) throw new Error(r.message);
      const worst = r.data.worst[0]!;
      expect(worst.txnsUntilShutdown).toBe(HARD_LIMIT - worst.xactAge);
      expect(worst.txnsUntilShutdown).toBeGreaterThan(2_000_000_000);
      expect(r.verdict.level).toBe('ok');
    });
  }, 120_000);

  it('does NOT escalate at the forced-autovacuum trigger — that is routine (A1)', () => {
    const t = wraparound.thresholds!;
    // 180M transactions of age is 90% of the default autovacuum_freeze_max_age.
    // The shipped code called this `critical`. It is 8.38% of the real horizon.
    const at180M = wraparound.verdict!(
      { worst: [{ database: 'app', xactAge: 180_000_000,
                  txnsUntilShutdown: HARD_LIMIT - 180_000_000,
                  pctToForcedVacuum: 90 }] }, t);
    expect(at180M.level).toBe('ok');
  });

  it('escalates on transactions remaining, at the documented boundary', () => {
    const t = wraparound.thresholds!;
    const warn = t.find((x) => x.level === 'warn')!.value;
    const crit = t.find((x) => x.level === 'critical')!.value;
    const at = (remaining: number) => wraparound.verdict!(
      { worst: [{ database: 'app', xactAge: HARD_LIMIT - remaining,
                  txnsUntilShutdown: remaining, pctToForcedVacuum: 0 }] }, t).level;

    expect(at(warn + 1)).toBe('ok');
    expect(at(warn)).toBe('warn');
    expect(at(crit)).toBe('critical');
  });

  it('every threshold carries a justification', () => {
    for (const t of wraparound.thresholds!) expect(t.because.length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/checks/test/wraparound.int.test.ts`
Expected: FAIL — `Cannot find module '../src/checks/wraparound.js'`

- [ ] **Step 3: Write the check**

`packages/checks/src/checks/wraparound.ts`:

```ts
import type { Check, Verdict } from '../types.js';

/** The xid at which Postgres refuses new transactions. */
const HARD_LIMIT = 2_147_483_647;

export interface WraparoundRow {
  database: string;
  xact_age: string;
  freeze_max_age: string;
}

export interface WraparoundEntry {
  database: string;
  xactAge: number;
  /** Transactions remaining before the server refuses writes. THE alarm. */
  txnsUntilShutdown: number;
  /** How close to a routine forced autovacuum. Informational only. */
  pctToForcedVacuum: number;
}

export interface WraparoundData { worst: WraparoundEntry[] }

/**
 * Pre-port review A1 — the worst defect found.
 *
 * The shipped check computed `100 * age(datfrozenxid) / autovacuum_freeze_max_age`
 * and criticalled at 90%. But autovacuum_freeze_max_age (default 200,000,000)
 * is the age at which Postgres FORCES a routine anti-wraparound autovacuum. It
 * is a maintenance trigger, not a danger line; busy databases cross it as normal
 * operation. Verified: the shipped `critical` fired at 8.38% of the real horizon.
 *
 * Worse, in the other direction: a database at 2.0 billion — hours from refusing
 * transactions — rendered as "1000% of horizon" on a scale whose critical had
 * already been passed five times over. Nothing was calibrated to the failure the
 * check was named after.
 *
 * So: two independent numbers. The ratio stays, as information. The alarm is
 * transactions remaining, which is what pgHero's transaction_id_danger (#44)
 * measures and the only one that is actionable.
 */
const SQL = `
SELECT datname AS database,
       age(datfrozenxid)::text AS xact_age,
       current_setting('autovacuum_freeze_max_age') AS freeze_max_age
FROM pg_database
WHERE datallowconn
ORDER BY age(datfrozenxid) DESC
LIMIT 10`;

export const wraparound: Check<WraparoundRow, WraparoundData> = {
  id: 'wraparound',
  title: 'Transaction ID wraparound',
  class: 'incident',
  sql: SQL,
  map: (rows) => ({
    worst: rows.map((r) => {
      const xactAge = Number(r.xact_age);
      return {
        database: r.database,
        xactAge,
        txnsUntilShutdown: HARD_LIMIT - xactAge,
        pctToForcedVacuum: Math.round((100 * xactAge) / Number(r.freeze_max_age)),
      };
    }),
  }),
  thresholds: [
    { level: 'warn', value: 500_000_000, unit: 'transactions',
      because: 'about a quarter of the 2^31 horizon consumed; enough runway to vacuum '
             + 'the largest table without an outage window, but the trend now matters' },
    { level: 'critical', value: 100_000_000, unit: 'transactions',
      because: 'pgHero #44 flags at 10M remaining; we escalate at 100M because '
             + 'freezing a multi-terabyte table takes longer than 10M transactions '
             + 'of headroom buys on a busy system' },
  ],
  verdict: (d, t): Verdict => {
    const worst = d.worst[0];
    if (!worst) return { level: 'ok' };
    const crit = t.find((x) => x.level === 'critical')!;
    const warn = t.find((x) => x.level === 'warn')!;
    const note = `${worst.database}: ${worst.txnsUntilShutdown.toLocaleString()} transactions left`;
    if (worst.txnsUntilShutdown <= crit.value) return { level: 'critical', note };
    if (worst.txnsUntilShutdown <= warn.value) return { level: 'warn', note };
    return { level: 'ok' };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project integration packages/checks/test/wraparound.int.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/checks/src/checks/wraparound.ts packages/checks/test/wraparound.int.test.ts
git commit -m "fix(checks): wraparound alarms on transactions remaining (A1)

autovacuum_freeze_max_age is the forced-vacuum trigger, not the failure point.
The shipped check criticalled at 180M xid age — 8.38% of the 2^31 horizon —
and had no signal at all for the real thing. Now two numbers: percent to a
routine freeze, and transactions until the server refuses writes."
```

---

### Task 8: `locks` — the wait graph, rebuilt on `pg_blocking_pids` (A2)

**Files:**
- Create: `packages/checks/src/checks/locks.ts`
- Test: `packages/checks/test/locks.int.test.ts`, `packages/checks/test/locks.test.ts`

**Interfaces:**
- Consumes: `Check`, `runCheck`, `withPostgres`
- Produces: `locks: Check<LockRow, LocksData>`, `buildChains(rows: LockRow[]): RootBlocker[]`, `RootBlocker`, `Waiter`

- [ ] **Step 1: Write the failing integration test**

`packages/checks/test/locks.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { runCheck } from '../src/run.js';
import { locks } from '../src/checks/locks.js';
import { withPostgres } from './harness.js';

/** Open a session that holds an advisory lock and keeps its transaction open. */
async function holder(uri: string, app: string, key: number): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: uri, application_name: app });
  c.on('error', () => {});
  await c.connect();
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock($1)', [key]);
  return c;
}

describe('locks', () => {
  it('does not name an unrelated advisory-lock holder as a blocker (A2)', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      const a = await holder(uri, 'holder-key-1', 1);   // innocent
      const b = await holder(uri, 'holder-key-2', 2);   // the real blocker
      const c = new pg.Client({ connectionString: uri, application_name: 'waiter-key-2' });
      c.on('error', () => {});
      await c.connect();
      void c.query('BEGIN').then(() => c.query('SELECT pg_advisory_xact_lock($1)', [2])).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));

      try {
        const r = await runCheck(ctx, locks);
        if (!r.ok) throw new Error(r.message);
        const rootApps = r.data.roots.map((x) => x.app);
        expect(rootApps).toContain('holder-key-2');
        // The shipped join key omitted classid/objid, so every advisory lock in
        // a database matched every other one and this name appeared.
        expect(rootApps).not.toContain('holder-key-1');
      } finally {
        await Promise.all([a.end(), b.end(), c.end()].map((p) => p.catch(() => {})));
      }
    });
  }, 120_000);

  it('nests a queued blocker instead of flattening it (A2)', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      await pool.query('CREATE TABLE t (id int)');

      const reader = new pg.Client({ connectionString: uri, application_name: 'long-reader' });
      const migration = new pg.Client({ connectionString: uri, application_name: 'migration' });
      const tail = new pg.Client({ connectionString: uri, application_name: 'tail-reader' });
      for (const c of [reader, migration, tail]) { c.on('error', () => {}); await c.connect(); }

      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM t');
      void migration.query('BEGIN').then(() => migration.query('LOCK TABLE t IN ACCESS EXCLUSIVE MODE')).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
      void tail.query('BEGIN').then(() => tail.query('SELECT count(*) FROM t')).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));

      try {
        const r = await runCheck(ctx, locks);
        if (!r.ok) throw new Error(r.message);
        const root = r.data.roots.find((x) => x.app === 'long-reader');
        expect(root, 'long-reader should be the root').toBeDefined();
        // Truth: reader -> migration -> tail. The shipped query produced
        // reader -> {migration, tail} because an edge required the blocker's
        // own lock to be GRANTED, so a queued blocker could never nest.
        expect(root!.waiters).toHaveLength(1);
        expect(root!.waiters[0]!.app).toBe('migration');
        expect(root!.waiters[0]!.waiters[0]!.app).toBe('tail-reader');
        expect(root!.totalWaiters).toBe(2);
      } finally {
        await Promise.all([reader.end(), migration.end(), tail.end()].map((p) => p.catch(() => {})));
      }
    });
  }, 120_000);
});
```

- [ ] **Step 2: Write the failing unit test for the pure graph builder**

`packages/checks/test/locks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildChains, type LockRow } from '../src/checks/locks.js';

const row = (pid: number, blockedBy: number[], app = `a${pid}`): LockRow => ({
  pid, blocked_by: blockedBy, app, usename: 'u', state: 'active',
  query: 'q', backend_start: '2026-01-01T00:00:00Z',
  xact_age_secs: '1', query_age_secs: '1', waiting_mode: null, waiting_on: null,
});

describe('buildChains', () => {
  it('nests a chain', () => {
    const roots = buildChains([row(1, []), row(2, [1]), row(3, [2])]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.pid).toBe(1);
    expect(roots[0]!.waiters[0]!.pid).toBe(2);
    expect(roots[0]!.waiters[0]!.waiters[0]!.pid).toBe(3);
    expect(roots[0]!.totalWaiters).toBe(2);
  });

  it('shows a diamond once and counts it once', () => {
    // 2 and 3 both blocked by 1; 4 blocked by both 2 and 3.
    const roots = buildChains([row(1, []), row(2, [1]), row(3, [1]), row(4, [2, 3])]);
    expect(roots[0]!.totalWaiters).toBe(3);
  });

  it('surfaces a closed cycle instead of reporting no contention', () => {
    const roots = buildChains([row(1, [2]), row(2, [1])]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.waiters[0]!.waiters[0]!.cycle).toBe(true);
  });

  it('orders the worst offender first', () => {
    const roots = buildChains([row(1, []), row(2, [1]), row(3, [1]), row(10, []), row(11, [10])]);
    expect(roots[0]!.pid).toBe(1);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run packages/checks/test/locks.test.ts`
Expected: FAIL — `Cannot find module '../src/checks/locks.js'`

- [ ] **Step 4: Write the check**

`packages/checks/src/checks/locks.ts`:

```ts
import type { Check, Verdict } from '../types.js';

export interface LockRow {
  pid: number;
  blocked_by: number[];
  usename: string | null;
  app: string | null;
  state: string | null;
  query: string | null;
  backend_start: string | null;
  xact_age_secs: string | null;
  query_age_secs: string | null;
  waiting_mode: string | null;
  waiting_on: string | null;
}

export interface Waiter {
  pid: number; user: string | null; app: string | null; query: string | null;
  state: string | null; backendStart: string | null;
  waitingMode: string | null; waitingOn: string | null;
  /** Age of this session's transaction. NOT time spent waiting — see A8. */
  xactAgeSecs: number | null;
  waiters: Waiter[];
  /** A back-edge to an ancestor: a deadlock in flight. */
  cycle: boolean;
}

export interface RootBlocker extends Omit<Waiter, 'cycle'> {
  totalWaiters: number;
}

export interface LocksData { roots: RootBlocker[] }

/**
 * Pre-port review A2. The shipped query self-joined pg_locks on
 * (locktype, database, relation, transactionid) and had two defects:
 *
 *  1. It omitted page, tuple, classid, objid and objsubid. Advisory locks are
 *     identified entirely by classid/objid, so every advisory lock in a database
 *     matched every other one — an uninvolved session was named as a root
 *     blocker, on the view with a kill button.
 *  2. `WHERE NOT blocked.granted AND blocking.granted` meant an edge existed
 *     only when the blocker's own lock was granted, so a QUEUED blocker could
 *     never be an intermediate node. The classic migration pile-up (long read <-
 *     ACCESS EXCLUSIVE <- readers) rendered flat, hiding the amplifier.
 *
 * pg_blocking_pids() knows about hard blocks, soft blocks (queue position),
 * parallel workers, and prepared transactions. It is what the cockpit's blocked
 * panel already used, which is why the two views disagreed.
 *
 * MATERIALIZED is load-bearing: without it the planner may inline the CTE and
 * evaluate pg_blocking_pids once per reference per row, and the function takes
 * exclusive access to the lock manager's shared state. One call per backend.
 */
const SQL = `
WITH act AS MATERIALIZED (
  SELECT pid, usename, application_name AS app, state, query,
         backend_start::text AS backend_start,
         EXTRACT(EPOCH FROM (now() - xact_start))::text  AS xact_age_secs,
         EXTRACT(EPOCH FROM (now() - query_start))::text AS query_age_secs,
         pg_blocking_pids(pid) AS blocked_by
  FROM pg_stat_activity
  WHERE backend_type = 'client backend'
)
SELECT a.*,
       (SELECT string_agg(DISTINCT l.mode, ',') FROM pg_locks l
         WHERE l.pid = a.pid AND NOT l.granted) AS waiting_mode,
       (SELECT string_agg(DISTINCT l.relation::regclass::text, ',') FROM pg_locks l
         WHERE l.pid = a.pid AND NOT l.granted AND l.relation IS NOT NULL) AS waiting_on
FROM act a
WHERE cardinality(a.blocked_by) > 0
   OR a.pid IN (SELECT unnest(blocked_by) FROM act)
LIMIT 500`;

function toWaiter(r: LockRow, waiters: Waiter[], cycle: boolean): Waiter {
  return {
    pid: r.pid, user: r.usename, app: r.app, query: r.query, state: r.state,
    backendStart: r.backend_start,
    waitingMode: r.waiting_mode, waitingOn: r.waiting_on,
    xactAgeSecs: r.xact_age_secs == null ? null : Number(r.xact_age_secs),
    waiters, cycle,
  };
}

/**
 * Pure: (pid, blocked_by[]) edges -> root-blocker trees.
 *
 * `path` is the ancestor chain, for cycle detection. `visited` is every pid
 * already placed under THIS root: a wait graph is a graph, not a tree, so a
 * session blocked by two blockers is reachable twice and must be shown — and
 * counted — once.
 */
export function buildChains(rows: LockRow[]): RootBlocker[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const blockedBy = new Map(rows.map((r) => [r.pid, r.blocked_by.filter((p) => p !== r.pid)]));
  const children = new Map<number, number[]>();
  for (const [pid, blockers] of blockedBy) {
    for (const b of blockers) children.set(b, [...(children.get(b) ?? []), pid]);
  }

  const walk = (pid: number, path: Set<number>, visited: Set<number>): { waiters: Waiter[]; count: number } => {
    const waiters: Waiter[] = [];
    let count = 0;
    for (const child of (children.get(pid) ?? []).sort((a, b) => a - b)) {
      const row = byPid.get(child);
      if (!row) continue;
      const cycle = path.has(child);
      if (!cycle && visited.has(child)) continue;
      if (cycle) { waiters.push(toWaiter(row, [], true)); continue; }
      visited.add(child);
      const nested = walk(child, new Set(path).add(child), visited);
      waiters.push(toWaiter(row, nested.waiters, false));
      count += 1 + nested.count;
    }
    return { waiters, count };
  };

  const makeRoot = (pid: number): RootBlocker => {
    const row = byPid.get(pid)!;
    const { waiters, count } = walk(pid, new Set([pid]), new Set());
    return { ...toWaiter(row, waiters, false), totalWaiters: count } as RootBlocker;
  };

  const rootPids = [...children.keys()]
    .filter((pid) => (blockedBy.get(pid) ?? []).length === 0)
    .sort((a, b) => a - b);

  const roots = rootPids.map(makeRoot);

  // Every session in a closed cycle is blocked, so none of them is a root and
  // the view read "no lock contention" during a live deadlock — the one moment
  // this check exists for. Seed one entry point per cycle (lowest pid); the
  // `cycle` flag on the back-edge is what names it a deadlock.
  if (roots.length === 0 && rows.length > 0) {
    const covered = new Set<number>();
    const collect = (ws: Waiter[]) => { for (const w of ws) { covered.add(w.pid); collect(w.waiters); } };
    for (const pid of [...children.keys()].sort((a, b) => a - b)) {
      if (covered.has(pid)) continue;
      const root = makeRoot(pid);
      covered.add(pid);
      collect(root.waiters);
      roots.push(root);
    }
  }

  return roots.sort((a, b) => b.totalWaiters - a.totalWaiters || a.pid - b.pid);
}

export const locks: Check<LockRow, LocksData> = {
  id: 'locks',
  title: 'Lock wait graph',
  class: 'incident',
  sql: SQL,
  map: (rows) => ({ roots: buildChains(rows) }),
  thresholds: [
    { level: 'warn', value: 1, unit: 'count',
      because: 'any session waiting on a lock is a query not completing; it is worth '
             + 'seeing even when brief' },
    { level: 'critical', value: 60, unit: 'seconds',
      because: 'a minute of blocking outlives most application timeouts, so the waiters '
             + 'are already being retried and the pile-up is compounding' },
  ],
  verdict: (d, t): Verdict => {
    const total = d.roots.reduce((n, r) => n + r.totalWaiters, 0);
    if (total === 0) return { level: 'ok' };
    const crit = t.find((x) => x.level === 'critical')!;
    const oldest = Math.max(...d.roots.map((r) => r.xactAgeSecs ?? 0));
    const note = `${total} session(s) blocked`;
    return { level: oldest >= crit.value ? 'critical' : 'warn', note };
  },
};
```

- [ ] **Step 5: Run both suites to verify they pass**

Run: `npx vitest run packages/checks/test/locks.test.ts`
Expected: PASS, 4 tests

Run: `npx vitest run --project integration packages/checks/test/locks.int.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 6: Commit**

```bash
git add packages/checks/src/checks/locks.ts packages/checks/test/locks.test.ts packages/checks/test/locks.int.test.ts
git commit -m "fix(checks): rebuild the wait graph on pg_blocking_pids (A2)

The pg_locks self-join omitted classid/objid, so unrelated advisory-lock
holders were named as root blockers — verified against ground truth. And it
required the blocker's own lock to be granted, so a queued ACCESS EXCLUSIVE
could never nest and the classic migration pile-up rendered flat. Both are one
function call the cockpit was already making 40 lines away."
```

---

### Task 9: `sessions` and `sessionStates` (A7, A9, A10, A11)

**Files:**
- Create: `packages/checks/src/checks/sessions.ts`
- Test: `packages/checks/test/sessions.int.test.ts`, `packages/checks/test/sessions.test.ts`

**Interfaces:**
- Consumes: `Check`
- Produces: `sessions: Check<SessionRow, SessionRow[], SessionOpts>`, `sessionStates: Check<StateRow, StatesData>`, `isIdleInTransaction(state)`, `prepareSessions(rows, opts)`

- [ ] **Step 1: Write the failing unit test**

`packages/checks/test/sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isIdleInTransaction, prepareSessions, type Session } from '../src/checks/sessions.js';

const s = (o: Partial<Session>): Session => ({
  pid: 1, state: 'idle', user: 'u', app: 'a', clientAddr: null, backendStart: null,
  inStateSecs: 0, queryAgeSecs: 0, query: '', ...o,
});

describe('isIdleInTransaction', () => {
  it('covers both Postgres spellings, and only those', () => {
    expect(isIdleInTransaction('idle in transaction')).toBe(true);
    expect(isIdleInTransaction('idle in transaction (aborted)')).toBe(true);
    expect(isIdleInTransaction('idle')).toBe(false);
    expect(isIdleInTransaction(null)).toBe(false);
  });
});

describe('prepareSessions', () => {
  it('ranks idle-in-transaction first, then active, then idle', () => {
    const out = prepareSessions(
      [s({ pid: 1, state: 'idle' }), s({ pid: 2, state: 'active' }),
       s({ pid: 3, state: 'idle in transaction' })],
      { sort: 'triage', filter: '' },
    );
    expect(out.map((r) => r.pid)).toEqual([3, 2, 1]);
  });

  it('orders idle sessions by time in state, not by a stale query age (A9)', () => {
    const out = prepareSessions(
      [s({ pid: 1, state: 'idle', inStateSecs: 5, queryAgeSecs: 900 }),
       s({ pid: 2, state: 'idle', inStateSecs: 60, queryAgeSecs: 1 })],
      { sort: 'triage', filter: '' },
    );
    expect(out.map((r) => r.pid)).toEqual([2, 1]);
  });

  it('matches a pid typed into the filter (A10)', () => {
    const out = prepareSessions(
      [s({ pid: 4242, app: 'web' }), s({ pid: 7, app: 'cron' })],
      { sort: 'triage', filter: '4242' },
    );
    expect(out.map((r) => r.pid)).toEqual([4242]);
  });
});
```

- [ ] **Step 2: Write the failing integration test**

`packages/checks/test/sessions.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { sessions, sessionStates } from '../src/checks/sessions.js';
import { withPostgres } from './harness.js';

describe('sessions', () => {
  it('is bounded (A7) and excludes its own backend', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, sessions, { limit: 500 });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.length).toBeLessThanOrEqual(500);
      expect(r.data.every((x) => x.query?.includes('pg_stat_activity') !== true || x.pid > 0)).toBe(true);
    });
  }, 120_000);

  it('censuses states', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, sessionStates);
      if (!r.ok) throw new Error(r.message);
      expect(r.data.byState.length).toBeGreaterThan(0);
    });
  }, 120_000);
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run packages/checks/test/sessions.test.ts`
Expected: FAIL — `Cannot find module '../src/checks/sessions.js'`

- [ ] **Step 4: Write the checks**

`packages/checks/src/checks/sessions.ts`:

```ts
import type { Check, Verdict } from '../types.js';

export interface SessionRow {
  pid: number; state: string | null; usename: string | null; app: string | null;
  client_addr: string | null; backend_start: string | null;
  in_state_secs: string | null; query_age_secs: string | null; query: string | null;
}

export interface Session {
  pid: number; state: string | null; user: string | null; app: string | null;
  clientAddr: string | null; backendStart: string | null;
  inStateSecs: number | null;
  /** Age of the CURRENT (or last) query. Not "time waiting" — see A8. */
  queryAgeSecs: number | null;
  query: string | null;
}

export interface SessionOpts { limit?: number }

/**
 * A11: the shipped code had two definitions of this — `startsWith(...)` in one
 * file and an explicit two-literal enumeration in another. One concept, one
 * implementation, exported so nothing has an excuse to write a third.
 */
export function isIdleInTransaction(state: string | null | undefined): boolean {
  return state === 'idle in transaction' || state === 'idle in transaction (aborted)';
}

/** A7: pg_stat_activity is unbounded; a 2000-connection instance mid-incident
 * would return 2000 rows of up to track_activity_query_size each, per poll. */
const SQL = (o: SessionOpts) => ({
  text: `
    SELECT pid, state, usename, application_name AS app,
           client_addr::text AS client_addr, backend_start::text AS backend_start,
           EXTRACT(EPOCH FROM (now() - state_change))::text AS in_state_secs,
           EXTRACT(EPOCH FROM (now() - query_start))::text  AS query_age_secs,
           query
    FROM pg_stat_activity
    WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
    ORDER BY pid
    LIMIT $1`,
  values: [o.limit ?? 500],
});

export const sessions: Check<SessionRow, Session[], SessionOpts> = {
  id: 'sessions',
  title: 'Sessions',
  class: 'incident',
  sql: SQL,
  map: (rows) => rows.map((r) => ({
    pid: Number(r.pid), state: r.state, user: r.usename, app: r.app,
    clientAddr: r.client_addr, backendStart: r.backend_start,
    inStateSecs: r.in_state_secs == null ? null : Number(r.in_state_secs),
    queryAgeSecs: r.query_age_secs == null ? null : Number(r.query_age_secs),
    query: r.query,
  })),
};

export interface PrepareOpts { sort: 'triage' | 'active'; filter: string }

/** Triage priority: idle-in-transaction first — the #1 preventable incident. */
function rank(r: Session): number {
  if (isIdleInTransaction(r.state)) return 0;
  if (r.state === 'active') return 1;
  return 2;
}

export function prepareSessions(rows: Session[], o: PrepareOpts): Session[] {
  const needle = o.filter.trim().toLowerCase();
  const filtered = needle
    // A10: pid is included — an operator almost always arrives holding one.
    ? rows.filter((r) => [String(r.pid), r.user, r.app, r.state, r.query]
        .some((f) => f?.toLowerCase().includes(needle)))
    : rows;

  return [...filtered].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    // A9: an idle session's queryAgeSecs is time since its LAST query ended,
    // which carries no information. Order every non-active group by time in state.
    const key = (r: Session) => (r.state === 'active' ? r.queryAgeSecs : r.inStateSecs) ?? 0;
    return key(b) - key(a);
  });
}

export interface StateRow { state: string | null; sessions: string; longest_secs: string | null }
export interface StatesData {
  byState: { state: string; sessions: number; longestInStateSecs: number }[];
  oldestIdleInTxnSecs: number | null;
}

const STATES_SQL = `
SELECT state, count(*)::int AS sessions,
       max(EXTRACT(EPOCH FROM (now() - state_change)))::text AS longest_secs
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
GROUP BY state ORDER BY sessions DESC`;

export const sessionStates: Check<StateRow, StatesData> = {
  id: 'sessionStates',
  title: 'Session states',
  class: 'incident',
  sql: STATES_SQL,
  map: (rows) => {
    const byState = rows.map((r) => ({
      state: r.state ?? 'unknown',
      sessions: Number(r.sessions),
      longestInStateSecs: Number(r.longest_secs ?? 0),
    }));
    const oldestIdleInTxnSecs = byState.reduce<number | null>((longest, s) => {
      if (!isIdleInTransaction(s.state)) return longest;
      return longest == null || s.longestInStateSecs > longest ? s.longestInStateSecs : longest;
    }, null);
    return { byState, oldestIdleInTxnSecs };
  },
  thresholds: [
    { level: 'warn', value: 60, unit: 'seconds',
      because: 'a transaction idle for a minute is holding row locks and pinning the '
             + 'xmin horizon for no reason; almost always an application bug' },
    { level: 'critical', value: 300, unit: 'seconds',
      because: 'five minutes of idle-in-transaction blocks autovacuum from reclaiming '
             + 'anything newer, so bloat starts accumulating on top of the locking' },
  ],
  verdict: (d, t): Verdict => {
    const s = d.oldestIdleInTxnSecs;
    if (s == null) return { level: 'ok' };
    const crit = t.find((x) => x.level === 'critical')!;
    const warn = t.find((x) => x.level === 'warn')!;
    if (s >= crit.value) return { level: 'critical', note: `idle in transaction for ${Math.round(s)}s` };
    if (s > warn.value) return { level: 'warn', note: `idle in transaction for ${Math.round(s)}s` };
    return { level: 'ok' };
  },
};
```

- [ ] **Step 5: Run both to verify they pass**

Run: `npx vitest run packages/checks/test/sessions.test.ts`
Expected: PASS, 5 tests

Run: `npx vitest run --project integration packages/checks/test/sessions.int.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 6: Commit**

```bash
git add packages/checks/src/checks/sessions.ts packages/checks/test/sessions.test.ts packages/checks/test/sessions.int.test.ts
git commit -m "feat(checks): sessions and the state census (A7, A9, A10, A11)

Bounded result set, idle sessions ordered by time in state rather than by a
stale query age, pid searchable in the filter, and exactly one definition of
'idle in transaction' — the previous two disagreed by construction."
```

---

### Task 10: `blocked` and `longRunning` (A8)

**Files:**
- Create: `packages/checks/src/checks/blocked.ts`, `packages/checks/src/checks/long-running.ts`
- Test: `packages/checks/test/blocked.int.test.ts`

**Interfaces:**
- Consumes: `Check`
- Produces: `blocked: Check<BlockedRow, BlockedData>`, `longRunning: Check<LongRunningRow, LongRunning[]>`

- [ ] **Step 1: Write the failing test**

`packages/checks/test/blocked.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { blocked } from '../src/checks/blocked.js';
import { longRunning } from '../src/checks/long-running.js';
import { withPostgres } from './harness.js';

describe('blocked', () => {
  it('reports zero on a quiet database and names the field honestly (A8)', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, blocked);
      if (!r.ok) throw new Error(r.message);
      expect(r.data.count).toBe(0);
      expect(r.data.longestQueryAgeSecs).toBeNull();
      expect(r.verdict.level).toBe('ok');
    });
  }, 120_000);

  it('calls pg_blocking_pids once per backend, not twice', () => {
    const text = typeof blocked.sql === 'string' ? blocked.sql : blocked.sql(undefined as never).text;
    expect(text.match(/pg_blocking_pids/g) ?? []).toHaveLength(1);
  });
});

describe('longRunning', () => {
  it('returns the longest active queries above its floor', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, longRunning, { minSecs: 0 });
      if (!r.ok) throw new Error(r.message);
      expect(Array.isArray(r.data)).toBe(true);
    });
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project integration packages/checks/test/blocked.int.test.ts`
Expected: FAIL — `Cannot find module '../src/checks/blocked.js'`

- [ ] **Step 3: Write both checks**

`packages/checks/src/checks/blocked.ts`:

```ts
import type { Check, Verdict } from '../types.js';

export interface BlockedRow {
  blocked: string; longest_query_age_secs: string | null; suspect_pid: string | null;
}
export interface BlockedData {
  count: number;
  /**
   * A8: this is the age of the blocked session's QUERY, not the time it has
   * spent waiting. A query that ran productively for ten minutes and then
   * blocked five seconds ago reports ten minutes. pg_stat_activity exposes no
   * wait-start timestamp, so this is the only proxy available — the name says
   * what it actually measures rather than what we wish it did.
   */
  longestQueryAgeSecs: number | null;
  suspectPid: number | null;
}

/**
 * One pg_blocking_pids call per backend. The shipped version called it twice —
 * once in the WHERE and once in the aggregate — and the function takes exclusive
 * access to the lock manager's shared state for the duration.
 */
const SQL = `
WITH act AS MATERIALIZED (
  SELECT pid, query_start, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
)
SELECT count(*)::int AS blocked,
       max(EXTRACT(EPOCH FROM (now() - query_start)))::text AS longest_query_age_secs,
       (array_agg(blockers[1] ORDER BY now() - query_start DESC))[1]::text AS suspect_pid
FROM act WHERE cardinality(blockers) > 0`;

export const blocked: Check<BlockedRow, BlockedData> = {
  id: 'blocked',
  title: 'Blocked sessions',
  class: 'incident',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    return {
      count: Number(r?.blocked ?? 0),
      longestQueryAgeSecs: r?.longest_query_age_secs == null ? null : Number(r.longest_query_age_secs),
      suspectPid: r?.suspect_pid == null ? null : Number(r.suspect_pid),
    };
  },
  thresholds: [
    { level: 'warn', value: 1, unit: 'count',
      because: 'any blocked session is a query not completing' },
    { level: 'critical', value: 60, unit: 'seconds',
      because: 'past a minute the waiters have exceeded most application timeouts and '
             + 'are being retried, so the queue grows faster than it drains' },
  ],
  verdict: (d, t): Verdict => {
    if (d.count === 0) return { level: 'ok' };
    const crit = t.find((x) => x.level === 'critical')!;
    const level = (d.longestQueryAgeSecs ?? 0) >= crit.value ? 'critical' : 'warn';
    return { level, note: `${d.count} session(s) blocked` };
  },
};
```

`packages/checks/src/checks/long-running.ts`:

```ts
import type { Check, Verdict } from '../types.js';

export interface LongRunningRow { pid: number; running_secs: string; query: string | null }
export interface LongRunning { pid: number; runningSecs: number; query: string | null }
export interface LongRunningOpts { minSecs?: number; limit?: number }

/**
 * The floor is a parameter rather than a hardcoded 5 seconds: pgHero's
 * long_running_query_sec defaults to 60 (capability #9) and the shipped code's
 * 5 put ordinary reporting queries on the triage screen under a green check.
 */
const SQL = (o: LongRunningOpts) => ({
  text: `
    SELECT pid, EXTRACT(EPOCH FROM (now() - query_start))::text AS running_secs, query
    FROM pg_stat_activity
    WHERE state = 'active' AND backend_type = 'client backend'
      AND pid <> pg_backend_pid()
      AND now() - query_start > make_interval(secs => $1)
    ORDER BY query_start ASC
    LIMIT $2`,
  values: [o.minSecs ?? 60, o.limit ?? 10],
});

export const longRunning: Check<LongRunningRow, LongRunning[], LongRunningOpts> = {
  id: 'longRunning',
  title: 'Long-running queries',
  class: 'incident',
  sql: SQL,
  map: (rows) => rows.map((r) => ({
    pid: Number(r.pid), runningSecs: Number(r.running_secs), query: r.query,
  })),
  thresholds: [
    { level: 'warn', value: 60, unit: 'seconds',
      because: 'pgHero #9 uses 60s as the definition of long-running; matching it keeps '
             + 'the two tools comparable on the same database' },
    { level: 'critical', value: 300, unit: 'seconds',
      because: 'five minutes exceeds almost every application and proxy timeout, so the '
             + 'client is gone and the work is being redone elsewhere' },
  ],
  verdict: (d, t): Verdict => {
    const longest = d[0]?.runningSecs ?? 0;
    const crit = t.find((x) => x.level === 'critical')!;
    const warn = t.find((x) => x.level === 'warn')!;
    if (longest > crit.value) return { level: 'critical', note: `pid ${d[0]?.pid} running ${Math.round(longest)}s` };
    if (longest > warn.value) return { level: 'warn', note: `pid ${d[0]?.pid} running ${Math.round(longest)}s` };
    return { level: 'ok' };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project integration packages/checks/test/blocked.int.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add packages/checks/src/checks/blocked.ts packages/checks/src/checks/long-running.ts packages/checks/test/blocked.int.test.ts
git commit -m "feat(checks): blocked and long-running (A8)

The blocked field is named longestQueryAgeSecs because that is what it
measures — pg_stat_activity has no wait-start column and the old label claimed
one. long-running's floor becomes a parameter defaulting to pgHero's 60s; the
hardcoded 5s put ordinary reporting queries on the triage screen."
```

---

### Task 11: `queryStats` — sort key matches limit key (A4, A5)

**Files:**
- Create: `packages/checks/src/checks/query-stats.ts`
- Test: `packages/checks/test/query-stats.int.test.ts`

**Interfaces:**
- Consumes: `Check`
- Produces: `queryStats: Check<QueryStatRow, QueryStatsData, QueryStatsOpts>`, `QueryStatsOpts = { sort, limit }`

- [ ] **Step 1: Write the failing test**

`packages/checks/test/query-stats.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { queryStats } from '../src/checks/query-stats.js';
import { withPostgres } from './harness.js';

describe('queryStats', () => {
  it('sorts in SQL by the key it was asked for (A4)', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE TABLE t (id int)');
      for (let i = 0; i < 5; i++) await pool.query('INSERT INTO t VALUES ($1)', [i]);
      await pool.query('SELECT pg_sleep(0.2)');

      const byMean = await runCheck(ctx, queryStats, { sort: 'mean', limit: 20 });
      if (!byMean.ok) throw new Error(byMean.message);
      const means = byMean.data.rows.map((r) => r.meanMs);
      expect([...means].sort((a, b) => b - a)).toEqual(means);
    });
  }, 120_000);

  it('reports how many shapes it did not return (A4)', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, queryStats, { sort: 'total', limit: 2 });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.rows.length).toBeLessThanOrEqual(2);
      expect(r.data.totalShapes).toBeGreaterThanOrEqual(r.data.rows.length);
    });
  }, 120_000);

  it('counts only top-level statements (A5)', async () => {
    await withPostgres(async (ctx) => {
      const text = typeof queryStats.sql === 'string'
        ? queryStats.sql : queryStats.sql({ sort: 'total', limit: 1 }).text;
      expect(text).toContain('toplevel');
    });
  }, 120_000);

  it('names the extension as the remedy when it is absent', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('DROP EXTENSION pg_stat_statements');
      const r = await runCheck(ctx, queryStats, { sort: 'total', limit: 5 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('missing-extension');
        expect(r.remedy).toBe('CREATE EXTENSION pg_stat_statements;');
      }
    });
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project integration packages/checks/test/query-stats.int.test.ts`
Expected: FAIL — `Cannot find module '../src/checks/query-stats.js'`

- [ ] **Step 3: Write the check**

`packages/checks/src/checks/query-stats.ts`:

```ts
import type { Check } from '../types.js';

export type QuerySort = 'total' | 'mean' | 'calls';

export interface QueryStatsOpts { sort: QuerySort; limit?: number }

export interface QueryStatRow {
  queryid: string | null; query: string | null; calls: string;
  total_ms: string; mean_ms: string; stddev_ms: string; rows: string;
  shared_blks_hit: string; shared_blks_read: string; total_shapes: string;
}

export interface QueryStatRowData {
  queryid: string | null; query: string | null; calls: number;
  totalMs: number; meanMs: number; stddevMs: number; rows: number;
  cacheHitPct: number | null;
}

export interface QueryStatsData {
  rows: QueryStatRowData[];
  /** Every shape visible to this role. `rows.length` is a slice of it. */
  totalShapes: number;
  sort: QuerySort;
}

const ORDER: Record<QuerySort, string> = {
  total: 'total_exec_time DESC',
  mean: 'mean_exec_time DESC',
  calls: 'calls DESC',
};

/**
 * A4: the shipped query was always `ORDER BY total_exec_time DESC LIMIT 100`,
 * and the UI then re-sorted those 100 client-side. With pg_stat_statements.max
 * defaulting to 5000, "sort by mean" meant "the worst mean among the 100
 * highest-total" — the twice-daily four-minute report sits at rank 3000 by
 * total and was unreachable under every sort offered. The sort key and the
 * LIMIT key must be the same key.
 *
 * A5: `toplevel` (PG14+) separates a PL/pgSQL function from the statements it
 * runs. Without it, when track = all, total time sums past 100% of wall clock
 * and a function competes with its own internals.
 *
 * `total_shapes` rides along so the UI can say what it did not show. A silent
 * truncation reads as "this is everything".
 */
const SQL = (o: QueryStatsOpts) => ({
  text: `
    WITH visible AS (
      SELECT * FROM pg_stat_statements
      WHERE toplevel
        AND (userid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
             OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE'))
    )
    SELECT queryid::text, query, calls::text,
           total_exec_time::text  AS total_ms,
           mean_exec_time::text   AS mean_ms,
           stddev_exec_time::text AS stddev_ms,
           rows::text,
           shared_blks_hit::text, shared_blks_read::text,
           (SELECT count(*) FROM visible)::text AS total_shapes
    FROM visible
    ORDER BY ${ORDER[o.sort]}
    LIMIT $1`,
  values: [o.limit ?? 100],
});

export const queryStats: Check<QueryStatRow, QueryStatsData, QueryStatsOpts> = {
  id: 'queryStats',
  title: 'Query statistics',
  class: 'incident',
  sql: SQL,
  requires: [
    { kind: 'extension', name: 'pg_stat_statements' },
    { kind: 'version', min: 140000 },
  ],
  map: (rows) => ({
    totalShapes: Number(rows[0]?.total_shapes ?? 0),
    sort: 'total',
    rows: rows.map((r) => {
      const hit = Number(r.shared_blks_hit);
      const read = Number(r.shared_blks_read);
      return {
        queryid: r.queryid, query: r.query, calls: Number(r.calls),
        totalMs: Number(r.total_ms), meanMs: Number(r.mean_ms),
        stddevMs: Number(r.stddev_ms), rows: Number(r.rows),
        cacheHitPct: hit + read === 0 ? null : (100 * hit) / (hit + read),
      };
    }),
  }),
};
```

> **Note on `ORDER[o.sort]`:** this is the one place a value reaches SQL outside a
> bind parameter. It is safe because `ORDER` is a closed record keyed by the
> `QuerySort` union — no caller-supplied string ever reaches it. Do not widen
> `QuerySort` to `string`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project integration packages/checks/test/query-stats.int.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/checks/src/checks/query-stats.ts packages/checks/test/query-stats.int.test.ts
git commit -m "fix(checks): the sort key and the LIMIT key are the same key (A4, A5)

Sorting 100-rows-by-total client-side and labelling the column 'mean ms' made
a claim the query could not honour: with pg_stat_statements.max at 5000, the
worst-mean query is usually not in the top 100 by total. Sort in SQL, report
what was truncated, and filter toplevel so a function does not compete with
its own internals."
```

---

### Task 12: `slots` — active slots and standbys (A6)

**Files:**
- Create: `packages/checks/src/checks/slots.ts`
- Test: `packages/checks/test/slots.int.test.ts`

**Interfaces:**
- Consumes: `Check`
- Produces: `slots: Check<SlotRow, SlotsData>`

- [ ] **Step 1: Write the failing test**

`packages/checks/test/slots.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { slots } from '../src/checks/slots.js';
import { withPostgres } from './harness.js';

describe('slots', () => {
  it('measures retained WAL for ACTIVE slots too (A6)', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query("SELECT pg_create_physical_replication_slot('s_active')");
      try {
        const r = await runCheck(ctx, slots);
        if (!r.ok) throw new Error(r.message);
        const slot = r.data.slots.find((s) => s.name === 's_active');
        expect(slot).toBeDefined();
        // The shipped query filtered retained bytes to inactive slots only, so a
        // connected-but-stalled logical consumer reported 0 while filling the disk.
        expect(slot!.retainedBytes).not.toBeNull();
      } finally {
        await pool.query("SELECT pg_drop_replication_slot('s_active')");
      }
    });
  }, 120_000);

  it('uses a recovery-safe LSN function so it survives a standby (A6)', () => {
    const text = typeof slots.sql === 'string' ? slots.sql : slots.sql(undefined as never).text;
    expect(text).toContain('pg_is_in_recovery()');
    expect(text).toContain('pg_last_wal_receive_lsn()');
  });

  it('escalates on retained bytes at the documented boundary', () => {
    const t = slots.thresholds!;
    const crit = t.find((x) => x.level === 'critical')!.value;
    const at = (bytes: number) => slots.verdict!(
      { slots: [{ name: 's', database: 'd', active: false, slotType: 'physical', retainedBytes: bytes }] },
      t,
    ).level;
    expect(at(crit - 1)).not.toBe('critical');
    expect(at(crit)).toBe('critical');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project integration packages/checks/test/slots.int.test.ts`
Expected: FAIL — `Cannot find module '../src/checks/slots.js'`

- [ ] **Step 3: Write the check**

`packages/checks/src/checks/slots.ts`:

```ts
import type { Check, Verdict } from '../types.js';

const GB = 1024 ** 3;

export interface SlotRow {
  slot_name: string; database: string | null; active: boolean;
  slot_type: string; retained_bytes: string | null;
}

export interface Slot {
  name: string; database: string | null; active: boolean;
  slotType: string; retainedBytes: number | null;
}

export interface SlotsData { slots: Slot[] }

/**
 * A6, two defects:
 *
 *  1. Retained bytes were computed under FILTER (WHERE NOT active). An ACTIVE
 *     slot whose consumer is connected but not advancing — the ordinary logical
 *     replication stall — retained unbounded WAL and reported 0. That is the
 *     failure that fills a primary's disk, and it was invisible.
 *  2. pg_current_wal_lsn() raises "recovery is in progress" on a standby, so
 *     the whole check degraded to n/a on every replica. Branch on
 *     pg_is_in_recovery() and use pg_last_wal_receive_lsn() there.
 */
const SQL = `
SELECT slot_name, database, active, slot_type,
       pg_wal_lsn_diff(
         CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn()
              ELSE pg_current_wal_lsn() END,
         restart_lsn)::text AS retained_bytes
FROM pg_replication_slots
ORDER BY 5 DESC NULLS LAST`;

export const slots: Check<SlotRow, SlotsData> = {
  id: 'slots',
  title: 'Replication slots',
  class: 'incident',
  sql: SQL,
  map: (rows) => ({
    slots: rows.map((r) => ({
      name: r.slot_name, database: r.database, active: r.active,
      slotType: r.slot_type,
      retainedBytes: r.retained_bytes == null ? null : Number(r.retained_bytes),
    })),
  }),
  thresholds: [
    { level: 'warn', value: 1 * GB, unit: 'bytes',
      because: 'a gigabyte of retained WAL means a consumer has been behind long enough '
             + 'that it is not going to catch up on its own' },
    { level: 'critical', value: 20 * GB, unit: 'bytes',
      because: 'twenty gigabytes is a meaningful fraction of a typical primary volume, '
             + 'and a full pg_wal takes the whole instance down, not just replication' },
  ],
  verdict: (d, t): Verdict => {
    const worst = d.slots.reduce<Slot | undefined>(
      (w, s) => ((s.retainedBytes ?? 0) > (w?.retainedBytes ?? 0) ? s : w), undefined);
    if (!worst || worst.retainedBytes == null) return { level: 'ok' };
    const crit = t.find((x) => x.level === 'critical')!;
    const warn = t.find((x) => x.level === 'warn')!;
    const gb = (worst.retainedBytes / GB).toFixed(1);
    const note = `slot '${worst.name}'${worst.active ? '' : ' (inactive)'} retaining ${gb} GB`;
    if (worst.retainedBytes >= crit.value) return { level: 'critical', note };
    if (worst.retainedBytes >= warn.value) return { level: 'warn', note };
    return { level: 'ok' };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project integration packages/checks/test/slots.int.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add packages/checks/src/checks/slots.ts packages/checks/test/slots.int.test.ts
git commit -m "fix(checks): slots covers active slots and standbys (A6)

Filtering retained WAL to inactive slots hid the common failure — a logical
consumer connected but not advancing, filling the primary's disk while the
check read 0. And pg_current_wal_lsn() errors in recovery, so the card was
blank on every replica."
```

---

### Task 13: The `kill` action

**Files:**
- Create: `packages/checks/src/actions/kill.ts`, `packages/checks/src/actions/audit.ts`
- Test: `packages/checks/test/kill.int.test.ts`

**Interfaces:**
- Consumes: `CheckContext`
- Produces: `killBackend(ctx, target, meta): Promise<KillOutcome>`, `KillOutcome = 'terminated' | 'session-changed' | 'gone'`, `writeAudit(record)`

- [ ] **Step 1: Write the failing test**

`packages/checks/test/kill.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { killBackend } from '../src/actions/kill.js';
import { withPostgres } from './harness.js';

describe('killBackend', () => {
  it('terminates a session whose identity still matches', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      const victim = new pg.Client({ connectionString: uri, application_name: 'victim' });
      victim.on('error', () => {});
      await victim.connect();
      const { rows } = await victim.query<{ pid: number; bs: string }>(
        'SELECT pg_backend_pid() AS pid, backend_start::text AS bs FROM pg_stat_activity WHERE pid = pg_backend_pid()',
      );
      const out = await killBackend(ctx,
        { pid: rows[0]!.pid, backendStart: rows[0]!.bs },
        { subcommand: 'sessions', reason: 'test' });
      expect(out).toBe('terminated');
      await victim.end().catch(() => {});
    });
  }, 120_000);

  it('refuses when the pid has been reused by a different session', async () => {
    await withPostgres(async (ctx, pool) => {
      const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const out = await killBackend(ctx,
        { pid: rows[0]!.pid, backendStart: '1999-01-01T00:00:00Z' },
        { subcommand: 'sessions', reason: 'test' });
      expect(out).toBe('session-changed');
    });
  }, 120_000);

  it('reports gone for a pid that is not present', async () => {
    await withPostgres(async (ctx) => {
      const out = await killBackend(ctx,
        { pid: 999_999, backendStart: '2026-01-01T00:00:00Z' },
        { subcommand: 'sessions', reason: 'test' });
      expect(out).toBe('gone');
    });
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project integration packages/checks/test/kill.int.test.ts`
Expected: FAIL — `Cannot find module '../src/actions/kill.js'`

- [ ] **Step 3: Write the action**

Port `src/core/kill.ts` and `src/core/audit.ts` into
`packages/checks/src/actions/`, with three changes:

1. `killBackend` takes `ctx: CheckContext` as its first parameter and queries
   `ctx.target` — no module-global pool.
2. `writeAudit` writes one JSON line to **stdout** as well as to
   `PGOPS_AUDIT_LOG` (default `~/.pgops/audit.log`). In a container the log file
   is not durable; stdout is the convention every log shipper already reads.
3. `redactSecrets` is imported from `../redact.js`.

The SQL is copied **verbatim** — it is correct:

```ts
/**
 * The comparison and the side effect are ONE statement against ONE snapshot.
 * Check-then-act in the client reopens a TOCTOU window: the session can end and
 * the pid be recycled between the read and the terminate. The three-valued
 * return distinguishes terminated / refused / already-gone, which a boolean
 * cannot.
 */
const KILL_SQL = `
SELECT CASE WHEN backend_start = $2::timestamptz
            THEN pg_terminate_backend(pid)
            ELSE NULL END AS terminated
FROM pg_stat_activity
WHERE pid = $1`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project integration packages/checks/test/kill.int.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add packages/checks/src/actions packages/checks/test/kill.int.test.ts
git commit -m "feat(checks): port the guarded kill and the audit log

SQL unchanged — it is correct. The pool comes from CheckContext instead of a
module global, and audit records also go to stdout, because in a container the
log file is not durable and stdout is what every shipper already reads."
```

---

### Task 14: Wire the registry and prove the wall holds

**Files:**
- Modify: `packages/checks/src/registry.ts` (imports now resolve)
- Test: `packages/checks/test/boundaries.test.ts`

**Interfaces:**
- Consumes: every check from Tasks 6–12
- Produces: a green `CHECKS` map with nine entries

- [ ] **Step 1: Write the failing test**

`packages/checks/test/boundaries.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src/registry.js';

const SRC = new URL('../src/', import.meta.url).pathname;

function allSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allSourceFiles(join(dir, e.name))
                    : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
}

describe('the package boundary', () => {
  it('declares exactly one runtime dependency', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.dependencies)).toEqual(['pg']);
  });

  it('imports nothing but node builtins and pg', () => {
    const bad: string[] = [];
    for (const file of allSourceFiles(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        const spec = m[1]!;
        if (spec.startsWith('.') || spec.startsWith('node:') || spec === 'pg') continue;
        bad.push(`${file}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('holds no module-level mutable state', () => {
    const bad: string[] = [];
    for (const file of allSourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const line of src.split('\n')) {
        if (/^let |^var /.test(line)) bad.push(`${file}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives every threshold a justification', () => {
    for (const [id, check] of Object.entries(CHECKS)) {
      for (const t of check.thresholds ?? []) {
        expect(t.because.length, `${id}/${t.level}`).toBeGreaterThan(20);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/checks/test/boundaries.test.ts`
Expected: FAIL — `dependencies` assertion fails if `@types/pg` leaked into
`dependencies`, or the import scan finds a stray specifier

- [ ] **Step 3: Fix whatever the test found**

Move any non-`pg` runtime import to `devDependencies` or delete it. If the
module-state test fires, convert the `let` to a parameter — see the
`CheckContext` rationale in Task 1.

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run test:int`
Expected: unit PASS, integration PASS on the default PG image

- [ ] **Step 5: Verify the wall is real, not just asserted**

```bash
cd packages/checks && node -e "import('react').then(()=>console.log('LEAK'),()=>console.log('ok: react unresolvable'))"
```

Expected: `ok: react unresolvable`

- [ ] **Step 6: Commit**

```bash
git add packages/checks
git commit -m "test(checks): assert the dependency wall, not just intend it

package.json dependencies is the only boundary JavaScript actually enforces.
These tests fail if a framework import, a stray runtime dependency, or a
module-level 'let' gets in — the three ways this package stops being reusable
by a CLI and a web app at the same time."
```

---

## Self-Review

**Spec coverage.** Every §3 element of the design spec has a task: the check
model and `runCheck` (Task 1), thresholds-as-data (Task 1, asserted in Task 14),
the result envelope with machine-readable reasons (Task 1), `CheckContext` with
two pools (Task 1), the registry and parity with three states (Task 4),
redaction (Task 5), and all nine P0 checks with corrections A1–A11 (Tasks 6–12).
§9's testing table is covered for everything P0 builds: real-Postgres per check,
boundary tests per threshold, the version matrix, and the parity assertions.
`store`, `series`, capture, delta maths, the Next app, auth, and deployment are
**deliberately out of scope** — they are P1–P4 and get their own plans.

**Gaps deliberately left.** §9's "capture is non-destructive", "delta maths",
"runtime env", "action gating", and "web smoke" rows have no P0 task because
they test code P0 does not build. They belong to the P3 and P1 plans
respectively.

**Type consistency.** `CheckContext`, `CheckResult`, `Check`, `Threshold`,
`Verdict` are defined once in Task 1 and referenced unchanged thereafter.
`isIdleInTransaction` is defined in Task 9 and is the only definition. `LockRow`
is defined in Task 8 and used by both its unit and integration tests.
`buildChains` returns `RootBlocker[]` in both. Check `id` strings match their
`CHECKS` keys, and `CHECKS` keys match every `check:` value in `PGHERO`.

**Known follow-up, not a placeholder.** Task 4 Step 3 shows fourteen of the
sixty parity entries inline and Step 4 is the procedure for the rest, deliberately
— transcribing all sixty from a stale audit would bake in the staleness. The
re-audit against current pgHero source is a required step, not an optional one,
and the registry test fails until all sixty are present.
