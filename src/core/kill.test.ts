import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockWriteAudit = vi.fn().mockResolvedValue(undefined);
vi.mock('./connection.js', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
vi.mock('./audit.js', () => ({ writeAudit: (...a: unknown[]) => mockWriteAudit(...a) }));

const { killBackend } = await import('./kill.js');

const target = { pid: 4711, backendStart: '2026-07-12 10:00:00.123456+00' };
const ctx = { subcommand: 'sessions', reason: 'idle in transaction for 840s', meta: { user: 'app' } };

describe('killBackend (core)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockWriteAudit.mockClear();
  });

  it('returns terminated when the session identity still matches', async () => {
    mockQuery.mockResolvedValue([{ terminated: true }]);
    await expect(killBackend(target, ctx)).resolves.toBe('terminated');
    // Guarded SQL is parameterized with pid + backendStart.
    expect(mockQuery.mock.calls[0]?.[1]).toEqual([4711, target.backendStart]);
  });

  it('refuses with session-changed when the pid was reused', async () => {
    mockQuery.mockResolvedValue([{ terminated: null }]);
    await expect(killBackend(target, ctx)).resolves.toBe('session-changed');
  });

  it('returns gone when the pid no longer exists', async () => {
    mockQuery.mockResolvedValue([]);
    await expect(killBackend(target, ctx)).resolves.toBe('gone');
  });

  it('audit-logs the caller context', async () => {
    mockQuery.mockResolvedValue([{ terminated: true }]);
    await killBackend(target, ctx);
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'kill',
        subcommand: 'sessions',
        reason: 'idle in transaction for 840s',
        result: 'terminated',
        target: expect.objectContaining({ pid: 4711, backend_start: target.backendStart, user: 'app' }),
      }),
    );
  });
});
