import { describe, expect, it } from 'vitest';
import {
  indexFlags, indexes, tableFlags, tables, toIndexes, toTables,
  type IndexRead, type IndexReadRow, type TableRead, type TableReadRow,
} from '../src/checks/catalog.js';

const row = (over: Partial<TableReadRow> = {}): TableReadRow => ({
  name: 'public.users', kind: 'table', size_bytes: '24576', heap_bytes: '8192', index_bytes: '16384',
  live_rows: '100', dead_rows: '15', vacuum_trigger: '70', inserted: '7', updated: '9', deleted: '6',
  seq_scans: '8', seq_rows: '80', idx_scans: '21', idx_rows: '21', hit_rate: '0.5',
  last_vacuum_ms: 1791786623987.664, last_analyze_ms: null, xid_age: 5, indexes: 1, unvalidated: 0, vacuuming: null,
  freeze_max_age: 200_000_000, stats_reset_ms: null, total: 1, ...over,
});
const table = (over: Partial<TableRead> = {}): TableRead => ({ ...toTables([row()]).tables[0]!, ...over });

describe('tables.map', () => {
  it('reads every counter as a number and a moment as whole milliseconds', () => {
    expect(toTables([row()])).toEqual({
      tables: [{
        name: 'public.users', kind: 'table', sizeBytes: 24576, heapBytes: 8192, indexBytes: 16384,
        liveRows: 100, deadRows: 15, vacuumTrigger: 70, inserted: 7, updated: 9, deleted: 6,
        seqScans: 8, seqRows: 80, idxScans: 21, idxRows: 21, hitRate: 0.5,
        lastVacuum: 1791786623988, lastAnalyze: null, xidAge: 5, indexes: 1, unvalidated: 0, vacuuming: null,
      }],
      total: 1, truncated: false, statsReset: null, freezeMaxAge: 200_000_000,
    });
  });

  it('keeps "no index", "no heap I/O" and "never" apart from zero', () => {
    const t = toTables([row({ idx_scans: null, idx_rows: null, hit_rate: null, last_vacuum_ms: null })]).tables[0]!;
    expect([t.idxScans, t.idxRows, t.hitRate, t.lastVacuum]).toEqual([null, null, null, null]);
  });

  // Review Focus 3.
  it('carries the true total when the cap dropped rows', () => {
    const data = toTables([row({ total: 10_000 }), row({ name: 'public.b', total: 10_000 })]);
    expect(data).toMatchObject({ total: 10_000, truncated: true });
  });

  it('is an empty catalog with no reset and no mark for a database with no tables', () => {
    expect(toTables([])).toEqual({ tables: [], total: 0, truncated: false, statsReset: null, freezeMaxAge: null });
  });

  it('is the same row after a trip through JSON, which is how the store keeps it', () => {
    expect(JSON.parse(JSON.stringify(table()))).toEqual(table());
  });
});

describe('tableFlags', () => {
  it('has nothing to say about a healthy table', () => {
    expect(tableFlags(table(), 200_000_000)).toEqual([]);
  });

  it('flags dead rows past the autovacuum trigger, but never a partitioned parent', () => {
    expect(tableFlags(table({ deadRows: 71 }), null)).toEqual(['vacuum overdue']);
    expect(tableFlags(table({ deadRows: 71, kind: 'partitioned' }), null)).toEqual([]);
  });

  it('flags transaction ID age at the freeze mark, when it knows the mark', () => {
    expect(tableFlags(table({ xidAge: 200_000_000 }), 200_000_000)).toEqual(['xid age']);
    expect(tableFlags(table({ xidAge: 200_000_000 }), null)).toEqual([]);
  });

  it('flags a table of ten thousand rows read mostly without its indexes', () => {
    const scanned = table({ liveRows: 10_000, seqScans: 10, idxScans: 90 });
    expect(tableFlags(scanned, null)).toEqual(['full scans']);
    expect(tableFlags({ ...scanned, idxScans: 190 }, null)).toEqual([]);
    expect(tableFlags({ ...scanned, liveRows: 9_999 }, null)).toEqual([]);
    // No index at all: there is nothing its scans could have used.
    expect(tableFlags({ ...scanned, idxScans: null }, null)).toEqual([]);
  });

  it('orders them most urgent first', () => {
    const t = table({ deadRows: 71, xidAge: 3e8, unvalidated: 2, vacuuming: 'scanning heap' });
    expect(tableFlags(t, 2e8)).toEqual(['vacuum overdue', 'xid age', 'not validated', 'vacuuming']);
  });
});

const indexRow = (over: Partial<IndexReadRow> = {}): IndexReadRow => ({
  name: 'public.users_email', table_name: 'public.users', columns: 'email', size_bytes: '8192', scans: '0', hit_rate: null,
  is_unique: false, is_primary: false, is_valid: true, duplicate_of: null, stats_reset_ms: 1791000000000.4, total: 1, ...over,
});
const index = (over: Partial<IndexRead> = {}): IndexRead => ({ ...toIndexes([indexRow()]).indexes[0]!, ...over });

describe('indexes.map and indexFlags', () => {
  it('reads an index with the reset its scans count from', () => {
    expect(toIndexes([indexRow({ scans: '12' })])).toEqual({
      indexes: [{
        name: 'public.users_email', table: 'public.users', columns: 'email', sizeBytes: 8192, scans: 12, hitRate: null,
        unique: false, primary: false, valid: true, duplicateOf: null,
      }],
      total: 1, truncated: false, statsReset: 1791000000000,
    });
  });

  it('calls an index never used only when dropping it could be right', () => {
    expect(indexFlags(index())).toEqual(['never used']);
    expect(indexFlags(index({ scans: 1 }))).toEqual([]);
    // It enforces a constraint whether or not anything scans it.
    expect(indexFlags(index({ unique: true }))).toEqual([]);
  });

  it('names a duplicate and an invalid index, and does not also call an invalid one unused', () => {
    expect(indexFlags(index({ duplicateOf: 'public.users_email_2', scans: 9 }))).toEqual(['duplicate']);
    expect(indexFlags(index({ valid: false }))).toEqual(['invalid']);
  });
});

describe('the two reads', () => {
  it('are captured, never polled, with ten seconds each', () => {
    for (const c of [tables, indexes]) expect([c.class, c.timeoutMs]).toEqual(['captured', 10_000]);
    expect([tables.home, indexes.home]).toEqual(['table', 'index']);
  });

  it('take a search literally: a percent sign is a percent sign', () => {
    const { values } = (tables.sql as (o: { search: string }) => { values: unknown[] })({ search: '100%_' });
    expect(values[2]).toBe('100\\%\\_');
  });
});
