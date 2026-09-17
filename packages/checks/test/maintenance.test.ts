import { describe, expect, it } from 'vitest';
import {
  autovacuumDanger, vacuumProgress, toAutovacuumDanger, toVacuumProgress,
} from '../src/checks/maintenance.js';
import { HARD_LIMIT } from '../src/checks/wraparound.js';

describe('toAutovacuumDanger', () => {
  /**
   * The number an operator acts on. 2,047,483,647 is exactly 100,000,000
   * short of the horizon — `wraparound`'s own `critical` threshold — so this
   * fixture also pins the two checks to one scale. Against pgHero's
   * `autovacuum_freeze_max_age` constant the same row would read as a
   * negative remaining count.
   */
  it('counts down from the same horizon the wraparound alarm uses', () => {
    const { relations } = toAutovacuumDanger([
      { relation: 'public.old', xact_age: 2_047_483_647, total: 1 },
    ]);
    expect(relations[0]!.txnsRemaining).toBe(100_000_000);
    expect(relations[0]!.xactAge).toBe(2_047_483_647);
  });

  /**
   * `age()` is signed int4 and goes negative on a standby or after
   * `pg_resetwal`. In SQL, `2147483647 - (-1)::int` is
   * `ERROR: integer out of range` — verified on 17.11 — which would fail the
   * whole check rather than one row. Deriving the subtraction here is what
   * makes that unreachable, so this is the test that would notice the
   * arithmetic moving back into the query.
   */
  it('survives a negative age, which SQL int4 arithmetic would not', () => {
    const { relations } = toAutovacuumDanger([
      { relation: 'public.standby', xact_age: -1, total: 1 },
    ]);
    expect(relations[0]!.txnsRemaining).toBe(HARD_LIMIT + 1);
  });

  it('reads truncation from the pre-LIMIT total, not the row count', () => {
    expect(toAutovacuumDanger([{ relation: 'public.t', xact_age: 5, total: 400 }]))
      .toMatchObject({ total: 400, truncated: true });
  });

  it('returns an empty list and a zero total for a database with no tables', () => {
    expect(toAutovacuumDanger([])).toEqual({ relations: [], total: 0, truncated: false });
  });

  /**
   * Ruling 1, and the reason it is a ruling rather than §2.2's default:
   * #44 `wraparound` reads `pg_database.datfrozenxid`, the minimum over every
   * relation, so it already alarms on anything this list could find. A second
   * set of thresholds would badge one fact twice and the two would disagree
   * as soon as either was tuned.
   */
  it('ships no verdict, because #44 owns the wraparound alarm', () => {
    expect(autovacuumDanger.verdict).toBeUndefined();
    expect(autovacuumDanger.thresholds).toBeUndefined();
  });
});

describe('toVacuumProgress', () => {
  /**
   * The `initializing` phase reports `heap_blks_total = 0`. A vacuum that has
   * just started is the most likely one to be looked at, and `0%` there reads
   * as "stuck" rather than "not yet measured".
   */
  it('reports an unknown total as a null percentage, never zero', () => {
    const { vacuums } = toVacuumProgress([
      { pid: 42, phase: 'initializing', relation: 'public.t',
        blks_total: '0', blks_scanned: '0' },
    ]);
    expect(vacuums[0]!.pctScanned).toBeNull();
    expect(vacuums[0]!.blksTotal).toBe(0);
  });

  it('reports a genuine zero percent once the total is known', () => {
    const { vacuums } = toVacuumProgress([
      { pid: 42, phase: 'scanning heap', relation: 'public.t',
        blks_total: '1000', blks_scanned: '0' },
    ]);
    expect(vacuums[0]!.pctScanned).toBe(0);
  });

  it('converts the bigint block counts, which arrive as text', () => {
    const { vacuums } = toVacuumProgress([
      { pid: 7, phase: 'scanning heap', relation: 'public.big',
        blks_total: '8000000000', blks_scanned: '2000000000' },
    ]);
    expect(vacuums[0]!.blksTotal).toBe(8_000_000_000);
    expect(vacuums[0]!.blksScanned).toBe(2_000_000_000);
    expect(vacuums[0]!.pctScanned).toBe(25);
  });

  /**
   * The relation can vanish between the view read and the catalog join — a
   * vacuum on a table another session is dropping. `null` says we could not
   * name it; a placeholder string would claim we could.
   */
  it('keeps an unresolvable relation as null rather than naming it', () => {
    const { vacuums } = toVacuumProgress([
      { pid: 9, phase: 'vacuuming indexes', relation: null,
        blks_total: '10', blks_scanned: '5' },
    ]);
    expect(vacuums[0]!.relation).toBeNull();
    expect(vacuums[0]!.pctScanned).toBe(50);
  });

  it('returns an empty list when nothing is vacuuming, which is the normal state', () => {
    expect(toVacuumProgress([])).toEqual({ vacuums: [] });
  });

  it('ships no verdict: a running vacuum is Postgres working', () => {
    expect(vacuumProgress.verdict).toBeUndefined();
  });
});
