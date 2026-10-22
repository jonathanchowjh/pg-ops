'use client';

import Link from 'next/link';
import { Track, useClock } from '@/components/clock';
import { Frame } from '@/components/frame';
import { END, GO, ROW, StripSvg, TAG, Unseen, reading } from '@/components/tree-rows';
import { clockTime, columnAt, downSince, fractionAt } from '@/lib/clock';
import { readingAt } from '@/lib/rows';
import type { FleetRow } from '@/lib/samples';
import { findingsAt, roundUp, unseenAt, type HealthKind } from '@/lib/tree';
import { cn } from '@/lib/utils';

/** What a finding is called on a fleet row, where there is no room for a sentence. */
const TAG_NAMES: Record<'chain' | 'idle' | HealthKind, string> = {
  chain: 'lock chain', idle: 'idle in transaction', connections: 'connections', replication: 'replication',
  xid: 'transaction ID age', deadlock: 'deadlock',
};

/**
 * The fleet: one row per database on the clock. Each row is the database's
 * band as a strip on one shared scale, its findings at the cursor as tags,
 * two at most, and "unreachable since" when the sampler could not reach it.
 * The label is the one link, to the database's tree. No action: the fleet
 * contacts no database.
 */
export function FleetView({ rows }: { rows: readonly FleetRow[] }) {
  const clock = useClock();
  // The page shows no fleet with no database in it.
  const first = rows[0]!.tree;
  const scale = roundUp(Math.max(0, ...rows.map((r) => Math.max(0, ...r.tree.band.map((c) => c.reduce((a, b) => a + b, 0))))) * 1.02);
  return (
    <Frame
      role="table"
      label="Every database"
      keyEnd="sessions not idle"
      rows={rows.map(({ name, tree, transitions }) => {
        const col = columnAt(tree, clock.at);
        const unseen = unseenAt(tree.seen, col);
        const down = downSince(transitions, clock.at);
        const tags = [
          ...(down === null ? [] : [`unreachable since ${clockTime(down, clock.offset(down), false)}`]),
          ...findingsAt(tree, clock.at).map((r) => TAG_NAMES[r.finding.kind]),
        ].filter((t, i, all) => all.indexOf(t) === i).slice(0, 2);
        const now = readingAt(tree.band, col);
        return (
          <div key={name} role="row" className={ROW}>
            <div role="rowheader" className="flex min-w-0 items-center gap-[7px] self-stretch px-2.5 whitespace-nowrap">
              <Link href={`/db/${name}`} className={GO}>
                <span className="truncate font-mono text-[13px] font-semibold text-foreground">{name}</span>
                {tags.map((t) => <span key={t} suppressHydrationWarning className={cn(TAG, t.startsWith('unreachable') && 'text-critical-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--critical-ink)_35%,transparent)]')}>{t}</span>)}
                <span className={END}>{unseen || down !== null ? '—' : now.total.toFixed(1)}</span>
                <span aria-hidden className="ml-1.5 text-[15px] text-muted-foreground opacity-0 group-hover:opacity-100 max-md:hidden">›</span>
              </Link>
            </div>
            <Track
              className="relative h-[34px] border-l py-[3px]"
              tip={(t) => {
                const c = Math.max(0, Math.min(tree.band.length - 1, Math.floor(fractionAt(tree, t) * tree.band.length)));
                return reading(name, tree.band, c, unseenAt(tree.seen, c));
              }}
            >
              <StripSvg strip={tree.band} scale={scale} />
              <Unseen seen={tree.seen} />
            </Track>
          </div>
        );
      })}
      rowCount={rows.length}
      foot={`each row 0 – ${scale} · sampled every 15 s`}
      grid={first}
    />
  );
}
