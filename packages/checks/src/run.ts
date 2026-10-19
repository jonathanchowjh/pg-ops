import type { PoolClient } from 'pg';
import type {
  Check, CheckContext, CheckResult, FailureReason, Requirement, Series, SeriesResult, SqlQuery, TimeRange, Tool,
} from './types.js';

/** Postgres SQLSTATEs we can turn into an actionable remedy. */
const UNDEFINED_TABLE = '42P01';
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * The GRANT text for a missing-role remedy. Exported for checks that detect
 * the missing role themselves, without a privilege error (activity.ts's
 * `restricted`). apps/web's guards.test.ts allows a literal GRANT in only
 * this file and tools/advice.ts.
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
 * refused, the ordinary "database is down" case). This unwraps it.
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
 * pg emits an 'error' event on the client when its connection drops, in
 * addition to rejecting any in-flight query. An 'error' event with no
 * listener is fatal in Node, and a checked-out client has none: pg-pool
 * removes its own on acquire and re-attaches it on release. Without this, an
 * unexpected disconnect takes down the whole process.
 *
 * Every checkout in this package goes through here. The listener is removed
 * on release so a reused connection does not accumulate them. Internal to
 * the package: not re-exported from index.ts.
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
 * Every statement this package runs carries this comment, so the Queries
 * page can fold the console's own statements out of the ranking.
 *
 * It must trail the statement: PostgreSQL 18 drops a leading comment from
 * the text pg_stat_statements stores, so a prefix marker would match
 * nothing there. A trailing comment survives on 14, 16, 17 and 18, over both
 * the simple and the extended protocol.
 */
export const OWN_SQL_MARKER = '/* pgops */';

/**
 * Attach OWN_SQL_MARKER to a statement. The only place that does;
 * capture.test.ts holds this.
 *
 * The newline is required: a statement whose last line ends in a `--`
 * comment would swallow a marker appended to that same line.
 */
export function ownSql(text: string): string {
  return `${text}\n${OWN_SQL_MARKER}`;
}

function toQuery<Opts>(sql: Check<never, never, Opts>['sql'], opts: Opts): SqlQuery {
  const q = typeof sql === 'string' ? { text: sql } : sql(opts);
  return { ...q, text: ownSql(q.text) };
}

/** The longest a check waits for a lock on a relation it reads. */
const LOCK_TIMEOUT_MS = 1_000;

/**
 * Run one query under a `statement_timeout`, and a `lock_timeout` of at most
 * a second.
 *
 * The lock timeout is for the catalog reads: a size function takes
 * AccessShareLock on every relation it measures, so one table held ACCESS
 * EXCLUSIVE by a migration would otherwise hold every read of the catalog
 * for its whole statement timeout. A read that waited fails (55P03) and the
 * page says it could not look.
 *
 * `SET LOCAL` inside an explicit transaction, not a bare `SET`: a bare `SET`
 * is connection-scoped and survives the client's return to the pool, arming
 * the timeout on whichever check draws that connection next.
 *
 * The values are interpolated because `SET LOCAL` does not accept a bind
 * parameter. `Math.trunc` plus the non-finite guard make them integer
 * literals.
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
    // BEGIN and COMMIT are marked too, or they would rank on the Queries
    // page as the most-called statements.
    await client.query(ownSql('BEGIN'));
    await client.query(ownSql(`SET LOCAL statement_timeout = ${ms}`));
    await client.query(ownSql(`SET LOCAL lock_timeout = ${Math.min(ms, LOCK_TIMEOUT_MS)}`));
    const result = await client.query(text, values);
    await client.query(ownSql('COMMIT'));
    release();
    return result;
  } catch (err) {
    // If ROLLBACK itself throws (e.g. the connection dropped), the client's
    // transaction state is unknown. Passing the error to release() makes
    // pg-pool destroy the connection instead of returning it to the pool.
    try {
      await client.query(ownSql('ROLLBACK'));
      release();
    } catch (rollbackErr) {
      release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
    }
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
 * Run one check. Never rejects: one unreadable check must not blank a page.
 *
 * Two overloads so the compiler enforces arity: `Opts = void` takes two
 * arguments, any other `Opts` requires three. A forgotten `opts` would
 * otherwise come back as an ordinary failed check and read as the database
 * being unwell. run.test.ts holds this with `@ts-expect-error`, checked by
 * `npm run typecheck:test`, not vitest.
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

  // Stamped before the query, so a slow poll reads as old as it is.
  const measuredAt = Date.now();
  try {
    const { text, values } = toQuery(check.sql as never, opts);
    const result = check.timeoutMs === undefined
      ? await ctx.target.query(text, values as never[])
      : await queryWithTimeout(ctx, text, values as never[], check.timeoutMs);
    const data = check.map(result.rows as Row[]);
    const verdict = check.verdict?.(data, check.thresholds ?? []) ?? null;
    // The threshold this verdict crossed, so every surface gets its
    // `because` and `remedy`. `ok` crossed none.
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
 * Run one series. Never rejects, same contract as runCheck, and the same two
 * overloads for arity.
 *
 * The store check comes first and has its own reason: `missing-store` renders
 * as "set this environment variable", where `error` would read as the
 * database being unwell.
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
      remedy: remedyFor('missing-store'),
    };
  }
  const tooOld = belowFloor(ctx, series);
  if (tooOld) return tooOld;
  const readAt = Date.now();
  try {
    return { ok: true, points: await series.read(ctx, range, opts as Opts), readAt };
  } catch (err) {
    return { ok: false, reason: 'error', message: messageOf(err) };
  }
}

/**
 * Run one tool. Never rejects, same contract as runCheck.
 *
 * Returns a `CheckResult` with `verdict: null`, since a tool never judges, so
 * every surface that renders a check can render a tool.
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
