import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

/**
 * I4 (final review): this was hardcoded `postgres:17-alpine`, so the CI matrix
 * did not reach the console at all — the PG 14 leg (the declared floor), 16 and
 * 18 all rendered pages against 17, and the Global Constraint "CI matrix 14,
 * 16, 17, 18" held for nothing in apps/web. Same expression as
 * packages/checks/test/global-setup.ts, which CI already drives per leg.
 */
const IMAGE = `postgres:${process.env.PGOPS_TEST_PG_VERSION ?? '17'}-alpine`;

export interface Console {
  baseUrl: string;
  sql: (text: string) => Promise<void>;
  /**
   * The throwaway container's own connection string. `sql()` above opens and
   * closes a connection per call, so it cannot hold a backend open across a
   * fetch — a test proving truncation (more sessions exist than the page's
   * LIMIT) needs to open extra `pg.Client` connections directly and keep them
   * open while it fetches, which needs the raw URL to connect to.
   */
  url: string;
}

/**
 * `next` itself, not `npm run start`. On Linux `npm run` puts `npm → sh →
 * next` between us and the listener, and a SIGTERM to npm kills npm and sh
 * but orphans `next` still holding the port — every later `withConsole` on
 * that worker then hit EADDRINUSE and silently tested the orphan instead
 * (CI run 35677090028: 23 failures, all "expected 404"). macOS's sh execs
 * its last command, so the orphan never appeared locally.
 */
const NEXT_BIN = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url));
const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));

async function waitForPort(url: string, server: ChildProcess, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Our server is gone, so anything still answering on the port is someone
    // else's — a test must not pass or fail against it.
    if (server.exitCode !== null) throw new Error(`console exited with code ${server.exitCode} before ${url} was up`);
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

/** Runs a command to completion, rejecting on a non-zero exit. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: 'inherit' });
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

/**
 * One container and one server per call. Starting the server is the
 * expensive part (a Next production build plus start), so a test needing
 * several assertions against the same seeded state should make them inside
 * one `withConsole` call rather than opening a new one per assertion.
 *
 * The build runs BEFORE the Postgres container even exists, and the server is
 * started only afterward, pointed at that container's freshly minted URL.
 * That order is the entire point: `next build` produces the artifact the
 * server runs from, and it does so before there is any database URL to
 * freeze even if the page tried. Only THEN does a container start, and only
 * then does the server that reads it. If the overview page rendered without
 * opting into dynamic rendering (see lib/check.ts's `connection()` seam),
 * `process.env.PGOPS_DATABASES` would have been captured — or, more likely,
 * found absent and thrown on — during the build step above, before this
 * function ever calls `PostgreSqlContainer`. A harness that instead ran
 * `next start` against a build already sitting on disk (the brief's
 * original shape) could not tell a dynamic page from a statically
 * prerendered one; this task's report records the run that proved the
 * distinction actually matters.
 */
export async function withConsole(
  fn: (c: Console) => Promise<void>,
  /**
   * Extra server environment. A FUNCTION when a value has to name the
   * throwaway container — `PGOPS_STORE_URL` is the case: the store's
   * connection string does not exist until the container has started, which
   * is after this argument is passed.
   */
  extraEnv: Record<string, string> | ((url: string) => Record<string, string>) = {},
): Promise<void> {
  let pg: StartedPostgreSqlContainer | undefined;
  let server: ChildProcess | undefined;
  try {
    await run('npm', ['run', '--workspace', '@pgops/web', 'build']);

    // Preloaded, not created: `shared_preload_libraries` only makes the
    // extension AVAILABLE, so `pg_stat_statements` is still a missing relation
    // until a test runs `CREATE EXTENSION` on this container — which is what
    // keeps "says the extension is missing rather than showing an empty table"
    // honest, while letting the one test that needs all nine incident checks
    // to run actually create it. Same command as
    // packages/checks/test/global-setup.ts.
    pg = await new PostgreSqlContainer(IMAGE)
      .withCommand(['postgres', '-c', 'shared_preload_libraries=pg_stat_statements'])
      .start();
    const url = pg.getConnectionUri();
    const port = 3100 + Math.floor(Number(process.env.VITEST_WORKER_ID ?? 1));

    server = spawn(process.execPath, [NEXT_BIN, 'start', '--port', String(port)], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        PGOPS_DATABASES: JSON.stringify([{ name: 'primary', url }]),
        NODE_ENV: 'production',
        // Auth (Task 2) and the action gate (Task 3) are both configured by
        // environment variables read at request time, so a test proving either
        // one needs to vary the SERVER's environment, not its own. Spread last:
        // a test that deliberately overrides PGOPS_DATABASES should win.
        ...(typeof extraEnv === 'function' ? extraEnv(url) : extraEnv),
      },
      stdio: 'inherit',
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForPort(baseUrl, server);

    await fn({
      baseUrl,
      url,
      sql: async (text: string) => {
        const c = new Client({ connectionString: url });
        await c.connect();
        try { await c.query(text); } finally { await c.end().catch(() => {}); }
      },
    });
  } finally {
    // Always torn down, failure or not — this is a throwaway container the
    // harness itself started, never the developer's own `pgops-dev`.
    // Awaited: the next `withConsole` on this worker binds the same port.
    if (server && server.exitCode === null) {
      const exited = new Promise((r) => server!.once('exit', r));
      server.kill('SIGTERM');
      await exited;
    }
    await pg?.stop().catch(() => {});
  }
}
