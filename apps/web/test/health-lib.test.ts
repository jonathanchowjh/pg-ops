import { describe, expect, it, vi } from 'vitest';
import { GATES, GATE_ORDER, HEALTH_METRICS, XID_WRAPAROUND, type HealthPoint } from '@pgops/checks';

vi.mock('next/server', () => ({ connection: async () => {} }));

import { HEALTH_CHARTS, WINDOWS, boardGroups, chartFor, parseWindow } from '@/lib/health';
import { DAY_MS } from '@/lib/trend';

const blank = (at: number, over: Partial<HealthPoint> = {}): HealthPoint => ({
  at, ...Object.fromEntries(HEALTH_METRICS.map((m) => [m, null])), ...over,
} as HealthPoint);

describe('HEALTH_CHARTS', () => {
  it('puts exactly the six headline charts on the fleet page, in this order', () => {
    expect(HEALTH_CHARTS.filter((c) => c.fleet).map((c) => c.metric)).toEqual([
      'serverConnections', 'blocked', 'avgActive', 'hitPct', 'replicationLagSecs', 'xidAge',
    ]);
  });

  it('lists its charts in gate order, and gives every gate at least one', () => {
    const order = HEALTH_CHARTS.map((c) => GATE_ORDER.indexOf(c.gate));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const gate of GATE_ORDER) {
      expect(HEALTH_CHARTS.some((c) => c.gate === gate), `no chart for ${gate}`).toBe(true);
    }
  });

  /**
   * Every figure the series derives must be a chart, a chart's inner line, or
   * the limit a chart is ruled against; anything else is captured for no reader.
   */
  it('draws every figure the series derives', () => {
    const drawn = new Set<string>(['maxConnections']);
    for (const c of HEALTH_CHARTS) {
      drawn.add(c.metric);
      if (c.inner) drawn.add(c.inner);
    }
    expect(HEALTH_METRICS.filter((m) => !drawn.has(m))).toEqual([]);
  });

  it('charts no figure twice', () => {
    const metrics = HEALTH_CHARTS.map((c) => c.metric);
    expect(new Set(metrics).size).toBe(metrics.length);
  });

  it('says why, for every chart, when it has nothing to draw', () => {
    for (const c of HEALTH_CHARTS) expect(c.empty.length, c.metric).toBeGreaterThan(20);
  });
});

describe('chartFor', () => {
  const spec = (metric: string) => HEALTH_CHARTS.find((c) => c.metric === metric)!;

  it('rules server connections against the latest known limit, with this database inside', () => {
    const chart = chartFor(spec('serverConnections'), [
      blank(0, { serverConnections: 40, connections: 10, maxConnections: 97 }),
      blank(1, { serverConnections: 42, connections: 11, maxConnections: 197 }),
      blank(2),
    ]);
    expect(chart.ceiling).toBe(197);
    expect(chart.scope).toBe('server');
    expect(chart.points.map((p) => p.value)).toEqual([40, 42, null]);
    expect(chart.inner!.map((p) => p.value)).toEqual([10, 11, null]);
  });

  it('has no ceiling when the limit was never read', () => {
    expect(chartFor(spec('serverConnections'), [blank(0, { serverConnections: 40 })]).ceiling).toBeNull();
  });

  it('rules transaction ID age against wraparound', () => {
    expect(chartFor(spec('xidAge'), [blank(0, { xidAge: 5 })]).ceiling).toBe(XID_WRAPAROUND);
  });

  it('does not measure size from zero, where growth would be invisible', () => {
    expect(chartFor(spec('sizeBytes'), [blank(0)]).zero).toBe(false);
    expect(chartFor(spec('blocked'), [blank(0)]).zero).toBe(true);
  });

  it('produces nothing a client component could not receive', () => {
    const chart = chartFor(spec('serverConnections'), [blank(0, { serverConnections: 1 })]);
    expect(JSON.parse(JSON.stringify(chart))).toEqual(chart);
  });
});

describe('parseWindow', () => {
  const NOW = Date.parse('2026-10-07T12:00:00Z');

  it('defaults to 48 hours', () => {
    expect(parseWindow({}, NOW)).toEqual({ key: '48h', from: NOW - 48 * 3_600_000, to: NOW });
  });

  it('accepts each named window', () => {
    expect(WINDOWS.map((w) => w.key)).toEqual(['6h', '48h', '7d', '30d', '90d']);
    for (const w of WINDOWS) {
      expect(parseWindow({ window: w.key }, NOW)).toEqual({ key: w.key, from: NOW - w.ms, to: NOW });
    }
  });

  it('accepts a start and end from the URL, so a moment can be shared', () => {
    const win = parseWindow({ from: '2026-10-01T02:00:00Z', to: '2026-10-01T08:00:00Z' }, NOW);
    expect(win).toEqual({
      key: null, from: Date.parse('2026-10-01T02:00:00Z'), to: Date.parse('2026-10-01T08:00:00Z'),
    });
  });

  /** Every one of these must fall back, not throw and not render an empty axis. */
  it('falls back to 48 hours for a window nobody could mean', () => {
    const fallback = { key: '48h', from: NOW - 48 * 3_600_000, to: NOW };
    const bad: Record<string, string | string[]>[] = [
      { from: 'banana', to: '2026-10-01T08:00:00Z' },
      { from: '2026-10-01T08:00:00Z' },
      { from: '2026-10-01T08:00:00Z', to: '2026-10-01T02:00:00Z' },   // backwards
      { from: '2026-10-01T08:00:00Z', to: '2026-10-01T08:01:00Z' },   // one minute: no bucket fits
      { from: '2025-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },   // longer than retention
      { from: '2026-10-07T00:00:00Z', to: '2026-10-14T00:00:00Z' },   // ends next week
      { window: '5y' },
    ];
    for (const sp of bad) expect(parseWindow(sp, NOW), JSON.stringify(sp)).toEqual(fallback);
  });

  it('takes the first value when a parameter is repeated', () => {
    expect(parseWindow({ window: ['7d', '30d'] }, NOW).key).toBe('7d');
  });
});

describe('boardGroups', () => {
  const NOW = 20 * DAY_MS;
  /** One point every six hours for `days` days ending at NOW. */
  const points = (days: number, f: (day: number) => Partial<HealthPoint>): HealthPoint[] =>
    Array.from({ length: days * 4 }, (_, i) => {
      const at = NOW - days * DAY_MS + i * 6 * 3_600_000;
      return blank(at, f(Math.floor(i / 4)));
    });
  const chart = (groups: ReturnType<typeof boardGroups>, metric: string) =>
    groups.flatMap((g) => g.charts).find((c) => c.metric === metric)!;

  it('groups every chart under its gate, in gate order, by the gate\'s own title', () => {
    const groups = boardGroups(points(1, () => ({})), { from: NOW - DAY_MS, to: NOW });
    expect(groups.map((g) => g.gate)).toEqual([...GATE_ORDER]);
    expect(groups.map((g) => g.title)).toEqual(GATE_ORDER.map((g) => GATES[g].title));
    expect(groups.flatMap((g) => g.charts)).toHaveLength(HEALTH_CHARTS.length);
  });

  it('says nothing about trend in a window shorter than seven days', () => {
    const groups = boardGroups(points(2, (d) => ({ serverConnections: 10 + d, maxConnections: 100 })),
      { from: NOW - 2 * DAY_MS, to: NOW });
    expect(chart(groups, 'serverConnections').note).toBeNull();
    expect(chart(groups, 'serverConnections').fit).toBeNull();
  });

  it('says how many days remain when a long window has too little history', () => {
    const groups = boardGroups(points(3, () => ({ serverConnections: 10, maxConnections: 100 })),
      { from: NOW - 30 * DAY_MS, to: NOW });
    expect(chart(groups, 'serverConnections').note).toBe('Trend needs 7 days of history; 4 more days to go.');
    expect(chart(groups, 'serverConnections').fit).toBeNull();
  });

  it('projects connections to the limit, and says how the line was drawn', () => {
    const groups = boardGroups(points(10, (d) => ({ serverConnections: 50 + d * 2, maxConnections: 100 })),
      { from: NOW - 10 * DAY_MS, to: NOW });
    const c = chart(groups, 'serverConnections');
    expect(c.note).toContain('+18 over 10 days, by daily peak.');
    expect(c.note).toMatch(/A straight line through the daily peaks reaches 100 in about \d+ days\./);
    expect(c.fit).not.toBeNull();
    expect(c.fit!.toValue).toBeGreaterThan(c.fit!.fromValue);
  });

  it('says "not rising" rather than inventing a date', () => {
    const groups = boardGroups(points(10, () => ({ serverConnections: 50, maxConnections: 100 })),
      { from: NOW - 10 * DAY_MS, to: NOW });
    expect(chart(groups, 'serverConnections').note).toContain('Not rising.');
  });

  it('gives size a growth rate and no date, because pgops cannot see the disk', () => {
    const groups = boardGroups(points(10, (d) => ({ sizeBytes: 1_000_000_000 + d * 1_048_576 })),
      { from: NOW - 10 * DAY_MS, to: NOW });
    const note = chart(groups, 'sizeBytes').note!;
    expect(note).toContain('a day');
    expect(note).not.toContain('reaches');
  });

  it('states a change but draws no projection for a level with no known ceiling', () => {
    const groups = boardGroups(points(10, (d) => ({ blocked: d })), { from: NOW - 10 * DAY_MS, to: NOW });
    expect(chart(groups, 'blocked').note).toBe('+9 over 10 days, by daily peak.');
    expect(chart(groups, 'blocked').fit).toBeNull();
  });

  it('never puts a trend on a rate', () => {
    const groups = boardGroups(points(10, (d) => ({ commitsPerSec: d })), { from: NOW - 10 * DAY_MS, to: NOW });
    expect(chart(groups, 'commitsPerSec').note).toBeNull();
  });

  it('produces nothing a client component could not receive', () => {
    const groups = boardGroups(points(10, (d) => ({ serverConnections: 50 + d, maxConnections: 100 })),
      { from: NOW - 10 * DAY_MS, to: NOW });
    expect(JSON.parse(JSON.stringify(groups))).toEqual(groups);
  });
});
