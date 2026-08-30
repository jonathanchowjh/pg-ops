import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { formatCount, formatDuration } from '@/lib/format';

export default async function Triage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  const [connections, sessionStates, blocked, longRunning, locks, wraparound, slots, queryStats] =
    await Promise.all([
      runCheckFor(name, CHECKS.connections),
      runCheckFor(name, CHECKS.sessionStates),
      runCheckFor(name, CHECKS.blocked),
      runCheckFor(name, CHECKS.longRunning, {}),
      runCheckFor(name, CHECKS.locks),
      runCheckFor(name, CHECKS.wraparound),
      runCheckFor(name, CHECKS.slots),
      runCheckFor(name, CHECKS.queryStats, { sort: 'total' }),
    ]);

  return (
    <div className="grid gap-4">
      <CheckPanel title="Connections" result={connections}>
        {(d) => <p>{formatCount(d.used)} / {formatCount(d.max)} used · {formatCount(d.headroom)} free</p>}
      </CheckPanel>

      {/*
        Plan defect (see task-8-report.md): the brief's Sessions panel read
        `d.states` with `{state, count, longestSecs}` per entry. The real
        `StatesData` shape (packages/checks/src/checks/sessions.ts) is
        `{ byState: {state, sessions, longestInStateSecs}[], oldestIdleInTxnSecs }`
        — corrected below to the compiler-verified field names.
      */}
      <CheckPanel title="Sessions" result={sessionStates}>
        {(d) => (
          <ul className="text-sm">
            {d.byState.map((s) => (
              <li key={s.state} className="flex justify-between">
                <span>{s.state}</span>
                <span>{formatCount(s.sessions)} · {formatDuration(s.longestInStateSecs)}</span>
              </li>
            ))}
          </ul>
        )}
      </CheckPanel>

      <CheckPanel title="Blocked" result={blocked}>
        {(d) =>
          d.count === 0
            ? <p className="text-sm text-muted-foreground">Nothing waiting on a lock.</p>
            : <p>{formatCount(d.count)} waiting · longest {formatDuration(d.longestQueryAgeSecs)} · suspect pid {d.suspectPid}</p>
        }
      </CheckPanel>

      <CheckPanel title="Long-running" result={longRunning}>
        {(d) =>
          d.queries.length === 0
            ? <p className="text-sm text-muted-foreground">No long-running queries.</p>
            : <ul className="text-sm">{d.queries.map((q) => (
                <li key={q.pid}>{q.pid} · {formatDuration(q.runningSecs)}</li>
              ))}</ul>
        }
      </CheckPanel>

      <CheckPanel title="Lock wait graph" result={locks}>
        {(d) =>
          d.roots.length === 0
            ? <p className="text-sm text-muted-foreground">No blocking.</p>
            : <p>{formatCount(d.roots.length)} root blocker(s)</p>
        }
      </CheckPanel>

      {/*
        Plan defect (see task-8-report.md): the brief's Wraparound panel read
        `d.pctToForcedVacuum` directly off `WraparoundData`. The real shape is
        `{ worst: WraparoundEntry[] }` — one entry per database, worst first —
        so `pctToForcedVacuum` lives on `d.worst[0]`, which can be absent (an
        empty `pg_database`, unreachable in practice but not unrepresentable).
      */}
      <CheckPanel title="Wraparound" result={wraparound}>
        {(d) => {
          const worst = d.worst[0];
          return worst
            ? <p>{worst.database}: {worst.pctToForcedVacuum}% of horizon · {formatCount(worst.txnsUntilShutdown)} txns left</p>
            : <p className="text-sm text-muted-foreground">No databases reporting.</p>;
        }}
      </CheckPanel>

      <CheckPanel title="Replication slots" result={slots}>
        {(d) => <p>{formatCount(d.slots.length)} slot(s)</p>}
      </CheckPanel>

      <CheckPanel title="Query statistics" result={queryStats}>
        {(d) => <p>{formatCount(d.totalShapes)} statement shape(s)</p>}
      </CheckPanel>
    </div>
  );
}
