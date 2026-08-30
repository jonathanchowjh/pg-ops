import type { Verdict } from '@pgops/checks';
import { Badge } from '@/components/ui/badge';

const LABEL = { ok: 'OK', warn: 'WARN', critical: 'CRITICAL' } as const;

/**
 * Colour is never the only signal: the level is spelled out in text too. An
 * operator on a projector, colour-blind, or reading a screenshot in grayscale
 * still gets the verdict.
 */
export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const variant = verdict.level === 'critical' ? 'destructive'
    : verdict.level === 'warn' ? 'secondary'
    : 'outline';
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant={variant}>{LABEL[verdict.level]}</Badge>
      {verdict.note ? <span className="text-sm text-muted-foreground">{verdict.note}</span> : null}
    </span>
  );
}
