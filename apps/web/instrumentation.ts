/**
 * Next calls `register()` once per server instance — and for the EDGE runtime
 * as well as the node one, where `pg` cannot run. The guard is not optional.
 *
 * It also fires on every dev-server restart, which is why `migrate` is
 * forward-only and idempotent: re-running is the normal case here, not the
 * exceptional one.
 *
 * The imports are dynamic and INSIDE the guard so that `pg` and the store
 * modules are never pulled into an edge bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const [{ startScheduler }, { storePool }, { contextFor, databaseNames, ownStatementsTotal }, checks] =
    await Promise.all([
      import('./lib/scheduler'),
      import('./lib/store'),
      import('./lib/pools'),
      import('@pgops/checks'),
    ]);

  // A backstop, and named honestly as one. `startScheduler` already swallows
  // the only failure it realistically has (see its I1 note), and
  // `databaseNames()` is wrapped where it is actually called, inside `names`.
  // What this catches is anything startScheduler grows later — register() is
  // awaited by Next during server preparation, so an escape here is the whole
  // console failing to boot over an OPTIONAL history store.
  /** This process's own-statement total at each database's last stored health row. */
  const ownAtLastRow = new Map<string, number>();
  try {
    const store = storePool(process.env);
    if (store === null) {
      console.info('[pgops] PGOPS_STORE_URL is not set; history is disabled and no DDL will run.');
      return;
    }
    await startScheduler({
      store,
      names: () => {
        // Configuration is read per TICK, not once at boot: PGOPS_CONFIG_FILE
        // points at a mounted file that can change without the container
        // restarting, and the whole configuration model is "read at request
        // time, not build time".
        try {
          return databaseNames();
        } catch {
          return [];
        }
      },
      capture: async (name) => {
        const ctx = await contextFor(name);
        const outcome = await checks.captureOnce(ctx, name);
        // AFTER the capture's transaction has committed, never inside it:
        // captureOnce holds one store client across two scans and a prune in
        // a single transaction, and these are 21 catalog scans each allowed
        // ten seconds. Its own failures are swallowed by contract, and the
        // capture's outcome is what the scheduler reports on — a hygiene pass
        // that could not run leaves the previous findings in the cache with
        // their own age, which the triage line renders as stale.
        await checks.captureHygiene(ctx, name);
        return outcome;
      },
      health: async (name) => {
        const ctx = await contextFor(name);
        const total = ownStatementsTotal(name);
        const prev = ownAtLastRow.get(name);
        const outcome = await checks.captureHealth(ctx, name, prev === undefined ? null : total - prev);
        // Move the mark only when a row was written (or there was no mark):
        // a skipped tick's statements belong to the next row, not to nobody.
        if (outcome.ok === true || prev === undefined) ownAtLastRow.set(name, total);
        return outcome;
      },
      migrate: checks.migrate,
    });
  } catch (err) {
    console.error(
      '[pgops] scheduler failed to start; history is disabled for this process: %s',
      (err as Error)?.message ?? err,
    );
  }
}
