/**
 * Next calls `register()` once per server instance — for the edge runtime as
 * well as the node one, where `pg` cannot run, so the guard is required. The
 * imports are dynamic and inside the guard so that `pg` and the store modules
 * are never pulled into an edge bundle.
 *
 * It also fires on every dev-server restart, which is why `migrate` is
 * forward-only and idempotent.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const [{ startScheduler }, { contextFor, databaseNames, storePool }, { sampleTick }, { placeTick }, checks] =
    await Promise.all([
      import('./lib/scheduler'),
      import('./lib/pools'),
      import('./lib/samples'),
      import('./lib/shapes'),
      import('@pgops/checks'),
    ]);

  // The try/catch below is a backstop: register() is awaited by Next during
  // server preparation, so an escape here is the whole console failing to
  // boot over an optional history store.
  try {
    const store = storePool(process.env);
    // No store is not a reason to stop: the sampler keeps fifteen minutes in
    // memory, and the scheduler starts nothing else without one.
    if (store === null) console.info('[pgops] PGOPS_STORE_URL is not set; history is disabled and no DDL will run.');
    await startScheduler({
      store,
      names: () => {
        // Configuration is read per tick, not once at boot: PGOPS_CONFIG_FILE
        // points at a mounted file that can change without the container
        // restarting.
        try {
          return databaseNames();
        } catch {
          return [];
        }
      },
      capture: async (name) => checks.captureOnce(await contextFor(name), name),
      health: async (name) => checks.captureHealth(await contextFor(name), name),
      migrate: checks.migrate,
      sample: sampleTick,
      place: placeTick,
    });
  } catch (err) {
    console.error(
      '[pgops] scheduler failed to start; history is disabled for this process: %s',
      checks.messageOf(err),
    );
  }
}
