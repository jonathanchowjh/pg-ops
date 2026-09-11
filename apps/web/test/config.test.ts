import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, readDatabases } from '@/lib/config';

function configFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'pgops-config-')), 'databases.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('readDatabases', () => {
  it('reads a single DATABASE_URL as one database named "default"', () => {
    expect(readDatabases({ DATABASE_URL: 'postgres://h/db' }))
      .toEqual([{ name: 'default', url: 'postgres://h/db' }]);
  });

  it('reads PGOPS_DATABASES as JSON', () => {
    const env = { PGOPS_DATABASES: '[{"name":"prod","url":"postgres://a/x"},{"name":"eu","url":"postgres://b/y"}]' };
    expect(readDatabases(env)).toEqual([
      { name: 'prod', url: 'postgres://a/x' },
      { name: 'eu', url: 'postgres://b/y' },
    ]);
  });

  /**
   * PGOPS_DATABASES wins. A deployment that sets both is almost certainly
   * migrating from one to many, and silently serving only the single database
   * would look like the new configuration was ignored.
   */
  it('prefers PGOPS_DATABASES when both are set', () => {
    const env = { DATABASE_URL: 'postgres://h/db', PGOPS_DATABASES: '[{"name":"prod","url":"postgres://a/x"}]' };
    expect(readDatabases(env)).toEqual([{ name: 'prod', url: 'postgres://a/x' }]);
  });

  it('throws a ConfigError naming the variable when neither is set', () => {
    expect(() => readDatabases({})).toThrow(ConfigError);
    expect(() => readDatabases({})).toThrow(/DATABASE_URL|PGOPS_DATABASES/);
  });

  it('throws a ConfigError rather than a SyntaxError on malformed JSON', () => {
    expect(() => readDatabases({ PGOPS_DATABASES: '[{' })).toThrow(ConfigError);
  });

  it('rejects an entry missing a name or url', () => {
    expect(() => readDatabases({ PGOPS_DATABASES: '[{"name":"prod"}]' })).toThrow(ConfigError);
    expect(() => readDatabases({ PGOPS_DATABASES: '[{"url":"postgres://a/x"}]' })).toThrow(ConfigError);
  });

  /**
   * Names become URL path segments (/db/[name]). A duplicate would make one of
   * them unreachable — the kind of misconfiguration that presents as "the eu
   * database shows prod's numbers", which is far worse than a startup error.
   */
  it('rejects duplicate names', () => {
    const env = { PGOPS_DATABASES: '[{"name":"p","url":"postgres://a/x"},{"name":"p","url":"postgres://b/y"}]' };
    expect(() => readDatabases(env)).toThrow(/duplicate/i);
  });

  it('rejects a name that would not survive a URL path segment', () => {
    const env = { PGOPS_DATABASES: '[{"name":"a/b","url":"postgres://a/x"}]' };
    expect(() => readDatabases(env)).toThrow(ConfigError);
  });
});

describe('PGOPS_CONFIG_FILE', () => {
  it('reads the same JSON array from a file on disk', () => {
    const path = configFile('[{"name":"prod","url":"postgres://h/prod"}]');
    expect(readDatabases({ PGOPS_CONFIG_FILE: path })).toEqual([
      { name: 'prod', url: 'postgres://h/prod' },
    ]);
  });

  it('wins over PGOPS_DATABASES and DATABASE_URL', () => {
    const path = configFile('[{"name":"fromfile","url":"postgres://h/f"}]');
    const dbs = readDatabases({
      PGOPS_CONFIG_FILE: path,
      PGOPS_DATABASES: '[{"name":"fromenv","url":"postgres://h/e"}]',
      DATABASE_URL: 'postgres://h/one',
    });
    expect(dbs.map((d) => d.name)).toEqual(['fromfile']);
  });

  it('names the file, not the variable, when the file is unreadable', () => {
    const path = join(tmpdir(), 'pgops-does-not-exist', 'databases.json');
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).toThrow(ConfigError);
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).toThrow(path);
  });

  /**
   * The discriminating test for the `source` parameter, and the reason it
   * exists at all. Every validation message in this file used to hardcode
   * "PGOPS_DATABASES". Reached through a file, each one then pointed an
   * operator at an environment variable they had not set, to explain a typo
   * in a file they had — the single worst thing a configuration error can do.
   * Reverting `source` and hardcoding the string back reddens exactly this
   * test and leaves the others green.
   */
  it('names PGOPS_CONFIG_FILE in validation messages reached through the file', () => {
    const path = configFile('[{"name":"bad name","url":"postgres://h/p"}]');
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).toThrow(/PGOPS_CONFIG_FILE/);
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).not.toThrow(/PGOPS_DATABASES/);
  });

  it('still names PGOPS_DATABASES when reached through the variable', () => {
    expect(() => readDatabases({ PGOPS_DATABASES: '[{"name":"bad name","url":"u"}]' }))
      .toThrow(/PGOPS_DATABASES/);
  });
});
