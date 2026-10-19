import { describe, expect, it } from 'vitest';
import { activity } from '../src/checks/activity.js';

describe('activity.map', () => {
  it('splits wait buckets from shape buckets and takes the active count from its own row', () => {
    const d = activity.map([
      { kind: 'total', key: null, detail: null, sessions: 42, longest_secs: null, query_id: null, statement: null, total: null, sees_all: true },
      { kind: 'wait', key: 'running', detail: null, sessions: 30, longest_secs: '0.4', query_id: null, statement: null, total: 2, sees_all: null },
      { kind: 'wait', key: 'IO', detail: 'DataFileRead', sessions: 12, longest_secs: '2.1', query_id: null, statement: null, total: 2, sees_all: null },
      { kind: 'shape', key: '123', detail: null, sessions: 40, longest_secs: '2.1', query_id: '123', statement: 'SELECT 1', total: 2, sees_all: null },
      { kind: 'shape', key: 'md5', detail: null, sessions: 2, longest_secs: '0.1', query_id: null, statement: 'SELECT 2', total: 2, sees_all: null },
    ]);
    expect(d.active).toBe(42);
    expect(d.waits.map((w) => w.type)).toEqual(['running', 'IO']);
    expect(d.waits[1]!.event).toBe('DataFileRead');
    expect(d.shapes[0]).toEqual({ shapeKey: '123', queryId: '123', statement: 'SELECT 1', sessions: 40, longestSecs: 2.1 });
    expect(d.shapes[1]!.queryId).toBeNull();
    expect(d.waitsTruncated).toBe(false);
    expect(d.shapesTruncated).toBe(false);
    expect(d.restricted).toBe(false);
  });

  it('sets restricted from the total row\'s sees_all, in both directions', () => {
    const base = { kind: 'total' as const, key: null, detail: null, sessions: 1, longest_secs: null, query_id: null, statement: null, total: null };
    expect(activity.map([{ ...base, sees_all: true }]).restricted).toBe(false);
    expect(activity.map([{ ...base, sees_all: false }]).restricted).toBe(true);
  });

  /**
   * `active` must not be the sum of the buckets that fitted under the limit.
   * Here 900 backends are active and one shape row came back out of 400.
   */
  it('keeps active exact and says so when a list was cut short', () => {
    const d = activity.map([
      { kind: 'total', key: null, detail: null, sessions: 900, longest_secs: null, query_id: null, statement: null, total: null, sees_all: true },
      { kind: 'shape', key: 'a', detail: null, sessions: 5, longest_secs: '1', query_id: null, statement: 'SELECT 1', total: 400, sees_all: null },
    ]);
    expect(d.active).toBe(900);
    expect(d.shapesTruncated).toBe(true);
    expect(d.waitsTruncated).toBe(false);
  });

  it('is empty, not broken, on an idle server', () => {
    expect(activity.map([])).toEqual({
      active: 0, waits: [], shapes: [], waitsTruncated: false, shapesTruncated: false, restricted: false,
    });
  });
});
