import type { Metadata } from 'next';
import Link from 'next/link';
import { SUGGESTION_DEFAULTS, TOOLS, type QueryAdvice, type SuggestedIndex } from '@pgops/checks';
import { runToolFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { IndexAdviceList } from '@/components/index-advice';
import { Sql } from '@/components/sql';
import { formatAgo, formatCount, formatMillis } from '@/lib/format';

export async function generateMetadata(
  { params }: { params: Promise<{ name: string }> },
): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Suggested indexes` };
}

/**
 * #58 `suggested_indexes` and #63 `suggested_indexes_by_query`.
 *
 * On its own route, reached by a click from the Indexes page, for the reason
 * `/indexes/bloat` is: it plans up to a hundred query shapes on every visit,
 * and the Indexes page reads cached hygiene results. pgHero puts suggestions
 * on its dashboard; pgops keeps the dashboard cheap and names the cost at the
 * link instead.
 *
 * No `<Refresh>`. Nothing about a suggestion changes in five seconds.
 */
export default async function Suggested({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const result = await runToolFor(name, TOOLS.suggestedIndexes, {});

  return (
    <>
      <CheckPanel title="Suggested indexes" result={result}>
        {(d) => {
          const unplanned = d.byQuery.filter((q) => q.error !== undefined).length;
          const planned = d.byQuery.length - unplanned;
          return (
            <div className="space-y-4">
              <p className="max-w-prose text-sm text-muted-foreground">
                From the busiest query shapes over {SUGGESTION_DEFAULTS.minMeanMs}&nbsp;ms and{' '}
                {SUGGESTION_DEFAULTS.minCalls} calls in pg_stat_statements, since statistics were last reset
                {d.statsResetAt === null ? '' : ` (${formatAgo(d.statsResetAt)})`}. Each shape is planned, not run;
                the columns are chosen by pgHero&rsquo;s heuristic from column statistics. Confirm before
                building anything — pgops never runs these statements.
              </p>

              {d.indexes.length === 0 ? (
                // Names the floor, not "no missing indexes": what was established
                // is that none of THESE shapes wants one — and only a shape that
                // was planned can have been cleared.
                <p className="text-sm text-muted-foreground">
                  No index suggested for the {formatCount(planned)}{' '}
                  {planned === 1 ? 'shape' : 'shapes'} planned over {SUGGESTION_DEFAULTS.minMeanMs} ms and{' '}
                  {SUGGESTION_DEFAULTS.minCalls} calls.
                </p>
              ) : (
                <ul className="space-y-4">
                  {d.indexes.map((g) => <Suggestion key={g.statement} name={name} index={g} />)}
                </ul>
              )}

              {unplanned > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {formatCount(unplanned)} {unplanned === 1 ? 'shape' : 'shapes'} could not be planned; each is
                  listed below with the reason.
                </p>
              ) : null}

              <details className="text-sm">
                <summary className="cursor-pointer">Shapes examined ({formatCount(d.byQuery.length)})</summary>
                {/* What `limit` and the thresholds left out, so "examined" is not
                    read as "every query this database runs". */}
                <p className="mt-2 text-muted-foreground">
                  Read the {formatCount(d.examined)} busiest of {formatCount(d.totalShapes)}{' '}
                  {d.totalShapes === 1 ? 'shape' : 'shapes'} by total time;{' '}
                  {formatCount(d.byQuery.length)} cleared the thresholds.
                </p>
                <ul className="mt-2 space-y-3">
                  {d.byQuery.map((q, i) => <Shape key={q.queryid ?? i} name={name} shape={q} />)}
                </ul>
              </details>
            </div>
          );
        }}
      </CheckPanel>
    </>
  );
}

function Suggestion({ name, index }: { name: string; index: SuggestedIndex }) {
  return (
    <li className="space-y-2">
      <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{index.statement}</pre>
      <p className="text-sm text-muted-foreground">
        Wanted by {formatCount(index.queries.length)} {index.queries.length === 1 ? 'shape' : 'shapes'}:
      </p>
      <ul className="space-y-1">
        {index.queries.map((q, i) => <li key={q.queryid ?? i}><ShapeSql name={name} shape={q} /></li>)}
      </ul>
    </li>
  );
}

function Shape({ name, shape }: { name: string; shape: QueryAdvice }) {
  return (
    <li className="space-y-1">
      <ShapeSql name={name} shape={shape} />
      <p className="text-xs text-muted-foreground tabular-nums">
        {formatCount(shape.calls)} calls · {formatMillis(shape.meanMs)} mean
      </p>
      {shape.error === undefined
        ? <IndexAdviceList advice={shape.advice} />
        : <p className="text-muted-foreground">Could not plan: {shape.error}</p>}
    </li>
  );
}

/** A shape's text, linked to its history when pg_stat_statements gave it an id. */
function ShapeSql({ name, shape }: { name: string; shape: { queryid: string | null; query: string } }) {
  return shape.queryid === null
    ? <Sql>{shape.query}</Sql>
    : <Link href={`/db/${name}/queries/${shape.queryid}`} className="block hover:underline"><Sql>{shape.query}</Sql></Link>;
}
