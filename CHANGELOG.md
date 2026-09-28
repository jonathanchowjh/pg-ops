# Changelog

All notable changes to pgops are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **No annotated tag could be pushed, so the documented way to cut a release
  was impossible.** For `refs/tags/*` git feeds the pre-push hook the TAG
  OBJECT's sha, while `scripts/gate.sh` records `git rev-parse HEAD`, a
  commit. The hook compared the two literally, so the match could never
  succeed and `git push origin v2.5.0` was refused for a commit that had just
  passed all four Postgres legs and the image smoke test. Step 4 of
  CONTRIBUTING's release procedure is "Tag vX.Y.Z", which made the release
  procedure reachable only through the `--no-verify` this hook exists to make
  unnecessary — the same failure mode that produced the hook in the first
  place, arriving by a different route. The hook now dereferences a ref to its
  commit before consulting the receipt, which is a no-op on a commit and on a
  lightweight tag.
- **A tag for a release older than the receipt file could not be pushed
  either.** v2.3.1 and v2.4.0 were tagged locally and never reached the
  remote, and their commits predate the receipt mechanism entirely, so no
  receipt will ever name them. The hook now also accepts a ref that introduces
  no commit the remote does not already have: the push sends no code, only a
  tag object pointing into published history. This is the same reasoning the
  hook already applied to a branch deletion, and it weakens nothing, because an
  unpushed commit still counts — commit after gating and the hook still refuses.

### Changed

- **The tab strip is data, in `apps/web/lib/tabs.ts`, not a local `const`
  inside the component that renders it.** Each tab now declares two things the
  compiler will not let a new one omit: `mode`, whether its page is live or
  durable, and `gate`, which gate it goes deeper into or `null` for an object
  page. Same reasoning as `gates.ts`, and the same sentence applies — a model
  that is only written down drifts from the thing it describes, and the drift
  is silent. `nav.test.tsx` carried a second copy of the gate-to-tab mapping
  precisely because the model lived where no test could import it.

  **The strip is deliberately NOT yet split into Now and Explore bands**, and
  `tabs.ts` records why at length. Grouping today's six tabs on liveness gives
  five in Now and one in Explore: Queries and Cleanup both poll, so both are
  live, while everything underneath them — indexes, bloat, suggested indexes,
  space, maintenance, sequences — runs on visit. A band labelled Explore
  holding one tab, beside a band labelled Now whose largest tab is a doorway to
  hygiene, is a label contradicting its contents, which is the defect the
  triage bands already had once when they were named `Saturation` /
  `Lock chains` / `Slow queries` / `Replication`. The prerequisite is moving
  those hygiene children onto entity tabs of their own, a route restructure
  with its own redirects and its own decision about the three pages v2.5.0
  deliberately did not fold into `/tables`. `mode` is true today and the bands
  can be rendered from it the day the routes sit either side of the line.

### Tests

- **The tab strip's model is held against the pages it describes.** A declared
  `mode` that nothing checks is prose in a type's clothing: it reads as true
  under any mutation. `tabs.test.ts` reads each tab's page off disk and asks
  whether it renders `<Refresh>`, which is the same observable fact
  `guards.test.ts`'s poll boundary ranges over from the page side — that file
  asserts which pages poll, this one asserts the strip agrees. Both directions
  are silent on their own: a live tab declared `explore` is a page that stops
  updating mid-incident with nothing saying so, and a hygiene tab declared
  `now` puts a catalog scan on a five-second timer. It also pins every gate to
  exactly one tab against `GATE_ORDER` rather than against the strip's own
  entries, which would pass under any mutation of those entries, and pins the
  count of `explore` tabs at one so the argument above has to be re-made rather
  than quietly expiring. Confirmed red by mislabelling Tables as live and by
  removing the Locks tab's gate.
- **One version, in four places, held by nothing until now.** Step 1 of the
  release procedure bumps three manifests "together" and the README's
  `**Status:** vX.Y.Z` line is a fourth copy — the one a release forgets,
  because no build reads it. Three of four is silent: the image reports one
  version, the package another, the README a third, and the first to notice is
  whoever is working out which build they are running mid-incident. Confirmed
  red for a stale manifest and for a stale README separately.
- **The pre-push hook is now RUN, not only read.** Every existing assertion
  about it greps its source, which suits "the slow steps are not in here" and
  cannot answer "does a push of this ref succeed". The tag bug passed every one
  of those greps. Four tests drive the hook as a subprocess against a throwaway
  repository holding one published commit, one the receipt names and one that is
  neither: the two acceptances above, the refusal that is the hook's whole
  purpose, and a branch deletion. Both acceptance tests were confirmed red
  against the previous hook, and both refusal tests green, so the change is
  demonstrably targeted.

## [2.5.0] — 2026-09-28

The Tables area: one list of every table, and a page about one of them.

**Minor, not major.** Two routes are added under a new tab and nothing
changes meaning or goes away — `/queries/tables`, `/cleanup/space` and
`/cleanup/maintenance` all stay exactly where they were.

### Added

- **Tables**, a fifth tab at `/db/<name>/tables` — every table in one list,
  sorted, searched and capped in SQL rather than in the page: size, rows,
  dead rows, cache hit and last vacuum. The sort happens before the cap, so
  the ranking is the database's and not the ranking of whichever population
  the first cap admitted. Presets for Biggest, Needs vacuum, Worst cache hit
  and Unused are each one URL onto that list, so the one-click answer three
  separate `ORDER BY` pages used to give survives with a single code path
  drawing the rows.
- **A page about one relation** at `/db/<name>/tables/<relation>` — 30 days
  of its size, its indexes and the unused, duplicate and invalid ones among
  them, its sequences, and its transaction ID age. Eight pages rendered a
  relation name and none of them was about that relation; this is the one
  that is. Its 404 fires only when a check *succeeded* and found nothing:
  `ok: false` is "we could not look", and answering that with "no such
  table" sends an operator to correct a name that was right.
- **Five checks can be asked about one relation.** `indexList`,
  `unusedIndexes`, `duplicateIndexes`, `invalidIndexes` and `sequences` take
  a `relation` option, bound as a nullable parameter in the `WHERE` ahead of
  the `LIMIT` — the construction `sessions.pid` already used. A filter
  applied to an already-capped page cannot find what the server never sent,
  and on an entity page that renders every fact as an em dash: this
  console's display for "we could not look", shown for "we did not ask".
  `sequences` filters on the *owned* table, because `orders_id_seq` is a
  fact about `orders`.
- `EntityLink` and `SortLink` — one way to link a relation and one way to
  sort a column, with the URL-encoding contract stated in both directions.
  A relation name is an arbitrary identifier: a slash routes somewhere else
  entirely, and a percent is mangled by a second decode.
- `npm run gate` — the integration matrix and the image smoke test, which
  used to run inside the pre-push hook. See below.

### Changed

- `lib/sort.ts` is `lib/url.ts`, and `foldFrom` is one call to `withParam`
  rather than a second copy of its loop. The file never held anything about
  sorting, and the fold, the sort and the search all make the same promise:
  changing one control carries the other two along.
- **Dependencies.** `pg` 8.21 to 8.23 — the one runtime dependency
  `packages/checks` is allowed — Next 16.3.3 to 16.3.6, React and React DOM
  19.2 to 19.3, and the remaining minors. TypeScript 7.0 and `@types/node` 26
  are available and deliberately untaken: a compiler major wants a change of
  its own, where a new diagnostic reads as the point rather than as collateral.
- **Two documentation lines stopped recommending `--no-verify`.** README and
  CONTRIBUTING each closed the hook explanation by noting that the flag skips
  either hook — one sentence after saying the pre-push hook is instant and the
  gate is the slow part, which leaves "here is the way out if you are in a
  hurry" as the only reading. There is no server-side check behind these hooks;
  they are the whole of this repository's CI, so the flag does not skip a wait,
  it skips the verification. The Tests table's Docker column also read
  "On open" on three rows, which is the Pages table's Refresh vocabulary copied
  one section down.

### Fixed

- **A materialized view's size was reported as zero.**
  `pg_stat_user_tables` carries a row per `relkind IN ('r','t','m','p')`,
  and the size CTE filtered to `'r'` before being `LEFT JOIN`ed back by
  name — so a matview matched nothing and `coalesce(size_num, 0)` reported
  a real, unmeasured size as a number indistinguishable from a genuinely
  empty table, sorting to the bottom of the default ranking where nobody
  would question it. The list now joins on `relid` and scopes to
  `relkind IN ('r','p')`, whose own storage really is zero when empty.
  `relationSizes` still reports matviews.
- **A table with no indexes reported zero index scans.**
  `pg_stat_user_tables.idx_scan` is `NULL`, not `0`, for a table that has
  no index at all. It was typed `string` and mapped with a bare `Number()`,
  which folded `null` to `0`, so the Table page said "Index scans: 0" for a
  table that could never have had one. It now renders "no indexes."
- **An underscore in the Tables search matched any character.** The term
  was bound into `'%' || $4 || '%'` unescaped, so `order_item` matched
  `orderXitem` and a `%` matched everything. `\`, `%` and `_` are now
  escaped before binding.
- **A table with no sequences earned a green OK badge.** `sequences`'
  verdict has no third state, so "nothing readable to judge" returns `ok` —
  the absence of a finding, not a claim the sequences are fine. The Table
  page now suppresses only an `ok` verdict and lets a `warn` through with
  its note and its remedy, which is the one piece of remediation text on
  that page: the column overflows before the sequence does, and widening
  the column is the fix.
- **A clean index and an unreadable one read one dash apart.** The Table
  page joined an index's flags with `|| '—'`, the same em dash this console
  uses everywhere for "we could not look". A clean index now renders an
  empty cell.
- **The pre-push hook broke every push.** git opens the connection to the
  remote *before* running `pre-push` — it must, because the hook is handed
  each ref's remote SHA on stdin — so the fifteen minutes the hook spent on
  the integration suite and a Docker image build were fifteen minutes of an
  idle `git-receive-pack` session. The remote dropped it and git died
  writing the pack to a closed pipe: exit 141, SIGPIPE, no output at all,
  not even `Enumerating objects`. `--no-verify` was the only way through,
  which made the gate worse than no gate: it trained the one reflex that
  skips it. The slow steps move to `scripts/gate.sh`, which records the SHA
  it passed on; the hook reads the ref lines off stdin and refuses any
  commit without that record. Binding the receipt to a SHA rather than a
  timestamp is what stops one gate run from blessing later work.

### Tests

- **The duplicate-index relation filter**, the last of the five
  relation-scoped checks with no coverage. Its filter sits inside the CTE
  both sides of the self-join read, so the effect is invisible on a
  one-table fixture; the test uses two tables and `limit: 1` with the
  wanted one sorted last, and was confirmed red by neutralising the
  predicate to `($2::text IS NULL OR TRUE)` — keeping `$2` bound, so the
  failure is wrong rows rather than a parameter-count error.
- **Four of the Tables list's six sort keys had no integration coverage.**
  `boundaries.test.ts`'s `::text`-alias guard only scans backtick blocks
  containing a literal `SELECT`, and every `ORDER BY` entry here is a bare
  fragment interpolated at run time. One test now seeds a table with no
  heap I/O at all alongside two measured ones, so the cache clause's
  `NULLS LAST` — which decides whether an unmeasured table ranks as the
  worst cache hit in the database — has something to get wrong.
- **`nav.test.tsx` asserts that every object tab is present**, not only
  that no stray tab appears. The allowlist it had could not fail: deleting
  the Tables entry from `TABS` left all 474 tests green.
- Four guards in `boundaries.test.ts` pin both halves of the hook change —
  that the slow steps are not in the hook, and that they are in the gate.
- **The README's route table is held against the routes that exist**, in
  both directions. A route with no row is undocumented capability, which is
  what the two Tables routes were for six commits. A row with no route is a
  promise the console does not keep, which sends an operator to a 404 during
  an incident. `registry.test.ts` already reads the README's parity table
  for the same reason.
- **The redaction guard matches by position rather than by contents.** The
  rule was "nothing naming `query` inside a brace span", but a brace span is
  not a rendering — `{ pathname, query }` is Next's object href — so the
  guard flagged hrefs, and `withParam` had to live in `lib/` because that
  was the one directory the scan did not walk. A brace renders only after
  `>`, `=`, `$` or `}`; asking where it sits is strictly more precise, and
  now distinguishes `({ query }) => <Sql>{query}</Sql>` from
  `({ query }) => <pre>{query}</pre>`, which the old rule could not, so it
  banned both. The guarantee is unchanged and still lives where it did:
  `routes.int.test.ts` seeds a real password into `pg_stat_activity` and
  asserts it appears on no route.

- **The integration harness resolves `next` instead of guessing where npm put
  it.** `NEXT_BIN` was a path relative to the test file —
  `../node_modules/next/dist/bin/next`, which is apps/web/node_modules — and
  that is correct only while npm nests `next` under this workspace. The
  dependency bump above hoisted it to the repo root, so every integration test
  in apps/web died on `MODULE_NOT_FOUND` fifteen minutes into the gate, after a
  Testcontainer and a production build, with a stack naming
  `node:internal/modules/cjs/loader` and nothing in this repository.
  `createRequire(import.meta.url).resolve()` walks the same chain
  `import 'next'` would, so it holds under either layout. Spawning the binary
  rather than `npm run start` is unchanged and still load-bearing: on Linux
  `npm run` orphans the server that holds the port. This is the third
  dependency to move here — the Dockerfile and the app's own vitest config are
  the other two, and both docblocks already warned that the next one to move
  would not announce itself. Neither warning was a test, so neither fired;
  `harness.test.ts` now stats the path `withConsole` spawns, in the one-minute
  pre-commit suite.

- **A test that could only ever pass on Postgres 15 and newer.**
  `table-list.int.test.ts` published the statistics its four sort assertions
  read by calling `pg_stat_force_next_flush()`, which arrived in Postgres 15,
  while this project declares, tests and documents 14 as its floor. Every 14
  leg of the gate failed on `function pg_stat_force_next_flush() does not
  exist`. It shipped because `npm run gate` runs one version by default and
  the 14/16/17/18 matrix only when asked, so a green gate says nothing about
  the floor. Two other integration files had already hit this and each polls
  instead, each explaining in a docblock that the function is unusable because
  the matrix runs 14 — in files this test's author had no reason to open. The
  poll is now one exported helper in the harness every integration file
  imports, and it waits for every fact the assertions rest on rather than only
  the one the flush was reaching for.

## [2.4.0] — 2026-09-23

The hygiene half, brought up to the incident half — P7b, P7c and P7d of the
hygiene roll-up design.
A finding nobody opened a page to look for now reaches the page they do open;
the hygiene pages stop being lists of everything at one weight; and the
console stops spending the same ink on good news as on bad.

A second live pass over every route closes the release — see §4.12 of the
design. It found that the console would not scroll, and that two of its
three charts were drawing things that were not in the data.

### Fixed

- **The page would not scroll.** `<Sql>` set `overflow-x-auto` on every
  rendered statement, and the CSS overflow spec computes the *other* axis
  from `visible` to `auto` when one axis is not visible — so each statement
  was a two-axis scroll container. The Queries page laid a hundred of them
  across itself, each 16px tall over a line up to 23,000px wide, and a
  trackpad gesture beginning over any one was captured by it. Statements
  clamp to two lines; `ui/table` remains the one horizontal scroller, which
  is what a comment on the sessions page had already argued for.
- **The database name scrolled away.** On `/queries` (4,400px tall) and
  `/sessions` (a Terminate button in every row), the identity guard expired
  at the first screenful. The header sticks.
- **Nothing marked the end of a page.** The last row sat 24px from the
  window edge, so a page that had finished scrolling looked like one that
  had stopped.
- **The charts were unreadable, and two of them were lying.** At `h-16`
  across the full shell they were 20:1 ribbons that encoded their whole
  range in sixty pixels of travel, under a value axis of two labels and a
  blank field between them. Now capped at 48rem, given real height, and
  ruled with four labelled gridlines. Three rules, each tested and
  mutation-checked: fewer than two points is not a chart (one capture drew
  an empty frame and a `−0s · −0s · now` axis); the axis will not scale
  below 2% of the reading (a 102 MB table that grew 8 KB drew a line
  climbing the full plot under four labels all reading "102 MB"); and a flat
  series gets one gridline rather than an invented range around it (the
  floor had produced `0 · −0.333 · −0.667 · −1` — negative call counts).
- **A query detail page with no query on it.** `/queries/<queryid>`
  identified its subject as a 19-digit integer and showed the statement
  nowhere. `readQueryText` fetches it in one indexed lookup; it was redacted
  at write time, so it is safe to render.
- **Raw timestamps in three more places**, to the microsecond, on a console
  that renders on the server and does not know the reader's timezone.
  `formatAgo` now serves all four callers.
- **Key-value lists on the Cleanup overview**, the shape converted
  everywhere else, and **a box around the whole Explain page**, written
  before a border came to mean "an escalated verdict is in here".
- **`ui/table`'s horizontal scroller had never engaged.** Its wrapper sat in
  a grid item, whose default `min-width: auto` refuses to shrink below the
  content's min-content size — so a `whitespace-nowrap` table made the item
  963px inside a 720px track and `overflow-x-auto` on a box already that wide
  is a no-op. At 768px the Sessions page was 965px and Queries 1101px, the
  whole document scrolling sideways. `min-w-0` on the item; all thirteen
  routes now hold 768 in both themes.
- **`formatCount` rounds.** Axis ticks are interpolated, so a calls axis
  read `681 · 457.667 · 234.333 · 11`. A count is a whole number.

- **The `CRITICAL` badge was below the contrast floor.** Measured,
  `oklch(0.577 0.245 27.325)` on its own 10% tint is 3.99:1 in light mode,
  against WCAG's 4.5:1 for text this size — on the badge that means wake
  someone up. New `-ink` tokens fix it, `--muted-foreground` moves with them
  (it passed by 0.03), and `apps/web/test/tokens.test.ts` parses the
  stylesheet, redoes the arithmetic and fails by name on any token that
  drifts under the line. It also asserts every measured token is inside the
  sRGB gamut, because a colour outside it has three different contrast
  ratios depending on who resolves it.

### Added

- **Four charts drawn from series that were already being captured.** No new
  capture and no migration for any of them: `query_load.calls` has been
  written since migration 004, `Interval.rows` and the shared-block counters
  differenced since P4, and `space_stats` filled since P1 — all of it
  discarded on every render.
  - *Calls beside execution time on Queries.* Execution time alone rises
    both when the database gets slower and when more traffic arrives, which
    have opposite fixes; read beside calls the pair is unambiguous.
  - *Rows and blocks read from disk on the query detail page*, joining calls
    and total time. Time up with rows flat is a plan that got worse; time up
    with blocks read up is a shape that outgrew the cache. Blocks rather than
    a cache-hit percentage on purpose: a ratio has no value in an interval
    that touched no shared buffers, and this console does not answer 0% or
    100% to a question it could not measure — and a hit rate lives in the
    last fraction of a percent, where the chart's own range floor would
    flatten exactly the drop worth seeing.
  - *Total table size over thirty days on the Space page*, summed in Postgres
    rather than in the console — one indexed aggregate instead of 3.4 million
    rows crossing the wire. It is deliberately **not** titled "database size":
    it sums user tables with their indexes and TOAST, excluding the catalogs
    and pgops's own schema, and would otherwise contradict the live Database
    size panel eight lines below it by 8 MB. The relation count rides back
    with the sum, so a fall can be told apart from a capture that measured
    less of the database.
- **No chart heading outlives its chart.** `LineChart` renders nothing below
  two points, so a heading beside it would have stood over blank page on a
  shape with a single capture.

- **A 24-hour load chart on the Queries page**, with a store. Every other
  number there ranks statements against each other, which answers "what is
  worst" and not "is this unusual" — and during an incident the second
  question decides whether the ranking matters at all.
- **`pgops.query_load`** (migration 004): one row per capture, the whole
  database's execution time and calls for that interval, differenced inside
  the capture that already holds both snapshots. Summed at read time instead,
  a large database would be over a million rows on every five-second poll. An
  interval spanning a statistics reset contributes nothing, so the chart has a
  gap exactly where the per-shape series has one — never a zero.
- **`LineChart`**, replacing `Spark`: a value axis with both bounds, a
  relative time axis, and a label that reads the series and both its ends
  aloud. A sparkline said "it went up" and could not say from what, to what,
  or over how long. It breaks the line where pgops stopped capturing, rather
  than drawing straight across a hole. Still inline SVG, still no charting
  dependency.
- **The pgops fold, on four more pages.** Indexes, Tables, Space and Sequences
  hide the console's own relations from their lists, count them in one line
  and show them on `?pgops=show` — the rule Sessions has always applied to
  pgops's own connections, now shared from `lib/fold.ts`. Readings and the
  checks' own verdicts still count them: a tool that removed itself from its
  own numbers would be lying about the thing it measures.
- **A count chip on the panels that find things and judge nothing.** Fifteen
  of the twenty-one hygiene checks reach no verdict by design, which left the
  panels with the most rows in them as the least marked things on the page.
  Neutral, never a hue — colour here means a threshold was crossed, and there
  is none.
- **Hygiene lines on the triage page.** Each band carries the cached state of
  its areas — Indexes and Tables under Queries, Sequences under Replication &
  cleanup — with the worst verdict among the area's checks, what it found, the
  age of the reading, and a link into the page that explains it. This is the
  one thing pgHero's dashboard did that pgops did not.

- **`pgops.check_results`** (migration 003): one row per check per database,
  upserted. Not a history — nothing reads a hygiene finding from last week, so
  there is no retention to run and no prune to get wrong.
- **A hygiene pass on the capture tick.** Every `class: 'hygiene'` check runs
  every five minutes, each bounded by its own `timeoutMs`, in its own
  transactions **after** the capture's has committed — twenty-one catalog
  scans have no business inside the transaction that holds the store's write
  path open. Skipped rather than queued when another replica holds the lock,
  the same rule capture follows.
- **Write-through from the hygiene pages.** They still run their checks on
  visit, unchanged, and now cache what they found, so a page and the line
  beneath it agree the moment anyone has looked.
- `AREAS` and `hygieneAreas()` in `packages/checks` — which checks belong to
  which page, and the roll-up, as data and one pure function.

### Changed

- **The Space page says "not enough history" once, not thirty times.** The
  growth column reads `—` per row and one sentence above the list gives the
  capture count and how long ago the first was taken. A thirty-relation
  database's most repeated words explained an absence rather than describing
  the database.
- **`Findings` is one component**, shared by Indexes and Tables, which each
  carried a byte-identical copy.
- The README's poll boundary. Hygiene pages still never poll; with a store
  configured, their checks also run on the capture tick. Without one, nothing
  is scheduled and the triage page says so once, naming the variable.

### Changed — how the console looks

- **A box means look here.** Only a check that needs attention — `warn`,
  `critical`, or one that could not run — keeps its bordered card, and it
  gains a tinted surface with the accent bar it already had. Everything else
  is a row on the canvas under a hairline. A triage page with nothing wrong
  was nine outlined boxes: furniture at the weight of a signal.
- **The four gates became a spine.** They have always been a sequence — the
  gates a request clears, in the order it clears them — and the page never
  showed it. A numbered rail down the left carries each gate's name, its
  question and its link, with a rule binding the band beside it. Causes run
  down the numbers and symptoms run up them. It collapses to plain headings
  below `lg`.
- **A type scale of five sizes and nothing between them**, body text in its
  own token a step lighter than a heading, and the shell down to 84rem.
- **`0 slot(s)` became `0 slots`**, through one helper that takes an
  irregular plural rather than guessing it.

### Notes

- **Three areas carry a line, not four.** Space, Maintenance and Settings have
  no member that can escalate — every one of their checks reports a reading
  and judges nothing — so a line for them would have to invent a verdict. The
  design expected `autovacuumDanger` to escalate; it deliberately does not
  (see the divergence for #45), and `escalates` is derived from the checks so
  a threshold added later gives an area its line with no edit.
- **An area's band is declared, not read from its checks' gates.**
  `invalidConstraints` answers a `keep-up` question on a `work` page, and
  `tableStats` does the same. The two are allowed to disagree.

## [2.3.1] — 2026-09-22

A patch for two pages that answered 500 whenever actions were enabled.

### Fixed

- **`/cleanup/maintenance` and `/sessions` no longer fail with
  `PGOPS_ALLOW_ACTIONS=true`.** Maintenance failed on every load. Sessions
  failed whenever a query had run past the long-running floor, which is the
  moment an operator opens it. Both pages handed the confirmation control a
  function to format its result, and a server page cannot pass a function to
  a client component. The result sentences now live in the control, chosen by
  key, so a caller that tries to pass a function fails typecheck. Broken since
  2.2.0.

### Tests

- The integration suite now fetches the pages that mount a confirmation with
  actions on. Every earlier page test ran with actions off, where the control
  is never rendered, and every actions-on test posted to an API route without
  rendering a page. That is how the break shipped twice.

## [2.3.0] — 2026-09-21

Explain and index suggestions — and with them, parity with pgHero is complete.

**Minor, not major.** Two routes are added under the Queries tab, one tier-0
API route, and nothing changes meaning or goes away.

Parity, read from `registry.ts`: **60 of the 65 capabilities ship, 5 are
declined on purpose, and 0 remain.** Every phase is complete, so the phase gate
now fails any capability added as `planned`.

### Added

- **Explain** at `/db/<name>/queries/explain` — paste a statement, read its plan
  as familiar `EXPLAIN` text and which index, if any, would serve it. A
  `$1`-style shape copied from the Queries tab plans generically, on every
  supported version. Closes #57 and #64.
- **Suggested indexes** at `/db/<name>/queries/indexes/suggested`, linked from
  the Indexes page beside index bloat — the busiest shapes over 20 ms and 50
  calls, each planned and advised, grouped by the index they want, with every
  shape examined listed beneath. Closes #58 and #63.
- `POST /api/db/<name>/explain`, tier 0: available with actions off, because
  planning changes nothing. It still requires `application/json`.
- `Tool<Input, Data>` and `runTool` in `packages/checks` — the shape the parity
  spec declined to design for questions the operator asks.

### Declined

- **#62 `autoindex`**, permanently: it builds an index on a monitored database,
  the same schema-change boundary as #19 and #61. Every suggestion carries the
  exact statement for the operator to run instead.
- **#59 `system_stats`**, permanently, as the parity spec had already ruled:
  per-cloud credentials and a cloud SDK for one panel.

### Security

- **Operator SQL takes exactly one path, `planStatements`**, and a source guard
  holds `PREPARE` to that file. The statement is prepared as a *named*
  statement, so Postgres refuses a second command after a `;`. Measured before
  it was written: over node-postgres's simple protocol the injected statement
  runs, **including when an empty parameter array is passed**, and only a
  named statement stops it. It runs in `BEGIN READ ONLY`, is always rolled
  back, and its connection is destroyed, because prepared statements survive a
  rollback. A one-second lock timeout means a table locked by a migration
  fails its shape at once instead of holding the page for ten seconds a shape.
- **Error messages from a failed plan are allowlisted by SQLSTATE.** Messages
  that can echo a value, such as `22P02`, are replaced with their code.

### Changed

- `readJson`, extracted from `openAction`, is the one copy of the CSRF
  media-type check, shared by the action routes and the explain route.
- The Queries and Cleanup section strips are rendered by each tab's layout
  instead of by every page, and a guard holds that.
- The DDL guard pins `tools/advice.ts` beside `run.ts`, and says why: it
  *builds* the index statement handed to the operator and never runs it.
- `shadcn` is no longer a dependency. It is a code generator, and the two
  components it ever produced are checked in; it stayed declared only so
  `globals.css` could import a stylesheet of variants nothing used, and that
  one import carried the MCP SDK, express and a `qs` advisory into the
  production tree. The scaffold guard now keeps it out.
- The design documents moved out of `docs/superpowers/specs/`. The
  per-phase execution plans and review transcripts that sat beside them, and
  the pre-console plan PDF that described the terminal program, are removed.

### Fixed

- **The plan text now matches what `EXPLAIN` prints.** It printed only each
  node's type, which turned a `Hash Left Join` into a `Hash Join` and a
  `Nested Loop Anti Join` into a `Nested Loop` — a different query — and lost
  aggregate strategies, partial and parallel modes, scan direction, the modify
  operation and CTE/subplan headers. Every node line is now held to real
  Postgres 17 output for 21 statements.
- **A shape pgops is not allowed to plan says what to grant, and is not counted
  as cleared.** `EXPLAIN` checks `SELECT` on every table it names even though
  it reads nothing, so the least-privilege role the README recommends is
  refused on every application table. The message now says which privilege is
  needed. The suggestions page says how many shapes could not be planned
  instead of reporting "no index suggested" for all of them, and the README
  documents the requirement.
- **The section strips under Queries and Cleanup now mark the page you are
  on.** They never did: rendered inside each page, `useSelectedLayoutSegment()`
  had no segment below it to report. Every test mocked the hook with the value
  it would have returned from a layout, so all of them passed.

### Notes

- **No dependency was added.** The parity spec said the suggestions would ship
  with a SQL parser. They read the planner's plan instead, which handles joins
  and needs no parser; the spec's §7 is amended to say so.
- **Nothing new polls.** Neither new page carries a `<Refresh>`.

## [2.2.0] — 2026-09-18

The remaining actions. pgops could terminate one session; it can now terminate
every query running past the floor, reset either kind of statistics, and
refresh planner statistics — each behind the same flag, each audited, each
confirmed.

**Minor, not major.** No route changes meaning, nothing is removed, and the nav
keeps its shape. Every control lands on a page that already existed, beside the
data it affects, and a deployment that never sets `PGOPS_ALLOW_ACTIONS` sees
none of it.

Parity, read from `registry.ts` rather than counted by hand: **56 of the 65
capabilities ship, 3 are declined on purpose, and 6 remain.** `parityBacklog`
reports P5 as 0 and the phase gate is green; only P6 is left.

### Added

- **Terminate long-running queries** on `/db/<name>/sessions` — the matching
  sessions are listed first, one reason covers the batch, and each is
  terminated through the same identity-pinned statement a single kill uses.
  Per-session outcomes, never a boolean. Closes #12.
- **Reset query statistics** and **reset database statistics** on
  `/db/<name>/queries`, side by side so the difference between them is legible
  before either is pressed. Closes #20 and #31.
- **Analyze tables** on `/db/<name>/cleanup/maintenance`, on the page that
  renders the last-analyze times it refreshes. Closes #47.
- **Tier 2 and server-side typed confirmation.** The web spec's action ladder
  had a tier that nothing implemented; the three destructive actions now
  require the database name typed back, checked in `openAction` rather than
  only in the browser.
- `lib/action-route.ts`, one preamble shared by all five action routes — the
  tier gate, the CSRF media-type check, the reason, the confirmation, the
  context and the actor.

### Declined

- **#19 `enable_query_stats` and #61 `disable_query_stats`**, permanently. Both
  are DDL against a *monitored* database, which four separate commitments in
  this project forbid: the §3.3 promise confining schema changes to the store
  "and nowhere else", the DDL guard's regex over both packages, the action
  ladder's tier 3 ("CLI only, never reachable from the web"), and §8, which cut
  the CLI that was tier 3's only vehicle. Removing the extension is worse than
  installing it — it destroys every query statistic on the database, and
  pgops's own capture reads that extension every five minutes. The parity
  spec's §7 claimed "all of the hard lite calls are in P6"; it had not examined
  P5, and this release amends it.

### Changed

- **The reset tripwire in `guards.test.ts` narrowed from a blanket ban to an
  exact allowlist**, and this is the change to read if you are auditing this
  project's safety claims. It forbade any file under `packages/checks/src` from
  naming `pg_stat_statements_reset` or `pg_stat_reset`, because pgHero calls
  one *as part of capture* and not doing that is what the parent spec §4.3
  calls the strongest product claim in the design. That claim is unchanged.
  What changed is the guard's shape: a blanket ban was right while pgops had no
  reset at all and wrong once it had a gated, confirmed, audited one. The
  allowlist names `actions/stats.ts` and nothing else, and a **second** test
  now names `capture.ts`, `store/write.ts`, `store/read.ts` and
  `series/query-stats.ts` directly — because an allowlist that merely happens
  to exclude the capture path is weaker than one that says so.
- `longRunning` returns `backendStart`. The bulk kill is pinned to it, so it
  has to be captured when the operator is looking at the row.
- The `ANALYZE` relation list is sized from `c.relpages`, not
  `pg_total_relation_size`. The latter opens each relation, taking a lock that
  conflicts with `ACCESS EXCLUSIVE` — so one table locked by a concurrent
  migration blocked the *listing*, before any `ANALYZE` was attempted, and the
  action hung for its full statement timeout. pgHero has the same hang.

### Notes

- **`pg_stat_statements_reset` is called with three arguments, never four.**
  `minmax_only` arrived in PG 15 and the supported floor is 14. The return type
  also differs across that boundary (`void` vs `timestamptz`) and is not read.
- **The reset is scoped to the current database's oid.** `pg_stat_statements`
  is shared across the cluster and the zero-argument form wipes every
  database's statements.
- **Nothing new polls.** The three pages gaining controls keep exactly the poll
  status they had.

## [2.1.0] — 2026-09-18

Trends over the captured history. P3 shipped the store and the five-minute
capture; this is the first release that reads it back as a shape rather than a
single delta.

**Minor, not major.** Nothing is removed, no route changes meaning, and the nav
keeps its shape: both new routes are drill-downs reached by clicking a row on a
page that already exists. There is no *Trends* tab — space growth belongs to
`keep-up` and query-shape history belongs to `work`, and a tab that cut across
both would give `gates.ts` a second organising axis competing with the first.

Parity, read from `registry.ts` rather than counted by hand: **52 of the 65
capabilities ship, 1 is declined on purpose, and 12 remain.** `parityBacklog`
reports P4 as 0 and the phase gate is green; P5 and P6 owe 6 each.

### Added

- **Seven-day growth on** `/db/<name>/cleanup/space` — a signed byte delta
  beside every relation size, computed between the first and last capture in
  the window. Relations link to their own history.
- **Relation history** (`/db/<name>/cleanup/space/<relation>`) — one relation's
  captured size over thirty days as a sparkline, with the endpoints, the change
  and the capture count stated beneath it. Closes #41 `relation_space_stats`.
- **Query-shape history** (`/db/<name>/queries/<queryid>`) — one statement
  shape's calls and total time per interval over twenty-four hours. Reached by
  clicking a row on the Queries tab. Closes #16 `query_hash_stats`.
- `spaceGrowth`, `relationSpace` and `queryShapeHistory` in `SERIES`, with
  `readSpaceGrowth` and `readRelationSpace` behind them. Closes #40
  `space_growth`.

### Changed

- **`space_growth` measures between two stored captures, not against a live
  size** — the thirteenth catalogued divergence from pgHero. pgHero takes the
  oldest size in the window and subtracts it from the relation's size *right
  now*, re-measured against the monitored database. That mixes a stored reading
  with a live one: up to one capture interval of change is attributed to the
  whole window, and the number moves every time the page is re-rendered, so two
  operators looking at the same "7-day growth" see different figures. Both
  endpoints come from the store here, and the last capture time travels with
  them.
- The README parity guard now derives which phases to check from
  `COMPLETE_PHASES` instead of a hardcoded list, so a phase that finishes no
  longer leaves the guard demanding a "P4 owes 0" line.

### Notes

- **Neither new route polls.** They render history, which does not move between
  refreshes. The poll boundary guard holds this from both directions.
- **Both bound their reads.** Thirty days of one relation at the five-minute
  cadence is 8,640 points; twenty-four hours of one shape is 288 snapshots.
  §5.1 requires the bound, and it is asserted on the arguments the page passes
  rather than on what renders — a page that forgot it looks identical against a
  small fixture.
- **A relation with one capture says "not enough history".** Its growth is
  arithmetically zero, and "0 B" would claim a week of flatness from a single
  reading.

## [2.0.0] — 2026-09-17

The hygiene half ships. v1 answered the questions you have in the first five
minutes of an incident; v2 answers the ones you have on a Tuesday afternoon —
indexes, bloat, table and database size, sequence exhaustion, vacuum and
analyze, and the server's own settings.

**Major, because the console changed shape.** `gates.ts` has always modelled a
request as four gates, and the nav had only three tabs: `keep-up` —
*Replication & cleanup* — had no destination. It has one now, and every gate
has a tab.

Parity, read from `registry.ts` rather than counted by hand: **49 of the 65
capabilities ship, 1 is declined on purpose, and 15 remain.** `parityBacklog`
reports P2 as 0 and the phase gate is green; P4, P5 and P6 owe 3, 6 and 6.

### Added

- **Cleanup** (`/db/<name>/cleanup`) — the wraparound horizon, replication role
  and lag, and replication slots. The one hygiene-gate route that polls, at the
  incident cadence, because a closing horizon and a stalled slot both get worse
  while you watch.
- **Space** (`/db/<name>/cleanup/space`) — database size, largest relations,
  largest tables with their indexes and TOAST.
- **Maintenance** (`/db/<name>/cleanup/maintenance`) — running vacuums with
  their progress, last vacuum and analyze per table, and transaction-ID age by
  relation.
- **Sequences** (`/db/<name>/cleanup/sequences`) — every sequence against the
  ceiling of the column it actually feeds, with the ones this role cannot read
  counted rather than dropped.
- **Indexes** (`/db/<name>/queries/indexes`) — index hit rate and caching,
  missing indexes, unused indexes, duplicates, and invalid indexes.
- **Index bloat** (`/db/<name>/queries/indexes/bloat`) — the five-CTE estimate,
  on its own route and run only when asked, because pgHero keeps it off the
  page you open by reflex for the same reason.
- **Tables** (`/db/<name>/queries/tables`) — table hit rate, caching, unused
  tables, and per-table statistics.
- **Settings** — the server's own configuration, in a collapsed disclosure on
  the Cleanup page.
- A second-level nav under the tabs that carry sub-routes, and a `Cleanup` tab
  on the first level.

### Changed

- **The poll boundary is now enforced in both directions.** `/cleanup` and the
  four incident pages refresh every five seconds; every hygiene route runs its
  catalog scans on visit and never polls. A guard fails if a hygiene route
  gains a refresh, and fails if an incident page loses one.
- **`registry.ts` closes P2.** Ten capabilities flip from planned to shipped
  and `'P2'` joins `COMPLETE_PHASES`, which the phase gate now holds.

### Divergences from pgHero, new in this release

Each is documented at the code that implements it; the full catalogue of twelve
is in the README.

- **Sizes are bytes, not `pretty_size` strings.** `"8192 MB"` cannot be
  thresholded, summed or charted. The formatting happens at the page.
- **A reading we could not take is `null`, never a sentinel.** pgHero renders
  an index with no I/O yet as `"Insufficient data"` in a column of percentages,
  and a table nothing has read as `0%` cached — both sort to the top of a page
  ranked by how bad the reading is.
- **Settings are one round trip, not fifteen**, and the value is the
  `SHOW`-equivalent: `shared_buffers` reads `128MB`, not `16384` with a
  separate `8kB` unit. pgHero's version branch is dropped rather than copied —
  it exists because `SHOW` errors on a setting the server does not have, and
  `pg_settings` returns no row instead.
- **`sequence_danger` measures against the COLUMN's type, not the sequence's
  own maximum.** A bigint sequence feeding an `integer` column overflows at
  2,147,483,647; measured against its own `max_value` it reads as 0.00000002%
  used on the day it starts failing.
- **`autovacuum_danger` ships as a list, not an alarm.** `transaction_id_danger`
  already reads the database-wide `datfrozenxid` — the minimum over every
  relation — so it cannot miss what the per-relation list would find, and two
  badges on one fact would disagree the moment either was tuned. The list also
  reads the TOAST relation's frozen xid, which freezes independently of the
  heap.
- **`maintenance_info` is answered by `table_stats`.** Both read
  `pg_stat_user_tables` and return the same eight fields. One question, one
  answer.

## [1.0.0] — 2026-09-11

The first release. pgops is a web console you deploy next to your databases:
one URL, many databases, no agent and nothing to schedule.

**v1 is the incident half of pgHero, and only that half — deliberately.** It
answers the questions you have in the first five minutes of an incident: who is
connected, what is blocked, what is running long, how much connection headroom
is left, which server you are actually pointed at. Then, if you switch the
safety off, it can terminate the backend holding everything up.

The hygiene half — indexes, bloat, table and database size, sequence
exhaustion, maintenance and settings — is **not** in v1 and is not partially
in v1. It is designed
and scheduled for v2. Shipping half of it would have meant a console that
answers "are your indexes healthy?" with a screen that is silently incomplete,
which is the one failure mode this project is built to avoid.

Parity is a checked claim, not a slogan: `packages/checks/src/registry.ts` maps
all 65 capabilities of pgHero 4.0.1 onto a shipped check, a shipped action, a
platform feature, or a numbered phase, and the test suite fails if a phase
marked complete still owes one. **24 of the 65 ship in v1, 1 is declined on
purpose, and 40 remain.**

### Added

- **Overview** (`/`) — every configured database with its worst verdict across
  every incident check. A check that could not *run* is reported separately
  from a check that ran and was fine.
- **Triage** (`/db/<name>`) — connections and headroom, sessions by state,
  what is blocked, long-running queries, the lock picture, wraparound horizon,
  replication slots, replication lag, and top queries.
- **Sessions** (`/db/<name>/sessions`) — live `pg_stat_activity`, connection
  sources grouped by database/user/app/IP with an SSL breakdown, and the one
  place an action can be taken.
- **Locks** (`/db/<name>/locks`) — the wait graph: who blocks whom, root
  blocker at the top of the chain, cycles marked rather than silently trimmed.
- **Queries** (`/db/<name>/queries`) — `pg_stat_statements` sortable by total,
  mean or calls, plus a slow-queries panel scoped to what was fetched. With a
  store configured, each row carries what it did since the last capture.
- **History** — `PGOPS_STORE_URL` enables a `pgops` schema (five tables, one
  forward-only migration under an advisory lock), captured at boot and every
  five minutes.
- **Guarded `kill`** — off by default, pinned to session identity rather than
  pid, requiring a free-text reason, audited to stdout and to a local log.
- **Multi-database routing** via `PGOPS_DATABASES` / `PGOPS_CONFIG_FILE`, read
  at request time so one image serves any target.
- HTTP basic auth over every route that can read or change a database.
- **The gates** (`packages/checks/src/gates.ts`) — the four gates a request
  clears, in order: connect, wait, work, keep-up. Every check and all 65 pgHero
  capabilities declare one, the compiler requires it, and the triage page's
  bands are *derived* from `GATE_ORDER` rather than written beside it. Causes
  run down the order and symptoms run up it, which is why a session blocked at
  `wait` is no longer offered for termination as though it were slow.
- **Every verdict explains itself.** `Threshold.because` was required,
  non-empty and unit-tested, and reached no pixel of the console; thresholds
  now also carry an optional `remedy`, and `runCheck` resolves the threshold a
  verdict actually crossed so any surface renders both without asking.
- **A bullet graph** on the readings that have a scale — the console computed
  `headroom / max * 100` to decide a verdict and then rendered a string that
  never showed it. Redundant to the text beside it, and `aria-hidden` for that
  reason.
- **pgops folds away its own connections** on Sessions, behind a count and a
  toggle. Pools are named via `application_name`, so the console can tell its
  ~19 idle backends from the application's three real ones.
- **A freshness readout that moves, and a refresh you can ask for.** The
  display ticks every second while the poll runs at five, so a stalled poll
  shows as a number climbing past the interval.
- Active-tab marking in the nav, a styled 404, and a tab icon.

### Divergences from pgHero, all deliberate

- **Capture never resets shared statistics.** pgHero's `capture_query_stats`
  calls `pg_stat_statements_reset()`, which silently zeroes the view for every
  other consumer of that database. pgops stores cumulative counters and
  differences them at read time.
- **`kill_all` is declined, permanently.** There is no incident in which
  "terminate every session, unreviewed" is the correct first move.
- **`replication_lag` is `null` on a primary, not `0`** — `0` reads as
  "perfectly caught up", a claim about replication made about a server that is
  not replicating.
- **`ssl_in_use` reads `pg_stat_ssl`**, a core catalog since 9.5, rather than
  pgHero's `sslinfo` extension. An unreadable SSL status renders `SSL unknown`,
  never `no SSL`.
- **`connection_security_breakdown` adds a fifth value**, `Unknown`, to
  pgHero's four, so a read failure cannot render as a confirmed "No SSL".
- **A gap in history is drawn as a gap.** When a counter goes backwards the
  interval spanning it is dropped rather than clamped — a spike that never
  happened reads as an incident, and this is a tool you open during one.

### Security

- **The kill route is now indistinguishable from a build without the file on
  every HTTP method, not just `POST`.** `route.ts` exports only `POST`, so
  Next's app-route dispatch answered `GET` with a `405` before any handler ran
  — and a `405` where a missing route answers `404` disclosed that the console
  had the kill endpoint compiled in, however firmly `PGOPS_ALLOW_ACTIONS` was
  left unset. The gate now sits in `proxy.ts`, above method dispatch; the route
  keeps its own copy so the property does not rest on a matcher.
- The kill route requires `Content-Type: application/json`, which a
  cross-origin HTML form cannot set — basic-auth credentials ride cross-site
  automatically, and there is no SameSite equivalent for `Authorization`.
- `PGOPS_ALLOW_ACTIONS=true` with no `PGOPS_USERNAME` warns on stderr the first
  time such a request arrives. It does not refuse to serve: some deployments
  legitimately put an authenticating proxy in front.

### Fixed

- **Wraparound was calibrated against the wrong number.** The check compared
  `age(datfrozenxid)` against `autovacuum_freeze_max_age` — a routine
  maintenance trigger, not a danger line — and criticalled at 90% of it, which
  fired at 8.38% of the real horizon. In the other direction a database hours
  from refusing transactions rendered as "1000% of horizon". The alarm is now
  transactions remaining; the ratio stays as information.
- `backendStart` may be omitted from a kill request and is treated as `null`,
  which is what every caller that omitted it already meant. `reason` is
  validated first, so a body missing both names the field that matters.
- The delta column pluralizes a single call correctly.
- `scripts/dev-db.sh` no longer advertises `pgops` CLI subcommands, which do
  not exist.
- **The Queries page can now be sorted.** `?sort=` had always been read, and
  this README had always called the route sortable, but nothing on the page
  could set it — the ordering was reachable only by editing the URL. The
  column headers are links, and the active one carries a caret, not colour.
- **Query times are readable.** `formatDuration` floors to whole seconds, so
  every mean below a second — very nearly all of them — rendered `0s` in the
  column the page ranks by.
- **The whole console rendered in the browser's default serif.** `@theme
  inline` mapped `--font-sans` onto a variable normally supplied by
  `next/font`, which this app does not use, so `@apply font-sans` emitted a
  `font-family` with no value.
- **Severity was a two-colour scale.** Every palette token was `oklch(L 0 0)` —
  lightness only, chroma zero — so `warn` and `ok` differed only by having a
  fill, on the page whose job is "is anything wrong anywhere?".
- **An unreachable database rendered its error nine times** inside a full band
  structure, as though there were something to triage. Identical failures now
  collapse to the single fact; differing ones still render per panel.
- The kill control no longer refuses a blank reason silently, announces its
  outcome via `role="status"`, and opens leftward instead of widening the table
  past the viewport.
- The store's pool names itself `pgops-store`, so it is distinguishable from
  the console's own connections when both point at one database.

### Known limits

- No published image. Build from a clone.
- `pg_stat_statements` is required for the Queries route; every other route
  works without it and says what is missing rather than rendering empty.
- Postgres 14 or newer, tested against 14, 16, 17 and 18 on every push.
