import { describe, expect, it } from 'vitest';
import { settings, settingNames, showMs, toSettings } from '../src/checks/settings.js';

describe('settingNames', () => {
  /**
   * Parity with pgHero's `settings.rb`: dropping a setting from a group would
   * otherwise degrade silently, one row fewer.
   *
   * `io_method` is in the list unconditionally: `pg_settings` returns no row
   * for a setting that does not exist, so there is nothing to branch on.
   */
  it("asks for pgHero 4.0.1's three groups in pgHero's order, then the timeouts and the freeze age the pages reason about", () => {
    expect(settingNames()).toEqual([
      'max_connections', 'shared_buffers', 'effective_cache_size', 'maintenance_work_mem',
      'checkpoint_completion_target', 'wal_buffers', 'default_statistics_target',
      'random_page_cost', 'effective_io_concurrency', 'work_mem', 'huge_pages',
      'jit', 'wal_compression', 'io_method', 'min_wal_size', 'max_wal_size',
      'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'deadlock_timeout',
      'autovacuum', 'autovacuum_max_workers', 'autovacuum_vacuum_cost_limit',
      'autovacuum_vacuum_scale_factor', 'autovacuum_analyze_scale_factor', 'autovacuum_freeze_max_age',
      'vacuum_cost_limit',
    ]);
  });

  it('asks for every name exactly once, so the server is not queried twice for one value', () => {
    const asked = settingNames();
    expect(new Set(asked).size).toBe(asked.length);
  });

  /** `sql` is a pure function of its opts and cannot reach the server version, so the check takes no options. */
  it('needs nothing from the caller', () => {
    expect(settings.sql).toBeTypeOf('function');
    expect(settingNames).toHaveLength(0);
  });
});

describe('toSettings', () => {
  /**
   * Every group carries more than one member, because a grouping bug that
   * puts everything in `main` passes any test where the other groups have a
   * single expected member.
   */
  const rows = [
    { name: 'vacuum_cost_limit', value: '200' },
    { name: 'autovacuum_max_workers', value: '3' },
    { name: 'shared_buffers', value: '128MB' },
    { name: 'autovacuum', value: 'on' },
    { name: 'max_connections', value: '100' },
  ];

  it('puts each setting in its own group and no other', () => {
    const d = toSettings(rows);
    expect(d.main.map((s) => s.name)).toEqual(['max_connections', 'shared_buffers']);
    expect(d.autovacuum.map((s) => s.name)).toEqual(['autovacuum', 'autovacuum_max_workers']);
    expect(d.vacuum.map((s) => s.name)).toEqual(['vacuum_cost_limit']);
  });

  /**
   * The rows above are in neither catalog nor alphabetical order. The SQL
   * adds no `ORDER BY`, so `toSettings` alone decides the order.
   */
  it('orders by the pgHero arrays, not by the order the rows arrived', () => {
    const d = toSettings(rows);
    expect(d.main[0]!.name).toBe('max_connections');
    expect(d.autovacuum[0]!.name).toBe('autovacuum');
  });

  /** Skipping a name with no row is what keeps this function free of a version branch: on 17 there is no `io_method` row. */
  it('skips a setting the server did not return rather than rendering it empty', () => {
    const d = toSettings([{ name: 'max_connections', value: '100' }]);
    expect(d.main).toEqual([{ name: 'max_connections', value: '100' }]);
    expect(d.main.some((s) => s.name === 'io_method')).toBe(false);
  });

  it('gives three empty groups for a server that returned nothing', () => {
    expect(toSettings([])).toEqual({ main: [], autovacuum: [], vacuum: [] });
  });

  it('keeps the value verbatim, including one that is a word rather than a number', () => {
    const d = toSettings([{ name: 'huge_pages', value: 'try' }]);
    expect(d.main[0]!.value).toBe('try');
  });

  /**
   * pgops sets its own timeouts on its connection. Reporting those as the
   * server's would hide a server with no timeout at all, the case Server tags.
   */
  it("reports the server's timeout, not the one pgops set on its own connection", () => {
    const d = toSettings([
      { name: 'statement_timeout', value: '10s', reset_ms: '0' },
      { name: 'lock_timeout', value: '1s', reset_ms: '30000' },
      { name: 'deadlock_timeout', value: '1s', reset_ms: null },
    ]);
    expect(d.main).toEqual([
      { name: 'statement_timeout', value: '0' },
      { name: 'lock_timeout', value: '30s' },
      { name: 'deadlock_timeout', value: '1s' },
    ]);
  });

  it('prints milliseconds as SHOW does', () => {
    expect([0, 1500, 1000, 90_000, 120_000, 7_200_000, 86_400_000].map(showMs))
      .toEqual(['0', '1500ms', '1s', '90s', '2min', '2h', '1d']);
  });

  it('ships no verdict: advice that does not know the machine is a guess', () => {
    expect(settings.thresholds).toBeUndefined();
  });

  it('belongs to the server, which Server draws', () => {
    expect(settings.home).toBe('server');
  });
});
