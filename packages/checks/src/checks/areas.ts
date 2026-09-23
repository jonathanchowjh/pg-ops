import type { Gate } from '../gates.js';
import { CHECKS } from '../registry.js';
import type { StoredCheckResult } from '../store/read.js';

/**
 * The hygiene areas — one per page that renders cached checks — and the
 * roll-up the triage page shows for each.
 *
 * WHY THIS IS DECLARED RATHER THAN DERIVED. The obvious version reads each
 * check's `gate` and groups by it. That is wrong twice over: `invalidConstraints`
 * declares `keep-up` and renders on the Indexes page, and `tableStats`
 * declares `keep-up` and renders on Tables. Both are deliberate — a check's
 * gate says which question it answers, and its area says which page an
 * operator opens to read it. They agree for most checks and must be allowed
 * to disagree for these.
 *
 * `band` is therefore the band the LINE renders in, which follows the page,
 * not the member checks' gates. `settings` renders inside the Cleanup
 * overview rather than on a page of its own and has no band at all.
 */
export interface Area {
  id: string;
  /** The word on the line, and on the sub-navigation pill it links to. */
  label: string;
  /** Path under `/db/<name>/`, or null where the area has no page of its own. */
  href: string | null;
  /** The triage band the line renders in, or null where it renders no line. */
  band: Gate | null;
  members: readonly string[];
}

/** The members of each area, by check id. */
const MEMBERS = [
  {
    id: 'indexes',
    label: 'Indexes',
    href: 'queries/indexes',
    band: 'work',
    members: [
      'indexHitRate', 'invalidIndexes', 'unusedIndexes', 'invalidConstraints',
      'duplicateIndexes', 'missingIndexes', 'indexUsage', 'indexCaching',
      'indexList', 'lastStatsReset',
    ],
  },
  {
    id: 'tables',
    label: 'Tables',
    href: 'queries/tables',
    band: 'work',
    members: ['tableHitRate', 'tableCaching', 'unusedTables', 'tableStats'],
  },
  {
    id: 'space',
    label: 'Space',
    href: 'cleanup/space',
    band: 'keep-up',
    members: ['databaseSize', 'relationSizes', 'tableSizes'],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    href: 'cleanup/maintenance',
    band: 'keep-up',
    members: ['autovacuumDanger', 'vacuumProgress'],
  },
  {
    id: 'sequences',
    label: 'Sequences',
    href: 'cleanup/sequences',
    band: 'keep-up',
    members: ['sequences'],
  },
  {
    id: 'settings',
    label: 'Settings',
    href: null,
    band: null,
    members: ['settings'],
  },
] as const satisfies readonly Area[];

export const AREAS: readonly Area[] = MEMBERS;

function canJudge(checkId: string): boolean {
  return CHECKS[checkId as keyof typeof CHECKS]?.verdict !== undefined;
}

/**
 * Whether any member of this area can escalate — DERIVED, never typed in. A
 * threshold added to `databaseSize` tomorrow gives Space a line with no edit
 * here, and one removed takes a line away.
 *
 * An area with no escalating member renders NO line: every one of its checks
 * reports a reading and judges nothing, so a line would have to invent a
 * verdict — the "we looked and it is fine" over-claim `verdict: null` exists
 * to prevent.
 *
 * A FUNCTION, not a field on AREAS, and that is load-bearing: `registry.ts`
 * is what builds `CHECKS`, and reading it while this module is still being
 * evaluated is a cycle — every id resolved to `undefined` and the whole
 * package failed to import. Asked for at call time, the registry is always
 * fully built.
 */
export function areaEscalates(area: Area): boolean {
  return area.members.some(canJudge);
}

/** Every hygiene check the scheduler should run, in area order. */
export const HYGIENE_CHECK_IDS: readonly string[] = AREAS.flatMap((a) => a.members);

export type HygieneLevel = 'ok' | 'warn' | 'critical' | 'unknown';

export interface HygieneArea {
  id: string;
  label: string;
  href: string | null;
  band: Gate | null;
  level: HygieneLevel;
  /** What is wrong, or why there is no answer. Null when healthy. */
  note: string | null;
  /** How old the oldest member's reading is, or null when there is none. */
  ageMs: number | null;
}

export interface HygieneOpts {
  now: Date;
  /** Past this, a reading is no longer a current answer. Two capture intervals. */
  staleAfterMs: number;
}

const RANK = { ok: 0, warn: 1, critical: 2 } as const;

/**
 * Roll the cached results up into one line per escalating area.
 *
 * Pure, and deliberately: this is the only logic between the store and the
 * triage page, and it decides when a colour is shown — so it is unit-tested
 * against fixtures rather than against a database.
 *
 * ONLY THE ESCALATING MEMBERS ARE CONSULTED. A member with no verdict
 * contributes nothing when it succeeds, so its failure withholds nothing
 * either: an `indexList` that timed out must not paint the Indexes line grey
 * when every check that judges ran fine.
 *
 * `unknown` wins over any verdict. A missing, stale or failed member means
 * the area has not been assessed, and this project never renders that as
 * `ok` — see the overview's UNKNOWN badge, which exists for the same reason.
 */
export function hygieneAreas(
  results: readonly StoredCheckResult[],
  opts: HygieneOpts,
): HygieneArea[] {
  const byId = new Map(results.map((r) => [r.checkId, r]));

  return AREAS.filter(areaEscalates).map((area) => {
    const judges = area.members.filter(canJudge);
    const rows = judges.map((id) => byId.get(id));

    const line = {
      id: area.id, label: area.label, href: area.href, band: area.band,
    };

    if (rows.some((r) => r === undefined)) {
      return { ...line, level: 'unknown' as const, note: 'never captured', ageMs: null };
    }
    const present = rows as StoredCheckResult[];
    const ageMs = Math.max(...present.map((r) => opts.now.getTime() - r.capturedAt.getTime()));

    if (ageMs > opts.staleAfterMs) {
      return { ...line, level: 'unknown' as const, note: 'last captured too long ago', ageMs };
    }
    const failed = present.find((r) => !r.ok);
    if (failed !== undefined) {
      return { ...line, level: 'unknown' as const, note: failed.message, ageMs };
    }

    // Worst first, so the sentence opens with the thing that decided the
    // level rather than with whichever member happens to sort first.
    const escalated = present
      .filter((r) => r.level === 'warn' || r.level === 'critical')
      .sort((a, b) => RANK[b.level as 'warn' | 'critical'] - RANK[a.level as 'warn' | 'critical']);

    const level = escalated[0]?.level as 'warn' | 'critical' | undefined ?? 'ok';
    const note = escalated.map((r) => r.note).filter((n) => n !== null).join(' · ');

    return { ...line, level, note: note === '' ? null : note, ageMs };
  });
}
