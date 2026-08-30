import { CHECKS, type Waiter } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { Sql } from '@/components/sql';
import { formatDuration } from '@/lib/format';


/**
 * The graph is a tree, so it renders as nested lists rather than a flat table.
 * The flat table is what the old TUI's blocked panel showed, and it is exactly
 * what hid the amplifier in a migration pile-up: long read <- ACCESS EXCLUSIVE
 * <- readers renders as three unrelated rows unless the nesting is visible.
 *
 * `cycle` marks a back-edge to an ancestor — a deadlock in flight. It is
 * labelled rather than recursed into, or this function would not terminate.
 */
function WaiterTree({ waiters }: { waiters: Waiter[] }) {
  if (waiters.length === 0) return null;
  return (
    <ul className="ml-4 border-l pl-4 text-sm">
      {waiters.map((w) => (
        <li key={`${w.pid}-${w.cycle}`} className="py-1">
          <span className="font-mono">{w.pid}</span>{' '}
          <span className="text-muted-foreground">
            {w.user ?? '—'}@{w.app ?? '—'} · waiting {formatDuration(w.waitSecs)}
            {w.cycle ? ' · DEADLOCK (cycle back to an ancestor)' : ''}
          </span>
          <Sql>{w.query}</Sql>
          {w.cycle ? null : <WaiterTree waiters={w.waiters} />}
        </li>
      ))}
    </ul>
  );
}

export default async function Locks({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const result = await runCheckFor(name, CHECKS.locks);

  return (
    <CheckPanel title="Lock wait graph" result={result}>
      {(d) => (
        <>
          {d.truncated ? (
            <p className="mb-2 text-sm text-muted-foreground">
              Partial graph — more lock rows matched than were fetched.
            </p>
          ) : null}
          {d.roots.length === 0 ? (
            <p className="text-sm text-muted-foreground">No blocking.</p>
          ) : (
            <ul className="space-y-3">
              {d.roots.map((r) => (
                <li key={r.pid}>
                  <p>
                    <span className="font-mono font-medium">{r.pid}</span>{' '}
                    <span className="text-muted-foreground">
                      {r.user ?? '—'}@{r.app ?? '—'} · {r.state ?? '—'} · open {formatDuration(r.xactAgeSecs)} ·
                      blocking {r.totalWaiters}
                    </span>
                  </p>
                  <Sql>{r.query}</Sql>
                  <WaiterTree waiters={r.waiters} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </CheckPanel>
  );
}
