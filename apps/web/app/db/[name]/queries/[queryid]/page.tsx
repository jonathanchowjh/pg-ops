import type { Metadata } from 'next';
import Link from 'next/link';
import { SERIES } from '@pgops/checks';
import type { Interval } from '@pgops/checks';
import { runSeriesFor } from '@/lib/check';
import { queryTextFor } from '@/lib/load';
import { ExplainLink } from '@/components/explain-link';
import { safeStatement, Sql } from '@/components/sql';
import { LineChart, type ChartPoint } from '@/components/line-chart';
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
  // Both at once: neither read depends on the other, and this page is the
  // one place in the console where a statement is the subject rather than a
  // row, so waiting for them in turn would be two round trips for one view.
  const [history, sql] = await Promise.all([
    runSeriesFor(name, SERIES.queryShapeHistory,
      { from: new Date(Date.now() - HOURS * 3_600_000), to: new Date() },
      { databaseName: name, queryid, maxSnapshots: MAX_SNAPSHOTS }),
    queryTextFor(name, queryid),
  ]);

  return (
    <div className="grid gap-4">
      <div>
        <Link href={`/db/${name}/queries`} className="text-sm underline underline-offset-2">
          ← All queries
        </Link>
        {/* THE STATEMENT IS THE HEADING. This page identified its subject
            as a 19-digit integer and showed the SQL nowhere — so an operator
            who followed a link from the Queries table could not confirm they
            had clicked the row they meant, and on a shape with no comparable
            history the page said nothing about the query at all. The ID stays
            below it: it is what the URL is keyed on and what a colleague gets
            pasted into chat. */}
        <h1 className="mt-2 font-medium">
          {sql === null
            ? <>Query <code className="font-mono text-sm">{queryid}</code></>
            : <Sql>{sql}</Sql>}
        </h1>
        <p className="text-sm text-muted-foreground">
          {sql === null ? null : <><code className="font-mono">{queryid}</code> · </>}
          Movement over the last {HOURS} hours, between captures.
        </p>
        {/* A9: one click to the plan, from the one page that holds the FULL
            statement rather than the two-line clamp the ranking shows.
            Absent when the text could not be recovered — the heading already
            degrades to the bare id, and a control that handed an empty
            statement to the Explain form could not work. */}
        {sql === null ? null : (
          <p className="mt-1"><ExplainLink name={name} statement={safeStatement(sql)} /></p>
        )}
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

  // FOUR SERIES, READ TOGETHER. Each answers a different question about the
  // same shape and none of them answers it alone: calls is how often it ran,
  // total time is what that cost, rows is how much work each run did, and
  // blocks read is how much of that work missed memory. Time up with calls
  // flat and rows flat is a plan that got worse; time up with rows up is a
  // table that grew under a query that was always going to scan it; time up
  // with blocks read up is a shape that outgrew the cache. All four were
  // captured, stored and differenced into `Interval` from the start, and
  // three of them were discarded on every render.
  return (
    <div className="grid gap-4">
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
        {/* An interval is plotted at the instant it ENDED. Its work happened
            across the five minutes before that, and the end is the only one
            of the two moments the reading is true of. */}
        <Chart
          title="Calls per interval"
          points={points.map((p) => ({ at: p.to, value: p.calls }))}
          label={`calls per interval over ${HOURS} hours`}
          format={formatCount}
        />
        <Chart
          title="Total time per interval"
          points={points.map((p) => ({ at: p.to, value: p.totalExecTime }))}
          label={`total execution time per interval over ${HOURS} hours`}
          format={formatMillis}
        />
        <Chart
          title="Rows per interval"
          points={points.map((p) => ({ at: p.to, value: p.rows }))}
          label={`rows returned per interval over ${HOURS} hours`}
          format={formatCount}
        />
        {/* BLOCKS, NOT A HIT-RATE PERCENTAGE, and the choice is the whole
            reason this chart took a second look.
            
            A ratio has two failures here that a count does not. Its
            denominator can be zero — an interval where the shape ran but
            touched no shared buffers has no hit rate, and this console does
            not answer 0% or 100% to a question it could not measure
            (tables.ts makes the same refusal, where pgHero collapses it with
            `CASE WHEN ... THEN 0`). And a hit rate lives in the last
            fraction of a percent: 99.9% to 99.1% is eight times the disk
            reads, and the chart's own 2% floor — correct everywhere else —
            would flatten exactly that drop into a straight line.
            
            The count has neither problem. Zero is a real reading ("it all
            came from memory"), the axis scales to whatever the shape
            actually does, and the calls chart beside it is what normalises
            the number when traffic changes. Blocks rather than bytes because
            block size is a compile-time setting pgops cannot see from
            here. */}
        <Chart
          title="Blocks read from disk per interval"
          points={points.map((p) => ({ at: p.to, value: p.sharedBlksRead }))}
          label={`shared blocks read from disk per interval over ${HOURS} hours`}
          format={formatCount}
        />
      </div>
      {/* The charts carry their own axes now; this is the exact latest
          reading, which an axis rounded to two bounds cannot give. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Fact label="Latest calls" value={formatCount(latest.calls)} />
        <Fact label="Latest total time" value={formatMillis(latest.totalExecTime)} />
        <Fact label="Latest rows" value={formatCount(latest.rows)} />
        <Fact label="Intervals" value={formatCount(points.length)} />
      </dl>
    </div>
  );
}

/**
 * A titled chart, or nothing at all.
 *
 * The guard is here rather than at each call site because `LineChart` itself
 * renders nothing below two points — so a heading written beside it would
 * survive its chart and stand over blank page. One capture is exactly that
 * case, and it is an ordinary state on a console whose history starts empty.
 */
function Chart({ title, points, label, format }: {
  title: string;
  points: readonly ChartPoint[];
  label: string;
  format: (v: number) => string;
}) {
  if (points.length < 2) return null;
  return (
    <div>
      <h2 className="mb-2 border-b pb-2 font-medium">{title}</h2>
      <LineChart points={points} label={label} format={format} />
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
