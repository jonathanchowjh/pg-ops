import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS, CHECKS, JOBS, PGHERO, SERIES, TOOLS,
} from '../src/registry.js';
import { HOMES } from '../src/types.js';
import { GATES, GATE_ORDER } from '../src/gates.js';
import type { Gate } from '../src/gates.js';

describe('the pgHero parity registry', () => {
  it('has an entry for every capability id 1..65', () => {
    const missing = Array.from({ length: 65 }, (_, i) => i + 1).filter((id) => !(id in PGHERO));
    expect(missing).toEqual([]);
  });

  it('puts every entry in exactly one of check / action / series / job / tool / platform / declined', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      const states = ['check', 'action', 'series', 'job', 'tool', 'platform', 'declined']
        .filter((k) => k in e);
      expect(states, `capability ${id}`).toHaveLength(1);
    }
  });

  it('never names a series, a job or a tool that does not exist', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      if ('series' in e) expect(SERIES, `capability ${id}`).toHaveProperty(e.series);
      if ('job' in e) expect(JOBS, `capability ${id}`).toHaveProperty(e.job);
      if ('tool' in e) expect(TOOLS, `capability ${id}`).toHaveProperty(e.tool);
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

  /**
   * Exact list equality, not a count: a decline is a product decision, and
   * this catches one arriving without anyone editing this line.
   */
  it('declines exactly five capabilities, each one permanently', () => {
    const declined = Object.entries(PGHERO)
      .filter(([, e]) => 'declined' in e).map(([id]) => Number(id));
    // #13 kill_all: an action with no diagnosis.
    // #19 / #61 / #62: a schema change against a monitored database.
    // #59 system_stats: a cloud SDK and credentials for one panel.
    expect(declined).toEqual([13, 19, 59, 61, 62]);
  });

  /** A decline that does not say why is indistinguishable from an omission later. */
  it('gives every decline a reason that states it is permanent', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      if (!('declined' in e)) continue;
      expect(e.declined.length, `capability ${id}`).toBeGreaterThan(80);
      expect(e.declined, `capability ${id}`).toMatch(/Permanent/i);
    }
  });

  it('declines system_stats and autoindex, permanently', () => {
    expect(PGHERO[59]).toHaveProperty('declined');
    expect(PGHERO[62]).toHaveProperty('declined');
  });
});

/**
 * The tree (gates.ts) is the console's organising model. Every capability
 * must have a place on it, so that one arriving with no home does not get a
 * band invented to hold it.
 */
describe('every capability has a place on the tree', () => {
  /**
   * Pinned to a literal because everything else about the tree is derived
   * from GATE_ORDER and GATES, so a derived test passes under any reordering.
   * The order is the model's claim: a request clears the gates in this
   * sequence, causes run down it and symptoms run up it.
   */
  it('is the order a request actually meets the gates', () => {
    expect(GATE_ORDER).toEqual(['connect', 'wait', 'work', 'keep-up']);
  });

  it('lists every gate in GATE_ORDER exactly once, and never `server`', () => {
    // `server` is not a gate and gets no band; it exists so identity and
    // settings checks have an answer to "which gate?".
    expect([...GATE_ORDER].sort()).toEqual(Object.keys(GATES).sort());
    expect(GATE_ORDER).not.toContain('server');
  });

  it('agrees with the check itself wherever a capability is shipped', () => {
    // The registry and the check each state the gate, so re-pointing a
    // capability at a check on a different gate fails here.
    for (const [id, e] of Object.entries(PGHERO)) {
      if (!('check' in e)) continue;
      expect(e.gate, `capability ${id} (${e.name})`).toBe(CHECKS[e.check].gate);
    }
  });

  it('gives every gate something to hold, now or later', () => {
    // A gate with nothing behind it would render as an empty heading on the
    // triage page.
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

/**
 * Guard: the README's parity table and headline must match the counts the
 * registry computes, so the registry cannot move and leave the prose behind.
 */
describe('the README parity claims', () => {
  const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

  const row = (label: string): number => {
    const m = new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`).exec(README);
    if (m === null) throw new Error(`no "${label}" row in the README parity table`);
    return Number(m[1]);
  };

  // Every entry is shipped or declined; the type has no third state.
  const shipped = Object.values(PGHERO).filter((e) => !('declined' in e)).length;

  it('states the counts the registry computes', () => {
    expect(row('Shipped')).toBe(shipped);
    expect(row('Declined on purpose')).toBe(
      Object.values(PGHERO).filter((e) => 'declined' in e).length);
    expect(row('Remaining')).toBe(0);
  });

  it('repeats those counts in the headline, rather than a second set', () => {
    const m = /\*\*(\d+) of the 65 are shipped, (\d+) (?:is|are) declined on purpose,\s*\n?\s*and (\d+) remain\*\*/.exec(README);
    expect(m, 'no "N of the 65 are shipped…" headline in the README').not.toBeNull();
    expect(Number(m![1])).toBe(shipped);
    expect(Number(m![3])).toBe(0);
  });
});

/**
 * Guard: the README stays a short pitch plus an operator manual, with the
 * design record in CONTRIBUTING. The word counts are ceilings, not targets.
 */
describe('the README is a pitch and a manual, not an essay', () => {
  const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
  const words = (s: string): number => s.trim().split(/\s+/).filter((w) => w !== '').length;

  it('pitches in under 150 words, before the first heading', () => {
    // Everything above the first `##`, minus the `# pgops` title line.
    const body = README.slice(README.indexOf('\n')).split(/^## /m)[0]!;
    expect(words(body)).toBeLessThanOrEqual(150);
  });

  it('is under 1,800 words in total', () => {
    expect(words(README)).toBeLessThanOrEqual(1_800);
  });

  /** Deleting the design sections outright would pass both word counts while losing the reasoning. */
  it('keeps the design record, in CONTRIBUTING', () => {
    const contributing = readFileSync(new URL('../../../CONTRIBUTING.md', import.meta.url), 'utf8');
    for (const claim of [
      // The four gates' causal order: the console's organising model.
      'symptoms run up',
      // Why capture stores cumulative values instead of resetting.
      'never resets',
      // The five declines, by the capability each one names.
      'kill_all',
      'autoindex',
      // The deliberate divergences from pgHero.
      'null` on a primary',
    ]) {
      expect(contributing, `CONTRIBUTING must carry: ${claim}`).toContain(claim);
    }
  });

  /** Moving these sections to CONTRIBUTING would pass the word counts and leave operators without a manual. */
  it('keeps the operator manual in the README', () => {
    for (const heading of [
      '## Quick start', '## Configuration', '## Database permissions',
      '## Pages', '## Safety model', '## Parity with pgHero',
    ]) {
      expect(README, `README must keep: ${heading}`).toContain(heading);
    }
  });
});

describe('home', () => {
  it('places every check on a node kind', () => {
    for (const [id, check] of Object.entries(CHECKS)) {
      expect(HOMES, id).toContain(check.home);
    }
  });
});
