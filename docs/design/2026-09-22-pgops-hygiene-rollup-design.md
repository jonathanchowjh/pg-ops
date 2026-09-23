# pgops — closing the gap to pgHero on the hygiene half

**Status:** P7a shipped as 2.3.1 (2026-09-22). P7b, P7c and P7d all
implemented and committed 2026-09-23, unreleased — §3 and §4 are history,
not a plan. §8 records every correction, from the pre-implementation review
and from the three phases built since; §4.12 records the second live pass,
which found the defects that only using the console could find.
Amends the full-parity design of 2026-09-03 (§2, §4.1) and the web design
of 2026-08-26 (charts, and the look of the console).

## 0. Why this document exists

A route-by-route walk of v2.3.0 against pgHero 4.0.1, with a seeded lock
chain, a store on the monitored database and `PGOPS_ALLOW_ACTIONS=true`,
found three things, and a fourth was raised in review. The first is a
defect; the next two are where a pgHero user coming to pgops loses
something they had; the fourth is that the console has no visual hierarchy
and looks like every other dashboard.

**(1) shipped in 2.3.1 and (2) is built and unreleased.** They are left
stated in the present tense below, as the case that justified the work; §6
says where each phase stands.

1. **Two pages return 500 whenever actions are on.** `/cleanup/maintenance`
   on every load, `/sessions` whenever there is at least one long-running
   query. Both pass a `describe` function from a server component into the
   client-side `ConfirmAction`, and React refuses to serialise it. Shipped in
   "feat(web): surface the four actions on the pages that own their data"
   (2026-09-18; `3c53f45` since the trailer rewrite renumbered it), present
   in v2.2.0 and v2.3.0. The component tests render pages directly and never
   cross the server-client boundary, and
   `actions.int.test.ts` boots with actions on but fetches only the API
   routes. Nothing in the suite could see it.
2. **A hygiene finding is invisible until its page is opened.** pgHero's
   overview lists duplicate, unused and invalid indexes, sequences near their
   ceiling and vacuum danger beside long-running queries. pgops's Triage and
   Overview show incident checks only. The parity design specified a cached
   hygiene class with badges on the strip (§2, §4.1); what shipped is 21
   hygiene checks that run on visit, each already carrying `timeoutMs:
   10_000`, no `check_results` table, and no badge anywhere. The design's
   §2.1 degradation is what shipped as the whole.
3. **The hygiene pages are lists where pgHero has tables and charts.**
   Queries has no load-over-time chart; the query and relation detail pages
   have axis-less sparklines; the Space page prints "not enough history"
   thirty times on a fresh store; and with the store on the monitored
   database, pgops's own nine relations fill every hygiene list. Sessions
   already folds pgops's own rows; the hygiene pages do not.

Four phases, in that order. The first is a patch release on its own.

## 1. The crash (P7a, v2.3.1)

`ConfirmAction` is a client component. A server page may hand it strings,
numbers and plain objects, never a function. An audit of every `'use client'`
component in `apps/web/components` finds `describe` to be the only
function-typed prop, so this is the whole class of the bug, not one instance
of it.

The two `describe` closures move into the component behind a string key:

```ts
// confirm-action.tsx
const OUTCOMES = {
  'kill-batch': (r) => `${terminated(r)} of ${total(r)} terminated.`,
  'analyze':    (r) => `${okCount(r)} of ${total(r)} analyzed.`,
} satisfies Record<string, (result: unknown) => string>;

describe?: keyof typeof OUTCOMES;
```

The two call sites pass `describe="kill-batch"` and `describe="analyze"`.
The prop keeps its name; its type narrows from a function to a key, so a
third call site that tries to pass a closure fails typecheck rather than
production.

**The test that would have caught it** goes in `actions.int.test.ts`, which
already boots the console with `PGOPS_ALLOW_ACTIONS=true` (its `ALLOWED`
env). One new block fetches every page that mounts `ConfirmAction` or
`KillButton` — `/sessions` with a long-running query opened on a second
client (`pg_sleep`) before the fetch, `/queries`, `/cleanup/maintenance` —
and asserts 200 and the control's label in the body. A page can only mount
a confirmation with actions on, so the actions-on run is the only run that
exercises the boundary; the test's docblock says so, because the actions-off
run passing is exactly what hid this.

No other change rides on the patch.

## 2. The hygiene roll-up (P7b)

### 2.1 What the parity design asked for, and what this changes

§2 of the parity design: the scheduler runs `class: 'hygiene'` checks and
writes each result to `pgops.check_results`; pages read the cache. §4.1: a
hygiene tab badges with the worst verdict among its area. §4.2: the overview
is unchanged. §8 cut `/doctor` because "two surfaces answering *where in this
database* is the collision this project has already made once."

The strip the design badged no longer exists. v2 shipped five gate tabs with
sub-navigation pills, so Queries and Cleanup are now mixed tabs holding
polled incident routes and on-visit hygiene routes. Badging a mixed tab
breaks §4.1's own rule that incident tabs never badge, and badging the pills
gives the console a second roll-up one row below the first.

**Amendment one: the roll-up surface is the Triage page, not the strip.**
Each hygiene area renders **one compact line** at the foot of a band,
carrying the area's worst cached verdict, the `note` of each escalating
member joined into one sentence, the age of the reading, and the link into
the area:

```
QUERIES   is the work itself taking too long?                 All queries →
┌ Long-running ─────────────────────────────────── CRITICAL ┐
│ …                                                          │
└────────────────────────────────────────────────────────────┘
  Query statistics        104 shapes · worst 26h 52m total   OK
  Indexes            2 unused indexes · 4m ago              WARN   Indexes →
  Tables             4m ago                                  OK     Tables →
```

(Drawn in today's chrome. §4 replaces the all-caps heading and the arrows;
the line's content is what this section decides.)

Pills stay unbadged. Panels on the area pages keep their own badges, as
today. §4.1's table of which checks may escalate is unchanged.

**Which band an area belongs to is declared, not derived.** The first draft
said band placement could be read from each check's gate. It cannot:
`tableStats` declares `gate: 'keep-up'` and renders on the Tables page under
`work`, and its docblock says not to "fix" that. So `AREAS` is a table in
`packages/checks/src/checks/areas.ts` — **six rows**, one per page that
renders cached checks, each naming its route segment, its band and its member
check ids — and the test holds that every `class: 'hygiene'` check appears in
exactly one area. Indexes and Tables sit under Queries; Sequences under
Replication & cleanup. **Space, Maintenance and Settings have no member that
can escalate and get no line** — §4.1 of the parity design expected
`autovacuumDanger` to alarm, and it deliberately does not (see the divergence
for #45). Whether an area gets a line is derived from the checks by
`areaEscalates`, so a threshold added later grants one with no edit here.

**Amendment two: pages stay on-visit and write through.** The parity design
had area pages read the cache with a "run now" button. That re-plumbs five
pages onto a second data path and adds a control whose only meaning is
"reload". Instead each area page keeps running its checks on visit exactly as
today and, when a store is configured, upserts what it just computed into
`check_results` on the way out. The Triage line is therefore never older
than the last tick or the last visit, whichever is later, and a page and the
line beneath it agree the moment anyone has looked. No new button. A page
render that writes to the store is new; it writes only to pgops's own
schema, so the DDL boundary and the "never write to a monitored database"
promise are untouched.

**Triage reads the cache only.** It polls at five seconds; the lines
cost one indexed read of `check_results` per render, the same class of read
the Queries page already makes for its since-last-capture column (§5.1). The
poll-boundary guard is extended to fail if the Triage page's module graph
reaches any hygiene check's `run`.

### 2.2 The run model

- **Migration 003** adds `pgops.check_results (database_id, check_id,
  captured_at, ok, level, note, message)`, primary key `(database_id,
  check_id)`. **Latest row only, upserted.** The first draft kept 14 days of
  rows; nothing reads hygiene history, and 21 checks at a five-minute cadence
  is 85,000 rows per database per fortnight for a table whose only query is
  "the newest row per check". No retention, no prune.
- **The tick runs the hygiene checks in their own transactions**, after the
  capture's transaction has committed — never inside it. `captureOnce` runs
  query stats, space and prune in one transaction so retention cannot drift
  from capture; a 10-second catalog scan does not belong in that transaction
  holding the store's write path open. Checks run sequentially per database
  with the canonical input `{}` (every hygiene page passes `{}` today, so
  the cached result is the page's result), each under its own `timeoutMs`.
  A result is written whether the check ran or failed — a failed run stores
  `ok: false` and its message, because "we could not look" is a reading the
  Triage line has to show. A timed-out check is reported and skipped, never
  allowed to hold the tick. Worst case is 21 × 10 s per database, inside the
  interval; the existing skip-not-queue rule covers the day it is not.
- **`readCheckResults(store, databaseName)`** returns the row per check for
  one database, with its age. One statement, no `DISTINCT ON` now that the
  key is unique.
- **`hygieneAreas(results, now)`** is a pure function in `packages/checks`:
  for each `AREAS` row, the worst level among members, the escalating
  members' notes joined, the oldest member's age, and `unknown` when any
  member has no row or the newest row is older than two capture intervals.
  Unit-tested without a database.
- **Degradation, per §2.1.** No store: the lines render
  `unknown · history is off · Indexes →`, and the pages have nowhere to
  write through to. Nothing else branches on deployment mode.

### 2.3 The README promise this changes

The README says the hygiene half is "never polling a catalog scan" and
"Hygiene routes will not poll when they land." The second stays true: no
route polls. The first becomes: **with a store configured, the capture tick
runs the hygiene checks every five minutes, each bounded at ten seconds, so
the console can say on the triage page what it found; without one, they run
only when you open their page.** That sentence goes in the README's History
section and the "What v2 adds" poll-boundary paragraph, because an operator
who chose pgops for that promise should read the amendment where the promise
was made.

### 2.4 What this does not do

No notification, no webhook, no exit code — parity design §9 stands. No
badge on the strip or the pills. The Overview page is unchanged (§4.2): it
still asks "is anything wrong anywhere" over incident checks only, because
a hygiene finding is never the reason a pager went off. If that decision is
revisited it is one line in `worstVerdict`, and it should be revisited with
a user asking, not for symmetry.

## 3. Charts and density (P7c)

The web design ruled: inline SVG, server-rendered, no chart library. That
stands. What changes is that the one drawing primitive grows from a
sparkline to a line chart with the two things a sparkline lacks.

- **`LineChart`** replaces `Spark`: a time axis with three **relative**
  labels (`−24h`, `−12h`, `now`) so a server-rendered chart never states a
  timezone it does not know, a value axis with min and max, one series, and
  `role="img"` with a label that states the first and last values so the
  chart is readable without sight. Still one component, still
  `preserveAspectRatio="none"`, still no measurement. `Spark` is deleted
  rather than kept beside it.
- **Queries gains a load chart, read from a table written at capture time.**
  The first draft aggregated per-shape deltas at read time. The Queries page
  polls at five seconds; 5,000 shapes × 288 captures is 1.4 million rows to
  sum on every tick of a page the README says must never be the reason a
  database is short of connections. So **migration 004** adds
  `pgops.query_load (database_id, captured_at, total_exec_time, calls)`,
  one row per capture, computed inside the capture transaction from the
  previous snapshot with the §3.5 discontinuity rule applied per shape
  before the sum — a reset on one shape leaves a gap in the total, not a
  cliff. The chart reads at most 288 rows and is drawn above the statistics
  table when the store is on, omitted entirely when it is off, the same rule
  as the since-last-capture column. Retention follows `query_stats`.
- **Query detail and relation detail** move to `LineChart`. No new data.
- **Growth reads once, not thirty times.** The Space page's growth column
  shows `—` per row and one sentence above the list: how many captures the
  store holds for this database and when the first was taken, so "not enough
  history" is said once with the number that explains it. The no-store case
  already omits the column and is unchanged.
- **pgops's own relations fold, as sessions do.** Every hygiene list that
  can contain `pgops.*` relations — Indexes, Tables, Space, Sequences — hides
  them by default, counts them in one line, and shows them with the same
  `?pgops=show` parameter Sessions uses. Readings (database size, hit rates)
  are never filtered: the fold is for lists an operator reads. The fold runs
  in the page over the rows the check returned, so no check changes. One
  consequence stated rather than hidden: a list capped at N rows by its SQL
  can show fewer than N after the fold, and the count line says how many
  were folded so the shortfall is accounted for.
- **The fold does not change a verdict, and must not.** P7b made this
  visible: a check's verdict is computed in `packages/checks` over every row
  the SQL returned, cached, and rendered on the triage line — so a store
  sharing a monitored database can put pgops's own relations into
  "2 unused indexes" on a page whose list has folded them away. The fix is
  not to filter the check: a console that hid its own cost from its own
  numbers would be doing the thing the Sessions page refuses to do, where
  pgops's connections are counted and one click away rather than dropped.
  The fold line therefore reads "N of them pgops's own" wherever the count it
  sits under includes them, which is the same sentence Sessions already
  uses, and the README's existing note about giving pgops its own store
  covers the rest.
- **Reading panels show a count.** A panel whose check yields `verdict:
  null` and a non-empty list (duplicate indexes is the case that motivated
  this) shows a neutral count chip where a verdict badge would go, so a
  finding without a threshold is not the least marked thing on its page.

**The two interfaces this phase adds**, so the work is not re-decided at
three call sites:

```ts
// components/line-chart.tsx — one series, server-rendered, no dependency.
export function LineChart({ points, label, format }: {
  points: readonly { at: Date; value: number }[];
  /** Read aloud in place of the drawing: states the span and both ends. */
  label: string;
  /** Formats the axis bounds. formatMillis, formatBytes, formatCount. */
  format: (v: number) => string;
}): ReactNode;

// store/read.ts
export async function readQueryLoad(
  store: Pool | PoolClient, databaseName: string, from: Date, to: Date,
): Promise<{ capturedAt: Date; totalExecTime: number; calls: number }[]>;
```

```sql
-- migration 004
CREATE TABLE IF NOT EXISTS pgops.query_load (
  database_id     int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL,
  total_exec_time double precision NOT NULL,  -- summed over shapes, this interval
  calls           bigint NOT NULL,
  PRIMARY KEY (database_id, captured_at)
);
```

The row is written by `captureOnce`, inside the transaction that already
holds the snapshot, from the deltas it has just computed — never recomputed
at read time. A shape whose interval spans a reset contributes nothing to
that row rather than a clamped zero, so the total has a gap exactly where the
per-shape series has one. Retention follows `query_stats`, in the same
`prune` call.

Sorting on the hygiene pages is **cut**. Every list is already ordered by
the one thing worth sorting on; adding column sorts to lists of nine rows is
work with no question behind it.

## 4. Visual hierarchy (P7d)

### 4.1 What is wrong, named

The console has five levels of structure and renders them at two weights.
The database name is 20 px semibold; a band heading is 14 px, grey, all
caps; a panel title is 16 px semibold; a row is 14 px; the tab strip is
14 px. A reader cannot tell a band from a panel from a row by weight alone,
so the page is read top to bottom instead of scanned.

Every panel is the same rounded card with the same border and radius,
healthy or not, so the card carries no information. The palette is the stock
shadcn achromatic set: lightness only, chroma zero, with hue appearing in
badges and a 4 px bar and nowhere else. And the console's own idea, the four
gates a request has to clear, is invisible as structure: it is four grey
eyebrows with a question after each.

Three of the five tells of a templated page are present: all-caps eyebrow
labels above every section, a `→` appended to every link, and content
chopped into identical cards. They are what "bland" is pointing at.

What stands, because each is a decision this project made for a reason:
the system font stack (no CDN on a locked-down network, no reflow during an
incident); the OS light or dark setting with no toggle; **colour means a
verdict and grey means no information**, and colour is never the only
signal; no chart library. The hierarchy has to come from type, surface and
structure, not from a brand accent, and that constraint is what will make
it look like nobody else's console.

### 4.2 Tokens, with the numbers they were chosen against

Every value below is oklch, matching the existing palette, and every contrast
ratio is measured rather than asserted — the script that produced them ships
as a test (§4.6), so a token edited later cannot quietly drop below the line.

**One defect found while measuring.** The `CRITICAL` badge in light mode is
**3.99:1** today: `oklch(0.577 0.245 27.325)` text on its own 10% tint. That
is below the 4.5:1 floor for small text, on the loudest signal this console
has. The badge inks below fix it, and they are the reason the palette changes
at all rather than only the layout.

**Colour.**

| Token | Light | Dark | For |
|---|---|---|---|
| `--background` | `oklch(0.985 0 0)` | `oklch(0.145 0 0)` | the canvas most content sits directly on |
| `--card` | `oklch(1 0 0)` | `oklch(0.205 0 0)` | only what still earns a card |
| `--foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | headings, values |
| `--body` *(new)* | `oklch(0.38 0 0)` | `oklch(0.87 0 0)` | sentences and table cells |
| `--muted-foreground` | `oklch(0.52 0 0)` *(was 0.556)* | `oklch(0.708 0 0)` | captions, ages, labels |
| `--critical-ink` *(new)* | `oklch(0.52 0.21 27.325)` | `oklch(0.704 0.185 22.216)` | badge and heading text at critical |
| `--warning-ink` *(new)* | `oklch(0.5 0.105 70)` | `oklch(0.82 0.15 80)` | the same at warn |
| `--success-ink` *(new)* | `oklch(0.48 0.13 150)` | `oklch(0.77 0.16 152)` | the same at ok |
| `--critical-surface` *(new)* | `oklch(0.97 0.014 27)` | `oklch(0.25 0.05 27)` | the tint under an escalated panel |
| `--warning-surface` *(new)* | `oklch(0.975 0.022 80)` | `oklch(0.24 0.04 80)` | the same at warn |

**Built, and two things changed in the building.** Both were found by running
the test of §4.7 against the stylesheet rather than against the draft.

*A badge sits on two different surfaces, and the plan measured the lighter
one.* Escalated panels are cards (`oklch(1 0 0)`); a healthy compact row and
a hygiene line sit on the canvas (`0.985`), which is darker, so the tint over
it is darker and the ratio lower. The canvas is the binding case and the
table below is measured over it. The earlier figures (5.04, 5.35, 5.35) were
the card. Both are asserted now.

*Three of the inks were marginally outside sRGB.* `oklch(0.52 0.22 27.325)`
has a green channel of −0.006. Invisible, and resolved three different ways:
the browser gamut-maps per CSS Color 4, Tailwind emits a hex fallback from
its own conversion, and the test clamps — giving 4.91, 4.91 and 4.80 for the
same token. All three passed, which is why it is worth pinning rather than
shrugging at: the next token might not have that headroom, and then the test
and the screen would disagree about whether the console is readable. The
chroma of those three is reduced until they fit, and a test asserts every
measured token does.

Measured, smallest first, over the canvas. Anything below 4.5:1 is a failure
for text at these sizes:

| Pair | Light | Dark |
|---|---:|---:|
| critical ink on its badge tint | 4.92 | 5.34 |
| critical ink on its badge tint, on a card | 5.13 | 4.66 |
| critical ink on the panel surface | 5.61 | 5.68 |
| warning ink on its badge tint | 5.11 | 7.60 |
| success ink on its badge tint | 5.10 | 7.11 |
| caption on the canvas | 5.28 | 7.63 |
| body text on the canvas | 9.59 | 13.36 |
| body text on the critical surface | 9.14 | 10.97 |

`--muted-foreground` moves from `0.556` to `0.52` for one reason: on the new
canvas it measures **4.53:1**, which passes by 0.03 and would fail the moment
anyone nudged the background. At `0.52` it is 5.28:1.

The tints are deliberately faint — 1.05:1 against the canvas in light, 1.22:1
in dark. They are a ground, not a highlight: the accent bar and the badge
carry the signal, and the tint only joins the panel's parts into one block.

**Type.** System stack, one family, no webfont — the existing reasoning
stands. Five sizes, and nothing between them:

| Role | Size / line-height | Weight | Notes |
|---|---|---|---|
| Database name | 28px / 1.15 | 600 | tracking `-0.02em`; the largest thing on the page, because acting on the wrong database is the expensive mistake |
| Gate heading | 20px / 1.3 | 500 | sentence case; its question follows at 16px in `--muted-foreground` |
| Panel title | 16px / 1.4 | 500 | |
| Body and table cells | 14px / 1.45 | 400 | `--body`; `tabular-nums` on every numeric column |
| Caption | 12px / 1.4 | 400 | `--muted-foreground`: ages, units, counts |

Monospace stays for SQL and identifiers and appears nowhere else. No
uppercase outside the badge, where the word IS the label.

**Space and layout.** A 4px base step (4, 8, 12, 16, 24, 32). Content width
84rem, down from 100rem. One header row: name and status line left,
freshness and Refresh right, tab strip beneath, and the per-page
`live · Refresh` row goes.

### 4.3 The gate spine, drawn

The one bold element, used once, on triage only. A two-column grid: a fixed
14rem column carrying the gate's number, name and question, and a hairline
rule joining the four cells down the page. Numbered because the gates are an
ordered sequence — a request clears them in that order — which is the one
case the numbering convention is honest.

```
   ┌── 14rem ──┐
   │           │
 1 │ Sessions  │  ▌Sessions by state                      CRITICAL
   │           │   idle · 6 · 2s      ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
   │ is there  │   active · 6 · 1h41m ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
   │ room for  │   idle in txn · 1    ▁▁▁▁▁
   │ the next  │   Why this matters — five minutes of idle-in-
   │ request?  │   transaction blocks autovacuum…
   │           │
   │           │   Connections        13 used · 84 free of 100    OK
   ├───────────┤   ─────────────────────────────────────────────────
 2 │ Locks     │  ▌Lock wait graph                        CRITICAL
   │           │   18389 postgres@batch-worker · blocking 2 · 1h41m
   │ is any-   │   UPDATE users SET n = n + 1 WHERE id = 1
   │ thing     │
   │ waiting   │   Blocked   2 waiting · longest 1h 41m       CRITICAL
   │ instead   │   ─────────────────────────────────────────────────
   │ of        │   Indexes   2 unused indexes · 4m ago            WARN
   │ working?  │   Tables    4m ago                                OK
   └───────────┘
```

Below `lg` the spine collapses: the gate cell becomes a heading above its
panels, and the rule disappears. Nothing reflows sideways, and no horizontal
scroll appears at any width.

The escalated panel keeps its left accent bar (`▌`) and gains the tint. The
healthy ones are rows on the canvas with a hairline beneath — no box. The
hygiene lines sit last in the band, as they already do.

### 4.4 What a box means, and the small copy decisions

**A card means look here.** Only a panel whose check is `warn`, `critical` or
unavailable gets a bordered card, its tinted surface and its accent bar. A
healthy compact panel is a row on the canvas with a hairline beneath it:
title, reading, badge. A verdict-less reading panel on a hygiene page is a
titled section with a hairline under the title. The box stops being furniture
and becomes the signal the accent bar was carrying alone.

**The hygiene lines follow that rule too.** P7b shipped them inside the
compact panel's box, which was the right weight beside the panels of the day.
Here they become rows with a hairline, the age in caption size, the badge at
the right, and a tinted surface when they escalate. They stay last in their
band, and the spine's rule runs past them: they belong to the gate.

**Links are words.** A band's link is the area's name at the heading's right
edge, underlined on hover. The `→` goes — from there, from the hygiene lines
and from every other link in the console.

**Copy.** `2 session(s) blocked` becomes `2 sessions blocked`, through one
pluralising helper beside `formatCount`. `1 unused index` already reads
correctly and stays. Nothing else about the wording changes: it already names
what happened and what to do.

**Motion.** None added. Focus rings stay exactly as they are, and
`prefers-reduced-motion` has nothing new to respect.

### 4.5 The hygiene pages become tables

Every key–value flex list becomes a real `<table>`: a header row naming the
columns, the label first, numbers right-aligned and tabular, hairline row
rules, no outer box. That is pgHero's density, and it is what makes a column
of percentages comparable by eye instead of by reading.

```
Index usage by table

RELATION                     INDEX SCANS        ROWS
public.order_items                    0%     600,000
public.orders                       100%     200,000
public.audit_log                      0%      66,667
────────────────────────────────────────────────────
9 relations · 6 of them pgops's own, hidden — show
```

An index's `CREATE INDEX` statement folds into a `<details>` under its name,
so "All indexes" is a scannable list of names and sizes rather than a wall of
SQL. Sorting stays cut: every list is already ordered by the one thing worth
ranking on.

### 4.6 The overview gains a quiet hygiene column

Decided 2026-09-23, replacing §2.4's "the overview is unchanged" and closing
§7. pgHero puts hygiene on its dashboard; pgops now does too, but not in the
same ink.

The incident verdict keeps the badge and the accent bar — that is the
question the page asks, and a hygiene finding must never colour a row on the
screen an operator opens while being paged. Hygiene appears as muted text in
its own column: `2 unused indexes · 4m ago`, at caption weight, with no
badge, no bar and no colour. A database with a hygiene finding and no
incident still reads OK, because it is OK: nothing is wrong right now.

It costs one indexed store read per database per 30-second poll, beside the
twelve live checks that page already runs. `hygieneFor` already returns
exactly what the column needs, so the work is the column, not the data.

### 4.7 A test, not a promise

The contrast table above is only worth as much as its next edit. So
`apps/web/test/tokens.test.ts` reads `globals.css`, parses every
`oklch(L C H)` token out of both themes, converts to sRGB, and asserts each
pair in the table clears 4.5:1 — the same arithmetic used to produce the
numbers, run against the file that actually ships. A token nudged later
fails by name, in the fast suite, with the ratio it produced.

Two things it deliberately does NOT check, because they are judgement and
not arithmetic: whether the tint is *visible* (1.06:1 is intentionally
barely), and whether a hue is right. Those are what the screenshots are for.

### 4.8 Two pieces of documentation debt this phase clears

Both were found on 2026-09-23, after the README was rewritten and P7b landed.

**The triage screenshot and its alt text are out of date.** The alt text
describes four bands of panels and says nothing about hygiene lines, which
now render in three of them. The picture predates them entirely. Reshooting
is already a P7d task; the alt text is rewritten with it, and it is the alt
text — not the picture — that carries this page to a reader who cannot see
it.

**Eight screenshots are orphaned.** The rewritten README references
`triage-*` and `kill-confirm-*` only; `overview-*`, `sessions-*`, `locks-*`
and `queries-*` are still in `docs/screenshots/` and referenced by nothing.
P7d decides one way or the other — re-reference them where the new README
earns them, or delete them — because a directory of images no document
points at is a set of pictures that will quietly stop being true. The
decision belongs with the reshoot rather than before it.

> **Decided 2026-09-23: `queries-*` re-shot and referenced; the other six
> deleted.** The Queries pair earns its place because the page gained
> something a sentence cannot show — the load chart, with its spike and the
> gap where two captures are missing. `overview-*`, `sessions-*` and
> `locks-*` were each a picture of a page the route table already describes
> in one line, and three more full-page images between the opening paragraph
> and the parity claim is noise on the document that has to make the case in
> its first screen. Deleted rather than kept unreferenced, per the rule
> above.

### 4.9 Reviewed against the generic default

A dashboard drawn without this brief comes out as cards, eyebrows and one
brand accent. This plan removes cards as the default, removes eyebrows, and
adds no brand accent, because colour-means-verdict is the project's rule and
is itself the distinctive choice. Its one bold move is the spine, which only
this product can draw because only this product has the model. The risk is
the tinted surfaces: a red wash on a page is loud. It is bounded by the
existing accent rule, which already withholds emphasis from `ok`, so a
healthy database has no tint anywhere and an unhealthy one has exactly as
much as it has problems.

### 4.10 Risks, and what would change our mind

Three things here could be wrong, and each has a cheap way to find out.

**The spine could read as decoration.** It earns its place only if the four
gates are genuinely a sequence to a reader who does not already know the
model. The test is the 768px screenshot: if the collapsed form — headings
above their panels, no rule — reads just as well, the spine is costing a
14rem column for nothing, and the honest move is to drop it and keep the
headings. Decide from the screenshots, before the reshoot, not after.

> **Decided 2026-09-23: kept.** Both widths were shot against a live database
> with a staged lock chain. The collapsed form at 768 does read well — the
> numbered headings carry the sequence on their own, which is the outcome
> that would have condemned the rail. What the rail adds at 1440 is not the
> numbering: it is a left edge to scan, and somewhere for the gate's question
> to live that is not beside the panels. The old layout put an uppercase
> heading and its question on one line above the panels, competing with them;
> the cell stacks name, question and link and gets out of the way. The rule
> then binds each band into one object, which is what makes four bands read
> as four steps rather than four lists. Kept, and the collapse below `lg` is
> what keeps the cost off the phone.

**The tints could be too faint to do their job, or too loud.** At 1.05:1 in
light they are close to invisible on a poor monitor, which is deliberate: the
badge and the bar carry the signal. If a critical panel does not read as
separate from the canvas at arm's length, raise the tint rather than the ink
— the ink is already pinned by the contrast test.

> **Decided 2026-09-23: unchanged.** Measured on screen in both themes. A
> critical panel reads as one block at arm's length in light and in dark, and
> a page with two escalations and seven healthy rows is unambiguous about
> which two to read. The dark tint is the more visible of the pair (1.22:1)
> and is still nowhere near a wash.

**Tables could be worse on a phone.** Six columns of index statistics at
768px is a horizontal scroll, which this plan forbids. The fallback is the
one the brief already implies: below the breakpoint a table becomes the row
list it is today, with the numbers still right-aligned. That is a layout
choice inside `<table>` markup, so the accessibility gain survives it.

> **Decided 2026-09-23: no fallback needed, and the widest table was cut
> instead.** `ui/table.tsx` already wraps every table in an
> `overflow-x-auto` container, so a wide table scrolls itself rather than the
> page — the plan's actual prohibition, no horizontal scroll on the PAGE, was
> never at risk. The one table that would have needed it was Maintenance,
> drafted at seven columns; manual and automatic vacuum are now one labelled
> cell each, which is five columns and is also the better answer to the
> question that panel is opened with ("when was this last touched").

What would NOT change: colour means a verdict and grey means no information,
system fonts, no chart library, and no brand accent. Those are the project's,
not this phase's.

### 4.11 What this changes for the tests

The web tests assert on text, roles and `aria-*`, not on class names: no
test matches `uppercase`, `border-l-4` or an arrow glyph in the UI (the two
files that contain `→` match it inside SQL text). Band titles are unchanged,
so the tests that hold band-to-tab agreement keep passing. What changes:
`check-panel.test.tsx` gains the rule that a healthy compact panel renders no
bordered container and an escalated one does, and `nav.test.tsx` loses
nothing. Every route is screenshotted in both themes before the phase
closes, and the README's screenshots are reshot then, not in P7c.

> **What the live pass actually changed, 2026-09-23.** Running it found four
> things no test could:
>
> - **Healthy rows drew their hairline forty pixels below their words.** The
>   spine's grid row is as tall as the taller of its two cells, and the
>   panels stretched to fill it — so a one-line row rendered as an empty box.
>   `content-start` on the inner grid.
> - **The fourth gate had no link.** `LINKS` covered three of four, which was
>   invisible while the bands were headings and obvious the moment each got a
>   cell with a slot for one.
> - **`2 session(s) blocked` survived in `packages/checks`.** The pluralising
>   helper is in `apps/web`, so the two notes written by the checks
>   themselves were missed. Inlined there rather than exported across the
>   boundary, which is what `indexes.ts` already does.
> - **A compact panel said the same thing twice.** "Blocked · 2 waiting ·
>   longest 4m 31s · CRITICAL · 2 sessions blocked" — the row's own summary
>   and the verdict's note, wrapping over three lines to say one thing. A
>   compact panel now drops the note; the full panel keeps it, where the
>   reading beside it is a list rather than a summary.
>
> And one deviation from §4.2 that the guards forced: **the per-page
> `live · Refresh` row stays where it is.** The plan wanted it in the header,
> but the header lives in the layout, the layout is shared with the hygiene
> routes, and `guards.test.ts` holds that those routes must never inherit a
> five-second catalog scan. The guard is worth more than the row.

### 4.12 The second live pass, and what using it found

§4.11 closes by requiring every route in both themes before the phase does.
That pass ran on 2026-09-23 across the seven routes the first one missed —
locks, cleanup, query detail, space detail, explain, index bloat, suggested
indexes — and the operator drove the running console rather than only
looking at it. Both halves mattered: the worst defect on the list was not
visible in a screenshot at all.

**The page would not scroll, and the cause was one CSS rule nobody wrote.**
`<Sql>` set `overflow-x-auto` on every rendered statement. The overflow spec
computes the *other* axis from `visible` to `auto` when one axis is not
visible, so each statement was a two-axis scroll container — and the Queries
page laid a hundred of them across itself, each 16px tall over a line up to
23,000px wide, covering roughly a quarter of the viewport. A trackpad
gesture beginning over any one of them was captured by it. The sessions page
had already diagnosed this in a comment — "a table of twenty
independently-scrolling cells, when the table itself already scrolls as one
piece" — and then kept the per-cell scroll. Statements clamp to two lines
now; `ui/table` remains the one horizontal scroller.

Two more from the same report: **the header scrolled away**, taking with it
the name this document calls the only thing standing between an operator
with three tabs open and acting on the wrong database — on `/queries`, which
is 4,400px tall, and `/sessions`, which carries a Terminate button in every
row. It sticks. And **nothing marked the end of a page**: at `pb-6` the last
row sat 24px from the window edge, so a page that had finished scrolling
looked like one that had stopped.

One thing the pass *cleared*: the five-second poll was suspected of stealing
scroll position and does not. `router.refresh()` preserves it, as Next 16's
own documentation states, and sixteen seconds of polling reset it zero
times; the single reset observed was Next's scroll restoration firing
because the test scrolled within a second of load.

**The charts were the wrong shape, and two of them were lying.** At `h-16`
across the full shell they were 20:1 ribbons encoding their whole range in
about sixty pixels of travel, so every series looked like the same gentle
ripple. Capped at 48rem, given real height, and ruled with four labelled
gridlines. Three rules came out of looking at real data, each now tested and
mutation-checked:

- **Fewer than two points is not a chart.** One capture drew an empty frame:
  no line, the same number on both value labels, and `−0s · −0s · now`.
- **The axis will not scale below 2% of the reading.** A 102 MB table that
  had grown 8 KB drew a line climbing the full plot under four labels all
  reading "102 MB", while the `Change` fact beside it said "+8 KB".
  Autoscaling to min..max is what makes a flat series look dramatic.
- **A flat series gets its own branch.** The floor above turned an all-zero
  series into `0 · −0.333 · −0.667 · −1` — negative call counts. Flat is a
  fact: one gridline, one label, one line.

**Five defects on the routes themselves.** `/queries/<queryid>` identified
its subject as a 19-digit integer and showed the statement nowhere, so an
operator could not confirm they had clicked the row they meant;
`readQueryText` fetches it in one indexed lookup rather than widening a
series whose docblock correctly says the caller already knows the *id*. Raw
timestamps to the microsecond survived in three more places the Tables pass
missed, and `formatAgo` now serves all four callers. The Cleanup overview
still held the key-value lists §4.5 converted everywhere else. And the
Explain page wore a box around its entire self, written before §4.4 made a
border mean "an escalated verdict is in here".

**The 768px half of task 10 found the worst defect of the pass, and it was
never a narrow-viewport bug.** `ui/table` wraps its table in `relative w-full
overflow-x-auto`, and that wrapper sat inside an unstyled grid item. A grid
item defaults to `min-width: auto`, which refuses to shrink below its
content's min-content size — so a table of `whitespace-nowrap` cells made the
item 963px inside a 720px track, the wrapper took that width through `w-full`
and had nothing left to scroll, and `overflow-x-auto` on a box already as
wide as its content is a no-op. The overflow escaped the panel, the section
and `main` and landed on the document: at 768 the Sessions page was 965px
wide and Queries 1101px, the whole page scrolling sideways and taking the
newly sticky header with it. The scroller had never engaged at any width.
`min-w-0` on the item is the entire fix, and the sessions page's own comment
— "the table itself already scrolls as one piece" — was describing something
that was not true when it was written. All thirteen routes now hold 768 in
both themes.

**Two charts were then added from data already captured**, which is the
opposite of scope creep: `query_load.calls` has been written since migration
004 and read into `StoredLoad` all along, and `Interval.rows` has been
differenced since P4 — both were being thrown away on every render.
Execution time alone rises both when the database gets slower and when more
traffic arrives, and those have opposite fixes; the pair is unambiguous. The
seeded demo showed it immediately: the spike at −11h58m is in execution time
and absent from calls.

## 5. Testing

- P7a: the actions-on page block in `actions.int.test.ts` (§1). Typecheck is
  the guard against the same mistake at a third call site.
- P7b, as built: 15 unit tests over `AREAS` and `hygieneAreas`; three over
  `checkResultRow`, where the failure branch lives because provoking a real
  privilege error mid-pass is awkward; five integration tests over the cache's
  upsert semantics; six over `captureHygiene`; and one console-level
  integration test that waits for the boot capture, asserts the three lines
  and an age, then visits an area page and asserts the cache advances. The
  guard reads the triage page's source for any `CHECKS.<hygieneId>` rather
  than a module graph — the page reaches data through exactly two seams, so a
  hygiene check could only arrive by being named there. It was proved to fail
  by adding one.
- P7c: `LineChart` renders NaN-free for a flat series and a single point;
  a `query_load` integration test captures three times with a reset between
  the second and third and asserts a gap, not a cliff; the fold tests mirror
  `sessions-fold.test.tsx`, whose parameter is `?pgops=show`.
- P7d: `tokens.test.ts` (§4.7) is written first and fails on today's badge;
  `check-panel.test.tsx` gains the rule that a healthy compact panel renders
  no bordered container and an escalated one does; the table pages assert
  `<th>` and `scope`, which is the accessibility half of "tables are
  tables". The guard that colour is never the only signal is the existing
  one: every badge spells its level, and it does not change. Re-checked on
  2026-09-23 — no test in `apps/web/test` matches a class name or a `→`,
  including those P7b added, so the restyle has no test to rewrite.
  Verification beyond the suite is the screenshots: every route, both
  themes, at 1440 and 768, looked at rather than merely captured.

## 6. Phases

| Phase | Version | Ships | Gate to next |
|---|---|---|---|
| P7a | 2.3.1 | §1 | **done** — actions-on page block green on PG 17 and 14 |
| P7b | 2.4.0 | §2 | **done** — three hygiene lines with an age; both guards hold |
| P7c | 2.4.0 | §3 | README's Queries and Space sections updated |
| P7d | 2.4.0 | §4 | every route screenshotted light and dark; docs/screenshots reshot |

**The matrix is no longer a gate CI enforces.** `.github/workflows/ci.yml` is
gone: the `static` job is `.githooks/pre-commit` and the `integration` and
`image` jobs are `.githooks/pre-push`, which runs ONE Postgres version by
default. The four-version run is
`PGOPS_HOOK_PG_VERSIONS='14 16 17 18' git push`, and it is a thing a person
now has to choose. Each phase below is gated on that command, not on a green
tick arriving by itself.

**There is no separate implementation-plan document, deliberately.** This
repo cut its plan and review files when the design documents moved to
`docs/design/`; the task lists below are the plan, and they live beside the
reasoning that produced them.

P7b, P7c and P7d share a minor version. They do NOT share a migration: 003
shipped with P7b and is in a store the moment anyone runs this branch, so
P7c's `query_load` is 004. Forward-only means forward.
P7d comes last because it restyles the lines, charts and tables the two
phases before it add, and a reshoot is done once. P7a goes out alone: an
operator with actions on cannot open the Sessions page during a lock
pile-up, and that is the page the README says the console exists for.

### P7a tasks

1. `confirm-action.tsx`: `OUTCOMES` map, `describe` becomes a key.
2. `sessions/page.tsx`, `maintenance/page.tsx`: pass the key.
3. `actions.int.test.ts`: page block, three pages, one long-running query
   opened on a second client before the fetch.
4. CHANGELOG 2.3.1, tag.

### P7b tasks

1. `store/migrations/003-check-results.ts` (both tables, §2.2 and §3);
   `write.ts` upsert; `read.ts` `readCheckResults`.
2. `capture.ts`: hygiene pass after commit, own transactions, per-check
   timeout, skip-and-report.
3. `checks/areas.ts`: `AREAS` data and `hygieneAreas()`; tests.
4. Triage page: `HygieneLine` per area at the foot of its band; guard
   extension; integration test.
5. Area pages: write-through after their checks run; no-store path
   unchanged.
6. README §2.3 amendment; CHANGELOG.

### P7c tasks

1. `store/migrations/004-query-load.ts`; `write.ts` insert; `prune` covers it;
   `read.ts` `readQueryLoad`.
2. `capture.ts`: write the row from the deltas it already computes, inside
   the existing transaction, with the discontinuity rule applied per shape
   before the sum.
3. `components/line-chart.tsx` (§3); delete `spark.tsx`; migrate query detail
   and relation detail.
4. Queries page: the 24-hour load chart above the table, omitted with no
   store, the same rule as the since-last-capture column.
5. Space page: the growth column reads `—` per row, with one sentence above
   the list giving the capture count and the first capture's time.
6. `lib/fold.ts`, shared by Sessions and the four hygiene lists; the count
   line says how many are pgops's own; the check and therefore the cached
   verdict are untouched (§3).
7. `CheckPanel`: neutral count chip for a verdict-less panel with a non-empty
   list.
8. README's Queries and Space sections; CHANGELOG.

### P7d tasks

1. `globals.css`: the tokens of §4.2 — canvas, `--body`, the darker
   `--muted-foreground`, the three inks, the two surfaces — plus the type
   scale and a `tabular-nums` utility.
2. `apps/web/test/tokens.test.ts` (§4.7): parse the tokens out of
   `globals.css`, convert oklch to sRGB, assert every pair in §4.2 clears
   4.5:1. Written FIRST: it fails against today's `CRITICAL` badge at 3.99,
   which is the defect this phase fixes.
3. `verdict-badge.tsx` and `ui/badge.tsx`: badges use the inks.
4. `db/[name]/layout.tsx`: one header row with the freshness cluster;
   84rem content width; remove the per-page `live · Refresh` row.
5. `CheckPanel`: card only when escalated or unavailable; tinted surface;
   healthy compact panel becomes a row (§4.4).
6. Triage: the gate spine (§4.3), sentence-case headings, links without
   arrows; `HygieneLine` follows the panel rule.
7. The four hygiene lists become tables; `details` for index definitions
   (§4.5).
8. Overview: the quiet hygiene column (§4.6), reading `hygieneFor` per
   database.
9. `formatCount`'s neighbour: one pluralising helper; `2 sessions blocked`.
10. Screenshot every route in both themes at 1440 and 768; reshoot
    `docs/screenshots`, including the first hygiene screenshots; rewrite the
    triage alt text to describe the lines and the spine; settle the eight
    orphaned screenshots (§4.8); README; CHANGELOG 2.4.0, version bump, tag.

## 7. Resolved: the overview carries hygiene

Asked of the reviewer on 2026-09-23 and answered the same day: **yes, as a
separate quiet column.** §4.6 is the decision; §2.4's "the overview is
unchanged" is superseded by it. The reasoning that survives is the part that
shaped the answer — a hygiene finding must not colour a row on the page an
operator opens while being paged — so it appears without a badge, without a
bar and without colour, and the row's verdict still comes from the incident
checks alone.

## 8. What the review changed

Checked against the code on 2026-09-22 before implementation:

| First draft said | Found | Now |
|---|---|---|
| Add `timeoutMs` to each hygiene check | All 21 already declare `timeoutMs: 10_000` | Task removed |
| Band placement read from each check's gate, with a test | `tableStats` is `keep-up` on a `work` page, by design | `AREAS` declares its gate; test is coverage, not agreement |
| Area pages read the cache with a run-now button | Five pages re-plumbed for a button that means "reload" | Pages stay on-visit and write through |
| `check_results` keeps 14 days, pruned | Nothing reads hygiene history | Latest row per check, upserted |
| Hygiene half inside `captureOnce`'s transaction | That transaction also holds prune; a 10 s scan would hold the write path | Own transactions, after commit |
| `readQueryLoad` sums per-shape deltas at read time | The Queries page polls at 5 s; 1.4M rows per poll at the documented store size | `query_load` written per capture, ≤288 rows read |
| New integration block in `routes.int.test.ts` | `actions.int.test.ts` already boots with actions on | Block goes there |
| Four hygiene lines, including Maintenance | `autovacuumDanger` has no verdict by design (#45 ships as a list, not an alarm), so Maintenance can never escalate | **Three lines**: Indexes, Tables, Sequences. `escalates` is derived, so a threshold added later grants a line with no edit |
| `hygieneAreas` filters on an `escalates` FIELD | Reading `CHECKS` while `areas.ts` evaluates is an import cycle — every id came back `undefined` and the package failed to load | `areaEscalates(area)`, evaluated at call time |
| Area pages write through "on the way out" | Nothing said where; awaiting it is one upsert after scans that already took seconds | Awaited, after the page's own `Promise.all`, via `cacheChecks` |
| Time axis with clock labels | Server-rendered, timezone unknown | Relative labels |
| `query_load` rides on migration 003 | 003 shipped with P7b; a store already holds it | `query_load` is migration **004** |
| Phases gated on the CI matrix | `ci.yml` is gone — pre-commit and pre-push hooks replaced it, one PG version by default | Gated on `PGOPS_HOOK_PG_VERSIONS='14 16 17 18' git push`, which a person chooses |
| P7d restyles panels, tables and charts | P7b added a surface after this section was written | The hygiene lines are in its scope too (§4.2) |
| Reshoot is a mechanical step | The README rewrite orphaned eight screenshots, and the triage alt text predates the lines | Both are P7d decisions, named in §4.3 |
