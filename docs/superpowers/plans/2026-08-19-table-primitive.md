# Table Primitive Implementation Plan (v0.2 Phase 1a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared, virtualised `Table` primitive in `src/ui/` and adopt it in `sessions` and `top`, removing the hand-rolled column arithmetic and fixing the fact that neither view can scroll.

**Architecture:** A pure layout module (`src/ui/table-layout.ts`) holds the column model, cell formatting, and scroll-window maths — all testable without rendering. A thin Ink component (`src/ui/Table.tsx`) draws it. The two existing table views then declare columns instead of computing padding. This follows the codebase's established split: pure logic in `.ts`, presentation in `.tsx`, state owned by `index.tsx`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), React 18, Ink 5, Vitest 4, ink-testing-library 4.

**Spec:** `docs/superpowers/specs/2026-08-19-pgops-ops-console-design.md` (§9 Phase 1)

## Scope note — this is Phase 1a of 5 phases

The spec's Phase 1 has two halves. This plan covers **only the Table primitive**. The shell refactor (tab strip, global nav keys, suppression rule, `Esc` change, `useVerdicts()`) is **Phase 1b** and gets its own plan — the spec itself warns that half is "a refactor of existing working code, not a component addition, and it should be planned and reviewed as such." Phases 2–5 follow with their own plans.

### Two deliberate deviations from the spec

1. **Proven on `sessions` and `top`, not `config` and `seq`.** The spec says to prove the primitive on the two cheapest new views. But `sessions` and `top` are the views that actually contain the `padStart`/`padEnd` arithmetic the primitive exists to delete, they need no new SQL, and they already have passing tests that act as a regression suite. `config` and `seq` move to Phase 2. This makes Phase 1a purely infrastructural — no new queries, no new schema.

2. **The `sessions` selected-row disclosure moves below the table.** Today the detail lines render inline directly beneath the selected row (`Sessions.tsx:42-47`). Inline expansion is incompatible with a fixed-height scroll window — an expanding row changes how many rows fit, so the window maths would oscillate. The detail becomes a fixed footer panel under the table. This is a visible UX change and is called out in Task 4.

## Global Constraints

- **Module system:** ESM. Every relative import must carry an explicit `.js` extension, including from `.tsx` files (e.g. `import { theme } from '../core/theme.js'`).
- **Layering:** `ui` may import from `core`; `core` must never import from `ui`. See the comment in `src/core/theme.ts:18-26`.
- **Colours:** only from `theme` in `src/core/theme.ts`. Never a raw hex literal in a component.
- **Query text:** any `pg_stat_activity.query` or `pg_stat_statements.query` rendered to the terminal must pass through `truncateQuery` (`src/core/format.ts`) or `cellQuery` (`src/commands/top/render.ts`) — these redact. Never `.slice()` query text directly.
- **Node:** >= 20.
- **Tests:** Vitest. Run with `npx vitest run <path>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/ui/table-layout.ts` (create) | Pure: `Column<T>` model, `formatCell`, `headerCells`, `visibleWindow`. No React. |
| `src/ui/table-layout.test.ts` (create) | Unit tests for all of the above. |
| `src/ui/Table.tsx` (create) | Ink component: header row, scroll window, selection marker, overflow indicators. |
| `src/ui/Table.test.tsx` (create) | Render tests via `ink-testing-library`. |
| `src/commands/sessions/Sessions.tsx` (modify) | Declares columns; detail panel moves below the table. |
| `src/commands/sessions/Sessions.view.test.tsx` (create) | Component-level tests, no `vi.mock` machinery. |
| `src/commands/top/Top.tsx` (modify) | Declares columns; keeps the sort-indicator header. |
| `src/commands/top/Top.view.test.tsx` (create) | Component-level tests, including the sort marker. |

Existing `Sessions.test.tsx` and `TopApp.test.tsx` stay as they are — they test
the containers and act as the regression suite for these changes.

---

## Task 1: Scroll-window maths

Neither `sessions` nor `top` currently windows its rows — `Sessions.tsx:30` and `Top.tsx:94` both `.map()` the entire array. On a 500-session box the view renders 500 rows into a 50-row terminal. This pure function is the fix.

**Files:**
- Create: `src/ui/table-layout.ts`
- Test: `src/ui/table-layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `visibleWindow(input: WindowInput): Window`, where `WindowInput = { total: number; selected: number; height: number; prevStart: number }` and `Window = { start: number; end: number }`. `end` is exclusive.

- [ ] **Step 1: Write the failing test**

Create `src/ui/table-layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { visibleWindow } from './table-layout.js';

describe('visibleWindow', () => {
  it('shows every row when they all fit, ignoring prevStart', () => {
    expect(visibleWindow({ total: 3, selected: 0, height: 10, prevStart: 7 })).toEqual({ start: 0, end: 3 });
  });

  it('scrolls down by the minimum needed when selection passes the bottom edge', () => {
    // window [0,5) showing rows 0-4; selecting row 5 scrolls exactly one row.
    expect(visibleWindow({ total: 100, selected: 5, height: 5, prevStart: 0 })).toEqual({ start: 1, end: 6 });
  });

  it('does not move while the selection stays inside the window', () => {
    expect(visibleWindow({ total: 100, selected: 12, height: 5, prevStart: 10 })).toEqual({ start: 10, end: 15 });
  });

  it('scrolls up when the selection is above the window', () => {
    expect(visibleWindow({ total: 100, selected: 3, height: 5, prevStart: 10 })).toEqual({ start: 3, end: 8 });
  });

  it('clamps at the end of the list', () => {
    expect(visibleWindow({ total: 20, selected: 19, height: 5, prevStart: 18 })).toEqual({ start: 15, end: 20 });
  });

  it('returns an empty window for an empty list or zero height', () => {
    expect(visibleWindow({ total: 0, selected: 0, height: 5, prevStart: 0 })).toEqual({ start: 0, end: 0 });
    expect(visibleWindow({ total: 10, selected: 0, height: 0, prevStart: 0 })).toEqual({ start: 0, end: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/table-layout.test.ts`
Expected: FAIL — cannot resolve `./table-layout.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/ui/table-layout.ts`:

```ts
/**
 * Pure table layout — the column model, cell formatting, and scroll maths that
 * `Table.tsx` draws. No React here, so every rule below is unit-testable.
 */

export interface WindowInput {
  /** Total rows in the list. */
  total: number;
  /** Index of the highlighted row. */
  selected: number;
  /** How many rows fit on screen. */
  height: number;
  /** Where the window sat last render — makes scrolling minimal rather than jumpy. */
  prevStart: number;
}

/** Half-open range: rows `[start, end)` are on screen. */
export interface Window {
  start: number;
  end: number;
}

/**
 * The visible slice of a long list.
 *
 * Minimal-scroll rather than keep-centred: the window only moves when the
 * selection would leave it, so paging through a lock chain doesn't shuffle every
 * row under your eyes. `prevStart` is what makes that stable across renders.
 */
export function visibleWindow({ total, selected, height, prevStart }: WindowInput): Window {
  if (total <= 0 || height <= 0) return { start: 0, end: 0 };
  if (total <= height) return { start: 0, end: total };

  const maxStart = total - height;
  let start = Math.min(Math.max(0, prevStart), maxStart);
  if (selected < start) start = selected;
  else if (selected >= start + height) start = selected - height + 1;

  start = Math.min(Math.max(0, start), maxStart);
  return { start, end: start + height };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/table-layout.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/table-layout.ts src/ui/table-layout.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): add virtualised scroll-window maths for the shared table

Neither sessions nor top windows its rows today — both map the entire
array, so a 500-session box renders 500 rows into a 50-row terminal.
Minimal-scroll (not keep-centred) so paging doesn't shuffle every row.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Column model and cell formatting

Replaces the `padStart`/`padEnd` calls scattered through `Sessions.tsx:36-40`, `Top.tsx:23-25`, and `Home.tsx:118-120`.

**Files:**
- Modify: `src/ui/table-layout.ts`
- Test: `src/ui/table-layout.test.ts`

**Interfaces:**
- Consumes: `visibleWindow` from Task 1 (same module, no import needed).
- Produces:
  - `Column<T> = { key: string; header: string; width: number; align?: 'left' | 'right'; value: (row: T) => string; color?: (row: T) => string | undefined }`
  - `formatCell(text: string, width: number, align?: 'left' | 'right'): string`
  - `headerCells<T>(columns: Column<T>[], sortKey?: string): { text: string; active: boolean }[]`

- [ ] **Step 1: Write the failing test**

Append to `src/ui/table-layout.test.ts`, and **extend the existing import** on line 2 to
`import { formatCell, headerCells, visibleWindow, type Column } from './table-layout.js';`
rather than adding a second import statement from the same module:

```ts
interface Row {
  pid: number;
  state: string;
}

const COLUMNS: Column<Row>[] = [
  { key: 'pid', header: 'pid', width: 6, align: 'right', value: (r) => String(r.pid) },
  { key: 'state', header: 'state', width: 10, value: (r) => r.state },
];

describe('formatCell', () => {
  it('pads left-aligned text to the column width', () => {
    expect(formatCell('ab', 5)).toBe('ab   ');
  });

  it('pads right-aligned text to the column width', () => {
    expect(formatCell('ab', 5, 'right')).toBe('   ab');
  });

  it('truncates with an ellipsis, never exceeding the width', () => {
    expect(formatCell('abcdefgh', 4)).toBe('abc…');
    expect(formatCell('abcdefgh', 4)).toHaveLength(4);
  });

  it('produces a single ellipsis at width 1 and empty string at width 0', () => {
    expect(formatCell('abc', 1)).toBe('…');
    expect(formatCell('abc', 0)).toBe('');
  });
});

describe('headerCells', () => {
  it('formats each header to its column width', () => {
    expect(headerCells(COLUMNS).map((c) => c.text)).toEqual(['   pid', 'state     ']);
  });

  it('marks the sorted column active and prefixes it with a caret', () => {
    const cells = headerCells(COLUMNS, 'pid');
    expect(cells[0]).toEqual({ text: '  ▼pid', active: true });
    expect(cells[1]?.active).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/table-layout.test.ts`
Expected: FAIL — `formatCell` / `headerCells` are not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/ui/table-layout.ts`:

```ts
/**
 * One column. `value` and `color` are functions of the row so the component
 * stays generic — a view declares its columns once instead of hand-padding
 * every cell at every render.
 */
export interface Column<T> {
  /** Stable identifier; also what `sortKey` matches against. */
  key: string;
  header: string;
  width: number;
  align?: 'left' | 'right';
  value: (row: T) => string;
  /** A theme colour, or undefined to inherit. */
  color?: (row: T) => string | undefined;
}

/**
 * Fit `text` into exactly `width` characters.
 *
 * Truncation is hard-capped: an over-long cell becomes `abc…`, never a wider
 * string that would shunt every column to its right out of alignment.
 */
export function formatCell(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return '';
  if (text.length > width) return `${text.slice(0, width - 1)}…`;
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
}

/**
 * Header cells, with the sorted column marked. `active` is returned rather than
 * a colour so the pure layer stays free of theme imports — the component decides
 * how "active" looks.
 */
export function headerCells<T>(
  columns: Column<T>[],
  sortKey?: string,
): { text: string; active: boolean }[] {
  return columns.map((c) => {
    const active = c.key === sortKey;
    return { text: formatCell(active ? `▼${c.header}` : c.header, c.width, c.align), active };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/table-layout.test.ts`
Expected: PASS — 12 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/ui/table-layout.ts src/ui/table-layout.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): add the shared column model and cell formatting

Replaces the padStart/padEnd arithmetic hand-rolled in Sessions.tsx,
Top.tsx and Home.tsx. Truncation is hard-capped so an over-long cell can
never shunt the columns to its right out of alignment.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: The `Table` component

**Files:**
- Create: `src/ui/Table.tsx`
- Test: `src/ui/Table.test.tsx`

**Interfaces:**
- Consumes: `Column`, `formatCell`, `headerCells`, `visibleWindow` from `./table-layout.js`.
- Produces: `Table<T>(props: TableProps<T>)` where
  `TableProps<T> = { columns: Column<T>[]; rows: T[]; selectedIndex: number; height: number; rowKey: (row: T, index: number) => string; sortKey?: string; empty?: string }`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/Table.test.tsx`:

```tsx
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Table } from './Table.js';
import type { Column } from './table-layout.js';

interface Row {
  pid: number;
  state: string;
}

const COLUMNS: Column<Row>[] = [
  { key: 'pid', header: 'pid', width: 6, align: 'right', value: (r) => String(r.pid) },
  { key: 'state', header: 'state', width: 10, value: (r) => r.state },
];

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ pid: 100 + i, state: `state${i}` }));

describe('Table', () => {
  it('renders the empty message when there are no rows', () => {
    const { lastFrame } = render(
      <Table columns={COLUMNS} rows={[]} selectedIndex={0} height={5} rowKey={(r) => String(r.pid)} empty="No sessions." />,
    );
    expect(lastFrame()).toContain('No sessions.');
  });

  it('renders headers and every row when they fit', () => {
    const { lastFrame } = render(
      <Table columns={COLUMNS} rows={rows(3)} selectedIndex={0} height={5} rowKey={(r) => String(r.pid)} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('pid');
    expect(frame).toContain('100');
    expect(frame).toContain('102');
    expect(frame).not.toContain('more');
  });

  it('windows a long list and reports how many rows are hidden', () => {
    const { lastFrame } = render(
      <Table columns={COLUMNS} rows={rows(100)} selectedIndex={0} height={5} rowKey={(r) => String(r.pid)} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('100'); // first row visible
    expect(frame).not.toContain('state50'); // far-off row is not rendered
    expect(frame).toContain('↓ 95 more');
  });

  it('marks the selected row', () => {
    const { lastFrame } = render(
      <Table columns={COLUMNS} rows={rows(3)} selectedIndex={1} height={5} rowKey={(r) => String(r.pid)} />,
    );
    expect(lastFrame()).toContain('▸');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/Table.test.tsx`
Expected: FAIL — cannot resolve `./Table.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/ui/Table.tsx`:

```tsx
import { Box, Text } from 'ink';
import { useRef } from 'react';
import { theme } from '../core/theme.js';
import { formatCell, headerCells, visibleWindow, type Column } from './table-layout.js';

/**
 * The shared table for every list view.
 *
 * Presentation only in the sense the rest of the codebase means it: no fetching,
 * no selection state. It does hold one ref — the previous scroll offset — so the
 * window moves minimally instead of jumping. Mutating a ref during render is the
 * same derived-state escape hatch `sessions/index.tsx:118` already uses.
 */
export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  selectedIndex: number;
  /** How many data rows fit on screen. */
  height: number;
  rowKey: (row: T, index: number) => string;
  /** Column `key` currently sorted, if any — marked in the header. */
  sortKey?: string;
  /** Shown instead of the table when `rows` is empty. */
  empty?: string;
}

export function Table<T>({ columns, rows, selectedIndex, height, rowKey, sortKey, empty }: TableProps<T>) {
  const prevStart = useRef(0);

  if (rows.length === 0) {
    return <Text color={theme.dim}>{empty ?? 'No rows.'}</Text>;
  }

  const { start, end } = visibleWindow({
    total: rows.length,
    selected: selectedIndex,
    height,
    prevStart: prevStart.current,
  });
  prevStart.current = start;

  const hiddenAbove = start;
  const hiddenBelow = rows.length - end;

  return (
    <Box flexDirection="column">
      <Text bold>
        {'  '}
        {headerCells(columns, sortKey).map((cell, i) => (
          <Text key={columns[i]?.key ?? i} color={cell.active ? theme.info : theme.dim}>
            {cell.text}
            {i < columns.length - 1 ? ' ' : ''}
          </Text>
        ))}
      </Text>

      {hiddenAbove > 0 ? <Text color={theme.dim}>{'  '}↑ {hiddenAbove} more</Text> : null}

      {rows.slice(start, end).map((row, i) => {
        const index = start + i;
        const selected = index === selectedIndex;
        return (
          <Text key={rowKey(row, index)} inverse={selected}>
            {selected ? '▸ ' : '  '}
            {columns.map((c, ci) => (
              <Text key={c.key} color={c.color?.(row)}>
                {formatCell(c.value(row), c.width, c.align)}
                {ci < columns.length - 1 ? ' ' : ''}
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/Table.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/Table.tsx src/ui/Table.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add the shared Table component

Header with sort marker, minimal-scroll window, selection marker, and
explicit "N more" indicators above and below so a windowed list never
pretends to be the whole list.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Adopt `Table` in `sessions`

**Files:**
- Modify: `src/commands/sessions/Sessions.tsx` (full rewrite of the component body)
- Test: `src/commands/sessions/Sessions.test.tsx` (existing — must still pass, plus one new case)

**Interfaces:**
- Consumes: `Table` and `Column` from Task 3.
- Produces: `SessionsProps` gains an optional `height` (default 15). Existing props `rows` and `selectedIndex` are unchanged, so `sessions/index.tsx` needs no edit.

**UX change (see Scope note):** the selected-row disclosure moves from inline-under-the-row to a fixed panel beneath the table. Inline expansion changes how many rows fit, which makes the scroll window oscillate.

- [ ] **Step 1: Read the existing tests**

Run: `npx vitest run src/commands/sessions/Sessions.test.tsx`
Expected: PASS. These are the regression suite for this task — note what they assert before changing anything.

- [ ] **Step 2: Write the failing test**

Create a **new** file `src/commands/sessions/Sessions.view.test.tsx`. The existing
`Sessions.test.tsx` renders `SessionsApp` with `vi.mock`'d queries — it is an
app-level test. The component deserves its own file with no mock machinery:

```tsx
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Sessions } from './Sessions.js';
import type { SessionRow } from './query.js';

const row = (pid: number): SessionRow => ({
  pid,
  state: 'active',
  user: 'app',
  app: 'web',
  clientAddr: null,
  backendStart: '2026-07-12 10:00:00+00',
  inStateSecs: 5,
  runningSecs: 5,
  query: 'SELECT 1',
});

describe('Sessions', () => {
  it('windows a long session list rather than rendering every row', () => {
    const many = Array.from({ length: 60 }, (_, i) => row(1000 + i));
    const { lastFrame } = render(<Sessions rows={many} selectedIndex={0} height={10} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1000');
    expect(frame).not.toContain('1059');
    expect(frame).toContain('more');
  });

  it('shows the selected row detail below the table', () => {
    const { lastFrame } = render(<Sessions rows={[row(4711)]} selectedIndex={0} />);
    expect(lastFrame()).toContain('session began');
  });

  it('renders the empty message with no rows', () => {
    const { lastFrame } = render(<Sessions rows={[]} selectedIndex={0} />);
    expect(lastFrame()).toContain('No client sessions.');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/commands/sessions/Sessions.test.tsx`
Expected: FAIL — `height` is not a prop, and all 60 rows render.

- [ ] **Step 4: Rewrite the component**

Replace the whole of `src/commands/sessions/Sessions.tsx` with:

```tsx
import { Box, Text } from 'ink';
import { formatDuration, truncateQuery } from '../../core/format.js';
import { theme } from '../../core/theme.js';
import { Table } from '../../ui/Table.js';
import type { Column } from '../../ui/table-layout.js';
import type { SessionRow } from './query.js';

function stateColor(state: string | null): string {
  if (state === 'active') return theme.success;
  if (state?.startsWith('idle in transaction')) return theme.critical;
  return theme.dim;
}

/**
 * Columns replace the hand-padded cells this component used to build. Every
 * query cell still goes through `truncateQuery`, which redacts — never slice
 * `pg_stat_activity.query` directly.
 */
const COLUMNS: Column<SessionRow>[] = [
  { key: 'pid', header: 'pid', width: 6, align: 'right', value: (r) => String(r.pid), color: () => theme.info },
  { key: 'state', header: 'state', width: 22, value: (r) => r.state ?? '?', color: (r) => stateColor(r.state) },
  { key: 'age', header: 'age', width: 8, align: 'right', value: (r) => formatDuration(r.inStateSecs) },
  { key: 'who', header: 'user@app', width: 20, value: (r) => `${r.user ?? '?'}@${r.app || '?'}`, color: () => theme.dim },
  { key: 'query', header: 'query', width: 60, value: (r) => (r.query ? truncateQuery(r.query, 60) : '') },
];

export interface SessionsProps {
  rows: SessionRow[];
  selectedIndex: number;
  /** Data rows to show at once; the rest scroll. */
  height?: number;
}

/**
 * Presentation only. The selected row's detail sits BELOW the table rather than
 * inline beneath its row: an inline expansion changes how many rows fit, which
 * makes the scroll window oscillate as you move the selection.
 */
export function Sessions({ rows, selectedIndex, height = 15 }: SessionsProps) {
  const selected = rows[selectedIndex];
  return (
    <Box flexDirection="column">
      <Table
        columns={COLUMNS}
        rows={rows}
        selectedIndex={selectedIndex}
        height={height}
        rowKey={(r) => String(r.pid)}
        empty="No client sessions."
      />
      {selected ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>
            {'  '}client {selected.clientAddr ?? 'local'} · session began {selected.backendStart ?? '?'}
          </Text>
          {selected.query ? <Text color={theme.dim}>{'  '}{truncateQuery(selected.query, 200)}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}
```

- [ ] **Step 5: Run the full sessions suite**

Run: `npx vitest run src/commands/sessions/`
Expected: PASS. If an existing assertion fails only because the detail text moved below the table, update that assertion — it is the intended change. If any assertion about *data* fails, the migration is wrong; fix the component, not the test.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/commands/sessions/Sessions.tsx src/commands/sessions/Sessions.view.test.tsx src/commands/sessions/Sessions.test.tsx
git commit -m "$(cat <<'EOF'
refactor(sessions): render through the shared Table

Declares columns instead of hand-padding cells, and gains scrolling: the
view used to map every row, so a 500-session box rendered 500 rows.

The selected row's detail moves below the table — inline expansion
changes how many rows fit, which makes the scroll window oscillate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Adopt `Table` in `top`

**Files:**
- Modify: `src/commands/top/Top.tsx` (full rewrite of the component body)
- Test: `src/commands/top/TopApp.test.tsx` (existing — must still pass)

**Interfaces:**
- Consumes: `Table`, `Column` from Task 3; `sortKey` prop added in Task 2's `headerCells`.
- Produces: `TopProps` gains optional `height` (default 15). `rows`, `sort`, `selectedIndex`, `filter` unchanged, so `top/index.tsx` needs no edit.

This task is what proves the `sortKey` header marker — `top` is the only view with a sorted-column indicator.

- [ ] **Step 1: Write the failing test**

Create a **new** file `src/commands/top/Top.view.test.tsx`. `TopApp.test.tsx`
mocks the query layer and tests the container; the component gets its own file.

Note `queryid` is `string | null`, not a number, and `QueryRow` extends
`QueryStat` — every field below is required:

```tsx
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Top } from './Top.js';
import type { QueryRow } from './stats.js';

const row = (n: number): QueryRow => ({
  queryid: String(n),
  query: `SELECT ${n} FROM orders`,
  calls: 120,
  totalMs: 5400,
  meanMs: 45,
  stddevMs: 10,
  rows: 120,
  sharedBlksHit: 900,
  sharedBlksRead: 100,
  cacheHitPct: 90,
});

describe('Top', () => {
  it('marks the sorted column in the header', () => {
    const { lastFrame } = render(<Top rows={[row(1)]} sort="mean" selectedIndex={0} />);
    expect(lastFrame()).toContain('▼mean ms');
  });

  it('windows a long query list', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i));
    const { lastFrame } = render(<Top rows={rows} sort="total" selectedIndex={0} height={10} />);
    expect(lastFrame()).toContain('more');
  });

  it('explains an empty list differently when a filter is active', () => {
    const { lastFrame: noFilter } = render(<Top rows={[]} sort="total" selectedIndex={0} />);
    expect(noFilter()).toContain('pg_stat_statements');

    const { lastFrame: filtered } = render(<Top rows={[]} sort="total" selectedIndex={0} filter="orders" />);
    expect(filtered()).toContain('No queries match');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/commands/top/`
Expected: FAIL — no `height` prop; all rows render.

- [ ] **Step 3: Rewrite the component**

Replace the whole of `src/commands/top/Top.tsx` with:

```tsx
import { Box, Text } from 'ink';
import { theme } from '../../core/theme.js';
import { Table } from '../../ui/Table.js';
import type { Column } from '../../ui/table-layout.js';
import { cellQuery } from './render.js';
import type { QueryRow, SortMode } from './stats.js';

/** Colour the cache cell by how cold it is — the whole point of the cache sort. */
function cacheColor(pct: number | null): string {
  if (pct === null) return theme.dim;
  if (pct < 50) return theme.critical;
  if (pct < 90) return theme.warning;
  return theme.success;
}

/**
 * Column `key`s match `SortMode` so `sortKey` marks the active column with no
 * extra mapping. `cellQuery` redacts — never slice query text directly.
 */
const COLUMNS: Column<QueryRow>[] = [
  { key: 'total', header: 'total ms', width: 9, align: 'right', value: (r) => String(Math.round(r.totalMs)) },
  { key: 'mean', header: 'mean ms', width: 9, align: 'right', value: (r) => r.meanMs.toFixed(2) },
  { key: 'calls', header: 'calls', width: 8, align: 'right', value: (r) => String(r.calls) },
  {
    key: 'cache',
    header: 'cache',
    width: 7,
    align: 'right',
    value: (r) => (r.cacheHitPct === null ? '—' : `${Math.round(r.cacheHitPct)}%`),
    color: (r) => cacheColor(r.cacheHitPct),
  },
  { key: 'query', header: 'query', width: 70, value: (r) => cellQuery(r.query, 70) },
];

export interface TopProps {
  rows: QueryRow[];
  sort: SortMode;
  selectedIndex: number;
  /** Active filter term, shown when non-empty. */
  filter?: string;
  /** Data rows to show at once; the rest scroll. */
  height?: number;
}

export function Top({ rows, sort, selectedIndex, filter, height = 15 }: TopProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Table
        columns={COLUMNS}
        rows={rows}
        selectedIndex={selectedIndex}
        height={height}
        sortKey={sort}
        rowKey={(r, i) => String(r.queryid ?? i)}
        empty={
          filter
            ? `No queries match “${filter}”.`
            : 'No query statistics. Is pg_stat_statements populated yet?'
        }
      />
      {filter && rows.length > 0 ? (
        <Text color={theme.dim}>filter: “{filter}” ({rows.length} shown)</Text>
      ) : null}
    </Box>
  );
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — every existing test plus the new ones. The `top` selection marker changes from `❯` to the shared `▸`; if an existing assertion checks for `❯`, update it to `▸` (consistency across views is the intent).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Verify against a real database**

```bash
npm run db:up
npm run db:seed
export DATABASE_URL='postgres://postgres:secret@localhost:55432/appdb'
npm run dev -- sessions   # j/k past the bottom of the window; confirm it scrolls
npm run dev -- top        # press o; confirm ▼ moves to the sorted column
npm run db:down
```

Expected: both views scroll instead of overflowing, columns stay aligned, and the sort marker follows `o`.

- [ ] **Step 7: Commit**

```bash
git add src/commands/top/Top.tsx src/commands/top/Top.view.test.tsx src/commands/top/TopApp.test.tsx
git commit -m "$(cat <<'EOF'
refactor(top): render through the shared Table

Declares columns instead of hand-padding, gains scrolling, and proves the
sortKey header marker. Selection marker is now the shared ▸ so every list
view highlights the same way.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- `npm test` passes with the new `table` and `Table` suites plus all pre-existing tests.
- `npm run typecheck` is clean.
- `sessions` and `top` contain **no** `padStart` or `padEnd` calls.
- Both views scroll rather than overflowing a short terminal, verified against the seeded dev database.

## Not in this plan

- The tab strip, global nav keys, suppression rule, `Esc` change, `useVerdicts()` → **Phase 1b**.
- Adopting `Table` in `Home.tsx` and `LockChain.tsx` → Phase 1b, where the shell refactor touches those files anyway. Migrating them here would mean editing the same components twice.
- `config` and `seq` views → Phase 2.
