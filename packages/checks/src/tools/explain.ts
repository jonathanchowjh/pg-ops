import type { CheckContext, Tool } from '../types.js';
import { guardClient, messageOf, ownSql } from '../run.js';
import { adviseOn, type IndexAdvice } from './advice.js';

/** One node of `EXPLAIN (FORMAT JSON)` output. Only the keys pgops reads are named. */
export interface PlanNode {
  'Node Type': string;
  Plans?: PlanNode[];
  [field: string]: unknown;
}

export type Planned =
  | { ok: true; plan: PlanNode; parameters: number }
  | { ok: false; code: string; message: string };

/** Longest statement accepted for planning, in characters. */
export const MAX_STATEMENT_LENGTH = 10_000;

const PLAN_TIMEOUT_MS = 10_000;
/**
 * PREPARE takes an AccessShareLock on every relation the statement names, so a
 * migration holding ACCESS EXCLUSIVE would otherwise hold each plan for the
 * whole PLAN_TIMEOUT_MS, per shape. With this the shape fails as data and
 * the rest are planned.
 */
const LOCK_TIMEOUT_MS = 1_000;

/**
 * The SQLSTATEs whose message is structural: it names the operator's own
 * syntax, relation, column, function or privilege, not a value. Only these
 * messages are shown.
 *
 * Other messages can leak data: `SELECT '42x'::int` answers with the value
 * it choked on, and stable functions such as `current_setting(...)` are
 * folded at plan time, so a cast error can carry a setting's value out.
 */
const STRUCTURAL = new Set([
  '42601', // syntax_error — including "cannot insert multiple commands"
  '42P01', // undefined_table
  '42703', // undefined_column
  '42883', // undefined_function
  '42702', // ambiguous_column
  '42725', // ambiguous_function
  '42804', // datatype_mismatch
  '42P18', // indeterminate_datatype — "$2" with no "$1"
  '42501', // insufficient_privilege
  '0A000', // feature_not_supported
  '55P03', // lock_not_available — the lock timeout
  '57014', // query_canceled — the plan timeout
]);

/**
 * Appended to 42501. EXPLAIN checks SELECT on every table the statement names
 * although it reads no rows, so a role with only pg_read_all_stats is
 * refused on every application table. Prose, not a GRANT to paste: the DDL
 * guard holds this file to containing none.
 */
const PRIVILEGE_HINT = ' Planning checks SELECT on every table a statement names, though it reads no rows: '
  + 'the pgops role needs SELECT on those tables, or pg_read_all_data for all of them.';

interface PlanOpts {
  /** How long a PREPARE may wait for a table's lock. The scheduler passes 100: it must never queue behind a migration. */
  lockTimeoutMs?: number;
  /** How long one plan may take. The scheduler passes 1000: nobody is waiting on its plans. */
  statementTimeoutMs?: number;
}

/** A positive whole number of milliseconds, else the default: it is interpolated into SET LOCAL. */
function millis(asked: number | undefined, fallback: number): number {
  const ms = Math.trunc(Number(asked ?? fallback));
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

/** The tables a plan reads or writes: every node that names a relation, schema-qualified, sorted, once each. */
export function relationsOf(plan: PlanNode): string[] {
  const out = new Set<string>();
  const walk = (n: PlanNode): void => {
    const rel = n['Relation Name'];
    const schema = n['Schema'];
    if (typeof rel === 'string' && typeof schema === 'string') out.add(`${schema}.${rel}`);
    for (const child of n.Plans ?? []) walk(child);
  };
  walk(plan);
  return [...out].sort();
}

const DISCARD = new Error('pgops: discarding a connection that holds prepared statements');

function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** Trimmed; throws on an empty statement or one over MAX_STATEMENT_LENGTH. */
export function checkStatement(sql: string): string {
  const trimmed = sql.trim();
  if (trimmed === '') throw new Error('Nothing to explain: the statement is empty.');
  if (trimmed.length > MAX_STATEMENT_LENGTH) {
    throw new Error(`The statement is ${trimmed.length} characters; the limit is ${MAX_STATEMENT_LENGTH}.`);
  }
  return trimmed;
}

/**
 * Plan operator-supplied statements. The only path by which text pgops did
 * not write reaches a monitored database.
 *
 * 1. `PREPARE` is sent as a named protocol statement. Over the simple
 *    protocol a trailing `; CREATE TABLE …` runs, and an empty `values` array
 *    does not change that: node-postgres still sends a simple query. With a
 *    named statement Postgres itself refuses ("cannot insert multiple
 *    commands into a prepared statement"). PREPARE also accepts only
 *    plannable statements, so `VACUUM` is a syntax error.
 * 2. `PREPARE` + `EXPLAIN EXECUTE` under `force_generic_plan`, not
 *    `EXPLAIN (GENERIC_PLAN)`. A named protocol statement counts `$1` as its
 *    own parameter, so GENERIC_PLAN through one fails ("bind message supplies
 *    0 parameters"), and binding NULLs to satisfy it yields a custom plan
 *    with the NULL folded in. This route gives a real generic plan on PG 12+;
 *    GENERIC_PLAN needs 16.
 * 3. `BEGIN READ ONLY`, always rolled back, under a statement timeout and a
 *    short lock timeout. Nothing here executes the statement; READ ONLY is
 *    so that if something ever did, it could not write.
 * 4. The connection is destroyed afterwards, never returned to the pool.
 *    Prepared statements survive ROLLBACK, and node-postgres caches statement
 *    names per connection and throws when one is reused with different text.
 *
 * A statement that fails to plan is data (`ok: false`), so one bad shape
 * does not fail a batch. A failure that is not a Postgres error, such as the
 * connection dying, rejects the whole batch.
 */
export async function planStatements(
  ctx: CheckContext, statements: readonly string[], opts: PlanOpts = {},
): Promise<Planned[]> {
  if (statements.length === 0) return [];
  const stmtMs = millis(opts.statementTimeoutMs, PLAN_TIMEOUT_MS);
  const lockMs = millis(opts.lockTimeoutMs, LOCK_TIMEOUT_MS);
  const client = await ctx.target.connect();
  const release = guardClient(client);
  const planned: Planned[] = [];
  try {
    for (const [i, statement] of statements.entries()) {
      const name = `pgops_explain_${i}`;
      // The envelope is marked as pgops's own. The PREPARE is not: it
      // carries the operator's statement, which this package never marks.
      await client.query(ownSql('BEGIN READ ONLY'));
      try {
        // Interpolated because SET LOCAL takes no bind parameter; integers, made so by `millis`.
        await client.query(ownSql(`SET LOCAL statement_timeout = ${stmtMs}`));
        await client.query(ownSql(`SET LOCAL lock_timeout = ${lockMs}`));
        await client.query(ownSql('SET LOCAL plan_cache_mode = force_generic_plan'));
        await client.query({ name: `pgops_prepare_${i}`, text: `PREPARE ${name} AS ${statement}`, values: [] });
        const counted = await client.query<{ n: number }>(
          ownSql('SELECT cardinality(parameter_types)::int AS n FROM pg_prepared_statements WHERE name = $1'),
          [name],
        );
        const parameters = counted.rows[0]?.n ?? 0;
        // Never planned with these: force_generic_plan ignores the values.
        const args = parameters > 0 ? `(${Array(parameters).fill('NULL').join(', ')})` : '';
        const explained = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
          ownSql(`EXPLAIN (FORMAT JSON, VERBOSE) EXECUTE ${name}${args}`),
        );
        planned.push({ ok: true, plan: explained.rows[0]!['QUERY PLAN'][0]!.Plan, parameters });
      } catch (err) {
        const code = sqlState(err);
        if (code === undefined) throw err;
        planned.push({
          ok: false,
          code,
          message: !STRUCTURAL.has(code)
            ? `Postgres could not plan this statement (SQLSTATE ${code}).`
            : code === '42501' ? `${messageOf(err)}.${PRIVILEGE_HINT}` : messageOf(err),
        });
      } finally {
        await client.query(ownSql('ROLLBACK'));
      }
    }
    release(DISCARD);
    return planned;
  } catch (err) {
    release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

export interface Explanation { plan: PlanNode; parameters: number; advice: IndexAdvice[] }

/**
 * A statement's plan and its index advice, from one planning pass: the plan
 * is the advice's input.
 *
 * No ANALYZE. It executes the statement, and inside a read-only transaction
 * `pg_terminate_backend(...)` and `pg_sleep(...)` still run as the pgops
 * role.
 */
export const explain: Tool<{ sql: string }, Explanation> = {
  id: 'explain',
  run: async (ctx, { sql }) => {
    const planned = (await planStatements(ctx, [checkStatement(sql)]))[0]!;
    if (!planned.ok) throw Object.assign(new Error(planned.message), { code: planned.code });
    const [advice] = await adviseOn(ctx, [planned.plan]);
    return { plan: planned.plan, parameters: planned.parameters, advice: advice! };
  },
};
