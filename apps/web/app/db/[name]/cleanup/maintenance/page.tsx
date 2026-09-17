import type { Metadata } from 'next';
import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { SubNav } from '@/components/sub-nav';
import { CLEANUP_SECTIONS } from '@/components/cleanup-sections';
import { formatCount } from '@/lib/format';

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
  if (at === null) return 'never';
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? 'never' : d.toISOString().slice(0, 16).replace('T', ' ');
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
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const [stats, danger, running] = await Promise.all([
    runCheckFor(name, CHECKS.tableStats, {}),
    runCheckFor(name, CHECKS.autovacuumDanger, {}),
    runCheckFor(name, CHECKS.vacuumProgress),
  ]);

  return (
    <div className="grid gap-4">
      <SubNav name={name} base="cleanup" items={CLEANUP_SECTIONS} />

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
            <ul className="text-sm">
              {d.vacuums.map((v) => (
                <li key={v.pid} className="flex justify-between gap-4 py-0.5">
                  <span className="font-medium">{v.relation ?? `pid ${v.pid}`}</span>
                  <span className="text-muted-foreground">
                    {v.phase}
                    {' · '}
                    {/*
                      The `initializing` phase reports heap_blks_total = 0 and
                      pctScanned null. `0%` there would read as a vacuum that
                      is stuck — on the vacuum most likely to be looked at.
                    */}
                    {v.pctScanned === null ? 'progress not yet known' : `${v.pctScanned}%`}
                  </span>
                </li>
              ))}
            </ul>
          );
        }}
      </CheckPanel>

      <CheckPanel title="Last vacuum and analyze" result={stats}>
        {(d) => {
          if (d.tables.length === 0) {
            return <p className="text-sm text-muted-foreground">No tables in a visible schema.</p>;
          }
          return (
            <>
              <ul className="text-sm">
                {d.tables.map((t) => (
                  <li key={t.table} className="flex justify-between gap-4 py-0.5">
                    <span className="font-medium">{t.table}</span>
                    <span className="text-muted-foreground">
                      {formatCount(t.deadRows)} dead
                      {' · vacuumed '}{when(t.lastVacuum ?? t.lastAutovacuum)}
                      {' · analyzed '}{when(t.lastAnalyze ?? t.lastAutoanalyze)}
                    </span>
                  </li>
                ))}
              </ul>
              {d.truncated ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Showing {formatCount(d.tables.length)} of {formatCount(d.total)},
                  worst first by dead rows.
                </p>
              ) : null}
            </>
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
              <ul className="text-sm">
                {d.relations.map((r) => (
                  <li key={r.relation} className="flex justify-between gap-4 py-0.5">
                    <span className="font-medium">{r.relation}</span>
                    <span className="text-muted-foreground">
                      {formatCount(r.txnsRemaining)} txns left
                    </span>
                  </li>
                ))}
              </ul>
              {d.truncated ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Showing {formatCount(d.relations.length)} of {formatCount(d.total)}, oldest first.
                </p>
              ) : null}
            </>
          );
        }}
      </CheckPanel>
    </div>
  );
}
