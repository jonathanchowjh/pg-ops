import type {
  Check, CheckContext, CheckResult, FailureReason, Requirement, Series, SeriesResult, SqlQuery, TimeRange,
} from './types.js';

/** Postgres SQLSTATEs we can turn into an actionable remedy. */
const UNDEFINED_TABLE = '42P01';
const INSUFFICIENT_PRIVILEGE = '42501';

function remedyFor(reason: FailureReason, requires: Requirement[] = []): string | undefined {
  if (reason === 'missing-extension') {
    const ext = requires.find((r) => r.kind === 'extension');
    return ext ? `CREATE EXTENSION ${ext.name};` : undefined;
  }
  if (reason === 'privilege') {
    const role = requires.find((r) => r.kind === 'role');
    return role ? `GRANT ${role.name} TO CURRENT_USER;` : undefined;
  }
  if (reason === 'missing-store') {
    return 'Set PGOPS_STORE_URL to a Postgres database pgops may create its own schema in.';
  }
  return undefined;
}

function classify(err: unknown, requires: Requirement[] = []): FailureReason {
  const code = (err as { code?: string })?.code;
  if (code === UNDEFINED_TABLE && requires.some((r) => r.kind === 'extension')) return 'missing-extension';
  if (code === INSUFFICIENT_PRIVILEGE) return 'privilege';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return 'unreachable';
  return 'error';
}

/**
 * Node raises an AggregateError with an empty `.message` when a host resolves
 * to several addresses and every connect attempt fails (::1 and 127.0.0.1 both
 * refused — the ordinary "database is down" case). Unwrap it, or the operator
 * sees an unexplained failure at exactly the moment they need the reason.
 *
 * Exported because capture.ts needs the same unwrapping on the STORE's
 * connect, where `PGOPS_STORE_URL=…localhost…` with nothing listening
 * produces exactly this error. It had its own copy that returned `''` for it,
 * so the scheduler logged a capture failure with no reason attached;
 * capture.test.ts holds that. NOT re-exported from index.ts — the barrel
 * publishes `runCheck` by name so that this stays internal to the package.
 */
export function messageOf(err: unknown): string {
  const e = err as { message?: string; errors?: unknown[] };
  if (e?.message) return e.message;
  if (Array.isArray(e?.errors)) {
    const parts = e.errors.map((x) => (x as Error | undefined)?.message).filter(Boolean);
    if (parts.length > 0) return parts.join('; ');
  }
  return String(err);
}

function toQuery<Opts>(sql: Check<never, never, Opts>['sql'], opts: Opts): SqlQuery {
  return typeof sql === 'string' ? { text: sql } : sql(opts);
}

/**
 * Run one query under a `statement_timeout`.
 *
 * `SET LOCAL` inside an explicit transaction, on a checked-out client — NOT
 * a bare `SET`. A bare `SET` is connection-scoped and survives the client's
 * return to the pool, so one hygiene check would silently arm a 10-second
 * timeout on whichever incident check drew that connection next, and the
 * failure would look like the database being slow rather than like pgops
 * misconfiguring it. `SET LOCAL` is discarded by COMMIT/ROLLBACK.
 *
 * The value is interpolated rather than bound because `SET LOCAL` does not
 * accept a bind parameter. `Math.trunc` plus a non-finite guard is what keeps
 * that safe: the result is provably an integer literal.
 */
async function queryWithTimeout(
  ctx: CheckContext,
  text: string,
  values: never[],
  timeoutMs: number,
): Promise<{ rows: unknown[] }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }
  const ms = Math.trunc(timeoutMs);
  const client = await ctx.target.connect();
  // pg emits a low-level 'error' event directly on the client when its
  // connection drops unexpectedly (e.g. the backend is killed mid-query),
  // IN ADDITION TO rejecting the in-flight query — the query rejection is
  // the signal the try/catch below actually acts on. `Client` extends
  // EventEmitter, and an 'error' event with no listener is a Node fatal
  // error: while a client is checked out, pg-pool has already removed its
  // own listener (it re-attaches one only once the client is idle again),
  // so without this, an unexpected disconnect crashes the entire pgops
  // process rather than failing the one check that hit it — the opposite
  // of the isolation `runCheck` exists to guarantee. Removed again in
  // `release` below so a long-lived, reused connection doesn't accumulate
  // one of these per call.
  const swallowConnectionError = () => {};
  client.on('error', swallowConnectionError);
  const release = (err?: Error): void => {
    client.removeListener('error', swallowConnectionError);
    client.release(err);
  };
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${ms}`);
    const result = await client.query(text, values);
    await client.query('COMMIT');
    // A committed transaction leaves the connection clean — no SET LOCAL,
    // no open transaction — so releasing it with no argument (return to
    // pool, reuse as-is) is correct.
    release();
    return result;
  } catch (err) {
    // ROLLBACK undoes the aborted transaction and the SET LOCAL together,
    // which is what makes a plain release() correct in the ordinary case
    // below: the connection really is clean again.
    //
    // But ROLLBACK can itself throw — e.g. the connection dropped mid-
    // transaction. When it does, the client's transaction state is unknown
    // or still aborted, and releasing it as healthy would poison the pool:
    // the next check to draw this connection gets "current transaction is
    // aborted, commands ignored until end of transaction block", which is
    // exactly the poisoned-pooled-connection failure this function exists
    // to prevent, reached by a different route. Passing the rollback error
    // to release() is what tells pg-pool to destroy the connection instead
    // of returning it to the pool — a plain release() here would not.
    try {
      await client.query('ROLLBACK');
      release();
    } catch (rollbackErr) {
      release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
    }
    // The original error is always what the operator needs to see, whether
    // or not ROLLBACK itself also failed.
    throw err;
  }
}

/**
 * Run one check. NEVER rejects.
 *
 * Isolation is the point: across sixty checks on managed Postgres, any given
 * one may be denied. One unreadable check must never blank a page.
 *
 * I1 (final review): the third parameter used to read `opts: Opts = undefined
 * as Opts`. A parameter with a default is OPTIONAL, which erased the
 * difference between "this check takes no options" and "this check takes
 * options and you forgot them". `runCheck(ctx, sessions)` typechecked, then
 * `check.sql(undefined)` dereferenced undefined at runtime — and since this
 * function never rejects, that TypeError came back as an ordinary failed
 * check ("Cannot read properties of undefined (reading 'limit')") rendered
 * on the incident page, where it reads as the DATABASE being unwell. The
 * never-reject contract is exactly what turns a loud crash into a quiet,
 * misattributed one, so the arity has to be enforced by the compiler.
 *
 * Two overloads restore that: `Opts = void` (every check with no options)
 * takes two arguments; any other `Opts` requires three. One implementation
 * signature still backs both — see run.test.ts's `@ts-expect-error` proof,
 * which `npm run typecheck:test` (not vitest) is what actually checks.
 */
export async function runCheck<Row, Data>(
  ctx: CheckContext,
  check: Check<Row, Data, void>,
): Promise<CheckResult<Data>>;
export async function runCheck<Row, Data, Opts>(
  ctx: CheckContext,
  check: Check<Row, Data, Opts>,
  opts: Opts,
): Promise<CheckResult<Data>>;
export async function runCheck<Row, Data, Opts>(
  ctx: CheckContext,
  check: Check<Row, Data, Opts>,
  opts?: Opts,
): Promise<CheckResult<Data>> {
  const version = check.requires?.find((r) => r.kind === 'version');
  if (version && ctx.serverVersion < version.min) {
    return {
      ok: false,
      reason: 'unsupported-version',
      message: `${check.id} requires server_version_num >= ${version.min}, found ${ctx.serverVersion}`,
    };
  }

  // Stamp when the database MEASURED the numbers, not when the promise settled.
  // A poll that took 5s then reads "5s ago" the moment it lands, which is true.
  const measuredAt = Date.now();
  try {
    const { text, values } = toQuery(check.sql as never, opts);
    const result = check.timeoutMs === undefined
      ? await ctx.target.query(text, values as never[])
      : await queryWithTimeout(ctx, text, values as never[], check.timeoutMs);
    const data = check.map(result.rows as Row[]);
    const verdict = check.verdict?.(data, check.thresholds ?? []) ?? null;
    // The threshold this verdict crossed, resolved HERE rather than at each
    // of the nine call sites that render a panel.
    //
    // `Threshold.because` — a required, non-empty, unit-tested sentence
    // explaining why the number matters — reached no pixel of the console
    // before this line existed, and neither did the remedy beside it. Every
    // surface that renders a verdict now gets both without asking, so a
    // page written later cannot forget to explain itself.
    //
    // `ok` deliberately resolves nothing: no threshold was crossed, so there
    // is no sentence to show, and inventing one would be the same
    // "we looked and it is fine" over-claim spec §1.1 exists against.
    const crossed = verdict === null || verdict.level === 'ok'
      ? undefined
      : check.thresholds?.find((t) => t.level === verdict.level);
    return { ok: true, data, verdict, crossed, measuredAt };
  } catch (err) {
    const reason = classify(err, check.requires);
    return { ok: false, reason, message: messageOf(err), remedy: remedyFor(reason, check.requires) };
  }
}

/**
 * Run one series. NEVER rejects — same contract and same reasoning as
 * runCheck: one unreadable series must never blank a page.
 *
 * The store check comes first and is its own reason. `missing-store` renders
 * as "set this environment variable"; reported as `error` it would read as
 * the database being unwell.
 *
 * I4 (final review): the arity is enforced by two overloads for the same
 * reason `runCheck`'s is — see run.ts's I1 docblock. `opts: Opts = undefined
 * as Opts` made the argument optional, so
 * `runSeries(ctx, historicalQueryStats, range)` typechecked and then
 * dereferenced `opts.databaseName` on undefined. Because this function never
 * rejects, that TypeError came back as an ordinary failed series and rendered
 * as the DATABASE being unwell. The never-reject contract is what turns a
 * loud crash into a quiet, misattributed one, so the compiler has to hold it.
 */
export async function runSeries<P>(
  ctx: CheckContext,
  series: Series<P, void>,
  range: TimeRange,
): Promise<SeriesResult<P>>;
export async function runSeries<P, Opts>(
  ctx: CheckContext,
  series: Series<P, Opts>,
  range: TimeRange,
  opts: Opts,
): Promise<SeriesResult<P>>;
export async function runSeries<P, Opts>(
  ctx: CheckContext,
  series: Series<P, Opts>,
  range: TimeRange,
  opts?: Opts,
): Promise<SeriesResult<P>> {
  if (!ctx.store) {
    return {
      ok: false,
      reason: 'missing-store',
      message: `${series.id} needs the pgops store, which is not configured.`,
      remedy: 'Set PGOPS_STORE_URL to a Postgres database pgops may create its own schema in.',
    };
  }
  const version = series.requires?.find((r) => r.kind === 'version');
  if (version && ctx.serverVersion < version.min) {
    return {
      ok: false,
      reason: 'unsupported-version',
      message: `${series.id} requires server_version_num >= ${version.min}, found ${ctx.serverVersion}`,
    };
  }
  const readAt = Date.now();
  try {
    return { ok: true, points: await series.read(ctx, range, opts as Opts), readAt };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
