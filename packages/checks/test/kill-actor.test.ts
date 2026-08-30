import { describe, expect, it, vi } from 'vitest';
import type { CheckContext } from '../src/types.js';

const written: unknown[] = [];
vi.mock('../src/actions/audit.js', () => ({
  writeAudit: vi.fn(async (record: unknown) => {
    written.push(record);
  }),
}));

import { killBackend } from '../src/actions/kill.js';

function fakeCtx(): CheckContext {
  return {
    target: { query: async () => ({ rows: [{ terminated: true }] }) } as never,
    serverVersion: 170000,
  };
}

/**
 * Why this field exists, verified rather than assumed:
 * `audit.ts`'s `currentActor()` builds the record's `user` as
 * `${os user}@${process.env.HOSTNAME || hostname()}`. Docker sets HOSTNAME to
 * the container ID, and Next's standalone server.js reads the same variable to
 * choose its bind address, so the P1b Dockerfile pins it to 0.0.0.0. In a
 * container, therefore, every kill would be audited as `node@0.0.0.0` — a
 * record naming neither the human who did it nor a host anyone can resolve.
 * The web layer knows the basic-auth username; this is how it gets into the
 * log that exists to attribute destructive actions.
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

  it('leaves `user` for writeAudit to derive when no actor is given', async () => {
    written.length = 0;
    await killBackend(
      fakeCtx(),
      { pid: 42, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test' },
    );
    expect(written).toHaveLength(1);
    expect(written[0]).not.toHaveProperty('user');
  });

  /**
   * Review finding: `'' ?? currentActor()` keeps the empty string — `??`
   * only falls through on `null`/`undefined`, not on falsy-but-present
   * values — so an `actor: ''` used to produce a record with `user: ''`,
   * against this field's own documented contract ("absent means absent").
   * An empty string is not a real actor any more than `undefined` is; both
   * must leave `user` for writeAudit's `currentActor()` fallback.
   */
  it('leaves `user` for writeAudit to derive when actor is the empty string', async () => {
    written.length = 0;
    await killBackend(
      fakeCtx(),
      { pid: 42, backendStart: '2026-01-01T00:00:00Z' },
      { subcommand: 'sessions', reason: 'test', actor: '' },
    );
    expect(written).toHaveLength(1);
    expect(written[0]).not.toHaveProperty('user');
  });
});
