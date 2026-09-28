import type { Gate } from '@pgops/checks';

/**
 * The tab strip, as data.
 *
 * It sat as a local `const` inside components/nav.tsx, which is the shape that
 * let nav.test.tsx carry its own second copy of the gate-to-tab mapping and
 * let the strip's organising idea live in a docblock rather than anywhere a
 * test could reach. Same reasoning as packages/checks/src/gates.ts, and the
 * same sentence applies: a model that is only written down drifts from the
 * thing it describes, and the drift is silent.
 *
 * Two facts each tab declares, both required, so the compiler asks the
 * question when a tab is added rather than a reviewer noticing later.
 *
 * **`mode` — does this tab's page poll?** This is the seam the information
 * architecture of 2026-09-23 §4 splits the console on, and it is not a new
 * idea here: guards.test.ts has enforced it from the page side since P2, where
 * an incident page renders `<Refresh>` and a hygiene page must not. What was
 * missing is the strip agreeing with it. `tabs.test.ts` reads every page named
 * below and fails if a tab declares `now` without polling, or `explore` while
 * polling.
 *
 * **`gate` — which gate is this tab the destination for?** `null` for Triage,
 * which renders all four as bands rather than going deeper into one, and for
 * an object page, which belongs to several gates at once and is exactly why no
 * gate could own a tab for it. nav.test.tsx pins `GATE_ORDER` against these
 * declarations, so a fifth gate cannot appear with nowhere to click.
 *
 * WHY THE STRIP IS NOT YET SPLIT INTO TWO BANDS, since `mode` now records the
 * side every tab falls on and rendering it would be a few lines. Grouping the
 * six tabs today gives **five in Now and one in Explore**. Queries and Cleanup
 * both poll, so both are Now, while everything underneath them — indexes,
 * bloat, suggested indexes, space, maintenance, sequences — is hygiene that
 * runs on visit. A band labelled Explore holding one tab, beside a band
 * labelled Now whose largest tab is a doorway to hygiene, is a label
 * contradicting its contents. That is the defect the triage bands already had
 * once, when they were named `Saturation` / `Lock chains` / `Slow queries` /
 * `Replication` — a resource state, a mechanism, a symptom and a noun — and
 * nobody could tell what they were looking at.
 *
 * The prerequisite is moving those hygiene children out of the two polling
 * tabs and onto entity tabs of their own, which is a route restructure with
 * its own redirects, its own tests and its own decision about the three pages
 * v2.5.0 deliberately did not fold into /tables. Recorded here rather than
 * half-built: `mode` is true today and the bands can be rendered from it the
 * day the routes sit on either side of the line.
 */
export interface Tab {
  /**
   * What `useSelectedLayoutSegment` returns one level below /db/[name] —
   * `null` on the triage index, the directory name on every other tab.
   * Matching on the segment rather than a parsed pathname is what keeps this
   * list from drifting out of step with the routes: the segment IS the
   * directory, and it is also how tabs.test.ts finds each tab's page on disk.
   */
  readonly segment: string | null;
  readonly href: string;
  readonly label: string;
  /** `now` polls every five seconds. `explore` runs on visit and carries history. */
  readonly mode: 'now' | 'explore';
  /** The gate this tab goes deeper into, or `null`. See the docblock above. */
  readonly gate: Gate | null;
}

export const TABS: readonly Tab[] = [
  { segment: null, href: '', label: 'Triage', mode: 'now', gate: null },
  { segment: 'sessions', href: '/sessions', label: 'Sessions', mode: 'now', gate: 'connect' },
  { segment: 'locks', href: '/locks', label: 'Locks', mode: 'now', gate: 'wait' },
  { segment: 'queries', href: '/queries', label: 'Queries', mode: 'now', gate: 'work' },
  { segment: 'tables', href: '/tables', label: 'Tables', mode: 'explore', gate: null },
  // Labelled `Cleanup`, not `Replication & cleanup`. The gate's title is the
  // sentence a band on the triage page uses; a tab is a word on a strip, and
  // the ampersand is where this row starts wrapping. The gate is declared
  // above rather than inferred from the label precisely because the two differ
  // here, which is what made a label-derived mapping in nav.test.tsx assert
  // "Replication" — a word that is not on the page at all.
  { segment: 'cleanup', href: '/cleanup', label: 'Cleanup', mode: 'now', gate: 'keep-up' },
] as const;
