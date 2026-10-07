'use client';

import { useState, type PointerEvent } from 'react';
import Link from 'next/link';
import { HealthChart } from './health-chart';
import { formatUtc } from '@/lib/format';
import type { BoardGroup } from '@/lib/health';

const ZOOM_HALF_MS = 3 * 3_600_000;

/**
 * Every chart for one database, under the four gates, with ONE cursor.
 *
 * A client component for the cursor and nothing else. It is handed numbers,
 * timestamps and fixed labels, so nothing here was ever a statement and
 * nothing needs redacting on the way into the page payload.
 *
 * The cursor is a moment in time held in state, not a pixel. Every chart
 * shares the window, so each can place the moment on its own axis and read
 * its own bucket; a pixel would be right for one chart's width only.
 */
export function HealthBoard({ name, from, to, groups }: {
  name: string;
  from: number;
  to: number;
  groups: readonly BoardGroup[];
}) {
  const [cursor, setCursor] = useState<number | null>(null);

  /**
   * One handler on the wrapper, for every plot. Mouse arrives as
   * pointermove; a touch arrives as pointerdown and then, because the plots
   * are `touch-pan-y`, as pointermove for a horizontal drag while a vertical
   * drag still scrolls the page.
   */
  const scrub = (e: PointerEvent<HTMLDivElement>) => {
    const plot = (e.target as Element).closest('[data-plot]');
    if (plot === null) return;
    const box = plot.getBoundingClientRect();
    if (box.width <= 0) return;
    const across = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    // Capped just short of `to`, so the right edge reads the last bucket and not one past it.
    setCursor(Math.min(from + across * (to - from), to - 1));
  };

  return (
    <div className="space-y-8" onPointerMove={scrub} onPointerDown={scrub}>
      {groups.map((g) => (
        <section key={g.gate} aria-labelledby={`health-${g.gate}`}>
          <h2 id={`health-${g.gate}`} className="font-semibold">{g.title}</h2>
          <div className="mt-3 grid gap-x-8 gap-y-6 lg:grid-cols-2">
            {g.charts.map((c) => (
              <HealthChart
                key={c.metric}
                label={c.scope === 'server' ? `${c.label} · server-wide` : c.label}
                unit={c.unit} points={c.points} from={from} to={to}
                ceiling={c.ceiling} inner={c.inner} innerLabel={c.innerLabel} fit={c.fit}
                zero={c.zero} empty={c.empty} cursor={cursor}
                note={[c.caveat, c.note].filter((s) => s !== null).join(' ') || null}
              />
            ))}
          </div>
        </section>
      ))}
      {cursor === null ? null : <CursorBar name={name} cursor={cursor} onClear={() => setCursor(null)} />}
    </div>
  );
}

/**
 * Pinned to the bottom of the viewport, where it cannot collide with the
 * sticky header and stays in reach while a chart far down the page is being
 * scrubbed.
 *
 * The three links go to LIVE pages. pgops does not store what sessions or
 * locks existed at a past moment, so each is labelled "now": the label is
 * the difference between a way to check whether it is still happening and a
 * promise this console cannot keep.
 */
function CursorBar({ name, cursor, onClear }: { name: string; cursor: number; onClear: () => void }) {
  const zoomFrom = new Date(cursor - ZOOM_HALF_MS).toISOString();
  const zoomTo = new Date(Math.min(cursor + ZOOM_HALF_MS, Date.now())).toISOString();
  const link = 'underline underline-offset-4 hover:text-foreground';
  return (
    <div className="sticky bottom-0 z-10 -mx-6 flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-background px-6 py-2 text-sm">
      <span className="font-medium tabular-nums">{formatUtc(cursor)} UTC</span>
      <Link className={link} href={`/db/${name}/health?from=${zoomFrom}&to=${zoomTo}`}>Zoom to ±3 hours</Link>
      <Link className={link} href={`/db/${name}/sessions`}>Sessions now</Link>
      <Link className={link} href={`/db/${name}/locks`}>Locks now</Link>
      <Link className={link} href={`/db/${name}/queries`}>Queries now</Link>
      <button
        type="button" onClick={onClear}
        className="ml-auto rounded border px-2 py-1 text-xs font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Clear
      </button>
    </div>
  );
}
