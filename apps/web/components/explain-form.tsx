'use client';

import { useState, useTransition } from 'react';
import type { CheckResult, Explanation, IndexAdvice, PlanNode } from '@pgops/checks';
import { CheckPanel } from './check-panel';
import { formatCount } from '@/lib/format';

type Answer =
  | { kind: 'result'; result: CheckResult<Explanation> }
  | { kind: 'error'; message: string };

/**
 * Ask the tier-0 route for a statement's generic plan. A POST body, never
 * the URL: a statement can carry a secret. Never rejects: what went wrong is
 * the answer.
 */
async function explainStatement(name: string, sql: string): Promise<Answer> {
  try {
    const res = await fetch(`/api/db/${name}/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
    const parsed = (await res.json().catch(() => ({}))) as { error?: string } & Partial<CheckResult<Explanation>>;
    if (typeof parsed.error === 'string') return { kind: 'error', message: parsed.error };
    if (typeof parsed.ok === 'boolean') return { kind: 'result', result: parsed as CheckResult<Explanation> };
    return { kind: 'error', message: `HTTP ${res.status}` };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** A plan and its index advice, or why there is none. The statement is never echoed here. */
function Shown({ answer }: { answer: Answer }) {
  if (answer.kind === 'error') return <p role="alert" className="text-sm text-destructive">{answer.message}</p>;
  return (
    <CheckPanel title="Plan" result={answer.result}>
      {(d) => (
        <div className="space-y-4">
          {/* A generic plan estimates for no particular value, so its row counts can differ from one real value's. */}
          {d.parameters > 0 ? (
            <p className="text-sm text-muted-foreground">
              Generic plan: {d.parameters === 1 ? '$1 was' : `$1–$${d.parameters} were`} planned without values.
            </p>
          ) : null}
          <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{planLines(d.plan).join('\n')}</pre>
          <div className="space-y-2">
            <h3 className="font-semibold">Index advice</h3>
            <p className="text-sm text-muted-foreground">
              Suggested from column statistics by pgHero&rsquo;s heuristic. Confirm before building anything; pgops never runs these.
            </p>
            <IndexAdviceList advice={d.advice} />
          </div>
        </div>
      )}
    </CheckPanel>
  );
}

/** Statement in; plan and index advice out. The tool at `/explain`, for a statement pasted from anywhere. */
export function ExplainForm({ name }: { name: string }) {
  const [sql, setSql] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [pending, startTransition] = useTransition();
  const blocked = pending || sql.trim() === '';
  const send = (): void => {
    if (blocked) return;
    startTransition(async () => { setAnswer(await explainStatement(name, sql)); });
  };
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="explain-sql" className="sr-only">Statement</label>
        <textarea
          id="explain-sql"
          className="block min-h-32 w-full rounded-md border bg-card p-2 font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          placeholder="SELECT * FROM orders WHERE customer_id = $1"
          spellCheck={false}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
        />
        <div className="flex justify-end">
          <button
            type="button"
            className="rounded-[5px] border bg-card px-2 py-0.5 text-xs/[18px] text-foreground hover:bg-muted disabled:opacity-50"
            disabled={blocked}
            onClick={send}
          >
            Explain
          </button>
        </div>
      </div>
      {answer === null ? null : <Shown answer={answer} />}
    </div>
  );
}

/**
 * Explain a statement the page already shows, in place: the head's one
 * action on a statement's page. The plan opens under the head and folds
 * away again; it is asked for once.
 *
 * `statement` crosses to the browser as a prop, so the page redacts it at
 * the call site. guards.test.ts holds that.
 */
export function ExplainHere({ name, statement }: { name: string; statement: string }) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [pending, startTransition] = useTransition();
  const toggle = (): void => {
    setOpen(!open);
    if (open || answer !== null) return;
    startTransition(async () => { setAnswer(await explainStatement(name, statement)); });
  };
  return (
    <>
      <button
        type="button"
        aria-pressed={open}
        disabled={pending}
        className="ml-auto rounded-[5px] border bg-card px-2 py-0.5 text-xs/[18px] text-foreground hover:bg-muted aria-pressed:bg-foreground aria-pressed:text-card disabled:opacity-50"
        onClick={toggle}
      >
        Explain
      </button>
      {open && answer !== null ? <div className="basis-full"><Shown answer={answer} /></div> : null}
    </>
  );
}

/**
 * What pgops concluded about each sequential scan.
 *
 * A suggestion is shown as the statement to run: pgops never builds an index
 * itself. A scan with no suggestion shows why.
 */
function IndexAdviceList({ advice }: { advice: readonly IndexAdvice[] }) {
  if (advice.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sequential scans — the planner found an index for every relation it reads.
      </p>
    );
  }
  return (
    <ul className="space-y-3 text-sm">
      {advice.map((a, i) => (
        <li key={`${a.schema}.${a.table}.${i}`} className="space-y-1">
          <p className="font-mono">{a.schema}.{a.table}</p>
          {a.found && a.suggestion && a.coveredBy === undefined ? (
            <>
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{a.suggestion.statement}</pre>
              {a.rowProgression ? (
                <p className="text-muted-foreground">
                  Rows: {a.rowProgression.map((n) => formatCount(n)).join(' → ')}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">{a.explanation ?? 'No suggestion.'}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

const PLAN_DETAILS = [
  'Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter',
  'Filter', 'One-Time Filter', 'Sort Key', 'Group Key',
] as const;

const AGGREGATE: Record<string, string> = { Sorted: 'GroupAggregate', Hashed: 'HashAggregate', Mixed: 'MixedAggregate' };

/** Postgres's `quote_identifier`, minus its keyword list: bare when plainly an identifier. */
const ident = (id: string) => (/^[a-z_][a-z0-9_$]*$/.test(id) ? id : `"${id.replace(/"/g, '""')}"`);

/**
 * A node's name as text EXPLAIN prints it. JSON splits it across fields —
 * `"Node Type": "Hash Join"` with `"Join Type": "Left"` is a Hash Left Join —
 * and printing the node type alone turns a left join into an inner one.
 * Transcribed from explain.c's ExplainNode and held to real output by
 * plan-lines.test.ts.
 */
function nodeName(node: PlanNode, str: (k: string) => string | undefined): string {
  const type = node['Node Type'];
  let name = type;
  if (type === 'ModifyTable') name = str('Operation') ?? type;
  else if (type === 'Aggregate') name = AGGREGATE[str('Strategy') ?? ''] ?? type;
  else if (type === 'SetOp') {
    name = `${str('Strategy') === 'Hashed' ? 'HashSetOp' : 'SetOp'}${str('Command') ? ` ${str('Command')}` : ''}`;
  }
  const partial = str('Partial Mode');
  if (partial === 'Partial' || partial === 'Finalize') name = `${partial} ${name}`;
  if (node['Parallel Aware'] === true) name = `Parallel ${name}`;
  const join = str('Join Type');
  if (join !== undefined && join !== 'Inner') {
    name = type === 'Nested Loop' ? `${name} ${join} Join` : `${name.replace(/ Join$/, '')} ${join} Join`;
  }
  if (str('Scan Direction') === 'Backward') name += ' Backward';
  return name;
}

/**
 * What a node reads: `using <index>` and `on [schema.]object [alias]`, the
 * alias only where it differs — explain.c's ExplainScanTarget. A Bitmap Index
 * Scan reads the index itself, so it is `on` the index.
 */
function target(node: PlanNode, str: (k: string) => string | undefined): string {
  const index = str('Index Name');
  if (index !== undefined && node['Node Type'] === 'Bitmap Index Scan') return ` on ${ident(index)}`;
  const object = str('Relation Name') ?? str('Function Name') ?? str('CTE Name') ?? str('Tuplestore Name');
  const alias = str('Alias');
  const schema = str('Schema');
  let out = index === undefined ? '' : ` using ${ident(index)}`;
  if (object === undefined && alias === undefined) return out;
  out += ' on';
  if (object !== undefined) out += ` ${schema === undefined ? '' : `${ident(schema)}.`}${ident(object)}`;
  if (alias !== undefined && alias !== object) out += ` ${ident(alias)}`;
  return out;
}

/**
 * A JSON plan as the indented text `EXPLAIN` prints.
 *
 * pgops plans as JSON because index advice needs the structure. This
 * reproduces the text layout: six columns of indent per level, `->` before
 * every child, details two past the node they belong to, and an InitPlan or
 * SubPlan under its own name, its subtree two further in. Node lines match
 * real output exactly (plan-lines.test.ts); the details are a subset, with no
 * `Output:`.
 */
export function planLines(node: PlanNode, depth = 0, pad = 0): string[] {
  const indent = depth === 0 ? '' : `${' '.repeat(6 * (depth - 1) + 2 + pad)}->  `;
  const detailIndent = ' '.repeat(6 * depth + 2 + pad);
  const str = (k: string) => (typeof node[k] === 'string' ? (node[k] as string) : undefined);
  const num = (k: string) => (typeof node[k] === 'number' ? (node[k] as number) : undefined);

  const total = num('Total Cost');
  const cost = total === undefined ? ''
    : `  (cost=${(num('Startup Cost') ?? 0).toFixed(2)}..${total.toFixed(2)}`
      + ` rows=${num('Plan Rows') ?? 0} width=${num('Plan Width') ?? 0})`;

  const lines = [`${indent}${nodeName(node, str)}${target(node, str)}${cost}`];
  for (const key of PLAN_DETAILS) {
    const value = node[key];
    if (typeof value === 'string') lines.push(`${detailIndent}${key}: ${value}`);
    else if (Array.isArray(value)) lines.push(`${detailIndent}${key}: ${value.join(', ')}`);
  }
  for (const child of node.Plans ?? []) {
    const subplan = typeof child['Subplan Name'] === 'string' ? child['Subplan Name'] : undefined;
    if (subplan === undefined) lines.push(...planLines(child, depth + 1, pad));
    else lines.push(`${detailIndent}${subplan}`, ...planLines(child, depth + 1, pad + 2));
  }
  return lines;
}
