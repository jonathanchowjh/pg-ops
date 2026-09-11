import { connection } from 'next/server';
import {
  runCheck, runSeries,
  type Check, type CheckResult, type Series, type SeriesResult, type TimeRange,
} from '@pgops/checks';
// Extensionless, not './pools.js': this file's tsconfig sets moduleResolution
// "bundler" (Next requires it), under which Next's own webpack/Turbopack
// resolvers do NOT map a literal ".js" specifier onto a sibling ".ts" file —
// unlike tsc and Vite, which both tolerate it silently. `next build` was
// never actually exercised against this import until Task 7 wired a page to
// it, so nothing had caught the mismatch. This is local to apps/web; the
// rest of the repo's ".js" convention is unaffected.
import { contextFor } from './pools';
import { ConfigError } from './config';

/**
 * `connection()` throws — it does not just no-op — when called with no
 * active Next.js request store, tagging the error with this code (see
 * https://nextjs.org/docs/messages/next-dynamic-api-wrong-context and
 * next/dist/server/request/connection.js's `throwForMissingRequestStore`).
 * That is exactly this module's own integration test: it calls
 * `runCheckFor` directly, with no Next server ever started, so there is no
 * static/dynamic distinction left to protect. Only THIS code is treated as
 * "no request scope, proceed anyway" — any other failure out of
 * `connection()` still becomes `ok:false` below, same as any other seam
 * failure.
 */
const NO_REQUEST_STORE = 'E251';

/**
 * Exported for check-seam.test.ts. The negative cases are the ones that
 * matter: swallowing anything OTHER than a missing request store would let a
 * genuine dynamic-rendering failure render as a success, which is the exact
 * defect `connection()` exists to prevent. Note also that a real prerender
 * does not reach here at all — `connection()` returns a hanging promise
 * during prerendering rather than throwing, so the run-time-configuration
 * guarantee below is untouched by this branch. Task 7's "reads its configuration at
 * run time, not build time" test is the end-to-end proof of that.
 */

export function isMissingRequestStore(err: unknown): boolean {
  return (err as { __NEXT_ERROR_CODE?: string } | null)?.__NEXT_ERROR_CODE === NO_REQUEST_STORE;
}

/**
 * The two "this is the CONSOLE failing, not the database" messages, in one
 * place because their WORDING is the whole point.
 *
 * Both fire on paths where no database was contacted, and both are rendered
 * by the same panel that renders a genuinely sick database. `FailureReason`
 * is packages/checks' vocabulary and has no member for "the web layer is
 * misconfigured", so the distinction lives entirely in these strings: they
 * name pgops, they say the database was not contacted, and the ConfigError
 * one ends with the operator's own input (PGOPS_CONFIG_FILE and its path,
 * PGOPS_DATABASES, DATABASE_URL). Reported as `reason: 'unreachable'` with a
 * bare framework message, this told an on-call engineer their database was
 * down when what was wrong was the deployment they had just changed.
 *
 * `runSeriesFor` duplicated both strings verbatim, minus the reasoning — two
 * copies of a message whose exact wording carries the meaning will drift.
 */
function consoleFailure(kind: 'render' | 'config', detail: string): string {
  return kind === 'render'
    ? `pgops console error — the database was not contacted. Dynamic rendering could not be established: ${detail}`
    : `pgops console misconfigured — the database was not contacted. ${detail}`;
}

/**
 * The single seam every page runs a check through.
 *
 * `await connection()` lives HERE, once, rather than on eleven pages.
 *
 * THE MECHANISM, stated correctly — the rest of this app's comments cite this
 * paragraph, and an earlier version of it was wrong. Turbopack does NOT
 * textually inline server-side `process.env`: a build of this app leaves
 * `process.env.PGOPS_SESSION_LIMIT??"50"` intact in the server chunk, so
 * anyone who checks the "inlining" claim finds no inlining and concludes the
 * rule is cargo cult. What actually happens is EVALUATION at prerender time.
 * A statically prerendered route runs its module and component bodies inside
 * the BUILD process — where `process.env` holds the build machine's
 * environment — and freezes the RESULT into HTML. `connection()` is what
 * stops that: during a prerender it returns a promise that never resolves, so
 * the route cannot be prerendered and must wait for a real request.
 *
 * Why it matters here: the whole configuration model is
 * `docker run -e PGOPS_DATABASES=… pgops` against an image built months
 * earlier. Get it wrong and the container serves a page frozen around
 * whatever database the build machine saw — silently, forever, with no error.
 * `test/guards.test.ts` asserts every page is dynamic and that none opts back
 * into static rendering; `routes.int.test.ts` proves it end to end by building
 * with no database configured and starting against one that did not exist at
 * build time.
 *
 * It never rejects, because `runCheck` never rejects and `contextFor`'s own
 * failures — and `connection()`'s own, outside the one case above — are
 * converted here. A page renders a failed check; it must never render a
 * stack trace.
 */
export async function runCheckFor<Row, Data>(
  name: string,
  check: Check<Row, Data, void>,
): Promise<CheckResult<Data>>;
export async function runCheckFor<Row, Data, Opts>(
  name: string,
  check: Check<Row, Data, Opts>,
  opts: Opts,
): Promise<CheckResult<Data>>;
export async function runCheckFor<Row, Data, Opts>(
  name: string,
  check: Check<Row, Data, Opts>,
  opts?: Opts,
): Promise<CheckResult<Data>> {
  try {
    await connection();
  } catch (err) {
    if (!isMissingRequestStore(err)) {
      // M8: this path is the CONSOLE failing, not the database. It fires once
      // per check, so the triage page renders eight "Unavailable" panels at
      // once. See `consoleFailure` for the wording and why it matters.
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'error', message: consoleFailure('render', detail) };
    }
    // No request store: not a real Next.js request (this file's own tests,
    // for instance). Nothing to opt into dynamic rendering for; proceed.
  }
  try {
    const ctx = await contextFor(name);
    return opts === undefined
      ? await runCheck(ctx, check as Check<Row, Data, void>)
      : await runCheck(ctx, check, opts);
  } catch (err) {
    // F4: same shape and same reasoning as the M8 branch above. `contextFor`
    // reads configuration before it opens anything, so a `ConfigError` here
    // means no database was ever contacted.
    if (err instanceof ConfigError) {
      return { ok: false, reason: 'error', message: consoleFailure('config', err.message) };
    }
    return { ok: false, reason: 'unreachable', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The same seam, for a series.
 *
 * A series must go through `await connection()` for exactly the reason a
 * check must: the store URL and the database list are read at run time from
 * the process environment, and a route Next is free to prerender would freeze
 * whatever the BUILD machine saw into HTML. Calling `contextFor` directly from
 * a page — which is what this plan originally specified — reintroduces the
 * defect the docblock above exists to prevent.
 *
 * Never rejects, for the same reason: a page renders a failed series; it must
 * never render a stack trace.
 */
export async function runSeriesFor<P>(
  name: string,
  series: Series<P, void>,
  range: TimeRange,
): Promise<SeriesResult<P>>;
export async function runSeriesFor<P, Opts>(
  name: string,
  series: Series<P, Opts>,
  range: TimeRange,
  opts: Opts,
): Promise<SeriesResult<P>>;
export async function runSeriesFor<P, Opts>(
  name: string,
  series: Series<P, Opts>,
  range: TimeRange,
  opts?: Opts,
): Promise<SeriesResult<P>> {
  try {
    await connection();
  } catch (err) {
    if (!isMissingRequestStore(err)) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'error', message: consoleFailure('render', detail) };
    }
  }
  try {
    return await runSeries(await contextFor(name), series, range, opts as Opts);
  } catch (err) {
    if (err instanceof ConfigError) {
      return { ok: false, reason: 'error', message: consoleFailure('config', err.message) };
    }
    return { ok: false, reason: 'unreachable', message: err instanceof Error ? err.message : String(err) };
  }
}
