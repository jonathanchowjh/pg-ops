import type { ReactNode } from 'react';
import type { CheckResult, Threshold, Verdict } from '@pgops/checks';
import { cn } from '@/lib/utils';
// No `.js` extension, unlike the rest of this repo. Next's bundler resolves
// relative imports against real files on disk and cannot map `./x.js` onto a
// sibling `x.tsx`; the build fails with a module-not-found that neither tsc
// nor vitest reproduces, because both happily rewrite the specifier. The
// convention is repo-wide EXCEPT inside apps/web's app, lib and components.
import { VerdictBadge, accentClass, surfaceClass } from './verdict-badge';
import { Badge } from './ui/badge';
import { formatCount } from '@/lib/format';

/**
 * True when this result is something the operator has to deal with.
 *
 * Exported because the triage page's bands rank on exactly this, and the
 * definition has to be the same one the panel styles itself by — a band that
 * called a panel quiet while the panel drew itself as an incident would be
 * worse than either alone.
 *
 * `!ok` counts. "We could not look" is not a quiet state: it is the one this
 * whole console was built to stop reading as "we looked and it is fine".
 */
export function needsAttention<T>(result: CheckResult<T>): boolean {
  if (!result.ok) return true;
  return result.verdict !== null && result.verdict.level !== 'ok';
}

/**
 * Every check on every page renders through here, so the failed case is
 * handled exactly once and cannot be forgotten on a page written later.
 *
 * `runCheck` never rejects: a denied, unsupported, or broken check arrives as
 * `{ok: false}` data. A panel that rendered nothing for that case would leave
 * a hole on the page that reads as "nothing to report" — the most dangerous
 * possible misreading during an incident. So the failure is rendered as
 * prominently as the success.
 *
 * `action` is the panel's way out. A triage panel that names a pid and stops
 * is a dead end — the operator has found the problem and the page offers
 * nowhere to go act on it, on a console whose pitch is that it can act and
 * not only watch. Panels that identify something actionable pass a link here.
 *
 * `headingLevel` exists because triage groups these panels under band
 * headings. Both were `h2`, which made every panel a SIBLING of the band
 * containing it: thirteen flat `h2`s in the document outline, so a reader
 * navigating by heading got no grouping at all — losing precisely the
 * structure the bands were added to provide. Pages that use panels directly,
 * under the layout's `h1`, keep the default.
 *
 * `count` is for the panels that find things and judge nothing.
 *
 * Fifteen of the twenty-one hygiene checks report a reading and never reach a
 * verdict, which is deliberate — `verdict: null` is "we do not judge this",
 * held distinct from "we judged it fine" — but it left the panels with the
 * most rows in them as the least marked things on their page. "Duplicate
 * indexes" listing nine redundant indexes had a bare heading, while "Index
 * cache hit rate" carried a green badge for having nothing to report. An
 * operator scanning badges down the page saw the wrong panels.
 *
 * A NEUTRAL chip, never a hue. Colour on this console means a threshold was
 * crossed, and there is no threshold here — that is the whole point. The chip
 * says how many, and stops.
 *
 * Rendered only where a verdict is not: a check that judged has something
 * stronger to say, and two badges in one corner would compete.
 *
 * `compact` is how the page stops spending equal space on unequal news. Nine
 * cards of identical size said a 42-minute lock chain and `0 slot(s)` were
 * the same size of problem. pgHero's dashboard collapses every healthy check
 * to a single line and expands only the ones that need reading, and the
 * research is consistent that a responder can hold five to nine items before
 * signal becomes noise. Compact keeps the value on screen — nothing is
 * hidden, and the badge still renders — it just stops it shouting.
 *
 * A BOX MEANS LOOK HERE. Compact halved the space a healthy check took and
 * left it wearing the same bordered card as an incident, so a triage page
 * with nothing wrong was still nine outlined boxes — furniture, at the weight
 * of a signal. Only a panel that needs attention (`warn`, `critical`, or a
 * check that could not run) keeps its border; it gains the tint and the
 * accent bar with it. Everything else is a row on the canvas under a
 * hairline. Nothing is hidden and no wording changes: the border stops being
 * decoration and becomes the third thing, after the bar and the badge, that
 * says the same one word.
 */
export function CheckPanel<T>({
  title,
  result,
  action,
  headingLevel = 2,
  compact = false,
  count,
  children,
}: {
  title: string;
  result: CheckResult<T>;
  action?: ReactNode;
  headingLevel?: 2 | 3;
  compact?: boolean;
  /** How many things this panel found. Shown only when there is no verdict. */
  count?: (data: T) => number;
  children: (data: T, verdict: Verdict | null) => ReactNode;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  // How many this panel found, when it is a panel that finds things and
  // judges nothing. Zero unless a `count` was given AND there is no verdict.
  const found = result.ok && result.verdict === null && count !== undefined
    ? count(result.data)
    : 0;
  // `verdict: null` is a check with no opinion (spec §1.1) — there is nothing
  // for a badge to say, so none renders, rather than a substituted OK
  // claiming this check judged the reading fine. The count chip below is not
  // a substitute either: it says how many rows, never whether they are good.
  //
  // A COMPACT panel drops the verdict's note, and this is not a style
  // preference. The compact row already states the reading in the page's own
  // words — "2 waiting · longest 4m 31s" — and the note states it again in
  // the check's — "2 sessions blocked". Side by side in a third of a column
  // they wrapped over three lines to say one thing twice. The full panel
  // keeps the note, where it has the room and where the reading beside it is
  // a list rather than a summary.
  const badge = result.ok
    ? (result.verdict
      ? <VerdictBadge verdict={result.verdict} note={!compact} />
      // Zero findings needs no chip: an empty list already says so, in
      // words, where the rows would be.
      : (found > 0
        ? <Badge variant="secondary" className="tabular-nums">{formatCount(found)}</Badge>
        : null))
    // Scannable, not just legible. The failure text says what happened, but
    // it is prose in a page of prose; this puts "we could not look" in the
    // same position, and at the same glance-weight, as the verdict it stands
    // in for. Deliberately the only badge with no hue — colour tracks
    // verdicts, and this is the absence of one (see globals.css).
    : <Badge variant="outline">UNAVAILABLE</Badge>;

  // See the docblock: a box is a signal, not a container. `needsAttention`
  // rather than the verdict alone, so a check that could not run keeps its
  // border — "we could not look" is not a quiet state.
  const loud = needsAttention(result);
  const verdict = result.ok ? result.verdict : null;

  if (compact) {
    return (
      <div
        className={cn(
          'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm',
          loud
            ? cn('rounded-md border px-3 py-2', accentClass(verdict), surfaceClass(verdict))
            // A hairline, and the same horizontal padding so a healthy row
            // and an escalated card still line their titles up in a column.
            : 'border-b px-3 py-2',
        )}
      >
        <Heading className="font-medium">{title}</Heading>
        <div className="flex items-baseline gap-3 text-muted-foreground">
          {result.ok ? children(result.data, result.verdict) : <span>{result.reason}</span>}
          {badge}
        </div>
      </div>
    );
  }

  return (
    <section
      // The accent is on the container, not the badge, because it has to be
      // findable in PERIPHERAL vision — a stack of nine panels is scanned
      // down the left edge, and that is where a 4px bar lands. Only warn and
      // critical carry one; see accentClass.
      className={cn(
        loud
          ? cn('rounded-lg border p-4', accentClass(verdict), surfaceClass(verdict))
          // Not a card: the title keeps its hairline so the section still
          // reads as one, and the reading sits directly on the canvas.
          : 'py-1',
      )}
    >
      <header
        className={cn(
          'mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1',
          loud ? '' : 'border-b pb-2',
        )}
      >
        <Heading className="font-semibold">{title}</Heading>
        <span className="flex items-center gap-3">
          {badge}
          {action}
        </span>
      </header>
      {result.ok ? (
        // Two columns once there is room, because the guidance is capped at a
        // readable line length and the panel is not. Stacked, a CRITICAL
        // panel on a 1440px screen was a 600px column of text with 800px of
        // white space beside it — the reading and the reason for it pushed
        // apart vertically by the one thing neither of them needed. Side by
        // side they are read together, which is how they are used.
        <div className={cn('grid gap-x-6 gap-y-3', result.crossed && 'lg:grid-cols-2')}>
          {/* `min-w-0` is what makes `ui/table`'s own horizontal scroller
              work, and without it the scroller had never engaged at any
              width. A grid item defaults to `min-width: auto`, which refuses
              to shrink below its content's min-content size — so a table of
              `whitespace-nowrap` cells made this item 963px inside a 720px
              track, the `overflow-x-auto` wrapper inside it inherited that
              width via `w-full` and had nothing left to scroll, and the
              overflow escaped all the way out to the document. At 768px the
              whole PAGE scrolled sideways, taking the sticky header with it. */}
          <div className="min-w-0">{children(result.data, result.verdict)}</div>
          <Guidance crossed={result.crossed} />
        </div>
      ) : (
        <div className="text-sm">
          <p className="font-medium">Unavailable — {result.reason}</p>
          <p className="text-muted-foreground">{result.message}</p>
          {result.remedy ? <pre className="mt-2 overflow-x-auto rounded bg-muted p-2">{result.remedy}</pre> : null}
        </div>
      )}
    </section>
  );
}

/**
 * Why the number matters, and what to do about it.
 *
 * Both sentences already existed and neither was ever rendered.
 * `Threshold.because` is documented in the checks package as "the sentence
 * justifying this number. MUST NOT be empty" — it is required, non-empty by
 * contract, and unit-tested, and a grep for it across apps/web returned
 * nothing. So the console showed CRITICAL and `idle in transaction for
 * 2542s` and never once said why that is bad, on a tool whose whole claim is
 * that it explains a database to the person woken up by it.
 *
 * `remedy` is the other half, and the checks package had already named the
 * principle: registry.ts calls pgHero's capability "the probe plus the
 * remedy". It shipped the remedy only on the path where a check BROKE. This
 * is the path where a check WORKED and found something.
 *
 * Nothing renders at `ok`: run.ts resolves no threshold there, because none
 * was crossed and there is no sentence to show.
 */
function Guidance({ crossed }: { crossed?: Threshold }) {
  if (!crossed) return null;
  return (
    // `max-w-prose`, because these are the two longest sentences on the page
    // and the panel around them is now as wide as the window. A 1500px-wide
    // line of explanation is a line nobody finishes.
    //
    // The rule moves with the layout: a horizontal divider above the text
    // when it sits below the reading, a vertical one beside it when it sits
    // alongside.
    <div className="max-w-prose space-y-1.5 border-t pt-3 text-sm lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
      {/* The `because` strings are written as because-CLAUSES — lower case,
          no terminal stop — so they need a lead-in to read as sentences.
          Rendering them bare produced "below a fifth of the pool free, a
          normal traffic spike can exhaust it", which reads like a fragment
          of something the page lost. */}
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Why this matters — </span>
        {crossed.because}.
      </p>
      {crossed.remedy ? <p>{crossed.remedy}</p> : null}
    </div>
  );
}
