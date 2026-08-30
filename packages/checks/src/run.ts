import type { Check, CheckContext, CheckResult, FailureReason, Requirement, SqlQuery } from './types.js';

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
 */
function messageOf(err: unknown): string {
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
    const result = await ctx.target.query(text, values as never[]);
    const data = check.map(result.rows as Row[]);
    const verdict = check.verdict?.(data, check.thresholds ?? []) ?? { level: 'ok' as const };
    return { ok: true, data, verdict, measuredAt };
  } catch (err) {
    const reason = classify(err, check.requires);
    return { ok: false, reason, message: messageOf(err), remedy: remedyFor(reason, check.requires) };
  }
}
