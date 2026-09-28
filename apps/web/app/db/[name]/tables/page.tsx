import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS, TABLE_SORTS, type TableSort } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { EntityLink } from '@/components/entity-link';
import { SortLink } from '@/components/sort-link';
import { withParam } from '@/lib/url';
import { foldFrom, foldOurs } from '@/lib/fold';
import { FoldNote } from '@/components/fold-note';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { formatAgo, formatBytes, formatCount } from '@/lib/format';

/**
 * The presets, and why they are links rather than a default sort plus a hint.
 *
 * Space, Maintenance and the unused half of the Tables page were each one
 * ORDER BY of this list (design §5.1). Collapsing them into a sortable table
 * without these would turn a one-click answer into "find the column, click
 * it" — slower, during an incident, than what it replaced. Each is a URL, so
 * it is shareable and back-buttonable, and none of them is a second code
 * path: they all land on this page with different parameters.
 */
const PRESETS = [
  { label: 'Biggest', key: 'sort', value: 'size' },
  { label: 'Needs vacuum', key: 'sort', value: 'vacuum' },
  { label: 'Worst cache hit', key: 'sort', value: 'cache' },
  { label: 'Unused', key: 'only', value: 'unused' },
] as const;

export async function generateMetadata(
  { params }: { params: Promise<{ name: string }> },
): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Tables` };
}

export default async function Tables({ params, searchParams }: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ sort?: string; q?: string; only?: string; pgops?: string }>;
}) {
  const { name } = await params;
  const controls = await searchParams;
  const pathname = `/db/${name}/tables`;
  const fold = foldFrom(pathname, controls);

  // VALIDATED HERE, and this is the line that makes the check's closed
  // `Record<TableSort, string>` safe to interpolate. `sqlFor` throws on a
  // miss rather than interpolating `undefined`; this is what ensures it
  // never has to.
  const sort: TableSort = TABLE_SORTS.includes(controls.sort as TableSort)
    ? (controls.sort as TableSort)
    : 'size';
  // Next's own `searchParams` type is `string | string[] | undefined`; this
  // page narrows it to `string` because that is the only shape a single `q`
  // ever takes — but a REPEATED `?q=a&q=b` on the wire is not a single `q`,
  // and Next can and does deliver that case as an array regardless of what
  // this type claims. Coerced to its first value here, before it can reach
  // `search` and, from there, the ILIKE bind parameter: node-postgres would
  // otherwise send an array as a Postgres array literal, not a text filter.
  const rawQ = controls.q as string | string[] | undefined;
  const q = Array.isArray(rawQ) ? rawQ[0] : rawQ;
  const search = q === undefined || q === '' ? undefined : q;
  const unusedOnly = controls.only === 'unused';

  const result = await runCheckFor(name, CHECKS.tableList, { sort, search, unusedOnly });

  // NOT `cacheChecks`. Every other hygiene page caches its result under the
  // check's id so the triage page can read the same reading — but those pages
  // run their checks unfiltered, with `{}`. This one runs a sorted, filtered,
  // searched query, and writing that under `tableList` would hand the triage
  // page one operator's search results as the database's state.

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="font-medium">Tables</h1>
        <p className="text-sm text-muted-foreground">
          Every table in this database, with what pgops knows about each.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {PRESETS.map((p) => {
          // A preset is active when its own parameter is the chosen one, so
          // `Unused` and `Biggest` can be lit at once — they are a filter and
          // an order, not two options in a list.
          const active = p.key === 'sort' ? sort === p.value : unusedOnly;
          return (
            <Link
              key={p.label}
              href={withParam(pathname, controls, p.key, active ? undefined : p.value)}
              aria-pressed={active}
              className={active
                ? 'rounded-md bg-muted px-2.5 py-1 font-medium text-foreground'
                : 'rounded-md px-2.5 py-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground'}
            >
              {p.label}
            </Link>
          );
        })}
        <form action={pathname} className="ml-auto flex items-center gap-2">
          {/* The other controls travel as hidden fields, so searching from a
              page reached by a preset keeps the preset. Without them a search
              silently resets the order the operator chose. */}
          {sort === 'size' ? null : <input type="hidden" name="sort" value={sort} />}
          {unusedOnly ? <input type="hidden" name="only" value="unused" /> : null}
          {fold.show ? <input type="hidden" name="pgops" value="show" /> : null}
          <label htmlFor="q" className="sr-only">Search table names</label>
          <input
            id="q"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Search tables"
            className="w-48 rounded border px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </form>
      </div>

      {/* "All tables", not `CHECKS.tableList.title` ("Tables"): CheckPanel's
          own heading sits right under the page's `<h1>Tables</h1>` — see
          `headingLevel` on CheckPanel for why the outline position is a
          stated choice, not an accident — and two headings with the same
          text back to back reads as a mistake rather than as two pieces of
          information. */}
      <CheckPanel title="All tables" result={result}>
        {(d) => {
          if (d.tables.length === 0) {
            return (
              <p className="text-sm text-muted-foreground">
                {search === undefined && !unusedOnly
                  ? 'No tables.'
                  : 'No tables match that.'}
              </p>
            );
          }
          // `foldOurs`, not a hand-rolled filter plus a separate `.length`
          // count: `components/findings.tsx`'s docblock explains why the
          // count must be DERIVED from the same rows it filters, inside one
          // function, rather than passed in beside them — an earlier
          // two-prop version let a mutation pass `items.length` for both and
          // restore the `rows.length` bug undetected. Two independent
          // traversals of the same rule here would be exactly that
          // configuration again, just inlined instead of behind a prop.
          const { shown, mine } = foldOurs(d.tables, (t) => t.name, fold.show);
          return (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortLink label="Table" column="name" current={sort} pathname={pathname} params={controls} />
                    <SortLink label="Size" column="size" current={sort} pathname={pathname} params={controls} align="right" />
                    <SortLink label="Rows" column="rows" current={sort} pathname={pathname} params={controls} align="right" />
                    <SortLink label="Dead" column="dead" current={sort} pathname={pathname} params={controls} align="right" />
                    <SortLink label="Cache hit" column="cache" current={sort} pathname={pathname} params={controls} align="right" />
                    <SortLink label="Vacuumed" column="vacuum" current={sort} pathname={pathname} params={controls} align="right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* `Findings` is not used here: it owns the fold and the
                      truncation sentence but renders a header of plain strings,
                      and every heading on this table is a link. The two notes it
                      would have contributed are rendered directly below. */}
                  {shown.map((t) => (
                    <TableRow key={t.name}>
                      <TableCell><EntityLink database={name} name={t.name} /></TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(t.sizeBytes)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(t.liveRows)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(t.deadRows)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {/* null is "no heap I/O recorded", which is NOT 0%. */}
                        {t.hitRate === null ? '—' : `${(t.hitRate * 100).toFixed(1)}%`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatAgo(t.lastVacuum) ?? 'never'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {/* Truncation counted BEFORE the fold, deliberately — the same
                  choice `Findings` documents and makes: `d.total >
                  d.tables.length` is a fact about the SQL's cap, unaffected
                  by how many of the returned rows are then folded away. */}
              {d.total > d.tables.length ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Showing {formatCount(d.tables.length)} of {formatCount(d.total)}. Narrow
                  the search or raise the cap to see the rest.
                </p>
              ) : null}
              <FoldNote mine={mine} fold={fold} />
            </>
          );
        }}
      </CheckPanel>
    </div>
  );
}
