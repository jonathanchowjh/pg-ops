import { appendFile, mkdir } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { redactSecrets } from './snapshot.js';

/**
 * Audit log for write actions (plan §G, Audit log format).
 *
 * Every kill / vacuum / run_maintenance appends one JSON record to
 * ~/.pgops/audit.log by default. The audit log is the mitigation for the
 * "malicious operator" threat — we don't add new attack surface, we make the
 * existing power traceable.
 */
export interface AuditRecord {
  timestamp: string;
  user: string;
  action: string;
  subcommand: string;
  target: Record<string, unknown>;
  reason?: string;
  result: string;
}

export function defaultAuditPath(): string {
  return process.env.PGOPS_AUDIT_LOG ?? join(homedir(), '.pgops', 'audit.log');
}

/** Best-effort identity for the audit record (e.g. "alice@bastion-host"). */
export function currentActor(): string {
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return process.env.USER ?? 'unknown';
    }
  })();
  return `${user}@${process.env.HOSTNAME ?? 'localhost'}`;
}

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

  await mkdir(dirname(path), { recursive: true });
  // Redact in case a password leaked into a reason/error string.
  await appendFile(path, `${redactSecrets(JSON.stringify(full))}\n`, 'utf8');
}
