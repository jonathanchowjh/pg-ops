import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellOptions } from './commands/shell/run.js';

/**
 * Two kinds of test here, and the difference matters.
 *
 * `pgops()` runs the REAL binary. It is the only way to prove an exit code —
 * and the only thing it can prove about the TUI, because every interactive
 * path dies at "No database connection" (or, with `--snapshot`, at the first
 * query) long before a view renders. So it must never be used to assert
 * routing: `pgops locks` mounting the shell on the locks tab is unobservable
 * from out here.
 *
 * `route()` is that assertion's honest home. It is the dispatch itself, with
 * `runShell` stubbed to record what it was handed — a wrong `tab` in `cli.tsx`
 * fails here, where shelling out would stay green.
 */

const shellCalls: ShellOptions[] = [];
vi.mock('./commands/shell/run.js', () => ({
  runShell: async (opts: ShellOptions) => {
    shellCalls.push(opts);
  },
}));

const { parseArgs, route } = await import('./cli.js');

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('./cli.tsx', import.meta.url));

/**
 * Run the real CLI. `DATABASE_URL` is deleted unless `url` is given, so nothing
 * reaches a database by accident; pass an unreachable one to exercise the
 * `--snapshot` failure path for real.
 */
async function pgops(args: string[], url?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  if (url !== undefined) env.DATABASE_URL = url;
  try {
    const { stdout, stderr } = await run('npx', ['tsx', CLI, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A URL that parses but refuses: port 1 is reserved and nothing listens on it. */
const UNREACHABLE = 'postgres://u:p@127.0.0.1:1/appdb';

const stdout: string[] = [];
const stderr: string[] = [];

beforeEach(() => {
  // Importing `cli.js` runs `main()` once; that call must not be mistaken for
  // one of ours.
  shellCalls.length = 0;
  stdout.length = 0;
  stderr.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (stdout.push(String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (stderr.push(String(chunk)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  // Never let a routing test's exit code escape into vitest's own.
  process.exitCode = 0;
});

describe('parseArgs -- --snapshot flag', () => {
  it('sets snapshot to true when --snapshot is present', () => {
    expect(parseArgs(['locks', '--snapshot']).snapshot).toBe(true);
  });

  it('defaults snapshot to false when --snapshot is absent', () => {
    expect(parseArgs(['locks']).snapshot).toBe(false);
  });

  it('leaves subcommand undefined for a bare invocation — the triage cockpit', () => {
    expect(parseArgs([]).subcommand).toBeUndefined();
    expect(parseArgs(['--snapshot']).subcommand).toBeUndefined();
  });
});

describe('pgops (bare) — the triage cockpit is the front door', () => {
  it('does not print help: it routes to the cockpit, which fails fast without a connection', async () => {
    const { code, stdout, stderr } = await pgops([]);
    // The old behavior (help + exit 1) is gone.
    expect(stdout).not.toContain('Usage: pgops');
    expect(stderr).toContain('No database connection');
    expect(code).toBe(1);
  }, 30_000);

  it('--help still prints help and exits 0, and documents the bare cockpit', async () => {
    const { code, stdout } = await pgops(['--help']);
    expect(stdout).toContain('pgops — Postgres on-call toolkit');
    expect(stdout).toContain('Usage: pgops [subcommand] [options]');
    // The product's front door is documented in its own help.
    expect(stdout).toMatch(/pgops \(no subcommand\)/);
    expect(stdout).toContain('triage cockpit');
    expect(stdout).toContain('locks');
    expect(stdout).toContain('-d, --database');
    expect(code).toBe(0);
  }, 30_000);

  it('an unknown subcommand still errors', async () => {
    const { code, stderr } = await pgops(['nonsense']);
    expect(stderr).toContain('Unknown subcommand: nonsense');
    expect(code).toBe(1);
  }, 30_000);
});

describe('route — every subcommand opens the shell on its tab', () => {
  it('opens the shell on `locks` for `pgops locks`', async () => {
    await route(parseArgs(['locks']));
    expect(shellCalls).toEqual([{ tab: 'locks', connectionString: undefined, once: false }]);
  });

  it('opens the shell on `triage` for `pgops triage` — the one name the strip prints', async () => {
    // Every other tab name is a valid subcommand, so the tab an operator is
    // most likely to type by name must not be the one that errors. It also
    // gives `pgops triage --snapshot` the same one-shot every other tab has.
    await route(parseArgs(['triage']));
    expect(shellCalls[0]?.tab).toBe('triage');
  });

  it('opens the shell on `top` for `pgops top`', async () => {
    await route(parseArgs(['top']));
    expect(shellCalls[0]?.tab).toBe('top');
  });

  it('opens the shell on `sessions` for `pgops sessions`', async () => {
    await route(parseArgs(['sessions']));
    expect(shellCalls[0]?.tab).toBe('sessions');
  });

  it('opens the shell with no tab for bare `pgops` — the cockpit', async () => {
    await route(parseArgs([]));
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0]?.tab).toBeUndefined();
  });

  it('carries -d and --snapshot into the shell', async () => {
    await route(parseArgs(['sessions', '--snapshot', '-d', 'postgres://u:p@h:5432/d']));
    expect(shellCalls[0]).toEqual({
      tab: 'sessions',
      connectionString: 'postgres://u:p@h:5432/d',
      once: true,
    });
  });

  it('does not open the shell for a planned subcommand — it says so and exits 1', async () => {
    await route(parseArgs(['vacuum']));
    expect(shellCalls).toEqual([]);
    expect(stderr.join('')).toContain('planned but not implemented yet');
    expect(process.exitCode).toBe(1);
  });

  it('does not open the shell for an unknown subcommand', async () => {
    await route(parseArgs(['nonsense']));
    expect(shellCalls).toEqual([]);
    expect(stderr.join('')).toContain('Unknown subcommand: nonsense');
    expect(process.exitCode).toBe(1);
  });

  it('does not open the shell for --help', async () => {
    await route(parseArgs(['--help']));
    expect(shellCalls).toEqual([]);
    expect(stdout.join('')).toContain('Usage: pgops');
    expect(process.exitCode).toBeFalsy();
  });
});

describe('--help describes the app the shell actually is', () => {
  it('documents the global keys and both kinds of planned area', async () => {
    await route(parseArgs(['--help']));
    const help = stdout.join('');
    // The nav keys a v0.2 user needs on their first run (spec §5.5, §5.6).
    expect(help).toContain('1-9');
    expect(help).toContain('Tab');
    expect(help).toContain('D doctor');
    expect(help).toContain('Esc');
    // Spec §5.3: a tab and a subcommand are different surfaces. `vacuum` has a
    // digit and a placeholder behind it; `indexes` never gets one.
    expect(help).toMatch(/vacuum[\s\S]*placeholder|placeholder[\s\S]*vacuum/);
    expect(help).toContain('indexes');
  });
});

describe('--snapshot keeps its exit-code contract through the shell', () => {
  it('exits 1 and still prints the cockpit markdown when the database is unreachable', async () => {
    // The cockpit's special case: `fetchTriage` RESOLVES with six failed
    // panels, so nothing rejects and only `connectionFailure` can make this
    // exit 1. `pgops --snapshot > incident.md || page-someone` depends on it.
    const { code, stdout: out, stderr: err } = await pgops(['--snapshot'], UNREACHABLE);
    expect(out).toContain('# pgops triage snapshot');
    expect(out).toContain('n/a');
    expect(err).toContain('ECONNREFUSED');
    expect(code).toBe(1);
  }, 30_000);

  it('exits 1 for a view whose fetch rejects, and prints no half-snapshot', async () => {
    const { code, stdout: out, stderr: err } = await pgops(['locks', '--snapshot'], UNREACHABLE);
    expect(out).not.toContain('# pgops locks snapshot');
    expect(err).toContain('ECONNREFUSED');
    expect(code).toBe(1);
  }, 30_000);
});
