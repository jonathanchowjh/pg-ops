import { describe, expect, it } from 'vitest';
import { databaseActivity } from '../src/checks/database-activity.js';

describe('databaseActivity.map', () => {
  it('parses bigint text into numbers', () => {
    const d = databaseActivity.map([{ xact_commit: '12', xact_rollback: '1', deadlocks: '0', conflicts: '0',
      temp_files: '0', temp_bytes: '0', blks_read: '5', blks_hit: '95', tup_returned: '1', tup_fetched: '1',
      tup_inserted: '1', tup_updated: '1', tup_deleted: '1', stats_reset: null,
      sampled_at: '2026-01-01 00:00:00+00' }]);
    expect(d.xactCommit).toBe(12);
    expect(d.statsResetAt).toBeNull();
    expect(d.sampledAt).toBe('2026-01-01 00:00:00+00');
  });
});
