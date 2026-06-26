# pgops — In-tool interaction & flow UX (design)

- **Date:** 2026-06-26
- **Status:** proposed (brainstormed; pending review)
- **Scope:** the UX of the *running* TUI — primarily the `locks` view (the signature
  flow), plus the shared interaction grammar every subcommand inherits.
- **Out of scope:** the install/README/discovery funnel and a no-DB demo mode
  (a separate "evaluation gap" effort), and any new subcommand.

## Problem

The `locks` root-blocker list shows **identity** (pid, app, who is waiting) but
none of the **decision inputs** a DBA needs to choose wait / kill / escalate.
The worst gap: the blocker's `state` — `idle in transaction` (a stuck client,
safe to kill) vs `active` (real work, killing rolls it back) — is the single
biggest decision driver and **isn't even fetched** by the query. The current UI
cannot support the kill decision even in principle.

Secondary: keys are inconsistent across views — `k` = kill in `locks` but
= move-up in `top` — so vim muscle memory is wrong in the one view with a
destructive action.

## Goals

1. The list is a **decision surface**: decide wait/kill at a glance.
2. One coherent **interaction grammar** across all views.
3. **Progressive disclosure**: scan all → decide on one → investigate deeper,
   with no modes to toggle.
4. **Correctness**: a kill can never target the wrong backend.

## 1. Interaction grammar (every view obeys)

| Key | Meaning | Scope |
|-----|---------|-------|
| `j` `k` `↑` `↓` | move selection | universal, **sacred** |
| `Enter` | drill into detail for the selected row | universal |
| `x` | execute this view's single write action (always confirmed + audit-logged) | universal |
| `s` | snapshot view → markdown file | universal |
| `q` / `Ctrl-C` | quit | universal |
| `?` | help overlay | universal (**key reserved; panel deferred**) |
| `/` | filter | view verb (top, future) |
| `o` | cycle sort order | view verb (top) |

- `useListNavigation`: `j`/`k`/`↑`/`↓` always navigate. Add a guard so
  `actionKeys` can never contain a navigation key (future authors get an error,
  not a silent collision).
- `locks`: kill moves `k` → `x`; status-bar hints updated.
- `x` generalizes: every view has **at most one** primary write action, on `x`,
  always behind the confirm modal + audit log (today kill; later "drop slot",
  "run maintenance").

## 2. The locks list as a decision surface

Each root blocker must answer wait/kill. Decision inputs:

- **state** — `active` / `idle in transaction` / `idle in transaction (aborted)`
  — **NEW, requires a query change.**
- **held duration** — from `xact_start`.
- **lock mode + relation** — e.g. `AccessExclusive on public.users`.
- **blast radius** — total count **and per-app breakdown** (`web-api×4, checkout×2`).
- **query** — truncated in the list, full in detail.
- **advise line** — heuristic verdict (§4).

**Data change.** Add `blocking_act.state` (and `blocked_act.state`) to
`LOCK_CHAIN_SQL`; extend `LockEdge` and `RootBlocker`/`Waiter` types; coerce in
`fetchLockEdges`. Add a **pure transform** that derives the per-app waiter
breakdown from the edges (unit-tested, like `chain.ts`).

## 3. Progressive disclosure (no modes)

Disclosure is a function of cursor position, not a mode the user switches:

- **Tier 1 — compact (scan):** one line per blocker —
  `⚠ pid  who  state age  lock  blocking N`.
- **Tier 2 — selected expands inline (decide):** the row under the cursor opens
  to the full decision block — query, per-app breakdown, advise, `[x]`. Collapses
  when the cursor moves. The user never leaves the list.
- **Tier 3 — `Enter` → full detail page (investigate):** untruncated query, the
  complete waiter tree, advise, kill; `Esc` returns. **May land as a second
  phase**; Tiers 1+2 already deliver the decision UX.

```
 LOCKS · appdb@prod · updated 1s ago              j/k move · x kill · s snap · q quit
 ────────────────────────────────────────────────────────────────────────────────
❯⚠ 18432  deploy@batch-worker   idle in txn 14m23s   AccessExcl on users   blocking 7
    UPDATE users SET migrated = true WHERE id BETWEEN 1 AND 5000000
    blocking 7 → web-api×4, checkout×2, cron×1
    ▸ stuck 14m, no running query — almost certainly safe to kill            [x]

 ⚠ 19001  app@cron-cleanup      active 8s           ShareLock on orders    blocking 1
 ⚠ 20114  etl@warehouse         idle in txn 3m02s   RowExcl on events      blocking 2
```

## 4. Advise heuristic

Opinionated but **clearly marked as a heuristic** (prefix `▸`), and it never
auto-acts. Rules for `locks`:

- `idle in transaction` / aborted → *"stuck client (idle in transaction {age}) —
  no work in flight; likely safe to kill."* (safe tone / green)
- `active`, held `< 30s` → *"active query, {age} — real work; killing rolls it
  back. consider waiting."* (caution / amber)
- `active`, held `≥ ~5m` → *"long-running active query ({age}) — stuck or heavy;
  judge by the query."* (caution / amber, leaning action)

Blast radius is shown as fact and may sharpen the wording, but is never the sole
basis of the verdict. The heuristic is a small **pure function** → unit-tested.

## 5. Correctness: selection tracks pid, not row index

The list re-polls every 2s and re-sorts worst-first. Selection must follow the
**pid**, not the index, so a re-order between selection and keypress can't shift
the kill target. Track `selectedPid`; derive the index each render; if the pid
has vanished, fall back to the nearest row. The confirm modal already shows the
pid — but the *target* is locked to the pid the user selected, captured at
selection time.

## 6. The resolution moment

On a successful kill, show a transient banner —
`✓ terminated pid {pid} — {N} waiters released` — for ~2s or until the next poll
shows the chain cleared. Turns a blink-to-empty into visible closure (we know
`totalWaiters` at kill time).

## 7. Liveness

The status bar shows freshness — `updated {N}s ago` (optionally a pulse char that
ticks each poll). Serves the "run it during the incident" promise: the user
trusts the screen is live, even when the healthy state ("No lock contention")
looks identical to a stale screen.

## 8. Snapshot flow

- **Interactive `s`** → write a file to `~/.pgops/snapshots/`, show the path
  (as built; Ink owns stdout, so it can't cleanly print markdown there).
- **New `pgops locks --snapshot`** (non-interactive) → connect, fetch once, print
  markdown to stdout, exit. The pipe-friendly path; also the scripting/demo path.
- **Fix the README** key table: `s` writes a *file* (not stdout); document
  `--snapshot` for stdout.

## 9. top alignment (minor)

- Reorder hints to the grammar; `top` already avoids the `k` collision.
- The Tier 1/2 disclosure pattern applies naturally (the selected query row
  expands to the full query + stddev + cache breakdown). Noted as a **follow-on**,
  not built in this pass.

## Error handling

- Connection errors: unchanged (fail fast before the TUI; poll errors shown red
  in the status bar).
- `--snapshot`: on error, print to stderr and exit non-zero (scriptable).

## Testing

- Pure transforms — per-app waiter breakdown, advise heuristic, selection-by-pid
  reconciliation — unit-tested (TDD), like `chain.ts`.
- Grammar guard (`actionKeys` ∌ navigation keys) — unit test.
- Disclosure render (compact vs expanded selected) — `ink-testing-library`
  snapshot.
- `--snapshot` one-shot — integration test against a seeded lock chain; assert
  stdout contains the chain markdown and the process exits 0.

## Phasing hint (for writing-plans)

1. Grammar + `k`→`x` + `actionKeys` guard (small, foundational).
2. Query `state` + types + per-app breakdown transform (data layer).
3. Decision-surface render: Tier 1 compact + Tier 2 inline expand + advise + liveness.
4. Selection-by-pid + resolution moment.
5. `--snapshot` one-shot + README fix.
6. (Stretch) Tier 3 detail page; `top` disclosure alignment.
