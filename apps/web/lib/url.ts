/**
 * Building an href that replaces one query parameter and carries every other
 * one along.
 *
 * A page has three controls in the URL — the fold, the sort and the search —
 * and any one of them quietly resetting the other two is the failure all
 * three share. This is the one place that promise is kept. `SortLink` calls
 * it, the Tables list calls it directly for its presets, and `foldFrom` in
 * lib/fold.ts is a call to it with the key fixed to `pgops`.
 *
 * IT LIVES IN lib/ because two different kinds of caller need it — a client
 * component and a server page — and neither owns it. That used to be forced
 * rather than chosen: `guards.test.ts`'s redaction scan read `{ pathname,
 * query }` as a possibly unredacted statement and lib/ was the only directory
 * it did not walk, so a test was deciding module layout. That guard now
 * matches by position and no longer objects to an href anywhere, so this is a
 * placement the code can defend on its own.
 */

/**
 * Replace one query parameter, carrying every other one along.
 *
 * Returns Next's object href form rather than a string, so the query is
 * escaped by the router and not by hand. An `undefined` or empty `value`
 * REMOVES the parameter — which is how the fold's "show" link becomes its
 * "hide" link without a second code path.
 */
export function withParam(
  pathname: string,
  params: Record<string, string | undefined>,
  key: string,
  value: string | undefined,
): { pathname: string; query: Record<string, string> } {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k !== key && v !== undefined && v !== '') query[k] = v;
  }
  if (value !== undefined && value !== '') query[key] = value;
  return { pathname, query };
}
