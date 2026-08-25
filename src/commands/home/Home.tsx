import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { fitToWidth, formatDuration, truncateQuery } from '../../core/format.js';
import { theme } from '../../core/theme.js';
import {
  budgetHome,
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
 * Never assume a glyph is one column. `stringWidth('⚠')` is **2** while
 * `stringWidth('✓')` is 1, so a line budgeted with a hardcoded 1 is a column
 * short exactly when the verdict is a warning — which is exactly when the note
 * beside it is longest. That one column wrapped the HEALTH card onto a row
 * `budgetHome` had not paid for. The same mis-measurement cost a truncated pid
 * in the locks view earlier on this branch; measure, do not assume.
 */
function markWidth(v: Verdict): number {
  return stringWidth(mark(v));
}

/**
 * One panel's header: focus marker, name, verdict glyph + note. The header
 * carries the verdict so a glance down the left edge of the screen is the
 * triage — the body is the supporting detail.
 */
function PanelHeader({
  name,
  focused,
  verdict,
  width,
}: {
  name: string;
  focused: boolean;
  verdict?: Verdict;
  width: number;
}) {
  // `'▸ '` + name + ' ' + glyph + ' ' before the note.
  const room = width - (2 + stringWidth(name) + 2 + (verdict ? markWidth(verdict) : 0));
  const note = verdict?.note ? fitToWidth(verdict.note, Math.max(1, room)) : '';
  return (
    <Text inverse={focused} bold>
      {focused ? '▸ ' : '  '}
      {name}
      {verdict ? (
        <Text color={verdictColor(verdict)}>
          {' '}
          {mark(verdict)}
          {note ? ` ${note}` : ''}
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
function PanelError({ error, width }: { error: string; width: number }) {
  // `    n/a (` + `)` is 10 columns.
  return <Text color={theme.warning}>{'    '}n/a ({truncateQuery(error, Math.max(1, width - 10))})</Text>;
}

/** Render a panel body, or its `n/a (error)` line when the panel failed. */
function PanelBody<T>({
  panel,
  width,
  children,
}: {
  panel: PanelResult<T>;
  width: number;
  children: (data: T) => JSX.Element;
}) {
  return panel.ok ? children(panel.data) : <PanelError error={panel.error} width={width} />;
}

export interface HomeProps {
  data: TriageData;
  focusedPanel: number;
  /**
   * Lines this panel stack may occupy. Unlike the list views there is no
   * `Table` here to clip anything, so `Home` has to spend its own budget — see
   * `budgetHome`. Optional, and uncapped when omitted: the container supplies
   * the real number, and a second default here is what made two views diverge
   * once already (`TableProps`).
   */
  maxLines?: number;
  /**
   * Total display columns. `budgetHome` counts ELEMENTS, and that is only the
   * same as counting terminal rows while no element is wider than the screen —
   * so every line here is truncated to this width. Two of them used to exceed
   * 80: a LONG-RUNNING row is `4 + 7 + 9 + 1 + query`, which at the old flat
   * `truncateQuery(q, 60)` came to 81 columns, and a HEALTH verdict carrying a
   * real note reached 86. Each wrapped into a second row that the budget had
   * not paid for, and three wrapped rows is the difference between 23 lines
   * and Ink clearing the terminal.
   *
   * Defaults to the 80-column floor rather than to the terminal: `Home` must
   * never read the terminal itself (`TableProps` documents the one-default
   * rule), and 80 is the width every pgops screen is required to survive.
   */
  width?: number;
}

const FLOOR_COLUMNS = 80;

export function Home({ data, focusedPanel, maxLines, width = FLOOR_COLUMNS }: HomeProps) {
  const states = data.sessions.ok ? data.sessions.data.byState.length : 1;
  const longRunning = data.longRunning.ok ? data.longRunning.data.length : 1;
  const budget = budgetHome({ maxLines: maxLines ?? Number.MAX_SAFE_INTEGER, states, longRunning });
  return (
    <Box flexDirection="column" paddingY={0}>
      {/* 0 — SESSIONS: state census; idle-in-transaction is the #1 preventable cause. */}
      <Box flexDirection="column" marginBottom={budget.spacing}>
        <PanelHeader
          name="SESSIONS"
          focused={focusedPanel === 0}
          verdict={data.sessions.ok ? verdictSessions(data.sessions.data) : undefined}
          width={width}
        />
        <PanelBody panel={data.sessions} width={width}>
          {(s) =>
            s.byState.length === 0 ? (
              <Text color={theme.dim}>{'    '}no client sessions</Text>
            ) : (
              <Box flexDirection="column">
                {s.byState.slice(0, budget.stateRows).map((r) => (
                  <Text key={r.state}>
                    {'    '}
                    <Text color={r.state.startsWith('idle in transaction') ? theme.critical : theme.dim}>
                      {fitToWidth(r.state, 30).padEnd(30)}
                    </Text>
                    <Text color={theme.fg}>{String(r.sessions).padStart(4)}</Text>
                    <Text color={theme.dim}>{formatDuration(r.longestInStateSecs).padStart(10)}</Text>
                  </Text>
                ))}
                {/* Never drop a row silently — same rule `Table` follows for
                    columns it could not fit. */}
                {budget.hiddenStates > 0 ? (
                  <Text color={theme.dim}>
                    {'    '}+{budget.hiddenStates} more
                  </Text>
                ) : null}
              </Box>
            )
          }
        </PanelBody>
      </Box>

      {/* 1 — BLOCKED: the fast yes/no on lock contention; Enter opens the wait graph. */}
      <Box flexDirection="column" marginBottom={budget.spacing}>
        <PanelHeader
          name="BLOCKED"
          focused={focusedPanel === 1}
          verdict={data.blocked.ok ? verdictBlocked(data.blocked.data) : undefined}
          width={width}
        />
        <PanelBody panel={data.blocked} width={width}>
          {(b) => (
            <Text color={theme.dim}>
              {'    '}
              {fitToWidth(
                b.blockedCount === 0
                  ? 'nothing blocked'
                  : `${b.blockedCount} waiting · longest ${formatDuration(b.longestWaitSecs)}${
                      b.suspectPid == null ? '' : ` · suspect pid ${b.suspectPid}`
                    }`,
                Math.max(1, width - 4),
              )}
            </Text>
          )}
        </PanelBody>
      </Box>

      {/* 2 — LONG-RUNNING: the three longest active queries right now. */}
      <Box flexDirection="column" marginBottom={budget.spacing}>
        <PanelHeader
          name="LONG-RUNNING"
          focused={focusedPanel === 2}
          verdict={data.longRunning.ok ? verdictLongRunning(data.longRunning.data) : undefined}
          width={width}
        />
        <PanelBody panel={data.longRunning} width={width}>
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
                    <Text color={theme.dim}>{truncateQuery(r.query, Math.max(1, width - 21))}</Text>
                  </Text>
                ))}
              </Box>
            )
          }
        </PanelBody>
      </Box>

      {/* 3 — CONNECTIONS: headroom before "too many connections". */}
      <Box flexDirection="column" marginBottom={budget.spacing}>
        <PanelHeader
          name="CONNECTIONS"
          focused={focusedPanel === 3}
          verdict={data.connections.ok ? verdictConnections(data.connections.data) : undefined}
          width={width}
        />
        <PanelBody panel={data.connections} width={width}>
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
        <PanelHeader name="HEALTH" focused={false} width={width} />
        <HealthLine label="wraparound" panel={data.wraparound} verdict={verdictWraparound} value={(c) => `${c.pctOfHorizon}% of horizon`} width={width} />
        <HealthLine
          label="slots"
          panel={data.slots}
          verdict={verdictSlots}
          value={(c) => `${c.inactiveCount} inactive`}
          width={width}
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
  width,
}: {
  label: string;
  panel: PanelResult<T>;
  verdict: (data: T) => Verdict;
  value: (data: T) => string;
  width: number;
}) {
  if (!panel.ok) {
    // `    ` + label + ` n/a (` + `)`.
    const room = width - (4 + stringWidth(label) + 7);
    return (
      <Text color={theme.warning}>
        {'    '}
        {label} n/a ({truncateQuery(panel.error, Math.max(1, room))})
      </Text>
    );
  }
  const v = verdict(panel.data);
  const head = `${label} ${value(panel.data)}`;
  // `    ` + glyph + ` ` + head, then ` — ` before the note. The note is the
  // only unbounded part: `verdictSlots` names the slot and points at a
  // playbook file, which reached 86 columns at the 80-column floor and wrapped
  // the HEALTH card onto a line `budgetHome` had not paid for.
  const room = width - (4 + markWidth(v) + 1 + stringWidth(head) + 3);
  const note = v.note ? fitToWidth(v.note, Math.max(1, room)) : '';
  return (
    <Text>
      {'    '}
      <Text color={verdictColor(v)}>{mark(v)}</Text> <Text color={theme.dim}>{head}</Text>
      {note ? <Text color={verdictColor(v)}> — {note}</Text> : null}
    </Text>
  );
}
