import type { Pool } from 'pg';
import { MIGRATION_LOCK_KEY, withAdvisoryLock } from './lock.js';
import { SQL as M001 } from './migrations/001-initial.js';

/**
 * Forward-only, numbered, idempotent. No migration framework — the list is
 * the framework, and `packages/checks` keeps exactly one dependency.
 *
 * Every entry must be safe to run against a store already at that version:
 * `register()` fires on every dev-server restart, so re-running is the normal
 * case rather than the exceptional one.
 */
const MIGRATIONS: readonly string[] = [M001];

/** The version this build knows how to produce. */
export const CURRENT_VERSION = MIGRATIONS.length;

/**
 * Bring `store` to CURRENT_VERSION and return the version now in force.
 *
 * Held under a session advisory lock so N replicas booting together migrate
 * once. Each migration and its version bump are ONE transaction: a migration
 * that half-applied and still recorded its version would leave a store that
 * reports healthy and is not.
 */
export async function migrate(store: Pool): Promise<number> {
  return withAdvisoryLock(store, MIGRATION_LOCK_KEY, async (client) => {
    // Bootstrap: the version table lives inside migration 001, so the very
    // first run has nowhere to read a version from. `to_regclass` answers
    // without throwing, unlike a SELECT against a missing relation.
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
    return MIGRATIONS.length;
  });
}
