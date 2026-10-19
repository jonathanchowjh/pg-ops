import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * A page's identity: its ancestors, then its name. It sits above the clock
 * bar, because where comes before when.
 *
 * The crumb is the ancestors only, each ending in "›", and it is the URL:
 * "prod › Tables ›" above a table. `children` go at the right: numbers, a
 * find box, the one action.
 */
export function NodeHead({ crumb, title, mono = false, children }: {
  crumb: readonly { label: string; href: string }[];
  /** A name, or a statement in its `<Sql>`. */
  title: ReactNode;
  /** A name Postgres gave, not one pgops did. */
  mono?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="pt-2">
      {crumb.length === 0 ? null : (
        <nav aria-label="Breadcrumb" className="text-xs/[18px] text-muted-foreground">
          {crumb.map((c) => (
            <span key={c.href}>
              <Link href={c.href} className="hover:text-foreground hover:underline">{c.label}</Link>{' › '}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-baseline gap-3 pt-0.5 pb-2.5">
        <h1 className={cn('m-0 font-semibold tracking-[-0.015em] text-foreground', mono ? 'font-mono text-lg/[26px]' : 'text-xl/[26px]')}>
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}

/** The one text search of a page that lists rows. A GET to the page itself, so it clears on navigation. */
export function FindBox({ find, label, winSecs, end }: { find: string; label: string; winSecs: number; end: number | null }) {
  return (
    <form role="search" className="ml-auto">
      <input type="hidden" name="win" value={winSecs} />
      {end === null ? null : <input type="hidden" name="end" value={end} />}
      <input
        type="search" name="find" defaultValue={find} aria-label={label} placeholder={label}
        className="w-[230px] max-w-full rounded-[5px] border bg-card px-2 py-0.5 text-xs/[18px] text-foreground placeholder:text-muted-foreground"
      />
    </form>
  );
}

/** A live read that failed, said where its rows would have been: a calm empty list would be a lie. */
export function ReadAlert({ read }: { read: { ok: true } | { ok: false; message: string; remedy?: string } | null }) {
  if (read === null || read.ok) return null;
  return (
    <p role="alert" className="my-3 rounded-md border border-l-[3px] border-l-critical-ink bg-critical-surface px-3.5 py-2.5 text-foreground">
      The sessions could not be read: {read.message}
      {read.remedy === undefined ? null : <code className="ml-2 font-mono">{read.remedy}</code>}
    </p>
  );
}
