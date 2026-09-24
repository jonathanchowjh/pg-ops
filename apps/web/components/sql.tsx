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
  // Lossless for the reader either way: a rendered statement is wrapped and
  // clamped, never laid out as source, so the newlines were never visible as
  // newlines.
  const oneLine = children.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return <span>—</span>;

  // CLAMPED, NOT SCROLLED, and the reason is a rule in the overflow spec
  // rather than a taste: `overflow-x: auto` computes the OTHER axis from
  // `visible` to `auto` too, so every statement on the page was a two-axis
  // scroll container. The Queries page rendered a hundred of them, each 16px
  // tall and 900px wide over a line that could be 23,000px long, and a
  // trackpad gesture that begins over any one of them is captured by it —
  // the page stopped scrolling under the pointer for most of its own area.
  //
  // Two lines is about 200 characters, which identifies a statement; the
  // whole text belongs on the query's own page, where there is room to read
  // it. Inside a table the row also stays one height whatever it holds, and
  // `ui/table` still scrolls the table sideways as ONE piece, which is the
  // single horizontal scroller this console ever wanted.
  // `whitespace-normal` is load-bearing and was missing. `ui/table`'s
  // TableCell carries `whitespace-nowrap` — right for a column of numbers,
  // fatal here: it inherits into this element, so the statement never wrapped,
  // `line-clamp-2` had no second line to clamp to, and the text ran under
  // line-clamp's own `overflow: hidden`. Measured on /queries at 1440: the
  // code box is 907px, the statement inside it is not, and the remainder was
  // CLIPPED MID-TOKEN with no ellipsis to admit it — `…ON d.id = l.dat`. A
  // console that shows a fragment of SQL shaped exactly like whole SQL is
  // worse than one that shows none. The comment below described wrapping this
  // element had never done.
  return (
    <code className="line-clamp-2 max-w-full font-mono text-xs break-words whitespace-normal">
      {redactSecrets(oneLine)}
    </code>
  );
}
