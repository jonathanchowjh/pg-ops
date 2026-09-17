'use client';

import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { cn } from '@/lib/utils';

export interface SubNavItem {
  /** The directory name under the tab — see the docblock on why not a path. */
  segment: string;
  label: string;
}

/**
 * The second level of navigation: which part of a tab, where `Nav` answers
 * which tab.
 *
 * Matched on `useSelectedLayoutSegment()` for the same reason `Nav` is: the
 * segment IS the directory name, so this list cannot drift out of step with
 * the routes the way a parsed pathname could. `null` is the segment on the
 * tab's own page, which is why the first entry is not a special case bolted
 * on — it is the entry whose segment is null.
 *
 * The tab keeps its landing page and its content; this is additive. Without
 * the first entry an operator who clicks into a sub-page could only get back
 * with the browser's back button, and the tab would read as replaced rather
 * than extended.
 *
 * Styled quieter than `Nav` deliberately — pills rather than a bordered tab
 * row. `Nav` answers "which gate?", which gates.ts calls the console's
 * vocabulary; this answers a smaller question and gets a smaller control, so
 * the two strips sitting one above the other still read as a hierarchy.
 *
 * `name` is interpolated raw, as every other link in this app does.
 * lib/config.ts validates it against /^[A-Za-z0-9_-]+$/ at load, explicitly
 * because "it becomes a URL path segment" — so there is nothing here to
 * encode, and encoding only here would make this one component disagree with
 * `Nav` directly above it.
 */
export function SubNav(
  { name, base, items }: { name: string; base: string; items: readonly SubNavItem[] },
) {
  const segment = useSelectedLayoutSegment();
  const root = `/db/${name}/${base}`;
  const entries = [{ segment: null as string | null, href: root, label: 'Overview' }]
    .concat(items.map((i) => ({
      segment: i.segment,
      href: `${root}/${i.segment}`,
      label: i.label,
    })));

  return (
    <nav aria-label={`${base} sections`} className="mb-4 flex flex-wrap gap-1 text-sm">
      {entries.map((e) => {
        const active = e.segment === segment;
        return (
          <Link
            key={e.href}
            href={e.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1 transition-colors',
              active
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {e.label}
          </Link>
        );
      })}
    </nav>
  );
}
