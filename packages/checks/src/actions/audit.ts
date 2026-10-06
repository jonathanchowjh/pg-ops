import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { redactSecrets } from '../redact.js';

/**
 * Audit log for write actions (plan §G, Audit log format).
 *
 * Every kill / vacuum / run_maintenance appends one JSON record. This is the
 * mitigation for the "malicious operator" threat — we don't add new attack
 * surface, we make the existing power traceable. A trace nobody can find
 * defeats that purpose just as thoroughly as no trace at all, so the write
 * strategy below is deliberate: see the comment on `writeAudit`.
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

/**
 * Where a record goes when the caller names no path.
 *
 * Exported, not private, because of I4 (final review): the integration suite
 * exercises `killBackend`, which always audits, so before `vitest.config.ts`
 * set `PGOPS_AUDIT_LOG` for the integration project every `npm run test:int`
 * appended real `action: "kill"` records — real pid, real backend_start, real
 * `user@host` — to the developer's own `~/.pgops/audit.log`. That file is
 * "the mitigation for the malicious-operator threat" (see the header above),
 * and fabricated entries in it are indistinguishable from genuine ones apart
 * from a free-text `reason` any operator is free to type. kill.int.test.ts
 * asserts on this function's return value directly, so the redirection is
 * pinned by a test rather than by a config line nobody reads.
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
  // not see it and every record used to read "user@localhost" — which defeats
  // the point of the log the moment there is more than one bastion host. The
  // env var still wins where it IS set deliberately (containers, tests).
  return `${user}@${process.env.HOSTNAME || hostname()}`;
}

/**
 * JSON.stringify, hardened against the two inputs a caller's arbitrary
 * target metadata (`KillMeta.extra`, and whatever future actions pass
 * through `writeAudit`) can put in front of it: a circular reference and a
 * BigInt — both of which JSON.stringify throws on by default. Converting
 * rather than throwing means a pathological value in one field marks
 * itself and the record still gets written, instead of the WHOLE record
 * (pid, result, everything) being silently discarded because of one bad
 * field nobody meant to be there.
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
 * Writes one JSON-line audit record to TWO places: stdout, and the file at
 * `path` (default `PGOPS_AUDIT_LOG`, else `~/.pgops/audit.log`).
 *
 * The write strategy is a deliberate answer to "what happens if the write
 * fails, and does that failure surface or get swallowed" — and, after a
 * review round, to "does 'never rejects' hold for real, or only for the
 * failure mode that was easiest to imagine":
 *
 *  - stdout is treated as the record's real home: it is the channel every
 *    log shipper already reads, and (unlike the file) a container's local
 *    filesystem is not durable — the brief calls this out explicitly.
 *  - the file write is a local convenience copy on top of that, not the
 *    record's only home.
 *  - EVERY step below — serializing, writing to stdout, writing to the file
 *    — is independently wrapped, and a failure in one does not stop the
 *    others from being attempted. The first version of this function only
 *    guarded the file write; `redactSecrets(JSON.stringify(full))` and
 *    `process.stdout.write(line)` sat outside any try/catch. Both throw in
 *    ways that are not hypothetical: `process.stdout.write` throws
 *    synchronously on EPIPE the moment a caller pipes `pgops kill ... |
 *    head` and `head` exits early; `JSON.stringify` throws on a circular
 *    reference or a BigInt, and `target` can carry caller-supplied metadata
 *    this function does not control the shape of. `safeStringify` above
 *    closes the second case by construction; the try/catch below is the
 *    net under BOTH cases regardless, because a comment promising
 *    "never rejects" is only true if nothing in the function can throw past
 *    it — see the fix-round note in the task report for why this needed a
 *    second pass.
 *  - none of these failures propagate out of `writeAudit`, because
 *    `killBackend` awaits this call from its own `finally` with no catch of
 *    its own, and a `writeAudit` that could reject there would replace a
 *    genuine `'terminated'` result with a thrown error — telling the
 *    operator the kill failed when it didn't.
 *  - but "does not propagate" is not "disappears": every catch below logs
 *    to stderr with `console.error` rather than swallowing silently — an
 *    empty catch here would recreate, for the audit log itself, the exact
 *    silent-loss failure mode this log exists to prevent for kills.
 *
 * Redacted before either write: a killed session's query is exactly the kind
 * of text `redactSecrets` exists for (see `../redact.ts`), and an audit
 * record is exactly the kind of file it warns reaches disk.
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
    // Last resort: even the hardened serializer above threw. There is no
    // line to write anywhere — surface it and stop.
    console.error('pgops: failed to serialize audit record; record was NOT written anywhere:', err);
    return;
  }

  try {
    process.stdout.write(line);
  } catch (err) {
    // e.g. EPIPE — a piped consumer (`pgops kill ... | head`) exited early.
    // The file write below is attempted regardless; this is not fatal to it.
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
 * Result of `readRecentAudit`: the records, and why the file could not be
 * read when it couldn't.
 *
 * `unreadable` carries the SAME distinction `locksUnavailable` carries for
 * the lock graph (apps/web/lib/stuck.ts): "no history" and "could not read
 * the history" must never collapse onto one empty-looking panel, because
 * this log is the only record of who terminated what — an operator reading
 * silence here is an operator concluding nothing was done, when in fact the
 * accountability trail is the thing that broke. A missing file (ENOENT) is
 * legitimately an empty history and stays `null`; anything else that keeps
 * the read from happening — a permission error, a directory where a file
 * should be, any other I/O error — is said, not swallowed.
 */
export interface RecentAudit {
  records: AuditRecord[];
  /** Null when the file was read (or was simply absent). Otherwise a short reason, e.g. an fs error code like "EACCES". */
  unreadable: string | null;
}

/**
 * The last few audit records for one database, newest first.
 *
 * Reads the same file `writeAudit` appends to, so there is no second copy of
 * the record and nothing to keep in step. Per host: a console with several
 * replicas sees only its own file, and the page that renders this says so.
 * Never throws — a missing file is an empty history, a corrupt line is
 * skipped — because it renders on the incident page and must not take it
 * down. A read failure that is NOT a missing file is reported through
 * `unreadable` rather than folded into the same `[]` a clean empty history
 * produces — see `RecentAudit` above.
 */
export async function readRecentAudit(
  opts: { database: string; limit?: number; path?: string },
): Promise<RecentAudit> {
  const limit = opts.limit ?? 10;
  let text: string;
  try {
    text = await readFile(opts.path ?? defaultAuditPath(), 'utf8');
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') return { records: [], unreadable: null };
    return { records: [], unreadable: code ?? 'error' };
  }
  const out: AuditRecord[] = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    let rec: AuditRecord;
    try {
      rec = JSON.parse(line) as AuditRecord;
    } catch {
      continue;
    }
    if (rec?.target?.database !== opts.database) continue;
    out.push(rec);
  }
  return { records: out, unreadable: null };
}
