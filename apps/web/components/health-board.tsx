'use client';

import { useState, type PointerEvent } from 'react';
import Link from 'next/link';
import { HealthChart, momentAt } from './health-chart';
import { nearest } from '@/lib/chart';
import { formatUtc } from '@/lib/format';
import type { BoardGroup } from '@/lib/health';

const ZOOM_HALF_MS = 3 * 3_600_000;

/**
 * Every chart for one database, under the four gates, with one cursor.
 *
 * A client component for the cursor only. It is handed numbers, timestamps
 * and fixed labels, so nothing needs redacting on the way into the page
 * payload.
 *
 * The cursor is a moment in time, not a pixel: every chart shares the window,
 * so each places the moment on its own axis and reads its own bucket.
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
  // Every chart shares one bucket axis, so the moment snaps to a bucket here
  // and the bar below names the bucket the charts read, not the pixel.
  const axis = groups[0]?.charts[0]?.points;
  const scrub = (e: PointerEvent<HTMLDivElement>) => {
    const at = momentAt(e, from, to);
    if (at === null) return;
    const i = axis === undefined ? -1 : nearest(axis, at);
    setCursor(i === -1 ? at : axis![i]!.at);
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
 * Pinned to the bottom of the viewport, clear of the sticky header.
 *
 * The three links go to live pages. pgops does not store what sessions or
 * locks existed at a past moment, so each is labelled "now".
 */
function CursorBar({ name, cursor, onClear }: { name: string; cursor: number; onClear: () => void }) {
  const zoomFrom = new Date(cursor - ZOOM_HALF_MS).toISOString();
  const zoomTo = new Date(Math.min(cursor + ZOOM_HALF_MS, Date.now())).toISOString();
  const link = 'underline underline-offset-4 hover:text-foreground';
  return (
    <div className="sticky bottom-0 z-10 -mx-6 flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-background px-6 py-2 text-sm">
      <span className="font-medium tabular-nums">{formatUtc(cursor)} UTC</span>
      <Link className={link} href={`/db/${name}/health?from=${zoomFrom}&to=${zoomTo}`}>Zoom to ±3 hours</Link>
      <Link className={link} href={`/db/${name}`}>Sessions now</Link>
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
