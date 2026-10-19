import type { CheckResult, IdentityData, Setting, SettingsData } from '@pgops/checks';
import { CheckPanel } from '@/components/check-panel';

function sslLabel(ssl: boolean | null): string {
  if (ssl === null) return 'SSL unknown';
  return ssl ? 'SSL' : 'no SSL';
}

/**
 * What the server on the other end says it is.
 *
 * Every other surface in this console names a database by the label the
 * operator wrote in `PGOPS_DATABASES`. This line is the only place the
 * server answers — see checks/identity.ts.
 *
 * An SSL status we could not read says `SSL unknown`, which is neither `SSL`
 * nor `no SSL`.
 */
export function StatusBar({ result }: { result: CheckResult<IdentityData> }) {
  // The check is a scalar SELECT and cannot fail on its own, so arriving here
  // means the database was unreachable. The line still renders rather than
  // vanishing.
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
    // unremarkable case.
    ...(d.replica === null ? ['replica unknown'] : d.replica ? ['replica'] : []),
  ];

  return (
    <p className="text-xs text-muted-foreground">
      {facts.join(' · ')}
    </p>
  );
}

/**
 * The server's settings, collapsed by default.
 *
 * Not inside `StatusBar`: that renders in `app/db/[name]/layout.tsx`, which
 * is shared by the four incident pages and which `router.refresh()`
 * re-renders. A `pg_settings` read there would land behind the 5-second poll
 * on every incident page. So the fetch and this disclosure live on /cleanup.
 */
export function SettingsDisclosure({ result }: { result: CheckResult<SettingsData> }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Settings
      </summary>
      <div className="mt-2">
        {/* A settings read that failed still renders the disclosure, with the
            reason inside it. */}
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
                `16384` plus a separate `8kB` unit. See settings.ts. */}
            <dd className="font-mono">{s.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
