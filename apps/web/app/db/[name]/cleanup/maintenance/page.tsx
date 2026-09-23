import type { Metadata } from 'next';
import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { cacheChecks } from '@/lib/hygiene';
import { CheckPanel } from '@/components/check-panel';
import { Findings } from '@/components/findings';
import { foldFrom } from '@/lib/fold';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmAction } from '@/components/confirm-action';
import { actionsAllowed } from '@/lib/actions';
import { formatAgo, formatCount } from '@/lib/format';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Maintenance` };
}

/** `null` is "never", which is the finding here — not a cell to leave blank. */
function when(at: Date | string | null): string {
  return formatAgo(at) ?? 'never';
}

/**
 * #43, #45, #46. No `<Refresh>` — see the space page.
 *
 * #43 `maintenance_info` is rendered by `tableStats`, not by a check of its
 * own: pgHero's `maintenance_info` and pgops's `tableStats` read the same
 * view and return the same eight fields, so a second check would give this
 * page two answers to one question. maintenance.ts records the ruling.
 */
export default async function Maintenance({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ pgops?: string }>;
}) {
  const { name } = await params;
  // pgops's own relations, folded out of both lists — the same rule the other
  // four hygiene pages follow. Seven of the twelve rows here belong to the
  // console when it shares a database with its store.
  const fold = foldFrom(`/db/${name}/cleanup/maintenance`, await searchParams);
  const [stats, danger, running] = await Promise.all([
    runCheckFor(name, CHECKS.tableStats, {}),
    runCheckFor(name, CHECKS.autovacuumDanger, {}),
    runCheckFor(name, CHECKS.vacuumProgress),
  ]);

  // The same readings, written where the triage page can see them. The page
  // is unchanged — it ran these checks just now, on visit — and this is what
  // stops the triage line reporting a finding this page has already
  // disproved. Never throws, and does nothing at all without a store.
  await cacheChecks(name, {
    tableStats: stats, autovacuumDanger: danger, vacuumProgress: running,
  });
  // Read after runCheckFor has awaited connection(), so the gate reflects the
  // deployment rather than being frozen at build time.
  const canAct = actionsAllowed(process.env);

  return (
    <div className="grid gap-4">
      {canAct ? <Analyze name={name} /> : null}

      <CheckPanel title="Running vacuums" result={running}>
        {(d) => {
          if (d.vacuums.length === 0) {
            return (
              <p className="text-sm text-muted-foreground">
                No vacuum is running right now. That is the normal state of a healthy
                database, not a reading we could not take.
              </p>
            );
          }
          return (
            // NOT folded, unlike the two lists below. A vacuum running on
            // pgops's own store is a vacuum running on this database, and it
            // is competing for the same I/O as everything else — hiding it
            // would be hiding load, which is the one thing the Sessions
            // page's fold is careful never to do.
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>relation</TableHead>
                  <TableHead>phase</TableHead>
                  <TableHead className="text-right">scanned</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.vacuums.map((v) => (
                  <TableRow key={v.pid}>
                    <TableCell className="font-mono font-medium">
                      {v.relation ?? `pid ${v.pid}`}
                    </TableCell>
                    <TableCell>{v.phase}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {/*
                        The `initializing` phase reports heap_blks_total = 0 and
                        pctScanned null. `0%` there would read as a vacuum that
                        is stuck — on the vacuum most likely to be looked at.
                      */}
                      {v.pctScanned === null
                        ? <span className="text-muted-foreground">not yet known</span>
                        : `${v.pctScanned}%`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          );
        }}
      </CheckPanel>

      <CheckPanel title="Last vacuum and analyze" result={stats}>
        {(d) => {
          if (d.tables.length === 0) {
            return <p className="text-sm text-muted-foreground">No tables in a visible schema.</p>;
          }
          return (
            <Findings
              items={d.tables}
              total={d.total}
              fold={fold}
              subject={(t: typeof d.tables[number]) => t.table}
              columns={['table', 'dead rows>', 'vacuumed>', 'analyzed>']}
            >
              {(t: typeof d.tables[number]) => (
                <TableRow key={t.table}>
                  <TableCell className="font-mono font-medium">{t.table}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(t.deadRows)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {when(t.lastVacuum ?? t.lastAutovacuum)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {when(t.lastAnalyze ?? t.lastAutoanalyze)}
                  </TableCell>
                </TableRow>
              )}
            </Findings>
          );
        }}
      </CheckPanel>

      <CheckPanel title="Transaction ID age by relation" result={danger}>
        {(d) => {
          if (d.relations.length === 0) {
            return <p className="text-sm text-muted-foreground">No relations in a visible schema.</p>;
          }
          return (
            <>
              {/*
                Ruling 1: no verdict, and no badge invented here either. #44
                `wraparound` owns the alarm — it reads the database-wide
                datfrozenxid, the minimum over every relation, so it cannot
                miss what this list finds. This is the detail an operator
                opens AFTER that alarm fires, to decide what to vacuum first.
              */}
              <p className="mb-2 text-sm text-muted-foreground">
                The wraparound alarm on the Cleanup tab reads the database as a whole.
                This is which relation is holding it back.
              </p>
              <Findings
                items={d.relations}
                total={d.total}
                fold={fold}
                subject={(r: typeof d.relations[number]) => r.relation}
                columns={['relation', 'transactions left>']}
              >
                {(r: typeof d.relations[number]) => (
                  <TableRow key={r.relation}>
                    <TableCell className="font-mono font-medium">{r.relation}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(r.txnsRemaining)}
                    </TableCell>
                  </TableRow>
                )}
              </Findings>
            </>
          );
        }}
      </CheckPanel>
    </div>
  );
}

/**
 * #47's control, on the page that renders what it refreshes.
 *
 * Tier 1 (web spec §7.1): the gate plus an inline confirmation, and no typed
 * confirmation — ANALYZE recomputes statistics rather than destroying them,
 * and the worst realistic outcome is I/O on a busy database, which the
 * per-table lock and statement timeouts bound.
 *
 * The cap is STATED. The action takes the largest N tables, and a control that
 * said "analyze tables" while covering 50 of 4,000 would leave an operator
 * believing their statistics are fresh everywhere. `TABLES` must match the
 * route's own default; the route clamps independently, so this number is the
 * page's claim about what it asked for, not the enforcement.
 */
const TABLES = 50;

function Analyze({ name }: { name: string }) {
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-md border p-3">
      <div>
        <p className="mb-1 text-xs text-muted-foreground">
          Recomputes planner statistics for the largest {formatCount(TABLES)} tables,
          one transaction each, with a 5s lock wait and a 120s ceiling per table.
          A table that cannot be locked is skipped and reported, not retried.
        </p>
        <ConfirmAction
          label="Analyze tables"
          endpoint={`/api/db/${encodeURIComponent(name)}/analyze`}
          body={{ limit: TABLES }}
          describe="analyze"
        />
      </div>
    </div>
  );
}
