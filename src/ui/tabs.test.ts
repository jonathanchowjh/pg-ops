import { describe, expect, it } from 'vitest';
import { TABS, nextTab, tabForKey } from './tabs.js';

describe('TABS', () => {
  it('has exactly nine tabs on keys 1-9, in spec order', () => {
    expect(TABS.map((t) => t.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(TABS.map((t) => t.name)).toEqual([
      'triage', 'sessions', 'locks', 'top', 'space', 'vacuum', 'replication', 'seq', 'system',
    ]);
  });

  it('leaves 0 unbound', () => {
    expect(tabForKey('0')).toBeUndefined();
  });

  it('marks exactly the four built views as built', () => {
    expect(TABS.filter((t) => t.built).map((t) => t.name)).toEqual(['triage', 'sessions', 'locks', 'top']);
  });

  it('cycles forward and backward, wrapping at both ends', () => {
    expect(nextTab('triage', 1).name).toBe('sessions');
    expect(nextTab('system', 1).name).toBe('triage');
    expect(nextTab('triage', -1).name).toBe('system');
  });

  it('tabForKey resolves each bound key to the matching tab', () => {
    // A can-it-fail check for tabForKey itself: '0' returning undefined
    // (above) doesn't prove '1'..'9' resolve to anything at all, let alone
    // the RIGHT tab — a tabForKey that always returned undefined would still
    // pass the '0' test.
    for (const t of TABS) expect(tabForKey(t.key)).toEqual(t);
  });

  it("nextTab falls back to the first tab when name matches nothing (e.g. the doctor view)", () => {
    // active can name something that isn't a tab (RULING R-P9: a later task
    // binds 'D' to a doctor view). nextTab must still return a real Tab, never
    // undefined, so we pick a defined behaviour: treat "not found" as if
    // cycling from just before the start, landing on the first tab regardless
    // of direction. Documented and tested here so it can't silently become
    // "throws" or "returns undefined" later.
    expect(nextTab('doctor', 1).name).toBe('triage');
    expect(nextTab('doctor', -1).name).toBe('triage');
  });
});
