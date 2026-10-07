import { describe, expect, it } from 'vitest';
import {
  formatAge, formatBytes, formatCount, formatDelta, formatDuration, formatMillis, formatUnit, formatUtc,
  planLines, plural,
} from '@/lib/format';

describe('formatDuration', () => {
  it('renders null as an em dash rather than "0s" or "null"', () => {
    expect(formatDuration(null)).toBe('—');
  });
  it('renders sub-minute durations in seconds', () => {
    expect(formatDuration(45)).toBe('45s');
  });
  it('renders minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2m 5s');
  });
  it('renders hours and minutes, dropping seconds', () => {
    expect(formatDuration(100_366)).toBe('27h 52m');
  });
  /** A negative age means clock skew between client and server, not a bug worth crashing on. */
  it('clamps a negative duration to 0s', () => {
    expect(formatDuration(-5)).toBe('0s');
  });
});

describe('formatMillis', () => {
  /**
   * The defect, stated as a test. The Queries page rendered these through
   * `formatDuration(ms / 1000)`, which floors to whole seconds — so a 25.6ms
   * mean, the ordinary magnitude for a statement on this page, printed "0s".
   * Every sub-second row's mean and most of their totals were that "0s", on
   * the two columns the page exists to rank by.
   */
  it('keeps a sub-second query mean readable instead of flooring it to 0s', () => {
    expect(formatMillis(25.6)).toBe('25.6ms');
    expect(formatDuration(25.6 / 1000)).toBe('0s'); // what it used to render
  });

  it('drops the decimal once the millisecond count is large enough not to need it', () => {
    expect(formatMillis(250)).toBe('250ms');
    expect(formatMillis(999.4)).toBe('999ms');
  });

  it('switches to seconds at a second, and to the coarse format at a minute', () => {
    expect(formatMillis(1_000)).toBe('1s');
    expect(formatMillis(3_200)).toBe('3.2s');
    expect(formatMillis(125_000)).toBe('2m 5s');
  });

  /** A statement that did work must not read as free. */
  it('distinguishes immeasurably fast from zero', () => {
    expect(formatMillis(0.02)).toBe('<0.1ms');
    expect(formatMillis(0)).toBe('0ms');
  });

  it('renders null as an em dash, like its sibling', () => {
    expect(formatMillis(null)).toBe('—');
  });
});

describe('formatBytes', () => {
  it('uses binary units, matching what Postgres reports and pg_size_pretty prints', () => {
    // 1 GiB, which is what `max_slot_wal_keep_size = 1GB` actually means.
    // Decimal units would render this 1.1 GB and invite a 7% mis-comparison
    // against the setting the operator is about to change.
    expect(formatBytes(1024 ** 3)).toBe('1 GB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('drops the decimal above ten, where it stops being a decision', () => {
    expect(formatBytes(847 * 1024 * 1024)).toBe('847 MB');
    expect(formatBytes(1.25 * 1024 ** 3)).toBe('1.3 GB');
  });

  it('reports bytes below a kilobyte rather than 0.0 KB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
  });

  it('renders an em dash for an absent or non-finite reading', () => {
    // `retainedBytes` is nullable: a slot on a server that will not report it
    // has no size, which is not the same as a slot retaining nothing.
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatDelta', () => {
  it('carries the sign of a byte delta, which formatBytes clamps away', () => {
    expect(formatDelta(2_147_483_648)).toBe('+2 GB');
    expect(formatDelta(-2_147_483_648)).toBe('\u22122 GB');
    expect(formatDelta(0)).toBe('0 B');
    // The clamp this exists to route around.
    expect(formatBytes(-2_147_483_648)).toBe('0 B');
  });
});

describe('planLines', () => {
  it('renders a plan the way EXPLAIN text does', () => {
    expect(planLines({
      'Node Type': 'Limit', 'Startup Cost': 1, 'Total Cost': 2.5, 'Plan Rows': 5, 'Plan Width': 33,
      Plans: [{
        'Node Type': 'Index Scan', 'Index Name': 'orders_pkey', 'Relation Name': 'orders', Schema: 'public',
        Alias: 'o', 'Startup Cost': 0.29, 'Total Cost': 8.3, 'Plan Rows': 1, 'Plan Width': 33,
        'Index Cond': '(o.id = $1)', Filter: '(o.status = $2)',
        Plans: [{ 'Node Type': 'Result' }],
      }],
    })).toEqual([
      'Limit  (cost=1.00..2.50 rows=5 width=33)',
      '  ->  Index Scan using orders_pkey on public.orders o  (cost=0.29..8.30 rows=1 width=33)',
      '        Index Cond: (o.id = $1)',
      '        Filter: (o.status = $2)',
      '        ->  Result',
    ]);
  });
  it('joins array-valued details, and omits an alias equal to the relation', () => {
    expect(planLines({ 'Node Type': 'Seq Scan', 'Relation Name': 't', Schema: 's', Alias: 't', 'Sort Key': ['a DESC', 'b'] }))
      .toEqual(['Seq Scan on s.t', '  Sort Key: a DESC, b']);
  });
});

/**
 * `0 slot(s)` is how a program writes when it has not decided what it is
 * saying, and this console is read by someone who has just been woken up.
 */
describe('plural', () => {
  it('agrees with the count', () => {
    expect(plural(1, 'root blocker')).toBe('1 root blocker');
    expect(plural(2, 'root blocker')).toBe('2 root blockers');
  });

  /** English's rule, not a special case: "0 sequences", never "0 sequence". */
  it('gives zero the plural', () => {
    expect(plural(0, 'sequence')).toBe('0 sequences');
  });

  it('takes an irregular plural rather than guessing one', () => {
    expect(plural(2, 'index', 'indexes')).toBe('2 indexes');
    expect(plural(1, 'index', 'indexes')).toBe('1 index');
  });

  it('groups the number, like every other count on the page', () => {
    expect(plural(12_000, 'session')).toBe('12,000 sessions');
  });
});

/**
 * A second duration formatter, for the question `formatDuration` is not built
 * for: "how long since this table was last vacuumed", which is routinely days
 * or weeks. `formatDuration` tops out in hours on purpose — `27h 52m` is the
 * right answer for a long transaction and is pinned above — and the same rule
 * renders a fortnight as `336h 0m`.
 */
describe('formatAge', () => {
  it('uses one unit, so a column of them compares at a glance', () => {
    expect(formatAge(45)).toBe('45s');
    expect(formatAge(125)).toBe('2m');
    expect(formatAge(3 * 3600 + 40 * 60)).toBe('3h');
  });

  /**
   * Two days, not one, before days take over: "36h" is a more useful answer
   * than "1d" for a vacuum that ran yesterday evening.
   */
  it('keeps hours until they stop being readable', () => {
    expect(formatAge(36 * 3600)).toBe('36h');
    expect(formatAge(47 * 3600)).toBe('47h');
    expect(formatAge(48 * 3600)).toBe('2d');
    expect(formatAge(14 * 86_400)).toBe('14d');
  });

  /** Clock skew between the server and the statistics it read. */
  it('clamps a negative age to 0s', () => {
    expect(formatAge(-5)).toBe('0s');
  });
});

describe('formatUnit', () => {
  it('formats each unit the health charts use', () => {
    expect(formatUnit('count', 12.4)).toBe('12');
    expect(formatUnit('sessions', 0.253)).toBe('0.25');
    expect(formatUnit('sessions', 14.26)).toBe('14.3');
    expect(formatUnit('pct', 99.123)).toBe('99.1%');
    expect(formatUnit('perSec', 0.44)).toBe('0.4/s');
    expect(formatUnit('perSec', 1234.4)).toBe(`${formatCount(1234)}/s`);
    expect(formatUnit('bytes', 1024)).toBe(formatBytes(1024));
    expect(formatUnit('bytesPerSec', 1024)).toBe(`${formatBytes(1024)}/s`);
    expect(formatUnit('secs', 90)).toBe(formatDuration(90));
  });

  /**
   * Found on screen: a quiet database's average active sessions is a few
   * thousandths, and its axis read "0.00" at the top and "0.00" at the
   * bottom. A figure that small keeps the digits that distinguish it.
   */
  it('keeps the digits of a figure too small for the usual precision', () => {
    expect(formatUnit('sessions', 0.004)).toBe('0.004');
    expect(formatUnit('perSec', 0.04)).toBe('0.04/s');
    expect(formatUnit('sessions', 0)).toBe('0');
    expect(formatUnit('perSec', 0)).toBe('0/s');
  });
});

describe('formatUtc', () => {
  it('prints month, day, hour and minute in UTC', () => {
    expect(formatUtc(Date.parse('2026-10-07T02:14:59Z'))).toBe('10-07 02:14');
  });
});
