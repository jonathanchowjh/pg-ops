import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS, SERIES } from '@pgops/checks';
import type { GrowthPoint } from '@pgops/checks';
import { runCheckFor, runSeriesFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { formatBytes, formatCount, formatDelta } from '@/lib/format';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Space` };
}

/**
 * #37, #38, #39. No `<Refresh>`: these are catalog scans that run on visit,
 * and the poll belongs to /cleanup itself, which renders incident checks.
 * test/guards.test.ts holds that from the source side.
 *
 * Every size here is FORMATTED at this edge. The checks return bytes where
 * pgHero returns `pretty_size(...)` strings (space.ts's §3 note), precisely
 * so the numbers can be thresholded, summed and charted — which only pays off
 * if nothing downstream has to parse "8192 MB" back into a number. The raw
 * count never reaches the page.
 */
export default async function Space({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const [size, relations, tables, growth] = await Promise.all([
    runCheckFor(name, CHECKS.databaseSize),
    runCheckFor(name, CHECKS.relationSizes, {}),
    runCheckFor(name, CHECKS.tableSizes, {}),
    // Seven days, matching pgHero's space_growth default. The range lives here
    // rather than in the series because TimeRange is a parameter of `read` —
    // the same series answers a 30-day question on the detail route.
    runSeriesFor(name, SERIES.spaceGrowth,
      { from: new Date(Date.now() - 7 * 24 * 3_600_000), to: new Date() },
      { databaseName: name }),
  ]);

  // ABSENT, not empty, when there is no store (§5.1): a blank growth column
  // reads as "this relation has not grown" when it means "we never looked".
  const byRelation = growth.ok
    ? new Map(growth.points.map((p) => [p.relation, p]))
    : null;

  return (
    <div className="grid gap-4">
      <CheckPanel title="Database size" result={size}>
        {(d) => (
          <p className="text-sm">
            {d.sizeBytes === null
              ? <span className="text-muted-foreground">Could not read a size.</span>
              : <span className="font-medium">{formatBytes(d.sizeBytes)}</span>}
          </p>
        )}
      </CheckPanel>

      <CheckPanel title="Largest relations" result={relations}>
        {(d) => (
          <SizeList
            rows={d.relations.map((r) => ({
              key: r.name, name: r.name, detail: r.type, bytes: r.sizeBytes,
            }))}
            total={d.total}
            empty="No relations in a visible schema."
            name={name}
            growth={byRelation}
          />
        )}
      </CheckPanel>

      <CheckPanel title="Largest tables, with their indexes and TOAST" result={tables}>
        {(d) => (
          <SizeList
            rows={d.relations.map((t) => ({ key: t.name, name: t.name, detail: null, bytes: t.sizeBytes }))}
            total={d.total}
            empty="No tables in a visible schema."
            name={name}
            growth={byRelation}
          />
        )}
      </CheckPanel>
    </div>
  );
}

interface SizeRow { key: string; name: string; detail: string | null; bytes: number }

/**
 * `total` is the PRE-LIMIT count the check carries (§5), never `rows.length`
 * — so the footer states what the cap hid rather than restating what it kept.
 */
function SizeList({ rows, total, empty, name, growth }: {
  rows: SizeRow[];
  total: number;
  empty: string;
  name: string;
  /** `null` means we never looked — the column is omitted, not blanked. */
  growth: Map<string, GrowthPoint> | null;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <>
      {growth === null ? null : (
        <p className="mb-1 text-xs text-muted-foreground">Growth over 7 days</p>
      )}
      <ul className="text-sm">
        {rows.map((r) => (
          <li key={r.key} className="flex justify-between gap-4 py-0.5">
            <span className="font-medium">
              {/* encodeURIComponent is defence for quoted identifiers: an
                  ordinary schema.relname encodes to itself, so no test here
                  can tell it apart from its absence. */}
              <Link
                href={`/db/${name}/cleanup/space/${encodeURIComponent(r.name)}`}
                className="underline underline-offset-2"
              >
                {r.name}
              </Link>
              {r.detail === null ? null : <span className="text-muted-foreground"> · {r.detail}</span>}
            </span>
            <span className="flex gap-4 text-muted-foreground">
              {growth === null ? null : <Growth point={growth.get(r.name)} />}
              <span>{formatBytes(r.bytes)}</span>
            </span>
          </li>
        ))}
      </ul>
      {total > rows.length ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Showing {formatCount(rows.length)} of {formatCount(total)}.
        </p>
      ) : null}
    </>
  );
}

/**
 * One capture is not a trend.
 *
 * `growthBytes` is arithmetically 0 for a relation captured once, and
 * rendering "0 B" would claim a week of flatness from a single reading. A
 * relation the window never saw at all gets the same treatment for the same
 * reason.
 */
function Growth({ point }: { point: GrowthPoint | undefined }) {
  if (point === undefined || point.points < 2) {
    return <span className="text-xs">not enough history</span>;
  }
  return <span>{formatDelta(point.growthBytes)}</span>;
}
