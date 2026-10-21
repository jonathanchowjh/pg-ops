import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CHECKS, type ConnectionDetailRow, type HealthMinute, type HorizonHolder, type Setting, type Slot, type Standby,
} from '@pgops/checks';
import { ConfirmAction, KillButton } from '@/components/actions';
import { CELL, List, NUM, Tag } from '@/components/catalog-rows';
import { Clock, LiveOnly, Time } from '@/components/clock';
import { NodeHead } from '@/components/node-head';
import { Panel } from '@/components/panel';
import { Refresh } from '@/components/refresh';
import { catalogFor } from '@/lib/catalog';
import { runCheckFor } from '@/lib/check';
import { MINUTE_MS, keepQuery, type Search } from '@/lib/clock';
import { actionsAllowed } from '@/lib/config';
import { formatBytes, formatCount, formatDuration } from '@/lib/format';
import { onColumns, perSecond } from '@/lib/plot';
import { clockFor, healthFor, liveMinute } from '@/lib/samples';
import { cn } from '@/lib/utils';

const SECTION = 'mt-5 mb-2 flex flex-wrap items-baseline gap-2.5 text-sm/5 font-semibold text-foreground';
const NOTE = 'text-xs font-normal text-muted-foreground';
/** A transaction open this long holds vacuum back on every table; "Terminate all" takes the ones past it. */
const LONG_SECS = 60;
/** Recent terminations listed at the foot. */
const TERMINATIONS_SHOWN = 10;

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Server` };
}

/** Who holds the connections: one row per application, its connections by state. */
interface Held { app: string; busy: number; idleInTxn: number; idle: number; unread: number }

function heldBy(rows: readonly ConnectionDetailRow[]): Held[] {
  const by = new Map<string, Held>();
  for (const r of rows) {
    // A background process has no database and no client; a client this role cannot read has a database and no state.
    if (r.database === null) continue;
    const app = r.source === null || r.source === '' ? '—' : r.source;
    let h = by.get(app);
    if (h === undefined) { h = { app, busy: 0, idleInTxn: 0, idle: 0, unread: 0 }; by.set(app, h); }
    if (r.state === null) h.unread += 1;
    else if (r.state === 'idle') h.idle += 1;
    else if (r.state.startsWith('idle in transaction')) h.idleInTxn += 1;
    else h.busy += 1;
  }
  const total = (h: Held): number => h.busy + h.idleInTxn + h.idle + h.unread;
  // The unnamed last among equals: a name is what the operator can act on.
  return [...by.values()].sort((a, b) => total(b) - total(a) || Number(a.app === '—') - Number(b.app === '—') || a.app.localeCompare(b.app));
}

/** The server's settings, with a timeout of 0 tagged "off": it is the one value an operator reads wrong. */
function SettingsList({ title, settings }: { title: string; settings: readonly Setting[] }) {
  return (
    <List head={[title, 'Value>']}>
      {settings.length === 0 ? <tr><td colSpan={2} className={cn(CELL, 'text-muted-foreground')}>none reported</td></tr> : settings.map((s) => (
        <tr key={s.name}>
          <td className={cn(CELL, 'font-mono text-foreground')}>{s.name}</td>
          {/* The tag before the value, in the same cell: a third column is the one a narrow list clips. */}
          <td className={NUM}>{s.name.endsWith('_timeout') && s.value === '0' ? <Tag>off</Tag> : null}{s.value}</td>
        </tr>
      ))}
    </List>
  );
}

/**
 * What the connection sees of the host, on the clock: connections against
 * the limit, replication lag, WAL, transactions and transaction ID age from
 * the health row's minutes, the live reads as the newest; then who holds
 * the connections, the transactions open longest with Terminate, the
 * settings the pages depend on, and the recent terminations.
 *
 * It polls: who holds the connections and what holds the horizon are live.
 * In a window in the past only the panels are drawn.
 */
export default async function ServerPage({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<Search> }) {
  const [{ name }, sp] = await Promise.all([params, searchParams]);
  const clock = await clockFor(name, sp, { sessions: false });
  const { grid } = clock;
  const live = grid.live;
  const canAct = live && actionsAllowed(process.env);
  const [health, catalog, activity, lag, xid, connections, horizon, detail, standbys, slots, settings] = await Promise.all([
    healthFor(name, grid),
    catalogFor(name),
    live ? runCheckFor(name, CHECKS.databaseActivity) : null,
    live ? runCheckFor(name, CHECKS.replicationLag) : null,
    live ? runCheckFor(name, CHECKS.wraparound) : null,
    live ? runCheckFor(name, CHECKS.connections) : null,
    live ? runCheckFor(name, CHECKS.horizon) : null,
    live ? runCheckFor(name, CHECKS.connectionDetail, {}) : null,
    live ? runCheckFor(name, CHECKS.standbys) : null,
    live ? runCheckFor(name, CHECKS.slots) : null,
    live ? runCheckFor(name, CHECKS.settings) : null,
  ]);

  // The live reads are the newest minute, drawn in the last column: so a console with no store still draws the moment.
  const now = live ? liveMinute(grid.to - 1, lag, xid, connections) : null;
  const minutes: HealthMinute[] = [...(health.ok ? health.value : []), ...(now === null ? [] : [now])];
  const level = (pick: (m: HealthMinute) => number | null): (number | null)[] => {
    const cols = onColumns(grid, minutes.flatMap((m) => { const v = pick(m); return v === null ? [] : [{ at: m.at, value: v }]; }), MINUTE_MS);
    const last = now === null ? null : pick(now);
    if (last !== null) cols[grid.columns - 1] = last;
    return cols;
  };
  const rate = (pick: (m: HealthMinute) => number | null, guarded: boolean): (number | null)[] =>
    onColumns(grid, perSecond(minutes, pick, guarded ? (m) => m.statsReset : undefined), MINUTE_MS);
  const lagKnown = minutes.some((m) => m.lagSecs !== null || m.lagBytes !== null);
  const freeze = catalog.freezeMaxAge;

  const api = (route: string): string => `/api/db/${encodeURIComponent(name)}/${route}`;
  const resetQueryStats = api('reset-query-stats');
  // The newest minute that measured it: the size is the health row's, not the poll's.
  const size = (health.ok ? health.value : []).findLast((m) => m.sizeBytes !== null)?.sizeBytes ?? null;
  const statsSince = activity?.ok && activity.data.statsResetAt !== null ? Date.parse(activity.data.statsResetAt) : null;
  const holders: HorizonHolder[] = horizon?.ok ? horizon.data.holders : [];
  // A waiter holds the horizon only because its blocker does: ending it frees nothing, so it is never offered.
  const endable = (h: HorizonHolder): boolean => h.kind === 'backend' && h.backendStart !== null && !h.waiting;
  const long = holders.filter((h) => endable(h) && (h.ageSecs ?? 0) > LONG_SECS);
  const held = detail?.ok ? heldBy(detail.data.connections) : [];
  const heldMax = Math.max(1, ...held.map((h) => h.busy + h.idleInTxn + h.idle + h.unread));
  const terminations = clock.events.filter((e) => e.kind === 'terminate').sort((a, b) => b.at - a.at).slice(0, TERMINATIONS_SHOWN);
  const standbyRows: Standby[] = standbys?.ok ? standbys.data.standbys : [];
  const slotRows: Slot[] = slots?.ok ? slots.data.slots : [];
  const failed = (r: { ok: boolean; message?: string } | null, what: string): string | null =>
    (r === null || r.ok ? null : `${what} could not be read: ${r.message}`);

  return (
    <>
      <NodeHead title="Server" crumb={[{ label: name, href: `/db/${name}` }]}>
        {size === null ? null : <span className="font-mono text-xs text-body tabular-nums">{formatBytes(size)} on disk</span>}
        {statsSince === null ? null : <span className="font-mono text-xs text-body tabular-nums">statistics since <Time at={statsSince} /></span>}
        {/* The server's, not a moment's: offered on a live window, pinned or not, as Analyze is on a table. */}
        {canAct ? (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <ConfirmAction
              label="Reset statistics" endpoint={api('reset-stats')} confirmWith={name}
              danger="Clears every table, index and function counter of this database. The captured intervals that span it are dropped."
            />
            <ConfirmAction
              label="Reset query statistics" endpoint={resetQueryStats} confirmWith={name}
              danger="Clears pg_stat_statements for this database. Every statement's calls, time and rows start again from zero."
            />
          </span>
        ) : null}
      </NodeHead>
      <Clock grid={grid} now={clock.now} day={clock.day} events={clock.events} keep={keepQuery('', null)} initialCursor={clock.pinAt}>
        {live ? <div className="flex justify-end pt-1.5"><Refresh intervalMs={5_000} /></div> : null}
        {health.ok ? null : (
          <p className="mb-2 text-xs text-muted-foreground">
            {health.kind === 'off' ? 'No store is configured, so the server’s minutes are not kept: the panels show this moment.' : `The store could not be read: ${health.message}`}
          </p>
        )}
        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Panel
            title="Connections" note="against the limit" unit="count" kind="line"
            series={[{ name: 'Server', tone: 0, values: level((m) => m.serverConnections) }, { name: 'This database', tone: 1, values: level((m) => m.connections) }]}
            limit={{ name: 'max_connections', values: level((m) => m.maxConnections) }}
          />
          <Panel
            title="Transaction ID age" note="against the freeze age" unit="compact" kind="line"
            series={[{ name: 'Oldest in the database', tone: 0, values: level((m) => m.xidAge) }, { name: 'Oldest snapshot', tone: 1, values: level((m) => m.xminAge) }]}
            limit={freeze === null ? undefined : { name: 'autovacuum_freeze_max_age', values: Array.from({ length: grid.columns }, () => freeze) }}
          />
          {lagKnown ? (
            <>
              <Panel title="Replication lag" note="behind the primary" unit="secs" kind="line" series={[{ name: 'Lag', tone: 0, values: level((m) => m.lagSecs) }]} />
              <Panel title="Still to replay" note="behind the primary" unit="bytes" kind="line" series={[{ name: 'To replay', tone: 0, values: level((m) => m.lagBytes) }]} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground md:col-span-2">
              No replication lag in this window: no standby streams from this server, or this role cannot read them.
            </p>
          )}
          <Panel title="WAL" note="written a second" unit="bytesPerSec" kind="stack" series={[{ name: 'WAL', tone: 0, values: rate((m) => m.walBytes, false) }]} />
          <Panel
            title="Transactions" note="a second" unit="perSec" kind="stack"
            series={[{ name: 'Commits', tone: 0, values: rate((m) => m.commits, true) }, { name: 'Rollbacks', tone: 2, values: rate((m) => m.rollbacks, true) }]}
          />
        </div>

        {!live ? null : (
          <>
            <h2 className={SECTION}>Who holds the connections<small className={NOTE}>by application, at this moment</small></h2>
            {failed(detail, 'The connections') !== null ? <p className="text-muted-foreground">{failed(detail, 'The connections')}</p> : (
              <>
                <p className="mb-1.5 flex flex-wrap gap-3 text-xs/[18px] text-muted-foreground">
                  <span><i aria-hidden className="mr-1.5 inline-block size-2 rounded-xs bg-foreground/75 align-middle" />Not idle</span>
                  <span><i aria-hidden className="mr-1.5 inline-block size-2 rounded-xs bg-class-idle align-middle" />Idle in transaction</span>
                  <span><i aria-hidden className="mr-1.5 inline-block size-2 rounded-xs bg-foreground/22 align-middle" />Idle</span>
                  {held.some((h) => h.unread > 0) ? <span><i aria-hidden className="mr-1.5 inline-block size-2 rounded-xs border align-middle" />Unreadable by this role</span> : null}
                  {detail?.ok && detail.data.truncated ? <span className="ml-auto">the first {formatCount(detail.data.connections.length)} of {formatCount(detail.data.total)}</span> : null}
                </p>
                <List head={['Application', '', 'Connections>']}>
                  {held.map((h) => {
                    const total = h.busy + h.idleInTxn + h.idle + h.unread;
                    return (
                      <tr key={h.app}>
                        <td className={cn(CELL, 'font-mono text-foreground')}>{h.app}</td>
                        <td className={cn(CELL, 'w-3/5')}>
                          <div data-bar className="flex h-2.5 min-w-[120px] overflow-hidden rounded-xs" style={{ width: `${(100 * total) / heldMax}%` }}>
                            <i className="bg-foreground/75" style={{ flex: h.busy }} />
                            <i className="bg-class-idle" style={{ flex: h.idleInTxn }} />
                            <i className="bg-foreground/22" style={{ flex: h.idle }} />
                            <i className="border bg-muted" style={{ flex: h.unread }} />
                          </div>
                        </td>
                        <td className={NUM}>{formatCount(total)}</td>
                      </tr>
                    );
                  })}
                </List>
              </>
            )}

            <h2 className={SECTION}>
              Transactions open longest<small className={NOTE}>what holds vacuum back on every table</small>
              {canAct && long.length > 0 ? (
                <span className="ml-auto">
                  <LiveOnly>
                    <ConfirmAction
                      label={`Terminate all over ${LONG_SECS} s`} endpoint={api('kill-long-running')} confirmWith={name} describe="kill-batch"
                      body={{ targets: long.map((h) => ({ pid: Number(h.who), backendStart: h.backendStart })) }}
                      danger={`Ends ${long.length === 1 ? 'the one session' : `${long.length} sessions`} with a transaction open over ${LONG_SECS} s. Each is checked to be the same session before it is ended.`}
                    />
                  </LiveOnly>
                </span>
              ) : null}
            </h2>
            {failed(horizon, 'The holders') !== null ? <p className="text-muted-foreground">{failed(horizon, 'The holders')}</p>
              : holders.length === 0 ? <p className="text-muted-foreground">Nothing holds a snapshot open: vacuum can reclaim everything that is dead.</p> : (
                // Terminate first: on a phone the table scrolls, and the action must not be what is scrolled off.
                <List head={['', 'Holder', '', 'Open for>', 'Transactions ago>']}>
                  {holders.map((h) => (
                    <tr key={`${h.kind}/${h.who}`}>
                      <td className={CELL}>
                        {canAct && endable(h)
                          ? <LiveOnly><KillButton database={name} pid={Number(h.who)} backendStart={h.backendStart} /></LiveOnly>
                          : null}
                      </td>
                      <td className={cn(CELL, 'font-mono text-foreground')}>
                        {h.kind === 'backend' ? <Link href={`/db/${name}#pid-${h.who}`} className="hover:underline">{h.who}</Link> : h.who}
                      </td>
                      <td className={cn(CELL, 'text-muted-foreground')}>
                        {h.kind === 'backend' ? h.detail : `${h.kind === 'prepared' ? 'prepared transaction' : 'slot'} · ${h.detail}`}
                        {h.waiting ? <span className="ml-2"><Tag>waiting on a lock</Tag></span> : null}
                      </td>
                      <td className={NUM}>{h.ageSecs === null ? '—' : formatDuration(h.ageSecs)}</td>
                      <td className={NUM}>{formatCount(h.xminAge)}</td>
                    </tr>
                  ))}
                </List>
              )}
            {horizon?.ok && horizon.data.truncated ? <p className="mt-1 text-xs text-muted-foreground">The ten furthest back.</p> : null}

            <h2 className={SECTION}>
              Replication
              <small className={NOTE}>
                {lag?.ok && lag.data.inRecovery === true
                  ? (lag.data.receiving === false ? 'this server is a standby and is NOT RECEIVING'
                    : lag.data.lagSeconds === null ? 'this server is a standby that has replayed nothing yet'
                      : `this server is a standby ${formatDuration(lag.data.lagSeconds)} behind`)
                  : 'the standbys streaming from this server, and its slots'}
              </small>
            </h2>
            {failed(standbys, 'The standbys') !== null ? <p className="text-muted-foreground">{failed(standbys, 'The standbys')}</p>
              : standbyRows.length === 0 ? <p className="text-muted-foreground">No standby streams from this server.</p> : (
                <List head={['Standby', 'State', 'Sync', 'Behind>', 'To replay>']}>
                  {standbyRows.map((s) => (
                    <tr key={`${s.app}/${s.clientAddr ?? 'local'}`}>
                      <td className={cn(CELL, 'font-mono text-foreground')}>{s.app}<span className="ml-2 text-muted-foreground">{s.clientAddr ?? ''}</span></td>
                      <td className={CELL}>{s.state ?? '—'}</td>
                      <td className={CELL}>{s.syncState ?? '—'}</td>
                      {/* Null is a stage this role cannot read, never caught up. */}
                      <td className={NUM}>{s.replaySecs === null ? '—' : formatDuration(s.replaySecs)}</td>
                      <td className={NUM}>{s.replayBytes === null ? '—' : formatBytes(s.replayBytes)}</td>
                    </tr>
                  ))}
                </List>
              )}
            {failed(slots, 'The slots') !== null ? <p className="mt-2 text-muted-foreground">{failed(slots, 'The slots')}</p>
              : slotRows.length === 0 ? null : (
                <div className="mt-2">
                  <List head={['Slot', 'State', 'Type', 'Retained>']}>
                    {slotRows.map((s) => (
                      <tr key={s.name}>
                        <td className={cn(CELL, 'font-mono text-foreground')}>{s.name}</td>
                        {/* An inactive slot pins WAL without end. */}
                        <td className={CELL}>{s.active ? 'active' : <Tag>inactive</Tag>}</td>
                        <td className={CELL}>{s.slotType}</td>
                        <td className={NUM}>{s.retainedBytes === null ? '—' : formatBytes(s.retainedBytes)}</td>
                      </tr>
                    ))}
                  </List>
                </div>
              )}

            <h2 className={SECTION}>Settings<small className={NOTE}>the ones the pages depend on</small></h2>
            {failed(settings, 'The settings') !== null ? <p className="text-muted-foreground">{failed(settings, 'The settings')}</p> : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <SettingsList title="Server" settings={settings?.ok ? settings.data.main : []} />
                <SettingsList title="Autovacuum" settings={settings?.ok ? settings.data.autovacuum : []} />
                <SettingsList title="Vacuum" settings={settings?.ok ? settings.data.vacuum : []} />
              </div>
            )}
          </>
        )}

        <h2 className={SECTION}>Recent terminations<small className={NOTE}>by pgops, in the last 24 hours, newest first</small></h2>
        {terminations.length === 0 ? <p className="text-muted-foreground">None.</p> : (
          <List head={['When', 'Where']}>
            {terminations.map((e) => (
              <tr key={`${e.at}/${e.relation}`}>
                <td className={CELL}><Time at={e.at} /></td>
                <td className={cn(CELL, 'font-mono text-foreground')}>{e.relation === '' ? <span className="font-sans text-muted-foreground">the database</span> : e.relation}</td>
              </tr>
            ))}
          </List>
        )}
      </Clock>
    </>
  );
}
