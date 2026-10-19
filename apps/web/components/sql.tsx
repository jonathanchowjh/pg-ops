import { redactSecrets } from '@pgops/checks';
import type { StatementNode, TableNode, Tree } from '@/lib/tree';

/**
 * A statement safe to put anywhere: collapsed to one line, then redacted.
 *
 * The order matters. `redactSecrets`'s quoted-literal rules are scoped to a
 * single line on purpose, so a secret split across two lines gets only its
 * first line masked:
 *   ALTER USER app WITH PASSWORD 'hun\nter2';  ->  … PASSWORD ***\nter2';
 *
 * Exported because anything handed to a client component is serialised into
 * the RSC payload before that component runs, so a client component cannot
 * redact its own props and the call site must. The guard in
 * test/guards.test.ts requires this function at every such call site.
 */
export function safeStatement(text: string): string {
  return redactSecrets(text.replace(/\s+/g, ' ').trim());
}

/**
 * The tree as it may be handed to a client component: every statement
 * through `safeStatement`. Every text the tree holds is already a shape,
 * from the sampler or the capture; this is the guard that the page does not
 * depend on it. guards.test.ts holds that the page calls this at the
 * `<TreeView>` and `<RowsView>` call sites.
 */
export function redactTree(tree: Tree): Tree {
  const statement = (s: StatementNode): StatementNode => ({ ...s, text: s.text === null ? null : safeStatement(s.text) });
  const table = (t: TableNode): TableNode => ({ ...t, statements: t.statements.map(statement) });
  return { ...tree, tables: tree.tables.map(table), none: tree.none === null ? null : table(tree.none), flat: tree.flat.map(statement) };
}

/**
 * The only component permitted to render a query string, so that
 * `redactSecrets` runs on every rendered query. A guard test asserts that no
 * page renders a `query` field outside it.
 */
export function Sql({ children, whole = false }: {
  children: string | null | undefined;
  /** The statement once, in full: wrapped, never clamped. */
  whole?: boolean;
}) {
  if (children == null) return <span>—</span>;

  // Collapsing loses nothing for the reader: a rendered statement is wrapped
  // and clamped, never laid out as source.
  const oneLine = safeStatement(children);
  if (oneLine === '') return <span>—</span>;

  if (whole) return <code className="block font-mono text-xs/5 break-words whitespace-pre-wrap">{oneLine}</code>;

  // Clamped, not scrolled: `overflow-x: auto` computes the other axis from
  // `visible` to `auto` too, so each statement would be a two-axis scroll
  // container that captures a trackpad gesture beginning over it. `ui/table`
  // still scrolls the table sideways as one piece.
  //
  // `whitespace-normal` is load-bearing. `ui/table`'s TableCell carries
  // `whitespace-nowrap`, which inherits into this element; without the
  // override the statement never wraps and `line-clamp-2` clips it mid-token
  // with no ellipsis.
  return (
    <code className="line-clamp-2 max-w-full font-mono text-xs break-words whitespace-normal">
      {oneLine}
    </code>
  );
}
