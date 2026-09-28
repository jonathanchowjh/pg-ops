import Link from 'next/link';

/**
 * THE ONE WAY a relation name is rendered when it can be clicked.
 *
 * Spec §6: "all these UI things should be standard throughout". Eight pages
 * render a relation name today and each styles it by hand, so the same table
 * looks like three different kinds of thing depending on which page found it.
 * One component makes the convention mechanical rather than remembered.
 *
 * `encodeURIComponent` HERE, and decoded by Next on the way in — exactly
 * once, in each direction. A relation name is an arbitrary identifier: a
 * slash in one routes somewhere else entirely, and a percent in one becomes
 * a mangled name if anything decodes twice. The receiving page's docblock
 * (app/db/[name]/tables/[relation]/page.tsx) carries the other half of this
 * contract.
 *
 * Deliberately NOT parameterised by kind yet. An index page does not exist
 * in this slice, and a link that reliably 404s is worse than a name that is
 * not yet a link.
 */
export function EntityLink({ database, name }: { database: string; name: string }) {
  return (
    <Link
      href={`/db/${database}/tables/${encodeURIComponent(name)}`}
      className="font-mono underline decoration-border underline-offset-2 hover:decoration-foreground"
    >
      {name}
    </Link>
  );
}
