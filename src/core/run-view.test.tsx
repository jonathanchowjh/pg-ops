import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runView } from './run-view.js';

/**
 * The `--snapshot` one-shot contract (deep-review I1).
 *
 * `pgops --snapshot > incident.md || page-someone` — the exit code IS the
 * machine-readable surface. The cockpit used to exit 0 with a database that was
 * flat on its back, because `fetchTriage()` never rejects (per-panel isolation):
 * its "failure" arrives as a RESOLVED payload of six failed panels. Every runner
 * now goes through here, so all four agree.
 */

const stdout: string[] = [];
const stderr: string[] = [];

beforeEach(() => {
  stdout.length = 0;
  stderr.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (stdout.push(String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (stderr.push(String(chunk)), true));
  // A syntactically valid URL is enough: getPool() constructs a lazy pool and
  // never connects, and the one-shot's fetch is injected by the caller.
  process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:5432/db';
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Never let a test's exit code escape into the vitest process's own.
  process.exitCode = 0;
  const { closePool } = await import('./connection.js');
  await closePool();
});

const view = () => <Text>never rendered in --snapshot mode</Text>;

describe('runView --snapshot', () => {
  it('prints the markdown and exits 0 when the poll measured something', async () => {
    await runView({
      subcommand: 'locks',
      once: true,
      snapshot: async () => ({ body: 'No lock contention.' }),
      view,
    });
    expect(stdout.join('')).toContain('# pgops locks snapshot');
    expect(stdout.join('')).toContain('No lock contention.');
    expect(process.exitCode).toBeFalsy();
  });

  it('still prints the honest markdown but exits 1 when nothing could be measured', async () => {
    // The cockpit's unreachable-database shape: the fetch RESOLVES, with every
    // panel reporting the connection error. The body names the failure, so it is
    // worth printing — but this is not a healthy database and must not exit 0.
    await runView({
      subcommand: 'triage',
      once: true,
      snapshot: async () => ({
        body: '## SESSIONS\n\nn/a (connect ECONNREFUSED 127.0.0.1:1)',
        failure: 'connect ECONNREFUSED 127.0.0.1:1',
      }),
      view,
    });
    expect(stdout.join('')).toContain('# pgops triage snapshot');
    expect(stdout.join('')).toContain('n/a (connect ECONNREFUSED 127.0.0.1:1)');
    expect(stderr.join('')).toContain('ECONNREFUSED');
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when the fetch rejects', async () => {
    await runView({
      subcommand: 'top',
      once: true,
      snapshot: async () => {
        throw new Error('relation "pg_stat_statements" does not exist');
      },
      view,
      mapError: (m) => `${m} — install hint`,
    });
    expect(stderr.join('')).toContain('install hint');
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 with a clear message when there is no connection configured at all', async () => {
    delete process.env.DATABASE_URL;
    await runView({
      subcommand: 'locks',
      once: true,
      snapshot: async () => ({ body: 'unreachable' }),
      view,
    });
    expect(stderr.join('')).toContain('No database connection');
    expect(stdout.join('')).toBe('');
    expect(process.exitCode).toBe(1);
  });
});
