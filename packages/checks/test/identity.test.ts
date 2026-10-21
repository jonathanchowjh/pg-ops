import { describe, expect, it } from 'vitest';
import { identity } from '../src/checks/identity.js';

/**
 * Every field is nullable, and `null` means "we could not look". The mistake
 * to catch is `false` and `null` collapsing into each other, in either
 * direction.
 */
describe('identity', () => {
  const row = {
    database: 'appdb',
    user: 'postgres',
    server_version_num: '170002',
    replica: false,
    ssl: true,
  };

  it('renames the row into the domain shape', () => {
    expect(identity.map([row])).toEqual({
      database: 'appdb',
      user: 'postgres',
      serverVersion: '17.2',
      replica: false,
      ssl: true,
    });
  });

  /** `pg_stat_ssl` has no row for this backend: an absence, not a "not encrypted" finding. */
  it('keeps an unknown ssl status null rather than calling it insecure', () => {
    expect(identity.map([{ ...row, ssl: null }]).ssl).toBeNull();
  });

  /** Written `|| null` instead of `?? null`, an unencrypted connection would read as "unknown". */
  it('keeps a known-unencrypted connection false rather than unknown', () => {
    expect(identity.map([{ ...row, ssl: false }]).ssl).toBe(false);
  });

  /**
   * Unreachable through the check's own SQL, but `map` is exported and must
   * not throw on a shape its type permits.
   */
  it('reports every field unknown when there is no row at all', () => {
    expect(identity.map([])).toEqual({
      database: null, user: null, serverVersion: null, replica: null, ssl: null,
    });
  });

  /**
   * `server_version_num` is major * 10000 + minor. Derived rather than read
   * from `server_version`, which on packaged builds carries a vendor suffix
   * (`16.4 (Debian 16.4-1.pgdg120+1)`). The pre-10 scheme is not handled:
   * this project floors at 14.
   */
  it('formats the version from its numeric form', () => {
    const v = (n: string) => identity.map([{ ...row, server_version_num: n }]).serverVersion;
    expect(v('170002')).toBe('17.2');
    expect(v('140012')).toBe('14.12');
    expect(v('180000')).toBe('18.0');
  });

});
