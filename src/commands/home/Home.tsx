import { Box, Text } from 'ink';
import { formatDuration, truncateQuery } from '../../core/format.js';
import { theme } from '../../core/theme.js';
import {
  verdictBlocked,
  verdictConnections,
  verdictLongRunning,
  verdictSessions,
  verdictSlots,
  verdictWraparound,
  type Verdict,
} from './model.js';
import type { PanelResult, TriageData } from './query.js';

/**
 * The triage cockpit (plan §M2) — one screen answering the questions a DBA runs
 * from memory in the first five minutes: who's connected and in what state, is
 * anything blocked, what's running long, are we near the connection cap, plus
 * two one-line health verdicts.
 *
 * Presentation only: `Home` is a pure function of one poll's `TriageData` and
 * the focused panel index. Every panel is a door — `Enter` drills into the view
 * that can actually fix that problem (see `PANEL_DRILLS`).
 */

export type DrillTarget =
  | { view: 'sessions'; sort?: 'triage' | 'active' }
  | { view: 'locks' }
  | { view: 'top' };

/**
 * Index-aligned with the panel focus order below. Each panel points at the view
 * that can act on it: BLOCKED → the lock chain (kill the root blocker),
 * LONG-RUNNING → sessions sorted by active runtime, SESSIONS/CONNECTIONS →
 * sessions in triage order (idle-in-transaction first — the usual culprit).
 */
export const PANEL_DRILLS: DrillTarget[] = [
  { view: 'sessions', sort: 'triage' },
  { view: 'locks' },
  { view: 'sessions', sort: 'active' },
  { view: 'sessions', sort: 'triage' },
];

export const PANEL_COUNT = PANEL_DRILLS.length;

/** ok is deliberately dim: only a problem should draw the eye during an incident. */
function verdictColor(v: Verdict): string {
  if (v.level === 'critical') return theme.critical;
  if (v.level === 'warn') return theme.warning;
  return theme.dim;
}

function mark(v: Verdict): string {
  return v.level === 'ok' ? '✓' : '⚠';
}

/**
 * One panel's header: focus marker, name, verdict glyph + note. The header
 * carries the verdict so a glance down the left edge of the screen is the
 * triage — the body is the supporting detail.
 */
function PanelHeader({ name, focused, verdict }: { name: string; focused: boolean; verdict?: Verdict }) {
  return (
    <Text inverse={focused} bold>
      {focused ? '▸ ' : '  '}
      {name}
      {verdict ? (
        <Text color={verdictColor(verdict)}>
          {' '}
          {mark(verdict)}
          {verdict.note ? ` ${verdict.note}` : ''}
        </Text>
      ) : null}
    </Text>
  );
}

/**
 * A panel whose query failed (e.g. no privilege for pg_replication_slots on a
 * managed Postgres). Renders `n/a (error)` in place of the body — the cockpit
 * never blanks because one panel is unavailable (spec §5, per-panel isolation).
 */
function PanelError({ error }: { error: string }) {
  return <Text color={theme.warning}>{'    '}n/a ({truncateQuery(error, 60)})</Text>;
}

/** Render a panel body, or its `n/a (error)` line when the panel failed. */
function PanelBody<T>({ panel, children }: { panel: PanelResult<T>; children: (data: T) => JSX.Element }) {
  return panel.ok ? children(panel.data) : <PanelError error={panel.error} />;
}

export interface HomeProps {
  data: TriageData;
  focusedPanel: number;
}

export function Home({ data, focusedPanel }: HomeProps) {
  return (
    <Box flexDirection="column" paddingY={0}>
      {/* 0 — SESSIONS: state census; idle-in-transaction is the #1 preventable cause. */}
      <Box flexDirection="column" marginBottom={1}>
        <PanelHeader
          name="SESSIONS"
          focused={focusedPanel === 0}
          verdict={data.sessions.ok ? verdictSessions(data.sessions.data) : undefined}
        />
        <PanelBody panel={data.sessions}>
          {(s) =>
            s.byState.length === 0 ? (
              <Text color={theme.dim}>{'    '}no client sessions</Text>
            ) : (
              <Box flexDirection="column">
                {s.byState.map((r) => (
                  <Text key={r.state}>
                    {'    '}
                    <Text color={r.state.startsWith('idle in transaction') ? theme.critical : theme.dim}>
                      {r.state.padEnd(30)}
                    </Text>
                    <Text color={theme.fg}>{String(r.sessions).padStart(4)}</Text>
                    <Text color={theme.dim}>{formatDuration(r.longestInStateSecs).padStart(10)}</Text>
                  </Text>
                ))}
              </Box>
            )
          }
        </PanelBody>
      </Box>

      {/* 1 — BLOCKED: the fast yes/no on lock contention; Enter opens the wait graph. */}
      <Box flexDirection="column" marginBottom={1}>
        <PanelHeader
          name="BLOCKED"
          focused={focusedPanel === 1}
          verdict={data.blocked.ok ? verdictBlocked(data.blocked.data) : undefined}
        />
        <PanelBody panel={data.blocked}>
          {(b) => (
            <Text color={theme.dim}>
              {'    '}
              {b.blockedCount === 0
                ? 'nothing blocked'
                : `${b.blockedCount} waiting · longest ${formatDuration(b.longestWaitSecs)}${
                    b.suspectPid == null ? '' : ` · suspect pid ${b.suspectPid}`
                  }`}
            </Text>
          )}
        </PanelBody>
      </Box>

      {/* 2 — LONG-RUNNING: the three longest active queries right now. */}
      <Box flexDirection="column" marginBottom={1}>
        <PanelHeader
          name="LONG-RUNNING"
          focused={focusedPanel === 2}
          verdict={data.longRunning.ok ? verdictLongRunning(data.longRunning.data) : undefined}
        />
        <PanelBody panel={data.longRunning}>
          {(rows) =>
            rows.length === 0 ? (
              <Text color={theme.dim}>{'    '}nothing running longer than 5s</Text>
            ) : (
              <Box flexDirection="column">
                {rows.map((r) => (
                  <Text key={r.pid}>
                    {'    '}
                    <Text color={theme.info}>{String(r.pid).padStart(7)}</Text>
                    <Text>{formatDuration(r.runningSecs).padStart(9)}</Text>{' '}
                    <Text color={theme.dim}>{truncateQuery(r.query, 60)}</Text>
                  </Text>
                ))}
              </Box>
            )
          }
        </PanelBody>
      </Box>

      {/* 3 — CONNECTIONS: headroom before "too many connections". */}
      <Box flexDirection="column" marginBottom={1}>
        <PanelHeader
          name="CONNECTIONS"
          focused={focusedPanel === 3}
          verdict={data.connections.ok ? verdictConnections(data.connections.data) : undefined}
        />
        <PanelBody panel={data.connections}>
          {(c) => (
            <Text color={theme.dim}>
              {'    '}
              {c.used} / {c.max} used · {c.headroom} free
            </Text>
          )}
        </PanelBody>
      </Box>

      {/* HEALTH: one-line verdicts, not drillable in v0.1 — a warning names the
          object and points at the playbook file that fixes it. */}
      <Box flexDirection="column">
        <PanelHeader name="HEALTH" focused={false} />
        <HealthLine label="wraparound" panel={data.wraparound} verdict={verdictWraparound} value={(c) => `${c.pctOfHorizon}% of horizon`} />
        <HealthLine
          label="slots"
          panel={data.slots}
          verdict={verdictSlots}
          value={(c) => `${c.inactiveCount} inactive`}
        />
      </Box>
    </Box>
  );
}

/** One HEALTH card: `✓ wraparound 34% of horizon`, or `slots n/a (…)` when denied. */
function HealthLine<T>({
  label,
  panel,
  verdict,
  value,
}: {
  label: string;
  panel: PanelResult<T>;
  verdict: (data: T) => Verdict;
  value: (data: T) => string;
}) {
  if (!panel.ok) {
    return (
      <Text color={theme.warning}>
        {'    '}
        {label} n/a ({truncateQuery(panel.error, 60)})
      </Text>
    );
  }
  const v = verdict(panel.data);
  return (
    <Text>
      {'    '}
      <Text color={verdictColor(v)}>{mark(v)}</Text> <Text color={theme.dim}>{label} {value(panel.data)}</Text>
      {v.note ? <Text color={verdictColor(v)}> — {v.note}</Text> : null}
    </Text>
  );
}
