import type { ReactNode } from 'react';
import type { CheckResult, Threshold, Verdict } from '@pgops/checks';
import { cn } from '@/lib/utils';
// No `.js` extension, unlike the rest of this repo: Next's bundler cannot map
// `./x.js` onto a sibling `x.tsx`, and neither tsc nor vitest reproduces the
// failure. This applies inside apps/web's app, lib and components.
import { VerdictBadge, accentClass, surfaceClass } from './verdict-badge';
import { Badge } from './ui/badge';
import { formatCount } from '@/lib/format';

/**
 * True when this result is something the operator has to deal with. A check
 * that could not run (`!ok`) counts. The triage page's bands rank on this, so
 * it must be the same definition the panel styles itself by.
 */
export function needsAttention<T>(result: CheckResult<T>): boolean {
  if (!result.ok) return true;
  return result.verdict !== null && result.verdict.level !== 'ok';
}

/**
 * Every check on every page renders through here, so the failed case is
 * handled once. `runCheck` never rejects: a denied, unsupported, or broken
 * check arrives as `{ok: false}` data and is rendered as prominently as a
 * success.
 *
 * `count` is for checks whose verdict is null ("we do not judge this"): a
 * neutral chip, because colour means a threshold was crossed. Only a panel
 * that needs attention gets a border, tint and accent bar.
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
  // Zero unless a `count` was given and there is no verdict.
  const found = result.ok && result.verdict === null && count !== undefined
    ? count(result.data)
    : 0;
  // `verdict: null` is a check with no opinion, so no verdict badge renders.
  // A compact panel drops the verdict's note: the compact row already states
  // the reading.
  const badge = result.ok
    ? (result.verdict
      ? <VerdictBadge verdict={result.verdict} note={!compact} />
      // Zero findings needs no chip: the empty list already says so.
      : (found > 0
        ? <Badge variant="secondary" className="tabular-nums">{formatCount(found)}</Badge>
        : null))
    // The only badge with no hue: colour tracks verdicts, and this is the
    // absence of one (see globals.css).
    : <Badge variant="outline">UNAVAILABLE</Badge>;

  // `needsAttention` rather than the verdict alone, so a check that could not
  // run keeps its border.
  const loud = needsAttention(result);
  const verdict = result.ok ? result.verdict : null;

  if (compact) {
    return (
      <div
        className={cn(
          'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm',
          loud
            ? cn('rounded-md border px-3 py-2', accentClass(verdict), surfaceClass(verdict))
            // Same horizontal padding as the card, so titles line up.
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
      // Only warn and critical carry an accent bar; see accentClass.
      className={cn(
        loud
          ? cn('rounded-lg border p-4', accentClass(verdict), surfaceClass(verdict))
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
        // Two columns once there is room: the guidance is capped at a
        // readable line length and the panel is not.
        <div className={cn('grid gap-x-6 gap-y-3', result.crossed && 'lg:grid-cols-2')}>
          {/* `min-w-0` is what makes `ui/table`'s horizontal scroller work. A
              grid item defaults to `min-width: auto` and will not shrink
              below its content, so a wide table would overflow the document
              instead of scrolling. */}
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
 * Why the number matters (`Threshold.because`) and what to do about it
 * (`remedy`). Nothing renders at `ok`: run.ts resolves no threshold there.
 */
function Guidance({ crossed }: { crossed?: Threshold }) {
  if (!crossed) return null;
  return (
    // The divider is above the text when stacked and beside it at `lg`.
    <div className="max-w-prose space-y-1.5 border-t pt-3 text-sm lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
      {/* The `because` strings are clauses — lower case, no terminal stop —
          so they need a lead-in and a full stop. */}
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Why this matters — </span>
        {crossed.because}.
      </p>
      {crossed.remedy ? <p>{crossed.remedy}</p> : null}
    </div>
  );
}
