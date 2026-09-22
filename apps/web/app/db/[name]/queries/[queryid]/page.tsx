import type { Metadata } from 'next';
import Link from 'next/link';
import { SERIES } from '@pgops/checks';
import type { Interval } from '@pgops/checks';
import { runSeriesFor } from '@/lib/check';
import { Spark } from '@/components/spark';
import { formatCount, formatMillis } from '@/lib/format';

/** Twenty-four hours, and the snapshot count that covers it at 5-minute capture. */
const HOURS = 24;
const MAX_SNAPSHOTS = 288;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string; queryid: string }>;
}): Promise<Metadata> {
  const { name, queryid } = await params;
  return { title: `${name} · query ${queryid}` };
}

/**
 * #16. One query shape's movement over twenty-four hours.
 *
 * No `<Refresh>`, unlike /queries above it: that is an incident page whose
 * numbers move every five seconds, and this is history, which does not.
 * test/guards.test.ts holds the boundary from the source side.
 */
export default async function QueryDetail({
  params,
}: {
  params: Promise<{ name: string; queryid: string }>;
}) {
  const { name, queryid } = await params;
  const history = await runSeriesFor(name, SERIES.queryShapeHistory,
    { from: new Date(Date.now() - HOURS * 3_600_000), to: new Date() },
    { databaseName: name, queryid, maxSnapshots: MAX_SNAPSHOTS });

  return (
    <div className="grid gap-4">
      <div>
        <Link href={`/db/${name}/queries`} className="text-sm underline underline-offset-2">
          ← All queries
        </Link>
        <h1 className="mt-2 font-medium">
          Query <code className="font-mono text-sm">{queryid}</code>
        </h1>
        <p className="text-sm text-muted-foreground">
          Movement over the last {HOURS} hours, between captures.
        </p>
      </div>

      <History history={history} />
    </div>
  );
}

/**
 * Three outcomes, and the middle one is the whole reason this is not a
 * two-branch render.
 *
 * `ok: false` is "we could not look". `ok: true` with no points is NOT "no
 * history" here the way it is on the space page: §3.5 drops any interval
 * spanning a `stats_reset` advance or an LRU eviction, so a shape with plenty
 * of captures and no comparable pair lands here too. Saying "no history" would
 * be a lie about a store that is full of this shape's data.
 */
function History({
  history,
}: {
  history: Awaited<ReturnType<typeof runSeriesFor<Interval>>>;
}) {
  if (!history.ok) {
    return (
      <div className="rounded border p-3 text-sm">
        <p>{history.message}</p>
        {history.remedy === undefined
          ? null
          : <p className="mt-1 text-muted-foreground">{history.remedy}</p>}
      </div>
    );
  }

  const points = history.points;
  if (points.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No comparable history in this window. Either this shape was not captured,
        or every interval spanned a point where the statistics were reset — which
        is dropped rather than charted as a spike.
      </p>
    );
  }

  const latest = points[points.length - 1]!;

  return (
    <div className="grid gap-4">
      <div className="rounded border p-3">
        <h2 className="mb-2 text-sm font-medium">Calls per interval</h2>
        <Spark points={points.map((p) => p.calls)} label={`calls over ${HOURS} hours`} />
      </div>
      <div className="rounded border p-3">
        <h2 className="mb-2 text-sm font-medium">Total time per interval</h2>
        <Spark
          points={points.map((p) => p.totalExecTime)}
          label={`total execution time over ${HOURS} hours`}
        />
      </div>
      {/* The charts are the shape; this is the fact. A sparkline has no axis,
          so without the latest interval stated it says "it went up" and not
          from what to what. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Fact label="Latest calls" value={formatCount(latest.calls)} />
        <Fact label="Latest total time" value={formatMillis(latest.totalExecTime)} />
        <Fact label="Latest rows" value={formatCount(latest.rows)} />
        <Fact label="Intervals" value={formatCount(points.length)} />
      </dl>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
