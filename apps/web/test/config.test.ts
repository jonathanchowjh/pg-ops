import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, readDatabases, removeDatabase, saveDatabase, savedPath } from '@/lib/config';

function configFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'pgops-config-')), 'databases.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

/** An empty saved file, so no test reads the developer's own ~/.pgops. */
function nothingSaved(): { PGOPS_CONFIG_FILE: string } {
  return { PGOPS_CONFIG_FILE: configFile('[]') };
}

describe('readDatabases', () => {
  it('reads a single DATABASE_URL as one database named "default"', () => {
    expect(readDatabases({ ...nothingSaved(), DATABASE_URL: 'postgres://h/db' }))
      .toEqual([{ name: 'default', url: 'postgres://h/db', source: 'env' }]);
  });

  it('reads PGOPS_DATABASES as JSON', () => {
    const env = { ...nothingSaved(), PGOPS_DATABASES: '[{"name":"prod","url":"postgres://a/x"},{"name":"eu","url":"postgres://b/y"}]' };
    expect(readDatabases(env).map((d) => d.name)).toEqual(['prod', 'eu']);
  });

  /** A deployment that sets both is most likely migrating from one database to many. */
  it('prefers PGOPS_DATABASES when both are set', () => {
    const env = { ...nothingSaved(), DATABASE_URL: 'postgres://h/db', PGOPS_DATABASES: '[{"name":"prod","url":"postgres://a/x"}]' };
    expect(readDatabases(env).map((d) => d.name)).toEqual(['prod']);
  });

  /** The fleet offers to add one; an error page would leave nowhere to add it from. */
  it('is an empty list when nothing is set and nothing is saved', () => {
    expect(readDatabases(nothingSaved())).toEqual([]);
  });

  it('throws a ConfigError rather than a SyntaxError on malformed JSON', () => {
    expect(() => readDatabases({ ...nothingSaved(), PGOPS_DATABASES: '[{' })).toThrow(ConfigError);
  });

  it('rejects an entry missing a name or url', () => {
    expect(() => readDatabases({ ...nothingSaved(), PGOPS_DATABASES: '[{"name":"prod"}]' })).toThrow(ConfigError);
    expect(() => readDatabases({ ...nothingSaved(), PGOPS_DATABASES: '[{"url":"postgres://a/x"}]' })).toThrow(ConfigError);
  });

  /** Names become URL path segments (/db/[name]); a duplicate makes one unreachable. */
  it('rejects duplicate names', () => {
    const env = { ...nothingSaved(), PGOPS_DATABASES: '[{"name":"p","url":"postgres://a/x"},{"name":"p","url":"postgres://b/y"}]' };
    expect(() => readDatabases(env)).toThrow(/duplicate/i);
  });

  it('rejects a name that would not survive a URL path segment', () => {
    const env = { ...nothingSaved(), PGOPS_DATABASES: '[{"name":"a/b","url":"postgres://a/x"}]' };
    expect(() => readDatabases(env)).toThrow(ConfigError);
  });

  it('still names PGOPS_DATABASES when reached through the variable', () => {
    expect(() => readDatabases({ ...nothingSaved(), PGOPS_DATABASES: '[{"name":"bad name","url":"u"}]' }))
      .toThrow(/PGOPS_DATABASES/);
  });
});

describe('the saved file', () => {
  it('is PGOPS_CONFIG_FILE when set, else ~/.pgops/databases.json', () => {
    expect(savedPath({ PGOPS_CONFIG_FILE: '/etc/pgops.json', HOME: '/home/node' })).toBe('/etc/pgops.json');
    expect(savedPath({ HOME: '/home/node' })).toBe('/home/node/.pgops/databases.json');
  });

  it('lists after the environment\'s databases, each marked with where it is set', () => {
    const path = configFile('[{"name":"fromfile","url":"postgres://h/f"}]');
    const dbs = readDatabases({ PGOPS_CONFIG_FILE: path, DATABASE_URL: 'postgres://h/one' });
    expect(dbs).toEqual([
      { name: 'default', url: 'postgres://h/one', source: 'env' },
      { name: 'fromfile', url: 'postgres://h/f', source: 'saved' },
    ]);
  });

  it('may be empty: removing the last database leaves []', () => {
    expect(readDatabases({ PGOPS_CONFIG_FILE: configFile('[]') })).toEqual([]);
  });

  /** Neither may silently win: the operator would watch a database they did not mean. */
  it('rejects a name both the environment and the file hold, naming the file', () => {
    const path = configFile('[{"name":"default","url":"postgres://h/f"}]');
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path, DATABASE_URL: 'postgres://h/one' })).toThrow(path);
  });

  it('is nothing saved when missing at the default path', () => {
    expect(readDatabases({ HOME: mkdtempSync(join(tmpdir(), 'pgops-home-')) })).toEqual([]);
  });

  /** A mistyped mount must not read as an empty console. */
  it('is an error naming the path when PGOPS_CONFIG_FILE is missing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pgops-config-')), 'typo.json');
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).toThrow(ConfigError);
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).toThrow(path);
  });

  it('names the file when it cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgops-config-'));
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: dir })).toThrow(ConfigError);
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: dir })).toThrow(dir);
  });

  it('names the file in validation messages reached through it', () => {
    const path = configFile('[{"name":"bad name","url":"postgres://h/p"}]');
    expect(() => readDatabases({ PGOPS_CONFIG_FILE: path })).toThrow(path);
  });
});

describe('saveDatabase and removeDatabase', () => {
  it('saves to the default path, creating it owner-only, and reads it back', () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), 'pgops-home-')) };
    saveDatabase(env, { name: 'prod', url: 'postgres://u:secret@h/p' });
    saveDatabase(env, { name: 'eu', url: 'postgres://u:secret@h/e' });
    expect(readDatabases(env).map((d) => [d.name, d.source])).toEqual([['prod', 'saved'], ['eu', 'saved']]);
    expect(statSync(savedPath(env)).mode & 0o777).toBe(0o600);
    // Written beside and renamed over: nothing is left beside it.
    expect(readdirSync(join(env.HOME, '.pgops'))).toEqual(['databases.json']);
  });

  /** The mode a create sets does not apply to a file that is already there. */
  it('narrows a file that was readable by others before it writes a password into it', () => {
    const path = configFile('[]');
    chmodSync(path, 0o644);
    saveDatabase({ PGOPS_CONFIG_FILE: path }, { name: 'prod', url: 'postgres://u:secret@h/p' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  /** A file mounted on its own cannot be renamed over; this is the same path, by a directory pgops cannot write. */
  it('writes in place, narrowed, when it cannot write beside the file', () => {
    const path = configFile('[]');
    chmodSync(path, 0o644);
    chmodSync(dirname(path), 0o500);
    try {
      saveDatabase({ PGOPS_CONFIG_FILE: path }, { name: 'prod', url: 'postgres://u:secret@h/p' });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readDatabases({ PGOPS_CONFIG_FILE: path }).map((d) => d.name)).toEqual(['prod']);
      expect(readdirSync(dirname(path))).toEqual(['databases.json']);
    } finally {
      chmodSync(dirname(path), 0o700);
    }
  });

  it('refuses a name already configured, in the environment or the file', () => {
    const env = { ...nothingSaved(), DATABASE_URL: 'postgres://h/one' };
    expect(() => saveDatabase(env, { name: 'default', url: 'postgres://h/x' })).toThrow(/already configured/);
    saveDatabase(env, { name: 'prod', url: 'postgres://h/p' });
    expect(() => saveDatabase(env, { name: 'prod', url: 'postgres://h/x' })).toThrow(/already configured/);
  });

  it('refuses a name that would not survive a URL path segment, and an empty URL', () => {
    const env = nothingSaved();
    expect(() => saveDatabase(env, { name: 'a/b', url: 'postgres://h/x' })).toThrow(ConfigError);
    expect(() => saveDatabase(env, { name: 'ok', url: '' })).toThrow(ConfigError);
  });

  it('removes a saved database and leaves the environment\'s alone', () => {
    const env = { ...nothingSaved(), DATABASE_URL: 'postgres://h/one' };
    saveDatabase(env, { name: 'prod', url: 'postgres://h/p' });
    removeDatabase(env, 'prod');
    expect(readDatabases(env).map((d) => d.name)).toEqual(['default']);
    expect(JSON.parse(readFileSync(env.PGOPS_CONFIG_FILE, 'utf8'))).toEqual([]);
    expect(() => removeDatabase(env, 'default')).toThrow(/environment/);
    expect(() => removeDatabase(env, 'nope')).toThrow(ConfigError);
  });

  it('names the file when it cannot be written', () => {
    const path = configFile('[]');
    chmodSync(path, 0o444);
    chmodSync(dirname(path), 0o500);
    try {
      expect(() => saveDatabase({ PGOPS_CONFIG_FILE: path }, { name: 'x', url: 'postgres://h/x' })).toThrow(path);
    } finally {
      chmodSync(dirname(path), 0o700);
    }
  });
});
