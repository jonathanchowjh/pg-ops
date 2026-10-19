'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The console's actions, each an inline two-step confirmation rather than a
 * modal: a reason is required and audited, Confirm stays disabled until the
 * form is valid, and the outcome is read from the JSON body.
 *
 * `KillButton` ends one session. `ConfirmAction` is everything else, and
 * with `confirmWith` it is tier 2: the operator types the database name
 * back, and `openAction` re-checks the same string server-side.
 */

const INPUT = 'rounded border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
// Styled as destructive so it cannot be mistaken for Cancel.
const CONFIRM = 'rounded border border-destructive px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 '
  + 'focus-visible:ring-2 focus-visible:ring-destructive focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';
const CANCEL = 'rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
const REASON_REQUIRED = 'reason required — it is audited';

/**
 * POST an action and return its parsed body. Never rejects: `fetch` itself
 * can fail (offline, DNS, an aborted connection), and that message is the
 * outcome. A failed action surfaces as a 502 whose `error` is the only place
 * the real reason reaches the operator, typically the console's role
 * lacking a privilege.
 */
async function post(endpoint: string, body: Record<string, unknown>): Promise<{ status: number; ok: boolean; body: Record<string, unknown> } | { error: string }> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, ok: res.ok, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * killBackend's three-valued result, in the operator's words. "session-changed"
 * is not a failure: it means the guard did its job.
 */
const KILLED: Record<string, string> = {
  terminated: 'terminated',
  'session-changed': 'refused — that pid is a different session now',
  gone: 'already gone',
};

/**
 * Terminate, tier 1.
 *
 * `backendStart` is passed straight through from the row the operator is
 * looking at. That is the entire PID-reuse guard: killBackend compares it,
 * inside the same statement as the terminate, against one snapshot of
 * pg_stat_activity. Re-deriving it here would always agree.
 */
export function KillButton({
  database,
  pid,
  backendStart,
  prominent = false,
}: {
  database: string;
  pid: number;
  backendStart: string | null;
  /** Drawn as the page's one danger button, for the finding it ends. A row's is a quiet link. */
  prominent?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Only 'terminated' is terminal. `router.refresh()` does not remount a
  // same-keyed table row, so after 'session-changed' or an error the control
  // must stay usable for a retry. After 'terminated' the backend is gone, and
  // a second Terminate would target a pid Postgres may already have handed to
  // someone else.
  if (outcome === 'terminated') {
    // `role="status"` so the result is announced to a screen reader.
    return <span role="status" className="text-xs text-muted-foreground">{KILLED[outcome]}</span>;
  }

  if (!confirming) {
    return (
      <span className="flex items-center gap-2">
        {/* Kept visible next to the retry, so the operator can read why the
            last attempt did not do what they expected. */}
        {outcome ? (
          <span role="status" className="text-xs text-muted-foreground">{KILLED[outcome] ?? outcome}</span>
        ) : null}
        <button
          type="button"
          className={prominent
            ? 'rounded-[5px] border border-critical-ink bg-card px-3 py-1 text-[13px] whitespace-nowrap text-critical-ink hover:bg-critical-surface'
            : 'text-xs underline underline-offset-2'}
          // Cleared on the way back in, not on the way out: the previous
          // outcome is what the operator reads while deciding to retry.
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
      // Encoded even though a configured name must already match
      // `[A-Za-z0-9_-]+` (lib/config.ts).
      const r = await post(`/api/db/${encodeURIComponent(database)}/kill`, { pid, backendStart, reason: reason.trim() });
      const said = 'error' in r ? r.error : (r.body.outcome ?? r.body.error ?? `HTTP ${r.status}`);
      setOutcome(String(said));
      setConfirming(false);
      // Refreshed on every outcome: a refusal ('session-changed') or a miss
      // ('gone') means the operator's picture was already stale.
      router.refresh();
    });
  };

  // The guard in `send` is the enforcement; this disables Confirm and drives
  // the hint that says why.
  const blank = reason.trim() === '';

  // Absolutely positioned and anchored to the right edge of its cell, so it
  // grows leftward over the query column instead of widening the table.
  //
  // On a phone the cell is narrower than the form, and anchored to its right
  // the form ran off the left of the screen: there it starts at the cell's
  // left edge and is the screen's width.
  //
  // Wrapping is scoped to narrow viewports (`sm:flex-nowrap`, and the cap
  // released by `sm:max-w-none`). This span's shrink-to-fit width is bounded
  // by its containing block, the action cell, so wrapping unconditionally
  // would wrap at the cell's width on every screen. `whitespace-nowrap` keeps
  // each item's own text on one line and does not stop flex items wrapping.
  return (
    <span className="absolute top-1/2 right-2 z-10 flex max-w-[calc(100vw-2rem)] -translate-y-1/2 flex-wrap items-center gap-1 rounded-md border bg-background p-1.5 whitespace-nowrap shadow-lg max-sm:right-auto max-sm:left-0 max-sm:w-[calc(100vw-2rem)] sm:max-w-none sm:flex-nowrap">
      <label className="sr-only" htmlFor={`reason-${pid}`}>Reason</label>
      <input
        id={`reason-${pid}`}
        className={`w-40 ${INPUT}`}
        placeholder={`Reason — terminate ${pid}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-describedby={`reason-hint-${pid}`}
        autoFocus
      />
      <button type="button" data-confirm className={CONFIRM} disabled={pending || blank} onClick={send}>Confirm</button>
      <button type="button" className={CANCEL} onClick={() => setConfirming(false)}>Cancel</button>
      {/* Says why Confirm is disabled. */}
      <span id={`reason-hint-${pid}`} className="text-xs text-muted-foreground">{blank ? REASON_REQUIRED : null}</span>
    </span>
  );
}

/**
 * The sentence shown after an action succeeds, keyed by action.
 *
 * Keys rather than a callback prop: the callers are server pages, and a
 * function cannot be serialised across the server/client boundary.
 */
const OUTCOMES = {
  'kill-batch': (r: unknown) => {
    const results = (r as { results?: { outcome: string }[] }).results ?? [];
    const killed = results.filter((x) => x.outcome === 'terminated').length;
    return `${killed} of ${results.length} terminated.`;
  },
  analyze: (r: unknown) => {
    const results = (r as { results?: { ok: boolean; relation?: string; error?: string }[] }).results ?? [];
    const failed = results.filter((x) => !x.ok);
    // The reason is what the operator acts on: a lock it waited behind, recovery, a missing privilege.
    const why = failed.map((x) => ` ${x.relation ?? 'A table'}: ${x.error ?? 'no reason given'}.`).join('');
    return `${results.length - failed.length} of ${results.length} analyzed.${why}`;
  },
} satisfies Record<string, (result: unknown) => string>;

export type ConfirmOutcome = keyof typeof OUTCOMES;

export function ConfirmAction({
  label,
  endpoint,
  body,
  confirmWith,
  danger,
  describe,
}: {
  label: string;
  /** Path only, e.g. `/api/db/prod/reset-stats`. */
  endpoint: string;
  /** Extra fields merged into the POST body. */
  body?: Record<string, unknown>;
  /** Tier 2: the exact string the operator must type. Omit for tier 1. */
  confirmWith?: string;
  /** What is irreversible about this, shown before the operator commits. */
  danger?: string;
  /** Which sentence the 200 body becomes afterwards — see OUTCOMES. */
  describe?: ConfirmOutcome;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const id = endpoint.replace(/[^a-z0-9]+/gi, '-');

  if (!open) {
    return (
      <span className="flex items-center gap-2">
        {result ? (
          // role="status" so the outcome is announced to screen readers.
          <span role="status" className="text-xs text-muted-foreground">{result}</span>
        ) : null}
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          // Cleared on the way in, not on the way out: the previous result is
          // what the operator reads while deciding whether to go again.
          onClick={() => { setResult(null); setReason(''); setTyped(''); setOpen(true); }}
        >
          {label}
        </button>
      </span>
    );
  }

  const blankReason = reason.trim() === '';
  const unconfirmed = confirmWith !== undefined && typed !== confirmWith;
  const blocked = pending || blankReason || unconfirmed;

  const send = () => {
    if (blocked) return;
    startTransition(async () => {
      const r = await post(endpoint, {
        ...body, reason: reason.trim(), ...(confirmWith === undefined ? {} : { confirm: typed }),
      });
      setResult('error' in r ? r.error
        : (r.body.error as string | undefined)
          ?? (describe === undefined ? undefined : OUTCOMES[describe](r.body))
          ?? (r.ok ? 'Done.' : `HTTP ${r.status}`));
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <span className="flex flex-wrap items-center gap-2 rounded-md border p-2">
      {danger ? <span className="w-full text-xs text-destructive">{danger}</span> : null}

      <label className="sr-only" htmlFor={`reason-${id}`}>Reason</label>
      <input
        id={`reason-${id}`}
        className={`w-48 ${INPUT}`}
        placeholder="Reason — it is audited"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        autoFocus
      />

      {confirmWith === undefined ? null : (
        <>
          <label className="sr-only" htmlFor={`confirm-${id}`}>
            Type {confirmWith} to confirm
          </label>
          <input
            id={`confirm-${id}`}
            className={`w-40 ${INPUT}`}
            placeholder={`Type ${confirmWith}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </>
      )}

      <button type="button" data-confirm className={CONFIRM} disabled={blocked} onClick={send}>Confirm</button>
      <button type="button" className={CANCEL} onClick={() => setOpen(false)}>Cancel</button>

      {/* Says why Confirm is disabled. */}
      <span className="text-xs text-muted-foreground">
        {blankReason ? REASON_REQUIRED : unconfirmed ? `type ${confirmWith} to confirm` : null}
      </span>
    </span>
  );
}
