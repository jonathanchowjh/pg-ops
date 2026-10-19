import type { Verdict, VerdictLevel } from '@pgops/checks';
import { Badge } from '@/components/ui/badge';

const LABEL = { ok: 'OK', warn: 'WARN', critical: 'CRITICAL' } as const;

const VARIANT = {
  ok: 'success',
  warn: 'warning',
  critical: 'destructive',
} as const;

/**
 * The accent a container wears at `warn` and `critical`. Nothing at `ok`.
 * `null` (a check with no opinion) and a failed check also get no accent on
 * purpose: neither is a verdict, and gray is what "no information" looks
 * like here (see globals.css).
 */
export function accentClass(verdict: Verdict | null | undefined): string {
  if (!verdict) return '';
  if (verdict.level === 'critical') return 'border-l-4 border-l-destructive';
  if (verdict.level === 'warn') return 'border-l-4 border-l-warning';
  return '';
}

/**
 * The tint a container wears behind that accent, under the same rule.
 *
 * Deliberately faint. tokens.test.ts holds that the text on it clears 4.5:1
 * and that the tint stays between 1.02 and 1.4 against the canvas.
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
 * Colour is never the only signal: the level is spelled out in text too. The
 * hue is what makes a WARN findable in a long list without reading every
 * label.
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
