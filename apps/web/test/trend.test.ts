import { describe, expect, it } from 'vitest';
import { DAY_MS, MIN_TREND_DAYS, dailyPeaks, daysUntil, fitPeaks, valueAt } from '@/lib/trend';

/** Four readings a day for `days` days; `f(day, hour)` gives each value. */
function series(days: number, f: (day: number, hour: number) => number | null) {
  return Array.from({ length: days * 4 }, (_, i) => {
    const day = Math.floor(i / 4);
    const hour = (i % 4) * 6;
    return { at: day * DAY_MS + hour * 3_600_000, value: f(day, hour) };
  });
}

describe('dailyPeaks', () => {
  it('takes the highest reading of each UTC day', () => {
    const peaks = dailyPeaks(series(3, (d, h) => d * 10 + h), 3 * DAY_MS);
    expect(peaks).toEqual([{ day: 0, value: 18 }, { day: 1, value: 28 }, { day: 2, value: 38 }]);
  });

  it('skips nulls, and skips a day with no reading at all', () => {
    const peaks = dailyPeaks(series(3, (d, h) => (d === 1 ? null : h === 6 ? null : d + 1)), 3 * DAY_MS);
    expect(peaks.map((p) => p.day)).toEqual([0, 2]);
  });

  /**
   * Final review. Peaks were taken per UTC calendar day, so a 7-day window
   * ending at 01:00 UTC spanned eight days whose first and last were
   * fragments. The last fragment was one hour of overnight trough, the note
   * read "−60 over 8 days", and a real rise became "Not rising." Periods are
   * now 24 hours counted back from the window's end, so every one is whole.
   */
  it('counts 24-hour periods back from the end of the window, never calendar fragments', () => {
    const to = 10 * DAY_MS + 3_600_000; // 01:00 UTC
    const points = Array.from({ length: 7 * 24 }, (_, i) => {
      const at = to - 7 * DAY_MS + i * 3_600_000;
      const hour = new Date(at).getUTCHours();
      return { at, value: hour === 12 ? 80 : 20 };
    });
    const peaks = dailyPeaks(points, to);
    expect(peaks).toHaveLength(7);
    expect(peaks.map((p) => p.value)).toEqual([80, 80, 80, 80, 80, 80, 80]);
  });
});

describe('fitPeaks', () => {
  it('refuses to fit fewer than seven days', () => {
    expect(MIN_TREND_DAYS).toBe(7);
    expect(fitPeaks(dailyPeaks(series(6, (d) => d), 6 * DAY_MS))).toBeNull();
    expect(fitPeaks(dailyPeaks(series(7, (d) => d), 7 * DAY_MS))).not.toBeNull();
  });

  it('finds the daily slope of a steady climb', () => {
    const line = fitPeaks(dailyPeaks(series(10, (d) => 100 + d * 5), 10 * DAY_MS))!;
    expect(line.perDay).toBeCloseTo(5, 6);
    expect(valueAt(line, 9.5 * DAY_MS)).toBeCloseTo(145, 6);
  });

  /**
   * Why peaks and not raw points. Connections follow the working day: a fit
   * through every reading sees the overnight trough and reports a slope set
   * by what time the window happens to start.
   */
  it('ignores the daily trough: the fit follows the peaks', () => {
    const line = fitPeaks(dailyPeaks(series(10, (d, h) => (h === 12 ? 80 + d : 5)), 10 * DAY_MS))!;
    expect(line.perDay).toBeCloseTo(1, 6);
  });

  /** Transaction ID age drops every time vacuum freezes. The peaks are what approach the limit. */
  it('fits a sawtooth by its peaks', () => {
    const line = fitPeaks(dailyPeaks(series(14, (d, h) => (h === 18 ? 1000 + d * 100 : 50)), 14 * DAY_MS))!;
    expect(line.perDay).toBeCloseTo(100, 6);
  });
});

describe('daysUntil', () => {
  it('projects a rising line to its ceiling', () => {
    const line = fitPeaks(dailyPeaks(series(10, (d) => 50 + d * 5), 10 * DAY_MS))!;
    // At day 10 the line reads 97.5; 100 is half a day away.
    expect(daysUntil(line, 100, 10 * DAY_MS)).toBeCloseTo(0.5, 6);
  });

  it('gives no date for a line that is flat or falling', () => {
    expect(daysUntil(fitPeaks(dailyPeaks(series(10, () => 50), 10 * DAY_MS))!, 100, 10 * DAY_MS)).toBeNull();
    expect(daysUntil(fitPeaks(dailyPeaks(series(10, (d) => 90 - d), 10 * DAY_MS))!, 100, 10 * DAY_MS)).toBeNull();
  });

  it('answers zero, not a negative number, once the line is past the ceiling', () => {
    const line = fitPeaks(dailyPeaks(series(10, (d) => 95 + d * 5), 10 * DAY_MS))!;
    expect(daysUntil(line, 100, 10 * DAY_MS)).toBe(0);
  });
});
