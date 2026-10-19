import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

/** Image tag comes from the CI matrix; defaults to the current stable. */
export const IMAGE = `postgres:${process.env.PGOPS_TEST_PG_VERSION ?? '17'}`;

/**
 * Starts the one Postgres container for the whole `integration` run.
 *
 * Here rather than at module scope in a test file: Vitest 4 defaults
 * `isolate: true`, so every test file gets a fresh module graph and would
 * start its own container. `globalSetup` runs once per `vitest run`. The URI
 * reaches test files through `provide`/`inject`; a `process.env` handoff is
 * not guaranteed to reach forked workers.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer(IMAGE)
    // pg_stat_statements must be preloaded; several checks read it.
    .withCommand(['postgres', '-c', 'shared_preload_libraries=pg_stat_statements'])
    .start();

  project.provide('pgConnectionUri', container.getConnectionUri());

  return async () => {
    await container.stop();
  };
}
