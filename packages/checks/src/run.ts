import type { PoolClient } from 'pg';
import type {
  Check, CheckContext, CheckResult, FailureReason, Requirement, Series, SeriesResult, SqlQuery, TimeRange, Tool,
} from './types.js';

/** Postgres SQLSTATEs we can turn into an actionable remedy. */
const UNDEFINED_TABLE = '42P01';
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * The GRANT text for a missing-role remedy, pulled out of `remedyFor` and
 * exported so a check that detects the SAME condition itself — rather than
 * through the privilege error `classify` below reacts to — can show the
 * identical fix without a second copy of the statement.
 *
 * activity.ts's `restricted` is exactly that case: no error is ever raised
 * (see its ActivityRow.sees_all docblock), so `remedyFor` never runs for it,
 * but the operator needs the same sentence. apps/web's guards.test.ts DDL
 * boundary allows a literal GRANT statement in only this file and
 * tools/advice.ts — keeping the string here, and having every other caller
 * go through this function, is what keeps that guard meaningful rather than
 * working around it with a second hardcoded copy elsewhere.
 */
export function grantRemedy(roleName: string): string {
  return `GRANT ${roleName} TO CURRENT_USER;`;
}

function remedyFor(reason: FailureReason, requires: Requirement[] = []): string | undefined {
  if (reason === 'missing-extension') {
    const ext = requires.find((r) => r.kind === 'extension');
    return ext ? `CREATE EXTENSION ${ext.name};` : undefined;
  }
  if (reason === 'privilege') {
    const role = requires.find((r) => r.kind === 'role');
    return role ? grantRemedy(role.name) : undefined;
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

/**
 * Check-out guard for a pooled client: attach an 'error' listener, and hand
 * back the `release` that removes it again.
 *
 * pg emits a low-level 'error' event directly on the client when its
 * connection drops unexpectedly (e.g. the backend is killed mid-query, the
 * server restarts, a failover moves the primary), IN ADDITION TO rejecting
 * any in-flight query — the query rejection is the signal callers actually
 * act on. `Client` extends EventEmitter, and an 'error' event with no
 * listener is a Node FATAL error. While a client is checked out it has no
 * listener: pg-pool removes its own on acquire (pg-pool/index.js, in
 * `_acquireClient`) and re-attaches it only on release (`_release`). So
 * without this, an unexpected disconnect does not fail the one operation
 * that hit it — it takes down the whole pgops process.
 *
 * Removed again on release so a long-lived, reused connection does not
 * accumulate one listener per check-out.
 *
 * A bare exported function, and it lives HERE for the same reason `messageOf`
 * does (see its docblock): every checkout in this package needs it, and three
 * hand-rolled copies of a subtle four-line idiom is how one of them ends up
 * missing — which is exactly what happened. `queryWithTimeout` had it and
 * carried this reasoning; `captureOnce` and `withAdvisoryLock` each hold a
 * client across far LONGER windows and had nothing. captureOnce's window
 * spans two scans of the monitored database plus the whole write transaction,
 * every five minutes, forever, on a file whose contract is "NEVER throws,
 * because an unhandled rejection on a background timer terminates the web
 * process". Not re-exported from index.ts — internal to the package, like
 * `messageOf`.
 */
export function guardClient(client: PoolClient): (err?: Error) => void {
  const swallowConnectionError = () => {};
  client.on('error', swallowConnectionError);
  return (err?: Error): void => {
    client.removeListener('error', swallowConnectionError);
    client.release(err);
  };
}

/**
 * Every statement this package runs carries this comment, which is what lets
 * the Queries page fold the console's own catalog reads out of the ranking
 * the way it already folds its own sessions and relations.
 *
 * It goes at the END, on its own line — see `ownSql`, the one place that
 * attaches it. It was a LEADING comment until the 14/16/17/18 gate matrix
 * caught what that costs: PostgreSQL 18 excludes a leading comment from the
 * text pg_stat_statements stores. Same statement, two servers:
 *
 *     PG 17   [/* pgops *\/ SELECT $1 AS marked]
 *     PG 18   [SELECT $1 AS marked]
 *
 * So on 18 a prefix marker does not merely move, it is gone — `query LIKE
 * marker || '%'` matches nothing, `ownShapes` reads 0, and the fold silently
 * stops folding. The Queries page would then blame the operator's database
 * for pgops's own polling, which is the entire defect this marker exists to
 * prevent, restored on the newest server anyone would deploy against.
 *
 * A trailing comment survives on all four versions, over the extended
 * protocol as well as the simple one.
 */
export const OWN_SQL_MARKER = '/* pgops */';

/**
 * Attach OWN_SQL_MARKER to a statement.
 *
 * Every marked statement in this package goes through here instead of
 * interpolating the marker itself, so the position is decided once. It was
 * interpolated at ten call sites before, which is why a server-side change
 * to one comment position was a ten-file fix; capture.test.ts now enforces
 * that new marked SQL comes through this function.
 *
 * The newline is load-bearing, not formatting: a statement whose last line
 * ends in a `--` comment would swallow a marker appended to that same line.
 * With the newline, a trailing `--` comment is measured to be harmless.
 */
export function ownSql(text: string): string {
  return `${text}\n${OWN_SQL_MARKER}`;
}

function toQuery<Opts>(sql: Check<never, never, Opts>['sql'], opts: Opts): SqlQuery {
  const q = typeof sql === 'string' ? { text: sql } : sql(opts);
  return { ...q, text: ownSql(q.text) };
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
  const release = guardClient(client);
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

/** The `unsupported-version` failure, when the server is older than a declared floor. */
function belowFloor(
  ctx: CheckContext,
  { id, requires }: { id: string; requires?: Requirement[] },
): { ok: false; reason: 'unsupported-version'; message: string } | undefined {
  const version = requires?.find((r) => r.kind === 'version');
  if (!version || ctx.serverVersion >= version.min) return undefined;
  return {
    ok: false,
    reason: 'unsupported-version',
    message: `${id} requires server_version_num >= ${version.min}, found ${ctx.serverVersion}`,
  };
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
  const tooOld = belowFloor(ctx, check);
  if (tooOld) return tooOld;

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
  const tooOld = belowFloor(ctx, series);
  if (tooOld) return tooOld;
  const readAt = Date.now();
  try {
    return { ok: true, points: await series.read(ctx, range, opts as Opts), readAt };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run one tool. NEVER rejects — the same contract as runCheck, for the same
 * reason: a page renders a failed tool; it must never render a stack trace.
 *
 * Returns a `CheckResult` with `verdict: null` rather than a result type of
 * its own. A tool answers and never judges (§2.2), and that one field is the
 * only difference — so every surface that renders a check renders a tool with
 * no new component, and `CheckPanel`'s failure branch (reason, message,
 * remedy) stays written once.
 *
 * No overloads, unlike runCheck: every tool takes an input, so the arity
 * problem I1 describes cannot arise.
 */
export async function runTool<Input, Data>(
  ctx: CheckContext,
  tool: Tool<Input, Data>,
  input: Input,
): Promise<CheckResult<Data>> {
  const tooOld = belowFloor(ctx, tool);
  if (tooOld) return tooOld;
  const measuredAt = Date.now();
  try {
    return { ok: true, data: await tool.run(ctx, input), verdict: null, measuredAt };
  } catch (err) {
    const reason = classify(err, tool.requires);
    return { ok: false, reason, message: messageOf(err), remedy: remedyFor(reason, tool.requires) };
  }
}
