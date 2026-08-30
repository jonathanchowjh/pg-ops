import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { actionsAllowed } from '@/lib/actions';
import { CheckPanel } from '@/components/check-panel';
import { KillButton } from '@/components/kill-button';
import { Sql } from '@/components/sql';
import { formatDuration } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default async function Sessions({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ limit?: string }>;
}) {
  const { name } = await params;
  const { limit } = await searchParams;
  const parsed = Number(limit);
  const result = await runCheckFor(name, CHECKS.sessions, {
    limit: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
  });
  // Read here, after runCheckFor has already awaited connection() — so this
  // page is dynamic before the gate is read, and the gate reflects the
  // deployment rather than being frozen at build time. Not hoisted to module
  // scope; see lib/check.ts and test/guards.test.ts.
  const canAct = actionsAllowed(process.env);

  return (
    <CheckPanel title="Sessions" result={result}>
      {(d) => (
        <>
          {d.truncated ? (
            <p className="mb-2 text-sm text-muted-foreground">
              Showing the first {d.sessions.length} — more sessions matched than are displayed.
            </p>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>pid</TableHead><TableHead>state</TableHead><TableHead>age</TableHead>
                <TableHead>user@app</TableHead><TableHead>query</TableHead>{canAct ? <TableHead /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.sessions.map((s) => (
                <TableRow key={s.pid}>
                  <TableCell>{s.pid}</TableCell>
                  <TableCell>{s.state ?? '—'}</TableCell>
                  <TableCell>{formatDuration(s.queryAgeSecs)}</TableCell>
                  <TableCell>{s.user ?? '—'}@{s.app ?? '—'}</TableCell>
                  <TableCell className="max-w-md truncate"><Sql>{s.query}</Sql></TableCell>
                  {canAct ? (
                    <TableCell>
                      <KillButton database={name} pid={s.pid} backendStart={s.backendStart} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </CheckPanel>
  );
}
