import type { CheckContext, Tool } from '../types.js';
import { guardClient, messageOf } from '../run.js';
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

/** pgHero's "Too large" cap, adopted: planning is cheap, parsing a megabyte is not. */
export const MAX_STATEMENT_LENGTH = 10_000;

const PLAN_TIMEOUT_MS = 10_000;
/**
 * PREPARE takes an AccessShareLock on every relation the statement names, so a
 * migration holding ACCESS EXCLUSIVE would otherwise hold each plan for the
 * whole PLAN_TIMEOUT_MS — per shape, on a page that plans a hundred. A second
 * is enough to know the table is busy; the shape fails as data and the rest
 * are planned.
 */
const LOCK_TIMEOUT_MS = 1_000;

/**
 * The SQLSTATEs whose message is STRUCTURAL — it names the operator's own
 * syntax, relation, column, function or privilege, not a value.
 *
 * pgHero replaces every message it does not recognise with "Error explaining
 * query", because "data can be extracted through the Postgres error message":
 * `SELECT '42x'::int` answers with the value it choked on, and selectivity
 * estimation folds stable functions such as `current_setting(...)` at PLAN
 * time, so a cast error can carry a setting's value out. An allowlist keeps
 * that closed while still telling an operator `relation "ordrs" does not
 * exist` — which pgHero's blanket replacement does not.
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
 * although it reads no rows, so the least-privilege role the README recommends
 * (pg_read_all_stats) is refused on every application table — and Postgres's
 * message names the table, not the fix. Prose, not a statement to paste:
 * the tables are Postgres's to name, and the DDL guard holds this file to
 * containing none.
 */
const PRIVILEGE_HINT = ' Planning checks SELECT on every table a statement names, though it reads no rows: '
  + 'the pgops role needs SELECT on those tables, or pg_read_all_data for all of them.';

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
 * Plan operator-supplied statements. THE ONLY PATH by which text pgops did not
 * write reaches a monitored database, and every step is a defence. Each was
 * measured on PG 14 and 17 before it was written (P6 plan, "Verified facts").
 *
 * 1. `PREPARE` is sent as a NAMED protocol statement. Over the simple protocol
 *    a trailing `; CREATE TABLE …` runs — and an empty `values` array does not
 *    change that, node-postgres still sends a simple query. A named statement
 *    makes Postgres itself refuse ("cannot insert multiple commands into a
 *    prepared statement"): a server-side guarantee, where pgHero's
 *    `explain_safe?` scans the string for `;`. PREPARE also accepts only
 *    plannable statements, so `VACUUM` is a syntax error, not a question.
 * 2. `PREPARE` + `EXPLAIN EXECUTE` under `force_generic_plan`, not
 *    `EXPLAIN (GENERIC_PLAN)`. A named protocol statement counts `$1` as its
 *    OWN parameter, so GENERIC_PLAN through one fails ("bind message supplies
 *    0 parameters") — and binding NULLs to satisfy it yields a CUSTOM plan
 *    with the NULL folded in (`One-Time Filter: false`). This route gives a
 *    real generic plan on PG 12+, so a normalized `pg_stat_statements` shape
 *    plans on every supported version; GENERIC_PLAN would floor it at 16.
 * 3. `BEGIN READ ONLY`, always rolled back, under a statement timeout and a
 *    short lock timeout. Nothing here executes the statement; READ ONLY is
 *    so that if something ever did, it could not write.
 * 4. The connection is DESTROYED afterwards, never returned to the pool.
 *    Prepared statements survive ROLLBACK, and node-postgres caches statement
 *    names per connection and throws when one is reused with different text.
 *    A pooled connection carrying them would break the next caller to draw it.
 *
 * A statement that fails to plan is DATA (`ok: false`), so a batch of a
 * hundred query shapes survives one of them being a `SET`. A failure that is
 * not a Postgres error — the connection dying — rejects the whole batch.
 */
export async function planStatements(ctx: CheckContext, statements: readonly string[]): Promise<Planned[]> {
  if (statements.length === 0) return [];
  const client = await ctx.target.connect();
  const release = guardClient(client);
  const planned: Planned[] = [];
  try {
    for (const [i, statement] of statements.entries()) {
      const name = `pgops_explain_${i}`;
      await client.query('BEGIN READ ONLY');
      try {
        // Interpolated because SET LOCAL takes no bind parameter; constants.
        await client.query(`SET LOCAL statement_timeout = ${PLAN_TIMEOUT_MS}`);
        await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
        await client.query('SET LOCAL plan_cache_mode = force_generic_plan');
        await client.query({ name: `pgops_prepare_${i}`, text: `PREPARE ${name} AS ${statement}`, values: [] });
        const counted = await client.query<{ n: number }>(
          'SELECT cardinality(parameter_types)::int AS n FROM pg_prepared_statements WHERE name = $1',
          [name],
        );
        const parameters = counted.rows[0]?.n ?? 0;
        // Never planned with these: force_generic_plan ignores the values.
        const args = parameters > 0 ? `(${Array(parameters).fill('NULL').join(', ')})` : '';
        const explained = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
          `EXPLAIN (FORMAT JSON, VERBOSE) EXECUTE ${name}${args}`,
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
        await client.query('ROLLBACK');
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
 * #57 `explain` and #64 `best_index`, in one planning pass.
 *
 * pgHero's explain page calls `explain` and then `suggested_indexes(queries:
 * [query])` — two answers about one statement. Here the plan IS the advice's
 * input, so planning twice would be waste and could disagree with itself. Two
 * registry entries, one tool: the JOBS precedent, where `captureQueryStats`
 * and `captureSpaceStats` both name `captureOnce`.
 *
 * Divergence D2: no ANALYZE. It EXECUTES the statement, and inside a read-only
 * transaction `pg_terminate_backend(...)` and `pg_sleep(...)` still run as the
 * pgops role. pgHero keeps it off by default; pgops's only route to effects an
 * operator chooses is the audited action ladder.
 */
export const explain: Tool<{ sql: string }, Explanation> = {
  id: 'explain',
  title: 'Explain',
  run: async (ctx, { sql }) => {
    const planned = (await planStatements(ctx, [checkStatement(sql)]))[0]!;
    if (!planned.ok) throw Object.assign(new Error(planned.message), { code: planned.code });
    const [advice] = await adviseOn(ctx, [planned.plan]);
    return { plan: planned.plan, parameters: planned.parameters, advice: advice! };
  },
};
