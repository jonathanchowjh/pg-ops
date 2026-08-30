# P1b — The Console Ships: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the rendering console into a deployable product: a mounted-file config form, HTTP basic auth, `kill` behind `PGOPS_ALLOW_ACTIONS`, a non-root Docker image, a CI proof that runtime configuration beats build-time configuration, and the deletion of the Ink TUI.

**Architecture:** Everything new is a pure function in `apps/web/lib/` with a thin adapter on top — a middleware, a route handler, a client component. That is the shape P1a already established (`nextTick`/`onTick` under `components/refresh.tsx`; `readDatabases` under `lib/pools.ts`) and it is what makes auth and the action gate testable without a browser or a server. The one destructive surface, `kill`, reuses `killBackend` unchanged — its single-statement PID-reuse guard is already proven against a real cluster.

**Tech Stack:** Next 16.3.3, React 19, TypeScript 5.7, `@pgops/checks` (workspace), Vitest 4, Testcontainers, Docker (multi-stage on `output: 'standalone'`).

**Spec:** `docs/superpowers/specs/2026-08-26-pgops-web-design.md` — §7.1 (the action ladder), §7.2 (auth), §8 (configuration and deployment), §9 (the "Runtime env" and "Action gating" test rows), §10 (P1: *"The Ink TUI, `src/ui/`, and the Ink/React-terminal dependencies are deleted here"*). The spec is the binding authority; this plan argues from it.

**Prior art in this repo, both binding:**
- `docs/superpowers/reviews/2026-08-27-p0-decision-record.md` — 64 rulings behind `packages/checks`. Ruling 38 (the non-client-backend kill guard) and Ruling 49 (the package's declaration is its contract) are quoted where they apply.
- `docs/superpowers/reviews/2026-08-27-p1a-decision-record.md` — 39 rulings behind `apps/web`.

## Global Constraints

- **Node floor is 22.** PostgreSQL floor is 14; CI matrix is 14, 16, 17, 18.
- **Every check-rendering path calls `await connection()` from `next/server` before reading configuration.** Unchanged from P1a, and it now binds the new **route handler** too. A statically prerendered route evaluates `process.env` **in the build process** and freezes the result into HTML — Turbopack does not textually inline server-side env, so the mechanism is prerender-time evaluation, not substitution. Task 6 is the end-to-end proof against a real image.
- **`redactSecrets` runs on every rendered query string.** Unchanged. The kill route's audit record passes through `writeAudit`, which already redacts.
- **Actions are off by default.** With `PGOPS_ALLOW_ACTIONS` unset, tier ≥ 1 routes return **404, not 403** — spec §7.1: *"the routes do not exist"*. Asserted against the route, not the UI.
- **No new runtime dependency in `apps/web`.** No dialog library, no auth library, no `bcrypt`. Everything here is Web Crypto, `node:fs`, and plain React. The shadcn Badge incident in P1a (a vendored component that dragged in `@base-ui/react`) is the precedent.
- **`packages/checks` gains exactly one field this phase** — `KillMeta.actor`, Task 3 — and its `dependencies` stay exactly `["pg"]`. Any other change to that package is a finding to report, not a task to do.
- **No websockets, no chart library, no internal HTTP layer for reads.** Pages still call `runCheck` directly. The kill route exists because a browser is outside the process; nothing else earns one.
- Existing repo conventions: 2-space indent, ESM. `packages/` uses `.js` import specifiers; **`apps/web` does not** — its tsconfig sets `moduleResolution: "bundler"`, under which Next's resolver will not map `./x.js` onto a sibling `x.tsx`. Comments explain *why* and cite the defect they prevent.

## Three verified facts this plan is built on

Each was checked against source in this repo, not recalled.

**1. `HOSTNAME` is overloaded, and Docker already sets it.**
`apps/web/node_modules/next/dist/build/utils.js:1125` — the standalone `server.js` template Next generates reads `const hostname = process.env.HOSTNAME || '0.0.0.0'`. `packages/checks/src/actions/audit.ts`'s `currentActor()` reads `${user}@${process.env.HOSTNAME || hostname()}` for the audit record's `user` field. Docker sets `HOSTNAME` to the container ID unless told otherwise, and every published Next Dockerfile pins it to `0.0.0.0` so the server binds on all interfaces. Both readers are correct in isolation; together they mean **every audit record written from a container names neither the operator nor a resolvable host** — `node@0.0.0.0`, or `node@a3f19c2b81d4`. Task 3 closes this by having the web path always pass an explicit actor; Task 5 sets `HOSTNAME=0.0.0.0` knowing it does so.

**2. `backendStart` is already on the wire.**
`packages/checks/src/checks/sessions.ts:33` exposes `backendStart: string | null` on every `Session`, cast `::text` at line 110. The sessions page renders those rows today. So the kill guard's identity snapshot needs no new query and no new plumbing — the value the operator is looking at *is* the value the guard checks.

**3. The harness cannot vary the server's environment.**
`apps/web/test/harness.ts`'s `withConsole` hardcodes `PGOPS_DATABASES` and passes no other configuration. Auth (Task 2) and the action gate (Task 3) both need a server started with extra environment, so Task 2 adds an optional second parameter to `withConsole`. This is noted here rather than discovered twice.

## File Structure

```
apps/web/
  middleware.ts              NEW. Thin adapter over lib/auth.ts. Strips the actor
                             header from every inbound request, then authorizes.
  Dockerfile                 NEW. Multi-stage, standalone, non-root.
  .dockerignore              NEW.
  next.config.ts             MODIFY. Add outputFileTracingRoot (monorepo standalone).
  lib/
    auth.ts                  NEW. authorize(env, header) -> AuthResult. Pure.
    actions.ts               NEW. actionsAllowed(env) -> boolean. Pure.
    config.ts                MODIFY. PGOPS_CONFIG_FILE branch; error messages name
                             the source variable rather than always PGOPS_DATABASES.
  app/api/db/[name]/kill/
    route.ts                 NEW. POST. 404 when actions are disallowed.
  components/
    kill-button.tsx          NEW. Client. Two-step confirm, no dialog library.
  app/db/[name]/sessions/
    page.tsx                 MODIFY. Renders KillButton only when actions are allowed.
  test/
    harness.ts               MODIFY. withConsole(fn, extraEnv?).
    auth.test.ts             NEW.
    actions.test.ts          NEW.
    config.test.ts           MODIFY. PGOPS_CONFIG_FILE cases.
    kill-button.test.tsx     NEW.
    auth.int.test.ts         NEW. 401/200 against the running server.
    actions.int.test.ts      NEW. 404 gate, real kill, stale-identity refusal.
    guards.test.ts           MODIFY. Guard that the kill route is the only
                             importer of killBackend in apps/web.

packages/checks/
  src/actions/kill.ts        MODIFY. KillMeta gains optional `actor`.
  test/kill.test.ts          MODIFY. Two cases for it.

.github/workflows/ci.yml     MODIFY. New `image` job (Task 6). Root typecheck step
                             removed in Task 7.

DELETED IN TASK 7
  src/                       The Ink TUI — 90 files, 45 of them tests.
  tsconfig.json              Root tsc project; it only ever included src/**.
  package.json               bin, files, ink/react-18 deps, dev/build/start scripts.
  README.md                  REWRITTEN, not deleted.
```

---

### Task 1: `PGOPS_CONFIG_FILE` — the mounted-file form of the same JSON

Spec §8: *"`PGOPS_CONFIG_FILE` points at the same JSON on disk for deployments that prefer a mounted file."* A Kubernetes ConfigMap or a Docker secret is a file, not an environment variable, and a connection string in an environment variable is visible to anything that can read `/proc/<pid>/environ` or run `docker inspect`.

**Files:**
- Modify: `apps/web/lib/config.ts`
- Test: `apps/web/test/config.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `readDatabases(env)` keeps its exact signature — synchronous, one argument, returns `DatabaseConfig[]`, throws `ConfigError`. `lib/pools.ts` calls it on every request and must not need a change.

**Rulings carried into this task, decided rather than left to the implementer:**

1. **Precedence is `PGOPS_CONFIG_FILE` > `PGOPS_DATABASES` > `DATABASE_URL`.** A mounted file is the most deliberate of the three acts; an operator who mounts one and also has a stale `DATABASE_URL` in the environment means the file. *Cost if wrong:* a deployment that set both reaches the file's databases instead of the variable's — visible immediately on the overview page, which lists them by name.
2. **The read is synchronous (`readFileSync`), on every request.** Making it async would push `await` through `configured()`, `databaseNames()`, and every Server Component that calls them, to save a sub-millisecond read of a local file that the OS page cache holds. *Cost if wrong:* a config file on a slow network mount blocks the event loop per request. The file is expected to be a local mounted ConfigMap; if that assumption ever breaks, the fix is caching, not async.
3. **No injected reader for testability.** The tests write a real temp file with `mkdtemp`. A `readFile = readFileSync` parameter would be a seam nothing but a test uses, and this repo's style rules forbid dependency-injection plumbing.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/config.test.ts`. Note the imports at the top of the file may need extending:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function configFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'pgops-config-')), 'databases.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('PGOPS_CONFIG_FILE', () => {
  it('reads the same JSON array from a file on disk', () => {
    const path = configFile('[{"name":"prod","url":"postgres://h/prod"}]');
    expect(readDatabases({ PGOPS_CONFIG_FILE: path })).toEqual([
      { name: 'prod', url: 'postgres://h/prod' },
    ]);
  });

  it('wins over PGOPS_DATABASES and DATABASE_URL', () => {
    const path = configFile('[{"name":"fromfile","url":"postgres://h/f"}]');
    const dbs = readDatabases({
      PGOPS_CONFIG_FILE: path,
      PGOPS_DATABASES: '[{"name":"fromenv","url":"postgres://h/e"}]',
      DATABASE_URL: 'postgres://h/one',
    });
    expect(dbs.map((d) => d.name)).toEqual(['fromfile']);
  });

  it('names the file, not the variable, when the file is unreadable', () => {
    const path = join(tmpdir(), 'pgops-does-not-exist', 'databases.json');
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).toThrow(ConfigError);
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).toThrow(path);
  });

  /**
   * The discriminating test for the `source` parameter, and the reason it
   * exists at all. Every validation message in this file used to hardcode
   * "PGOPS_DATABASES". Reached through a file, each one then pointed an
   * operator at an environment variable they had not set, to explain a typo
   * in a file they had — the single worst thing a configuration error can do.
   * Reverting `source` and hardcoding the string back reddens exactly this
   * test and leaves the others green.
   */
  it('names PGOPS_CONFIG_FILE in validation messages reached through the file', () => {
    const path = configFile('[{"name":"bad name","url":"postgres://h/p"}]');
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).toThrow(/PGOPS_CONFIG_FILE/);
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).not.toThrow(/PGOPS_DATABASES/);
  });

  it('still names PGOPS_DATABASES when reached through the variable', () => {
    expect(() => readDatabases({ PGOPS_DATABASES: '[{"name":"bad name","url":"u"}]' }))
      .toThrow(/PGOPS_DATABASES/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:web -- config`
Expected: FAIL — the first case returns nothing useful because `PGOPS_CONFIG_FILE` is not read at all; the last two fail on the message text.

- [ ] **Step 3: Implement**

In `apps/web/lib/config.ts`, add the import and the file branch, and thread a `source` label through `parseMany` and its messages:

```ts
import { readFileSync } from 'node:fs';
```

```ts
export function readDatabases(env: Record<string, string | undefined>): DatabaseConfig[] {
  // Precedence: a mounted file is the most deliberate of the three acts, and
  // it is also the only one that keeps connection strings out of the process
  // environment (visible to `docker inspect` and to anything that can read
  // /proc/<pid>/environ). See the plan's Ruling 1 for this task.
  const file = env.PGOPS_CONFIG_FILE;
  if (file) return parseMany(readConfigFile(file), `PGOPS_CONFIG_FILE (${file})`);

  const many = env.PGOPS_DATABASES;
  if (many) return parseMany(many, 'PGOPS_DATABASES');

  const one = env.DATABASE_URL;
  if (one) return [{ name: 'default', url: one }];

  throw new ConfigError(
    'No database configured. Set DATABASE_URL for one database, PGOPS_DATABASES ' +
    'to a JSON array of {name, url} for several, or PGOPS_CONFIG_FILE to a file ' +
    'holding that same array.',
  );
}

/**
 * Read synchronously, on every request, deliberately — see the plan's Ruling 2.
 * `readDatabases` is called from `contextFor` on the render path of every page;
 * making it async would push `await` through `databaseNames()` and every Server
 * Component that lists databases, to save a page-cached read of a local file.
 *
 * The error names the PATH, not just the variable. An operator debugging a
 * Kubernetes deployment needs to know pgops looked at
 * /etc/pgops/databases.json and found nothing — "PGOPS_CONFIG_FILE could not
 * be read" sends them to check the variable, which is set correctly.
 */
function readConfigFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `PGOPS_CONFIG_FILE points at ${path}, which could not be read: ${(err as Error).message}`,
    );
  }
}
```

Then change `parseMany`'s signature to `function parseMany(raw: string, source: string): DatabaseConfig[]` and replace every literal `PGOPS_DATABASES` inside it with `${source}`. There are five such messages: not-valid-JSON, must-be-a-non-empty-array, `[i]` is not an object, `[i].name`, `[i].url`, and the duplicate-name message. Read the file and change all of them — a missed one is exactly the defect the fourth test above catches.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:web -- config`
Expected: PASS, including the pre-existing cases — `readDatabases`'s signature and behaviour for the two existing forms are unchanged.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run --workspace @pgops/web typecheck
git add apps/web/lib/config.ts apps/web/test/config.test.ts
git commit -m "feat(web): read databases from a mounted file, and name the source in errors"
```

---

### Task 2: HTTP basic auth

Spec §7.2: *"`PGOPS_USERNAME` / `PGOPS_PASSWORD` → HTTP basic via middleware, matching pgHero's shape."*

**Files:**
- Create: `apps/web/lib/auth.ts`, `apps/web/middleware.ts`, `apps/web/test/auth.test.ts`, `apps/web/test/auth.int.test.ts`
- Modify: `apps/web/test/harness.ts`

**Interfaces:**
- Produces, and Tasks 3 and 4 consume:
  - `export const ACTOR_HEADER = 'x-pgops-user'` from `lib/auth.ts`.
  - `export type AuthResult = { ok: true; user: string | null } | { ok: false; status: 401 | 503; message: string }`
  - `export function authorize(env: Record<string, string | undefined>, authorization: string | null): AuthResult`
  - `export async function withConsole(fn: (c: Console) => Promise<void>, extraEnv?: Record<string, string>): Promise<void>` — the harness gains an optional second parameter.

**Rulings carried into this task:**

1. **The logic is a pure function in `lib/auth.ts`; `middleware.ts` is the adapter.** Middleware needs a `NextRequest` and a running Next runtime to invoke, which makes it awkward to test and impossible to test exhaustively. Every branch that matters — scheme parsing, a password containing a colon, half-configured auth — is a table test against `authorize`. This mirrors `components/refresh.tsx`, where `nextTick`/`onTick` carry the logic and the component carries the wiring. *Cost if wrong:* none identified; this is the repo's established shape.
2. **No `node:crypto`.** Middleware's runtime is not guaranteed to be Node, and a `runtime: 'nodejs'` declaration is a Next-version-dependent flag this plan will not bet on. The constant-time compare below is eleven lines of arithmetic over char codes and works in both runtimes. *Cost if wrong:* none — `timingSafeEqual` would not be more correct here, only more idiomatic.
3. **Both comparisons always run.** `safeEqual(u) && safeEqual(p)` short-circuits, which leaks through timing *which* half was wrong — turning one unknown-pair problem into two independent known-length problems. Compute both, then combine. *Cost if wrong:* an attacker who can measure response times learns the username separately from the password. Small, but free to avoid.
4. **Setting exactly one of the two variables is a 503, not a 401 and not open access.** An operator who set `PGOPS_USERNAME` and forgot `PGOPS_PASSWORD` has expressed the intent to require auth. Serving the console openly because the configuration was incomplete is the failure mode that matters; a 401 would be worse still, since it invites password guesses against something that can never match. A 503 whose body names the missing variable is loud, unambiguous, and fixable in one `docker run` flag. *Cost if wrong:* a deployment that half-configured auth is down rather than exposed. That is the correct direction for a console with a kill button.
5. **Middleware deletes `x-pgops-user` from every inbound request before doing anything else.** Task 3 audits kills against that header. Without the strip, any client can set it and choose the name that appears in the audit log — forging the record of a destructive action in the log that exists to attribute destructive actions. The delete happens on the unauthenticated path too, so it holds whether or not auth is configured. *Cost if wrong:* the audit log becomes attacker-controlled. This is the one line in the task that must not be lost.

- [ ] **Step 1: Write the failing unit tests**

Create `apps/web/test/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ACTOR_HEADER, authorize } from '@/lib/auth';

const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;
const CONFIGURED = { PGOPS_USERNAME: 'alice', PGOPS_PASSWORD: 'hunter2' };

describe('authorize', () => {
  it('allows everything, with no actor, when neither variable is set', () => {
    expect(authorize({}, null)).toEqual({ ok: true, user: null });
  });

  it('rejects a request with no Authorization header when auth is configured', () => {
    expect(authorize(CONFIGURED, null)).toMatchObject({ ok: false, status: 401 });
  });

  it('accepts the configured pair and reports the username as the actor', () => {
    expect(authorize(CONFIGURED, basic('alice', 'hunter2'))).toEqual({ ok: true, user: 'alice' });
  });

  it('rejects the right username with the wrong password', () => {
    expect(authorize(CONFIGURED, basic('alice', 'hunter3'))).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects the wrong username with the right password', () => {
    expect(authorize(CONFIGURED, basic('bob', 'hunter2'))).toMatchObject({ ok: false, status: 401 });
  });

  /**
   * RFC 7617: the credentials are `user-id ":" password`, and only the FIRST
   * colon separates them — a password may contain any of them. Splitting on
   * every colon locks out anyone whose password contains one, which is a
   * large fraction of generated passwords, and does it with a 401 that reads
   * as "wrong password".
   */
  it('accepts a password containing colons', () => {
    const env = { PGOPS_USERNAME: 'alice', PGOPS_PASSWORD: 'a:b:c' };
    expect(authorize(env, basic('alice', 'a:b:c'))).toEqual({ ok: true, user: 'alice' });
  });

  it('rejects a non-Basic scheme', () => {
    expect(authorize(CONFIGURED, 'Bearer abcdef')).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects credentials that are not valid base64', () => {
    expect(authorize(CONFIGURED, 'Basic !!!not-base64!!!')).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects credentials with no colon at all', () => {
    expect(authorize(CONFIGURED, `Basic ${btoa('alice')}`)).toMatchObject({ ok: false, status: 401 });
  });

  /**
   * Ruling 4. The dangerous default is serving openly because the operator
   * set half the pair; the second-most dangerous is a 401 nobody can ever
   * satisfy. 503, naming the variable that is missing.
   */
  it('fails closed with 503 when only the username is set', () => {
    const r = authorize({ PGOPS_USERNAME: 'alice' }, basic('alice', 'anything'));
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(r.ok === false && r.message).toContain('PGOPS_PASSWORD');
  });

  it('fails closed with 503 when only the password is set', () => {
    const r = authorize({ PGOPS_PASSWORD: 'hunter2' }, null);
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(r.ok === false && r.message).toContain('PGOPS_USERNAME');
  });

  it('names the actor header once, so middleware and the kill route agree', () => {
    expect(ACTOR_HEADER).toBe('x-pgops-user');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:web -- auth`
Expected: FAIL — `@/lib/auth` does not exist.

- [ ] **Step 3: Implement `apps/web/lib/auth.ts`**

```ts
/**
 * HTTP basic auth, spec §7.2. pgHero's shape: two environment variables, a
 * 401 with a WWW-Authenticate challenge, and documentation that says plainly
 * this is the floor and a reverse proxy (OAuth2 Proxy, ALB auth, IAP) is the
 * answer for anything real.
 *
 * The logic lives here, as a pure function of (env, header), rather than in
 * middleware.ts: middleware needs a NextRequest and a running Next runtime to
 * invoke, so every interesting branch — a password containing a colon,
 * half-configured auth, a malformed scheme — would otherwise be reachable
 * only through an integration test that boots a server. Same split as
 * components/refresh.tsx, where nextTick/onTick hold the logic.
 */

/**
 * The header middleware sets, after successful authentication, so the kill
 * route can name the human in the audit record. Exported so exactly one
 * string exists: a middleware and a route that disagreed about its spelling
 * would silently audit every kill as anonymous.
 */
export const ACTOR_HEADER = 'x-pgops-user';

export type AuthResult =
  | { ok: true; user: string | null }
  | { ok: false; status: 401 | 503; message: string };

/**
 * Constant-time string comparison, without node:crypto — middleware's runtime
 * is not guaranteed to be Node, and `timingSafeEqual` is not available in the
 * Edge runtime.
 *
 * `charCodeAt` past the end of a string returns NaN, and `NaN | 0` is 0, so
 * two out-of-range positions compare equal to each other. That is why the
 * length difference is folded in FIRST and separately: without it, "ab" and
 * "ab\0\0" would compare equal. The loop always runs to the longer of the two
 * lengths, so the time taken depends on the lengths (which basic auth leaks
 * anyway, in the base64 blob's size) and never on where the first difference
 * falls.
 */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/**
 * RFC 7617. `atob` rather than Buffer: available in both the Node and Edge
 * runtimes. Only the FIRST colon separates user from password — a password
 * containing colons is legal and common, and splitting on every colon locks
 * those operators out with a 401 that reads as "wrong password".
 */
function decodeBasic(header: string): { user: string; pass: string } | null {
  const space = header.indexOf(' ');
  if (space < 0) return null;
  if (header.slice(0, space).toLowerCase() !== 'basic') return null;
  const encoded = header.slice(space + 1).trim();
  if (!encoded) return null;

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

export function authorize(
  env: Record<string, string | undefined>,
  authorization: string | null,
): AuthResult {
  const user = env.PGOPS_USERNAME;
  const pass = env.PGOPS_PASSWORD;

  // Half-configured is a hard failure, not an open door — see the plan's
  // Ruling 4. An operator who set one of these meant to require auth; serving
  // the console (with its kill button) openly because they missed the other
  // is the failure that matters. 503 rather than 401: a 401 invites password
  // guesses against a pair that can never match.
  if (Boolean(user) !== Boolean(pass)) {
    const missing = user ? 'PGOPS_PASSWORD' : 'PGOPS_USERNAME';
    return {
      ok: false,
      status: 503,
      message:
        `pgops is misconfigured: ${missing} is not set, but its counterpart is. ` +
        'Set both to require authentication, or neither to run without it.',
    };
  }

  if (!user || !pass) return { ok: true, user: null };

  const supplied = authorization ? decodeBasic(authorization) : null;
  if (!supplied) return { ok: false, status: 401, message: 'Authentication required.' };

  // Both comparisons run unconditionally. `&&` would short-circuit on a wrong
  // username and never touch the password, which leaks through response
  // timing which HALF was wrong — see the plan's Ruling 3.
  const userOk = safeEqual(supplied.user, user);
  const passOk = safeEqual(supplied.pass, pass);
  if (!(userOk && passOk)) return { ok: false, status: 401, message: 'Authentication required.' };

  return { ok: true, user: supplied.user };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:web -- auth`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the middleware**

Create `apps/web/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { ACTOR_HEADER, authorize } from '@/lib/auth';

/**
 * The adapter over lib/auth.ts. Everything decidable lives there; this file
 * turns an AuthResult into a Response and does the one thing a pure function
 * cannot: rewrite the request headers seen downstream.
 */
export function middleware(req: NextRequest) {
  // FIRST, unconditionally, before any decision: strip any client-supplied
  // actor header. The kill route audits against this header, so a client that
  // could set it would choose the name recorded against a terminated backend
  // — forging entries in the log that exists to attribute exactly that. The
  // strip happens whether or not auth is configured, because an unauthenticated
  // deployment must not have a MORE forgeable audit trail than an
  // authenticated one. Guarded by apps/web/test/auth.int.test.ts.
  const headers = new Headers(req.headers);
  headers.delete(ACTOR_HEADER);

  const result = authorize(process.env, req.headers.get('authorization'));

  if (!result.ok) {
    return new NextResponse(result.message, {
      status: result.status,
      headers:
        result.status === 401
          ? { 'WWW-Authenticate': 'Basic realm="pgops", charset="UTF-8"' }
          : {},
    });
  }

  if (result.user !== null) headers.set(ACTOR_HEADER, result.user);
  return NextResponse.next({ request: { headers } });
}

/**
 * Everything except Next's own build output. `_next/static` and `_next/image`
 * are hashed asset paths that carry no data from the database; running the
 * comparison on each of them adds latency to every page load for no gain.
 * Every route that can read or change a database goes through this.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

- [ ] **Step 6: Give the harness an environment parameter**

In `apps/web/test/harness.ts`, change `withConsole`'s signature and merge the extra environment into the spawned server's:

```ts
export async function withConsole(
  fn: (c: Console) => Promise<void>,
  extraEnv: Record<string, string> = {},
): Promise<void> {
```

and, at the `spawn` call:

```ts
      env: {
        ...process.env,
        PGOPS_DATABASES: JSON.stringify([{ name: 'primary', url }]),
        NODE_ENV: 'production',
        // Auth (Task 2) and the action gate (Task 3) are both configured by
        // environment variables read at request time, so a test proving either
        // one needs to vary the SERVER's environment, not its own. Spread last:
        // a test that deliberately overrides PGOPS_DATABASES should win.
        ...extraEnv,
      },
```

- [ ] **Step 7: Write the integration test**

Create `apps/web/test/auth.int.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withConsole } from './harness';

const AUTH = { PGOPS_USERNAME: 'alice', PGOPS_PASSWORD: 'hunter2' };
const header = (u: string, p: string) => ({ authorization: `Basic ${btoa(`${u}:${p}`)}` });

describe('basic auth, against the running console', () => {
  it('challenges an unauthenticated request and serves an authenticated one', async () => {
    await withConsole(async ({ baseUrl }) => {
      const anon = await fetch(baseUrl, { redirect: 'manual' });
      expect(anon.status).toBe(401);
      expect(anon.headers.get('www-authenticate')).toMatch(/^Basic realm="pgops"/);

      const wrong = await fetch(baseUrl, { headers: header('alice', 'nope'), redirect: 'manual' });
      expect(wrong.status).toBe(401);

      const ok = await fetch(baseUrl, { headers: header('alice', 'hunter2'), redirect: 'manual' });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('primary');
    }, AUTH);
  });

  it('serves everything when neither variable is set', async () => {
    await withConsole(async ({ baseUrl }) => {
      expect((await fetch(baseUrl, { redirect: 'manual' })).status).toBe(200);
    });
  });
});
```

- [ ] **Step 8: Run the integration test**

Run: `npm run test:int -- auth`
Expected: PASS. This builds the app and starts a server twice, so it takes a few minutes.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run --workspace @pgops/web typecheck
git add apps/web/lib/auth.ts apps/web/middleware.ts apps/web/test/auth.test.ts \
        apps/web/test/auth.int.test.ts apps/web/test/harness.ts
git commit -m "feat(web): HTTP basic auth, and an actor header no client can forge"
```

---

### Task 3: The action gate and the kill route

Spec §7.1. Tier 1 is `kill`, gated on `PGOPS_ALLOW_ACTIONS=true` **and** confirm. *"A deployment that never sets `PGOPS_ALLOW_ACTIONS` cannot reach tiers 1–3 at all — the routes do not exist."* §9's test row: *"With `PGOPS_ALLOW_ACTIONS` unset, tier ≥ 1 routes return 404. Asserted against the route, not the UI."*

**Files:**
- Create: `apps/web/lib/actions.ts`, `apps/web/app/api/db/[name]/kill/route.ts`, `apps/web/test/actions.test.ts`, `apps/web/test/actions.int.test.ts`, `packages/checks/test/kill-actor.test.ts`
- Modify: `packages/checks/src/actions/kill.ts`, `apps/web/test/guards.test.ts`

**Interfaces:**
- Consumes: `ACTOR_HEADER` from `lib/auth.ts` (Task 2). `contextFor(name)` from `lib/pools.ts`. `killBackend`, `KillOutcome` from `@pgops/checks`.
- Produces, and Task 4 consumes: `POST /api/db/<name>/kill` taking `{ pid: number, backendStart: string | null, reason: string }` and answering `200 {"outcome":"terminated"|"session-changed"|"gone"}`, `400` on a malformed body, `404` when actions are disallowed or the database is unknown. `export function actionsAllowed(env): boolean` from `lib/actions.ts`.

**Rulings carried into this task:**

1. **A route handler, not a Server Action.** The Global Constraint says pages call `runCheck` directly and an API route exists only where something outside the process consumes it. A browser issuing a kill *is* outside the process, and §9 requires the gate be assertable against the route itself — a Server Action has no stable URL to POST to from a test. *Cost if wrong:* one more file than strictly necessary.
2. **404, not 403, when the gate is closed.** The spec's words are "the routes do not exist". A 403 advertises that a kill endpoint is there and merely switched off, which is an invitation; a 404 is indistinguishable from a build that never had one. *Cost if wrong:* an operator who forgot the flag sees "not found" instead of "not allowed" — mitigated by Task 4, which renders no kill control at all in that case, and by the README.
3. **All three outcomes are HTTP 200.** `terminated`, `session-changed` and `gone` are three results of a request that succeeded; only the client cares which. Mapping `session-changed` to a 4xx would make an ordinary, expected, *correct* refusal look like a client error in every proxy log between the browser and the console. *Cost if wrong:* a naive client that checks only `res.ok` reports "killed" when nothing died. Task 4 reads `outcome`, and the test pins all three.
4. **`reason` is required and must be non-empty after trimming.** It is the only free-text field in the audit record and the only thing distinguishing a deliberate kill from an accident, months later. *Cost if wrong:* operators type "x". That is still more than nothing, and it is their audit trail.
5. **`packages/checks` gains `KillMeta.actor`.** This is the one modification to that package in P1b, and it is justified by a verified defect rather than by taste: `currentActor()` builds the audit record's `user` as `${os user}@${process.env.HOSTNAME || hostname()}`, and in a container `HOSTNAME` is the container ID — or, once Task 5's Dockerfile pins it so Next's standalone server binds correctly, the literal string `0.0.0.0`. Either way the audit log names neither the human nor a resolvable host. The web is the first caller that knows a real identity. *Cost if wrong:* an optional field nothing uses. `currentActor()` remains the fallback, so the CLI path is untouched.
6. **The web path always passes `actor`, even with auth unconfigured.** Not "pass it if we have a username" — because then an unauthenticated deployment falls back to `currentActor()` and lands right back on `node@0.0.0.0`. Unauthenticated kills are audited as `anonymous@<PGOPS_PUBLIC_HOST or the request host>`. *Cost if wrong:* the record says `anonymous`, which is the truth.

- [ ] **Step 1: Write the failing unit tests for the gate**

Create `apps/web/test/actions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { actionsAllowed } from '@/lib/actions';

describe('actionsAllowed', () => {
  it('is off when the variable is absent', () => {
    expect(actionsAllowed({})).toBe(false);
  });

  it('is on for the exact value the spec documents', () => {
    expect(actionsAllowed({ PGOPS_ALLOW_ACTIONS: 'true' })).toBe(true);
  });

  it('tolerates case and surrounding whitespace', () => {
    expect(actionsAllowed({ PGOPS_ALLOW_ACTIONS: ' TRUE ' })).toBe(true);
  });

  /**
   * The reason this is a strict comparison and not `Boolean(env.X)`. Every
   * one of these is a NON-empty string, so a truthiness test would enable
   * the kill route for an operator who wrote `PGOPS_ALLOW_ACTIONS=false`
   * expecting it to stay off. Replacing the body with `Boolean(...)` reddens
   * exactly this test.
   */
  it('stays off for every other value, including the ones that look truthy', () => {
    for (const v of ['false', 'FALSE', '0', '1', 'yes', 'no', 'on', 'off', '']) {
      expect(actionsAllowed({ PGOPS_ALLOW_ACTIONS: v }), v).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement `apps/web/lib/actions.ts`**

Run: `npm run test:web -- actions` — FAIL, module not found.

```ts
/**
 * The tier-1 gate, spec §7.1. Actions are off by default: a deployment that
 * never sets this cannot reach the kill route at all, because the route
 * answers 404.
 *
 * Compared strictly against the one documented value rather than tested for
 * truthiness. `Boolean(process.env.PGOPS_ALLOW_ACTIONS)` is true for the
 * string "false", which is exactly what an operator writes when they want
 * this off and are being explicit about it. A permissive parser on the gate
 * in front of pg_terminate_backend is not a convenience.
 */
export function actionsAllowed(env: Record<string, string | undefined>): boolean {
  return (env.PGOPS_ALLOW_ACTIONS ?? '').trim().toLowerCase() === 'true';
}
```

Run again: PASS.

- [ ] **Step 3: Write the failing test for `KillMeta.actor`**

Create `packages/checks/test/kill-actor.test.ts`. A separate file from `kill.test.ts` deliberately: that file mocks `writeAudit` to always reject, which is the wrong fixture for asserting what reaches the record. Vitest mocks are per-file.

```ts
import { describe, expect, it, vi } from 'vitest';
import type { CheckContext } from '../src/types.js';

const written: unknown[] = [];
vi.mock('../src/actions/audit.js', () => ({
  writeAudit: vi.fn(async (record: unknown) => {
    written.push(record);
  }),
}));

import { killBackend } from '../src/actions/kill.js';

function fakeCtx(): CheckContext {
  return {
    target: { query: async () => ({ rows: [{ terminated: true }] }) } as never,
    serverVersion: 170000,
  };
}

/**
 * Why this field exists, verified rather than assumed:
 * `audit.ts`'s `currentActor()` builds the record's `user` as
 * `${os user}@${process.env.HOSTNAME || hostname()}`. Docker sets HOSTNAME to
 * the container ID, and Next's standalone server.js reads the same variable to
 * choose its bind address, so the P1b Dockerfile pins it to 0.0.0.0. In a
 * container, therefore, every kill would be audited as `node@0.0.0.0` — a
 * record naming neither the human who did it nor a host anyone can resolve.
 * The web layer knows the basic-auth username; this is how it gets into the
 * log that exists to attribute destructive actions.
 */
describe('killBackend — the audited actor', () => {
  it('records the caller-supplied actor when one is given', async () => {
    written.length = 0;
    await killBackend(
      fakeCtx(),
      { pid: 42, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'web/sessions', reason: 'blocking checkout', actor: 'alice@console.internal' },
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ user: 'alice@console.internal', action: 'kill' });
  });

  it('leaves `user` for writeAudit to derive when no actor is given', async () => {
    written.length = 0;
    await killBackend(
      fakeCtx(),
      { pid: 42, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test' },
    );
    expect(written).toHaveLength(1);
    expect(written[0]).not.toHaveProperty('user');
  });
});
```

Run: `npm test -- kill-actor` — FAIL. `actor` is not in `KillMeta`, so the first case does not typecheck and the record carries no `user`.

- [ ] **Step 4: Add `actor` to `KillMeta`**

In `packages/checks/src/actions/kill.ts`, extend the interface:

```ts
export interface KillMeta {
  /** Which view/command issued the kill — audit-log field. */
  subcommand: string;
  /** Human-readable justification — audit-log field. */
  reason: string;
  /**
   * Who did it, when the caller knows better than this process does.
   *
   * `writeAudit` derives `user` from `currentActor()` — the OS user, plus
   * `process.env.HOSTNAME || hostname()`. That is right for a CLI on a
   * bastion host and wrong inside a container, where HOSTNAME is the
   * container ID, and wronger still once a Next standalone server pins it to
   * 0.0.0.0 so it binds on all interfaces (verified: next/dist/build/utils.js
   * generates `process.env.HOSTNAME || '0.0.0.0'` into server.js). A web
   * console authenticating an operator knows their name; nothing else in
   * this process does. Omitted, the fallback is unchanged.
   */
  actor?: string;
  /** Extra target metadata for the audit entry (user, app, held_mode, state…). */
  extra?: Record<string, unknown>;
}
```

and, in the `finally` block's `writeAudit` call, pass it through — spreading conditionally so an absent `actor` leaves the key off entirely and `writeAudit`'s own `record.user ?? currentActor()` default still applies:

```ts
      await writeAudit({
        action: 'kill',
        subcommand: meta.subcommand,
        // Conditional spread, not `user: meta.actor`: writeAudit defaults with
        // `record.user ?? currentActor()`, and an explicit `user: undefined`
        // key would still take that branch — but a future `??=`-style edit, or
        // any consumer reading the object shape, would see a `user` key that is
        // there and empty. Absent means absent.
        ...(meta.actor === undefined ? {} : { user: meta.actor }),
        target: { ...meta.extra, pid: target.pid, backend_start: target.backendStart },
        reason: meta.reason,
        result,
      });
```

Run: `npm test -- kill-actor` — PASS. Then `npm test` — the whole unit suite must stay green, and `npm run --workspace @pgops/checks typecheck` must pass (`index.ts` re-exports this type).

- [ ] **Step 5: Write the kill route**

Create `apps/web/app/api/db/[name]/kill/route.ts`:

```ts
import { connection } from 'next/server';
import { killBackend } from '@pgops/checks';
import { ACTOR_HEADER } from '@/lib/auth';
import { actionsAllowed } from '@/lib/actions';
import { contextFor, UnknownDatabaseError } from '@/lib/pools';

/**
 * The only tier-1 surface in P1b, and the only place in apps/web permitted to
 * import `killBackend` (guarded in test/guards.test.ts).
 *
 * `await connection()` for the same reason every page has it: without it this
 * handler is a candidate for prerendering, and `actionsAllowed(process.env)`
 * would be evaluated in the BUILD process — freezing the gate open or shut
 * according to the build machine's environment rather than the deployment's.
 * See lib/check.ts for the full statement of the mechanism.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  await connection();

  // Spec §7.1: "A deployment that never sets PGOPS_ALLOW_ACTIONS cannot reach
  // tiers 1-3 at all — the routes do not exist." 404, not 403: a 403
  // advertises a kill endpoint that is merely switched off. Checked before
  // the body is read and before the database is resolved, so a disallowed
  // deployment is indistinguishable from one built without this file.
  if (!actionsAllowed(process.env)) return notFound();

  const { name } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad('Body must be JSON.');
  }
  const { pid, backendStart, reason } = (body ?? {}) as Record<string, unknown>;

  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return bad('pid must be a positive integer.');
  }
  if (backendStart !== null && typeof backendStart !== 'string') {
    return bad('backendStart must be the session identity string, or null.');
  }
  // The only free-text field in the audit record, and the only thing that
  // distinguishes a deliberate kill from an accident when someone reads the
  // log six months from now. Required, and required to be more than spaces.
  if (typeof reason !== 'string' || reason.trim() === '') {
    return bad('reason is required.');
  }

  let ctx;
  try {
    ctx = await contextFor(name);
  } catch (err) {
    // An unknown database name is a 404 for the same reason a bad path is:
    // nothing here to act on. Anything else is the console failing to reach a
    // database it does know about.
    if (err instanceof UnknownDatabaseError) return notFound();
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  const outcome = await killBackend(
    ctx,
    { pid, backendStart: backendStart ?? null },
    {
      subcommand: 'web/sessions',
      reason: reason.trim(),
      // Always explicit, never left to currentActor() — see the plan's Ruling
      // 6. Middleware sets this header after authenticating and deletes any
      // client-supplied copy first, so it is either a real authenticated
      // username or absent. Absent means auth is not configured, which is
      // honestly recorded as "anonymous" rather than silently falling back to
      // the container's OS user and container ID.
      actor: `${req.headers.get(ACTOR_HEADER) ?? 'anonymous'}@${new URL(req.url).host}`,
      extra: { database: name },
    },
  );

  // All three outcomes are 200 — see the plan's Ruling 3. They are three
  // results of a request that succeeded, and only the client distinguishes
  // them.
  return new Response(JSON.stringify({ outcome }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function notFound() {
  return new Response('Not found', { status: 404 });
}

function bad(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 6: Guard that this is the only importer of `killBackend`**

Add to `apps/web/test/guards.test.ts`, alongside the existing source-scanning guards:

```ts
  /**
   * `killBackend` is the one destructive call in the codebase. It is easy to
   * add a second caller — a Server Action, a convenience helper — that skips
   * `actionsAllowed`, and nothing about such a call looks wrong in review.
   * The gate is enforced in exactly one file; this asserts that stays true.
   *
   * Written as "the set of importing files", not "no file other than X
   * imports it": the correct file is a substring of any wrong path under it,
   * and an exclusion written the other way round matched itself in both P0
   * and P1a.
   */
  it('imports killBackend in exactly one file — the gated route', () => {
    const ROUTE = join(APP, 'api', 'db', '[name]', 'kill', 'route.ts');
    const importers = [...sources(APP), ...sources(COMPONENTS), ...sources(LIB)]
      .filter((f) => /\bkillBackend\b/.test(strip(readFileSync(f, 'utf8'))))
      .sort();
    expect(importers).toEqual([ROUTE]);
  });
```

The file already defines everything this needs — `walk`, `sources` (which filters to the four extensions Next compiles), and the `APP`, `COMPONENTS` and `LIB` roots. Reuse them; do not introduce parallel helpers. `sources(APP)` alone is not enough here: the guard must see `lib/` and `components/` too, since the whole point is that a second caller could appear anywhere.

- [ ] **Step 7: Run to verify the guard fails without the route, then passes**

Temporarily add `import { killBackend } from '@pgops/checks';` to `apps/web/lib/pools.ts`, run `npm run test:web -- guards`, confirm the new test reddens and names `lib/pools.ts`, then remove it and confirm green. Record both runs in the task report — a source-scanning guard that has never been seen to fail is not evidence of anything.

- [ ] **Step 8: Write the integration test**

Create `apps/web/test/actions.int.test.ts`:

```ts
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { withConsole } from './harness';

const ALLOWED = { PGOPS_ALLOW_ACTIONS: 'true' };

async function kill(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/api/db/primary/kill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('the kill route', () => {
  /**
   * Spec §9's "Action gating" row, asserted against the route rather than the
   * UI. The server here is started with PGOPS_ALLOW_ACTIONS unset — which is
   * also the default, so this is the shape every deployment has until someone
   * opts in.
   */
  it('does not exist when PGOPS_ALLOW_ACTIONS is unset', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(baseUrl, { pid: 1, backendStart: null, reason: 'x' });
      expect(res.status).toBe(404);
    });
  });

  it('terminates a real backend, refuses a stale identity, and reports a dead pid', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      // A real, idle client backend to kill.
      const victim = new Client({ connectionString: url });
      await victim.connect();
      const { rows } = await victim.query<{ pid: number; backend_start: string }>(
        'SELECT pg_backend_pid() AS pid, backend_start::text AS backend_start ' +
        'FROM pg_stat_activity WHERE pid = pg_backend_pid()',
      );
      const target = rows[0]!;

      // Wrong identity for a live pid: the guard must refuse rather than kill
      // whatever now answers to that number. This is the PID-reuse case, and
      // it runs BEFORE the successful kill so the pid is known to be live.
      const stale = await kill(baseUrl, {
        pid: target.pid,
        backendStart: '1999-01-01T00:00:00Z',
        reason: 'stale identity',
      });
      expect(stale.status).toBe(200);
      expect(await stale.json()).toEqual({ outcome: 'session-changed' });

      const good = await kill(baseUrl, {
        pid: target.pid,
        backendStart: target.backend_start,
        reason: 'integration test',
      });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ outcome: 'terminated' });
      await victim.end().catch(() => {});

      const absent = await kill(baseUrl, {
        pid: 999_999,
        backendStart: '2026-01-01T00:00:00Z',
        reason: 'no such pid',
      });
      expect(await absent.json()).toEqual({ outcome: 'gone' });
    }, ALLOWED);
  });

  it('rejects a body with no reason', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await kill(baseUrl, { pid: 1, backendStart: null, reason: '   ' });
      expect(res.status).toBe(400);
    }, ALLOWED);
  });

  it('is 404 for a database that is not configured', async () => {
    await withConsole(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/db/nosuchdb/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 1, backendStart: null, reason: 'x' }),
      });
      expect(res.status).toBe(404);
    }, ALLOWED);
  });
});
```

- [ ] **Step 9: Run it**

Run: `npm run test:int -- actions`
Expected: PASS. Note this suite performs real kills, so `PGOPS_AUDIT_LOG` must be redirected — the root `vitest.config.ts` already sets it for the integration project (I4). Confirm the records landed in the temp path and not in `~/.pgops/audit.log`, and say so in the report.

- [ ] **Step 10: Commit**

```bash
npm run --workspace @pgops/checks typecheck
npm run --workspace @pgops/web typecheck
git add packages/checks/src/actions/kill.ts packages/checks/test/kill-actor.test.ts \
        apps/web/lib/actions.ts "apps/web/app/api/db/[name]/kill/route.ts" \
        apps/web/test/actions.test.ts apps/web/test/actions.int.test.ts \
        apps/web/test/guards.test.ts
git commit -m "feat(web): kill behind PGOPS_ALLOW_ACTIONS, audited to a named actor"
```

---

### Task 4: The kill control

Spec §7.1: tier 1 is `PGOPS_ALLOW_ACTIONS=true` **and** confirm.

**Files:**
- Create: `apps/web/components/kill-button.tsx`, `apps/web/test/kill-button.test.tsx`
- Modify: `apps/web/app/db/[name]/sessions/page.tsx`

**Interfaces:**
- Consumes: `POST /api/db/<name>/kill` and `actionsAllowed` (Task 3). `Session.backendStart` from `@pgops/checks` (already on the wire — verified fact 2).
- Produces: nothing later tasks depend on.

**Rulings carried into this task:**

1. **No dialog library.** The confirm is an inline two-step: the cell becomes a reason input with Confirm and Cancel. Adding `@radix-ui/react-dialog` (or whatever shadcn's `dialog` vendors this month) is how P1a ended up with `@base-ui/react` installed for a Badge that turned out to be a `<span>`. An inline control also has no focus-trap or portal behaviour to get wrong, and it gives tier 2's typed confirmation a natural home later. *Cost if wrong:* the control is plainer than a modal. During an incident that is not a cost.
2. **The control is not rendered at all when actions are disallowed.** Not rendered-and-disabled: a disabled button advertises a capability the deployment does not have and invites someone to go looking for the flag mid-incident. The route's 404 is the enforcement; this is the honesty. *Cost if wrong:* an operator with the flag set but a stale page sees no button until refresh.
3. **`backendStart` is sent as the page received it.** Not re-fetched, not re-derived: the whole point of the guard is that the identity travels with the row the human looked at. *Cost if wrong:* the PID-reuse guard stops guarding, which is the defect the guard exists for.
4. **On any outcome, `router.refresh()`.** Even `session-changed` and `gone` — in both cases the operator's picture of the world is out of date, which is *why* the kill did not do what they expected. *Cost if wrong:* stale rows stay on screen after a refused kill.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/kill-button.test.tsx`, using the repo's local render helper (`apps/web/test/render.tsx`) rather than testing-library — see its header for why.

```tsx
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './render';
import { KillButton } from '@/components/kill-button';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const PROPS = { database: 'primary', pid: 42, backendStart: '2026-01-01T00:00:00Z' };

/**
 * `render` is async and wraps only the INITIAL render in `act`; a click that
 * causes a state update has to be wrapped by the caller, or React 19 warns and
 * the DOM read below races the re-render. `find()` in that helper matches an
 * element's own TEXT, not a CSS selector — `querySelector` is the right tool
 * for reaching a specific control.
 */
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

afterEach(() => vi.unstubAllGlobals());

describe('KillButton', () => {
  it('does not send anything on the first click — it asks first', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { container, text } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.querySelector('input')).not.toBeNull();
    expect(text()).toContain('Confirm');
  });

  it('refuses to send with an empty reason', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));
    await click(container.querySelector('button[data-confirm]'));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * The identity the page rendered is the identity that gets sent. Re-deriving
   * it here — or omitting it and letting the server look it up — would turn
   * killBackend's single-statement PID-reuse guard into a guard against
   * nothing, because the value it compares would no longer be the one the
   * human was looking at when they decided.
   */
  it('sends the pid and the backendStart it was given, with the typed reason', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ outcome: 'terminated' })));
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));

    const input = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      // React tracks the last value it set on the node, so assigning `.value`
      // directly and firing `input` is ignored as a no-op change. The native
      // setter is what a controlled component actually observes — the same
      // mechanism testing-library's `fireEvent.change` uses internally.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'blocking checkout');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await click(container.querySelector('button[data-confirm]'));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/db/primary/kill');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      pid: 42,
      backendStart: '2026-01-01T00:00:00Z',
      reason: 'blocking checkout',
    });
  });

  it('reports a refusal in the operator\'s words, not the protocol\'s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ outcome: 'session-changed' }))));
    const { container, text } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const input = container.querySelector<HTMLInputElement>('input')!;
      setter.call(input, 'why not');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container.querySelector('button[data-confirm]'));

    expect(text()).toContain('different session');
  });
});
```

If any of this fights React 19's batching, adjust the test MECHANICS — never what is being asserted. The `useTransition` update in `send` in particular may need one more `act` tick to settle than written here.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:web -- kill-button` — FAIL, module not found.

- [ ] **Step 3: Implement `apps/web/components/kill-button.tsx`**

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Tier 1's "and confirm", spec §7.1, as an inline two-step rather than a
 * modal.
 *
 * No dialog library: P1a installed `@base-ui/react` for a shadcn Badge that
 * turned out to be a `<span>`, and the fix was to stop vendoring the
 * dependency rather than to keep it. An inline control has no portal, no
 * focus trap, and nothing to get wrong when a `router.refresh()` re-renders
 * the table underneath it.
 *
 * `backendStart` is passed straight through from the row the operator is
 * looking at. That is the entire PID-reuse guard: killBackend compares it,
 * inside the same statement as the terminate, against one snapshot of
 * pg_stat_activity. Re-deriving it here would compare the server's idea of
 * the session against itself and always agree.
 */
export function KillButton({
  database,
  pid,
  backendStart,
}: {
  database: string;
  pid: number;
  backendStart: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (outcome) return <span className="text-xs text-muted-foreground">{OUTCOMES[outcome] ?? outcome}</span>;

  if (!confirming) {
    return (
      <button
        type="button"
        className="text-xs underline underline-offset-2"
        onClick={() => setConfirming(true)}
      >
        Terminate
      </button>
    );
  }

  const send = () => {
    if (reason.trim() === '') return;
    startTransition(async () => {
      const res = await fetch(`/api/db/${database}/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid, backendStart, reason: reason.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string };
      setOutcome(body.outcome ?? body.error ?? `HTTP ${res.status}`);
      setConfirming(false);
      // Refreshed on EVERY outcome, not only on success. A refusal
      // ('session-changed') or a miss ('gone') both mean the operator's
      // picture of the world was already stale — which is precisely why the
      // kill did not do what they expected.
      router.refresh();
    });
  };

  return (
    <span className="flex items-center gap-1">
      <label className="sr-only" htmlFor={`reason-${pid}`}>Reason</label>
      <input
        id={`reason-${pid}`}
        className="w-40 border px-1 text-xs"
        placeholder={`Reason — terminate ${pid}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="button" data-confirm className="text-xs font-medium" disabled={pending} onClick={send}>
        Confirm
      </button>
      <button type="button" className="text-xs" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}

/**
 * killBackend's three-valued result, in the operator's words. "session-changed"
 * is not a failure and must not read as one: it means the guard did its job.
 */
const OUTCOMES: Record<string, string> = {
  terminated: 'terminated',
  'session-changed': 'refused — that pid is a different session now',
  gone: 'already gone',
};
```

- [ ] **Step 4: Run the tests**

Run: `npm run test:web -- kill-button` — PASS.

- [ ] **Step 5: Wire it into the sessions page**

In `apps/web/app/db/[name]/sessions/page.tsx`, import `actionsAllowed` and `KillButton`, compute the gate once, add a header cell and a body cell, both conditional:

```tsx
  const canAct = actionsAllowed(process.env);
```

```tsx
                <TableHead>query</TableHead>{canAct ? <TableHead /> : null}
```

```tsx
                  <TableCell className="max-w-md truncate"><Sql>{s.query}</Sql></TableCell>
                  {canAct ? (
                    <TableCell>
                      <KillButton database={name} pid={s.pid} backendStart={s.backendStart} />
                    </TableCell>
                  ) : null}
```

`process.env` is read inside the component body, after `runCheckFor` has already awaited `connection()` — so this page is dynamic before the gate is read, and the gate reflects the deployment rather than the build machine. Do not hoist it to module scope.

- [ ] **Step 6: Verify the whole suite and the build**

```bash
npm run test:web
npm run --workspace @pgops/web typecheck
npm run --workspace @pgops/web build
```
All three green. `next build` is the one that catches an import specifier tsc and vitest both tolerate.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/kill-button.tsx apps/web/test/kill-button.test.tsx \
        "apps/web/app/db/[name]/sessions/page.tsx"
git commit -m "feat(web): a two-step terminate control, shown only where actions are allowed"
```

---

### Task 5: The Docker image

Spec §8: *"Image: multi-stage build on `output: 'standalone'`, running `node server.js` as a non-root user. Standalone traces only the files actually reached, so the runtime layer carries no build toolchain."*

**Files:**
- Create: `Dockerfile`, `.dockerignore` (both at the repo root — the build context is the whole workspace, because `apps/web` depends on `packages/checks`)
- Modify: `apps/web/next.config.ts`

**Interfaces:**
- Produces, and Task 6 consumes: an image serving on `PORT` (default `8080`) that takes all configuration from its runtime environment, and accepts a `DATABASE_URL` **build argument** that exists only so Task 6 can prove the build-time value never reaches the running container.

**Rulings carried into this task:**

1. **One build stage, not a separate `deps` stage.** The usual Next Dockerfile caches `npm ci` in its own stage and copies `node_modules` forward. That requires knowing where npm put things — and this repo has two React majors whose hoisting layout Task 7 deliberately changes: `apps/web/node_modules` exists today and may not afterwards, at which point a `COPY --from=deps /repo/apps/web/node_modules` fails a build that has nothing wrong with it. A single stage that copies the context and runs `npm ci` is immune to that. *Cost if wrong:* a slower rebuild when only source changed. Reintroducing the split is a five-line change once the dependency tree stops moving, and P1b is the phase in which it moves.
2. **`HOSTNAME=0.0.0.0` is set deliberately, knowing what else reads it.** Verified: `next/dist/build/utils.js:1125` generates `const hostname = process.env.HOSTNAME || '0.0.0.0'` into `server.js`, and Docker sets `HOSTNAME` to the container ID, so leaving it unset binds the server to the container's own hostname rather than all interfaces. `audit.ts`'s `currentActor()` reads the same variable. Task 3's `actor` is what keeps the audit log honest under this; the Dockerfile carries the comment that ties the two together. *Cost if wrong:* either an unreachable container or a misattributed audit record — both already seen and both closed.
3. **`node:22-alpine`, and the image's own `node` user.** The base image ships a `node` user at uid 1000; creating another is ceremony. Alpine because the runtime layer is a Next standalone bundle and a Node binary, with no native build step to trip over. *Cost if wrong:* if a future dependency needs glibc, the base changes in one line.
4. **`outputFileTracingRoot` is set explicitly.** In a workspace, Next infers the trace root and warns when it finds more than one lockfile. Inferred wrongly, the standalone output silently omits `packages/checks/dist` and the container fails at first request with a module-not-found for a package the build clearly succeeded with. *Cost if wrong:* a broken image that builds cleanly — which is why Task 6 runs it rather than trusting it.

- [ ] **Step 1: Set the trace root**

In `apps/web/next.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // The Dockerfile builds from this. Standalone traces only the files actually
  // reached, so the runtime layer carries no build toolchain.
  output: 'standalone',

  // Explicit, not inferred. This app imports `@pgops/checks` through a
  // workspace symlink, so the files it needs at runtime live two directories
  // up. Next infers a trace root and warns when a workspace has more than one
  // lockfile; inferred as `apps/web`, the standalone bundle omits
  // packages/checks/dist entirely and the image fails at the first request
  // with a module-not-found for a package the build resolved fine. Task 6
  // runs the image rather than trusting this.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
};

export default config;
```

- [ ] **Step 2: Write `.dockerignore`**

At the repo root:

```
node_modules
**/node_modules
.next
**/.next
dist
**/dist
.git
.superpowers
docs
*.tsbuildinfo
```

`dist` and `.next` are excluded so a stale local build cannot be copied into the image and silently used instead of the one the Dockerfile makes. `docs` is 4 MB of plans and specs that no runtime reads.

- [ ] **Step 3: Write the `Dockerfile`**

At the repo root:

```dockerfile
# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
# One stage, not the usual deps/build split. This repo carries two React
# majors (18 at the root for the Ink TUI, 19 in apps/web) and P1b deletes one
# of them, which moves what npm hoists where. A `COPY --from=deps
# /repo/apps/web/node_modules` is correct before that deletion and a build
# failure after it. Copying the context and installing once is immune to the
# layout; the cost is a slower rebuild when only source changed.
FROM node:22-alpine AS build
WORKDIR /repo

COPY . .
RUN npm ci

# Exists ONLY so CI can prove the build-time value never reaches the running
# container (spec §9, "Runtime env"). A statically prerendered route would
# evaluate process.env inside THIS process and freeze the result into HTML;
# `await connection()` in apps/web/lib/check.ts is what prevents that, and
# this argument is how the proof gets a wrong value in here to look for.
# Nothing in a real build should pass it.
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

# Builds @pgops/checks first — the web app's own build script does this,
# because the package's `exports` point at dist/ and dist/ is git-ignored.
RUN npm run --workspace @pgops/web build

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Verified against next/dist/build/utils.js: the standalone server.js Next
# generates reads `process.env.HOSTNAME || '0.0.0.0'` to choose its bind
# address, and Docker sets HOSTNAME to the container ID unless told otherwise
# — which binds the server to one interface instead of all of them.
#
# The same variable is read by packages/checks/src/actions/audit.ts to name
# the host in every audit record, so with this set, `currentActor()` would
# produce `node@0.0.0.0`: a record naming neither the operator nor a
# resolvable machine. That is why the kill route always passes an explicit
# `actor` (KillMeta.actor) rather than relying on the fallback. Change one of
# these two lines and read the other first.
ENV HOSTNAME=0.0.0.0

# Standalone output is rooted at the workspace root (outputFileTracingRoot in
# apps/web/next.config.ts), so server.js lands at apps/web/server.js with a
# traced node_modules beside it. Static assets are NOT traced — Next expects
# them copied next to the server that serves them.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static

# The base image's own uid 1000. Nothing here writes to the filesystem except
# the audit log's local convenience copy, which fails loudly to stderr and does
# not stop the kill — stdout is that record's real home in a container.
USER node

EXPOSE 8080
CMD ["node", "apps/web/server.js"]
```

- [ ] **Step 4: Build and run it by hand**

```bash
docker build -t pgops:dev .
docker run --rm -p 8080:8080 -e DATABASE_URL=postgres://pgops:pgops@host.docker.internal:55432/appdb pgops:dev
```

**Do not point this at the developer's `pgops-dev` container on :55432.** Start a throwaway instead:

```bash
docker run -d --name pgops-image-probe -e POSTGRES_PASSWORD=probe -p 55433:5432 postgres:17-alpine
docker run --rm -p 8080:8080 \
  -e DATABASE_URL=postgres://postgres:probe@host.docker.internal:55433/postgres pgops:dev
curl -s localhost:8080 | head -40
docker rm -f pgops-image-probe
```

Expected: the overview page renders, listing the database as `default`. Record in the task report: the image's size (`docker images pgops:dev`), and that `docker run --rm pgops:dev id -u` prints a non-zero uid.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore apps/web/next.config.ts
git commit -m "feat(web): a non-root standalone image, and an explicit trace root"
```

---

### Task 6: Prove runtime configuration beats build-time configuration

Spec §9's "Runtime env" row: *"Build an image with one `DATABASE_URL`, run it with another, assert it uses the second. Guards §6.1."* This is the end-to-end half of the rule that `apps/web/test/guards.test.ts` enforces at the source level and `routes.int.test.ts` demonstrates against a `next start` — neither of which exercises an actual image built on a machine with the wrong environment.

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `scripts/image-smoke.sh`

**Interfaces:**
- Consumes: the `Dockerfile` and its `DATABASE_URL` build argument (Task 5).

**Rulings carried into this task:**

1. **A shell script driven by CI, not a Vitest integration test.** The existing integration project runs Testcontainers inside Vitest, which is right for a library against a database. This test's subject is an *image* — `docker build`, `docker run`, and the interaction between the two — and expressing that through a test runner adds a layer that can only obscure which of the two commands failed. *Cost if wrong:* one more entry point to maintain. The script is thirty lines and runs identically on a laptop.
2. **The proof is a distinctive database NAME, not connectivity.** "It connected" is weak evidence: a frozen build-time value that happens to point at the same host would also connect. The image is built with `DATABASE_URL` pointing at a host that does not exist, and run with `PGOPS_DATABASES` naming a database `runtime-wins`. If the page shows `runtime-wins`, runtime configuration was read; a frozen build would have shown `default` — the name `readDatabases` gives a lone `DATABASE_URL` — or failed outright. Those two outcomes are impossible to confuse. *Cost if wrong:* none identified.
3. **The job is `needs`-free and runs in parallel with the others.** It builds an image from scratch, which is the slowest thing in CI; serializing it behind the matrix would make every red build slower to discover. *Cost if wrong:* an image job that passes against source the unit tests reject. It is a smoke test; the other jobs are the gate.

- [ ] **Step 1: Write the script**

Create `scripts/image-smoke.sh`, executable:

```bash
#!/usr/bin/env bash
# Spec §9, "Runtime env": build an image with one DATABASE_URL, run it with
# another, assert it uses the second.
#
# The whole configuration model is `docker run -e PGOPS_DATABASES=... pgops`
# against an image built months earlier. A statically prerendered route
# evaluates process.env in the BUILD process and freezes the result into HTML —
# Turbopack does not textually inline server-side env, so nothing about the
# built output looks wrong; the page is simply already rendered. Get this wrong
# and every deployment of the image talks to whatever database the build
# machine saw. apps/web/lib/check.ts's `await connection()` is the prevention;
# this is the proof.
set -euo pipefail

IMAGE=pgops:smoke
PG=pgops-smoke-pg
APP=pgops-smoke-app
cleanup() { docker rm -f "$PG" "$APP" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# Built pointing at a host that does not resolve. If any part of the build
# freezes this in, the running container cannot possibly work.
docker build \
  --build-arg DATABASE_URL=postgres://build:build@build-machine.invalid:5432/frozen \
  -t "$IMAGE" .

docker network create pgops-smoke >/dev/null 2>&1 || true
docker run -d --name "$PG" --network pgops-smoke \
  -e POSTGRES_PASSWORD=smoke postgres:17-alpine >/dev/null

# Wait for it, rather than sleeping and hoping.
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

# The distinguishing evidence: a database NAME that a build-time freeze could
# not have known. A frozen DATABASE_URL would have produced the name "default".
docker run -d --name "$APP" --network pgops-smoke -p 8080:8080 \
  -e PGOPS_DATABASES='[{"name":"runtime-wins","url":"postgres://postgres:smoke@'"$PG"':5432/postgres"}]' \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  curl -fsS localhost:8080 >/dev/null 2>&1 && break
  sleep 1
done

body=$(curl -fsS localhost:8080)
docker logs "$APP" | tail -20

if ! grep -q 'runtime-wins' <<<"$body"; then
  echo "FAIL: the page does not name the database this container was RUN with." >&2
  echo "$body" | head -40 >&2
  exit 1
fi
if grep -q 'build-machine.invalid' <<<"$body"; then
  echo "FAIL: the build-time DATABASE_URL reached the rendered page." >&2
  exit 1
fi

# Non-root, spec §8.
uid=$(docker exec "$APP" id -u)
if [ "$uid" = "0" ]; then
  echo "FAIL: the container runs as root." >&2
  exit 1
fi

echo "OK: runtime configuration wins, and the container runs as uid $uid."
```

- [ ] **Step 2: Run it locally**

Run: `chmod +x scripts/image-smoke.sh && ./scripts/image-smoke.sh`
Expected: `OK: runtime configuration wins, and the container runs as uid 1000.`

- [ ] **Step 3: Prove the test can fail**

This is the step that makes the previous one mean something. Temporarily delete the `await connection();` line from `apps/web/lib/check.ts` **and** the guard test that pins it, re-run the script, and record what happens. Then restore both.

Expected on the mutated build: either the build fails outright (no database configured at build time, because `readDatabases` throws when it evaluates during prerender) or the page renders `default`/an error frozen from the build machine. Either is a red. If the script still prints OK with `connection()` removed, the script is not testing what it claims and must be fixed before this task is done. Record the exact output in the task report.

- [ ] **Step 4: Add the CI job**

In `.github/workflows/ci.yml`, after the `integration` job:

```yaml
  image:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      # Spec §9, "Runtime env". The source-level half of this rule is
      # apps/web/test/guards.test.ts (every page is dynamic, nothing opts back
      # into static rendering); this is the half that builds an actual image on
      # a machine with the wrong DATABASE_URL and runs it with the right one.
      # Neither substitutes for the other: the guard cannot see a build, and a
      # build cannot see an import.
      - run: ./scripts/image-smoke.sh
```

- [ ] **Step 5: Commit**

```bash
git add scripts/image-smoke.sh .github/workflows/ci.yml
git commit -m "test(image): prove the container reads its database at run time, not build time"
```

---

### Task 7: Delete the Ink TUI

Spec §10, P1: *"The Ink TUI, `src/ui/`, and the Ink/React-terminal dependencies are deleted here. This is the phase where pgops stops being a terminal program."*

This task is last by the project owner's own decision, taken when P1 was split: everything else is proven first, so the deletion is a subtraction from working software rather than a step in the middle of building it.

**Files:**
- Delete: `src/` (90 files, 45 of them tests), `tsconfig.json`
- Modify: `package.json`, `tsconfig.test.json`, `vitest.config.ts`, `apps/web/vitest.config.ts`, `apps/web/package.json`, `.github/workflows/ci.yml`, `packages/checks/test/boundaries.test.ts` (one docblock), `README.md` (rewritten)

**Interfaces:**
- Consumes: nothing. Produces: a repo with one React major.

**Rulings carried into this task:**

1. **The `pgops` binary goes away in this phase, and comes back in P2.** With `src/` deleted there is no `dist/cli.js` for `bin` to point at. The alternatives are a stub that errors and a `bin` entry pointing at nothing; both are worse than no entry. Spec §10 puts `pgops check --format json` in P2, which is where a CLI returns — as its own package, next to `@pgops/checks`, rather than at the workspace root. The root `package.json` becomes `"private": true` and stops declaring `bin` and `files`. *Cost if wrong:* between P1b and P2 there is no `npx pgops`. Nothing has ever been published — the version is `0.0.0` and `master` has never been pushed — so no installed user loses anything.
2. **`apps/web/vitest.config.ts` stays a separate file.** Its docblock says it "can fold back into the root config once P1b deletes the TUI", and that is true, but it also carries the jsdom environment and the React plugin that only this app needs. Folding it in trades a real file for a nested block and re-opens a resolution question that took three failed attempts to close in P1a. *Cost if wrong:* one config file more than the minimum. Update its docblock so it no longer promises a fold that is not happening.
3. **`@vitejs/plugin-react` moves from the root's devDependencies to `apps/web`'s.** It is imported by `apps/web/vitest.config.ts` and by nothing else; leaving it at the root after the root stops having React is exactly the kind of dependency that survives three refactors because nobody can tell what needs it. *Cost if wrong:* an install-time resolution error, caught by the first `npm run test:web`.
4. **The README is rewritten, not amended.** Its first line is "The Postgres on-call toolkit for your terminal", and 195 lines follow describing keystrokes, a tab strip, and an ASCII screenshot of a program that no longer exists. Amending it produces a document describing two products. *Cost if wrong:* the rewrite loses prose worth keeping — recoverable from git.

- [ ] **Step 1: Delete the TUI and its configuration**

```bash
git rm -r --quiet src
git rm --quiet tsconfig.json
```

- [ ] **Step 2: Rewrite the root `package.json`**

Remove `bin`, `files`, the `dev`/`build`/`start`/`typecheck` scripts, and every Ink/React dependency. Add `"private": true`. The result:

```json
{
  "name": "pgops",
  "version": "0.0.0",
  "private": true,
  "description": "Postgres on-call console. Run it during the incident.",
  "type": "module",
  "license": "Apache-2.0",
  "workspaces": ["packages/*", "apps/*"],
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run --project unit",
    "test:int": "npm run --workspace @pgops/checks build && vitest run --project integration",
    "test:web": "npm run --workspace @pgops/checks build && vitest run --project web",
    "test:watch": "vitest",
    "typecheck:test": "tsc -p tsconfig.test.json --noEmit",
    "db:up": "./scripts/dev-db.sh up",
    "db:down": "./scripts/dev-db.sh down",
    "db:psql": "./scripts/dev-db.sh psql",
    "db:seed": "./scripts/dev-db.sh seed"
  },
  "keywords": ["postgres", "postgresql", "ops", "dba", "locks", "incident", "sre", "console"],
  "devDependencies": {
    "@types/node": "^22.10.2",
    "typescript": "^5.7.2",
    "vitest": "^4.1.8"
  }
}
```

Dropped: `cli-truncate`, `ink`, `pg`, `react`, `string-width` from dependencies (`pg` is declared by `packages/checks`, which is the package that uses it); `@types/pg`, `@types/react`, `@vitejs/plugin-react`, `ink-testing-library`, `react-dom`, `tsx` from devDependencies. `@vitejs/plugin-react` moves to `apps/web`.

Then, in `apps/web/package.json`, add to `devDependencies`:

```json
    "@vitejs/plugin-react": "^6.1.0",
```

- [ ] **Step 3: Reroot `tsconfig.test.json`**

It currently extends the root `tsconfig.json`, which is now deleted, and includes `src/**`. Rewrite it to stand on `tsconfig.base.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["packages/*/src/**/*", "packages/*/test/**/*"],
  "exclude": ["node_modules", "**/dist"]
}
```

This is the project that catches `run.ts`'s overload contract — `packages/checks/test/run.test.ts:134` documents that `npm run typecheck:test`, not vitest, is what rejects a two-argument call to a three-argument check. Verify that still holds after the rewrite by making that call and watching it fail, then reverting.

- [ ] **Step 4: Narrow the unit project**

In `vitest.config.ts`, the `unit` project's `include` drops the two `src/**` globs:

```ts
          include: ['packages/**/test/**/*.test.ts'],
```

- [ ] **Step 5: Update the two docblocks that promise things that are no longer true**

`apps/web/vitest.config.ts`'s header explains the two-React-majors split and ends "This file can fold back into the root config once P1b deletes the TUI." Replace that last sentence — the file stays, for the jsdom environment and the React plugin, and the hazard it describes is now historical rather than live. Say so; do not delete the explanation, because it is why the config is not simply inlined.

`packages/checks/test/boundaries.test.ts:151-157`'s docblock describes root `tsconfig.json` as covering "src/** — the OLD TUI". Root `tsconfig.json` no longer exists. The *assertion* is unaffected (it pins a CI step), but the reasoning above it now cites a deleted file. Update the prose; leave the test alone.

- [ ] **Step 6: Drop the root typecheck step from CI**

In `.github/workflows/ci.yml`'s `static` job, remove `- run: npm run typecheck` (the script is gone). Every other step stays exactly as written — `boundaries.test.ts` asserts, with an anchored regex, that the two `--workspace @pgops/checks` steps are present as real YAML steps.

- [ ] **Step 7: Reinstall and verify the tree collapsed to one React**

```bash
rm -rf node_modules apps/web/node_modules packages/checks/node_modules
npm install
npm ls react
```

Expected: one entry, React 19, under `apps/web`. Record the exact output in the task report — this is the resolution of the hazard P1a worked around, and "it should be fine now" is not evidence.

- [ ] **Step 8: Rewrite the README**

Replace `README.md` entirely. It must cover, and nothing much beyond:

- What pgops is now: a web console for the first five minutes of a Postgres incident. Keep the framing that already works — pgHero is the daily dashboard, pgBadger the postmortem tool, pganalyze the SaaS; pgops is what you run *during* the incident, and it can act, not only watch.
- The five routes: overview, triage, sessions, locks (the wait graph), queries.
- Running it: the three `docker run` forms from spec §8 verbatim — one database, many, and with auth.
- Configuration: `DATABASE_URL`, `PGOPS_DATABASES`, `PGOPS_CONFIG_FILE`, `PGOPS_USERNAME`/`PGOPS_PASSWORD`, `PGOPS_ALLOW_ACTIONS`, `PORT`. One table, one line each.
- Safety, in its own short section: actions are off by default and the routes do not exist without the flag; `kill` is pinned to the session identity so a recycled pid cannot be terminated by mistake; every kill is audited to stdout as JSON and to `~/.pgops/audit.log`; every rendered query is redacted; basic auth is the floor and a reverse proxy is the answer for anything real (spec §7.2's own words).
- Requirements: Postgres 14+, tested against 14, 16, 17 and 18.
- Development: `npm install`, `npm run db:up`, `npm run --workspace @pgops/web dev`, and the four test commands.
- One honest paragraph saying the terminal UI was removed in this release and a JSON-emitting CLI returns in the next phase, so anyone arriving from the old README knows what happened.

Do not carry the ASCII screenshot of the TUI forward.

- [ ] **Step 9: Run everything**

```bash
npm test
npm run typecheck:test
npm run --workspace @pgops/checks typecheck
npm run --workspace @pgops/checks build
npm run --workspace @pgops/web typecheck
npm run test:web
npm run --workspace @pgops/web build
npm run test:int
./scripts/image-smoke.sh
```

Every one green. The unit count will drop by roughly 250 tests — that is the TUI's own suite leaving with it, and the report should state the before and after numbers explicitly so the drop is visibly accounted for rather than discovered later.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: delete the Ink TUI — pgops is a web console"
```

Before committing, run `git status --short` and read it. `git add -A` in this repo has previously swept up unrelated working-tree edits; this commit deletes 90 files and the diff is too large to eyeball afterwards.

---

## Deferred past P1b, deliberately

Named so nobody implements them early or reports them as gaps:

- **Tier 2 (`reset` stats) and tier 3 (DDL).** Spec §7.1 puts `reset` in P5 and DDL in the CLI only, never reachable from the web.
- **`analyze`**, the other tier-1 action — P5 by spec §10.
- **The `pgops` CLI**, returning in P2 as `pgops check --format json` with exit codes, in its own package.
- **`PGOPS_STORE_URL` and `pgops capture`** — P3. The Dockerfile's `CMD` is a single web server; the `docker run … pgops capture` form in spec §8 arrives with the store.
- **Playwright web smoke** — spec §9's last row. Task 6 covers the configuration half against a real image; a browser driving every route against a seeded and a permission-denied database is a larger piece of machinery that belongs with P2's eight new routes.
- **Rate limiting, CSRF, session cookies.** Basic auth over a reverse proxy is the documented floor; anything more is the proxy's job, per spec §7.2.

## Self-Review

**Spec coverage.** §7.1 the action ladder — Tasks 3 and 4 (tier 1 only; tiers 2–3 deferred above with the spec's own phasing cited). §7.2 auth — Task 2. §7.3 redaction — unchanged from P1a; the one new surface, the audit record, already passes through `writeAudit`'s `redactSecrets`. §8 configuration — Task 1 (`PGOPS_CONFIG_FILE`) and Task 5 (the image, non-root, standalone). §9's "Action gating" row — Task 3 Step 8, asserted against the route. §9's "Runtime env" row — Task 6. §10's P1 deletion clause — Task 7.

**Placeholder scan.** No TBDs. One step directs the implementer to read a file before editing it — `parseMany`'s five error messages in Task 1, which the plan does not reproduce in full. That is a verification step, not a gap. Two code blocks were corrected against their real dependencies while writing this plan rather than left to fail in review: Task 3's guard snippet now uses `guards.test.ts`'s actual `walk`/`sources`/`APP`/`COMPONENTS`/`LIB`/`strip` helpers, and Task 4's test now awaits `render` (it is async) and reaches controls with `querySelector` rather than the helper's `find`, which matches an element's own text and not a selector.

**Type consistency.** `AuthResult`'s discriminant is `ok`, and both Task 2's middleware and Task 3's route branch on it the same way. `ACTOR_HEADER` is defined once in `lib/auth.ts` and imported by both consumers — the one string that, spelled differently in two places, would silently audit every kill as anonymous, which is why it is exported rather than written twice. `KillMeta.actor` is optional everywhere, so every existing `killBackend` call site still typechecks unchanged. `actionsAllowed(env)` takes the same `Record<string, string | undefined>` shape as `readDatabases(env)` and `authorize(env, …)`, so all three are called with `process.env` identically. The kill route's response body is `{ outcome: KillOutcome }`, and Task 4's `OUTCOMES` map has exactly the three keys that union admits.

**One deliberate deviation from the spec.** §9's "Runtime env" row describes a test; Task 6 implements it as a shell script driven by a CI job rather than as a case in the Vitest integration project. The subject under test is an image and the interaction between `docker build` and `docker run`, which a test runner can only wrap. The requirement is met; the mechanism differs — the same shape as P1a's source-scanning guards standing in for the "enforced by lint rule" the spec asked for.
