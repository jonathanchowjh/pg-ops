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
    // `role="status"` so the result of a destructive action is ANNOUNCED. A
    // screen-reader user pressed Confirm and the only feedback was this text
    // silently replacing the button — no announcement, so nothing said
    // whether a production backend had just been terminated, refused, or had
    // errored. Polite rather than assertive: the action has already finished,
    // so there is nothing to interrupt.
    return <span role="status" className="text-xs text-muted-foreground">{OUTCOMES[outcome]}</span>;
  }

  if (!confirming) {
    return (
      <span className="flex items-center gap-2">
        {/* Kept visible next to the retry: the operator has to be able to read
            WHY the last attempt did not do what they expected — a refusal
            names a stale row, an error names a fixable privilege problem. */}
        {outcome ? (
          <span role="status" className="text-xs text-muted-foreground">{OUTCOMES[outcome] ?? outcome}</span>
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

  // `send` refuses a blank reason and always has. It did so SILENTLY: the
  // operator clicked Confirm, nothing happened, nothing said why, and the only
  // account of the rule was an early `return` in a function they cannot see.
  // On the one control in this console that can end a production backend, a
  // button that looks armed and does nothing is the worst of the three
  // available behaviours — worse than refusing loudly, and worse than not
  // being there. The guard in `send` stays as the actual enforcement; this
  // just stops the UI from lying about it.
  const blank = reason.trim() === '';

  // Absolutely positioned, anchored to the RIGHT edge of its cell, so it grows
  // LEFTWARD over the query column instead of widening the table.
  //
  // Laid out inline, this control took the action cell from 16px to 423px and
  // the sessions table from 944px to 1351px inside a 942px container — putting
  // Confirm at x=1422 on a 1280px viewport. The operator had to scroll
  // sideways to finish an action they had already started, on the one control
  // that ends a production backend. Anchoring right pins the panel to the one
  // edge that is always on screen (the table's right edge is the container's),
  // and the table's width no longer changes at all when this opens, so no
  // other row moves under the reader either.
  //
  // The PHONE half of that same fix, measured at 390px on 2026-10-01: on one
  // line this panel is 477px wide, so 104px of it — including the `reason
  // required` hint below, the only thing that says why Confirm is disabled —
  // sat off the right edge of the screen. Wrapping brings it to 186px, fully
  // on screen, hint included.
  //
  // WRAPPING IS SCOPED TO NARROW VIEWPORTS (`sm:flex-nowrap`, and the cap
  // released by `sm:max-w-none`) because it is NOT free above them. This span
  // is absolutely positioned, so its shrink-to-fit width is bounded by its
  // containing block — the ~190px action cell. `whitespace-nowrap` plus a
  // non-wrapping flex is precisely what made it ignore that bound and lay out
  // at its 477px content width. Allow wrapping unconditionally and it wraps at
  // the CELL's width on every screen: measured at 1280px, the tidy single row
  // this control was deliberately tuned into became a 186px four-line stack.
  // The breakpoint is what keeps the desktop layout the paragraph above
  // describes intact while fixing the phone.
  //
  // `whitespace-nowrap` stays: it keeps each item's own text on one line, and
  // does not stop flex items wrapping — `white-space` and `flex-wrap` are
  // independent.
  return (
    <span className="absolute top-1/2 right-2 z-10 flex max-w-[calc(100vw-2rem)] -translate-y-1/2 flex-wrap items-center gap-1 rounded-md border bg-background p-1.5 whitespace-nowrap shadow-lg sm:max-w-none sm:flex-nowrap">
      <label className="sr-only" htmlFor={`reason-${pid}`}>Reason</label>
      <input
        id={`reason-${pid}`}
        className="w-40 rounded border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        placeholder={`Reason — terminate ${pid}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-describedby={`reason-hint-${pid}`}
        // The operator clicked Terminate one keystroke ago; the reason field
        // is unambiguously where they are going next.
        autoFocus
      />
      <button
        type="button"
        data-confirm
        // Styled as destructive, unlike its neighbour. Confirm and Cancel were
        // two near-identical scraps of 12px text, distinguished only by
        // `font-medium` — a coin flip at a glance, on a pair where one choice
        // is irreversible.
        className="rounded border border-destructive px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        disabled={pending || blank}
        onClick={send}
      >
        Confirm
      </button>
      <button
        type="button"
        className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => setConfirming(false)}
      >
        Cancel
      </button>
      {/* Says WHY it is disabled, and says the thing the operator actually
          needs to know: the text is not a formality, it is written to the
          audit record that outlives the incident. */}
      <span id={`reason-hint-${pid}`} className="text-xs text-muted-foreground">
        {blank ? 'reason required — it is audited' : null}
      </span>
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
