import type { Metadata } from 'next';
import Link from 'next/link';
import { SERIES } from '@pgops/checks';
import { runSeriesFor } from '@/lib/check';
import { SubNav } from '@/components/sub-nav';
import { CLEANUP_SECTIONS } from '@/components/cleanup-sections';
import { Spark } from '@/components/spark';
import { formatBytes, formatCount, formatDelta } from '@/lib/format';

/** Thirty days, and §5.1's bound on what that window is allowed to return. */
const DAYS = 30;
const MAX_POINTS = 500;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string; relation: string }>;
}): Promise<Metadata> {
  const { name, relation } = await params;
  return { title: `${name} · ${relation}` };
}

/**
 * #41. One relation's captured size over thirty days.
 *
 * No `<Refresh>`: this is history, which does not move between polls, and
 * test/guards.test.ts holds that from the source side.
 *
 * `relation` arrives ALREADY DECODED from Next — the link that reaches here
 * encoded it, and decoding again would corrupt a name containing a literal
 * percent.
 *
 * Thirty days at the five-minute capture cadence is 8,640 points for one
 * relation, which is a payload nobody needs and a chart nobody can read, so
 * `maxPoints` is passed. It keeps the most RECENT N: truncating from the other
 * end would show the history and hide the present.
 */
export default async function RelationSpace({
  params,
}: {
  params: Promise<{ name: string; relation: string }>;
}) {
  const { name, relation } = await params;
  const history = await runSeriesFor(name, SERIES.relationSpace,
    { from: new Date(Date.now() - DAYS * 24 * 3_600_000), to: new Date() },
    { databaseName: name, relation, maxPoints: MAX_POINTS });

  return (
    <div className="grid gap-4">
      <SubNav name={name} base="cleanup" items={CLEANUP_SECTIONS} />

      <div>
        <Link href={`/db/${name}/cleanup/space`} className="text-sm underline underline-offset-2">
          ← All relations
        </Link>
        <h1 className="mt-2 font-medium">{relation}</h1>
        <p className="text-sm text-muted-foreground">Size over the last {DAYS} days.</p>
      </div>

      <History relation={relation} history={history} />
    </div>
  );
}

/**
 * The three cases kept apart on purpose.
 *
 * `ok: false` is "we could not look" and carries a remedy. `ok: true` with no
 * points is "we looked and there is nothing yet" — an ordinary state for a
 * relation created since the last capture, and telling an operator their store
 * failed would send them to fix something that is working.
 */
function History({
  relation,
  history,
}: {
  relation: string;
  history: Awaited<ReturnType<typeof runSeriesFor<{ capturedAt: Date; sizeBytes: number }>>>;
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
        No history captured yet for {relation}.
      </p>
    );
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;

  return (
    <div className="rounded border p-3">
      <Spark
        points={points.map((p) => p.sizeBytes)}
        label={`${relation} size over ${DAYS} days`}
      />
      {/* The chart is the shape; these are the fact. A sparkline has no axis,
          so without the endpoints stated it says "it went up" and not by how
          much. */}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Fact label="First" value={formatBytes(first.sizeBytes)} />
        <Fact label="Latest" value={formatBytes(last.sizeBytes)} />
        <Fact
          label="Change"
          value={points.length < 2
            ? 'not enough history'
            : formatDelta(last.sizeBytes - first.sizeBytes)}
        />
        <Fact label="Captures" value={formatCount(points.length)} />
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
