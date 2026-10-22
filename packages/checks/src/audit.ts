import { appendFile, mkdir } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { redactSecrets } from './redact.js';
import { messageOf } from './run.js';
import type { ActionMeta } from './types.js';

/** One JSON line per write action: who did what to which target, and why. */
interface AuditRecord {
  timestamp: string;
  user: string;
  action: string;
  subcommand: string;
  target: Record<string, unknown>;
  reason?: string;
  result: string;
}

/**
 * Where a record goes when the caller names no path. The integration suite
 * sets `PGOPS_AUDIT_LOG` so test kills stay out of the developer's real log;
 * kill.int.test.ts holds this.
 */
export function defaultAuditPath(): string {
  return process.env.PGOPS_AUDIT_LOG ?? join(homedir(), '.pgops', 'audit.log');
}

/** Best-effort identity for the audit record (e.g. "alice@bastion-host"). */
function currentActor(): string {
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return process.env.USER ?? 'unknown';
    }
  })();
  // `HOSTNAME` is a shell variable, not an exported one, so Node usually does
  // not see it. It wins where it is set deliberately (containers, tests).
  return `${user}@${process.env.HOSTNAME || hostname()}`;
}

/**
 * JSON.stringify that converts a circular reference or a BigInt instead of
 * throwing, so one bad field in caller-supplied target metadata does not
 * discard the whole record.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return `${val.toString()}n`;
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  });
}

/**
 * Writes one JSON-line audit record to stdout and to the file at `path`
 * (default `PGOPS_AUDIT_LOG`, else `~/.pgops/audit.log`). stdout is the
 * record's real home, since a container's filesystem is not durable; the file
 * is a local copy.
 *
 * Never rejects. Callers await this from a `finally`, where a rejection would
 * replace a successful action's result with a thrown error. Each step is
 * wrapped separately so one failing does not stop the others, and each
 * failure is logged to stderr.
 *
 * Redacted before either write: the target can carry a session's query text.
 */
export async function writeAudit(
  record: Omit<AuditRecord, 'timestamp' | 'user'> & Partial<Pick<AuditRecord, 'timestamp' | 'user'>>,
  path = defaultAuditPath(),
): Promise<void> {
  const full: AuditRecord = {
    timestamp: record.timestamp ?? new Date().toISOString(),
    user: record.user ?? currentActor(),
    action: record.action,
    subcommand: record.subcommand,
    target: record.target,
    reason: record.reason,
    result: record.result,
  };

  let line: string;
  try {
    line = `${redactSecrets(safeStringify(full))}\n`;
  } catch (err) {
    console.error('pgops: failed to serialize audit record; record was NOT written anywhere:', err);
    return;
  }

  try {
    process.stdout.write(line);
  } catch (err) {
    // e.g. EPIPE: a piped consumer (`pgops kill ... | head`) exited early.
    console.error('pgops: failed to write audit record to stdout:', err);
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, 'utf8');
  } catch (err) {
    console.error(`pgops: failed to write audit log to ${path}:`, err);
  }
}

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
