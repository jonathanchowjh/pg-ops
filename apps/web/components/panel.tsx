'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Axis, ClockLines, Track, setHover, useClock } from '@/components/clock';
import { CLASS_BG, CLASS_FILL } from '@/components/tree-rows';
import { clockTime, fractionAt, type CLASSES } from '@/lib/clock';
import { formatUnit, type Unit } from '@/lib/format';
import { byHourOfDay, byteSteps } from '@/lib/plot';
import { scaleSteps } from '@/lib/tree';
import { cn } from '@/lib/utils';

/** A series' ink: a class hue where the series is a class, and otherwise a shade of ink, darkest first. */
export type Tone = (typeof CLASSES)[number] | 0 | 1 | 2;
const FILL: Record<Tone, string> = { ...CLASS_FILL, 0: 'fill-foreground/75', 1: 'fill-foreground/45', 2: 'fill-foreground/22' };
const KEY: Record<Tone, string> = { ...CLASS_BG, 0: 'bg-foreground/75', 1: 'bg-foreground/45', 2: 'bg-foreground/22' };
const STROKE: Record<Tone, string> = {
  cpu: 'stroke-class-cpu', io: 'stroke-class-io', idle: 'stroke-class-idle', other: 'stroke-class-other', lock: 'stroke-class-lock',
  0: 'stroke-foreground/75', 1: 'stroke-foreground/45', 2: 'stroke-foreground/22',
};

export interface Series { name: string; tone: Tone; values: readonly (number | null)[] }

const r2 = (n: number): number => Math.round(n * 100) / 100;
const NUM = 'mr-1.5 inline-block min-w-10 text-right font-mono';
const DOT = 'mr-1.5 inline-block size-2 rounded-xs align-middle';
const CARD = 'min-w-0 overflow-hidden rounded-md border bg-card';
const HEAD = 'flex flex-wrap items-baseline gap-2.5 px-3 pt-2 pb-1';
const TITLE = 'm-0 text-[13px]/[18px] font-semibold text-foreground';
const NOTE = 'ml-1.5 font-normal text-muted-foreground';
/** Two labelled marks nearer than this fraction of the plot would print over each other. */
const LABEL_GAP = 0.12;
/** A class's share of a column at or below this is left out of the readout, as the tree's readout leaves it. */
const READ_FLOOR = 0.05;

/**
 * One fact about a node across the clock's window: a title, a y axis ruled
 * at round steps in its unit, its own clock axis, a legend when it has more
 * than one series, and the same numbers as a table. It reads the page's one
 * cursor: a click pins, a drag selects, the pointer reads out.
 */
export function Panel({ title, note, unit, kind, series, limit, marks = [], wide = false }: {
  title: string;
  /** What the y axis measures, said once beside the title. */
  note?: string;
  unit: Unit;
  /** `stack`: the series stand on each other, filled. `line`: each on its own. */
  kind: 'stack' | 'line';
  /** One value a column of the clock's window. Null where nothing was kept. */
  series: readonly Series[];
  /** A dashed line the series are read against: a trigger, a limit. */
  limit?: { name: string; values: readonly (number | null)[] };
  /** Events on this panel's clock. */
  marks?: readonly { at: number; label: string }[];
  /** Both columns of the page's grid. */
  wide?: boolean;
}) {
  const { grid, offset } = useClock();
  const n = Math.max(1, series[0]?.values.length ?? 0);
  const at = (s: { values: readonly (number | null)[] }, c: number): number => s.values[c] ?? 0;
  const said = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : formatUnit(unit, v));
  /** A rule is a round number already: a session count's two decimals would be noise there. */
  const ruled = (v: number): string => (unit === 'sessions' ? String(v) : formatUnit(unit, v));

  let max = 0;
  for (let c = 0; c < n; c += 1) {
    const stacked = series.reduce((a, s) => a + at(s, c), 0);
    const highest = series.reduce((a, s) => Math.max(a, at(s, c)), 0);
    max = Math.max(max, kind === 'stack' ? stacked : highest, limit === undefined ? 0 : at(limit, c));
  }
  const steps = unit === 'bytes' ? byteSteps(max * 1.05) : scaleSteps(max * 1.05);
  const top = steps.at(-1)!;
  const y = (v: number): number => r2(100 - (v / top) * 100);

  /** A series as filled steps standing on the ones before it. */
  const filled = (i: number): string => {
    let d = '';
    for (let c = 0; c < n; c += 1) {
      const v = at(series[i]!, c);
      if (v <= 0) continue;
      let base = 0;
      for (let j = 0; j < i; j += 1) base += at(series[j]!, c);
      d += `M${c} ${y(base + v)}h1v${r2((v / top) * 100)}h-1z`;
    }
    return d;
  };
  /** A series as a line, broken where nothing was kept. */
  const traced = (values: readonly (number | null)[]): string => {
    let d = '';
    let pen = false;
    for (let c = 0; c < n; c += 1) {
      const v = values[c];
      if (v === null || v === undefined) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${c + 0.5} ${y(v)}`;
      pen = true;
    }
    return d;
  };

  const tip = (t: number): ReactNode => {
    const c = Math.max(0, Math.min(n - 1, Math.floor(fractionAt(grid, t) * n)));
    return (
      <>
        {' '}{title}
        {kind === 'stack' && series.length > 1
          ? <><br /><b className={NUM}>{formatUnit(unit, series.reduce((a, s) => a + at(s, c), 0))}</b>in all</>
          : null}
        {[...series].reverse().filter((s) => typeof s.tone === 'number' || at(s, c) > READ_FLOOR).map((s) => (
          <span key={s.name}><br /><b className={NUM}>{said(s.values[c])}</b><i className={cn(DOT, KEY[s.tone])} />{s.name}</span>
        ))}
        {limit === undefined ? null : <span><br /><b className={NUM}>{said(limit.values[c])}</b>{limit.name}</span>}
      </>
    );
  };

  let labelled = -1;
  const drawn = marks.filter((m) => m.at >= grid.from && m.at <= grid.to).sort((a, b) => a.at - b.at).map((m) => {
    const x = fractionAt(grid, m.at);
    const named = x - labelled > LABEL_GAP;
    if (named) labelled = x;
    return { ...m, x, named };
  });
  const names = [...series.map((s) => ({ name: s.name, key: KEY[s.tone] })), ...(limit === undefined ? [] : [{ name: limit.name, key: 'bg-foreground' }])];
  const kept = [...series, ...(limit === undefined ? [] : [limit])].some((s) => s.values.some((v) => v !== null));

  return (
    <section className={cn(CARD, wide && 'md:col-span-2')}>
      <header className={HEAD}>
        <h3 className={TITLE}>{title}{note === undefined ? null : <small className={NOTE}>{note}</small>}</h3>
        {names.length < 2 ? null : (
          <span data-legend className="ml-auto flex flex-wrap gap-x-3 text-xs text-body">
            {names.map((k) => <span key={k.name} className="flex items-center gap-1.5"><i aria-hidden className={cn('size-2 rounded-xs', k.key)} />{k.name}</span>)}
          </span>
        )}
      </header>
      {!kept ? <p className="px-3 pb-3 text-xs text-muted-foreground">nothing kept for this window</p> : (
        <>
          <div className="relative mr-3 ml-14">
            <Track className="aspect-[2.8/1] max-h-[280px] min-h-40 w-full border-l" tip={tip}>
              {steps.slice(1).map((v) => (
                <i key={v} aria-hidden className="absolute inset-x-0 border-t border-border" style={{ bottom: `${(v / top) * 100}%` }}>
                  <span className="absolute right-full mr-1.5 -translate-y-1/2 font-mono text-xs/4 whitespace-nowrap text-body">{ruled(v)}</span>
                </i>
              ))}
              <svg aria-hidden viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" className="absolute inset-0 size-full">
                {series.map((s, i) => (kind === 'stack'
                  ? <path key={s.name} d={filled(i)} className={FILL[s.tone]} />
                  : <path key={s.name} d={traced(s.values)} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" className={STROKE[s.tone]} />))}
                {limit === undefined ? null : (
                  <path d={traced(limit.values)} fill="none" strokeWidth="1.5" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" className="stroke-foreground" />
                )}
              </svg>
              {drawn.map((m) => (
                <i key={`${m.at}/${m.label}`} data-mark aria-hidden className="absolute inset-y-0 border-l border-dashed border-foreground" style={{ left: `${m.x * 100}%` }}>
                  {/* Near the right edge the label reads leftwards, or the card would cut it. */}
                  {m.named ? <span className={cn('absolute top-0 rounded-xs bg-card px-0.5 text-xs/4 whitespace-nowrap text-foreground', m.x > 0.85 ? 'right-1' : 'left-1')}>{m.label}</span> : null}
                </i>
              ))}
            </Track>
            <Axis grid={grid} offset={offset} className="border-l" />
            <ClockLines className="inset-x-0" />
          </div>
          <table className="sr-only">
            <caption>{title}</caption>
            <thead><tr><th>Time</th>{names.map((k) => <th key={k.name}>{k.name}</th>)}</tr></thead>
            <tbody>
              {Array.from({ length: n }, (_, c) => {
                const t = grid.from + (c * (grid.to - grid.from)) / n;
                return (
                  <tr key={c}>
                    <th suppressHydrationWarning>{clockTime(t, offset(t))}</th>
                    {series.map((s) => <td key={s.name}>{said(s.values[c])}</td>)}
                    {limit === undefined ? null : <td>{said(limit.values[c])}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Is this hour normal for this hour: the day the window ends on, hour by
 * hour, over the mean of the seven days before it, in two shades of ink.
 * The hour the cursor is in is ringed, so the panel moves with the clock
 * like the rest.
 *
 * Drawn after mount: which hour a moment falls in is the reader's zone,
 * which the server does not know, and a bar's height is not text React can
 * be told to leave alone.
 */
export function Rhythm({ hours }: { hours: readonly { at: number; sessions: number }[] }) {
  const { grid, at, offset } = useClock();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const end = grid.to - 1;
  const zone = offset(end);
  const { mean, today } = byHourOfDay(hours, end, zone);
  const top = Math.max(1e-9, ...mean, ...today.map((v) => v ?? 0));
  const dayStart = Math.floor((end + zone * 60_000) / DAY_MS) * DAY_MS - zone * 60_000;
  const marked = at >= dayStart && at < dayStart + DAY_MS ? Math.floor((at - dayStart) / HOUR_MS) : -1;
  const said = (v: number): string => formatUnit('sessions', v);

  return (
    <section className={cn(CARD, 'md:col-span-2')}>
      <header className={HEAD}>
        <h3 className={TITLE}>Rhythm<small className={NOTE}>sessions not idle by hour: this day over the mean of the seven before</small></h3>
        <span data-legend className="ml-auto flex flex-wrap gap-x-3 text-xs text-body">
          <span className="flex items-center gap-1.5"><i aria-hidden className="size-2 rounded-xs bg-foreground/75" />This day</span>
          <span className="flex items-center gap-1.5"><i aria-hidden className="size-2 rounded-xs bg-foreground/22" />Mean</span>
        </span>
      </header>
      <div className="flex h-40 gap-0.5 px-3" onMouseLeave={() => setHover(null)}>
        {!mounted ? null : mean.map((m, h) => (
          <div
            key={h}
            data-hour={h}
            data-marked={h === marked ? '' : undefined}
            className={cn('relative h-full flex-1', h === marked && 'shadow-[inset_0_0_0_1.5px_var(--foreground)]')}
            onMouseMove={(e) => setHover({
              t: dayStart + h * HOUR_MS, x: e.clientX, y: e.clientY,
              tip: (
                <>
                  {today[h] === null || today[h] === undefined ? null : <><br /><b className={NUM}>{said(today[h]!)}</b>this day</>}
                  <br /><b className={NUM}>{said(m)}</b>mean of the seven before
                </>
              ),
            })}
          >
            <b className="absolute inset-x-0 bottom-0 rounded-t-xs bg-foreground/22" style={{ height: `${(m / top) * 100}%` }} />
            {today[h] === null || today[h] === undefined ? null : (
              <u className="absolute inset-x-[22%] bottom-0 rounded-t-xs bg-foreground/75" style={{ height: `${(today[h]! / top) * 100}%` }} />
            )}
          </div>
        ))}
      </div>
      <div aria-hidden className="flex gap-0.5 px-3 pb-2 font-mono text-xs/5 text-body">
        {mean.map((_, h) => <span key={h} className="flex-1 text-center">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>)}
      </div>
    </section>
  );
}
