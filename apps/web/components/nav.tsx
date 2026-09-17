'use client';

import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { cn } from '@/lib/utils';

// `segment` is what useSelectedLayoutSegment returns one level below
// /db/[name] — `null` on the triage index, the folder name on every other
// tab. Matching on that rather than on a parsed pathname means this list
// cannot drift out of step with the routes: the segment IS the directory.
const TABS = [
  { segment: null, href: '', label: 'Triage' },
  { segment: 'sessions', href: '/sessions', label: 'Sessions' },
  { segment: 'locks', href: '/locks', label: 'Locks' },
  { segment: 'queries', href: '/queries', label: 'Queries' },
  // Labelled `Cleanup`, not `Replication & cleanup`. The gate's title is the
  // sentence a band on the triage page uses; a tab is a word on a strip, and
  // the ampersand is where this row starts wrapping. test/nav.test.tsx holds
  // the property that matters — every gate has a tab — by href segment
  // rather than by label, precisely because the two differ here.
  { segment: 'cleanup', href: '/cleanup', label: 'Cleanup' },
] as const;

/**
 * A client component purely for `useSelectedLayoutSegment`. It was a server
 * component rendering four identical links, which meant the console gave no
 * answer at all to "where am I?" — every tab looked the same on every page,
 * and the only way to tell `/locks` from `/sessions` was to read the content
 * and infer it.
 *
 * `aria-current="page"` carries the same fact to a screen reader, and the
 * underline carries it to anyone who cannot see the colour change — the
 * active tab is never distinguished by colour alone.
 */
export function Nav({ name }: { name: string }) {
  const segment = useSelectedLayoutSegment();

  return (
    <nav className="mb-4 flex gap-1 border-b text-sm">
      {TABS.map((t) => {
        const active = t.segment === segment;
        return (
          <Link
            key={t.label}
            href={`/db/${name}${t.href}`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-t-md px-3 py-2 -mb-px border-b-2 transition-colors',
              active
                ? 'border-b-foreground font-medium text-foreground'
                : 'border-b-transparent text-muted-foreground hover:text-foreground hover:border-b-border',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
