import { messageOf } from '../run.js';
import type { ActionMeta } from '../types.js';
import { writeAudit } from './audit.js';

/**
 * Run one action and write its audit record, whether it succeeded or threw.
 * Every action goes through here, so none can forget the record.
 *
 * `target` is a function because it is read after `run`: analyze names the
 * relations it got through, including on the way out of a failure. It goes
 * after `meta.extra`, so caller-supplied metadata cannot overwrite it.
 *
 * `writeAudit` never rejects, and the catch is there anyway: a throw from an
 * `await` inside a `finally` replaces the `try` block's outcome, so a
 * successful action would be reported as failed, or a real error masked.
 */
export async function audited<T>(
  action: string,
  meta: ActionMeta,
  target: () => Record<string, unknown>,
  run: () => Promise<T>,
  describe: (value: T) => string,
): Promise<T> {
  let result = 'unknown';
  try {
    const value = await run();
    result = describe(value);
    return value;
  } catch (err) {
    result = `error: ${messageOf(err)}`;
    throw err;
  } finally {
    try {
      await writeAudit({
        action,
        subcommand: meta.subcommand,
        // Truthiness, so an empty actor falls back to the default too: `??`
        // in writeAudit would keep `''`.
        ...(meta.actor ? { user: meta.actor } : {}),
        target: { ...meta.extra, ...target() },
        reason: meta.reason,
        result,
      });
    } catch (err) {
      console.error(`pgops: writeAudit threw despite its no-reject contract; ${action} outcome unaffected:`, err);
    }
  }
}
