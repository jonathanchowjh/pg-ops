import { render } from 'ink';
import type { ReactElement } from 'react';
import { closePool, ConnectionError, getPool, safeTarget } from './connection.js';
import { buildSnapshot } from './snapshot.js';

/**
 * The one view runner, shared by every subcommand (deep-review root cause).
 *
 * `runHome`/`runLocks`/`runTop`/`runSessions` each hand-rolled the same four
 * steps — getPool + ConnectionError preamble, `safeTarget`, the `--snapshot`
 * one-shot, `closePool()` — and each drifted: `home --snapshot` exited 0 where
 * the others exited 1 (I1). One implementation, one exit-code contract.
 *
 * `--snapshot` is the machine-readable surface
 * (`pgops --snapshot > incident.md || page-someone`), so:
 *   - the markdown always goes to stdout (it names the failure honestly), and
 *   - a run that measured nothing exits 1, whether the fetch REJECTED (locks,
 *     top, sessions) or RESOLVED with every panel failed (the cockpit, whose
 *     `fetchTriage` never rejects by design).
 */

/** One-shot result: the markdown body, plus the reason nothing could be measured. */
export interface OneShot {
  /** Markdown body for the snapshot envelope. Printed even on failure. */
  body: string;
  /**
   * Set when the poll resolved but measured nothing (the cockpit's all-panels-
   * failed case). The body is still printed; the process exits 1.
   */
  failure?: string;
}

export interface RunViewOptions {
  /** Snapshot/status-bar label, e.g. "locks", "triage". */
  subcommand: string;
  connectionString?: string;
  /** `--snapshot`: print the markdown to stdout and exit, no TUI. */
  once?: boolean;
  /** The one-shot fetch + markdown body. */
  snapshot: () => Promise<OneShot>;
  /** The TUI, given the credential-free target label. */
  view: (target: string | undefined) => ReactElement;
  /** Turn a raw driver error into an actionable hint (e.g. top's pg_stat_statements). */
  mapError?: (message: string) => string;
}

export async function runView(opts: RunViewOptions): Promise<void> {
  // Fail fast with a clear message before entering the TUI.
  try {
    getPool({ connectionString: opts.connectionString });
  } catch (err) {
    if (err instanceof ConnectionError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Redact credentials from the displayed target (host/db only).
  const target = safeTarget(opts.connectionString ?? process.env.DATABASE_URL);

  if (opts.once) {
    try {
      const { body, failure } = await opts.snapshot();
      process.stdout.write(
        buildSnapshot({ subcommand: opts.subcommand, timestamp: new Date().toISOString(), target }, body) + '\n',
      );
      if (failure !== undefined) {
        process.stderr.write(`${opts.mapError ? opts.mapError(failure) : failure}\n`);
        process.exitCode = 1;
      }
    } catch (err) {
      const message = (err as Error).message;
      process.stderr.write(`${opts.mapError ? opts.mapError(message) : message}\n`);
      process.exitCode = 1;
    } finally {
      await closePool();
    }
    return;
  }

  const { waitUntilExit } = render(opts.view(target));
  await waitUntilExit();
  await closePool();
}
