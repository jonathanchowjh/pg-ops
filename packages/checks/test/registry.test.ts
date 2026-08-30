import { describe, expect, it } from 'vitest';
import { ACTIONS, CHECKS, PGHERO, parityBacklog } from '../src/registry.js';

const PHASES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

describe('the pgHero parity registry', () => {
  it('has an entry for every capability id 1..65', () => {
    const missing = Array.from({ length: 65 }, (_, i) => i + 1).filter((id) => !(id in PGHERO));
    expect(missing).toEqual([]);
  });

  it('puts every entry in exactly one of shipped / action / planned / declined', () => {
    for (const [id, e] of Object.entries(PGHERO)) {
      const states = ['check', 'action', 'planned', 'declined'].filter((k) => k in e);
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

  it('reports the remaining backlog — parity is complete when this is 0', () => {
    expect(parityBacklog()).toBe(Object.values(PGHERO).filter((e) => 'planned' in e).length);
  });
});
