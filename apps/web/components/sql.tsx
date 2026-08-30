import { redactSecrets } from '@pgops/checks';

/**
 * THE ONLY component permitted to render a query string.
 *
 * Spec §7.3 requires `redactSecrets` on every rendered query, not just on
 * export — and "remember to call it" is not a mechanism. Routing every query
 * through one component makes the rule mechanically checkable: Task 11's guard
 * asserts that no page renders a `query` field outside this component.
 */
export function Sql({ children }: { children: string | null | undefined }) {
  if (children == null) return <span>—</span>;

  // Collapsed to one line BEFORE redacting, and that order is the whole point
  // (F2, final review). `redactSecrets`'s quoted-literal rules are scoped to a
  // single line on purpose — an unterminated literal must not be able to
  // swallow a whole document up to some unrelated apostrophe — so a secret
  // that a newline splits across two lines gets only its first line masked:
  //   ALTER USER app WITH PASSWORD 'hun\nter2';  →  … PASSWORD ***\nter2';
  // The TUI used to guarantee single-line input to that matcher
  // (core/format.ts's `truncateQuery`); P1b deleted that file, and this
  // component was handing `pg_stat_activity.query` through raw. Nothing
  // replaced the guarantee, so it is restored here, at the one caller that
  // renders a query — `packages/checks` gains no behaviour this phase.
  //
  // Lossless for the reader either way: this renders in a single-line, x-
  // scrolling `<code>` block, so the newlines were never visible as newlines.
  const oneLine = children.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return <span>—</span>;

  return <code className="block max-w-full overflow-x-auto font-mono text-xs">{redactSecrets(oneLine)}</code>;
}
