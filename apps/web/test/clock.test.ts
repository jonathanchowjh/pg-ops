import { describe, expect, it } from 'vitest';
import {
  axisTicks, clockTime, columnAt, endShowing, gridFor, hop, keepQuery, labelMarks, openFrom, stamp, step, timeAt, toggled,
  windowQuery, zoomTo,
} from '@/lib/clock';

const NOW = Date.UTC(2026, 9, 12, 8, 30, 20);
const MIN = 60_000;

describe('gridFor', () => {
  it('defaults to the last hour, live, on the samples', () => {
    expect(gridFor({}, NOW)).toEqual({ from: NOW - 60 * MIN, to: NOW, columns: 120, raw: true, live: true, winSecs: 3600 });
  });

  it('takes a window and an end from the URL', () => {
    const end = NOW - 30 * MIN;
    expect(gridFor({ win: '900', end: String(end) }, NOW)).toMatchObject({ from: end - 15 * MIN, to: end, live: false, raw: true });
  });

  it.each([
    [{ win: 'x' }], [{ win: '5' }], [{ win: '999999' }], [{ win: '-900' }],
  ])('falls back to the hour for %j', (sp) => {
    expect(gridFor(sp, NOW).winSecs).toBe(3600);
  });

  it.each([[String(NOW + MIN)], ['soon'], ['0'], ['-5']])('is live for an end of %s', (end) => {
    expect(gridFor({ end }, NOW)).toMatchObject({ live: true, to: NOW });
  });

  it('does not reach back past a day', () => {
    const g = gridFor({ win: '3600', end: String(NOW - 40 * 3_600_000) }, NOW);
    expect(g.from).toBe(NOW - 24 * 3_600_000);
  });

  it('lays a wide window on whole minutes, ending when the current one closes', () => {
    const g = gridFor({ win: '21600' }, NOW);
    expect(g).toMatchObject({ raw: false, live: true, columns: 120, to: Date.UTC(2026, 9, 12, 8, 31, 0) });
    expect((g.to - g.from) / g.columns).toBe(3 * MIN);
  });

  it('keeps every wide column a whole number of minutes for an odd window', () => {
    const g = gridFor({ win: String(135 * 60) }, NOW);
    expect(g.columns).toBe(67);
    expect((g.to - g.from) / g.columns).toBe(2 * MIN);
  });

  it('reads the first of a repeated parameter', () => {
    expect(gridFor({ win: ['900', '3600'] }, NOW).winSecs).toBe(900);
  });
});

describe('moving on the clock', () => {
  const g = gridFor({ win: '900' }, NOW);

  it('reads a point across the window as a moment, snapped to a sample', () => {
    expect(timeAt(g, 0.5) % 15_000).toBe(0);
    expect(Math.abs(timeAt(g, 0.5) - (NOW - 7.5 * MIN))).toBeLessThanOrEqual(7_500);
    expect(timeAt(g, -3)).toBeLessThanOrEqual(g.from + 7_500);
  });

  it('finds the column a moment is in', () => {
    expect(columnAt(g, g.from)).toBe(0);
    expect(columnAt(g, g.to)).toBe(119);
    expect(columnAt(g, g.from + 7.5 * MIN)).toBe(60);
  });

  it('steps back one sample from live, and forward off the end to live again', () => {
    const back = step(g, null, -1);
    expect(back).toBe(g.to - 15_000);
    expect(step(g, back, 1)).toBeNull();
    expect(step(g, g.from, -1)).toBe(g.from);
  });

  it('steps a column at a time where a column is wider than a sample', () => {
    const wide = gridFor({ win: '21600' }, NOW);
    expect(step(wide, null, -1)).toBe(wide.to - 3 * MIN);
  });

  it('stops at the end of a window in the past instead of going live', () => {
    const past = gridFor({ win: '900', end: String(NOW - 60 * MIN) }, NOW);
    expect(step(past, past.to - 15_000, 1)).toBe(past.to - 15_000);
  });

  it('hops to the next event and the one before', () => {
    const events = [{ at: 300 }, { at: 100 }, { at: 200 }];
    expect(hop(events, 150, 1)).toBe(200);
    expect(hop(events, 200, 1)).toBe(300);
    expect(hop(events, 200, -1)).toBe(100);
    expect(hop(events, 300, 1)).toBeNull();
  });

  it('zooms to a dragged selection in either direction, never under two minutes', () => {
    expect(zoomTo(NOW - 10 * MIN, NOW - 4 * MIN)).toEqual({ winSecs: 360, end: NOW - 4 * MIN });
    expect(zoomTo(NOW - 4 * MIN, NOW - 10 * MIN)).toEqual({ winSecs: 360, end: NOW - 4 * MIN });
    expect(zoomTo(NOW - 30_000, NOW).winSecs).toBe(120);
  });

  it('brings a moment into view three tenths from the right', () => {
    expect(endShowing(g, NOW - 3 * 3_600_000)).toBe(NOW - 3 * 3_600_000 + 4.5 * MIN);
  });

  it('writes the window into a query string, with no end when live', () => {
    expect(windowQuery(900, null)).toBe('?win=900');
    expect(windowQuery(900, 1234.6)).toBe('?win=900&end=1235');
  });
});

describe('what the URL keeps', () => {
  it('says nothing when there is nothing to keep', () => {
    expect(keepQuery('', null)).toBe('');
    expect(openFrom(undefined)).toBeNull();
  });

  it('round-trips a find and folds whose names hold anything', () => {
    const q = keepQuery('users', ['public.a,b', 'public."Weird & Odd"']);
    const sp = new URLSearchParams(q.slice(1));
    expect(sp.get('find')).toBe('users');
    expect([...openFrom(sp.getAll('open'))!]).toEqual(['public.a,b', 'public."Weird & Odd"']);
  });

  it('tells every fold shut from no word at all', () => {
    expect(keepQuery('', [])).toBe('&open=');
    expect(openFrom('')).toEqual(new Set());
  });

  it('flips one fold', () => {
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
  });
});

describe('clock times', () => {
  it('prints a clock time in a zone', () => {
    expect(clockTime(NOW, 0)).toBe('08:30:20');
    expect(clockTime(NOW, 480)).toBe('16:30:20');
    expect(clockTime(NOW, -210, false)).toBe('05:00');
  });

  it('adds the date once a moment is more than twelve hours away', () => {
    expect(stamp(NOW - 3_600_000, 0, NOW)).toBe('07:30:20');
    expect(stamp(NOW - 20 * 3_600_000, 0, NOW)).toBe('Oct 11 12:30:20');
  });

  it('puts ticks on round times, clear of the edges', () => {
    const ticks = axisTicks(gridFor({ win: '3600' }, NOW), 900, 0);
    expect(ticks.map((t) => t.label)).toEqual(['07:40', '07:50', '08:00', '08:10', '08:20']);
    for (const t of ticks) expect(t.at).toBeGreaterThan(0.04);
  });

  it('labels midnight with its date, in the zone asked for', () => {
    const day = gridFor({ win: '86400' }, NOW);
    expect(axisTicks(day, 900, 0).map((t) => t.label)).toContain('Oct 12');
    // At +08:00 the day turned sixteen hours before 08:30 UTC.
    const local = axisTicks(day, 900, 480);
    expect(local.find((t) => t.label === 'Oct 12')!.t).toBe(Date.UTC(2026, 9, 11, 16, 0, 0));
  });
});

describe('labelMarks', () => {
  // A 1000 px plot over 0..1000 ms, so a moment is its own pixel. A label of n characters is about 6.6n + 8 px.
  const grid = { from: 0, to: 1000 };
  const mark = (at: number, chars = 10) => ({ at, label: 'x'.repeat(chars) });
  const named = (ms: { at: number; label: string }[], width = 1000) => labelMarks(ms, grid, width).map((m) => m.named);

  it('names the first of two marks whose labels would print over each other', () => {
    expect(named([mark(100), mark(150)])).toEqual([true, false]);
  });

  it('names both when their labels clear', () => {
    expect(named([mark(100), mark(300)])).toEqual([true, true]);
  });

  it('reads a label leftwards only where it would run past the plot', () => {
    expect(labelMarks([mark(900, 20)], grid, 1000)[0]!.leftward).toBe(true);
    expect(labelMarks([mark(900, 10)], grid, 1000)[0]!.leftward).toBe(false);
  });

  /** Measured at 390 px: "lock chain users" at 80 % of a 220 px band ran past the card. */
  it('turns a label leftwards on a narrow plot where a wide one would not', () => {
    expect(labelMarks([mark(800, 16)], grid, 220)[0]!.leftward).toBe(true);
  });

  /** Found by review: a leftward label covers the room behind its mark. */
  it('names a label read leftwards only when it clears the label before it', () => {
    expect(named([mark(750, 20), mark(880, 20)])).toEqual([true, false]);
    expect(named([mark(580, 20), mark(880, 20)])).toEqual([true, true]);
  });

  it('names nothing a plot is too narrow to hold', () => {
    expect(named([mark(50, 20)], 100)).toEqual([false]);
  });

  it('drops a mark outside the window, and sorts the rest by time', () => {
    expect(labelMarks([mark(600), mark(1500), mark(200)], grid, 1000).map((m) => m.at)).toEqual([200, 600]);
  });
});
