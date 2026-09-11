import { describe, expect, it } from 'vitest';
import { connectionDetail, sslStatus } from '../src/checks/connections.js';

const row = {
  pid: 42, database: 'appdb', user: 'app', source: 'web-1',
  ip: '10.0.0.7', state: 'active', ssl: true, total_matching: 1,
};

describe('sslStatus', () => {
  it('reports an encrypted connection as SSL', () => {
    expect(sslStatus(row)).toBe('SSL');
  });

  /**
   * A backend with no database is an auxiliary process (checkpointer,
   * walwriter, autovacuum launcher). It is not an unencrypted client and
   * must not be counted as a security finding — pgHero draws exactly this
   * distinction and it is the reason this is a five-value status, not a
   * boolean.
   */
  it('reports a backend with no database as an internal process', () => {
    expect(sslStatus({ ...row, ssl: false, database: null })).toBe('Internal Process');
  });

  /**
   * No IP but a known state means a unix-socket connection: local, and not
   * meaningfully "insecure" — a fact about transport, decided before `ssl`
   * is even consulted. No IP and NO state means the query could not read
   * this backend's details at all; with `ssl` actually measured `false`
   * here, that is still an honest `'No SSL'` finding, not a socket we have
   * no evidence for.
   */
  it('separates a unix socket from a connection it cannot see', () => {
    expect(sslStatus({ ...row, ssl: false, ip: null, state: 'idle' })).toBe('Socket');
    expect(sslStatus({ ...row, ssl: false, ip: null, state: null })).toBe('No SSL');
  });

  /**
   * The two-direction pair identity.test.ts pins for its own `ssl` field,
   * held here for `sslStatus` too: NULL must never render as encrypted, and
   * — the direction that was missed until review — must equally never
   * render as a confirmed "not encrypted" finding. `ssl === null` and
   * `ssl === false` are different facts (respectively "we could not look"
   * and "we looked, and it is unencrypted") and must render as different
   * statuses, or the second question mark on the SSL breakdown panel would
   * quietly become a security finding no operator asked for.
   */
  it('does not claim encryption when ssl is unknown', () => {
    expect(sslStatus({ ...row, ssl: null })).toBe('Unknown');
  });

  it('keeps a known-unencrypted connection No SSL rather than unknown', () => {
    expect(sslStatus({ ...row, ssl: false })).toBe('No SSL');
  });
});

describe('connectionDetail', () => {
  it('lists connections, groups sources, and counts by ssl status in one pass', () => {
    const d = connectionDetail.map([
      row,
      { ...row, pid: 43, ssl: false, total_matching: 1 },
      { ...row, pid: 44, source: 'web-2', ssl: true, total_matching: 1 },
    ]);
    expect(d.connections.map((c) => c.pid)).toEqual([42, 43, 44]);
    expect(d.bySslStatus).toEqual({ SSL: 2, 'No SSL': 1 });
    // web-1 appears twice (pids 42 and 43) under one source row; web-2 once.
    expect(d.sources).toEqual([
      {
        database: 'appdb', user: 'app', source: 'web-1', ip: '10.0.0.7', connections: 2,
        key: '"appdb"\0"app"\0"web-1"\0"10.0.0.7"',
      },
      {
        database: 'appdb', user: 'app', source: 'web-2', ip: '10.0.0.7', connections: 1,
        key: '"appdb"\0"app"\0"web-2"\0"10.0.0.7"',
      },
    ]);
  });

  /**
   * Fix 4 (final review): a real `application_name` of the literal text
   * `"null"` must not collide with a genuinely NULL field under the same
   * grouping key — the hazard a plain template-literal join (`${x}`, which
   * stringifies `null` to the same four characters as the string `"null"`)
   * cannot distinguish. Two auxiliary backends (all four fields NULL) group
   * together; a client backend whose application_name is literally the text
   * "null" gets its own, different key.
   */
  it('does not collide a literal "null" application_name with a genuinely null one', () => {
    const aux = { ...row, database: null, user: null, source: null, ip: null, state: null };
    const d = connectionDetail.map([
      aux,
      { ...aux, pid: 45 },
      { ...row, pid: 46, database: null, user: null, source: 'null', ip: null, state: null },
    ]);
    expect(d.sources).toHaveLength(2);
    const [auxSource, literalSource] = d.sources;
    expect(auxSource!.connections).toBe(2);
    expect(literalSource!.connections).toBe(1);
    expect(auxSource!.key).not.toBe(literalSource!.key);
  });

  /**
   * Convention 6, and the trap the spec calls out in §5: a capped list whose
   * consumer reads rows.length reports a truncated total as the real one.
   * total_matching is the pre-LIMIT count carried on every row by
   * `count(*) OVER ()`, exactly as sessions.ts does it.
   */
  it('reports the true total when the list is truncated', () => {
    const d = connectionDetail.map([{ ...row, total_matching: 900 }]);
    expect(d.total).toBe(900);
    expect(d.truncated).toBe(true);
    expect(d.connections).toHaveLength(1);
  });

  it('is not truncated when the list is complete', () => {
    expect(connectionDetail.map([{ ...row, total_matching: 1 }]).truncated).toBe(false);
  });

  it('reports an empty server without inventing a total', () => {
    const d = connectionDetail.map([]);
    expect(d).toEqual({
      connections: [], sources: [], bySslStatus: {}, total: 0, truncated: false,
    });
  });

  it('never escalates — headroom is the connections check\'s job', () => {
    expect(connectionDetail.verdict).toBeUndefined();
  });
});
