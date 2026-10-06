'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { TableRow } from '@/components/ui/table';

/** `#pid-4511` → 4511. Anything else → null. */
export function pidFromHash(hash: string): number | null {
  const m = /^#pid-(\d+)$/.exec(hash);
  return m === null ? null : Number(m[1]);
}

/**
 * Which session row the URL fragment points at.
 *
 * NOT the CSS `:target` pseudo-class, which is what this replaced and which
 * was a silent no-op. `:target` tracks the document's target element, and the
 * App Router changes the URL with the History API rather than by navigating to
 * a fragment — so clicking a pid on the triage page moved the URL, scrolled
 * the row into view, and left `:target` matching nothing. Measured on a live
 * chain: `matches(':target')` was false after the click and true only after a
 * full page load, which is the one way nobody reaches this page during an
 * incident.
 *
 * Three separate reads cover three separate ways the fragment can change,
 * and each is handled by a different part of this hook:
 *   - Arriving fresh from another route remounts this component, so the
 *     `read()` call on mount picks up whatever fragment is already in the
 *     URL by then. This does not depend on the effect's dependency array at
 *     all — a mount always runs its effect once, regardless of what deps say.
 *   - A same-page fragment change (the fragment changes while this component
 *     stays mounted, e.g. clicking another pid link on the same page) fires
 *     `hashchange`, which the listener installed above catches.
 *   - `usePathname` is in the dependency list for the one case neither of
 *     those covers: a History-API navigation between two instances of the
 *     SAME route pattern (e.g. a different `[name]` in this route's path)
 *     that Next may satisfy without unmounting this component and without
 *     firing `hashchange`. No link in this app performs that navigation
 *     today — every pid link crosses either a page-load boundary or lands on
 *     the already-mounted `hashchange` case above — so this dependency is a
 *     contract the component keeps for that shape of navigation, not a fix
 *     for an observed bug.
 */
export function useHighlightedPid(): number | null {
  const pathname = usePathname();
  const [pid, setPid] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setPid(pidFromHash(window.location.hash));
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [pathname]);
  return pid;
}

/**
 * One session row, tinted when the fragment names its pid.
 *
 * A client component because the fragment is only knowable in the browser:
 * the server renders every row unmarked and the marked one appears on hydrate,
 * which is correct — a shared link's recipient sees the same row marked.
 *
 * Renders this app's `TableRow` rather than a bare `<tr>` so every row keeps
 * `TableRow`'s own border, hover tint and `data-slot` — dropping to `<tr>`
 * here would silently lose those on every Sessions row.
 */
export function HighlightedRow(
  { pid, className, children }: { pid: number; className?: string; children: ReactNode },
) {
  const highlighted = useHighlightedPid();
  return (
    <TableRow
      id={`pid-${pid}`}
      // `bg-background` is load-bearing, not decoration: the Sessions table
      // pins its action column with `sticky right-0 bg-inherit`, and a
      // transparent row would let the query column scroll under the Terminate
      // buttons. The highlight follows it and wins by twMerge's last-one-wins
      // on conflicting `bg-*`, so the pinned cell inherits the tint too.
      className={cn('scroll-mt-40 bg-background', highlighted === pid && 'bg-warning-surface', className)}
    >
      {children}
    </TableRow>
  );
}
