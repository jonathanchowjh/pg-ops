import { describe, expect, it } from 'vitest';
import { ACTIONS, CHECKS, COMPLETE_PHASES, PGHERO, parityBacklog } from '../src/registry.js';
import type { Phase } from '../src/registry.js';

/**
 * Annotated, not inferred: `parityBacklog` takes a `Phase`, and a bare
 * array literal widens to `string[]`. The annotation is also what makes
 * this list a claim about `Phase`'s members — adding 'P7' to the type
 * without adding it here leaves the partition test to notice.
 */
const PHASES: Phase[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

describe('the pgHero parity registry', () => {
  it('has an entry for every capability id 1..65', () => {
    const missing = Array.from({ length: 65 }, (_, i) => i + 1).filter((id) => !(id in PGHERO));
    expect(missing).toEqual([]);
  });

  it('puts every entry in exactly one of check / action / platform / planned / declined', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      const states = ['check', 'action', 'platform', 'planned', 'declined'].filter((k) => k in e);
      expect(states, `capability ${id}`).toHaveLength(1);
    }
  });

  it('never names a check that does not exist', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      if ('check' in e) expect(CHECKS, `capability ${id}`).toHaveProperty(e.check);
    }
  });

  it('never names an action that does not exist', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      if ('action' in e) expect(ACTIONS, `capability ${id}`).toHaveProperty(e.action);
    }
  });

  it('declines exactly one capability — kill_all (#13)', () => {
    const declined = Object.entries(PGHERO).filter(([, e]) => 'declined' in e).map(([id]) => Number(id));
    expect(declined).toEqual([13]);
  });

  it('only plans phases that exist', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      if ('planned' in e) expect(PHASES, `capability ${id}`).toContain(e.planned);
    }
  });

  /**
   * THE GATE. Every other test in this file asserts the registry is
   * well-FORMED; this one asserts it is TRUE. P1 closed owing six
   * capabilities (#1, #2, #3, #18, #48, #60) and nothing here went red,
   * because "planned for a phase that already shipped" was not a property
   * anyone had written down. It is the same shape as the calibration bug
   * the web design spec §3.2 describes — a test that compares a constant to
   * itself agrees with any value the constant takes.
   */
  it('owes nothing for a phase that is already complete', () => {
    for (const phase of COMPLETE_PHASES) {
      const outstanding = Object.entries(PGHERO)
        .filter(([, e]) => 'planned' in e && e.planned === phase)
        .map(([id]) => Number(id));
      expect(outstanding, `phase ${phase} is complete but still owes`).toEqual([]);
    }
  });

  /**
   * Replaces a test that asserted `parityBacklog()` equalled a copy of its
   * own implementation. This one can actually fail: add a phase to the
   * `Phase` type without adding it to `PHASES` and the per-phase counts
   * stop summing to the whole.
   */
  it('partitions the backlog across the phases without loss', () => {
    const summed = PHASES.reduce((n, p) => n + parityBacklog(p), 0);
    expect(summed).toBe(parityBacklog());
  });
});
