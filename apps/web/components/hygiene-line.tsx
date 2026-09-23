import Link from 'next/link';
import type { HygieneArea } from '@pgops/checks';
import { formatDuration } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { VerdictBadge, surfaceClass } from '@/components/verdict-badge';
import { cn } from '@/lib/utils';

/**
 * One hygiene area, summarised on the triage page.
 *
 * A LINE, NOT A PANEL. The incident checks above it were run by this render,
 * five seconds ago; this was run by the capture tick, up to five minutes ago,
 * and it is a catalog scan nobody can afford on a poll. Giving it the same
 * card would say the two are the same kind of reading. It gets the weight of
 * the compact panels beside it and carries one extra thing they do not need:
 * its age.
 *
 * No accent bar even at `critical`. The bar exists to be counted in
 * peripheral vision as "an incident is happening now", and a duplicate index
 * found four minutes ago is not that — it is a thing to fix this week. The
 * badge still spells the level out, so the finding is not hidden, only
 * ranked below the thing that is on fire.
 *
 * It follows the panels' box rule (see check-panel.tsx): a healthy line is a
 * row under a hairline, and an escalated one takes the tint — but still not
 * the border, and still not the bar. That is the rank: louder than a healthy
 * row, quieter than an incident, which is exactly what a week-old finding is.
 */
export function HygieneLine({ area, name }: { area: HygieneArea; name: string }) {
  const level = area.level === 'unknown' ? null : { level: area.level };
  return (
    <div
      className={cn(
        'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-3 py-2 text-sm',
        surfaceClass(level),
      )}
    >
      <span className="font-medium">
        {area.href === null
          ? area.label
          : (
            <Link
              href={`/db/${name}/${area.href}`}
              className="underline-offset-4 hover:underline"
            >
              {area.label}
            </Link>
          )}
      </span>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-muted-foreground">
        {area.note === null ? null : <span>{area.note}</span>}
        {/* The age is what stops a cached reading claiming to be current.
            `null` means nothing was ever captured, which the note beside it
            already says in words — a "—" here would read as an age of zero. */}
        {area.ageMs === null ? null : <span>{formatDuration(area.ageMs / 1_000)} ago</span>}
        {level === null
          // Deliberately the only badge with no hue: colour tracks verdicts,
          // and this is the absence of one. Same badge the overview gives a
          // database it could not read.
          ? <Badge variant="outline">UNKNOWN</Badge>
          : <VerdictBadge verdict={level} />}
      </span>
    </div>
  );
}
