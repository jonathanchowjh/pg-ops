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

  it('leaves credential-free text untouched', () => {
    expect(redactSecrets('SELECT 1 FROM users')).toBe('SELECT 1 FROM users');
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
