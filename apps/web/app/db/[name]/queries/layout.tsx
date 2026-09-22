import type { ReactNode } from 'react';
import { SubNav } from '@/components/sub-nav';

/**
 * The Queries tab's section strip, rendered once for every page under it.
 *
 * A LAYOUT, not a component each page renders: `useSelectedLayoutSegment()`
 * answers relative to the nearest layout, and inside a page there is no
 * segment below to answer with — so while seven pages each rendered the
 * strip, it highlighted nothing on any of them. Here it answers `indexes` on
 * /queries/indexes and on /queries/indexes/bloat alike, and `null` on the tab
 * itself. One place also means the strip cannot change shape between pages.
 */
export default async function QueriesLayout(
  { children, params }: { children: ReactNode; params: Promise<{ name: string }> },
) {
  const { name } = await params;
  return (
    <>
      <SubNav
        name={name}
        base="queries"
        items={[
          { segment: 'indexes', label: 'Indexes' },
          { segment: 'tables', label: 'Tables' },
          { segment: 'explain', label: 'Explain' },
        ]}
      />
      {children}
    </>
  );
}
