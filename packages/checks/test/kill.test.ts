import { describe, expect, it, vi } from 'vitest';
import type { CheckContext } from '../src/types.js';

/**
 * writeAudit is designed never to reject, but a throw from an `await` inside
 * a `finally` replaces the `try` block's return value. This mocks writeAudit
 * rejecting to prove killBackend still returns the real kill outcome.
 * `vi.mock` is hoisted above the imports, so kill.ts resolves to this mock.
 */
vi.mock('../src/actions/audit.js', () => ({
  writeAudit: vi.fn(async () => {
    throw new Error('audit sink is down');
  }),
}));

import { killBackend } from '../src/actions/kill.js';
import * as audit from '../src/actions/audit.js';

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
  });

  it('still returns "gone" when writeAudit rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await killBackend(
      fakeCtx(undefined),
      { pid: 1, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test' },
    );
    expect(out).toBe('gone');
  });

  it("spreads meta.extra before the real pid/backend_start, so it can't overwrite the audit subject", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const writeAuditMock = vi.mocked(audit.writeAudit);
    writeAuditMock.mockClear();

    await killBackend(
      fakeCtx(true),
      { pid: 1, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test', extra: { pid: 999_999, backend_start: 'lies', app: 'psql' } },
    );

    const call = writeAuditMock.mock.calls[0]?.[0];
    expect(call?.target).toMatchObject({ pid: 1, backend_start: '2026-01-01T00:00:00Z', app: 'psql' });
  });
});
