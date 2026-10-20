'use client';

import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * The pages under a database, as the sidebar lists them.
 *
 * `polls` is declared, not inferred: pages.test.ts reads each page off disk
 * and fails if one polls while saying it does not, or the reverse. Both
 * mistakes are silent otherwise: an incident page that stops updating, or a
 * catalog scan on a five-second timer.
 *
 * The first entry is the database itself, the tree; the sidebar prints the
 * database's name for it.
 */
export interface Page {
  /** What `useSelectedLayoutSegment` returns one level below /db/[name]; null on the tree. */
  readonly segment: string | null;
  readonly href: string;
  readonly label: string;
  readonly polls: boolean;
  /** Segments that light this entry too: a tool or a node addressed under it. */
  readonly also?: readonly string[];
}

export const PAGES: readonly Page[] = [
  { segment: null, href: '', label: '', polls: true },
  { segment: 'tables', href: '/tables', label: 'Tables', polls: false },
  { segment: 'queries', href: '/queries', label: 'Queries', polls: true, also: ['explain'] },
  { segment: 'indexes', href: '/indexes', label: 'Indexes', polls: false },
  { segment: 'server', href: '/server', label: 'Server', polls: true },
];

const ITEM = 'flex items-center rounded-[5px] px-2 py-1 whitespace-nowrap hover:bg-muted hover:text-foreground '
  + 'aria-[current=page]:bg-muted aria-[current=page]:font-semibold aria-[current=page]:text-foreground';

/**
 * The sidebar: the fleet, then this database by name, which is the tree,
 * with its pages under it. A client component purely for
 * `useSelectedLayoutSegment`; a server layout cannot know the active segment.
 *
 * The list is `PAGES`. No counts and no marks: what needs
 * attention is said on the tree.
 *
 * Under 768 px it is one row that scrolls sideways, above the page.
 */
export function Sidebar({ name }: { name: string }) {
  const segment = useSelectedLayoutSegment();
  return (
    <aside className="flex items-center gap-1 overflow-x-auto border-b bg-sidebar p-2 text-[13px]/5 md:sticky md:top-0 md:h-screen md:flex-col md:items-stretch md:gap-3.5 md:self-start md:overflow-y-auto md:border-r md:border-b-0 md:px-2.5 md:py-3.5">
      <span className="px-2 font-mono font-semibold text-foreground">pgops</span>
      <nav aria-label="Fleet" className="flex md:flex-col">
        <Link href="/" className={ITEM}>Fleet</Link>
      </nav>
      <div aria-hidden className="mx-2 h-px bg-border max-md:hidden" />
      <nav aria-label={name} className="flex gap-px md:flex-col">
        {PAGES.map((p) => (
          <Link
            key={p.href}
            href={`/db/${name}${p.href}`}
            aria-current={p.segment === segment || (segment !== null && (p.also ?? []).includes(segment)) ? 'page' : undefined}
            className={cn(ITEM, p.segment !== null && 'md:pl-6')}
          >
            {p.segment === null ? name : p.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
