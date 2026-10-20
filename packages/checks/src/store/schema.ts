import type { Pool } from 'pg';
import { withAdvisoryLock } from './lock.js';
import { MIGRATION_LOCK_KEY } from './write.js';
import { SQL as M001 } from './migrations/001-initial.js';
import { SQL as M002 } from './migrations/002-query-stats-query-id.js';
import { SQL as M003 } from './migrations/003-check-results.js';
import { SQL as M004 } from './migrations/004-query-load.js';
import { SQL as M005 } from './migrations/005-health-stats.js';
import { SQL as M006 } from './migrations/006-samples.js';
import { SQL as M007 } from './migrations/007-captured.js';
import { SQL as M008 } from './migrations/008-drop-check-results.js';
import { SQL as M009 } from './migrations/009-shapes.js';
import { SQL as M010 } from './migrations/010-lag-bytes.js';
import { SQL as M011 } from './migrations/011-health-lean.js';

/**
 * Forward-only, numbered, idempotent. Every entry must be safe to run
 * against a store already at that version.
 */
const MIGRATIONS: readonly string[] = [M001, M002, M003, M004, M005, M006, M007, M008, M009, M010, M011];

/** The version this build knows how to produce. */
export const CURRENT_VERSION = MIGRATIONS.length;

/**
 * Bring `store` to CURRENT_VERSION and return the version now in force.
 *
 * Held under a session advisory lock so replicas booting together migrate
 * once. Each migration and its version bump are one transaction.
 */
export async function migrate(store: Pool): Promise<number> {
  return withAdvisoryLock(store, MIGRATION_LOCK_KEY, async (client) => {
    // The version table is created by migration 001, so the first run has
    // none. `to_regclass` answers without throwing.
    const { rows: probe } = await client.query<{ present: string | null }>(
      `SELECT to_regclass('pgops.schema_version')::text AS present`,
    );
    let current = 0;
    if (probe[0]!.present !== null) {
      const { rows } = await client.query<{ version: number }>(
        'SELECT version FROM pgops.schema_version',
      );
      current = rows[0]?.version ?? 0;
    }

    for (let v = current; v < MIGRATIONS.length; v += 1) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[v]!);
        await client.query(
          `INSERT INTO pgops.schema_version (version) VALUES ($1)
             ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version`,
          [v + 1],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }

    // The store may have been migrated by a newer pgops (a rollback, or a
    // rolling deploy). An older build is not refused, because throwing would
    // turn all of its history off. Not every migration is additive, though:
    // 008 drops pgops.check_results, so a build from before it loses its
    // hygiene cache. It is logged instead.
    if (current > MIGRATIONS.length) {
      console.error(
        'pgops: store schema is at version %d but this build knows %d — '
        + 'it was migrated by a newer pgops. Some history may not work; finish the '
        + 'rollback or roll forward.',
        current, MIGRATIONS.length,
      );
    }
    return Math.max(current, MIGRATIONS.length);
  });
}
