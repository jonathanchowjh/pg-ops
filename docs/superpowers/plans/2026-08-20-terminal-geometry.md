# Terminal Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared `Table` fit the terminal it is running in — width and height — so no row wraps and no view shows an arbitrary 15 rows on a 50-row screen.

**Architecture:** Two new pure functions in `src/ui/table-layout.ts` (`solveColumns` chooses which columns survive and how wide the flex column is; `budgetRows` converts a line budget into a data-row count), one thin Ink hook (`useTerminalSize`) that reads `stdout` and re-renders on resize, and `Table` wiring them together. Views declare column *intent* — which column absorbs slack, which may be dropped first — instead of fixed numbers.

**Tech Stack:** TypeScript ESM (strict), Ink 5, React 18, Vitest 4, ink-testing-library 4, `cli-truncate`, `string-width`.

**Spec:** `docs/superpowers/specs/2026-08-19-pgops-ops-console-design.md` (rev. 4) — §9 Phase 1(1), §10 row *"Terminal geometry"*.

## Why this is its own phase, before the shell

Spec §9 makes this a prerequisite rather than polish:

> Retrofitting width after nine more views declare columns means re-tuning
> eleven column sets, so it happens first.

Today `sessions` totals **122** display columns and `top` totals **109**. Ink wraps
`<Text>` with `{trim: false, hard: true}`, so on an 80-column terminal — the POSIX
default, a split tmux pane, a bastion host, a phone SSH client — every full-width
row spills onto a second line. `pgops` is the tool you open at 03:00 on exactly
those terminals.

## Global Constraints

- **Terminal floor is 80×24.** Every column set must fit 80 display columns with no wrapping. Fallback when `stdout` reports nothing (piped output, non-TTY) is `80×24`.
- **ESM import specifiers end in `.js`** even for `.ts` sources (`./table-layout.js`).
- **`noUncheckedIndexedAccess` is on.** `array[i]` has type `T | undefined`. Never index without a guard or `!` you can justify.
- **Query text redaction is non-negotiable.** `pg_stat_activity.query` goes through `truncateQuery` (`src/core/format.ts`); `pg_stat_statements.query` goes through `cellQuery` (`src/commands/top/render.ts`). Never `.slice()` query text. A prior review of this codebase found exactly this bug.
- **Never measure or truncate text with `.length`/`.slice`.** Use `stringWidth` and `cliTruncate`. UTF-16 code units are not display columns.
- **No case-colliding filenames.** `src/ui/table.ts` and `src/ui/Table.tsx` collided on this macOS volume in Phase 1a and broke four tests. `forceConsistentCasingInFileNames` does *not* catch it.
- **Code style (CLAUDE.md):** light OOP. No classes here — every unit in this plan is a bare function or a hook. TypeScript `interface` for a plain data shape is fine and is what this codebase already uses; what is banned is interfaces as an abstraction seam, inheritance, factories, and DI plumbing.
- **Test files are excluded from `tsconfig.json`.** Run `npm run typecheck` *and* `npm run typecheck:test`.
- **Commit message trailer:** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## Constraint discovered during planning — read before Task 3

`ink-testing-library`'s stdout stub defines `columns` as a **getter that returns a
hardcoded `100`**, with no setter and no constructor option
(`node_modules/ink-testing-library/build/index.js`). Rendering a component at 80
columns through that harness is impossible.

Two consequences, and they drive the whole design:

1. **All geometry logic lives in pure functions** (`solveColumns`, `budgetRows`)
   tested directly with plain `expect`, no React.
2. **`Table` takes optional `width` and `maxLines` props.** Production omits them
   and the hook supplies the values; tests pass them explicitly. This is the only
   way a view test can assert behaviour at 80 columns.

Do not try to stub `stdout.columns` in tests. It is a getter on the prototype and
patching it is exactly the kind of fragile seam CLAUDE.md's "override the method
on the instance" rule exists to avoid — here there is no need for a seam at all,
because the logic is pure.

## File Structure

| File | Responsibility |
|---|---|
| `src/ui/table-layout.ts` | **Modify.** Extend `Column<T>` with `flex`/`min`/`drop`; add `solveColumns` and `budgetRows`. Stays pure — no React, no Ink. |
| `src/ui/table-layout.test.ts` | **Modify.** Add suites for both new functions. |
| `src/ui/useTerminalSize.ts` | **Create.** The one impure piece: reads `useStdout()`, subscribes to `resize`. ~25 lines. |
| `src/ui/useTerminalSize.test.tsx` | **Create.** Asserts the fallback and the resize subscription/cleanup. |
| `src/ui/Table.tsx` | **Modify.** Accept `width`/`maxLines`, call the solver, render the dropped-column hint. |
| `src/ui/Table.test.tsx` | **Modify.** Geometry assertions at explicit widths. |
| `src/commands/sessions/Sessions.tsx` | **Modify.** Column intent + chrome constant. |
| `src/commands/sessions/index.tsx` | **Modify.** Pass terminal size through. |
| `src/commands/top/Top.tsx` | **Modify.** Column intent + chrome constant. |
| `src/commands/top/index.tsx` | **Modify.** Pass terminal size through. |
| `src/ui/geometry.test.tsx` | **Create.** The regression gate: no rendered line exceeds the terminal width, for every view, at 80/100/120. |

`Home.tsx` and `LockChain.tsx` are **out of scope** — they migrate onto `Table` in
the shell phase, and doing it here would mean touching the cockpit twice.

---

### Task 1: `budgetRows` — turn a line budget into a row count

**Files:**
- Modify: `src/ui/table-layout.ts`
- Test: `src/ui/table-layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `budgetRows(maxLines: number, total: number): number`

**Why this exists.** `Table` occupies more lines than it shows rows: one header,
plus up to two `↑ N more` / `↓ N more` indicators. A caller that sizes the table
to the terminal must not have to know that. Today it does not know it, which is
why the component silently uses `height + 3` lines.

**Design decision to preserve:** when the list scrolls at all, reserve **both**
indicator lines even at the very top, where only `↓` renders. A row count that
changes as you scroll makes the window jitter under the cursor. One wasted line
buys a stable table.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/table-layout.test.ts`:

```ts
describe('budgetRows', () => {
  it('reserves one line for the header when everything fits', () => {
    expect(budgetRows(10, 5)).toBe(5);
    expect(budgetRows(6, 5)).toBe(5); // header + 5 rows = 6
  });

  it('reserves both indicator lines once the list scrolls', () => {
    // 6 lines: header + ↑ + 3 rows + ↓
    expect(budgetRows(6, 100)).toBe(3);
  });

  it('keeps the row count stable regardless of how long the list is', () => {
    expect(budgetRows(20, 100)).toBe(budgetRows(20, 10_000));
  });

  it('always yields at least one row while there is room for one', () => {
    expect(budgetRows(3, 100)).toBe(1);
    expect(budgetRows(2, 100)).toBe(1);
  });

  it('yields nothing when there is no room or no rows', () => {
    expect(budgetRows(1, 100)).toBe(0);
    expect(budgetRows(0, 100)).toBe(0);
    expect(budgetRows(-5, 100)).toBe(0);
    expect(budgetRows(20, 0)).toBe(0);
  });
});
```

Add `budgetRows` to the existing import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/table-layout.test.ts`
Expected: FAIL — `budgetRows is not a function` / no exported member.

- [ ] **Step 3: Write minimal implementation**

Append to `src/ui/table-layout.ts`:

```ts
/**
 * Data rows that fit in `maxLines` total lines.
 *
 * `Table` spends lines on chrome the caller should not have to count: one header
 * row always, plus an `↑ N more` and a `↓ N more` indicator once the list is
 * longer than the window. Both indicator lines are reserved as soon as the list
 * scrolls at all — even at the very top, where only `↓` renders. Reserving them
 * conditionally would change the row count as the selection moves, making the
 * window jitter under the cursor; one unused line buys a stable table.
 */
export function budgetRows(maxLines: number, total: number): number {
  if (maxLines < 2 || total <= 0) return 0;
  const withoutIndicators = maxLines - 1; // header
  if (total <= withoutIndicators) return total;
  return Math.max(1, maxLines - 3); // header + ↑ + ↓
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/table-layout.test.ts`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/ui/table-layout.ts src/ui/table-layout.test.ts
git commit -m "feat(table): budget a line allowance into a stable data-row count"
```

---

### Task 2: `solveColumns` — fit a column set to the available width

**Files:**
- Modify: `src/ui/table-layout.ts`
- Test: `src/ui/table-layout.test.ts`

**Interfaces:**
- Consumes: the existing `Column<T>`.
- Produces:
  - `Column<T>` gains three optional fields: `flex?: boolean`, `min?: number`, `drop?: number`
  - `solveColumns<T>(columns: Column<T>[], available: number): SolvedColumns<T>`
  - `interface SolvedColumns<T> { columns: Column<T>[]; dropped: string[] }`

**The model.** A view declares intent, not arithmetic:

- **fixed** (default) — the numeric and status columns. Their width is their
  meaning; a `pid` column that shrinks is worse than absent.
- **`flex: true`** — at most one per set, and always the query column. It absorbs
  whatever is left over, down to `min`.
- **`drop: n`** — droppable when the row will not fit. **Higher `n` is dropped
  first.** A column with no `drop` is never dropped.

**Algorithm.** Give the flex column its floor, then drop until the row fits, then
give the flex column everything that is actually left:

1. `survivors = [...columns]`
2. Loop: compute `need = fixedSum + flexMin + separators`. If `need <= available`, stop. Otherwise drop the surviving column with the highest `drop`; if none is droppable, stop and accept the overflow — `formatCell` still hard-truncates, so the row degrades rather than breaking.
3. If a flex column survived, widen it to `max(min, available - fixedSum - separators)`.

`available` is the width left for cells: the caller subtracts the 2-column
selection gutter before calling.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/table-layout.test.ts`:

```ts
describe('solveColumns', () => {
  // Mirrors the real sessions set: pid/state/age are load-bearing, `who`
  // duplicates the detail panel, query absorbs slack.
  const cols = (): Column<{ n: number }>[] => [
    { key: 'pid', header: 'pid', width: 6, value: (r) => String(r.n) },
    { key: 'state', header: 'state', width: 22, value: () => '' },
    { key: 'age', header: 'age', width: 8, value: () => '' },
    { key: 'who', header: 'user@app', width: 20, drop: 2, value: () => '' },
    { key: 'query', header: 'query', width: 60, flex: true, min: 20, value: () => '' },
  ];

  /** Total display width of a solved row: cells plus one space between each. */
  const rowWidth = <T,>(s: SolvedColumns<T>) =>
    s.columns.reduce((n, c) => n + c.width, 0) + Math.max(0, s.columns.length - 1);

  it('gives the flex column the leftover width when everything fits', () => {
    const s = solveColumns(cols(), 118);
    expect(s.dropped).toEqual([]);
    expect(s.columns.find((c) => c.key === 'query')?.width).toBe(58);
    expect(rowWidth(s)).toBe(118);
  });

  it('drops the droppable column rather than starving the flex column', () => {
    const s = solveColumns(cols(), 78); // an 80-column terminal, less the gutter
    expect(s.dropped).toEqual(['who']);
    expect(s.columns.map((c) => c.key)).toEqual(['pid', 'state', 'age', 'query']);
    expect(s.columns.find((c) => c.key === 'query')?.width).toBe(39);
    expect(rowWidth(s)).toBe(78);
  });

  it('never exceeds the available width once the set can fit at all', () => {
    // 59 is this set's floor: the three undroppable columns (36) + the query
    // floor (20) + 3 separators. Below it there is nothing left to give.
    for (let w = 59; w <= 200; w++) {
      expect(rowWidth(solveColumns(cols(), w))).toBeLessThanOrEqual(w);
    }
  });

  it('overflows rather than throwing when even the floor will not fit', () => {
    // Deliberate: with no droppable column left, `formatCell` hard-truncates
    // each cell so the table degrades legibly instead of breaking.
    expect(rowWidth(solveColumns(cols(), 30))).toBe(59);
  });

  it('drops highest `drop` first', () => {
    const c: Column<{ n: number }>[] = [
      { key: 'keep', header: 'k', width: 10, value: () => '' },
      { key: 'first', header: 'a', width: 10, drop: 9, value: () => '' },
      { key: 'second', header: 'b', width: 10, drop: 1, value: () => '' },
    ];
    expect(solveColumns(c, 21).dropped).toEqual(['first']);
    expect(solveColumns(c, 10).dropped).toEqual(['first', 'second']);
  });

  it('stops dropping when only undroppable columns remain, and does not mangle them', () => {
    const c: Column<{ n: number }>[] = [
      { key: 'a', header: 'a', width: 10, value: () => '' },
      { key: 'b', header: 'b', width: 10, value: () => '' },
    ];
    const s = solveColumns(c, 5);
    expect(s.columns.map((x) => x.width)).toEqual([10, 10]);
    expect(s.dropped).toEqual([]);
  });

  it('honours the flex floor instead of going negative', () => {
    const s = solveColumns(cols(), 30);
    expect(s.columns.find((x) => x.key === 'query')?.width).toBe(20);
  });

  it('returns nothing when there is no width at all', () => {
    expect(solveColumns(cols(), 0).columns).toEqual([]);
    expect(solveColumns(cols(), -10).columns).toEqual([]);
  });

  it('does not mutate the caller-owned column objects', () => {
    const original = cols();
    const before = original.map((c) => c.width);
    solveColumns(original, 78);
    expect(original.map((c) => c.width)).toEqual(before);
  });
});
```

Add `solveColumns` and the `SolvedColumns` type to the file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/table-layout.test.ts`
Expected: FAIL — `solveColumns is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/table-layout.ts`, extend `Column<T>` — add these three fields to the
existing interface, keeping every current field and comment intact:

```ts
  /**
   * This column absorbs leftover width. At most one per column set; in practice
   * always the query column, because it is the only one whose usefulness scales
   * smoothly with the space it gets.
   */
  flex?: boolean;
  /** Floor for a flex column, so a narrow terminal starves it rather than inverting it. */
  min?: number;
  /**
   * Drop order when the row will not fit — **higher is dropped first**. A column
   * with no `drop` is never dropped: its width is its meaning, and a `pid` cell
   * squeezed to three characters is worse than an absent one.
   */
  drop?: number;
```

Then append:

```ts
/** The surviving columns, resized to fit, plus the keys that did not make it. */
export interface SolvedColumns<T> {
  columns: Column<T>[];
  /** Keys dropped, in the order they were dropped. Rendered as a `+N` header hint. */
  dropped: string[];
}

/**
 * Fit a column set into `available` display columns.
 *
 * `available` is the width left for cells — the caller subtracts the 2-column
 * selection gutter first.
 *
 * Fixed columns keep their declared width, because for a `pid` or a duration the
 * width IS the meaning. Slack goes to the single `flex` column, and when even its
 * floor will not fit, droppable columns are removed highest-`drop`-first. If only
 * undroppable columns remain the row is left over-wide on purpose: `formatCell`
 * hard-truncates each cell, so the table degrades legibly instead of throwing.
 *
 * Pure and non-mutating — callers own their column objects, and the sessions and
 * top column sets are module-level constants that must survive being solved at a
 * different width on every render.
 */
export function solveColumns<T>(columns: Column<T>[], available: number): SolvedColumns<T> {
  if (available <= 0) return { columns: [], dropped: columns.map((c) => c.key) };

  let survivors = [...columns];
  const dropped: string[] = [];

  const fixedSum = (cs: Column<T>[]) =>
    cs.reduce((n, c) => n + (c.flex ? 0 : c.width), 0);
  const flexFloor = (cs: Column<T>[]) => {
    const f = cs.find((c) => c.flex);
    return f ? (f.min ?? 1) : 0;
  };

  for (;;) {
    const need = fixedSum(survivors) + flexFloor(survivors) + Math.max(0, survivors.length - 1);
    if (need <= available) break;

    // Highest `drop` goes first. `reduce` rather than a sort so ties resolve to
    // the earlier declaration, keeping the outcome stable and reviewable.
    const victim = survivors.reduce<Column<T> | undefined>(
      (worst, c) => (c.drop === undefined ? worst : worst === undefined || c.drop > worst.drop! ? c : worst),
      undefined,
    );
    if (!victim) break;

    survivors = survivors.filter((c) => c.key !== victim.key);
    dropped.push(victim.key);
  }

  const flex = survivors.find((c) => c.flex);
  if (!flex) return { columns: survivors, dropped };

  const width = Math.max(flex.min ?? 1, available - fixedSum(survivors) - Math.max(0, survivors.length - 1));
  return {
    columns: survivors.map((c) => (c.flex ? { ...c, width } : c)),
    dropped,
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/ui/table-layout.test.ts && npm run typecheck && npm run typecheck:test`
Expected: all PASS. Note the existing `Column` usages still compile — every new field is optional.

- [ ] **Step 5: Commit**

```bash
git add src/ui/table-layout.ts src/ui/table-layout.test.ts
git commit -m "feat(table): solve a column set against the available width"
```

---

### Task 3: `useTerminalSize` — the one impure piece

**Files:**
- Create: `src/ui/useTerminalSize.ts`
- Test: `src/ui/useTerminalSize.test.tsx`

**Interfaces:**
- Consumes: Ink's `useStdout`.
- Produces: `useTerminalSize(): { columns: number; rows: number }`

**Read the harness constraint above first.** This hook is deliberately as thin as
it can be, because it is the only part of this plan that cannot be tested at
varying sizes.

- [ ] **Step 1: Write the failing test**

Create `src/ui/useTerminalSize.test.tsx`:

```tsx
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { useTerminalSize } from './useTerminalSize.js';

function Probe() {
  const { columns, rows } = useTerminalSize();
  return <Text>{`${columns}x${rows}`}</Text>;
}

describe('useTerminalSize', () => {
  it('reads the current terminal size', () => {
    // ink-testing-library's stdout stub reports columns=100 and no rows, so this
    // also pins the rows fallback. See the plan's harness note: the stub's
    // `columns` is a prototype getter and cannot be varied.
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toBe('100x24');
  });

  it('subscribes to resize and unsubscribes on unmount', () => {
    const { stdout, unmount } = render(<Probe />);
    expect(stdout.listenerCount('resize')).toBe(1);
    unmount();
    expect(stdout.listenerCount('resize')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/useTerminalSize.test.tsx`
Expected: FAIL — cannot resolve `./useTerminalSize.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/useTerminalSize.ts`:

```ts
import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

/**
 * POSIX defaults. Used whenever stdout reports nothing — a pipe, a CI log, a
 * `--snapshot` redirect. Guessing wide would wrap; 80x24 always renders.
 */
const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * The terminal's current size, re-rendering on resize.
 *
 * The only impure piece of the geometry work, and deliberately the thinnest:
 * `ink-testing-library`'s stdout stub exposes `columns` as a prototype getter
 * hardcoded to 100, with no setter and no option, so nothing rendered through
 * that harness can be observed at another width. Every decision that depends on
 * width therefore lives in `solveColumns`/`budgetRows`, which are pure and tested
 * directly, and `Table` accepts explicit overrides so view tests can pin a size.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => ({
    columns: stdout?.columns ?? FALLBACK_COLUMNS,
    rows: stdout?.rows ?? FALLBACK_ROWS,
  });

  const [size, setSize] = useState<TerminalSize>(read);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(read);
    stdout.on('resize', onResize);
    // Re-read on mount: the terminal may have been resized between the initial
    // useState and this effect running.
    onResize();
    return () => {
      stdout.off('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);

  return size;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/useTerminalSize.test.tsx && npm run typecheck:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/useTerminalSize.ts src/ui/useTerminalSize.test.tsx
git commit -m "feat(ui): read the terminal size and follow resizes"
```

---

### Task 4: Wire `Table` to the terminal

**Files:**
- Modify: `src/ui/Table.tsx`
- Test: `src/ui/Table.test.tsx`

**Interfaces:**
- Consumes: `solveColumns`, `budgetRows`, `visibleWindow`, `useTerminalSize`.
- Produces: `TableProps<T>` where `height` is **replaced** by:
  - `maxLines?: number` — total lines the table may occupy; defaults to the terminal's rows.
  - `width?: number` — total display columns available; defaults to the terminal's columns.

**Breaking change, deliberate.** `height` (data rows) becomes `maxLines` (total
lines) because the old prop made the caller responsible for chrome it could not
see. The only callers are `Sessions.tsx` and `Top.tsx`, both updated in Tasks 5
and 6.

**Dropped columns are never silent.** When `solveColumns` drops a column the
header gains a dim `+N` suffix. Hiding data with no indication is the failure the
spec's "no silent caps" discipline exists to prevent.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/Table.test.tsx`:

```tsx
describe('Table geometry', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ n: i }));
  const columns: Column<{ n: number }>[] = [
    { key: 'n', header: 'n', width: 6, align: 'right', value: (r) => String(r.n) },
    { key: 'who', header: 'who', width: 20, drop: 2, value: () => 'someone@someapp' },
    { key: 'text', header: 'text', width: 60, flex: true, min: 20, value: () => 'x'.repeat(200) },
  ];

  const lines = (frame: string | undefined) => (frame ?? '').split('\n');

  it('emits no line wider than the terminal at 80 columns', () => {
    const { lastFrame } = render(
      <Table columns={columns} rows={rows} selectedIndex={0} width={80} maxLines={12}
             rowKey={(r) => String(r.n)} />,
    );
    for (const line of lines(lastFrame())) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it('occupies no more lines than its budget', () => {
    const { lastFrame } = render(
      <Table columns={columns} rows={rows} selectedIndex={0} width={120} maxLines={12}
             rowKey={(r) => String(r.n)} />,
    );
    expect(lines(lastFrame()).length).toBeLessThanOrEqual(12);
  });

  it('names how many columns it dropped instead of hiding them silently', () => {
    const { lastFrame } = render(
      <Table columns={columns} rows={rows} selectedIndex={0} width={40} maxLines={12}
             rowKey={(r) => String(r.n)} />,
    );
    expect(lastFrame()).toContain('+1');
    expect(lastFrame()).not.toContain('someone@someapp');
  });

  it('keeps a dropped column when the terminal is wide enough for it', () => {
    const { lastFrame } = render(
      <Table columns={columns} rows={rows} selectedIndex={0} width={140} maxLines={12}
             rowKey={(r) => String(r.n)} />,
    );
    expect(lastFrame()).toContain('someone@someapp');
    expect(lastFrame()).not.toContain('+1');
  });
});
```

Add `import stringWidth from 'string-width';` to the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/Table.test.tsx`
Expected: FAIL — `width`/`maxLines` are not props; lines exceed 80.

- [ ] **Step 3: Write the implementation**

In `src/ui/Table.tsx`: replace the `height` prop, call the solver, and render the
hint. The gutter is 2 columns (`'▸ '` / `'  '`), so the cells get `width - 2`.

```tsx
import { Box, Text } from 'ink';
import { useRef } from 'react';
import { theme } from '../core/theme.js';
import {
  budgetRows,
  formatCell,
  headerCells,
  solveColumns,
  visibleWindow,
  type Column,
} from './table-layout.js';
import { useTerminalSize } from './useTerminalSize.js';

/** The selection arrow column, `'▸ '` or `'  '`, in front of every row. */
const GUTTER = 2;

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  selectedIndex: number;
  rowKey: (row: T, index: number) => string;
  /**
   * Total lines the table may occupy, chrome included — NOT a data-row count.
   * `budgetRows` subtracts the header and scroll indicators. Defaults to the
   * terminal's height; views pass a smaller number to leave room for their own
   * chrome, and tests pass an explicit value.
   */
  maxLines?: number;
  /** Total display columns available. Defaults to the terminal's width. */
  width?: number;
  /** Column `key` currently sorted, if any — marked in the header. */
  sortKey?: string;
  /** Shown instead of the table when `rows` is empty. */
  empty?: string;
}

export function Table<T>({
  columns, rows, selectedIndex, rowKey, maxLines, width, sortKey, empty,
}: TableProps<T>) {
  const prevStart = useRef(0);
  const terminal = useTerminalSize();

  if (rows.length === 0) {
    return (
      <Text color={theme.dim}>
        {'  '}
        {empty ?? 'No rows.'}
      </Text>
    );
  }

  const solved = solveColumns(columns, (width ?? terminal.columns) - GUTTER);
  const height = budgetRows(maxLines ?? terminal.rows, rows.length);

  const { start, end } = visibleWindow({
    total: rows.length,
    selected: selectedIndex,
    height,
    prevStart: prevStart.current,
  });
  prevStart.current = start;

  const cols = solved.columns;
  const hiddenAbove = start;
  const hiddenBelow = rows.length - end;

  return (
    <Box flexDirection="column">
      <Text bold>
        {'  '}
        {headerCells(cols, sortKey).map((cell, i) => (
          <Text key={cols[i]?.key ?? i} color={cell.active ? theme.info : theme.dim}>
            {cell.text}
            {i < cols.length - 1 ? ' ' : ''}
          </Text>
        ))}
        {/* Columns the width could not fit. Never drop data silently. */}
        {solved.dropped.length > 0 ? (
          <Text color={theme.dim}> +{solved.dropped.length}</Text>
        ) : null}
      </Text>

      {hiddenAbove > 0 ? <Text color={theme.dim}>{'  '}↑ {hiddenAbove} more</Text> : null}

      {rows.slice(start, end).map((row, i) => {
        const index = start + i;
        const selected = index === selectedIndex;
        return (
          <Text key={rowKey(row, index)} inverse={selected}>
            {selected ? '▸ ' : '  '}
            {cols.map((c, ci) => (
              <Text key={c.key} color={c.color?.(row, selected)}>
                {formatCell(c.value(row), c.width, c.align, ci < cols.length - 1)}
                {ci < cols.length - 1 ? ' ' : ''}
              </Text>
            ))}
          </Text>
        );
      })}

      {hiddenBelow > 0 ? <Text color={theme.dim}>{'  '}↓ {hiddenBelow} more</Text> : null}
    </Box>
  );
}
```

**Note on the empty case:** it returns before the hooks that follow it, but
`useRef` and `useTerminalSize` both run above the early return, so hook order is
stable. Do not move them below it.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run src/ui && npm run typecheck:test`
Expected: the four new geometry tests PASS. `Sessions.view.test.tsx` and
`Top.view.test.tsx` may fail on the removed `height` prop — Tasks 5 and 6 fix
them. Do not patch those views here.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Table.tsx src/ui/Table.test.tsx
git commit -m "feat(table): size the table to the terminal, and name dropped columns"
```

---

### Task 5: `sessions` declares column intent

**Files:**
- Modify: `src/commands/sessions/Sessions.tsx`
- Modify: `src/commands/sessions/index.tsx`
- Test: `src/commands/sessions/Sessions.view.test.tsx`

**Interfaces:**
- Consumes: `Table`'s `width`/`maxLines`, `useTerminalSize`.
- Produces: `SessionsProps` with `width?: number` and `maxLines?: number` replacing `height?: number`.

**The intent, and why.** `pid`, `state`, and `age` are never dropped — `state` is
the triage signal this whole view exists to surface, and a truncated duration
lies. `who` is droppable because the selected row's `user@app` is already in the
detail panel below. `query` flexes.

At 80 columns this drops `who`: `2 + 6+1 + 22+1 + 8+1 + 39 = 80`.
At 120 it keeps everything and gives `query` 58.

- [ ] **Step 1: Write the failing test**

Add to `src/commands/sessions/Sessions.view.test.tsx`:

```tsx
it('fits an 80-column terminal without wrapping any row', () => {
  const rows = Array.from({ length: 50 }, (_, i) => makeRow({ pid: 100 + i }));
  const { lastFrame } = render(<Sessions rows={rows} selectedIndex={0} width={80} maxLines={20} />);
  for (const line of (lastFrame() ?? '').split('\n')) {
    expect(stringWidth(line)).toBeLessThanOrEqual(80);
  }
});

it('drops user@app before it starves the query column', () => {
  const rows = [makeRow({ pid: 42, user: 'alice', app: 'checkout' })];
  const narrow = render(<Sessions rows={rows} selectedIndex={0} width={80} maxLines={20} />);
  expect(narrow.lastFrame()).not.toContain('alice@checkout');
  const wide = render(<Sessions rows={rows} selectedIndex={0} width={130} maxLines={20} />);
  expect(wide.lastFrame()).toContain('alice@checkout');
});
```

Use the file's existing row helper; if it has none, add a local `makeRow` that
fills every `SessionRow` field. Import `stringWidth`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/commands/sessions`
Expected: FAIL — `width`/`maxLines` are not props on `Sessions`.

- [ ] **Step 3: Write the implementation**

In `Sessions.tsx`, replace the `COLUMNS` array and the props/signature. Keep
`stateColor` and the redaction comment exactly as they are.

```tsx
/**
 * Columns declare intent, not arithmetic (see `solveColumns`). `pid`, `state`,
 * and `age` are undroppable: `state` is the triage signal this view exists for,
 * and a truncated duration lies. `who` is droppable because the selected row's
 * `user@app` is already in the detail panel below, so a narrow terminal loses a
 * convenience rather than a fact. Every query cell still goes through
 * `truncateQuery`, which redacts — never slice `pg_stat_activity.query` directly.
 */
const COLUMNS: Column<SessionRow>[] = [
  { key: 'pid', header: 'pid', width: 6, align: 'right', value: (r) => String(r.pid), color: () => theme.info },
  { key: 'state', header: 'state', width: 22, value: (r) => r.state ?? '?', color: (r) => stateColor(r.state) },
  { key: 'age', header: 'age', width: 8, align: 'right', value: (r) => formatDuration(r.inStateSecs) },
  { key: 'who', header: 'user@app', width: 20, drop: 2, value: (r) => `${r.user ?? '?'}@${r.app || '?'}`, color: () => theme.dim },
  { key: 'query', header: 'query', width: 60, flex: true, min: 20, value: (r) => (r.query ? truncateQuery(r.query, 200) : '') },
];

export interface SessionsProps {
  rows: SessionRow[];
  selectedIndex: number;
  /** Total display columns available; omit to use the terminal's width. */
  width?: number;
  /** Total lines the table may occupy; omit to use the terminal's height. */
  maxLines?: number;
}

export function Sessions({ rows, selectedIndex, width, maxLines }: SessionsProps) {
  const terminal = useTerminalSize();
  const columns = width ?? terminal.columns;
  const selected = rows[selectedIndex];
  return (
    <Box flexDirection="column">
      <Table
        columns={COLUMNS}
        rows={rows}
        selectedIndex={selectedIndex}
        width={columns}
        maxLines={maxLines}
        rowKey={(r) => String(r.pid)}
        empty="No client sessions."
      />
      {selected ? (
        <Box flexDirection="column" marginTop={1}>
          {/*
            The detail lines are subject to the same wrapping rule as the table:
            `<Text>` wraps hard, so a line one column too wide renders as two and
            the panel grows under the table. Both are truncated to the terminal,
            less the 2-column gutter and a column of slack. The query line used a
            flat 200, which wrapped on anything under a 204-column terminal.
          */}
          <Text color={theme.dim}>
            {'  '}
            {cliTruncate(
              `client ${selected.clientAddr ?? 'local'} · session began ${selected.backendStart ?? '?'}`,
              Math.max(1, columns - 3),
            )}
          </Text>
          {selected.query ? (
            <Text color={theme.dim}>
              {'  '}
              {truncateQuery(selected.query, Math.max(1, columns - 3))}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
```

Add `import cliTruncate from 'cli-truncate';` and
`import { useTerminalSize } from '../../ui/useTerminalSize.js';` to `Sessions.tsx`.
`Sessions` reads the terminal itself so the detail panel can size to it even when
the container passes no `width` — the `width` prop stays, so tests can pin it.

**Note the `truncateQuery(r.query, 200)` change.** The old code passed the
hard-coded column width (`60`); the flex column's width is no longer known where
`value` is declared. Redaction still happens — that is what matters — and
`formatCell` performs the display-width truncation afterwards. 200 is a generous
upper bound that keeps the redacted string cheap to measure.

In `index.tsx`, feed the terminal size in:

```tsx
// Chrome above and below the table: the bordered StatusBar is 3 lines, the
// detail block is a blank line plus up to 2 lines, and the filter prompt takes
// one more while it is open.
const CHROME_LINES = 6;

// ...inside SessionsApp, alongside the other hooks:
const terminal = useTerminalSize();
```

and pass it to the view:

```tsx
<Sessions
  rows={rows}
  selectedIndex={index}
  width={terminal.columns}
  maxLines={Math.max(3, terminal.rows - CHROME_LINES - (filtering ? 1 : 0))}
/>
```

Import `useTerminalSize` from `../../ui/useTerminalSize.js`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/commands/sessions && npm run typecheck && npm run typecheck:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sessions
git commit -m "refactor(sessions): declare column intent and follow the terminal"
```

---

### Task 6: `top` declares column intent

**Files:**
- Modify: `src/commands/top/Top.tsx`
- Modify: `src/commands/top/index.tsx`
- Test: `src/commands/top/Top.view.test.tsx`

**Interfaces:** identical shape to Task 5 — `TopProps` gains `width?`/`maxLines?`
and loses `height?`.

**The intent.** `total` and `mean` are the sort keys people live in and are never
dropped. `calls` goes first (`drop: 3`) and `cache` second (`drop: 2`) — cache
hit rate earns its place because it is the only column that is *colour*-carrying,
so it survives one step longer. `query` flexes with a floor of 20.

At 80 columns nothing drops: `2 + 9+1 + 9+1 + 8+1 + 7+1 + 41 = 80`.

- [ ] **Step 1: Write the failing test**

Add to `src/commands/top/Top.view.test.tsx`:

```tsx
it('fits an 80-column terminal without wrapping any row', () => {
  const rows = Array.from({ length: 50 }, (_, i) => makeRow({ queryid: String(i) }));
  const { lastFrame } = render(<Top rows={rows} sort="total" selectedIndex={0} width={80} maxLines={20} />);
  for (const line of (lastFrame() ?? '').split('\n')) {
    expect(stringWidth(line)).toBeLessThanOrEqual(80);
  }
});

it('keeps every numeric column at 80 columns', () => {
  const { lastFrame } = render(
    <Top rows={[makeRow({})]} sort="total" selectedIndex={0} width={80} maxLines={20} />,
  );
  expect(lastFrame()).not.toContain('+1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/commands/top`
Expected: FAIL — `width`/`maxLines` are not props on `Top`.

- [ ] **Step 3: Write the implementation**

In `Top.tsx`, add the intent fields to the existing `COLUMNS` entries — do not
restructure them, and keep every comment including the `cellQuery` redaction note
and the pre-migration selection-colour note:

- `total`: unchanged (undroppable)
- `mean`: unchanged (undroppable)
- `calls`: add `drop: 3`
- `cache`: add `drop: 2`
- `query`: add `flex: true, min: 20`, and change `value` to `cellQuery(r.query, 200)` for the same reason as Task 5

Update `TopProps` and the signature exactly as in Task 5, replacing `height = 15`
with `width`/`maxLines` passthrough.

**Also remove `paddingX={1}` from `Top`'s outer `<Box>`.** It costs two display
columns that `Table` has no way to know about, so a row solved to exactly the
terminal width renders one column over and wraps — the exact bug this task is
here to fix. Removing it also makes `top` align with `sessions`, which has never
had it; `Table`'s own 2-column selection gutter already provides the left margin.

In `index.tsx`:

```tsx
// Chrome: the bordered StatusBar is 3 lines, the filter summary line is 1, and
// the filter prompt takes one more while it is open.
const CHROME_LINES = 4;
```

and pass `width={terminal.columns}` plus
`maxLines={Math.max(3, terminal.rows - CHROME_LINES - (filtering ? 1 : 0))}`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/commands/top && npm run typecheck && npm run typecheck:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/top
git commit -m "refactor(top): declare column intent and follow the terminal"
```

---

### Task 7: The regression gate

**Files:**
- Create: `src/ui/geometry.test.tsx`

**Interfaces:** consumes `Sessions` and `Top`. No production code changes.

**Why a separate file.** Tasks 5 and 6 each test their own view. This file is the
*invariant*, stated once, over every view that renders a `Table` — so the shell
phase adds a line here per new view instead of rediscovering the rule. Spec §10
names it:

> Every view's column set fits 80 columns without wrapping, at every supported
> terminal width, with no row emitting a blank continuation line.

- [ ] **Step 1: Write the test**

Create `src/ui/geometry.test.tsx`:

```tsx
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { Sessions } from '../commands/sessions/Sessions.js';
import { Top } from '../commands/top/Top.js';
import type { SessionRow } from '../commands/sessions/query.js';
import type { QueryRow } from '../commands/top/stats.js';

/**
 * The geometry invariant, stated once for every view that renders a `Table`.
 *
 * Ink wraps `<Text>` with `{trim: false, hard: true}`, so a row one column too
 * wide becomes two lines and the whole table renders double-spaced. That bug
 * shipped once already (`154da2a`) and was invisible in a wide terminal, which is
 * exactly why this gate asserts narrow widths a developer never looks at.
 *
 * When the shell phase adds a view, add a case here. That is the point of the
 * file.
 */

const WIDTHS = [80, 100, 120, 160];

const sessionRow = (pid: number): SessionRow => ({
  pid,
  state: 'idle in transaction (aborted)',
  user: 'a-fairly-long-username',
  app: 'PostgreSQL JDBC Driver',
  clientAddr: '10.0.0.1',
  backendStart: '2026-08-20 09:00:00+00',
  inStateSecs: 8_675_309,
  runningSecs: 8_675_309,
  query: 'SELECT '.repeat(80),
});

const queryRow = (i: number): QueryRow => ({
  queryid: String(i),
  query: 'SELECT '.repeat(80),
  calls: 999_999_999,
  totalMs: 999_999_999,
  meanMs: 99_999.999,
  stddevMs: 1,
  rows: 1,
  sharedBlksHit: 1,
  sharedBlksRead: 1,
  cacheHitPct: 42,
});

/** Deliberately pathological: max-length cells in every column. */
const sessions = Array.from({ length: 200 }, (_, i) => sessionRow(1000 + i));
const queries = Array.from({ length: 200 }, (_, i) => queryRow(i));

const views = [
  { name: 'sessions', at: (w: number) => <Sessions rows={sessions} selectedIndex={5} width={w} maxLines={18} /> },
  { name: 'top', at: (w: number) => <Top rows={queries} sort="total" selectedIndex={5} width={w} maxLines={18} /> },
];

describe('terminal geometry', () => {
  for (const view of views) {
    for (const width of WIDTHS) {
      it(`${view.name} fits ${width} columns`, () => {
        const lines = (render(view.at(width)).lastFrame() ?? '').split('\n');
        for (const line of lines) {
          expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
      });

      it(`${view.name} emits no blank continuation line at ${width} columns`, () => {
        const lines = (render(view.at(width)).lastFrame() ?? '').split('\n');
        // A wrapped row shows up as a data line followed by a blank one. The
        // detail block's deliberate blank separator is the only legal blank, so
        // assert on the table region: no two consecutive blanks, and no blank
        // directly between two rows that both carry a pid.
        const blanks = lines.filter((l) => l.trim() === '').length;
        expect(blanks).toBeLessThanOrEqual(1);
      });

      it(`${view.name} occupies no more than its line budget at ${width} columns`, () => {
        const lines = (render(view.at(width)).lastFrame() ?? '').split('\n');
        expect(lines.length).toBeLessThanOrEqual(18 + 4); // table budget + view chrome
      });
    }
  }
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/ui/geometry.test.tsx`
Expected: PASS — all 24 cases. If a case fails, the column set is wrong, not the
test; fix the `COLUMNS` intent in the offending view.

- [ ] **Step 3: Run the whole suite and both typechecks**

Run: `npm test && npm run typecheck && npm run typecheck:test && npm run build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/ui/geometry.test.tsx
git commit -m "test(ui): gate every table view against wrapping at narrow widths"
```

---

## Done when

- `solveColumns` and `budgetRows` are pure, exported from `src/ui/table-layout.ts`, and unit-tested with no React.
- `Table` takes `width`/`maxLines`, defaults both from `useTerminalSize()`, and names dropped columns with `+N`.
- `sessions` and `top` render inside 80 columns with no wrapped row and no blank continuation line, asserted at 80/100/120/160.
- Both views fill the available terminal height instead of a hardcoded 15.
- `npm test`, `npm run typecheck`, `npm run typecheck:test`, and `npm run build` are all clean.

**Not verified by this plan, and not claimed:** behaviour against a live
database, and behaviour in a real resizing terminal. `ink-testing-library`'s
stdout stub cannot vary `columns`, so the `useTerminalSize` → `Table` path is
exercised only through explicit props. A manual check — `npm run db:up`, then
`npm run dev` in an 80-column window, resized — is worth doing before merge and
should be reported as done or not done, never assumed. Phase 1a's plan claimed a
live-database verification that never ran; do not repeat that.

## Deferred to the shell phase

- `Home.tsx` and `LockChain.tsx` migrating onto `Table` (they still hand-pad at `Home.tsx:117-120` and `166-167`).
- `LockChain.tsx`'s `❯` cursor, which disagrees with `Table`'s `▸`.
- `StatusBar` hint truncation under narrow widths — it already sets `wrap="truncate"`, but which hints survive is a shell-owned decision once the tab strip exists.
