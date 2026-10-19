import { describe, expect, it } from 'vitest';
import {
  formatBytes, formatCompact, formatCount, formatDuration, formatMillis, formatRate, formatUnit, formatUtc, plural,
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
  /** A negative age means clock skew between client and server. */
  it('clamps a negative duration to 0s', () => {
    expect(formatDuration(-5)).toBe('0s');
  });
});

describe('formatMillis', () => {
  /** `formatDuration` floors to whole seconds, so an ordinary 25.6ms mean would print "0s". */
  it('keeps a sub-second query mean readable instead of flooring it to 0s', () => {
    expect(formatMillis(25.6)).toBe('25.6ms');
    expect(formatDuration(25.6 / 1000)).toBe('0s'); // what formatDuration would print
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
    // 1 GiB is what `max_slot_wal_keep_size = 1GB` means; decimal units
    // would render it 1.1 GB.
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
    // `retainedBytes` is nullable: unreported is not the same as retaining nothing.
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('plural', () => {
  it('agrees with the count', () => {
    expect(plural(1, 'root blocker')).toBe('1 root blocker');
    expect(plural(2, 'root blocker')).toBe('2 root blockers');
  });

  /** "0 sequences", never "0 sequence". */
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
   * A quiet database's average active sessions is a few thousandths; at the
   * usual precision both ends of its axis would read "0.00".
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

describe('formatRate and formatCompact', () => {
  it('keeps a small rate from printing as zero', () => {
    expect(formatRate(0)).toBe('0');
    expect(formatRate(0.003)).toBe('0.003');
    expect(formatRate(1e-7)).toBe('0.0000001');
    expect(formatRate(0.0096)).toBe('0.01');
    expect(formatRate(0.44)).toBe('0.4');
    expect(formatRate(12.6)).toBe('13');
    expect(formatRate(1234)).toBe('1.2K');
  });

  it('prints a large count in three characters or so', () => {
    expect(formatCompact(950)).toBe('950');
    expect(formatCompact(48_000_000)).toBe('48M');
    expect(formatUnit('compact', 1500)).toBe('1.5K');
    expect(formatUnit('rate', 0.003)).toBe('0.003/s');
  });
});
