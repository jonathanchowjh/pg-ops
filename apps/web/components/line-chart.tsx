import { formatDuration } from '@/lib/format';

export interface ChartPoint { at: Date; value: number }

/** Horizontal gridlines, counting both bounds. Four is two readable rows
 *  between max and min — enough to read a value off the line, few enough
 *  that the labels never collide at this height. */
const TICKS = 4;

/** The plot's top and bottom inside the 0..30 viewBox, leaving the stroke
 *  room so a point AT the maximum is not sliced in half by the edge. */
const TOP = 1;
const BOTTOM = 29;

/**
 * The smallest range the value axis will scale to, as a fraction of the
 * reading itself.
 *
 * AUTOSCALING TO min..max IS WHAT MAKES A FLAT SERIES LOOK DRAMATIC, and the
 * space page caught it: a 102 MB table that had grown 8 KB — 0.008% — drew a
 * line climbing the full height of the plot, under a value axis whose four
 * labels all read "102 MB" because the whole range was finer than the
 * formatter's own resolution. The chart shouted while the `Change` fact
 * beside it correctly said "+8 KB".
 *
 * With a floor, the plot can never turn a change smaller than 2% of the
 * reading into more than 2% of its height; the line goes flat, which is what
 * the data says. Real movement — a table growing 15% in a month, a query
 * whose interval time doubles — is far above the floor and scales exactly as
 * it did. It also fixes the axis as a side effect: the labels now span a
 * range wide enough for the formatter to print four different numbers.
 */
const MIN_RANGE_FRACTION = 0.02;

/**
 * One series over time, as an inline SVG. No charting dependency: there are
 * three charts in the whole console, and `apps/web` is deliberately thin.
 *
 * THIS REPLACES `Spark`, and the two things it adds are the two a sparkline
 * cannot have: an axis on each side. A sparkline says "it went up"; it cannot
 * say from what, to what, or over how long, so every caller had to restate
 * all three underneath in a definition list. Those lists stay — they are the
 * exact latest reading — but the chart no longer depends on them to mean
 * anything.
 *
 * SIZED TO BE READ, not to fill the column. At `h-16` across the full 1344px
 * shell this was a 20:1 ribbon: a line that thin encodes its whole range in
 * about sixty pixels of travel, so every series looked like the same gentle
 * ripple and the shape — the thing a chart is for — was unreadable. Capped
 * at 48rem and given real height, the same data has an aspect ratio a slope
 * survives.
 *
 * THE LABELS ARE HTML, NOT `<text>` IN THE SVG. `preserveAspectRatio="none"`
 * is what lets the caller size the chart in CSS while the geometry below
 * stays a fixed 0..100 by 0..30 — no measurement, no ref, nothing that
 * behaves differently on the server. It also scales the two axes by different
 * factors, which would stretch any glyph drawn inside. Laying the labels out
 * around the SVG keeps both properties. The gridlines can live inside it
 * because a line has no shape to distort.
 *
 * THE TIME LABELS ARE RELATIVE. This renders on the server, which does not
 * know the reader's timezone; "14:05" would be a claim about a clock pgops
 * cannot see. `−24h`, `−12h`, `now` are true in every timezone, and they are
 * derived from the points rather than passed in, so a window that turns out
 * to hold six hours of history says six.
 */
export function LineChart({ points, label, format }: {
  points: readonly ChartPoint[];
  /** What the series IS. The endpoints are appended for the screen reader. */
  label: string;
  /** Formats the value axis. `formatMillis`, `formatBytes`, `formatCount`. */
  format: (v: number) => string;
}) {
  // FEWER THAN TWO POINTS IS NOT A CHART. One capture drew an empty frame:
  // no line (a single point has no segment to stroke), the same number on
  // both value labels, and a time axis reading "−0s · −0s · now" because the
  // span between a point and itself is zero. Every caller already states the
  // capture count beside this and says "not enough history" in words, so
  // returning nothing leaves the truth on the page and takes away the
  // drawing that contradicted it.
  if (points.length < 2) return null;

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series has range 0, and (v - min) / 0 is NaN — an SVG with NaN
  // coordinates renders NOTHING, which would make the most ordinary case
  // (a relation that has not changed) look like a broken chart.
  // A SERIES THAT NEVER MOVED GETS ITS OWN BRANCH, because inventing a range
  // around it invents numbers that are not readings. A shape called zero
  // times in every interval drew an axis of `0 · −0.333 · −0.667 · −1` —
  // negative call counts, on a console whose whole discipline is not saying
  // things it cannot see. Flat is a fact: one line through the middle, one
  // label naming the value it held.
  const flat = max === min;
  const range = flat ? 1 : Math.max(max - min, Math.abs(max) * MIN_RANGE_FRACTION);
  // The axis runs from the maximum DOWN by that range: `min` in the ordinary
  // case, a little below `max` when the floor took over, and half a unit
  // below when the series is flat, which centres it.
  const lo = flat ? max - 0.5 : max - range;

  const t0 = points[0]!.at.getTime();
  const t1 = points[points.length - 1]!.at.getTime();
  const span = t1 - t0 || 1;
  const x = (p: ChartPoint) => ((p.at.getTime() - t0) / span) * 100;
  const y = (p: ChartPoint) => BOTTOM - ((p.value - lo) / range) * (BOTTOM - TOP);

  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;

  // Top to bottom, so index 0 is the maximum — the order they are read in,
  // and the order they are drawn down the axis.
  const ticks = flat
    ? [{ value: max, yPct: 50 }]
    : Array.from({ length: TICKS }, (_, i) => {
      const fraction = i / (TICKS - 1);
      return { value: max - fraction * range, yPct: ((TOP + fraction * (BOTTOM - TOP)) / 30) * 100 };
    });

  return (
    <figure className="m-0 max-w-3xl">
      <div className="flex gap-2">
        {/* Each label is CENTRED ON ITS GRIDLINE rather than distributed with
            `justify-between`, which lines up only the first and last and
            leaves the ones between it off by half a line-height — on an axis
            whose entire job is to let a value be read off a position. */}
        <div className="relative h-44 w-16 shrink-0" aria-hidden="true">
          {ticks.map((t) => (
            <span
              key={t.yPct}
              className="absolute right-0 -translate-y-1/2 text-[0.6875rem] tabular-nums text-muted-foreground"
              style={{ top: `${t.yPct}%` }}
            >
              {format(t.value)}
            </span>
          ))}
        </div>
        <svg
          viewBox="0 0 100 30"
          preserveAspectRatio="none"
          role="img"
          // The drawing read aloud: what it is, and both ends of it. A chart
          // whose label is only its title tells a screen reader that a
          // picture exists and nothing about what it shows.
          aria-label={`${label}. ${format(first)} to ${format(last)}.`}
          className="h-44 w-full text-foreground"
        >
          {ticks.map((t) => (
            <line
              key={t.yPct}
              x1="0"
              x2="100"
              y1={(t.yPct / 100) * 30}
              y2={(t.yPct / 100) * 30}
              className="stroke-border"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {segments(points).map((seg) => (
            <polyline
              key={seg[0]!.at.getTime()}
              points={seg.map((p) => `${x(p).toFixed(2)},${y(p).toFixed(2)}`).join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>
      {/* Offset by the value gutter so "now" sits under the right edge of the
          plot and not under the figure. */}
      <figcaption
        className="mt-1 ml-[4.5rem] flex justify-between text-[0.6875rem] tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        <span>{`−${formatDuration(span / 1_000)}`}</span>
        <span>{`−${formatDuration(span / 2_000)}`}</span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}

/**
 * Split the series wherever pgops stopped looking.
 *
 * A polyline drawn straight across a hole asserts the values in between, and
 * this console holds "we could not look" apart from "we looked" everywhere
 * else — the same rule that makes `query_load` write no row for an interval
 * it could not measure rather than a zero.
 *
 * THREE TIMES THE MEDIAN SPACING, and the multiple comes from the scheduler.
 * A capture already in progress on another replica is SKIPPED, never queued,
 * so a single missing tick is the normal working of the design rather than an
 * outage — breaking the line there would draw a hole in every healthy
 * deployment with two replicas. Two consecutive misses is not routine, and
 * that is what this catches.
 */
function segments(points: readonly ChartPoint[]): ChartPoint[][] {
  if (points.length < 3) return [[...points]];
  const gaps = points.slice(1).map((p, i) => p.at.getTime() - points[i]!.at.getTime());
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const out: ChartPoint[][] = [[points[0]!]];
  for (let i = 1; i < points.length; i += 1) {
    if (gaps[i - 1]! > median * 3) out.push([]);
    out[out.length - 1]!.push(points[i]!);
  }
  // A one-point segment has no line to draw and would render an invisible
  // polyline; the gap either side of it is the reading.
  return out.filter((s) => s.length > 1);
}
