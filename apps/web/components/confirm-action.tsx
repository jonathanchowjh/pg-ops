'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The confirmation control for P5's three new actions.
 *
 * `KillButton` is deliberately NOT folded into this. It carries the PID-reuse
 * reasoning, a three-valued outcome vocabulary and a per-row absolute layout
 * that exists because laying it out inline pushed Confirm off a 1280px
 * viewport. Generalising the two would make both harder to read for the sake
 * of a shared shell. What IS shared is the idiom — inline two-step, reason
 * required, Confirm disabled until valid, the error taken from the JSON body —
 * so the console has one way of asking "are you sure", not two.
 *
 * `confirmWith` is the tier-2 step (web spec §7.1): the operator types the
 * database name back. Disabling the button on a mismatch is for the operator;
 * `openAction` re-checks the same string server-side, because a confirmation
 * the client alone enforces is one curl away from bypassed.
 */

/**
 * The sentence shown after an action succeeds, keyed by action.
 *
 * Keys rather than a callback prop because this is a client component and its
 * callers are server pages: React serialises every prop that crosses that
 * boundary, and a function cannot be serialised. v2.2.0 took a `describe`
 * function here and both call sites answered 500 whenever actions were on —
 * /sessions during exactly the pile-up it exists for. With the prop typed as
 * a key, a caller that tries to pass a closure fails typecheck instead.
 */
const OUTCOMES = {
  'kill-batch': (r: unknown) => {
    const results = (r as { results?: { outcome: string }[] }).results ?? [];
    const killed = results.filter((x) => x.outcome === 'terminated').length;
    return `${killed} of ${results.length} terminated.`;
  },
  analyze: (r: unknown) => {
    const results = (r as { results?: { ok: boolean }[] }).results ?? [];
    const ok = results.filter((x) => x.ok).length;
    return `${ok} of ${results.length} analyzed.`;
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
          // role="status" so the outcome of a destructive action is ANNOUNCED
          // rather than silently replacing a button. Polite: it has already
          // happened, so there is nothing to interrupt.
          <span role="status" className="text-xs text-muted-foreground">{result}</span>
        ) : null}
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          // Cleared on the way IN, not on the way out: the previous result is
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
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...body,
            reason: reason.trim(),
            ...(confirmWith === undefined ? {} : { confirm: typed }),
          }),
        });
        const parsed = (await res.json().catch(() => ({}))) as { error?: string };
        // The 502 path carries `error`, and it is the only place the real
        // reason reaches the operator — typically the console's role lacking
        // a privilege. Keep this chain intact rather than showing "HTTP 502".
        setResult(parsed.error ?? (describe === undefined ? undefined : OUTCOMES[describe](parsed)) ?? (res.ok ? 'Done.' : `HTTP ${res.status}`));
      } catch (err) {
        // fetch itself can reject — offline, DNS, an aborted connection. Left
        // uncaught, the rejection escapes the transition, `pending` never
        // clears, and the operator sees nothing at all.
        setResult(err instanceof Error ? err.message : String(err));
      }
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
        className="w-48 rounded border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
            className="w-40 rounded border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            placeholder={`Type ${confirmWith}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </>
      )}

      <button
        type="button"
        data-confirm
        className="rounded border border-destructive px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        disabled={blocked}
        onClick={send}
      >
        Confirm
      </button>
      <button
        type="button"
        className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>

      {/* Says WHY it is disabled. A button that looks armed and does nothing
          is the worst of the available behaviours on a control like this. */}
      <span className="text-xs text-muted-foreground">
        {blankReason
          ? 'reason required — it is audited'
          : unconfirmed
            ? `type ${confirmWith} to confirm`
            : null}
      </span>
    </span>
  );
}
