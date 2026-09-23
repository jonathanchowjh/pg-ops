import Link from 'next/link';
import type { Fold } from '@/lib/fold';
import { formatCount } from '@/lib/format';

/**
 * What the fold hid, and the link that shows it.
 *
 * ALWAYS RENDERED WHEN THERE IS ANYTHING TO SAY, including when the rows are
 * already shown — the operator who clicked "show" needs the way back, and
 * needs to know which of the rows in front of them are the console's own.
 *
 * The wording is the count and whose they are, not an instruction. "3 of
 * these are pgops's own" is a fact about the list above it; "hiding 3 rows"
 * would be a fact about this component.
 */
export function FoldNote({ mine, fold }: { mine: number; fold: Fold }) {
  if (mine === 0) return null;
  const n = formatCount(mine);
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      {fold.show
        ? `${n} of these ${mine === 1 ? 'is' : 'are'} pgops's own. `
        : `${n} more ${mine === 1 ? 'is' : 'are'} pgops's own, hidden. `}
      <Link href={fold.href} className="underline underline-offset-4">
        {fold.show ? 'hide them' : 'show them'}
      </Link>
    </p>
  );
}
