import type { ReactNode } from 'react';
import { FoldNote } from '@/components/fold-note';
import { foldOurs, type Fold } from '@/lib/fold';
import { formatCount } from '@/lib/format';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Every capped list on the hygiene pages: the rows, what the cap hid, and
 * what the fold hid.
 *
 * ONE COMPONENT, shared by Indexes and Tables, which had a byte-identical
 * copy each — and would now have needed the same fold added to both.
 *
 * `total` is the pre-LIMIT `count(*) OVER ()` the check carries (§5) — the
 * only number that knows how much the cap hid. Telling an operator a
 * truncated list was the whole answer is the failure these pages exist to
 * avoid.
 *
 * The count shown is derived from `items` INSIDE this component rather than
 * passed in beside it. An earlier version took `shown` and `total` as two
 * props, and a mutation that passed `items.length` for both — restoring
 * exactly the `rows.length` bug §5 forbids — survived the suite, because only
 * one of the call sites had a truncation test. One prop fewer removes the
 * mistake instead of testing for it eight times.
 *
 * `columns` turns the list into a real table. That is pgHero's density, and
 * it is what makes a column of percentages comparable by eye rather than by
 * reading each one: right-aligned, tabular figures, a heading that names the
 * unit, hairline row rules and no outer box. `<table>` markup rather than a
 * grid of divs, so the header cells are actually associated with their
 * columns for anyone reading this with a screen reader — a `role="table"`
 * bolted onto divs is the version of this that looks the same and announces
 * nothing.
 *
 * TRUNCATION IS COUNTED BEFORE THE FOLD, DELIBERATELY. "Showing 9 of 42" is a
 * fact about the SQL's cap, and the fold happens here, afterwards — so a list
 * that says nine and draws six is accounted for by the fold line directly
 * beneath it, rather than by a truncation sentence quietly changed to mean
 * something else.
 */
export function Findings<T>({ items, total, subject, fold, columns, children }: {
  items: readonly T[];
  total: number;
  /** The relation this row is ABOUT — see `foldOurs`. */
  subject: (item: T) => string;
  fold: Fold;
  /**
   * The column headings, when this list is a table. A trailing `>` on a label
   * right-aligns that column, which is where numbers belong: a column of
   * percentages is comparable at a glance only when its digits line up.
   *
   * Omitted where the rows are not a grid — a finding that carries a
   * `CREATE INDEX` statement under it is a list item, not a cell.
   */
  columns?: readonly string[];
  children: (item: T) => ReactNode;
}) {
  const { shown, mine } = foldOurs(items, subject, fold.show);
  return (
    <>
      {columns === undefined
        ? <ul className="text-sm">{shown.map(children)}</ul>
        : (
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead
                    key={c}
                    className={cn(c.endsWith('>') && 'text-right')}
                  >
                    {c.replace(/>$/, '')}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>{shown.map(children)}</TableBody>
          </Table>
        )}
      {total > items.length ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Showing {formatCount(items.length)} of {formatCount(total)}. Narrow the database or
          raise the cap to see the rest.
        </p>
      ) : null}
      <FoldNote mine={mine} fold={fold} />
    </>
  );
}
