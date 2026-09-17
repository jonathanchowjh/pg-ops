import type { CheckResult, IdentityData, Setting, SettingsData } from '@pgops/checks';
import { CheckPanel } from '@/components/check-panel';

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

/**
 * #56, and the one thing on this page the server says about ITSELF rather
 * than about its current state.
 *
 * Placement, and why it is not literally inside `StatusBar`. `gates.ts` puts
 * `server` facts in the status line, and `StatusBar` renders in
 * `app/db/[name]/layout.tsx` — which is shared by the four incident pages,
 * and which `router.refresh()` re-renders. A `pg_settings` read there would
 * land behind the 5-second poll on every incident page, which is precisely
 * the load §4.2's poll boundary exists to prevent. So the fetch and this
 * disclosure live on /cleanup, the one keep-up page, and the four pages that
 * do not ask for settings are untouched — `StatusBar` above is not modified
 * at all, which is the strongest form of "the line above the terminate
 * button still reads exactly as it did".
 *
 * Collapsed by default. These are twenty-one numbers an operator consults
 * deliberately; open, they would push the actual findings below the fold on
 * the page whose subject is what needs cleaning up.
 */
export function SettingsDisclosure({ result }: { result: CheckResult<SettingsData> }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Settings
      </summary>
      <div className="mt-2">
        {/* A settings read that FAILED still renders the disclosure, with the
            reason inside it. Omitting the section entirely would make a
            permission error indistinguishable from a build that never had
            this feature. CheckPanel already owns that wording. */}
        <CheckPanel title="Settings" result={result} headingLevel={3}>
          {(d) => (
            <div className="grid gap-4 sm:grid-cols-3">
              <SettingGroup title="Server" settings={d.main} />
              <SettingGroup title="Autovacuum" settings={d.autovacuum} />
              <SettingGroup title="Vacuum" settings={d.vacuum} />
            </div>
          )}
        </CheckPanel>
      </div>
    </details>
  );
}

function SettingGroup({ title, settings }: { title: string; settings: readonly Setting[] }) {
  if (settings.length === 0) {
    return (
      <div>
        <h4 className="font-medium">{title}</h4>
        <p className="text-muted-foreground">none reported</p>
      </div>
    );
  }
  return (
    <div>
      <h4 className="font-medium">{title}</h4>
      <dl>
        {settings.map((s) => (
          <div key={s.name} className="flex justify-between gap-4 py-0.5">
            <dt className="text-muted-foreground">{s.name}</dt>
            {/* `value` is already the SHOW-equivalent string — `128MB`, not
                `16384` plus a separate `8kB` unit — so there is nothing to
                concatenate here and no unitless setting to leave a trailing
                space behind. settings.ts carries that reasoning. */}
            <dd className="font-mono">{s.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
