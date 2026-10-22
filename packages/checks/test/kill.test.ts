import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckContext } from '../src/types.js';

/**
 * writeAudit is designed never to reject, but a throw from an `await` inside
 * a `finally` replaces the `try` block's return value. A throwing hostname()
 * makes the real writeAudit reject, to prove killBackend still returns the
 * real kill outcome. The file write is mocked so no log is touched.
 */
const written: string[] = [];
// hostname() is the injection point: currentActor() calls it outside writeAudit's
// try blocks, so a throw there is a genuine rejection. HOSTNAME is stubbed empty
// below because audit.ts only calls hostname() when it is unset.
vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  hostname: vi.fn(() => {
    throw new Error('audit sink is down');
  }),
}));
vi.mock('node:fs/promises', () => ({
  mkdir: async () => undefined,
  appendFile: async (_path: string, line: string) => {
    written.push(line);
  },
}));

import { hostname } from 'node:os';
import { killBackend } from '../src/actions.js';

beforeEach(() => {
  vi.stubEnv('HOSTNAME', '');
  vi.mocked(hostname).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeCtx(terminated: boolean | null | undefined): CheckContext {
  return {
    target: {
      query: async () => ({ rows: terminated === undefined ? [] : [{ terminated }] }),
    } as never,
    serverVersion: 170000,
  };
}

describe('killBackend — writeAudit contract violation (defence in depth)', () => {
  it('still returns "terminated" when writeAudit rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await killBackend(
      fakeCtx(true),
      { pid: 1, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test' },
    );
    expect(out).toBe('terminated');
    expect(hostname).toHaveBeenCalled();
    // The violation itself is still surfaced, not silently absorbed.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('writeAudit threw despite its no-reject contract'),
      expect.any(Error),
    );
  });

  it('still returns "session-changed" when writeAudit rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await killBackend(
      fakeCtx(null),
      { pid: 1, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test' },
    );
    expect(out).toBe('session-changed');
    expect(hostname).toHaveBeenCalled();
  });

  it('still returns "gone" when writeAudit rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await killBackend(
      fakeCtx(undefined),
      { pid: 1, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test' },
    );
    expect(out).toBe('gone');
    expect(hostname).toHaveBeenCalled();
  });

  it("spreads meta.extra before the real pid/backend_start, so it can't overwrite the audit subject", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.mocked(hostname).mockReturnValueOnce('host');
    written.length = 0;

    await killBackend(
      fakeCtx(true),
      { pid: 1, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test', extra: { pid: 999_999, backend_start: 'lies', app: 'psql' } },
    );

    const call = JSON.parse(written[0] ?? '{}') as { target?: unknown };
    expect(call.target).toMatchObject({ pid: 1, backend_start: '2026-01-01T00:00:00Z', app: 'psql' });
  });
});
