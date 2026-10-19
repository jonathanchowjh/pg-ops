'use client';

import { useState, type PointerEvent } from 'react';
import { nearest, ticks, type ChartPoint } from '@/lib/chart';
import { formatUnit, formatUtc, type Unit } from '@/lib/format';

export type HealthChartPoint = ChartPoint;

const HEIGHT = 30;
const TOP = 2;
const BOTTOM = 28;

/** The moment under a pointer, from its place across the plot it is over. */
export function momentAt(e: PointerEvent<Element>, from: number, to: number): number | null {
  const plot = (e.target as Element).closest('[data-plot]');
  if (plot === null) return null;
  const box = plot.getBoundingClientRect();
  if (box.width <= 0) return null;
  const across = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  // Capped just short of `to`, so the right edge reads the last bucket and not one past it.
  return Math.min(from + across * (to - from), to - 1);
}

/**
 * One series over a window, as an inline SVG with no charting dependency.
 *
 * - A null is a hole the line breaks at; `withGaps` in lib/chart.ts makes
 *   them from uneven spacing for series that have none.
 * - The x axis is the window (`from`..`to`), so every chart on a page can
 *   share one time axis and one cursor.
 * - The y axis starts at zero unless told otherwise, and is ruled at round
 *   values up to the first one past the peak.
 *
 * The labels are HTML, not `<text>` in the SVG. `preserveAspectRatio="none"`
 * lets CSS size the plot while the geometry stays 0..100 by 0..30, but it
 * scales the axes by different factors, which would stretch any glyph drawn
 * inside.
 *
 * The cursor is a moment, not a pixel. The board passes one so every chart
 * reads the same bucket; a chart on its own keeps its own, from the pointer
 * over its plot. Either way the readout snaps to the nearest reading and
 * marks it.
 */
export function HealthChart({
  label, unit, points, from, to,
  ceiling = null, inner, innerLabel, fit = null,
  zero = true, compact = false, empty, note = null, cursor,
}: {
  label: string;
  unit: Unit;
  points: readonly HealthChartPoint[];
  from: number;
  to: number;
  /** A known limit. Ruled across the plot, and the axis reaches it. */
  ceiling?: number | null;
  /** A second, lighter line on the same scale: one database's share of a server total. */
  inner?: readonly HealthChartPoint[];
  innerLabel?: string;
  /** A straight-line fit, as its values at `from` and `to`. */
  fit?: { fromValue: number; toValue: number } | null;
  zero?: boolean;
  compact?: boolean;
  /** Shown instead of the plot when every reading is null. */
  empty?: string;
  note?: string | null;
  /** A moment in epoch ms, or null for none. Undefined, and the chart tracks its own pointer. */
  cursor?: number | null;
}) {
  const [own, setOwn] = useState<number | null>(null);
  const controlled = cursor !== undefined;
  const at = controlled ? cursor : own;

  const seen = points.filter((p): p is { at: number; value: number } => p.value !== null);
  if (seen.length === 0) {
    return (
      <figure className="m-0">
        <figcaption className="text-sm font-medium">{label}</figcaption>
        <p className={`text-muted-foreground ${compact ? 'text-xs' : 'text-sm'}`}>
          {empty ?? 'No reading in this window.'}
        </p>
      </figure>
    );
  }

  const values = seen.map((p) => p.value);
  const peak = Math.max(...values);
  const latest = seen[seen.length - 1]!.value;
  const hi = Math.max(peak, ceiling ?? peak);
  const lo = Math.min(...values);
  // A series that never moved off a non-zero level is one line through the
  // middle under one label, not a slope magnified out of nothing. Where it
  // did move, 2% of the reading floors the range so a change far smaller
  // than the level stays near-flat.
  const flat = !zero && lo === hi;
  const wanted = zero ? hi : Math.max(hi - lo, Math.abs(hi) * 0.02);
  // Offsets from the foot of a zero-based axis, or from the top of one that
  // is not. The last one is the axis's full range, rounded up to a gridline.
  const rules = flat ? [0] : ticks(wanted, unit);
  const range = flat ? 1 : rules[rules.length - 1]! || 1;
  const top = zero ? range : flat ? hi + 0.5 : hi;
  const base = top - range;
  const span = to - from || 1;
  const x = (t: number) => ((t - from) / span) * 100;
  const y = (v: number) => BOTTOM - ((v - base) / range) * (BOTTOM - TOP);
  const xy = (p: { at: number; value: number }) => `${x(p.at).toFixed(2)},${y(p.value).toFixed(2)}`;
  const gridlines = rules.map((r) => ({
    value: zero ? r : hi - r,
    text: zero || r === 0 ? formatUnit(unit, zero ? r : hi) : `−${formatUnit(unit, r)}`,
  }));

  const under = at === null ? null : points[nearest(points, at)] ?? null;
  const innerUnder = at === null || inner === undefined ? null : inner[nearest(inner, at)] ?? null;

  const scrub = controlled ? undefined : (e: PointerEvent<HTMLDivElement>) => setOwn(momentAt(e, from, to));
  const leave = controlled ? undefined : () => setOwn(null);

  return (
    <figure className="m-0 min-w-0">
      <figcaption className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="shrink-0 tabular-nums">
          {under === null ? formatUnit(unit, latest) : (
            <>
              <span className="text-muted-foreground">{formatUtc(under.at)} · </span>
              <span className="font-medium">{under.value === null ? 'no reading' : formatUnit(unit, under.value)}</span>
              {innerUnder?.value == null ? null : (
                <span className="text-muted-foreground"> · {innerLabel} {formatUnit(unit, innerUnder.value)}</span>
              )}
            </>
          )}
        </span>
      </figcaption>
      <div className="mt-2 flex gap-2">
        {compact ? null : (
          // Stretched to the plot's height by the flex row, so each label
          // sits on its gridline whatever the plot's aspect comes to.
          <div className="relative w-16 shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground" aria-hidden="true">
            {gridlines.map((g) => (
              <span key={g.value} className="absolute right-0 -translate-y-1/2" style={{ top: `${(y(g.value) / HEIGHT) * 100}%` }}>
                {g.text}
              </span>
            ))}
          </div>
        )}
        {/* `data-plot` is what a cursor measures against, and `touch-pan-y`
            is what lets a horizontal drag scrub the cursor on a phone while a
            vertical one still scrolls the page. The height follows the width,
            within limits: a wide plot that stays short cannot be read. */}
        <div
          data-plot
          className={`relative w-full touch-pan-y ${compact ? 'aspect-[3/1] max-h-20 min-h-12' : 'aspect-[5/2] max-h-72 min-h-40'}`}
          onPointerMove={scrub} onPointerDown={scrub} onPointerLeave={leave}
        >
          <svg
            viewBox={`0 0 100 ${HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${label}. Latest ${formatUnit(unit, latest)}, peak ${formatUnit(unit, peak)}.`}
            className="h-full w-full overflow-visible text-foreground"
          >
            {(compact ? [gridlines[0]!] : gridlines).map((g) => (
              <line
                key={g.value} data-gridline x1="0" x2="100" y1={y(g.value)} y2={y(g.value)}
                className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke"
              />
            ))}
            {ceiling === null ? null : (
              <line
                data-series="ceiling" x1="0" x2="100" y1={y(ceiling)} y2={y(ceiling)}
                className="text-critical-ink" stroke="currentColor" strokeWidth="1"
                strokeDasharray="4 3" vectorEffect="non-scaling-stroke"
              />
            )}
            {fit === null ? null : (
              <line
                data-series="fit" x1="0" x2="100" y1={y(fit.fromValue)} y2={y(fit.toValue)}
                className="text-muted-foreground" stroke="currentColor" strokeWidth="1"
                strokeDasharray="2 3" vectorEffect="non-scaling-stroke"
              />
            )}
            {inner === undefined ? null : runs(inner).filter((r) => r.length > 1).map((r) => (
              <polyline
                key={r[0]!.at} data-series="inner" points={r.map(xy).join(' ')} fill="none"
                className="text-muted-foreground" stroke="currentColor" strokeWidth="1"
                strokeLinejoin="round" vectorEffect="non-scaling-stroke"
              />
            ))}
            {runs(points).map((r) => (r.length > 1 ? (
              <polyline
                key={r[0]!.at} data-series="main" points={r.map(xy).join(' ')} fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
              />
            ) : (
              // One reading with a gap on both sides. A zero-length line with
              // a round cap is a dot that does not stretch with the viewBox.
              <Dot key={r[0]!.at} at={r[0]!} x={x} y={y} series="main" size={3} />
            )))}
            {innerUnder?.value == null ? null : (
              <Dot at={{ at: innerUnder.at, value: innerUnder.value }} x={x} y={y} series="inner-marker" size={6} ring />
            )}
            {under?.value == null ? null : (
              <Dot at={{ at: under.at, value: under.value }} x={x} y={y} series="marker" size={8} ring />
            )}
          </svg>
          {under === null ? null : (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px bg-foreground/60"
              style={{ left: `${Math.min(100, Math.max(0, x(under.at)))}%` }}
            />
          )}
        </div>
      </div>
      {compact ? null : (
        <div className="mt-1 ml-[4.5rem] flex justify-between text-[0.6875rem] tabular-nums text-muted-foreground" aria-hidden="true">
          <span>{formatUtc(from)}</span>
          <span>{formatUtc(to)} UTC</span>
        </div>
      )}
      {innerLabel === undefined || compact ? null : (
        <p className="ml-[4.5rem] text-xs text-muted-foreground">Lighter line: {innerLabel}.</p>
      )}
      {note === null || compact ? null : <p className="ml-[4.5rem] text-xs text-muted-foreground">{note}</p>}
    </figure>
  );
}

/**
 * A dot of `size` px that does not stretch with the viewBox. With `ring`,
 * a surface-coloured halo first, so it stays legible on the line it marks.
 */
function Dot({ at, x, y, series, size, ring = false }: {
  at: { at: number; value: number };
  x: (t: number) => number;
  y: (v: number) => number;
  series: string;
  size: number;
  ring?: boolean;
}) {
  const pos = { x1: x(at.at), x2: x(at.at), y1: y(at.value), y2: y(at.value) };
  return (
    <>
      {ring ? (
        <line {...pos} className="stroke-background" strokeWidth={size + 4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ) : null}
      <line
        {...pos} data-series={series}
        className={series === 'inner-marker' ? 'text-muted-foreground' : undefined}
        stroke="currentColor" strokeWidth={size} strokeLinecap="round" vectorEffect="non-scaling-stroke"
      />
    </>
  );
}

/** Split a series into stretches of consecutive readings. A null ends a stretch. */
function runs(points: readonly HealthChartPoint[]): { at: number; value: number }[][] {
  const out: { at: number; value: number }[][] = [];
  let run: { at: number; value: number }[] = [];
  for (const p of points) {
    if (p.value === null) {
      if (run.length > 0) out.push(run);
      run = [];
    } else {
      run.push({ at: p.at, value: p.value });
    }
  }
  if (run.length > 0) out.push(run);
  return out;
}
