import type { Metadata } from 'next';
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
  const [wraparound, replication, slots, settings] = await Promise.all([
    runCheckFor(name, CHECKS.wraparound),
    runCheckFor(name, CHECKS.replicationLag),
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
            {d.inRecovery === null
              ? 'Role unknown.'
              : d.inRecovery
                ? d.lagSeconds === null
                  ? 'This server is a standby · nothing replayed yet'
                  : `This server is a standby · ${formatDuration(d.lagSeconds)} behind`
                : 'This server is a primary · replication lag does not apply'}
            {' · '}
            <span className="text-muted-foreground">
              {d.standbys === null
                ? 'standbys unknown'
                : `${formatCount(d.standbys)} streaming`}
            </span>
          </p>
        )}
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
