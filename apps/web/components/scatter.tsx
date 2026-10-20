'use client';

import Link from 'next/link';
import { useState, type FocusEvent, type MouseEvent } from 'react';
import { useWidth } from '@/components/clock';
import { CHAR_PX } from '@/lib/clock';
import { formatCount, formatRate, formatUnit, type Unit } from '@/lib/format';
import { along, byteDecades, decades, isoLine, layScatter, type LogAxis, type Mark, type Placed } from '@/lib/plot';
import { cn } from '@/lib/utils';

// Two decimals: the browser keeps six significant digits of a style, and any more is a hydration mismatch.
const pct = (v: number): string => `${Math.round(v * 10_000) / 100}%`;
/** A tick is a power of ten, or of a binary unit for bytes, printed as one: a mean's "<0.1ms" would label two ticks alike. */
const tickLabel = (unit: Unit, v: number): string => (unit === 'millis' && v < 0.1 ? `${formatRate(v)}ms` : formatUnit(unit, v));
/** Left, top, right, bottom, in pixels from the plot's top left. */
type Box = [number, number, number, number];
/**
 * The named points whose labels fit, heaviest first: a label that would
 * cover another, a named point or a box already `taken` is left to the readout.
 */
function fitting(named: readonly Placed[], at: (m: Placed) => [number, number], width: number, taken: readonly Box[] = []): Set<string> {
  const boxes: Box[] = [...taken, ...named.map((m): Box => {
    const [x, y] = at(m);
    return [x - 6, y - 6, x + 6, y + 6];
  })];
  const kept = new Set<string>();
  for (const m of named) {
    const [x, y] = at(m);
    const w = m.label.length * CHAR_PX;
    const x1 = (m.cx ?? 0) > 0.7 ? x - 8 - w : x + 8;
    const box: Box = [x1, y - 8, x1 + w, y + 8];
    if (x1 < 0 || box[2] > width + 24) continue;
    if (boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
    boxes.push(box);
    kept.add(m.id);
  }
  return kept;
}
/** The band's share of the plot's width, when there is one. */
const BAND = 0.12;
/** A long axis is ruled at every other decade, or every third: as many as `px` holds at one label per `per`. */
const ticks = (axis: LogAxis, unit: Unit, px: number, per: number): number[] => {
  const all = unit === 'bytes' ? byteDecades(axis) : decades(axis);
  const step = Math.ceil(all.length / Math.max(2, Math.min(8, Math.floor(px / per))));
  return all.filter((_, i) => i % step === 0);
};

/**
 * A population on two log axes: which of many matter. The heaviest points
 * are named, every point reads out under the pointer and links to its node,
 * and the page lists the same rows under it.
 *
 * Positions are percentages of the box, and every label is HTML: an
 * SVG stretched to fit would stretch its text. Warning ink is the thing to
 * hunt; everything else is a shade of ink.
 */
export function Scatter({ marks, x, y, band, iso = [] }: {
  /** A label or a line that holds statement text is redacted by the page that builds it. */
  marks: readonly Mark[];
  x: { label: string; unit: Unit };
  y: { label: string; unit: Unit };
  /** The name of the band at the left, for points with no x: "never", "none". */
  band?: string;
  /** Lines of equal x × y, each labelled where it starts. */
  iso?: readonly { product: number; label: string }[];
}) {
  const [hover, setHover] = useState<{ id: string; left: number; top: number } | null>(null);
  const [box, width] = useWidth<HTMLDivElement>();
  if (marks.length === 0) return <p className="px-3 py-6 text-muted-foreground">nothing to plot</p>;
  const laid = layScatter(marks);
  const shown = hover === null ? undefined : laid.marks.find((m) => m.id === hover.id);
  const inset = band === undefined ? 0 : BAND;
  /** Across the whole box: the band takes the left of it. */
  const share = (cx: number | null): number => (cx === null ? inset / 2 : inset + cx * (1 - inset));
  const across = (cx: number | null): string => pct(share(cx));
  // 2.8 wide to 1 high, from 220 to 420. Set here, not by `aspect-ratio`: with a
  // minimum height that widens a narrow plot past the screen.
  const height = Math.round(Math.max(220, Math.min(420, width / 2.8)));
  const lines = iso.flatMap((l) => {
    const at = isoLine(laid.x, laid.y, l.product);
    return at === null ? [] : [{ ...at, label: l.label }];
  });
  // A line's label sits where it starts; one that would run into the label before it, or past the plot, is left off.
  const lineLabels: typeof lines = [];
  for (const l of lines) {
    const prev = lineLabels.at(-1);
    if (share(l.x1) * width + 4 + l.label.length * CHAR_PX > width) continue;
    if (prev === undefined || l.y1 !== prev.y1 || (l.x1 - prev.x1) * width * (1 - inset) > prev.label.length * CHAR_PX + 8) lineLabels.push(l);
  }
  // A line's label is laid first: a point's label gives way to it, not the other way.
  const labelled = fitting(
    laid.marks.filter((m) => m.named).reverse(), (m) => [share(m.cx) * width, (1 - m.cy) * height], width,
    lineLabels.map((l): Box => {
      const lx = share(l.x1) * width + 4;
      const ly = (1 - l.y1) * height;
      return [lx, ly - 16, lx + l.label.length * CHAR_PX, ly];
    }),
  );

  return (
    <figure className="m-0 px-3 pt-1 pb-2">
      <figcaption className="font-mono text-xs/4 text-body">{y.label}</figcaption>
      <div ref={box} className="relative mt-1 mb-6 ml-16" style={{ height }}>
        {band === undefined ? null : (
          <div className="absolute inset-y-0 left-0 rounded-xs bg-muted" style={{ width: pct(inset * 0.9) }}>
            <span className="absolute top-full left-1/2 mt-1 -translate-x-1/2 font-mono text-xs/4 text-body">{band}</span>
          </div>
        )}
        {ticks(laid.y, y.unit, height, 40).map((v) => (
          <i key={v} aria-hidden className="absolute inset-x-0 border-t border-border" style={{ bottom: pct(along(laid.y, v)) }}>
            <span className="absolute right-full mr-1.5 -translate-y-1/2 font-mono text-xs/4 whitespace-nowrap text-body">{tickLabel(y.unit, v)}</span>
          </i>
        ))}
        {ticks(laid.x, x.unit, width * (1 - inset), 96).map((v) => (
          <i key={v} aria-hidden className="absolute inset-y-0 border-l border-border" style={{ left: across(along(laid.x, v)) }}>
            <span className="absolute top-full mt-1 -translate-x-1/2 font-mono text-xs/4 whitespace-nowrap text-body">{tickLabel(x.unit, v)}</span>
          </i>
        ))}
        <svg
          aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none"
          className="absolute inset-y-0 h-full" style={{ left: pct(inset), width: pct(1 - inset) }}
        >
          {lines.map((l) => (
            <line
              key={l.label} x1={l.x1 * 100} y1={100 - l.y1 * 100} x2={l.x2 * 100} y2={100 - l.y2 * 100}
              vectorEffect="non-scaling-stroke" strokeDasharray="4 4" className="stroke-muted-foreground"
            />
          ))}
        </svg>
        {lineLabels.map((l) => (
          <span
            key={l.label}
            className="pointer-events-none absolute ml-1 font-sans text-xs/4 whitespace-nowrap text-muted-foreground"
            style={{ left: across(l.x1), bottom: pct(l.y1) }}
          >
            {l.label}
          </span>
        ))}
        {laid.marks.map((m) => {
          const at = { left: across(m.cx), bottom: pct(m.cy) };
          const cls = cn(
            // The hit area is wider than the dot: a ten-pixel target is one nobody lands on.
            'absolute -mb-[5px] -ml-[5px] block size-2.5 rounded-full ring-[1.5px] ring-card before:absolute before:-inset-[7px] before:rounded-full',
            m.flag ? 'bg-warning-ink' : m.named ? 'bg-foreground/75' : 'bg-foreground/45',
          );
          const enter = (e: MouseEvent<HTMLElement>): void => setHover({ id: m.id, left: e.clientX, top: e.clientY });
          const focus = (e: FocusEvent<HTMLElement>): void => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover({ id: m.id, left: r.right, top: r.bottom });
          };
          const leave = (): void => setHover(null);
          const where = m.cx === null ? '' : undefined;
          return m.href === null
            ? <i key={m.id} data-dot data-band={where} className={cls} style={at} onMouseEnter={enter} onMouseLeave={leave} />
            : <Link
              key={m.id} data-dot data-band={where} href={m.href} aria-label={m.label === '' ? m.id : m.label} className={cls} style={at}
              onMouseEnter={enter} onMouseLeave={leave} onFocus={focus} onBlur={leave}
            />;
        })}
        {laid.marks.filter((m) => labelled.has(m.id)).map((m) => (
          <span
            key={m.id}
            className={cn(
              'pointer-events-none absolute -mb-2 font-sans text-xs/4 whitespace-nowrap text-foreground',
              (m.cx ?? 0) > 0.7 ? '-ml-2 -translate-x-full' : 'ml-2',
            )}
            style={{ left: across(m.cx), bottom: pct(m.cy) }}
          >
            {m.label}
          </span>
        ))}
      </div>
      <div className="text-right font-mono text-xs/4 text-body">{x.label}</div>
      {laid.dropped === 0 ? null : (
        <p className="text-xs text-muted-foreground">{formatCount(laid.dropped)} more not drawn; every flagged one is.</p>
      )}
      {shown === undefined || hover === null ? null : (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-20 max-w-80 rounded-[5px] bg-foreground px-2 py-1.5 text-xs/[17px] text-card shadow-lg"
          style={{ left: hover.left + 14, top: hover.top + 16 }}
        >
          <span className="font-mono">{shown.label === '' ? shown.id : shown.label}</span>
          {shown.lines.map((l, i) => <span key={i} className="block">{l}</span>)}
        </div>
      )}
    </figure>
  );
}
