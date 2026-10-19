import { describe, it, expect } from 'vitest';
import { normalise, redactSecrets, statementShape } from '../src/redact.js';

describe('redactSecrets', () => {
  it('masks the password in a postgres URL', () => {
    expect(redactSecrets('postgres://app:hunter2@db:5432/x')).toBe('postgres://app:***@db:5432/x');
  });

  it('masks the password in non-postgres URLs (mysql, redis, ...)', () => {
    expect(redactSecrets('mysql://root:hunter2@10.0.0.1')).toBe('mysql://root:***@10.0.0.1');
    expect(redactSecrets('redis://user:s3cret@cache:6379')).toBe('redis://user:***@cache:6379');
  });

  it('masks key=value style secrets', () => {
    expect(redactSecrets('password=hunter2')).toContain('***');
    expect(redactSecrets('password=hunter2')).not.toContain('hunter2');
  });

  it('masks the SQL spelling, which has no separator at all', () => {
    // Caught in flight in pg_stat_activity.query and rendered on screen.
    expect(redactSecrets("ALTER USER app PASSWORD 'hunter2'")).toBe("ALTER USER app PASSWORD ***");
    expect(redactSecrets("CREATE ROLE r LOGIN ENCRYPTED PASSWORD 'hunter2'")).not.toContain('hunter2');
    expect(redactSecrets('ALTER USER app PASSWORD "hunter2"')).not.toContain('hunter2');
  });

  it('masks a password caught in flight in a rendered query', () => {
    expect(redactSecrets("ALTER USER app PASSWORD 'hunter2'"))
      .toBe('ALTER USER app PASSWORD ***');
  });

  describe('SQL literal forms that leaked (final review)', () => {
    it("masks a password containing a doubled quote ('hun''ter2')", () => {
      // A `[^']*'` rule stops at the first inner quote and prints the tail:
      // `PASSWORD ***'ter2'`.
      const out = redactSecrets("ALTER USER app PASSWORD 'hun''ter2'");
      expect(out).toBe('ALTER USER app PASSWORD ***');
      expect(out).not.toContain('ter2');
    });

    it("masks a backslash-escaped quote in an E'' escape string", () => {
      // Same tail-leak shape as the doubled-quote case.
      const out = redactSecrets("CREATE ROLE r LOGIN ENCRYPTED PASSWORD E'hun\\'ter2'");
      expect(out).toBe('CREATE ROLE r LOGIN ENCRYPTED PASSWORD ***');
      expect(out).not.toContain('ter2');
    });

    it('masks a dollar-quoted literal (PASSWORD $$hunter2$$ / $tag$…$tag$)', () => {
      expect(redactSecrets('ALTER USER app PASSWORD $$hunter2$$')).toBe('ALTER USER app PASSWORD ***');
      expect(redactSecrets('ALTER USER app PASSWORD $pw$hunter2$pw$')).toBe('ALTER USER app PASSWORD ***');
      expect(redactSecrets('ALTER USER app PASSWORD $$hunter2$$')).not.toContain('hunter2');
    });

    it('masks a literal clipped by track_activity_query_size (no closing delimiter)', () => {
      // pg_stat_activity.query is clipped at 1024 bytes by default, so the
      // rendered statement may have no closing quote.
      expect(redactSecrets("ALTER USER app PASSWORD 'hunter2")).toBe('ALTER USER app PASSWORD ***');
      expect(redactSecrets('ALTER USER app PASSWORD $$hunter2')).toBe('ALTER USER app PASSWORD ***');
      expect(redactSecrets('ALTER USER app PASSWORD "hunter2')).toBe('ALTER USER app PASSWORD ***');
    });
  });

  /** The tool's job is showing the query; a redaction rule must not mangle ordinary SQL. */
  describe('does not over-redact ordinary SQL', () => {
    it('leaves credential-free text untouched', () => {
      expect(redactSecrets('SELECT 1 FROM users')).toBe('SELECT 1 FROM users');
    });

    it('leaves a `::` type-cast alone — it is not a key/value separator', () => {
      // Treating the first `:` of `::` as a separator renders
      // `SELECT secret:*** FROM vault`.
      expect(redactSecrets('SELECT secret::text FROM vault')).toBe('SELECT secret::text FROM vault');
      expect(redactSecrets('SELECT token::uuid, api_key::text FROM keys')).toBe(
        'SELECT token::uuid, api_key::text FROM keys',
      );
    });

    it('masks a quoted key=value secret that contains a space', () => {
      // A `\\S+` value rule stops at the first space and prints the rest of
      // the password: `password = *** two'`.
      expect(redactSecrets("password = 'hunter two'")).toBe('password = ***');
      expect(redactSecrets("password='hunter two'")).toBe('password=***');
      expect(redactSecrets('password = "hunter two"')).toBe('password = ***');
      expect(redactSecrets("password = 'hunter two'")).not.toContain('two');
    });

    it('still masks the key=value forms the `::` guard must not weaken', () => {
      expect(redactSecrets('password=hunter2')).toBe('password=***');
      expect(redactSecrets('token: abc123')).toBe('token: ***');
    });

    it('leaves ordinary column references and predicates readable', () => {
      const q = 'SELECT * FROM users WHERE token_expires_at < now()';
      expect(redactSecrets(q)).toBe(q);
      const q2 = 'SELECT id, secret FROM vault ORDER BY id';
      expect(redactSecrets(q2)).toBe(q2);
      const q3 = 'UPDATE api_keys SET rotated_at = now() WHERE id = 7';
      expect(redactSecrets(q3)).toBe(q3);
    });
  });

  it('leaves prose about passwords readable — only quoted literals are masked', () => {
    // Over-redacting an error message would cost the operator the diagnosis.
    expect(redactSecrets('password authentication failed for user "app"')).toBe(
      'password authentication failed for user "app"',
    );
  });

  describe('coverage: gaps in comment-documented behavior', () => {
    it('unquoted key=value stops at space and leaves trailing content intact', () => {
      // Breaks if rule 2's \S+ becomes .*, which would redact ordinary SQL
      // to end of line.
      const result = redactSecrets('password=hunter2 AND user=x');
      expect(result).toBe('password=*** AND user=x');
      expect(result).toContain('AND user=x');
    });

    it('dollar-quote tag back-reference prevents matching at competing tags', () => {
      // Breaks if rule 4 loses its \3 back-reference: `$tag$…$tag$` must end
      // at its own tag, not at some other `$…$`.
      const result = redactSecrets('ALTER USER app PASSWORD $tag$a$other$b$tag$');
      expect(result).toBe('ALTER USER app PASSWORD ***');
      expect(result).not.toContain('a$other$b');
    });

    it('doubled-quote in key=value form (rule 2) is handled correctly', () => {
      // Breaks if (?:[^'\n]|'')* is removed from rule 2.
      const result = redactSecrets("password='hun''ter2' AND x=1");
      expect(result).toBe("password=*** AND x=1");
      expect(result).not.toContain('ter2');
    });

    it('multi-line: unterminated literal masks only its own line', () => {
      // Breaks if [^'\n] becomes [^']: an unterminated literal would swallow
      // to a later stray apostrophe.
      const result = redactSecrets("ALTER USER app PASSWORD 'hunter2\nSELECT 1 FROM 'users'");
      expect(result).toContain("ELECT 1 FROM 'users'");
      expect(result).not.toContain('hunter2');
    });

    it('all keyword forms are positively redacted: passwd', () => {
      expect(redactSecrets('passwd=secret123')).not.toContain('secret123');
      expect(redactSecrets('passwd=secret123')).toContain('***');
    });

    it('all keyword forms are positively redacted: pwd', () => {
      expect(redactSecrets('pwd=hunter2')).not.toContain('hunter2');
      expect(redactSecrets('pwd=hunter2')).toContain('***');
    });

    it('all keyword forms are positively redacted: secret', () => {
      expect(redactSecrets('secret=abc123')).not.toContain('abc123');
      expect(redactSecrets('secret=abc123')).toContain('***');
    });

    it('all keyword forms are positively redacted: api_key', () => {
      expect(redactSecrets('api_key=key123')).not.toContain('key123');
      expect(redactSecrets('api_key=key123')).toContain('***');
    });

    it('all keyword forms are positively redacted: api-key (hyphen spelling)', () => {
      expect(redactSecrets('api-key=key123')).not.toContain('key123');
      expect(redactSecrets('api-key=key123')).toContain('***');
    });
  });
});

describe('normalise', () => {
  it('makes every literal a placeholder, as pg_stat_statements prints a shape', () => {
    expect(normalise("SELECT * FROM u WHERE email = 'jo@x.com' AND ssn = '123-45-6789'"))
      .toBe('SELECT * FROM u WHERE email = $1 AND ssn = $2');
    expect(normalise("INSERT INTO u (email, password) VALUES ('a@b','hunter2')"))
      .toBe('INSERT INTO u (email, password) VALUES ($1,$2)');
    expect(normalise("SET access_token = 'eyJabc'")).toBe('SET access_token = $1');
    expect(normalise("UPDATE t SET client_secret='s3cr3t' WHERE id = 42")).toBe('UPDATE t SET client_secret=$1 WHERE id = $2');
  });

  it('numbers on from the highest placeholder already there', () => {
    expect(normalise("SELECT $1, 'x', $3")).toBe('SELECT $1, $4, $3');
  });

  it('reads every spelling of a string as one literal', () => {
    expect(normalise("SELECT 'it''s', E'a\\'b', B'101', X'ff', N'n', U&'d\\0061'")).toBe('SELECT $1, $2, $3, $4, $5, $6');
    expect(normalise("SELECT $$a'b$$, $fn$ x $$ y $fn$")).toBe('SELECT $1, $2');
  });

  it('casts the placeholder of a typed literal, which a type before a placeholder would not parse as', () => {
    expect(normalise("SELECT now() - interval '1 day', date '2026-01-01', timestamp with time zone 'x' FROM t"))
      .toBe('SELECT now() - $1::interval, $2::date, $3::timestamp with time zone FROM t');
    expect(normalise("SELECT x FROM t WHERE a LIKE 'b%' AND c = 'd'")).toBe('SELECT x FROM t WHERE a LIKE $1 AND c = $2');
  });

  it('masks a literal cut short by track_activity_query_size to the end', () => {
    expect(normalise("SELECT * FROM u WHERE token = 'eyJhbGciOiJIUzI1")).toBe('SELECT * FROM u WHERE token = $1');
  });

  it('leaves identifiers, quoted identifiers and their digits alone', () => {
    expect(normalise('SELECT "pass""word", t1.c2, a$b FROM s1.t1')).toBe('SELECT "pass""word", t1.c2, a$b FROM s1.t1');
  });

  it('replaces every kind of number, and a number is never half an identifier', () => {
    expect(normalise('SELECT 1, 1.5, .5, 1e3, 0xff, 1_000 FROM t2 LIMIT 10 OFFSET 20'))
      .toBe('SELECT $1, $2, $3, $4, $5, $6 FROM t2 LIMIT $7 OFFSET $8');
  });

  it('keeps what is part of the statement\'s shape and not data: a type\'s size, a sort by position', () => {
    expect(normalise("SELECT x::numeric(10, 2), y::varchar(20), z::character varying(5) FROM t ORDER BY 1 DESC, 2"))
      .toBe('SELECT x::numeric(10, 2), y::varchar(20), z::character varying(5) FROM t ORDER BY 1 DESC, 2');
    expect(normalise('SELECT a, count(*) FROM t GROUP BY 1 HAVING count(*) > 5')).toBe('SELECT a, count(*) FROM t GROUP BY 1 HAVING count(*) > $1');
  });

  it('drops a line comment, so the text flattens to one line without losing its tail, and keeps a block comment', () => {
    expect(normalise("SELECT id -- 'the key'\nFROM t /* app:web */ WHERE id = 7")).toBe('SELECT id \nFROM t /* app:web */ WHERE id = $1');
    expect(normalise("SELECT '-- not a comment', 1")).toBe('SELECT $1, $2');
  });
});

describe('statementShape', () => {
  it('is the shape on one line, with what redaction catches outside a literal masked', () => {
    expect(statementShape("SELECT *\n  FROM u -- pw 'x'\n WHERE password = 'hunter2'")).toBe('SELECT * FROM u WHERE password = $1');
    expect(statementShape('/* postgres://app:hunter2@db/x */ SELECT 1')).toBe('/* postgres://app:***@db/x */ SELECT $1');
  });

  it('leaves a placeholder after a credential key readable: it is not a secret', () => {
    expect(redactSecrets('WHERE password = $1')).toBe('WHERE password = $1');
    expect(redactSecrets('password=hunter2')).not.toContain('hunter2');
  });
});
