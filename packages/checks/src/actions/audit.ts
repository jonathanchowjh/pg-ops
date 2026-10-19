import { appendFile, mkdir } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { redactSecrets } from '../redact.js';

/** One JSON line per write action: who did what to which target, and why. */
export interface AuditRecord {
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
