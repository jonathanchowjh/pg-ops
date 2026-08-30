import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

/** Image tag comes from the CI matrix; defaults to the current stable. */
const IMAGE = `postgres:${process.env.PGOPS_TEST_PG_VERSION ?? '17'}`;

/**
 * Starts the one Postgres container for the whole `integration` run.
 *
 * A module-level `let container` in a test file looks like "one per worker"
 * but isn't: Vitest 4 defaults `isolate: true`, which gives every test FILE
 * its own fresh module graph, so module-scope state never survives past the
 * file that set it. Ten-plus integration files times a four-version CI
 * matrix would have multiplied that into dozens of containers per run.
 *
 * `globalSetup` runs once per `vitest run`, in Vitest's main process, before
 * any test file's module graph is created — regardless of isolate/pool
 * settings — so it is the one place a "start once" guarantee actually holds.
 * The container's connection URI is handed to every test file through
 * `provide`/`inject`, the supported channel for this (a `process.env`
 * handoff is not guaranteed to reach forked worker processes).
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
