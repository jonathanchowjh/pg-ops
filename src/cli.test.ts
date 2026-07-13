import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('./cli.tsx', import.meta.url));

/** Run the real CLI with no DATABASE_URL, so nothing can reach a database. */
async function pgops(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  try {
    const { stdout, stderr } = await run('npx', ['tsx', CLI, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

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
