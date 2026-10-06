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
 * The fourth tab, and the gate that had none.
 *
 * `gates.ts` titles the `keep-up` gate "Replication & cleanup" and states
 * that each gate title mirrors the tab going deeper into it. Three of four
 * tabs existed. This is a second surface over checks that already ship on the
 * triage page — exactly as `/sessions` already is for the `connect` gate —
 * and none of those checks is modified to land here.
 *
 * THIS PAGE POLLS, and it is the only page added in P2 that does. All three
 * checks below are `class: 'incident'`: a wraparound horizon and a stalled
 * replication slot both get worse while an operator watches. Its sub-routes
 * are the opposite — catalog scans that run on visit — which is why the poll
 * lives here and not in the layout the sub-routes share. test/guards.test.ts
 * holds both halves.
 */
export default async function Cleanup({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  // Promise.all, matching every other multi-check page: three sequential
  // awaits would be three snapshots taken at three different instants on a
  // page that re-reads all of them every five seconds.
  const [wraparound, oldest, replication, standbys, slots, settings] = await Promise.all([
    runCheckFor(name, CHECKS.wraparound),
    runCheckFor(name, CHECKS.horizon),
    runCheckFor(name, CHECKS.replicationLag),
    // B4: the primary's view of its standbys, beside the standby's view of
    // itself. Two different questions, which is why this is its own check
    // and not more columns on the one above.
    runCheckFor(name, CHECKS.standbys),
    runCheckFor(name, CHECKS.slots),
    // #56 is fetched HERE and not in the layout: the layout is shared by the
    // four incident pages and re-renders on router.refresh(), so a
    // pg_settings read there would land behind the 5s poll. See
    // SettingsDisclosure's docblock.
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
          // A TABLE, not a key-value list. Two numbers joined by a middle
          // dot in one right-aligned run cannot be compared down a column,
          // which is the only question this panel is asked: which database is
          // closest to the horizon. Same conversion as the Maintenance page.
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
                        ? <Link href={`/db/${name}/sessions#pid-${h.who}`} className="underline underline-offset-4">{h.who}</Link>
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
              pgHero answers 0 for a primary's replication lag, which on a
              dashboard reads as "perfectly caught up" — a claim about
              replication health made about a server that is not replicating.
              `null` here means the question does not apply, and it is never
              formatted as a duration. The two null cases are distinguished
              because they are different facts: a primary has no lag to have,
              a standby that has replayed nothing has one we cannot yet read.
            */}
            {/*
              B4: `lagSeconds === 0` means "I have replayed everything I
              RECEIVED", which is the right caught-up test for a healthy
              standby and is also exactly what a dead walreceiver looks
              like — nothing arriving, nothing left to replay. A standby
              that lost the primary hours ago read "0s behind". `receiving`
              is checked FIRST for that reason: it decides whether the lag
              figure beside it means anything at all.
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
              Stage 4's re-plan overlap. This clause and the Standbys panel
              directly below said one fact twice: "primary · 0 streaming"
              over "No standbys are streaming from this server."

              Not deleted, though — rendered only when the Standbys panel
              cannot speak. `standbys` declares
              `requires: [{ kind: 'role', name: 'pg_monitor' }]` and this
              check declares nothing, so on a role without pg_monitor that
              panel is UNAVAILABLE and this clause is the only reading of
              how many standbys are attached. The specialist owns the fact
              when it can report it; this fills in when it cannot.
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
        B4: its own panel rather than a table under "Role and lag", because
        the two answer different questions — that one is this server's view
        of itself, this one is its view of everything streaming from it —
        and folding them would make a failed read of one look like a
        finding about the other.
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
                      Every lag cell is an em dash when null, never a zero.
                      A role without pg_monitor reads another user's
                      walsender lag as NULL, and "0s" there would be a claim
                      about a standby nobody was able to look at.
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
                    {/* INACTIVE stays shouted. An inactive slot is the one
                        that pins WAL forever, and it is the whole reason this
                        panel exists. */}
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
