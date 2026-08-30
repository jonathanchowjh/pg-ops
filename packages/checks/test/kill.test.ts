import { describe, expect, it, vi } from 'vitest';
import type { CheckContext } from '../src/types.js';

/**
 * Fix-round 1: writeAudit is DESIGNED to never reject (see its own doc
 * comment), but kill.ts's finally block no longer TRUSTS that design
 * blindly — an exception thrown from an `await` inside a `finally` block
 * replaces the `try` block's return value, so if writeAudit's contract is
 * ever violated by a future edit, killBackend must not let that turn a
 * genuine kill outcome into a thrown error. This mocks exactly that
 * violation (writeAudit rejecting) to prove the outer catch in kill.ts's
 * finally is the thing standing between it and a masked outcome — pure
 * unit coverage, no Postgres, since the point under test is kill.ts's own
 * control flow, not the SQL. `vi.mock` calls are hoisted by Vitest above
 * every import in this file, so `kill.ts`'s own `import { writeAudit } from
 * './audit.js'` resolves to this mock.
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
