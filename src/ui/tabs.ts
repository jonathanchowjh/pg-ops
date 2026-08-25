/**
 * The tab registry (spec §5.3): nine tabs, keys `1`-`9`, fixed order.
 *
 * `0` is deliberately unbound — spec §5.3: "A tenth tab requires a new
 * registered escalation rule, not an empty slot." `tabForKey('0')` returns
 * `undefined` like any other unrecognised key; there is no tenth entry to
 * find.
 *
 * A plain exported array and two bare functions. No class: nothing here
 * holds state across calls, so there is nothing for a class to own.
 */
export interface Tab {
  key: string;
  name: string;
  built: boolean;
}

export const TABS: Tab[] = [
  { key: '1', name: 'triage', built: true },
  { key: '2', name: 'sessions', built: true },
  { key: '3', name: 'locks', built: true },
  { key: '4', name: 'top', built: true },
  { key: '5', name: 'space', built: false },
  { key: '6', name: 'vacuum', built: false },
  { key: '7', name: 'replication', built: false },
  { key: '8', name: 'seq', built: false },
  { key: '9', name: 'system', built: false },
];

/** The tab bound to `k`, or `undefined` if `k` (e.g. `'0'`) is unbound. */
export function tabForKey(k: string): Tab | undefined {
  return TABS.find((t) => t.key === k);
}

/**
 * The next tab in `dir` from the tab named `name`, wrapping at both ends.
 *
 * `active` (and so `name`) may name something that is not a tab — a later
 * task binds `D` to a doctor view (RULING R-P9), which the tab strip renders
 * with nothing highlighted, and pressing an arrow key from there still needs
 * a real `Tab` back. The signature promises `Tab`, not `Tab | undefined`, so
 * an unknown name cannot fall through to `TABS[-1]` (`undefined`) — instead
 * it is treated as sitting just before the first tab, so either direction
 * lands on `TABS[0]` (`triage`). That is an arbitrary but defined choice:
 * "leaving the doctor view" always returns you to the first tab rather than
 * throwing or silently returning `undefined` at runtime.
 */
export function nextTab(name: string, dir: 1 | -1): Tab {
  const i = TABS.findIndex((t) => t.name === name);
  // Unknown name (i === -1): land on index 0 regardless of `dir` — see the
  // doc comment above. Known name: step by `dir`, wrapping with `+ TABS.length`
  // before `%` since JS `%` can return negative for a negative dividend.
  const idx = i === -1 ? 0 : (i + dir + TABS.length) % TABS.length;
  const tab = TABS[idx];
  // noUncheckedIndexedAccess makes this `Tab | undefined`; handled, not
  // `!`-asserted. It is unreachable in practice — `idx` is always in
  // `[0, TABS.length)` by construction — but the signature promises `Tab`,
  // so a broken invariant must fail loudly rather than smuggle `undefined`
  // past the return type.
  if (tab === undefined) {
    throw new Error(`nextTab: index ${idx} out of range for TABS (length ${TABS.length})`);
  }
  return tab;
}
