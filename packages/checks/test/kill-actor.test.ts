import { describe, expect, it, vi } from 'vitest';
import type { CheckContext } from '../src/types.js';

const written: Record<string, unknown>[] = [];
vi.mock('node:fs/promises', () => ({
  mkdir: async () => undefined,
  appendFile: async (_path: string, line: string) => {
    written.push(JSON.parse(line) as Record<string, unknown>);
  },
}));
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

import { killBackend } from '../src/actions.js';

function fakeCtx(): CheckContext {
  return {
    target: { query: async () => ({ rows: [{ terminated: true }] }) } as never,
    serverVersion: 170000,
  };
}

/**
 * `currentActor()` builds `user` as `${os user}@${HOSTNAME || hostname()}`,
 * and the Dockerfile pins HOSTNAME to 0.0.0.0 for Next's bind address, so in
 * a container every kill would be audited as `node@0.0.0.0`. `actor` is how
 * the web layer's basic-auth username reaches the audit log.
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

  it('derives `user` in writeAudit when no actor is given', async () => {
    written.length = 0;
    await killBackend(
      fakeCtx(),
      { pid: 42, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test' },
    );
    expect(written).toHaveLength(1);
    expect(written[0]?.user).toMatch(/@/);
  });

  /** `'' ?? currentActor()` keeps the empty string, which would record `user: ''`. */
  it('derives `user` in writeAudit when actor is the empty string', async () => {
    written.length = 0;
    await killBackend(
      fakeCtx(),
      { pid: 42, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test', actor: '' },
    );
    expect(written).toHaveLength(1);
    expect(written[0]?.user).toMatch(/@/);
  });
});
