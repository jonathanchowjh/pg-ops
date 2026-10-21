import { connection } from 'next/server';
import type { Pool } from 'pg';
import { cache } from 'react';
import {
  CHECKS, messageOf, runCheck, runSeries, runTool,
  type Check, type CheckContext, type CheckResult, type FailureReason, type Series, type SeriesResult,
  type TimeRange, type Tool,
} from '@pgops/checks';
// Extensionless, not './pools.js': Next's webpack/Turbopack resolvers do not
// map a literal ".js" specifier onto a sibling ".ts" file, unlike tsc and
// Vite. This is local to apps/web; the rest of the repo keeps ".js".
import { contextFor, storePool } from './pools';
import { ConfigError } from './config';

/**
 * `connection()` throws when called with no active Next.js request store,
 * tagging the error with this code (see
 * https://nextjs.org/docs/messages/next-dynamic-api-wrong-context). That is
 * the case in this module's own integration test, which calls `runCheckFor`
 * with no Next server started. Only this code is treated as "no request
 * scope, proceed anyway"; any other failure out of `connection()` becomes
 * `ok:false` below.
 */
const NO_REQUEST_STORE = 'E251';

/**
 * Exported for check-seam.test.ts. Swallowing anything other than a missing
 * request store would let a genuine dynamic-rendering failure render as a
 * success. A real prerender does not reach here: `connection()` returns a
 * hanging promise during prerendering rather than throwing.
 */
export function isMissingRequestStore(err: unknown): boolean {
  return (err as { __NEXT_ERROR_CODE?: string } | null)?.__NEXT_ERROR_CODE === NO_REQUEST_STORE;
}

/**
 * `await connection()`, in the one place every page's reads pass through.
 * Resolves to null when rendering is dynamic, or to what went wrong.
 *
 * A statically prerendered route runs its module and component bodies inside
 * the build process — where `process.env` holds the build machine's
 * environment — and freezes the result into HTML. `connection()` is what
 * stops that: during a prerender it returns a promise that never resolves, so
 * the route cannot be prerendered and must wait for a real request. (The
 * hazard is evaluation at prerender time; Turbopack does not textually inline
 * server-side `process.env`.)
 *
 * `test/guards.test.ts` asserts every page is dynamic and that none opts back
 * into static rendering; `routes.int.test.ts` proves it end to end.
 */
async function dynamicRendering(): Promise<string | null> {
  try {
    await connection();
    return null;
  } catch (err) {
    // No request store: not a real Next.js request. Proceed.
    if (isMissingRequestStore(err)) return null;
    return messageOf(err);
  }
}

type Failure = { ok: false; reason: FailureReason; message: string };

/**
 * Run `run` against one database's context. Never rejects: the runners it is
 * given never reject, and a failure to establish dynamic rendering or to
 * build the context is converted here.
 *
 * The two console failures are worded as the console failing, not the
 * database: both render in the panel that renders a sick database, and
 * `FailureReason` has no member for "the web layer is misconfigured", so the
 * distinction lives entirely in these strings.
 */
async function withContext<R>(name: string, run: (ctx: CheckContext) => Promise<R>): Promise<R | Failure> {
  const broken = await dynamicRendering();
  if (broken !== null) {
    return {
      ok: false,
      reason: 'error',
      message: 'pgops console error — the database was not contacted. '
        + `Dynamic rendering could not be established: ${broken}`,
    };
  }
  try {
    return await run(await contextFor(name));
  } catch (err) {
    // `contextFor` reads configuration before it opens anything, so a
    // `ConfigError` here means no database was contacted.
    if (err instanceof ConfigError) {
      return {
        ok: false,
        reason: 'error',
        message: `pgops console misconfigured — the database was not contacted. ${err.message}`,
      };
    }
    return { ok: false, reason: 'unreachable', message: messageOf(err) };
  }
}

/**
 * The single seam every page runs a check through. A page must not call
 * `contextFor` directly.
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
  return withContext(name, (ctx) => (opts === undefined
    ? runCheck(ctx, check as Check<Row, Data, void>)
    : runCheck(ctx, check, opts)));
}

/** The same seam, for a series. */
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
  return withContext(name, (ctx) => runSeries(ctx, series, range, opts as Opts));
}

/**
 * The same seam, for a tool. A tool's result is a `CheckResult`: the same
 * envelope as a check, rendered the same way.
 */
export async function runToolFor<Input, Data>(
  name: string,
  tool: Tool<Input, Data>,
  input: Input,
): Promise<CheckResult<Data>> {
  return withContext(name, (ctx) => runTool(ctx, tool, input));
}

/**
 * `off` is no store configured, which is a setting and not a fault; each
 * caller words it for what it would have shown.
 */
export type StoreRead<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'off' | 'error'; message: string };

/**
 * The same seam, for a page reading the store directly: cached findings and
 * history that involve no monitored database. Never rejects.
 */
export async function readStore<T>(read: (store: Pool) => Promise<T>): Promise<StoreRead<T>> {
  const broken = await dynamicRendering();
  if (broken !== null) return { ok: false, kind: 'error', message: `pgops console error — ${broken}` };
  const store = storePool(process.env);
  if (store === null) return { ok: false, kind: 'off', message: 'History is off.' };
  try {
    return { ok: true, value: await read(store) };
  } catch (err) {
    return { ok: false, kind: 'error', message: messageOf(err) };
  }
}

/**
 * The server's account of itself, once a request: the layout states it on
 * every page, and the table page asks whether it is a standby. `cache`
 * shares one read between them, on each poll.
 */
export const identityFor = cache((name: string) => runCheckFor(name, CHECKS.identity));
