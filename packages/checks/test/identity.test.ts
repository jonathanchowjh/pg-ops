import { describe, expect, it } from 'vitest';
import { identity } from '../src/checks/identity.js';

/**
 * `map` renames, derives the display version, and enforces one rule — and
 * that rule is why this file exists: every field is nullable, and `null`
 * means "we could not look". The dangerous mistake here is not a crash — it
 * is `false` and `null` collapsing into each other, in either direction, on a
 * status line an operator reads before pressing a kill button.
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

  /**
   * `pg_stat_ssl` has no row for this backend — an unsupported build, or a
   * catalog we could not read. Reporting that as "not encrypted" invents a
   * finding out of an absence, which is the one thing this console promises
   * never to do.
   */
  it('keeps an unknown ssl status null rather than calling it insecure', () => {
    expect(identity.map([{ ...row, ssl: null }]).ssl).toBeNull();
  });

  /**
   * The same confusion in the opposite, quieter direction: written `?? null`
   * this passes, written `|| null` a genuinely unencrypted connection reads
   * as "unknown" and nobody investigates it. `false` is a finding, not an
   * absence.
   */
  it('keeps a known-unencrypted connection false rather than unknown', () => {
    expect(identity.map([{ ...row, ssl: false }]).ssl).toBe(false);
  });

  /**
   * A scalar SELECT always returns one row, so this is unreachable through
   * the check's own SQL. It is pinned anyway because `map` is a pure
   * function this package exports: it must degrade to "we could not look"
   * rather than throwing on a shape the type system already permits.
   */
  it('reports every field unknown when there is no row at all', () => {
    expect(identity.map([])).toEqual({
      database: null, user: null, serverVersion: null, replica: null, ssl: null,
    });
  });

  /**
   * `server_version_num` is major * 10000 + minor. The display form is
   * derived rather than taken from `current_setting('server_version')`,
   * which on the packaged builds most operators run answers
   * `16.4 (Debian 16.4-1.pgdg120+1)` — a vendor suffix in the status bar.
   * The pre-10 scheme (9.6 = 90600, where the major is two components) is
   * not handled and does not need to be: this project floors at 14.
   */
  it('formats the version from its numeric form', () => {
    const v = (n: string) => identity.map([{ ...row, server_version_num: n }]).serverVersion;
    expect(v('170002')).toBe('17.2');
    expect(v('140012')).toBe('14.12');
    expect(v('180000')).toBe('18.0');
  });

  it('never escalates — it is context, not a finding', () => {
    expect(identity.verdict).toBeUndefined();
  });
});
