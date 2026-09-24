import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS, SERIES } from '@pgops/checks';
import type { GrowthPoint, StoredTotal } from '@pgops/checks';
import { runCheckFor, runSeriesFor } from '@/lib/check';
import { SPACE_DAYS, databaseSpaceFor } from '@/lib/load';
import { LineChart } from '@/components/line-chart';
import { cacheChecks } from '@/lib/hygiene';
import { CheckPanel } from '@/components/check-panel';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FoldNote } from '@/components/fold-note';
import { foldFrom, foldOurs, type Fold } from '@/lib/fold';
import { formatBytes, formatCount, formatDelta, formatDuration, plural } from '@/lib/format';

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
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ pgops?: string }>;
}) {
  const { name } = await params;
  // pgops's own tables and indexes, folded out of the lists below. Its
  // database SIZE is not filtered and must not be — see lib/fold.ts.
  const fold = foldFrom(`/db/${name}/cleanup/space`, await searchParams);
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

  // Read after the checks rather than beside them: this one is history, it
  // cannot fail the page, and its window is thirty days where the growth
  // column's is seven.
  const total = await databaseSpaceFor(name);

  // The same readings, written where the triage page can see them. The page
  // is unchanged — it ran these checks just now, on visit — and this is what
  // stops the triage line reporting a finding this page has already
  // disproved. Never throws, and does nothing at all without a store.
  await cacheChecks(name, {
    databaseSize: size, relationSizes: relations, tableSizes: tables,
  });

  // ABSENT, not empty, when there is no store (§5.1): a blank growth column
  // reads as "this relation has not grown" when it means "we never looked".
  const byRelation = growth.ok
    ? new Map(growth.points.map((p) => [p.relation, p]))
    : null;
  // Said ONCE, above the list, rather than thirty times inside it — see
  // `growthNote`.
  const note = growth.ok ? growthNote(growth.points) : null;

  return (
    <div className="grid gap-4">
      <Total points={total} />
      <CheckPanel title="Database size" result={size}>
        {(d) => (
          <p className="text-sm">
            {d.sizeBytes === null
              ? <span className="text-muted-foreground">Could not read a size.</span>
              : <span className="font-medium">{formatBytes(d.sizeBytes)}</span>}
          </p>
        )}
      </CheckPanel>

      <CheckPanel title="Largest relations" result={relations} count={(d) => d.total}>
        {(d) => (
          <SizeList
            rows={d.relations.map((r) => ({
              key: r.name, name: r.name, detail: r.type, bytes: r.sizeBytes,
            }))}
            total={d.total}
            empty="No relations in a visible schema."
            name={name}
            growth={byRelation}
            note={note}
            fold={fold}
          />
        )}
      </CheckPanel>

      <CheckPanel title="Largest tables, with their indexes and TOAST" result={tables} count={(d) => d.total}>
        {(d) => (
          <SizeList
            rows={d.relations.map((t) => ({ key: t.name, name: t.name, detail: null, bytes: t.sizeBytes }))}
            total={d.total}
            empty="No tables in a visible schema."
            name={name}
            growth={byRelation}
            note={note}
            fold={fold}
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
function SizeList({ rows, total, empty, name, growth, note, fold }: {
  rows: SizeRow[];
  total: number;
  empty: string;
  name: string;
  /** `null` means we never looked — the column is omitted, not blanked. */
  growth: Map<string, GrowthPoint> | null;
  /** What the window actually holds. Null alongside a null `growth`. */
  note: string | null;
  fold: Fold;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const { shown, mine } = foldOurs(rows, (r) => r.name, fold.show);
  return (
    <>
      {note === null ? null : (
        <p className="mb-1 text-xs text-muted-foreground">{note}</p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>relation</TableHead>
            <TableHead>kind</TableHead>
            {growth === null ? null : <TableHead className="text-right">7-day growth</TableHead>}
            <TableHead className="text-right">size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((r) => (
            <TableRow key={r.key}>
              <TableCell className="font-mono font-medium">
                {/* encodeURIComponent is defence for quoted identifiers: an
                    ordinary schema.relname encodes to itself, so no test here
                    can tell it apart from its absence. */}
                <Link
                  href={`/db/${name}/cleanup/space/${encodeURIComponent(r.name)}`}
                  className="underline underline-offset-2"
                >
                  {r.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{r.detail ?? ''}</TableCell>
              {growth === null ? null : (
                <TableCell className="text-right tabular-nums">
                  <Growth point={growth.get(r.name)} />
                </TableCell>
              )}
              <TableCell className="text-right tabular-nums">{formatBytes(r.bytes)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {total > rows.length ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Showing {formatCount(rows.length)} of {formatCount(total)}.
        </p>
      ) : null}
      <FoldNote mine={mine} fold={fold} />
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
 *
 * An em dash, NOT the sentence it used to be. "not enough history" is one
 * fact about the store, and this column printed it thirty times down a list
 * whose actual subject is size — so the page's most repeated words explained
 * an absence rather than describing the database. It is said once, above the
 * list, by `growthNote`, and with the number that explains it. The dash is
 * the same mark the Queries table uses for a shape it has no interval for,
 * and it means what it means everywhere: nothing was measured here.
 */
function Growth({ point }: { point: GrowthPoint | undefined }) {
  if (point === undefined || point.points < 2) {
    return <span aria-label="no growth reading">—</span>;
  }
  return <span>{formatDelta(point.growthBytes)}</span>;
}

/**
 * The growth column's heading, and — when the window is too thin to measure
 * anything — its explanation.
 *
 * `points` is per RELATION, so the largest is what the window holds for the
 * database: a relation created yesterday has fewer captures than the store
 * does, and reporting its count as the store's would understate the history
 * every other row was measured against.
 */
/**
 * Every captured table's size, added up, over thirty days.
 *
 * THE PAGE'S LARGEST QUESTION, and the only one it could not answer. Every
 * other reading here is a single instant — the live total at the top, the
 * largest relations beneath it — or a single relation's history behind a
 * link. "Is this growing, and how fast" is what an operator opens a space
 * page to find out, and answering it meant clicking into relations one at a
 * time and adding up the slopes by eye.
 *
 * NOT "DATABASE SIZE", and the distinction is not pedantry — it is a number
 * that would contradict the one eight lines below it. `space_stats` holds
 * `pg_total_relation_size` for `relkind IN ('r','m','p')` outside
 * `pg_catalog`, `information_schema` and `pgops` (see capture.ts's
 * SPACE_SQL): user TABLES, each already carrying its own indexes and TOAST,
 * and nothing else. On the demo that is 116 MB against a live database size
 * of 124 MB, the difference being the catalogs and pgops's own storage. A
 * chart titled "Database size" sitting above a "Database size" panel that
 * disagrees with it by 8 MB is exactly the kind of quiet wrongness this
 * console exists not to print.
 *
 * Silent below two captures, like every other chart, and silent with no
 * store at all: `databaseSpaceFor` returns `[]` for both, and the growth
 * column below already says which of the two it is.
 */
function Total({ points }: { points: readonly StoredTotal[] }) {
  if (points.length < 2) return null;
  return (
    <div>
      <h2 className="mb-2 border-b pb-2 font-medium">Total table size over {SPACE_DAYS} days</h2>
      <LineChart
        points={points.map((p) => ({ at: p.capturedAt, value: p.sizeBytes }))}
        label={`total size of every captured table, with indexes and TOAST, over ${SPACE_DAYS} days`}
        format={formatBytes}
      />
      <p className="mt-1 text-sm text-muted-foreground">{populationNote(points)}</p>
    </div>
  );
}

/**
 * What the line was summed across, and why that matters.
 *
 * THE SUM ALONE CAN LIE. It totals the tables pgops MEASURED, so a capture
 * that could not read every table sums fewer of them and draws as the
 * database shrinking — indistinguishable, from the line alone, from a table
 * being dropped. `readDatabaseSpace` carries the count back for exactly this
 * sentence: a steady count means every dip is real, and a count that moved
 * is the one case where a dip might not be.
 *
 * It also names the population, because "5 tables" on a page listing 37
 * relations otherwise reads as most of them having been left out. They are
 * not: the other 32 are indexes, and `pg_total_relation_size` has already
 * counted each one inside its table.
 */
function populationNote(points: readonly StoredTotal[]): string {
  const counts = points.map((p) => p.relations);
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  const tail = ' Indexes and TOAST are counted inside their table; system catalogs'
    + " and pgops's own schema are not counted at all, so this sits below the"
    + ' database size above.';
  if (lo === hi) {
    return `Summed across ${plural(hi, 'table')}, the same at every capture.${tail}`;
  }
  return `Summed across ${formatCount(lo)}–${formatCount(hi)} tables — the count moved within `
    + 'the window, so a fall here may be a table dropped or one pgops could not measure.'
    + tail;
}

function growthNote(points: readonly GrowthPoint[]): string {
  const captures = points.reduce((most, p) => Math.max(most, p.points), 0);
  if (captures >= 2) return `Growth over 7 days · ${formatCount(captures)} captures`;
  const first = points.reduce<Date | null>(
    (earliest, p) => (earliest === null || p.firstAt < earliest ? p.firstAt : earliest), null);
  if (captures === 0 || first === null) {
    return 'Growth over 7 days — nothing captured in this window yet.';
  }
  // One reading is a size, not a trend. The age is what says how long the
  // wait is: the second capture arrives five minutes after the first.
  return `Growth over 7 days — one capture so far, taken ${formatDuration(
    (Date.now() - first.getTime()) / 1_000)} ago. Two are needed to measure a change.`;
}
