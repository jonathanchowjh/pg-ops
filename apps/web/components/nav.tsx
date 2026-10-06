'use client';

import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { TABS } from '@/lib/tabs';
import { cn } from '@/lib/utils';


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
 *
 * THE STRIP ITSELF IS DATA, in lib/tabs.ts, and that file's docblock is where
 * the model and the decisions about it live — including why the strip is not
 * yet split into Now and Explore bands. This component renders that list and
 * decides nothing. It is a client component purely for the segment hook.
 *
 * The strip is no longer the four gates, and that is a decision rather than
 * drift: Tables is an object, it carries history, it does not poll, and it
 * feeds three readings across two gates at once, which is exactly why no
 * single gate could own it. Each tab declares its gate, or `null`, in
 * lib/tabs.ts; test/nav.test.tsx pins those declarations against GATE_ORDER
 * so every gate still has somewhere to click, and test/tabs.test.ts pins each
 * tab's `mode` against whether its page actually polls.
 */
export function Nav({ name }: { name: string }) {
  const segment = useSelectedLayoutSegment();

  return (
    <nav className="mb-4 flex flex-wrap gap-1 border-b text-sm">
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
