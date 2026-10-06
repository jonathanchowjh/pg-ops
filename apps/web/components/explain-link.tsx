'use client';

import { useRouter } from 'next/navigation';

export const EXPLAIN_HANDOFF_KEY = 'pgops.explain';

/**
 * One click from a statement to its plan.
 *
 * The text travels through `sessionStorage`, not the URL. That is the
 * explain route's own rule — a statement is a POST body because it can
 * carry a literal secret — and a query string would put it in the browser's
 * history, in any access log the console sits behind, and in the referrer of
 * everything the next page loads.
 *
 * A `button` rather than an anchor, deliberately: there is no URL that
 * represents this destination with this statement, so there is nothing for
 * an anchor to point at, and offering one that middle-click opened to an
 * empty form would be a worse lie than not offering it.
 *
 * Storage that throws — a private window, blocked site data — still
 * navigates. The operator lands on an empty form, which is exactly where
 * they were before this link existed; landing nowhere is the one outcome
 * worse than that.
 */
export function ExplainLink({ name, statement }: { name: string; statement: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="text-xs underline underline-offset-2 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={() => {
        try {
          sessionStorage.setItem(EXPLAIN_HANDOFF_KEY, statement);
        } catch {
          // Degrade to an empty form rather than not navigating at all.
        }
        router.push(`/db/${name}/queries/explain`);
      }}
    >
      Explain
    </button>
  );
}
