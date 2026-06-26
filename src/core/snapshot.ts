/**
 * Shared snapshot exporter (plan: "Shared snapshot exporter").
 *
 * Any view serializes to markdown via the `[s]` key — paste straight into a Slack
 * incident channel or a postmortem doc. This is a cross-cutting capability, not a
 * subcommand, so it lives in core and every view reuses the same redaction path.
 */

/** Patterns that look like credentials — redacted from every snapshot (plan §G). */
const CREDENTIAL_PATTERNS: RegExp[] = [
  // any scheme://user:password@host -> mask the password (postgres, mysql, redis, ...)
  /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi,
  // key=value secrets (password, secret, token, api_key, ...)
  /\b(password|passwd|pwd|secret|token|api[_-]?key)\b(\s*[=:]\s*)(\S+)/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, (_m, pre: string, mid: string, post = '') => {
      // For the URL pattern, `post` is "@"; for key=value it's empty and `mid`
      // is the separator. Both collapse to: keep the prefix, mask the value.
      return post === '@' ? `${pre}***${post}` : `${pre}${mid}***`;
    });
  }
  return out;
}

export interface SnapshotMeta {
  /** Subcommand that produced the snapshot, e.g. "locks". */
  subcommand: string;
  /** ISO timestamp; injected so the function stays pure/testable. */
  timestamp: string;
  /** Optional host/database label (already credential-free). */
  target?: string;
}

/**
 * Wrap a view-produced markdown body with a standard header and redact secrets.
 * The view owns its body markdown; core owns the envelope + safety.
 */
export function buildSnapshot(meta: SnapshotMeta, body: string): string {
  const header = [
    `# pgops ${meta.subcommand} snapshot`,
    '',
    `- **time:** ${meta.timestamp}`,
    meta.target ? `- **target:** ${meta.target}` : undefined,
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  return redactSecrets(`${header}\n${body}\n`);
}
