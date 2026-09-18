/**
 * A sparkline, as an inline SVG polyline. No charting dependency: this is two
 * sparklines in the whole console, and `apps/web` is deliberately thin.
 *
 * `viewBox` with `preserveAspectRatio="none"` means the caller sizes it in
 * CSS and the geometry below is always 0..100 by 0..30 — so there is no
 * measurement, no ref, and nothing that behaves differently on the server.
 */
export function Spark({ points, label }: { points: readonly number[]; label: string }) {
  if (points.length === 0) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  // A flat series has range 0, and (v - min) / 0 is NaN — an SVG with NaN
  // coordinates renders NOTHING, which would make the most ordinary case
  // (a relation that has not changed) look like a broken chart.
  const range = max - min || 1;
  const step = points.length === 1 ? 0 : 100 / (points.length - 1);
  const coords = points
    .map((v, i) => `${(i * step).toFixed(2)},${(30 - ((v - min) / range) * 28 - 1).toFixed(2)}`)
    .join(' ');

  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className="h-12 w-full text-foreground"
    >
      <polyline
        points={coords}
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
