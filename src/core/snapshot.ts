/**
 * Shared snapshot exporter (plan: "Shared snapshot exporter").
 *
 * Any view serializes to markdown via the `[s]` key — paste straight into a Slack
 * incident channel or a postmortem doc. This is a cross-cutting capability, not a
 * subcommand, so it lives in core and every view reuses the same redaction path.
 */

/**
 * Patterns that look like credentials — redacted from every snapshot (plan §G)
 * and, since the I3 fix, from every query rendered in a TUI too (core/format.ts's
 * `truncateQuery`, the chokepoint all four views share).
 *
 * Each rule keeps the identifying prefix and masks only the value, so the reader
 * still sees *that* a credential was there.
 */
/** The credential-ish keywords every value rule keys off. */
const KEYS = String.raw`(password|passwd|pwd|secret|token|api[_-]?key)`;

const CREDENTIAL_RULES: { pattern: RegExp; replacement: string }[] = [
  // any scheme://user:password@host -> mask the password (postgres, mysql, redis, ...)
  { pattern: /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi, replacement: '$1***$3' },
  // key=value / key: value secrets (password, secret, token, api_key, ...).
  //
  // `(?!:)` — a Postgres type cast is NOT a key/value separator. Without it this
  // rule turned `SELECT secret::text FROM vault` into `SELECT secret:*** FROM
  // vault` on the operator's screen (it only guarded file sinks before I3; now
  // it runs on every rendered query, so its false positives are visible).
  { pattern: new RegExp(String.raw`\b${KEYS}\b(\s*[=:](?!:)\s*)(\S+)`, 'gi'), replacement: '$1$2***' },
  // The SQL spelling, which has no separator at all and so slipped through the
  // rule above: ALTER USER app PASSWORD 'hunter2', CREATE ROLE … ENCRYPTED
  // PASSWORD E'…'. This is the exact statement that gets caught in flight in
  // pg_stat_activity.query and rendered on the cockpit. Anchored on a quoted
  // literal so ordinary prose ("password authentication failed for user app")
  // is left readable.
  //
  // Three things the final review's fuzz run got real secrets out of:
  //  - `'hun''ter2'` — a quote inside the password, doubled per SQL escaping.
  //    `[^']*'` stopped at the FIRST inner quote and printed the tail
  //    (`PASSWORD ***'ter2'`). `(?:[^'\n]|'')*` consumes doubled quotes as one
  //    unit, so the scan ends only at a LONE quote — the true terminator.
  //  - `E'hun\'ter2'` — the OTHER way to put a quote in a password, and the one
  //    the `E` prefix exists for. `\\.` consumes a backslash escape as one unit,
  //    so the escaped quote doesn't terminate the scan either. (In a non-`E`
  //    literal a trailing backslash would make this over-consume to end of the
  //    line — that direction is fail-safe: it masks more, it cannot leak.)
  //  - a literal with no closing delimiter. `pg_stat_activity.query` is clipped
  //    at `track_activity_query_size` (1024 bytes), so the statement we render
  //    is routinely cut mid-literal. The closing delimiter is therefore OPTIONAL
  //    (`'?` / `"?`): the fallback is to mask to end of line.
  //  - see the dollar-quote rule below.
  //
  // Scoped to one line (`[^'\n]`, not `[^']`) so an unterminated literal can, at
  // worst, mask the rest of ITS line — never swallow the remainder of a snapshot
  // document up to some unrelated apostrophe. Every query in a snapshot body is
  // already single-line (core/format.ts's `truncateQuery` collapses whitespace).
  {
    pattern: new RegExp(String.raw`\b${KEYS}\b(\s+)(e?'(?:[^'\\\n]|''|\\.)*'?|"(?:[^"\n]|"")*"?)`, 'gi'),
    replacement: '$1$2***',
  },
  // Dollar-quoted string constants — valid for PASSWORD and previously not
  // covered at all: `PASSWORD $$hunter2$$`, `PASSWORD $pw$hun'ter2$pw$` (the
  // form you REACH FOR precisely when the password contains a quote). The tag is
  // back-referenced (`\3`), so `$pw$…$pw$` ends at its own tag and not at some
  // other `$…$`. `m` + `$` closes an unterminated (clipped) literal at end of
  // line, same fallback as above.
  {
    pattern: new RegExp(String.raw`\b${KEYS}\b(\s+)\$([a-z0-9_]*)\$[^\n]*?(?:\$\3\$|$)`, 'gim'),
    replacement: '$1$2***',
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern, replacement } of CREDENTIAL_RULES) {
    out = out.replace(pattern, replacement);
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
