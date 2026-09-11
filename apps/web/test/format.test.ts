import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatMillis } from '@/lib/format';

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
