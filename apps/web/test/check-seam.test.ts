import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKS } from '@pgops/checks';
import { isMissingRequestStore, runCheckFor } from '@/lib/check';

describe('isMissingRequestStore', () => {
  /**
   * This predicate decides whether a `connection()` failure is swallowed or
   * turned into `ok:false`. Swallowing the wrong thing is the dangerous
   * direction: it would let a genuine dynamic-rendering failure through as a
   * successful render, which is the exact defect `connection()` exists to
   * prevent. So the assertion that matters most is the negative one.
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

describe('runCheckFor when the console itself is misconfigured', () => {
  // Every input `readDatabases` looks at, in precedence order. Cleared rather
  // than assumed absent: a developer running this suite with a DATABASE_URL
  // exported in their shell would otherwise get a real connection attempt.
  const CONFIG_VARS = ['PGOPS_CONFIG_FILE', 'PGOPS_DATABASES', 'DATABASE_URL'];

  afterEach(() => vi.unstubAllEnvs());

  /**
   * F4 (final review): Task 1's entire justification was that a configuration
   * error must name the input the operator actually set. Through this seam it
   * reached nobody in the shape that matters — `ConfigError` fell into the
   * catch-all below and came back as `reason: 'unreachable'`, which labels a
   * fault in the CONSOLE as the database being down. That is the same
   * misattribution class the `M8` branch eleven lines above it was written to
   * prevent, and during an incident it sends the on-call to the database
   * rather than to the deployment they just changed.
   *
   * The reason must not be 'unreachable' — nothing was ever contacted — and
   * the message must carry `ConfigError`'s own text, which is the only place
   * the operator's input is named.
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
   * The negative half: an ordinary connection failure must STILL be
   * 'unreachable'. A branch that caught too much would relabel every database
   * outage as a misconfiguration, which is the same defect pointing the other
   * way. Port 1 on loopback refuses immediately; nothing is listening there.
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
