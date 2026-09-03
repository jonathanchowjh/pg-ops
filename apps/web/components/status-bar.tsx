import type { CheckResult, IdentityData } from '@pgops/checks';

/**
 * What the server on the other end says it is.
 *
 * Every other surface in this console names a database by the label the
 * OPERATOR wrote in `PGOPS_DATABASES`. This line is the only place the
 * SERVER gets to answer, and it renders beside a terminate button — see
 * checks/identity.ts for the full reasoning.
 *
 * Unknown never renders as fine and never renders as its opposite: an SSL
 * status we could not read says `SSL unknown`, which is neither `SSL` nor
 * `no SSL`.
 */
function sslLabel(ssl: boolean | null): string {
  if (ssl === null) return 'SSL unknown';
  return ssl ? 'SSL' : 'no SSL';
}

export function StatusBar({ result }: { result: CheckResult<IdentityData> }) {
  // Not silence. The check is a scalar SELECT and cannot fail on its own, so
  // arriving here means the database was unreachable — which the panels
  // below will also report. This line still speaks, because it is the one
  // that claims WHICH server we are on, and a claim that quietly vanishes
  // reads as a claim that was never in doubt.
  if (!result.ok) {
    return <p className="text-xs text-muted-foreground">identity unavailable</p>;
  }

  const d = result.data;
  const facts = [
    d.database ?? 'unknown database',
    d.user ?? 'unknown user',
    d.serverVersion === null ? 'unknown version' : `PG ${d.serverVersion}`,
    sslLabel(d.ssl),
    // Only the affirmative and the unknown render. A primary is the
    // unremarkable case and adding "primary" to every page would train the
    // reader to skip the field that matters on the one page where it says
    // something else.
    ...(d.replica === null ? ['replica unknown'] : d.replica ? ['replica'] : []),
  ];

  return (
    <p className="text-xs text-muted-foreground">
      {facts.join(' · ')}
    </p>
  );
}
