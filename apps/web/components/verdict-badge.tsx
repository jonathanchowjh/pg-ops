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

/**
 * The tint a container wears behind that accent.
 *
 * A GROUND, not a highlight, and deliberately barely there — 1.05:1 against
 * the canvas in light mode. The bar and the badge carry the signal; this only
 * joins the panel's title, reading and explanation into one block so the eye
 * takes them as one thing. tokens.test.ts holds both ends of that: the text
 * on it clears 4.5:1, and the tint itself stays between 1.02 and 1.4 against
 * the canvas, so it can neither vanish nor shout.
 *
 * Nothing at `ok`, nothing at `null`, and nothing for a FAILED check — the
 * same rule as the accent. Gray is what "no information" looks like here, and
 * a check that could not run has no verdict to tint with.
 */
export function surfaceClass(verdict: Verdict | null | undefined): string {
  if (!verdict) return '';
  if (verdict.level === 'critical') return 'bg-critical-surface';
  if (verdict.level === 'warn') return 'bg-warning-surface';
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
export function VerdictBadge({ verdict, note = true }: { verdict: Verdict; note?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant={VARIANT[verdict.level]}>{LABEL[verdict.level]}</Badge>
      {note && verdict.note
        ? <span className="text-sm text-muted-foreground">{verdict.note}</span>
        : null}
    </span>
  );
}
