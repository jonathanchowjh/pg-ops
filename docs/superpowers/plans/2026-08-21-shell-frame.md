# Shell Frame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn four separately-invoked views into one app with a tab strip, where every view is one keystroke away from anywhere.

**Architecture:** A `Shell` owns navigation and mounts exactly one view at a time. It renders the tab strip and passes it *down* as a slot, so each view keeps its own `StatusBar` and no view state has to flow upward. Global keys live in one `useGlobalNav` hook that goes inert while a modal or filter has the keyboard.

**Tech Stack:** TypeScript ESM (strict), Ink 5, React 18, Vitest 4, ink-testing-library 4.

**Spec:** `docs/superpowers/specs/2026-08-19-pgops-ops-console-design.md` (rev. 4) — §5.3 tabs vs subcommands, §5.5 key bindings and the suppression rule, §5.6 `Esc` semantics, §9 Phase 1(2).

## Scope

**In:** the frame — tab strip, global nav keys, suppression, `Esc`, placeholders for unbuilt tabs, and `LockChain` onto `Table`.

**Out, deliberately:** `useVerdicts()` and the `⚠` glyphs (spec §5.4). The strip ships showing plain names. Verdicts are a polling subsystem with their own cadence, their own failure modes, and their own §10 test row; folding them in here would make one plan that cannot be reviewed as a unit. They are the next plan, and the strip is built to receive them.

**Out:** migrating `Home.tsx`'s panels onto `Table`. Those panels are not selectable lists — `Table` requires `selectedIndex` and `rowKey` and always renders a selection gutter. Forcing them through it would mean adding a selection-optional mode to `Table` to serve one caller. `Home.tsx` keeps its `padStart`/`padEnd` until something else needs that mode.

## Two things found while reading the code that the spec did not anticipate

**1. `LockChain.tsx:47` renders every root.** `roots.map(...)` with no window — the same latent bug `sessions` and `top` had before Phase 1a. A 200-root pile-up renders 200 rows into a 24-row terminal. It is the last hand-rolled list in the codebase, it still uses `❯` where `Table` uses `▸`, and the shell is about to restructure that file anyway. Task 1 fixes it, so the shell then sees four views of uniform shape.

**2. `ConfirmModal.tsx:18` calls `useInput` unconditionally.** Ink fires *every* registered handler for a keypress; there is no capture and nothing to stop propagation. So a shell-level `useInput` will fire *alongside* the modal's — and the modal treats "any other key" as cancel. Without suppression, pressing `4` with a kill confirmation open both cancels the kill and navigates to `top`. This is why §5.5 calls the suppression rule "required for correctness" rather than a nicety, and it is the single highest-risk regression in this plan.

## Deliberate deviation from the spec's wording

Spec §9 says *"A shell-owned tab strip means restructuring all four existing views so the shell owns chrome."* This plan does **not** move `StatusBar` into the shell.

The spec's layout puts `StatusBar` above the strip, so a shell owning the bar would need every view's `subcommand`, `cadence`, `freshness`, `hints`, and transient `message` to flow *upward* — state that lives in four separate containers and changes on every poll. The mechanism for that (a callback the child fires from an effect, into shell state, which re-renders the child) is an effect loop waiting to happen, and it buys nothing: the bar's contents are genuinely per-view, and the views already build them correctly.

Instead the **element flows down**: the shell renders the strip and hands it to the mounted view as a `strip` prop, which the view drops in immediately below its own `StatusBar`. Same rendered layout, no upward state, no loop risk. The shell still owns what it must — which view is mounted, and the keyboard.

The cost is one line per view and the chance a future view forgets it; Task 6 pins that with a test over every view.

## Global Constraints

- **Terminal floor is 80x24.** The strip must fit 80 columns; it wraps to two lines by design (spec §5.1 mockup), and those lines count against every view's `CHROME_LINES`.
- **`Table`'s `maxLines` is a budget including chrome.** Adding the strip means every view's `CHROME_LINES` grows. Get this wrong and the tables overflow again — that is what Phase 1b just fixed.
- **Never measure or truncate text with `.length`/`.slice`.** Use `stringWidth` and `fitToWidth` (`src/core/format.ts`).
- **Query text redaction:** `pg_stat_activity.query` through `truncateQuery`, `pg_stat_statements.query` through `cellQuery`. Never `.slice()` query text.
- ESM import specifiers end in `.js` even for `.ts` sources.
- `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` are on.
- Code style (CLAUDE.md): light OOP. No classes, no interfaces-as-abstraction, no inheritance, no factories, no DI plumbing. **No React context** — pass props, the way `onBack` already is.
- Both `npm run typecheck` and `npm run typecheck:test` clean; suite green (252 at plan time).
- Commit trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## A note on how Tasks 5-7 are specified

Tasks 1-4 give exact code and exact test values. Tasks 5-7 give exact *contracts, tests, and failure modes* but not full implementations, and that is deliberate rather than an omission.

The previous plan in this series supplied complete "verbatim" implementations, and three of them contained real bugs that implementers had to find: a test assertion that could never fail, a missing `width` on a root `Box`, and a truncation done in the wrong units. Every one was in code I wrote by reasoning rather than by running. Tasks 5-7 are integration work whose exact shape depends on what Tasks 1-4 produce, so speculative code there would repeat that mistake with less to gain.

What is specified precisely instead: every interface, every test that must exist, and every named failure mode. An implementer who satisfies those has built the right thing. If a contract here turns out to be wrong, say so and stop — do not work around it silently.

## File Structure

| File | Responsibility |
|---|---|
| `src/commands/locks/LockChain.tsx` | **Modify.** Render through `Table`; detail moves below the table. |
| `src/ui/tabs.ts` | **Create.** The tab registry: key, name, whether it is built. One source of truth. |
| `src/ui/TabStrip.tsx` | **Create.** Pure presentation of the tab list. No glyphs yet. |
| `src/ui/useGlobalNav.ts` | **Create.** `1`-`9`, `Tab`/`Shift-Tab`, `D`, `Esc`, gated by `enabled`. |
| `src/commands/shell/Shell.tsx` | **Create.** Mounts one view, owns nav and capture state, renders the strip. |
| `src/commands/shell/Placeholder.tsx` | **Create.** The one-line "not built yet" view. |
| `src/commands/{home,locks,top,sessions}/index.tsx` | **Modify.** Accept `strip` and `onCapture`; drop `onBack` in favour of shell-owned `Esc`. |
| `src/cli.tsx` | **Modify.** Every subcommand opens the shell on that tab. |

---

### Task 1: `LockChain` renders through `Table`

**Files:**
- Modify: `src/commands/locks/LockChain.tsx`
- Modify: `src/commands/locks/index.tsx`
- Test: `src/commands/locks/LockChain.view.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `Table`, `Column<RootBlocker>`, `useTerminalSize`.
- Produces: `LockChainProps { roots, selectedIndex, width?, maxLines? }`.

**Why first.** It is the last hand-rolled list, it renders every root into a fixed terminal, and the shell restructures this file regardless. Doing it now means the shell sees four uniform views.

**Column intent** — mirror `sessions`, whose shape this most resembles:

| key | header | width | intent |
|---|---|---:|---|
| `pid` | `pid` | 7 | never dropped (carries the warning marker) |
| `who` | `user@app` | 20 | `drop: 2` |
| `held` | `state · held` | 22 | never dropped |
| `mode` | `mode` | 16 | `drop: 3` (dropped first) |
| `waiters` | `blocking` | 9, right | never dropped — it is the severity signal |

**The detail moves below the table.** Today `ExpandedDetail` renders inline under the selected row. `Sessions.tsx` documents why that is wrong: *"an inline expansion changes how many rows fit, which makes the scroll window oscillate as you move the selection."* Same fix — detail below, exactly as `Sessions` does it.

- [ ] **Step 1: Write the failing test**

```tsx
it('windows a long root list rather than rendering every row', () => {
  const roots = Array.from({ length: 60 }, (_, i) => rootBlocker(1000 + i));
  const { lastFrame } = render(<LockChain roots={roots} selectedIndex={0} width={120} maxLines={12} />);
  const frame = lastFrame() ?? '';
  expect(frame).toContain('1000');
  // budgetRows(12, 60) = 9, so the window is [0, 9) and pid 1009 is the
  // first excluded row — the boundary an off-by-one would leak.
  expect(frame).toContain('1008');
  expect(frame).not.toContain('1009');
  expect(frame).toContain('more');
});

it('renders the same number of lines at every width', () => {
  const roots = Array.from({ length: 60 }, (_, i) => rootBlocker(1000 + i));
  const count = (w: number) =>
    (render(<LockChain roots={roots} selectedIndex={5} width={w} maxLines={12} />).lastFrame() ?? '')
      .split('\n').length;
  const baseline = count(400);
  for (const w of [80, 100, 120, 160]) expect(count(w)).toBe(baseline);
});
```

Write a `rootBlocker(pid, over?: Partial<RootBlocker>)` factory with **pathological** values — a `user@app` past 20 columns, a long `heldMode`, a `query` of `'SELECT '.repeat(80)`. A fixture that never saturates a column proves nothing; this branch learned that the hard way.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/commands/locks`
Expected: FAIL — `width`/`maxLines` are not props, and all 60 roots render.

- [ ] **Step 3: Implement**

Declare `COLUMNS` per the table above. Render `<Table>` with `rowKey={(r) => String(r.pid)}` and `empty="No lock contention. The DB is not blocked."`. Keep `adviseBlocker` and the waiter breakdown, but move them into a detail block below the table, mirroring `Sessions.tsx`. Query text still goes through `truncateQuery`. Drop `CompactRow`'s `❯` — `Table` supplies `▸`.

In `locks/index.tsx`, add `const terminal = useTerminalSize();` and a `CHROME_LINES` constant. Derive it from what that view actually renders — the bordered `StatusBar` (3, plus 1 when a message shows), the detail block, and the `polling pg_locks…` line — and comment each term. Do not copy `sessions`' number.

- [ ] **Step 4: Verify**

Run: `npx vitest run src/commands/locks && npm run typecheck && npm run typecheck:test`

- [ ] **Step 5: Commit**

```bash
git add src/commands/locks
git commit -m "refactor(locks): render the lock chain through the shared Table"
```

---

### Task 2: The tab registry

**Files:**
- Create: `src/ui/tabs.ts`
- Test: `src/ui/tabs.test.ts`

**Interfaces:**
- Produces: `TABS: Tab[]`, `interface Tab { key: string; name: string; built: boolean }`, `tabForKey(k: string): Tab | undefined`, `nextTab(name: string, dir: 1 | -1): Tab`.

Spec §5.3's nine tabs, in fixed order: `1` triage, `2` sessions, `3` locks, `4` top, `5` space, `6` vacuum, `7` replication, `8` seq, `9` system. Built today: triage, sessions, locks, top. **`0` is deliberately unbound** — spec §5.3: *"A tenth tab requires a new registered escalation rule, not an empty slot."*

- [ ] **Step 1: Write the failing test**

```ts
describe('TABS', () => {
  it('has exactly nine tabs on keys 1-9, in spec order', () => {
    expect(TABS.map((t) => t.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(TABS.map((t) => t.name)).toEqual([
      'triage', 'sessions', 'locks', 'top', 'space', 'vacuum', 'replication', 'seq', 'system',
    ]);
  });

  it('leaves 0 unbound', () => {
    expect(tabForKey('0')).toBeUndefined();
  });

  it('marks exactly the four built views as built', () => {
    expect(TABS.filter((t) => t.built).map((t) => t.name)).toEqual(['triage', 'sessions', 'locks', 'top']);
  });

  it('cycles forward and backward, wrapping at both ends', () => {
    expect(nextTab('triage', 1).name).toBe('sessions');
    expect(nextTab('system', 1).name).toBe('triage');
    expect(nextTab('triage', -1).name).toBe('system');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/ui/tabs.test.ts`
Expected: FAIL — cannot resolve `./tabs.js`.

- [ ] **Step 3: Implement.** A plain exported array and two bare functions. No class.

- [ ] **Step 4: Verify** — tests pass, both typechecks clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/tabs.ts src/ui/tabs.test.ts
git commit -m "feat(ui): the tab registry, nine tabs with 0 deliberately unbound"
```

---

### Task 3: `TabStrip`

**Files:**
- Create: `src/ui/TabStrip.tsx`
- Test: `src/ui/TabStrip.test.tsx`

**Interfaces:** consumes `TABS`. Produces `TabStrip({ active, width })`.

Renders `1 triage  2 sessions  …` across up to two lines, the active tab highlighted, unbuilt tabs dimmed. **No verdict glyphs** — spec §5.2: a warning glyph means "act now," and until `useVerdicts` exists there is nothing honest to show. A test asserts the strip renders no warning or tick under any input, so a later contributor cannot quietly add one without deleting that test.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders every tab with its key', () => {
  const frame = render(<TabStrip active="triage" width={100} />).lastFrame() ?? '';
  for (const t of TABS) expect(frame).toContain(`${t.key} ${t.name}`);
});

it('fits 80 columns without growing past two lines', () => {
  const lines = (render(<TabStrip active="triage" width={80} />).lastFrame() ?? '').split('\n');
  expect(lines.length).toBeLessThanOrEqual(2);
  // Line count, not line width: Ink wraps at the Box width, so a too-wide
  // strip shows up as a third line, never as an over-wide line.
});

it('carries no verdict glyph — a warning must mean "act now" (spec §5.2)', () => {
  for (const active of TABS.map((t) => t.name)) {
    const frame = render(<TabStrip active={active} width={100} />).lastFrame() ?? '';
    expect(frame).not.toMatch(/[⚠✓]/);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/ui/TabStrip.test.tsx`
Expected: FAIL — cannot resolve `./TabStrip.js`.

- [ ] **Step 3: Implement.** Set `width` on the root `<Box>`, as `Table` does — that is what makes the two-line assertion meaningful.

- [ ] **Step 4: Verify.**

- [ ] **Step 5: Commit**

```bash
git add src/ui/TabStrip.tsx src/ui/TabStrip.test.tsx
git commit -m "feat(ui): the tab strip, names only"
```

---

### Task 4: `useGlobalNav`

**Files:**
- Create: `src/ui/useGlobalNav.ts`
- Test: `src/ui/useGlobalNav.test.tsx`

**Interfaces:**
- Produces: `useGlobalNav({ enabled, onJump, onCycle, onDoctor, onEscape })`.

**This hook is where the correctness risk lives.** Ink fires every registered `useInput` handler; there is no propagation to stop. `ConfirmModal.tsx:18` registers one unconditionally and treats any non-`y` key as cancel. So with a kill confirmation open, an unguarded `4` would cancel the kill *and* navigate away.

`enabled` is the whole defence, and it must be passed as `{ isActive: enabled }` to `useInput` — **not** an early `return` inside the handler body. Both appear to work; only the first is robust to someone later adding a branch above the guard.

- [ ] **Step 1: Write the failing test**

Write a small `Probe` component that calls the hook with spy callbacks, then:

```tsx
it('jumps on 1-9 and ignores 0', () => { /* onJump called per digit, never for '0' */ });
it('cycles on Tab and Shift-Tab', () => { /* both directions */ });
it('opens doctor on D, not on lowercase d', () => { /* case matters */ });
it('escapes on Esc', () => { /* onEscape fired */ });

it('is completely inert when disabled — the suppression rule (spec §5.5)', () => {
  // Every callback, every key, zero calls. This is the test that stops a
  // digit typed into a filter from navigating, and a digit pressed with a
  // ConfirmModal open from both cancelling the kill and changing tab.
  const spies = { onJump: vi.fn(), onCycle: vi.fn(), onDoctor: vi.fn(), onEscape: vi.fn() };
  const { stdin } = render(<Probe enabled={false} {...spies} />);
  for (const key of ['1', '5', '9', 'D', '\t', '']) stdin.write(key);
  for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/ui/useGlobalNav.test.tsx`
Expected: FAIL — cannot resolve `./useGlobalNav.js`.

- [ ] **Step 3: Implement** with `useInput(handler, { isActive: enabled })`.

- [ ] **Step 4: Verify.**

- [ ] **Step 5: Commit**

```bash
git add src/ui/useGlobalNav.ts src/ui/useGlobalNav.test.tsx
git commit -m "feat(ui): global navigation keys, inert while suppressed"
```

---

### Task 5: `Shell` and `Placeholder`

**Files:**
- Create: `src/commands/shell/Shell.tsx`, `src/commands/shell/Placeholder.tsx`
- Test: `src/commands/shell/Shell.test.tsx`

**Interfaces:**
- Produces: `Shell({ target, initialTab })`, and the two props every view now takes: `strip: ReactNode`, `onCapture: (captured: boolean) => void`.

`Shell` holds `activeTab` and `captured`. It calls `useGlobalNav({ enabled: !captured, ... })`, builds `<TabStrip active={activeTab} width={terminal.columns} />`, and passes it to the mounted view as `strip`. `Esc` always sets the tab to `triage` (spec §5.6) — but only reaches the shell when nothing is captured, so a modal or filter dismisses first, which is exactly the specified ordering.

An unbuilt tab mounts `Placeholder`, naming the phase that delivers it. **It must never render a tick** (spec §5.3) — a tab must not claim health for something unmeasured.

- [ ] **Step 1: Write the failing test**

Cover: jumping to a built tab mounts that view; jumping to an unbuilt tab shows the placeholder with its phase and no tick; `Esc` from any view returns to triage; and — end to end, not just at the hook — a view reporting `onCapture(true)` makes every nav key inert.

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.**

- [ ] **Step 5: Commit**

```bash
git add src/commands/shell
git commit -m "feat(shell): one app, nine tabs, one keystroke apart"
```

---

### Task 6: Wire the four views in

**Files:** `src/commands/home/index.tsx`, `src/commands/locks/index.tsx`, `src/commands/top/index.tsx`, `src/commands/sessions/index.tsx`, and their test files. Also `src/ui/geometry.test.tsx`.

Each view: accept `strip` and render it immediately below its `StatusBar`; accept `onCapture` and call it when a `ConfirmModal` opens or closes and when filter mode toggles; **grow `CHROME_LINES` by the strip's height**; drop `onBack` (the shell owns `Esc`) and drop `Esc back` from the hints.

**The `CHROME_LINES` change is the one that silently breaks geometry.** The strip is two lines at 80 columns. Miss it and every table overflows again — the exact defect Phase 1b existed to fix. Derive each view's constant from what it renders and comment every term.

- [ ] **Step 1: Write the failing tests**

For **every** view: the strip renders; opening a `ConfirmModal` calls `onCapture(true)` and closing calls `onCapture(false)`; entering filter mode calls `onCapture(true)` and leaving calls `onCapture(false)`. Then add each view to `src/ui/geometry.test.tsx`'s `views` array, so the same-line-count-at-every-width invariant covers all four.

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement, one view at a time**, running that view's tests between each.
- [ ] **Step 4: Verify** — full suite, both typechecks, build.

- [ ] **Step 5: Commit**

```bash
git add src/commands src/ui/geometry.test.tsx
git commit -m "refactor(views): take the strip, report capture, drop per-view Esc"
```

---

### Task 7: `cli.tsx` opens the shell

**Files:** `src/cli.tsx`, `src/cli.test.ts`, `README.md`

Every subcommand now opens the shell on that tab: `pgops locks` mounts the shell with `initialTab: 'locks'`. **This is a documented behaviour change** (spec §5.6): `Esc` used to be inert on a directly-invoked view and now returns to triage, because there is always a triage to return to.

`--snapshot` is unchanged — it never enters the TUI, so it keeps its one-shot path and its exit-code contract.

- [ ] **Step 1: Write the failing test** — `pgops locks` mounts the shell on the locks tab; `--snapshot` still bypasses the TUI entirely and keeps its exit code.
- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — full suite, both typechecks, build.
- [ ] **Step 5: Update `README.md` §Keys** — document `1`-`9`, `Tab`/`Shift-Tab`, `D`, and the `Esc` change. The README currently documents the old rule and would otherwise become false.

- [ ] **Step 6: Commit**

```bash
git add src/cli.tsx src/cli.test.ts README.md
git commit -m "feat(cli): every subcommand opens the shell on its tab"
```

---

## Done when

- Nine tabs, `0` unbound, order fixed, no verdict glyphs anywhere.
- `1`-`9`, `Tab`/`Shift-Tab`, `D` and `Esc` work from every view — and are **provably inert** while a `ConfirmModal` is open or filter mode is active.
- `Esc` always returns to triage, after dismissing any modal or filter.
- Unbuilt tabs show a placeholder naming their phase, never a tick.
- `LockChain` windows and fits 80 columns; the geometry gate covers all four views.
- `npm test`, `npm run typecheck`, `npm run typecheck:test`, `npm run build` all clean.

**Not verified by this plan, and not claimed:** behaviour against a live database, and in a real resizing terminal. `ink-testing-library`'s stdout stub cannot vary `columns`. A manual pass in an 80x24 window — jump every tab, open a kill modal and press digits, enter a filter and type digits — is worth doing before merge and must be **reported as done or not done, never assumed**. Phase 1a's plan claimed a verification that never ran; Phase 1b's did not. Keep it that way.

## Carried forward

- `useVerdicts()` and the strip's warning glyphs — the next plan.
- `Home.tsx`'s panels still hand-pad; they need a selection-optional `Table`.
- `Sessions.tsx`'s detail-panel `Box` has no explicit `width` (harness-only today, and its safety now depends on the `fitToWidth` fix).
- `cliTruncate('x', 1)` returns an ellipsis rather than the character; any `flex` column without a `min` can be solved to width 1.
- No test covers chrome outside `Table`'s own `Box` — `Top`'s `paddingX` removal is guarded by a comment alone, and this plan adds a strip *above* every table.
