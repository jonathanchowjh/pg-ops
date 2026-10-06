import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS, type Waiter } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { KillButton } from '@/components/kill-button';
import { Refresh } from '@/components/refresh';
import { Sql } from '@/components/sql';
import { actionsAllowed } from '@/lib/actions';
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
            {w.waitingMode ? ` · wants ${w.waitingMode}${w.waitingOn ? ` on ${w.waitingOn}` : ''}` : ''}
          </span>
          {/* AccessExclusiveLock specifically, not any strong mode: it is the one
              ALTER TABLE, DROP and TRUNCATE take, and the only one that queues plain
              SELECTs behind it — which is why the sentence can promise every reader
              is queued. `waitingMode` is a `string_agg(DISTINCT l.mode, ',' ORDER BY
              l.mode)` (locks.ts) over EVERY ungranted lock this session wants, so a
              waiter queued on two different modes at once arrives as
              'AccessExclusiveLock,RowExclusiveLock' — `=== 'AccessExclusiveLock'`
              missed exactly that case, the multi-lock migration pile-up this marker
              exists for. Split and test membership instead. Still not a substring
              test on the raw string: lock mode names are a fixed Postgres enum, and
              testing membership in the SPLIT list rather than `includes()` on the
              joined text is what still refuses a false positive on a future mode
              whose name happens to contain this one. */}
          {(w.waitingMode?.split(',') ?? []).includes('AccessExclusiveLock') ? (
            <span className="ml-1 font-medium text-warning-ink">· DDL — every reader behind it is queued too</span>
          ) : null}
          {w.cycle ? (
            <span className="ml-1 font-semibold text-destructive">
              · DEADLOCK (cycle back to an ancestor)
            </span>
          ) : null}
          <Sql>{w.query}</Sql>
          {w.cycle ? null : <WaiterTree waiters={w.waiters} />}
        </li>
      ))}
    </ul>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Locks` };
}

export default async function Locks({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const result = await runCheckFor(name, CHECKS.locks);
  // Read here, after runCheckFor has already awaited connection() — so this
  // page is dynamic before the gate is read, and the gate reflects the
  // deployment rather than being frozen at build time. Not hoisted to module
  // scope; see lib/check.ts and test/guards.test.ts.
  const canAct = actionsAllowed(process.env);

  return (
    <>
      {/* Task 1: the poll lives on the incident pages, not the layout —
          hygiene routes share that layout and must not inherit a 5s
          catalog scan. test/guards.test.ts holds this. */}
      <div className="mb-2 flex justify-end"><Refresh intervalMs={5_000} /></div>
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
                    <div className="relative pr-24">
                      <p>
                        <Link href={`/db/${name}/sessions#pid-${r.pid}`} className="font-mono font-medium underline underline-offset-4">
                          {r.pid}
                        </Link>
                        {' '}
                        <span className="text-muted-foreground">
                          {r.user ?? '—'}@{r.app ?? '—'} · {r.state ?? '—'} · open {formatDuration(r.xactAgeSecs)} ·
                          blocking {r.totalWaiters}
                        </span>
                      </p>
                      {/* The one pid this page tells the operator to end, and the control that
                          ends it. Waiters below get no button: killing one frees nothing. */}
                      {canAct ? (
                        <span className="absolute top-0 right-0">
                          <KillButton database={name} pid={r.pid} backendStart={r.backendStart} />
                        </span>
                      ) : null}
                    </div>
                    {/* `startsWith`, not equality: Postgres also reports
                        `idle in transaction (aborted)`, which has the same
                        consequence for the reader — the statement below already
                        finished, and the transaction is still holding its locks. */}
                    {r.state?.startsWith('idle in transaction') ? (
                      <p className="text-xs text-muted-foreground">last statement (transaction idle):</p>
                    ) : null}
                    <Sql>{r.query}</Sql>
                    <WaiterTree waiters={r.waiters} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CheckPanel>
    </>
  );
}
