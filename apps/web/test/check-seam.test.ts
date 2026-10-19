import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKS, TOOLS } from '@pgops/checks';
import { isMissingRequestStore, runCheckFor, runToolFor } from '@/lib/check';

describe('isMissingRequestStore', () => {
  /**
   * A match means the `connection()` failure is swallowed, so a false
   * positive would pass a real dynamic-rendering failure as a successful render.
   */
  it('does not treat an ordinary error as a missing request store', () => {
    expect(isMissingRequestStore(new Error('connection refused'))).toBe(false);
  });

  it('does not treat a different Next error code as a missing request store', () => {
    const err = Object.assign(new Error('static generation bailout'), { __NEXT_ERROR_CODE: 'E252' });
    expect(isMissingRequestStore(err)).toBe(false);
  });

  it('does not throw on null or undefined', () => {
    expect(isMissingRequestStore(null)).toBe(false);
    expect(isMissingRequestStore(undefined)).toBe(false);
  });

  it('recognises the missing-request-store code', () => {
    const err = Object.assign(new Error('called outside a request scope'), { __NEXT_ERROR_CODE: 'E251' });
    expect(isMissingRequestStore(err)).toBe(true);
  });
});

// Every input `readDatabases` looks at, in precedence order. Cleared rather
// than assumed absent, in case the developer's shell exports a DATABASE_URL.
const CONFIG_VARS = ['PGOPS_CONFIG_FILE', 'PGOPS_DATABASES', 'DATABASE_URL'];

describe('runCheckFor when the console itself is misconfigured', () => {
  afterEach(() => vi.unstubAllEnvs());

  /**
   * A `ConfigError` must not come back as 'unreachable': nothing was
   * contacted, and that label sends the on-call to the database rather than
   * the deployment. The message must carry `ConfigError`'s own text.
   */
  it('reports a configuration fault as a console error, not the database being unreachable', async () => {
    for (const v of CONFIG_VARS) vi.stubEnv(v, undefined);

    const r = await runCheckFor('primary', CHECKS.connections);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).not.toBe('unreachable');
    expect(r.message).toContain('No database configured');
    expect(r.message).toMatch(/pgops/);
  });

  /**
   * The negative half: a branch that caught too much would relabel every
   * outage as a misconfiguration. Port 1 on loopback refuses immediately.
   */
  it('still reports a real connection failure as unreachable', async () => {
    for (const v of CONFIG_VARS) vi.stubEnv(v, undefined);
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:1/nope');

    const r = await runCheckFor('default', CHECKS.connections);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unreachable');
  });
});

/**
 * The same two properties through the tool seam. Page tests mock
 * `runToolFor`, so nothing else exercises the lines between the page and
 * `runTool`.
 */
describe('runToolFor', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reports a configuration fault as a console error, not the database being unreachable', async () => {
    for (const v of CONFIG_VARS) vi.stubEnv(v, undefined);
    const r = await runToolFor('primary', TOOLS.explain, { sql: 'SELECT 1' });
    expect(r).toMatchObject({ ok: false, reason: 'error', message: expect.stringContaining('No database configured') });
  });

  it('still reports a real connection failure as unreachable', async () => {
    for (const v of CONFIG_VARS) vi.stubEnv(v, undefined);
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:1/nope');
    const r = await runToolFor('default', TOOLS.explain, { sql: 'SELECT 1' });
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});
