import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { Refresh } from '@/components/refresh';
import { SettingsDisclosure } from '@/components/status-bar';
import { formatBytes, formatCount, formatDuration } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Cleanup` };
}

/**
 * The tab behind the `keep-up` gate ("Replication & cleanup" in gates.ts).
 *
 * This page polls: its checks are incident-class and get worse while an
 * operator watches. test/guards.test.ts holds that.
 */
export default async function Cleanup({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const [wraparound, oldest, replication, standbys, slots, settings] = await Promise.all([
    runCheckFor(name, CHECKS.wraparound),
    runCheckFor(name, CHECKS.horizon),
    runCheckFor(name, CHECKS.replicationLag),
    // The primary's view of its standbys; replicationLag is this server's
    // view of itself.
    runCheckFor(name, CHECKS.standbys),
    runCheckFor(name, CHECKS.slots),
    // Fetched here, not in the layout: the layout re-renders on
    // router.refresh(), so a pg_settings read there would land behind the 5s
    // poll of every incident page. See SettingsDisclosure.
    runCheckFor(name, CHECKS.settings),
  ]);

  return (
    <div className="grid gap-4">
      <div className="flex justify-end"><Refresh intervalMs={5_000} /></div>
      <SettingsDisclosure result={settings} />

      <CheckPanel title="Wraparound" result={wraparound}>
        {(d) => {
          const worst = d.worst[0];
          if (!worst) return <p className="text-sm text-muted-foreground">No databases reporting.</p>;
          return (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>database</TableHead>
                  <TableHead className="text-right">txns left</TableHead>
                  <TableHead className="text-right">of horizon</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.worst.map((w) => (
                  <TableRow key={w.database}>
                    <TableCell className="font-medium">{w.database}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(w.txnsUntilShutdown)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {w.pctToForcedVacuum}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          );
        }}
      </CheckPanel>

      <CheckPanel title="Oldest snapshot" result={oldest}>
        {(d) => d.holders.length === 0
          ? <p className="text-sm text-muted-foreground">Nothing is holding a snapshot open. Vacuum can reclaim everything that is dead.</p>
          : (
            <>
            <Table>
              <TableHeader><TableRow>
                <TableHead>holder</TableHead><TableHead>kind</TableHead><TableHead>what</TableHead>
                <TableHead className="text-right">open for</TableHead><TableHead className="text-right">transactions ago</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {d.holders.map((h) => (
                  <TableRow key={`${h.kind}-${h.who}`}>
                    <TableCell className="font-mono">
                      {h.kind === 'backend'
                        ? <Link href={`/db/${name}#pid-${h.who}`} className="underline underline-offset-4">{h.who}</Link>
                        : h.who}
                    </TableCell>
                    <TableCell>{h.kind === 'prepared' ? 'prepared transaction' : h.kind}</TableCell>
                    <TableCell className="text-muted-foreground">{h.detail}</TableCell>
                    <TableCell className="text-right tabular-nums">{h.ageSecs === null ? '—' : formatDuration(h.ageSecs)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(h.xminAge)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {d.truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">Showing the ten furthest-back holders.</p>
            ) : null}
            </>
          )}
      </CheckPanel>

      <CheckPanel title="Role and lag" result={replication}>
        {(d) => (
          <p className="text-sm">
            {/*
              A null lag is never formatted as a duration: a primary has no
              lag to have, and a standby that has replayed nothing has one we
              cannot yet read.
            */}
            {/*
              `lagSeconds === 0` means everything received has been replayed,
              which is also what a dead walreceiver looks like. `receiving`
              is checked first: it decides whether the lag figure means
              anything.
            */}
            {d.inRecovery === null
              ? 'Role unknown.'
              : d.inRecovery
                ? d.receiving === false
                  ? 'This server is a standby · NOT RECEIVING — no walreceiver is running'
                  : d.lagSeconds === null
                    ? 'This server is a standby · nothing replayed yet'
                    : `This server is a standby · ${formatDuration(d.lagSeconds)} behind`
                : 'This server is a primary · replication lag does not apply'}
            {/*
              Rendered only when the Standbys panel below is unavailable.
              `standbys` requires pg_monitor and this check does not, so
              without that role this is the only standby count.
            */}
            {standbys.ok ? null : (
              <>
                {' · '}
                <span className="text-muted-foreground">
                  {d.standbys === null
                    ? 'standbys unknown'
                    : `${formatCount(d.standbys)} streaming`}
                </span>
              </>
            )}
          </p>
        )}
      </CheckPanel>

      {/*
        Its own panel, not a table under "Role and lag": merged, a failed
        read of one would look like a finding about the other.
      */}
      <CheckPanel title="Standbys" result={standbys}>
        {(d) => {
          if (d.standbys.length === 0) {
            return <p className="text-sm text-muted-foreground">No standbys are streaming from this server.</p>;
          }
          return (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>standby</TableHead>
                  <TableHead>client</TableHead>
                  <TableHead>state</TableHead>
                  <TableHead>sync</TableHead>
                  <TableHead>write</TableHead>
                  <TableHead>flush</TableHead>
                  <TableHead>replay</TableHead>
                  <TableHead>behind</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.standbys.map((sb) => (
                  <TableRow key={`${sb.app}-${sb.clientAddr ?? 'local'}`}>
                    <TableCell className="font-mono">{sb.app}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{sb.clientAddr ?? '—'}</TableCell>
                    <TableCell>{sb.state ?? '—'}</TableCell>
                    <TableCell>{sb.syncState ?? '—'}</TableCell>
                    {/*
                      Null lag is an em dash, never a zero: a role without
                      pg_monitor reads another user's walsender lag as NULL.
                    */}
                    <TableCell className="tabular-nums">{sb.writeSecs === null ? '—' : formatDuration(sb.writeSecs)}</TableCell>
                    <TableCell className="tabular-nums">{sb.flushSecs === null ? '—' : formatDuration(sb.flushSecs)}</TableCell>
                    <TableCell className="tabular-nums">{sb.replaySecs === null ? '—' : formatDuration(sb.replaySecs)}</TableCell>
                    <TableCell className="tabular-nums">{sb.replayBytes === null ? '—' : formatBytes(sb.replayBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          );
        }}
      </CheckPanel>

      <CheckPanel title="Replication slots" result={slots}>
        {(d) => {
          if (d.slots.length === 0) {
            return <p className="text-sm text-muted-foreground">None configured.</p>;
          }
          return (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>slot</TableHead>
                  <TableHead>state</TableHead>
                  <TableHead>type</TableHead>
                  <TableHead className="text-right">retained</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.slots.map((s) => (
                  <TableRow key={s.name}>
                    <TableCell className="font-mono font-medium">{s.name}</TableCell>
                    {/* INACTIVE is capitalised on purpose: an inactive slot
                        pins WAL indefinitely. */}
                    <TableCell>{s.active ? 'active' : 'INACTIVE'}</TableCell>
                    <TableCell>{s.slotType}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.retainedBytes === null
                        ? <span className="text-muted-foreground">—</span>
                        : formatBytes(s.retainedBytes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          );
        }}
      </CheckPanel>
    </div>
  );
}
