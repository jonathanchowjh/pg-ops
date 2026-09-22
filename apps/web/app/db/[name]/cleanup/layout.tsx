import type { ReactNode } from 'react';
import { SubNav } from '@/components/sub-nav';

/**
 * The Cleanup tab's section strip, rendered once for every page under it —
 * see queries/layout.tsx for why a layout and not each page.
 */
export default async function CleanupLayout(
  { children, params }: { children: ReactNode; params: Promise<{ name: string }> },
) {
  const { name } = await params;
  return (
    <>
      <SubNav
        name={name}
        base="cleanup"
        items={[
          { segment: 'space', label: 'Space' },
          { segment: 'maintenance', label: 'Maintenance' },
          { segment: 'sequences', label: 'Sequences' },
        ]}
      />
      {children}
    </>
  );
}
