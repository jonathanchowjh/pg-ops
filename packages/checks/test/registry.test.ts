import { describe, expect, it } from 'vitest';
import {
  ACTIONS, CHECKS, COMPLETE_PHASES, JOBS, PGHERO, PHASE_ORDER, SERIES, parityBacklog,
} from '../src/registry.js';
import type { Phase } from '../src/registry.js';
import { GATES, GATE_ORDER } from '../src/gates.js';
import type { Gate } from '../src/gates.js';

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

  it('puts every entry in exactly one of check / action / series / job / platform / planned / declined', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      const states = ['check', 'action', 'series', 'job', 'platform', 'planned', 'declined']
        .filter((k) => k in e);
      expect(states, `capability ${id}`).toHaveLength(1);
    }
  });

  it('never names a series or a job that does not exist', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      if ('series' in e) expect(SERIES, `capability ${id}`).toHaveProperty(e.series);
      if ('job' in e) expect(JOBS, `capability ${id}`).toHaveProperty(e.job);
    }
  });

  it('orders every phase exactly once', () => {
    expect([...PHASE_ORDER].sort()).toEqual([...PHASES].sort());
  });

  it('states the BUILD order, which is not the label order', () => {
    // Sorting both sides — as the test above must, since it is asking about
    // membership — makes every permutation pass, so the one property this
    // constant exists to encode was the one property nothing asserted. The
    // README cites PHASE_ORDER as the reason P3 shipped before P2; that claim
    // is only worth anything if something fails when the array changes.
    expect([...PHASE_ORDER]).toEqual(['P0', 'P1', 'P3', 'P2', 'P4', 'P5', 'P6']);
    expect(PHASE_ORDER.indexOf('P3')).toBeLessThan(PHASE_ORDER.indexOf('P2'));
  });

  it('has built every phase that precedes an unbuilt one', () => {
    // The gate PHASE_ORDER is FOR: phases complete in build order, with no
    // holes. Shipping P4 while P2 is still owed would pass every other test
    // in this file.
    const firstUnbuilt = PHASE_ORDER.findIndex((p) => !COMPLETE_PHASES.includes(p));
    const built = PHASE_ORDER.filter((p) => COMPLETE_PHASES.includes(p));
    expect(built).toEqual(PHASE_ORDER.slice(0, firstUnbuilt === -1 ? undefined : firstUnbuilt));
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

/**
 * The tree (gates.ts) is the console's organising model, and this is what
 * keeps it honest. Its whole value is that EVERY capability has a place on
 * it before it is built — the forty still outstanding included — because a
 * capability that arrives with no home is one that gets a band invented to
 * hold it, which is how the four bands became four different vocabularies
 * the first time.
 */
describe('every capability has a place on the tree', () => {
  /**
   * Pinned to a literal, deliberately, and the one place in this suite that
   * is. Everything else about the tree is derived — the page reads GATE_ORDER
   * and GATES, so a test comparing the page against those two agrees with
   * itself no matter what they say, and reordering GATE_ORDER passed it
   * silently. The ORDER is not an arrangement, it is the model's central
   * claim: a request clears these gates in this sequence, causes run down it
   * and symptoms run up it. A claim that specific has to be written down
   * somewhere a change has to argue with.
   */
  it('is the order a request actually meets the gates', () => {
    expect(GATE_ORDER).toEqual(['connect', 'wait', 'work', 'keep-up']);
  });

  it('lists every gate in GATE_ORDER exactly once, and never `server`', () => {
    // `server` is not a gate and gets no band: those facts belong in the
    // status line. It exists so "which gate?" has an answer for identity and
    // settings rather than an `undefined` escape hatch.
    expect([...GATE_ORDER].sort()).toEqual(Object.keys(GATES).sort());
    expect(GATE_ORDER).not.toContain('server');
  });

  it('agrees with the check itself wherever a capability is shipped', () => {
    // The duplication is the point: the registry states the gate and the
    // check states the gate, so re-pointing a capability at a check on a
    // different gate cannot pass silently.
    for (const [id, e] of Object.entries(PGHERO)) {
      if (!('check' in e)) continue;
      expect(e.gate, `capability ${id} (${e.name})`).toBe(CHECKS[e.check].gate);
    }
  });

  it('gives every gate something to hold, now or later', () => {
    // Ranges over the PLANNED entries as much as the shipped ones, so a gate
    // invented with nothing behind it fails here rather than rendering as an
    // empty heading on the triage page.
    for (const gate of GATE_ORDER) {
      const held = Object.values(PGHERO).filter((e) => e.gate === gate);
      expect(held.length, `gate ${gate}`).toBeGreaterThan(0);
    }
  });

  it('places every shipped check on a gate the triage page renders', () => {
    for (const [id, check] of Object.entries(CHECKS)) {
      if (check.gate === 'server') continue;
      expect(GATE_ORDER, `check ${id}`).toContain(check.gate as Gate);
    }
  });
});
