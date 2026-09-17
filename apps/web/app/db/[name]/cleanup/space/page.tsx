import type { Metadata } from 'next';
import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { SubNav } from '@/components/sub-nav';
import { CLEANUP_SECTIONS } from '@/components/cleanup-sections';
import { formatBytes, formatCount } from '@/lib/format';

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
  const [size, relations, tables] = await Promise.all([
    runCheckFor(name, CHECKS.databaseSize),
    runCheckFor(name, CHECKS.relationSizes, {}),
    runCheckFor(name, CHECKS.tableSizes, {}),
  ]);

  return (
    <div className="grid gap-4">
      <SubNav name={name} base="cleanup" items={CLEANUP_SECTIONS} />

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
          />
        )}
      </CheckPanel>

      <CheckPanel title="Largest tables, with their indexes and TOAST" result={tables}>
        {(d) => (
          <SizeList
            rows={d.relations.map((t) => ({ key: t.name, name: t.name, detail: null, bytes: t.sizeBytes }))}
            total={d.total}
            empty="No tables in a visible schema."
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
function SizeList({ rows, total, empty }: { rows: SizeRow[]; total: number; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <>
      <ul className="text-sm">
        {rows.map((r) => (
          <li key={r.key} className="flex justify-between gap-4 py-0.5">
            <span className="font-medium">
              {r.name}
              {r.detail === null ? null : <span className="text-muted-foreground"> · {r.detail}</span>}
            </span>
            <span className="text-muted-foreground">{formatBytes(r.bytes)}</span>
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
