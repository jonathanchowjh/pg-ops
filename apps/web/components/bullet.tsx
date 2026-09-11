import { cn } from '@/lib/utils';

/**
 * A bullet graph: one measure drawn to scale, over the bands that decide its
 * verdict.
 *
 * Stephen Few designed this to replace dashboard gauges, and it is the exact
 * shape of the data these checks already carry — a featured measure, a linear
 * scale, and "two to five ranges declaring its qualitative state". The
 * console had none of it: `connections.ts` computes `headroom / max * 100`
 * and escalates below 20% and 10%, and the UI rendered the string
 * `23 / 100 used · 74 free`. The one number that produces the verdict was the
 * one number never shown, and nothing anywhere was drawn to scale.
 *
 * Length, not area or angle: NN/g's summary of the preattentive research is
 * that length and 2D position are the encodings people read accurately, while
 * area (pie, treemap) is not, and circular gauges "consume a lot of precious
 * space" for less. So this is a straight bar, and the bands sit behind it on
 * the same axis rather than beside it.
 *
 * `aria-hidden`, deliberately and not by omission. Every value drawn here is
 * already rendered as text next to it, and the thresholds are stated in
 * words by CheckPanel's Guidance block. A screen reader announcing the bar
 * as well would read the same fact twice, which is noise, not access. This
 * is redundant visual encoding of text that is already there — which is also
 * why it degrades safely if it fails to render at all.
 */
export function Bullet({
  value,
  max,
  bands = [],
  className,
}: {
  value: number;
  max: number;
  /**
   * Where each qualitative range STARTS, as a percentage of `max`.
   *
   * Percentages rather than absolute values because that is the form the
   * thresholds arrive in for the check this was built for, and converting
   * once at the call site keeps the arithmetic next to the threshold it
   * came from rather than hidden in here.
   */
  bands?: { from: number; level: 'warn' | 'critical' }[];
  className?: string;
}) {
  // A zero or negative `max` is not a drawing problem to be clamped away —
  // there is no scale, so there is nothing to draw to scale, and a bar
  // rendered against a scale that does not exist is a picture of a number
  // nobody measured.
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(value)) return null;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));

  return (
    <div
      aria-hidden
      className={cn('relative h-2.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      {bands.map((b) => (
        <div
          key={`${b.level}-${b.from}`}
          className={cn(
            'absolute inset-y-0',
            b.level === 'critical' ? 'bg-destructive/20' : 'bg-warning/20',
          )}
          style={{ left: `${b.from}%`, right: 0 }}
        />
      ))}
      {/* Drawn last so it sits over the bands. Its own colour tracks the band
          it has reached, so the bar and the badge above it cannot disagree. */}
      <div
        className={cn('absolute inset-y-0 left-0 rounded-full', barColour(pct, bands))}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * The worst band this value has entered.
 *
 * Iterates rather than assuming order: `bands` is written at the call site
 * next to the thresholds it mirrors, and nothing there guarantees the
 * critical band is listed after the warn one.
 */
function barColour(pct: number, bands: { from: number; level: 'warn' | 'critical' }[]): string {
  if (bands.some((b) => b.level === 'critical' && pct >= b.from)) return 'bg-destructive';
  if (bands.some((b) => b.level === 'warn' && pct >= b.from)) return 'bg-warning';
  return 'bg-foreground/70';
}
