import { describe, expect, it } from 'vitest';
import { AREAS, areaEscalates, hygieneAreas, type HygieneArea } from '../src/checks/areas.js';
import { CHECKS } from '../src/registry.js';
import type { StoredCheckResult } from '../src/store/read.js';

const NOW = new Date('2026-09-23T12:00:00Z');
const STALE_AFTER_MS = 10 * 60_000;
const opts = { now: NOW, staleAfterMs: STALE_AFTER_MS };

/** A stored row, defaulting to "ran four minutes ago and judged nothing". */
function row(checkId: string, over: Partial<StoredCheckResult> = {}): StoredCheckResult {
  return {
    checkId,
    ok: true,
    level: null,
    note: null,
    message: null,
    capturedAt: new Date(NOW.getTime() - 4 * 60_000),
    ...over,
  };
}

/** Every member of every area, all healthy, four minutes old. */
function allHealthy(): StoredCheckResult[] {
  return AREAS.flatMap((a) => a.members.map((id) => row(
    id,
    CHECKS[id as keyof typeof CHECKS].verdict === undefined ? {} : { level: 'ok' },
  )));
}

const byId = (areas: HygieneArea[], id: string) => areas.find((a) => a.id === id)!;

/**
 * The area table is DATA, and these are the properties that make it safe to
 * add a check without touching the triage page.
 */
describe('AREAS', () => {
  it('gives every hygiene check exactly one area', () => {
    const owned = AREAS.flatMap((a) => a.members);
    const hygiene = Object.values(CHECKS)
      .filter((c) => c.class === 'hygiene')
      .map((c) => c.id);

    expect([...owned].sort()).toEqual([...hygiene].sort());
    expect(new Set(owned).size).toBe(owned.length);
  });

  it('claims nothing that is not hygiene', () => {
    // An incident check cached here would be a second, staler answer to a
    // question the triage page already polls for.
    const classes = AREAS.flatMap((a) => a.members)
      .map((id) => CHECKS[id as keyof typeof CHECKS].class);
    expect([...new Set(classes)]).toEqual(['hygiene']);
  });

  /**
   * An area renders a line only where one of its members can escalate.
   * `space`, `maintenance` and `settings` cannot: every member reports a
   * reading and judges nothing, so a line for them would have to invent a
   * verdict — the "we looked and it is fine" over-claim this project holds
   * `verdict: null` distinct from `ok` to prevent.
   */
  it('reports a line only for the areas that can escalate', () => {
    expect(AREAS.filter(areaEscalates).map((a) => a.id))
      .toEqual(['indexes', 'tables', 'sequences']);
  });

  it('puts each line under a band the triage page renders', () => {
    for (const area of AREAS.filter(areaEscalates)) {
      expect(['connect', 'wait', 'work', 'keep-up']).toContain(area.band);
    }
  });

  /**
   * `escalates` is derived from the checks, not typed in beside them: a
   * threshold added to `databaseSize` tomorrow gives Space a line without an
   * edit here, and a threshold removed takes one away.
   */
  it('derives escalation from the checks themselves', () => {
    for (const area of AREAS) {
      const canJudge = area.members
        .some((id) => CHECKS[id as keyof typeof CHECKS].verdict !== undefined);
      expect(areaEscalates(area)).toBe(canJudge);
    }
  });
});

describe('hygieneAreas', () => {
  it('reports the worst level among an area\'s escalating members', () => {
    const results = allHealthy().map((r) => (
      r.checkId === 'unusedIndexes' ? { ...r, level: 'warn', note: '2 unused indexes' } : r));

    expect(byId(hygieneAreas(results, opts), 'indexes')).toMatchObject({
      level: 'warn', note: '2 unused indexes',
    });
  });

  it('joins the notes of every escalating member, worst first', () => {
    const results = allHealthy().map((r) => {
      if (r.checkId === 'unusedIndexes') return { ...r, level: 'warn', note: '2 unused indexes' };
      if (r.checkId === 'invalidIndexes') return { ...r, level: 'critical', note: '1 invalid index' };
      return r;
    });

    expect(byId(hygieneAreas(results, opts), 'indexes')).toMatchObject({
      level: 'critical', note: '1 invalid index · 2 unused indexes',
    });
  });

  it('says nothing beyond the level when every member is healthy', () => {
    expect(byId(hygieneAreas(allHealthy(), opts), 'indexes'))
      .toMatchObject({ level: 'ok', note: null });
  });

  /** Only the areas that can escalate get a line; see the AREAS test above. */
  it('returns one entry per escalating area', () => {
    expect(hygieneAreas(allHealthy(), opts).map((a) => a.id))
      .toEqual(['indexes', 'tables', 'sequences']);
  });

  it('is unknown when a member has never been captured', () => {
    const results = allHealthy().filter((r) => r.checkId !== 'indexHitRate');

    expect(byId(hygieneAreas(results, opts), 'indexes'))
      .toMatchObject({ level: 'unknown', note: 'never captured' });
  });

  /**
   * A reading older than two capture intervals is not a current answer. It
   * reads `unknown` rather than keeping its old colour, which is the same
   * rule the overview applies to a database it could not reach: "we could
   * not look" never renders as "we looked and it is fine".
   */
  it('is unknown when the newest reading is older than the staleness bound', () => {
    const old = new Date(NOW.getTime() - STALE_AFTER_MS - 1_000);
    const results = allHealthy().map((r) => (
      r.checkId === 'indexHitRate' ? { ...r, capturedAt: old } : r));

    expect(byId(hygieneAreas(results, opts), 'indexes'))
      .toMatchObject({ level: 'unknown', note: 'last captured too long ago' });
  });

  it('is unknown when an escalating member could not run, and says why', () => {
    const results = allHealthy().map((r) => (r.checkId === 'indexHitRate'
      ? { ...r, ok: false, level: null, message: 'permission denied for pg_statio_user_indexes' }
      : r));

    expect(byId(hygieneAreas(results, opts), 'indexes'))
      .toMatchObject({ level: 'unknown', note: 'permission denied for pg_statio_user_indexes' });
  });

  /**
   * A member that never judges cannot make an area unknown: it contributes
   * no verdict when it succeeds, so its failure withholds nothing. Only the
   * members that could have escalated are consulted.
   */
  it('ignores a failed member that has no verdict to give', () => {
    const results = allHealthy().map((r) => (r.checkId === 'indexList'
      ? { ...r, ok: false, level: null, message: 'statement timeout' }
      : r));

    expect(byId(hygieneAreas(results, opts), 'indexes')).toMatchObject({ level: 'ok' });
  });

  it('reports the age of the oldest escalating member', () => {
    const results = allHealthy().map((r) => (r.checkId === 'indexHitRate'
      ? { ...r, capturedAt: new Date(NOW.getTime() - 9 * 60_000) }
      : r));

    expect(byId(hygieneAreas(results, opts), 'indexes').ageMs).toBe(9 * 60_000);
  });

  /** No store, or a database captured for the first time in a moment. */
  it('reports every area unknown when the cache is empty', () => {
    const areas = hygieneAreas([], opts);
    expect(areas).toHaveLength(3);
    expect(areas.every((a) => a.level === 'unknown')).toBe(true);
    expect(areas.every((a) => a.ageMs === null)).toBe(true);
  });
});
