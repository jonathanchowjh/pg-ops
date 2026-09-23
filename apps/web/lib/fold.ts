/**
 * Hiding pgops's own relations from the lists an operator reads, and saying
 * how many were hidden.
 *
 * A console pointed at a database that is also its store — the documented
 * single-database setup, and the one every developer runs — finds its own
 * tables, indexes and sequences in every catalog scan it makes. Eight of
 * them, on a list of nine. The findings an operator opened the page for are
 * then outnumbered by the tool that found them.
 *
 * SPLIT, NOT FILTERED, and COUNTED, NOT DROPPED — the same rule the Sessions
 * page already applies to pgops's own connections. pgops's schema IS in that
 * database and it does take space, so a console that removed itself from its
 * own inventory would be lying about the thing it exists to measure. The
 * count is always stated and the rows are one click away.
 *
 * READINGS ARE NEVER FOLDED. A hit rate, a database size, a cache
 * percentage: those are one number computed over everything, and there is no
 * row to hide. Only LISTS fold.
 *
 * AND A VERDICT IS NEVER FOLDED, which is the part worth stating out loud. A
 * check's verdict is computed in `packages/checks` over every row its SQL
 * returned, then cached and rendered on the triage line — so "2 unused
 * indexes" can count an index this page has folded away. Filtering the check
 * instead would hide pgops's cost from pgops's own numbers, which is exactly
 * what the Sessions page refuses to do. The fold line says how many of the
 * count are ours; the README's note about giving pgops its own store covers
 * the rest.
 */

/** The store's schema, and the only prefix this folds on. */
const OURS = 'pgops.';

export interface Fold {
  /** Whether the operator has asked to see them. */
  show: boolean;
  /** Where the show/hide link goes, carrying every other parameter along. */
  href: { pathname: string; query: Record<string, string> };
}

/**
 * Read the fold out of the URL, and build the link that flips it.
 *
 * URL state, not component state, for the reason the Sessions page's sort
 * links give: it is already shareable, bookmarkable and back-button-able,
 * and a client toggle would take those three away to add nothing.
 *
 * Every OTHER parameter is carried through, so flipping the fold on a page
 * that was reached with a limit or a sort does not silently reset it.
 */
export function foldFrom(
  pathname: string,
  params: Record<string, string | undefined>,
): Fold {
  const show = params.pgops === 'show';
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k !== 'pgops' && v !== undefined && v !== '') query[k] = v;
  }
  if (!show) query.pgops = 'show';
  return { show, href: { pathname, query } };
}

/** Whether this schema-qualified name belongs to pgops's own store. */
export function isOurs(qualifiedName: string): boolean {
  return qualifiedName.startsWith(OURS);
}

export interface Folded<T> {
  /** The rows to render: all of them when `show`, otherwise everyone else's. */
  shown: T[];
  /** How many are pgops's own, whether or not they are being shown. */
  mine: number;
}

/**
 * Split a list of rows on whether they are pgops's own.
 *
 * `subject` names the relation the row is ABOUT, which is not always the
 * row's most prominent field: a duplicate-index finding is about its index,
 * and an index-usage row is about its table.
 */
export function foldOurs<T>(
  items: readonly T[],
  subject: (item: T) => string,
  show: boolean,
): Folded<T> {
  const mine = items.filter((i) => isOurs(subject(i))).length;
  return { shown: show ? [...items] : items.filter((i) => !isOurs(subject(i))), mine };
}
