import { describe, expect, it } from 'vitest';
import { buildSnapshot, redactSecrets } from './snapshot.js';

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
    // The statement this actually has to catch: caught in flight in
    // pg_stat_activity.query and rendered straight onto the cockpit (I3).
    expect(redactSecrets("ALTER USER app PASSWORD 'hunter2'")).toBe("ALTER USER app PASSWORD ***");
    expect(redactSecrets("CREATE ROLE r LOGIN ENCRYPTED PASSWORD 'hunter2'")).not.toContain('hunter2');
    expect(redactSecrets('ALTER USER app PASSWORD "hunter2"')).not.toContain('hunter2');
  });

  /**
   * The three literal forms a final-review fuzz run got REAL secrets out of.
   * Pinned: each one reached the cockpit screen and the snapshot file.
   */
  describe('SQL literal forms that leaked (final review)', () => {
    it("masks a password containing a doubled quote ('hun''ter2')", () => {
      // The old rule's `[^']*'` stopped at the first INNER quote: it masked
      // `'hun'` and printed the tail — `PASSWORD ***'ter2'`.
      const out = redactSecrets("ALTER USER app PASSWORD 'hun''ter2'");
      expect(out).toBe('ALTER USER app PASSWORD ***');
      expect(out).not.toContain('ter2');
    });

    it("masks a backslash-escaped quote in an E'' escape string", () => {
      // The other way to put a quote in a password — and the form the `E` prefix
      // exists for. Same tail-leak shape as the doubled-quote case.
      const out = redactSecrets("CREATE ROLE r LOGIN ENCRYPTED PASSWORD E'hun\\'ter2'");
      expect(out).toBe('CREATE ROLE r LOGIN ENCRYPTED PASSWORD ***');
      expect(out).not.toContain('ter2');
    });

    it('masks a dollar-quoted literal (PASSWORD $$hunter2$$ / $tag$…$tag$)', () => {
      // Dollar-quoting is valid for PASSWORD and had zero coverage.
      expect(redactSecrets('ALTER USER app PASSWORD $$hunter2$$')).toBe('ALTER USER app PASSWORD ***');
      expect(redactSecrets('ALTER USER app PASSWORD $pw$hunter2$pw$')).toBe('ALTER USER app PASSWORD ***');
      expect(redactSecrets('ALTER USER app PASSWORD $$hunter2$$')).not.toContain('hunter2');
    });

    it('masks a literal clipped by track_activity_query_size (no closing delimiter)', () => {
      // pg_stat_activity.query is CLIPPED at 1024 bytes by default, so the
      // statement the cockpit renders often has no closing quote at all.
      expect(redactSecrets("ALTER USER app PASSWORD 'hunter2")).toBe('ALTER USER app PASSWORD ***');
      expect(redactSecrets('ALTER USER app PASSWORD $$hunter2')).toBe('ALTER USER app PASSWORD ***');
      expect(redactSecrets('ALTER USER app PASSWORD "hunter2')).toBe('ALTER USER app PASSWORD ***');
    });
  });

  /**
   * The other half of the contract: the tool's core job is SHOWING you the
   * query. A redaction rule that mangles ordinary SQL destroys that, and does it
   * on the screen the operator is reading during an outage.
   */
  describe('does not over-redact ordinary SQL', () => {
    it('leaves credential-free text untouched', () => {
      expect(redactSecrets('SELECT 1 FROM users')).toBe('SELECT 1 FROM users');
    });

    it('leaves a `::` type-cast alone — it is not a key/value separator', () => {
      // The key=value rule treated the first `:` of `::` as a separator and
      // rendered `SELECT secret:*** FROM vault` on screen.
      expect(redactSecrets('SELECT secret::text FROM vault')).toBe('SELECT secret::text FROM vault');
      expect(redactSecrets('SELECT token::uuid, api_key::text FROM keys')).toBe(
        'SELECT token::uuid, api_key::text FROM keys',
      );
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
    // Over-redacting an error message ("password authentication failed for user
    // app") would cost the operator the diagnosis during an incident.
    expect(redactSecrets('password authentication failed for user "app"')).toBe(
      'password authentication failed for user "app"',
    );
  });
});

describe('buildSnapshot', () => {
  it('wraps the body with a header and redacts secrets in it', () => {
    const md = buildSnapshot(
      { subcommand: 'locks', timestamp: '2000-01-01T00:00:00Z', target: 'db/app' },
      'connect mysql://root:hunter2@h',
    );
    expect(md).toContain('# pgops locks snapshot');
    expect(md).not.toContain('hunter2');
  });
});
