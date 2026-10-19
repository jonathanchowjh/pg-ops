import Link from 'next/link';
import { HealthBoard } from '@/components/health-board';
import { formatUtc } from '@/lib/format';
import {
  HEALTH_POINTS, WINDOWS, boardGroups, emptyReason, healthFor, parseWindow, type HealthWindow,
} from '@/lib/health';
import { cn } from '@/lib/utils';

/**
 * One database's stored health, under the four gates.
 *
 * Does not poll. It reads the store only and runs no check, so it works for
 * a database that is down.
 */
export default async function Health({ params, searchParams }: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { name } = await params;
  const now = Date.now();
  const win = parseWindow(await searchParams, now);
  const read = await healthFor([name], new Date(win.from), new Date(win.to), HEALTH_POINTS);
  const history = read.ok ? read.histories[0] : undefined;

  return (
    <div className="space-y-6">
      <WindowLinks name={name} win={win} />
      {!read.ok ? (
        <p role={read.kind === 'error' ? 'alert' : undefined} className="text-sm">{read.message}</p>
      ) : history === undefined || history.rows < 2 ? (
        <p className="text-sm text-muted-foreground">
          {emptyReason(history?.lastAt ?? null, win.to, now)}
        </p>
      ) : (
        <HealthBoard name={name} from={win.from} to={win.to} groups={boardGroups(history.points, win)} />
      )}
    </div>
  );
}

function WindowLinks({ name, win }: { name: string; win: HealthWindow }) {
  return (
    <nav aria-label="Window" className="flex flex-wrap items-center gap-1 text-sm">
      {WINDOWS.map((w) => (
        <Link
          key={w.key}
          href={`/db/${name}/health?window=${w.key}`}
          aria-current={w.key === win.key ? 'true' : undefined}
          className={cn(
            'rounded border px-2 py-1',
            w.key === win.key ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {w.label}
        </Link>
      ))}
      {win.key === null ? (
        <span className="ml-2 tabular-nums text-muted-foreground">
          {formatUtc(win.from)} to {formatUtc(win.to)} UTC
        </span>
      ) : null}
    </nav>
  );
}
