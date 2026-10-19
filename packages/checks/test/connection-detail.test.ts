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
   * walwriter, autovacuum launcher), not an unencrypted client.
   */
  it('reports a backend with no database as an internal process', () => {
    expect(sslStatus({ ...row, ssl: false, database: null })).toBe('Internal Process');
  });

  /**
   * No IP but a known state is a unix socket, decided before `ssl` is
   * consulted. No IP and no state means the backend's details were
   * unreadable; with `ssl` measured `false` that is still `'No SSL'`.
   */
  it('separates a unix socket from a connection it cannot see', () => {
    expect(sslStatus({ ...row, ssl: false, ip: null, state: 'idle' })).toBe('Socket');
    expect(sslStatus({ ...row, ssl: false, ip: null, state: null })).toBe('No SSL');
  });

  /**
   * `ssl === null` ("we could not look") must render as neither encrypted
   * nor a confirmed "not encrypted" finding; `ssl === false` is the finding.
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
   * A plain `${x}` join stringifies `null` to the same text as the string
   * `"null"`. Two auxiliary backends (all four fields NULL) group together; a
   * backend whose application_name is literally "null" gets its own key.
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
   * A consumer reading rows.length would report a capped list's length as the
   * total. total_matching is the pre-LIMIT count from `count(*) OVER ()`.
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
