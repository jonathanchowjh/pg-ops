/**
 * Ported from src/core/snapshot.ts. Matters MORE on the web than it did in the
 * terminal: a screenshot needs a human to take it, a URL forwards itself.
 */

/**
 * Patterns that look like credentials. Two callers today: `actions/audit.ts`,
 * which runs this over the serialised audit record before writing it, and
 * apps/web's `Sql` component, which runs it over every query the console
 * renders (spec §7.3 — every rendered query, not just exports).
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
  //
  // The value was `\S+`, which stops at the first space — so a quoted secret
  // with a space in it printed its own tail: `password = 'hunter two'` became
  // `password = *** two'`. A quoted value is scanned to its closing quote
  // instead (doubled quotes consumed as one unit, as in the SQL rule below),
  // with the close optional so a literal clipped by track_activity_query_size
  // does not fall through to the space-terminated branch. An UNQUOTED value
  // still ends at the first space: nothing in the text says where it stops,
  // and eating to end-of-line would redact ordinary SQL along with it.
  {
    pattern: new RegExp(
      String.raw`\b${KEYS}\b(\s*[=:](?!:)\s*)(?:'(?:[^'\n]|'')*'?|"(?:[^"\n]|"")*"?|\S+)`,
      'gi',
    ),
    replacement: '$1$2***',
  },
  // The SQL spelling, which has no separator at all and so slipped through the
  // rule above: ALTER USER app PASSWORD 'hunter2', CREATE ROLE … ENCRYPTED
  // PASSWORD E'…'. This is the exact statement that gets caught in flight in
  // pg_stat_activity.query and rendered by the console. Anchored on a quoted
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
  // worst, mask the rest of ITS line — never swallow the remainder of a
  // document up to some unrelated apostrophe. That scoping is deliberate and
  // stays.
  //
  // The consequence, stated plainly because it is the CALLER's to handle: a
  // secret that a newline splits across two lines gets only its first line
  // masked — `PASSWORD 'hun\nter2'` becomes `PASSWORD ***\nter2'`. Whole-
  // literal redaction requires single-line input, and this function does not
  // normalise its argument. Both callers today satisfy that: `actions/audit.ts`
  // passes a JSON string, in which a real newline is already escaped to the two
  // characters `\n`, and apps/web's `Sql` component collapses whitespace before
  // calling (see the comment there — an earlier version of it did not, which is
  // how this was found). An earlier version of THIS comment cited
  // `core/format.ts`'s `truncateQuery` as the guarantee; P1b deleted that file
  // along with the terminal UI, and the guarantee went with it.
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
