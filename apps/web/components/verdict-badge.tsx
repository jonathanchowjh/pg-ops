import type { Verdict, VerdictLevel } from '@pgops/checks';
import { Badge } from '@/components/ui/badge';

const LABEL = { ok: 'OK', warn: 'WARN', critical: 'CRITICAL' } as const;

const VARIANT = {
  ok: 'success',
  warn: 'warning',
  critical: 'destructive',
} as const;

/**
 * The accent a container wears when the check inside it has an opinion worth
 * interrupting for.
 *
 * Only `warn` and `critical` return anything. An `ok` accent would put a
 * coloured edge on all nine triage panels of a healthy database, and a page
 * where everything is emphasised is a page where nothing is — the badge
 * already says OK, and the reader's eye is a scarce resource during an
 * incident. `null` (a check with no opinion) and a FAILED check both fall
 * through to no accent on purpose: neither is a verdict, and gray is what
 * "no information" looks like here (see globals.css).
 */
export function accentClass(verdict: Verdict | null | undefined): string {
  if (!verdict) return '';
  if (verdict.level === 'critical') return 'border-l-4 border-l-destructive';
  if (verdict.level === 'warn') return 'border-l-4 border-l-warning';
  return '';
}

/** The worst of two levels, for a container summarising several checks. */
const RANK: Record<VerdictLevel, number> = { ok: 0, warn: 1, critical: 2 };
export function worse(a: Verdict, b: Verdict): Verdict {
  return RANK[b.level] > RANK[a.level] ? b : a;
}

/**
 * Colour is never the only signal: the level is spelled out in text too. An
 * operator on a projector, colour-blind, or reading a screenshot in grayscale
 * still gets the verdict.
 *
 * What colour adds is the SCAN. The text label is what makes the badge
 * correct; the hue is what makes a WARN findable in a list of twenty rows
 * without reading twenty labels. Before these variants existed the palette
 * was entirely achromatic and `warn` rendered as the same gray as `ok`, so
 * the overview could be read correctly only by reading it word by word —
 * which is the one thing nobody does while the pager is going off.
 */
export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant={VARIANT[verdict.level]}>{LABEL[verdict.level]}</Badge>
      {verdict.note ? <span className="text-sm text-muted-foreground">{verdict.note}</span> : null}
    </span>
  );
}
