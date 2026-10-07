import { formatUnit, formatUtc, type Unit } from '@/lib/format';

export interface HealthChartPoint { at: number; value: number | null }

const HEIGHT = 30;
const TOP = 2;
const BOTTOM = 28;

/**
 * One health series over a fixed window.
 *
 * Differs from `LineChart` in the three ways stored health needs:
 *
 * - A null is a gap the reader marked, and the line BREAKS there. LineChart
 *   infers gaps from spacing because its series have no nulls.
 * - The x axis is the window (`from`..`to`), not the span of the points, so
 *   every chart on a page shares one time axis and a database with an hour
 *   of history does not stretch it across forty-eight.
 * - The y axis starts at zero unless told otherwise. These are counts and
 *   rates; three blocked sessions drawn at the top of an axis that runs from
 *   2.9 to 3.1 is the lie a zoomed axis tells.
 *
 * No hooks and no browser APIs, so it renders in a server page and inside
 * the client board alike.
 */
export function HealthChart({
  label, unit, points, from, to,
  ceiling = null, inner, innerLabel, fit = null,
  zero = true, compact = false, empty, note = null, cursor = null,
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
  /** A moment in epoch ms. The readout shows the bucket under it. */
  cursor?: number | null;
}) {
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
  const lo = zero ? 0 : Math.min(...values);
  // A window that never moved still needs a range to divide by; 2% of the
  // reading keeps a flat non-zero series from being magnified into noise.
  const range = hi > lo
    ? Math.max(hi - lo, zero ? 0 : Math.abs(hi) * 0.02)
    : (Math.abs(hi) * 0.02 || 1);
  const base = zero ? 0 : hi - range;
  const span = to - from || 1;
  const x = (at: number) => ((at - from) / span) * 100;
  const y = (v: number) => BOTTOM - ((v - base) / range) * (BOTTOM - TOP);
  const xy = (p: { at: number; value: number }) => `${x(p.at).toFixed(2)},${y(p.value).toFixed(2)}`;

  const under = cursor === null
    ? undefined
    : points[Math.min(points.length - 1, Math.max(0, Math.floor(((cursor - from) / span) * points.length)))];
  const readout = cursor === null
    ? formatUnit(unit, latest)
    : under?.value == null ? 'no reading' : formatUnit(unit, under.value);

  return (
    <figure className="m-0 min-w-0">
      <figcaption className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="shrink-0 tabular-nums">{readout}</span>
      </figcaption>
      <div className="mt-2 flex gap-2">
        {compact ? null : (
          <div className="relative h-36 w-14 shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground" aria-hidden="true">
            <span className="absolute right-0 -translate-y-1/2" style={{ top: `${(TOP / HEIGHT) * 100}%` }}>
              {formatUnit(unit, hi)}
            </span>
            <span className="absolute right-0 -translate-y-1/2" style={{ top: `${(BOTTOM / HEIGHT) * 100}%` }}>
              {zero ? formatUnit(unit, base) : `−${formatUnit(unit, range)}`}
            </span>
          </div>
        )}
        {/* `data-plot` is what the board's cursor measures against, and
            `touch-pan-y` is what lets a horizontal drag scrub the cursor on
            a phone while a vertical one still scrolls the page. */}
        <div data-plot className={`relative w-full touch-pan-y ${compact ? 'h-10' : 'h-36'}`}>
          <svg
            viewBox={`0 0 100 ${HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${label}. Latest ${formatUnit(unit, latest)}, peak ${formatUnit(unit, peak)}.`}
            className="h-full w-full overflow-visible text-foreground"
          >
            <line x1="0" x2="100" y1={BOTTOM} y2={BOTTOM} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
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
              <line
                key={r[0]!.at} data-series="main"
                x1={x(r[0]!.at)} x2={x(r[0]!.at)} y1={y(r[0]!.value)} y2={y(r[0]!.value)}
                stroke="currentColor" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke"
              />
            )))}
          </svg>
          {cursor === null ? null : (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px bg-foreground/60"
              style={{ left: `${Math.min(100, Math.max(0, x(cursor)))}%` }}
            />
          )}
        </div>
      </div>
      {compact ? null : (
        <div className="mt-1 ml-16 flex justify-between text-[0.6875rem] tabular-nums text-muted-foreground" aria-hidden="true">
          <span>{formatUtc(from)}</span>
          <span>{formatUtc(to)} UTC</span>
        </div>
      )}
      {innerLabel === undefined || compact ? null : (
        <p className="ml-16 text-xs text-muted-foreground">Lighter line: {innerLabel}.</p>
      )}
      {note === null || compact ? null : <p className="ml-16 text-xs text-muted-foreground">{note}</p>}
    </figure>
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
