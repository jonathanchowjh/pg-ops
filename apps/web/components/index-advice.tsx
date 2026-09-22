import type { IndexAdvice } from '@pgops/checks';
import { formatCount } from '@/lib/format';

/**
 * What pgops concluded about each sequential scan, shared by the explain page
 * and the suggestions page.
 *
 * A suggestion is shown as the statement to run, because that is the whole
 * remedy path: #62 `autoindex` is declined, and pgops never builds an index
 * itself. A scan with no suggestion shows WHY — "Stats not found" and "fewer
 * than 500 rows" are answers an operator can act on; a blank is not.
 */
export function IndexAdviceList({ advice }: { advice: readonly IndexAdvice[] }) {
  if (advice.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sequential scans — the planner found an index for every relation it reads.
      </p>
    );
  }
  return (
    <ul className="space-y-3 text-sm">
      {advice.map((a, i) => (
        <li key={`${a.schema}.${a.table}.${i}`} className="space-y-1">
          <p className="font-mono">{a.schema}.{a.table}</p>
          {a.found && a.suggestion && a.coveredBy === undefined ? (
            <>
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{a.suggestion.statement}</pre>
              {a.rowProgression ? (
                <p className="text-muted-foreground">
                  Rows: {a.rowProgression.map((n) => formatCount(n)).join(' → ')}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">{a.explanation ?? 'No suggestion.'}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
