'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Tier 1's "and confirm", spec §7.1, as an inline two-step rather than a
 * modal.
 *
 * No dialog library: P1a installed `@base-ui/react` for a shadcn Badge that
 * turned out to be a `<span>`, and the fix was to stop vendoring the
 * dependency rather than to keep it. An inline control has no portal, no
 * focus trap, and nothing to get wrong when a `router.refresh()` re-renders
 * the table underneath it.
 *
 * `backendStart` is passed straight through from the row the operator is
 * looking at. That is the entire PID-reuse guard: killBackend compares it,
 * inside the same statement as the terminate, against one snapshot of
 * pg_stat_activity. Re-deriving it here would compare the server's idea of
 * the session against itself and always agree.
 */
export function KillButton({
  database,
  pid,
  backendStart,
}: {
  database: string;
  pid: number;
  backendStart: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // F6 (final review): only 'terminated' is terminal. `router.refresh()` does
  // not remount a same-keyed table row, so a control that replaced itself with
  // text on EVERY outcome stayed dead until the operator navigated away — and
  // the outcomes they most want to retry are exactly the ones that killed it:
  // 'session-changed' means the guard refused because the row was stale, so
  // the refreshed row is the one they now want to act on, and an error means
  // nothing happened at all. This is the incident path of an incident tool.
  //
  // 'terminated' stays terminal on purpose: the backend is gone, and offering
  // a second Terminate on that row invites a kill against a pid Postgres may
  // already have handed to someone else.
  if (outcome === 'terminated') {
    return <span className="text-xs text-muted-foreground">{OUTCOMES[outcome]}</span>;
  }

  if (!confirming) {
    return (
      <span className="flex items-center gap-2">
        {/* Kept visible next to the retry: the operator has to be able to read
            WHY the last attempt did not do what they expected — a refusal
            names a stale row, an error names a fixable privilege problem. */}
        {outcome ? (
          <span className="text-xs text-muted-foreground">{OUTCOMES[outcome] ?? outcome}</span>
        ) : null}
        <button
          type="button"
          className="text-xs underline underline-offset-2"
          // Cleared on the way back in, not on the way out: the previous
          // outcome is what the operator is reading while they decide to
          // retry, and it must not linger past the decision.
          onClick={() => { setOutcome(null); setConfirming(true); }}
        >
          Terminate
        </button>
      </span>
    );
  }

  const send = () => {
    if (reason.trim() === '') return;
    startTransition(async () => {
      try {
        // F12 (final review): encoded, not interpolated raw. Nothing can reach
        // this component with a name that needs escaping today — the layout
        // 404s any unconfigured name and a configured one must match
        // `[A-Za-z0-9_-]+` (lib/config.ts) — but that defence is two layers
        // away from this line, and neither of them is where a reader looks
        // when they change this URL.
        const res = await fetch(`/api/db/${encodeURIComponent(database)}/kill`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pid, backendStart, reason: reason.trim() }),
        });
        const body = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string };
        // C1: a failed pg_terminate_backend (typically the console's role
        // lacking pg_signal_backend) surfaces as a 502 with `error`, not
        // `outcome`. Keep this fallback chain intact — it is the only path
        // that gets that message in front of the operator who needs to read
        // it, rather than a blank or a generic "HTTP 502".
        setOutcome(body.outcome ?? body.error ?? `HTTP ${res.status}`);
      } catch (err) {
        // I3 (review): `fetch` itself can reject — offline, DNS, an aborted
        // connection — which is exactly the kind of failure this control
        // exists to survive. Left uncaught, the rejection propagated out of
        // this transition: `pending` never returned to false (Confirm
        // disabled forever) and no outcome was ever set, so the operator saw
        // nothing at all — silently defeating C1's whole point of showing
        // why a kill failed.
        setOutcome(err instanceof Error ? err.message : String(err));
      }
      setConfirming(false);
      // Refreshed on EVERY outcome, not only on success. A refusal
      // ('session-changed') or a miss ('gone') both mean the operator's
      // picture of the world was already stale — which is precisely why the
      // kill did not do what they expected.
      router.refresh();
    });
  };

  return (
    <span className="flex items-center gap-1">
      <label className="sr-only" htmlFor={`reason-${pid}`}>Reason</label>
      <input
        id={`reason-${pid}`}
        className="w-40 border px-1 text-xs"
        placeholder={`Reason — terminate ${pid}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="button" data-confirm className="text-xs font-medium" disabled={pending} onClick={send}>
        Confirm
      </button>
      <button type="button" className="text-xs" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}

/**
 * killBackend's three-valued result, in the operator's words. "session-changed"
 * is not a failure and must not read as one: it means the guard did its job.
 */
const OUTCOMES: Record<string, string> = {
  terminated: 'terminated',
  'session-changed': 'refused — that pid is a different session now',
  gone: 'already gone',
};
