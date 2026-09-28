import Link from 'next/link';
import { cn } from '@/lib/utils';
import { withParam } from '@/lib/url';

/**
 * A column heading that sorts.
 *
 * `aria-sort` on the `<th>`, not a caret glyph alone: the active column must
 * be announced, and it must be distinguishable without colour. Every sort
 * this console offers is single-direction and chosen to be the direction
 * anyone asks for — biggest first, worst cache hit first, longest unvacuumed
 * first — so there is no ascending/descending toggle to carry. That is a
 * deliberate narrowing, not an omission: a second click that reverses
 * "biggest tables" into "smallest tables" answers a question nobody has
 * during an incident, and it doubles the sort surface the check must
 * whitelist.
 */
export function SortLink({ label, column, current, pathname, params, align }: {
  label: string;
  column: string;
  current: string;
  pathname: string;
  params: Record<string, string | undefined>;
  align?: 'right';
}) {
  const active = column === current;
  return (
    <th
      scope="col"
      aria-sort={active ? 'descending' : 'none'}
      className={cn(
        'h-9 px-2 text-left align-middle font-medium text-muted-foreground',
        align === 'right' && 'text-right',
      )}
    >
      <Link
        href={withParam(pathname, params, 'sort', column)}
        className={cn(
          'underline-offset-4 hover:underline',
          active && 'font-semibold text-foreground underline',
        )}
      >
        {label}
      </Link>
    </th>
  );
}
