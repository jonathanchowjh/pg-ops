# Deep review — deferred follow-ups (2026-06-26)

A three-lens adversarial deep review of the in-tool UX work. **Tier 1 findings were
fixed** in commit `0370262` (`fix: address deep-review findings (Tier 1)`). The
items below are real but were deferred because they need a design decision or
touch the safety-critical kill path. Tracked here so they aren't lost.

## H. PID-reuse session-identity guard on kill (safety)

**Problem.** The kill target (`pending`) is captured at `x`-press and may sit
through an arbitrary human delay before `y`. Postgres backend PIDs are reused by
the OS. If the original blocker disconnects and that PID is reassigned to an
innocent new backend before the operator confirms, `pg_terminate_backend(pid)`
kills the wrong *session* — and returns `true`, so the confirm modal can't catch
it (the displayed pid is technically the one killed; it's a different session on
that pid). The audit entry then records inaccurate metadata.

**Fix (proposed).** Capture a stable session identity at selection
(`pg_stat_activity.backend_start`, available per-backend) and re-check it at kill:
`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2`.
If no row matches, refuse and report "session changed — not killing." This also
subsumes the (already-fixed) arm-the-wrong-row race. Requires threading
`backend_start` through query → chain → kill. Narrow real-world window, but it's
the one genuine wrong-kill path.

## I. Pure deadlock-cycle visibility

**Problem.** `buildChains` defines a root as a pid that blocks others but is never
itself blocked. In a pure cycle (A↔B with no external blocker), every pid is
blocked, so `rootPids` is empty and the view renders "No lock contention" — a
blind spot exactly when a deadlock is forming. (Cycles that *have* an external
root already render with the cycle flag; only the rootless pure cycle is invisible.)

**Mitigating factor.** Postgres's deadlock detector aborts one side within
`deadlock_timeout` (default 1s), so a true pure cycle is short-lived. Low priority.

**Fix (proposed).** After collecting `rootPids`, detect any blocked pids with no
root ancestor (an all-cycle subgraph) and emit one representative node per cycle
with `cycle: true` set on the root, so the operator sees it before PG resolves it.

## Minor / latent (no user-visible effect today)

- **In-flight poll not cancelled on unmount** (`index.tsx`). A `poll()` awaiting
  `fetchLockEdges()` when the user quits will call setters on an unmounted tree.
  React 18 silently no-ops these and the try/catch contains the rejected query, so
  there's no crash today — but it's not future-proof (StrictMode / stricter React).
  Fix: an `isMounted` ref or `AbortController` cleared in the poll effect's cleanup.
- **Refs written during render** (`selectedPidRef`/`setIndexRef`/`indexRef`). Safe
  today (Ink has no StrictMode, synchronous reconciler), but officially discouraged.
  Move to `useLayoutEffect` if concurrent features ever land.
- **Liveness ticker forces a full-tree re-render every 1s** — wasteful but harmless
  at this scale; could memoize the freshness string or scope the re-render.
