import type { ReactNode } from 'react';
import Link from 'next/link';

/**
 * The one way a relation name is rendered when it can be clicked.
 *
 * Encoded here and decoded by Next on the way in, exactly once each way: a
 * relation name is an arbitrary identifier and may hold a slash or a percent.
 * The receiving page is app/db/[name]/tables/[relation]/page.tsx.
 *
 * With `children`, the link wraps them instead of printing the name: a
 * tree row's whole label cell is its one link. Tables only: there is no
 * index page to link to.
 */
export function EntityLink(
  { database, name, className, children }: { database: string; name: string; className?: string; children?: ReactNode },
) {
  return (
    <Link
      href={`/db/${database}/tables/${encodeURIComponent(name)}`}
      className={className ?? 'font-mono underline decoration-border underline-offset-2 hover:decoration-foreground'}
    >
      {children ?? name}
    </Link>
  );
}
