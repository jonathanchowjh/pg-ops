import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

/**
 * Follows the CI matrix's Postgres version. Same expression as
 * packages/checks/test/global-setup.ts.
 */
export const IMAGE = `postgres:${process.env.PGOPS_TEST_PG_VERSION ?? '17'}-alpine`;

export interface Console {
  baseUrl: string;
  sql: (text: string) => Promise<void>;
  /**
   * The throwaway container's connection string, for a test that must hold a
   * backend open across a fetch; `sql()` opens and closes one per call.
   */
  url: string;
}

/**
 * `next` itself, not `npm run start`. On Linux a SIGTERM to npm kills npm and
 * sh but orphans `next` still holding the port, and every later `withConsole`
 * on that worker silently tests the orphan. macOS's sh execs its last
 * command, so the orphan does not appear locally.
 *
 * Resolved, not spelled out as a path: npm may nest `next` under this
 * workspace or hoist it to the repo root. `next` publishes no `exports`
 * field, so the subpath resolves directly. harness.test.ts checks the result.
 */
export const NEXT_BIN = createRequire(import.meta.url).resolve('next/dist/bin/next');
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
 * One container and one server per call. Starting the server is expensive (a
 * Next production build plus start), so make several assertions inside one
 * `withConsole` call rather than opening one per assertion.
 *
 * The build runs before the Postgres container exists, so there is no
 * database URL for a statically prerendered page to capture: a page that
 * failed to opt into dynamic rendering (see lib/check.ts's `connection()`
 * seam) fails here instead of passing against a frozen URL.
 */
export async function withConsole(
  fn: (c: Console) => Promise<void>,
  /**
   * Extra server environment. A function when a value needs the container's
   * URL (`PGOPS_STORE_URL`), which does not exist until the container starts.
   */
  extraEnv: Record<string, string> | ((url: string) => Record<string, string>) = {},
): Promise<void> {
  let pg: StartedPostgreSqlContainer | undefined;
  let server: ChildProcess | undefined;
  try {
    await run('npm', ['run', '--workspace', '@pgops/web', 'build']);

    // Preloaded, not created: `pg_stat_statements` stays a missing relation
    // until a test runs `CREATE EXTENSION`, so the missing-extension tests
    // still hold. Same command as packages/checks/test/global-setup.ts.
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
        // Spread last: a test that deliberately overrides PGOPS_DATABASES wins.
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
    // Awaited: the next `withConsole` on this worker binds the same port.
    if (server && server.exitCode === null) {
      const exited = new Promise((r) => server!.once('exit', r));
      server.kill('SIGTERM');
      await exited;
    }
    await pg?.stop().catch(() => {});
  }
}
