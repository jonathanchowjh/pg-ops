import type { ReactNode } from 'react';
import type { CheckResult, Verdict } from '@pgops/checks';
// No `.js` extension, unlike the rest of this repo. Next's bundler resolves
// relative imports against real files on disk and cannot map `./x.js` onto a
// sibling `x.tsx`; the build fails with a module-not-found that neither tsc
// nor vitest reproduces, because both happily rewrite the specifier. The
// convention is repo-wide EXCEPT inside apps/web's app, lib and components.
import { VerdictBadge } from './verdict-badge';

/**
 * Every check on every page renders through here, so the failed case is
 * handled exactly once and cannot be forgotten on a page written later.
 *
 * `runCheck` never rejects: a denied, unsupported, or broken check arrives as
 * `{ok: false}` data. A panel that rendered nothing for that case would leave
 * a hole on the page that reads as "nothing to report" — the most dangerous
 * possible misreading during an incident. So the failure is rendered as
 * prominently as the success.
 */
export function CheckPanel<T>({
  title,
  result,
  children,
}: {
  title: string;
  result: CheckResult<T>;
  children: (data: T, verdict: Verdict) => ReactNode;
}) {
  return (
    <section className="rounded-lg border p-4">
      <header className="mb-3 flex items-center justify-between gap-4">
        <h2 className="font-semibold">{title}</h2>
        {result.ok ? <VerdictBadge verdict={result.verdict} /> : null}
      </header>
      {result.ok ? (
        children(result.data, result.verdict)
      ) : (
        <div className="text-sm">
          <p className="font-medium">Unavailable — {result.reason}</p>
          <p className="text-muted-foreground">{result.message}</p>
          {result.remedy ? <pre className="mt-2 overflow-x-auto rounded bg-muted p-2">{result.remedy}</pre> : null}
        </div>
      )}
    </section>
  );
}
