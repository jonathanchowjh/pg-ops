# pgops — the mental model, and the navigation that should reflect it

**Status:** In design, 2026-09-23/24. Settled with the operator: §3, §4,
§5.2, §5.3, §5.4, §6.1, §6.2, §6.3, §8. The remaining entity pages (§5.5) are
proposed and not yet agreed. Nothing implemented.
Supersedes the navigation assumptions of the web design of 2026-08-26 (§4)
and amends the gate-to-tab mapping of the full-parity design of 2026-09-03.

## 0. Why this document exists

> "not liking the navigation, looking at something i would like to be able to
> click into it, and for this to have a clear mental hierarchy i can traverse,
> this doesnt. its flat with no depth … focus on the mental model and picture
> first, the UI should then reflect that."

Also raised in the same breath, and downstream of the same cause: the tables
do not sort, filter or search meaningfully, and the UI patterns are not
standard across pages.

## 1. The diagnosis

### 1.1 The console has pages for QUESTIONS, not for THINGS

Eight pages render a relation name — Space, Space detail, Maintenance,
Sequences, Tables, Indexes, Index bloat, Sessions. Not one of them is *about*
that relation.

Of every noun in the console, exactly one is clickable to a page of its own:
a query shape. `cleanup/space/[relation]` exists, is linked from a single
page, and shows only a size chart — it is a chart with a URL, not a table
page.

So "looking at something I would like to be able to click into it" has no
answer anywhere in the app. That is the flatness. It is not a shortage of
menu levels; it is an absence of nouns.

### 1.2 Gates are a lens, not a hierarchy

`connect / wait / work / keep-up` answer "what is wrong right now", which is
the product's thesis and is good at its job. They fail as a browsing
structure for two reasons:

- **An entity belongs to several gates at once.** A table's cache hit rate is
  `work`; its vacuum age and size are `keep-up`; the index suggested for it is
  `work`. No gate can own the table page, so today none does.
- **They are lopsided as containers.** Of 60 live capabilities: `work` 26,
  `keep-up` 20, `connect` 7, `server` 6, `wait` 1. Balanced as questions,
  unusable as a menu.

### 1.3 The Cleanup tab is a grab-bag

It holds wraparound and replication (live, polling, `class: 'incident'`)
beside Space, Maintenance and Sequences (catalog scans, on visit, with
history). Two different kinds of thing under one word.

## 2. Prior art

| Tool | Structure | What to take |
|---|---|---|
| **pgHero** | Flat by topic: Queries, Space, Connections, Maintenance, Explain, Tune | Nothing structural — it has the same defect. Parity is already settled elsewhere. |
| **pgAdmin** | Pure object tree: server → database → schema → table → index | The hierarchy of nouns. Useless during an incident. |
| **AWS Performance Insights / Datadog DBM** | One load chart, *sliced* by dimension (wait event, SQL, host), drill into a SQL | The "slices of the picture" idea for charts, and drill-down as the primary gesture. |
| **pganalyze** | Entity pages (a Table page gathers schema, indexes, vacuum history, bloat, IO, size over time) **plus** a separate Checks layer for issues | The two-axis model, and the gathering table page. Closest to what is wanted. |

The pattern in the good ones is two axes: **issues** (what is wrong) and
**objects** (what is this), with every mention of an object linking to its
page.

## 3. Decision — two modes: Now and Explore

**Settled 2026-09-23.**

- **Now** keeps the gate triage. It is the live view, and it is what makes
  pgops distinctive.
- **Explore** is the object layer that does not exist today: one canonical
  page per thing, gathering everything the console knows about it.
- **Every noun rendered anywhere in Now is a link into Explore.**

Rejected: making the gate tabs themselves list→detail (a table would live
under one gate while belonging to three, so every entity page would be a
partial view); and going objects-first with health demoted to one page
(during an incident the gates must come first).

## 4. Decision — the seam is LIVENESS

**Settled 2026-09-23.**

Now polls; Explore does not, and carries history.

This is not a new boundary. `test/guards.test.ts` already enforces it from
the source side: incident pages poll every five seconds, hygiene pages run
their catalog scans on visit and never poll. The information architecture
should follow the line the code already holds.

```
shop                                   [Now] Explore   ⚙
─────────────────────────────────────────────────────────
NOW  (polls 5s — ephemeral)
  Triage · Sessions · Locks · Replication
  └─ the four gates are the BANDS on Triage

EXPLORE  (on visit — durable, with history)
  Queries   → a query shape
  Tables    → public.order_items
  Indexes   → public.order_items_sku_idx
  Sequences → public.orders_id_seq
```

**Consequence to accept: the tabs stop being 1:1 with gates.**
`test/nav.test.ts` currently holds "every gate has a tab". The gates survive
as the triage lens — the bands on the Now page — rather than as the tab
strip. That test changes meaning and must be rewritten deliberately, not
deleted.

**This dissolves §1.3.** Wraparound and replication are live, so they join
Now. Space, Maintenance and Sequences are durable, so they become facets of
the Tables and Sequences entity pages in Explore.

## 5. The entity pages

### 5.1 Three of today's pages are sorts, not pages

Reading the code made this sharper than §1.1 put it. These are not pages
about different things; they are one list under three orderings:

| Today | What it actually is |
|---|---|
| `cleanup/space` | Tables sorted by size |
| `cleanup/maintenance` | Tables sorted by vacuum age |
| `queries/tables` (unused half) | Tables filtered on `scans = 0` |
| `queries/indexes/bloat` | Indexes sorted by bloat |

This is why "the tables dun allow me to sort" and "its flat with no depth"
are one complaint and not two: the missing sort was being compensated for
with a page each, and a ranking makes a dead-end page — there is nothing to
click, because the page is about an order rather than a thing.

Once the Tables list sorts and filters, those pages stop existing.
`cleanup/space/[relation]` — the chart with a URL — is not deleted; it is the
Table page's first panel, already written.

Route count goes from 15 to about 12, and every noun becomes clickable.

**URL scheme (decided, low stakes):** flat — `/db/shop/tables/public.order_items`,
with no `/explore/` segment. Now and Explore is a nav concept and the mode is
derivable from the first segment; a short URL is what survives being pasted
into Slack during an incident.

### 5.2 An entity page asks about ONE relation — **settled 2026-09-24**

Every relation-oriented check already returns rows keyed by the table. Twelve
row types, one join key, none of it new:

| Keyed by the table itself | Carrying their table |
|---|---|
| `TableSize.name`, `TableCaching.table`, `UnusedTable.table`, `TableStat.table`, `RelationXidAge.relation` | `IndexEntry.table`, `BloatedIndex.table`, `DuplicatePair.table`, `IndexFinding.table`, `TableIndexUsage.table`, `SequenceEntry.table` |

So a Table page is a join over checks that already run — no new checks, no new
store tables. And `Check<Row, Data, Opts>` already parameterises its own SQL
(`sql: (o) => ({ text, values: [o.limit ?? DEFAULT_LIMIT] })`), so what an
entity page needs is an added optional `relation` on the opts, not new
machinery.

**It must not be assembled from the cached LIST results, and this is the
decision.** Every one of those checks is capped with `LIMIT $1`. Filtering the
top N means a table that falls outside every cap renders "cache hit rate: —"
— pixel-identical to "we measured, and there is none". That is `verdict: null`
being served as `ok`, the rule this project treats as its signature,
reintroduced through the back door on the very page whose job is to gather
everything known about one thing.

Asking about the one relation is also the cheaper query: an uncapped
single-relation predicate is the smallest thing this console runs.

### 5.3 The Table page — **settled 2026-09-24**

| Panel | From | New work |
|---|---|---|
| Size, and growth over 30 days | `tableSizes` + `space_stats` | none — this is `cleanup/space/[relation]`, already written |
| Live/dead rows, last vacuum and analyze | `tableStats` | `relation` opt |
| Transaction age, wraparound headroom | `autovacuumDanger` | `relation` opt |
| Cache hit rate, heap vs index | `tableCaching`, `indexUsage` | `relation` opt |
| Its indexes, flagged unused/duplicate/invalid/bloated | `indexList` + the four finding checks | `relation` opt |
| Sequences feeding its columns | `sequences` | `relation` opt |
| The index suggested for it | `missingIndexes` | `relation` opt |
| ANALYZE | the existing actions layer | flag-gated, unchanged |

### 5.4 Cut: "the query shapes that touch this table" — **settled 2026-09-24**

§5 listed it as part of the Table page; it is not being built, and the
same edge seen from the Query shape side (§5.5, "the tables it reads") is
cut with it. pgops has no way to know which shapes
touch a relation. It would take SQL parsing or planner output, neither of
which exists here, and the only cheap version — substring-matching the
redacted statement text — returns `orders` when asked for `order_items` and
misses everything behind a view. A panel wrong in both directions is worse
than an absent one. Recorded in §9 rather than half-built.

### 5.5 The other entity pages — proposed

Not yet agreed. Each gathers what is today scattered across the pages named
in brackets.

(The Table page is settled above, at §5.3.)

- **Query shape** — the statement; its four series [query detail]; its plan
  [explain]; the index suggested for it [suggested]. NOT the tables it reads
  — see the cut at §5.4.
- **Index** — definition; size and growth; scans; unused/duplicate/invalid/
  bloat; the table it is on.
- **Sequence** — last value, ceiling, percent consumed, the column it feeds.
- **Session (backend)** — pid, state, age, the statement, what it blocks and
  waits on, terminate. Lives in Now, not Explore: a backend is ephemeral.

## 6. The standard patterns

The operator's words: "all these UI things should be standard throughout."

### 6.1 The table component already exists — **settled 2026-09-23**

`components/findings.tsx` is it. Thirteen call sites across the three hygiene
pages already route through it, and it already holds the alignment rule (a
trailing `>` on a column label right-aligns it), the truncation accounting
("Showing 9 of 42") and the fold. §6 does not need a new component; it needs
sort, filter and search added to this one.

It also already names the entity. Every call site passes
`subject: (item) => string` — the relation the row is *about* — because
`foldOurs` needs it to hide pgops' own storage from pgops' own findings. So
the hook for "click into it" is threaded through all thirteen sites already;
it simply is not rendered as a link. The accessors split cleanly into
table-subjects (`t.table`) and index-subjects (`i.name`), so what is missing
is a `kind` prop saying which of the two a list holds.

That `subject` was added for an unrelated reason and turned out to be the
seam the entity layer needs is the second time this has happened here — the
first being `guards.test.ts` enforcing the liveness boundary of §4 before the
IA had named it.

### 6.2 Sort and filter run on the SERVER — **settled 2026-09-23**

Sort, filter and search become URL query parameters that the check's SQL
applies BEFORE its `LIMIT`.

The alternative — sorting in the browser — is not merely less capable, it is
wrong. These lists are capped in SQL, with a `count(*) OVER ()` carried
alongside precisely so the page can admit what the cap hid. Sorting the rows
that survived the cap by a different column yields the ranking *of that
capped population*, presented as if it were the ranking. "Top 50 by size,
re-sorted by vacuum age" is not "the 50 stalest tables", and nothing on the
page could tell the difference. That is the same class of lie `Findings`
already guards against in the line directly beneath every list.

Server-side buys three things besides correctness: the sort is in the URL, so
it is shareable and survives a poll; presets become free (§6.3); and it works
with JavaScript off.

Cost, stated: the check signatures gain sort and filter arguments, and each
sort is a round trip.

### 6.3 Named presets, not bare column headers — **settled 2026-09-23**

The Tables list carries a small strip of preset links above it — Biggest ·
Needs vacuum · Unused · Worst cache hit — each one a URL with sort and filter
parameters already applied.

This is what makes §5.1's collapse safe. Removing three pages in favour of a
sortable list would otherwise turn a one-click answer into "go to Tables,
find the column, click it, click it again for descending" — slower, during an
incident, than what it replaced. A preset keeps the single gesture, keeps the
answer shareable as a link, and still leaves one code path rendering the rows.

### 6.4 The rest — proposed

- **Column sorting** on every meaningful column, beside the presets, for the
  orderings no preset names.
- **Breadcrumbs**, because Explore has depth: `shop › Tables ›
  public.order_items`. Today `queries/indexes/bloat` and
  `queries/indexes/suggested` sit two levels deep with no trail at all.
- **One entity-link convention**, so a relation name looks and behaves the
  same on every page that renders one.
- **Charts** (raised separately, same session): axis intervals at round
  numbers rather than interpolated bounds; one shared time-range control that
  changes every chart on the page together, with a window that can be moved
  (last hour, today, yesterday); better labelling. See §7 of the P7d design
  for the rules the chart already holds — no library, gaps never drawn
  through, no range invented around a flat series.

## 7. Open — configuration from the UI

> "i want to be able to do config like adding new db from the frontend itself"

Not designed. The tension to resolve first, stated plainly so it is not
skipped:

Configuration today arrives from `PGOPS_DATABASES` / `PGOPS_CONFIG_FILE` and
the console never writes it. Adding a database from the UI means pgops
storing connection strings it can write — credentials at rest, in a tool that
holds broad access to production databases and already ships an actions flag
that is off by default. It also cuts against the project's promise to run no
DDL against a monitored database, if the store is where they land.

Questions before any design: where do credentials live (the store? a file the
container can write? a secret manager?); who may add one (there is basic auth
and nothing else); is this "add a database" or "test a connection string and
show me the command to add it"; and does an added database survive a restart
of a stateless container.

## 8. The first slice — **settled 2026-09-24**

**Tables list + Table page**, as one vertical slice:

1. The `relation` opt on the checks named in §5.3.
2. `Findings` gains sort, filter and search (§6.2, server-side) and renders
   its `subject` as a link (§6.1).
3. The Tables list absorbs `cleanup/space`, `cleanup/maintenance` and the
   unused half of `queries/tables`, with the presets of §6.3.
4. The Table page becomes the first destination that link points at.

Chosen over doing §6 everywhere first, which would fix sorting on all thirteen
lists but leave the first column linking to nothing; and over building entity
pages first, which would add depth while the lists stayed unsortable. The
slice is larger than either, and it is the only one of the three that proves
the whole pattern end to end.

## 9. Not yet designed

- Sequencing beyond the first slice (§9). No phase plan yet for what follows.
- How a query shape is linked to the relations it touches (§5.4). Wanted from
  both ends — the Table page and the Query shape page — and cheap only if it
  is allowed to be wrong.
- What the Now tab strip is exactly (Triage · Sessions · Locks · Replication
  is a proposal, not agreed).
- URL scheme for entity pages, and whether old URLs redirect.
- What happens to `/db/<name>/cleanup/*` routes and their tests.
