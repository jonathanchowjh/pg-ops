'use client';

import { useState, useTransition } from 'react';
import type { CheckResult, Explanation } from '@pgops/checks';
import { CheckPanel } from './check-panel';
import { IndexAdviceList } from './index-advice';
import { planLines } from '@/lib/format';

type Answer =
  | { kind: 'result'; result: CheckResult<Explanation> }
  | { kind: 'error'; message: string };

/**
 * Statement in; plan and index advice out.
 *
 * A client component because the statement travels as a POST body, never in
 * the URL (see the route's docblock) — so the page cannot be a form that
 * navigates. The answer renders through `CheckPanel`, like every check on
 * every page: a tool's result IS a `CheckResult`, and a failed plan is shown
 * exactly as any failure is, reason first.
 *
 * The statement is never echoed outside the textarea it was typed into.
 */
export function ExplainForm({ name }: { name: string }) {
  const [sql, setSql] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [pending, startTransition] = useTransition();
  const blocked = pending || sql.trim() === '';

  const send = () => {
    if (blocked) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/db/${name}/explain`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql }),
        });
        const parsed = (await res.json().catch(() => ({}))) as { error?: string } & Partial<CheckResult<Explanation>>;
        if (typeof parsed.error === 'string') setAnswer({ kind: 'error', message: parsed.error });
        else if (typeof parsed.ok === 'boolean') setAnswer({ kind: 'result', result: parsed as CheckResult<Explanation> });
        else setAnswer({ kind: 'error', message: `HTTP ${res.status}` });
      } catch (err) {
        // fetch itself can reject. Left uncaught, the transition never
        // settles and the operator sees nothing at all.
        setAnswer({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="explain-sql" className="text-sm font-medium">Statement</label>
        <textarea
          id="explain-sql"
          className="block min-h-32 w-full rounded border p-2 font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          placeholder="SELECT * FROM orders WHERE customer_id = $1"
          spellCheck={false}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
        />
        <button
          type="button"
          className="rounded border px-3 py-1 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          disabled={blocked}
          onClick={send}
        >
          Explain
        </button>
      </div>

      {answer?.kind === 'error' ? <p role="alert" className="text-sm text-destructive">{answer.message}</p> : null}

      {answer?.kind === 'result' ? (
        <CheckPanel title="Plan" result={answer.result}>
          {(d) => (
            <div className="space-y-4">
              {/* A generic plan estimates for no particular value, so its row
                  counts can differ from what one real value would get. */}
              {d.parameters > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Generic plan: {d.parameters === 1 ? '$1 was' : `$1–$${d.parameters} were`} planned without values.
                </p>
              ) : null}
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{planLines(d.plan).join('\n')}</pre>
              <div className="space-y-2">
                <h3 className="font-semibold">Index advice</h3>
                <p className="text-sm text-muted-foreground">
                  Suggested from column statistics by pgHero&rsquo;s heuristic — confirm before building
                  anything. pgops never runs these.
                </p>
                <IndexAdviceList advice={d.advice} />
              </div>
            </div>
          )}
        </CheckPanel>
      ) : null}
    </div>
  );
}
