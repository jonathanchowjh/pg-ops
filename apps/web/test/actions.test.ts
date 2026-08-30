import { describe, expect, it } from 'vitest';
import { actionsAllowed } from '@/lib/actions';

describe('actionsAllowed', () => {
  it('is off when the variable is absent', () => {
    expect(actionsAllowed({})).toBe(false);
  });

  it('is on for the exact value the spec documents', () => {
    expect(actionsAllowed({ PGOPS_ALLOW_ACTIONS: 'true' })).toBe(true);
  });

  it('tolerates case and surrounding whitespace', () => {
    expect(actionsAllowed({ PGOPS_ALLOW_ACTIONS: ' TRUE ' })).toBe(true);
  });

  /**
   * The reason this is a strict comparison and not `Boolean(env.X)`. Every
   * one of these is a NON-empty string, so a truthiness test would enable
   * the kill route for an operator who wrote `PGOPS_ALLOW_ACTIONS=false`
   * expecting it to stay off. Replacing the body with `Boolean(...)` reddens
   * exactly this test.
   */
  it('stays off for every other value, including the ones that look truthy', () => {
    for (const v of ['false', 'FALSE', '0', '1', 'yes', 'no', 'on', 'off', '']) {
      expect(actionsAllowed({ PGOPS_ALLOW_ACTIONS: v }), v).toBe(false);
    }
  });
});
