/**
 * Patterns that look like credentials. Callers: `audit.ts`, over the
 * serialised audit record, and apps/web's `Sql` component, over every query
 * the console renders.
 *
 * Each rule keeps the identifying prefix and masks only the value, so the
 * reader still sees that a credential was there.
 *
 * Every rule is scoped to one line, so an unterminated literal masks at most
 * the rest of its line. A secret split across lines is therefore only masked
 * on its first line: callers must pass single-line input. audit.ts passes a
 * JSON string (newlines escaped) and `Sql` collapses whitespace first.
 *
 * A statement that is stored passes `statementShape`, which takes every
 * literal out before any of this runs.
 */
/** The credential-ish keywords every value rule keys off. */
const KEYS = String.raw`(password|passwd|pwd|secret|token|api[_-]?key)`;

const CREDENTIAL_RULES: { pattern: RegExp; replacement: string }[] = [
  // any scheme://user:password@host -> mask the password (postgres, mysql, redis, ...)
  { pattern: /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi, replacement: '$1***$3' },
  // key=value / key: value secrets (password, secret, token, api_key, ...).
  //
  // `(?!:)`: a Postgres type cast (`secret::text`) is not a key/value
  // separator. `(?!\$\d+\b)`: a placeholder is not a secret, and a shape
  // compares `password = $1`.
  //
  // A quoted value is scanned to its closing quote, doubled quotes consumed
  // as one unit, so a secret containing a space is masked whole. The close is
  // optional because track_activity_query_size can clip a literal. An
  // unquoted value ends at the first space.
  {
    pattern: new RegExp(
      String.raw`\b${KEYS}\b(\s*[=:](?!:)\s*)(?!\$\d+\b)(?:'(?:[^'\n]|'')*'?|"(?:[^"\n]|"")*"?|\S+)`,
      'gi',
    ),
    replacement: '$1$2***',
  },
  // The SQL spelling, which has no separator: ALTER USER app PASSWORD
  // 'hunter2', CREATE ROLE … ENCRYPTED PASSWORD E'…'. Anchored on a quoted
  // literal so prose ("password authentication failed for user app") is left
  // readable.
  //
  //  - `(?:[^'\n]|'')*` consumes a doubled quote (`'hun''ter2'`) as one unit,
  //    so the scan ends only at a lone quote.
  //  - `\\.` consumes a backslash escape (`E'hun\'ter2'`) as one unit. In a
  //    non-`E` literal a trailing backslash over-consumes to end of line,
  //    which masks more and cannot leak.
  //  - the closing delimiter is optional, because `pg_stat_activity.query` is
  //    clipped at `track_activity_query_size`; the fallback masks to end of
  //    line.
  {
    pattern: new RegExp(String.raw`\b${KEYS}\b(\s+)(e?'(?:[^'\\\n]|''|\\.)*'?|"(?:[^"\n]|"")*"?)`, 'gi'),
    replacement: '$1$2***',
  },
  // Dollar-quoted constants: `PASSWORD $$hunter2$$`, `PASSWORD
  // $pw$hun'ter2$pw$`. The tag is back-referenced (`\3`), so the literal ends
  // at its own tag. `m` + `$` closes a clipped literal at end of line.
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

/** A character an unquoted identifier or keyword is made of. */
const WORD = /[A-Za-z0-9_$\u0080-￿]/;
const WORD_START = /[A-Za-z_\u0080-￿]/;
/** Types whose size in parentheses is part of the statement, not data: `numeric(10, 2)`. */
const SIZED = new Set(['numeric', 'decimal', 'varchar', 'char', 'character', 'varying', 'bit', 'varbit', 'time', 'timestamp', 'interval', 'float']);
/**
 * A type written before a literal, `interval '1 day'`, at the end of what is
 * copied so far. `interval $1` does not parse, so its placeholder is cast
 * instead: `$1::interval`.
 */
const TYPED = new RegExp(String.raw`(?<![\w$.:])((?:timestamp|time)\s+with(?:out)?\s+time\s+zone|double\s+precision|`
  + String.raw`interval|date|time|timestamp|timestamptz|timetz|jsonb?|uuid|inet|cidr|numeric|decimal|int[248]?|integer|bigint|`
  + String.raw`smallint|real|float[48]?|bool(?:ean)?|text|varchar|char|bytea|money|xml|macaddr)(\s+)$`, 'i');
/** Words that may follow a position in `ORDER BY 1 DESC NULLS LAST, 2`. */
const SORT_WORDS = new Set(['asc', 'desc', 'nulls', 'first', 'last']);

/** Where a literal that starts at `i` with a quote ends, `''` and, for an `E` string, `\'` read as part of it. */
function stringEnd(text: string, i: number, backslash: boolean): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (backslash && c === '\\') { j += 2; continue; }
    if (c === "'") {
      if (text[j + 1] === "'") { j += 2; continue; }
      return j + 1;
    }
    j += 1;
  }
  return text.length;
}

/**
 * A statement as its shape: every literal a `$n` placeholder, the way
 * pg_stat_statements prints one, numbered on from the highest placeholder
 * already there. Literals are where the data is: an email, an account
 * number, a token in a `SET`. What is the shape and not data stays: a
 * type's size and a sort by position, which a generic plan needs as they
 * are. A line comment is dropped, so the text can be flattened to one line
 * without the comment swallowing the rest; a block comment stays.
 */
export function normalise(text: string): string {
  let n = 0;
  for (const m of text.matchAll(/\$(\d+)/g)) n = Math.max(n, Number(m[1]));
  const next = (): string => `$${(n += 1)}`;
  let out = '';
  /** The last word copied, lower case, and whether a sort by position is still open. */
  let word = '';
  let byList = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i, i + 3);
    if (rest.startsWith('--')) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      // Postgres nests block comments.
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text.startsWith('/*', j)) { depth += 1; j += 2; } else if (text.startsWith('*/', j)) { depth -= 1; j += 2; } else j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === '"' || (/^u&"/i.test(rest))) {
      let j = text.indexOf('"', i) + 1;
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      out += text.slice(i, Math.min(j, text.length));
      i = Math.min(j, text.length);
      word = '';
      continue;
    }
    if (c === "'" || /^[ebxn]'/i.test(rest) || /^u&'/i.test(rest)) {
      const quote = text.indexOf("'", i);
      i = stringEnd(text, quote, /^e'/i.test(rest));
      const typed = TYPED.exec(out);
      out = typed === null ? out + next() : `${out.slice(0, typed.index)}${next()}::${typed[1]!.replace(/\s+/g, ' ')}${typed[2]}`.trimEnd();
      word = '';
      byList = false;
      continue;
    }
    if (c === '$') {
      const param = /^\$\d+/.exec(text.slice(i));
      if (param !== null) {
        out += param[0];
        i += param[0].length;
        word = '';
        byList = false;
        continue;
      }
      const tag = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(text.slice(i));
      if (tag !== null) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? text.length : close + tag[0].length;
        out += next();
        word = '';
        byList = false;
        continue;
      }
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < text.length && WORD.test(text[j]!)) j += 1;
      word = text.slice(i, j).toLowerCase();
      out += text.slice(i, j);
      i = j;
      if (word === 'by') byList = true;
      else if (!SORT_WORDS.has(word)) byList = false;
      // A type's size: copied through its closing parenthesis.
      const size = SIZED.has(word) ? /^\s*\([\s\d,]*\)/.exec(text.slice(i)) : null;
      if (size !== null) {
        out += size[0];
        i += size[0].length;
      }
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const num = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i))!;
      i += num[0].length;
      out += byList && /^[0-9]+$/.test(num[0]) ? num[0] : next();
      word = '';
      continue;
    }
    if (c !== ',' && !/\s/.test(c)) byList = false;
    out += c;
    i += 1;
  }
  return out;
}

/**
 * A statement as it may be stored or shown: its shape, on one line, with
 * what redaction still finds outside a literal masked, a URL in a comment
 * among them.
 */
export function statementShape(text: string): string {
  return redactSecrets(normalise(text).replace(/\s+/g, ' ').trim());
}
