'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Axis, ClockLines, Readout, Track, useClock } from '@/components/clock';
import { EntityLink } from '@/components/entity-link';
import { KillButton } from '@/components/actions';
import {
  CLASS_BG, MoreRow, QuietRow, QuietTableRow, ROW_PX, SessionRow, StatementRow, StripSvg, TableRow, Ties, Unseen, reading,
  type RowContext,
} from '@/components/tree-rows';
import { CLASS_NAMES, CLASSES, clockTime, columnAt, EVENT_NAMES, fractionAt, keepQuery, toggled, windowQuery } from '@/lib/clock';
import { formatDuration } from '@/lib/format';
import { flatten, listRows, readingAt, tiesOf, type Show } from '@/lib/rows';
import { FOLD_NONE, FOLD_QUIET, NONE, UNSEEN, findingsAt, scaleSteps, unseenAt, type Pointer, type Ranked, type Tree } from '@/lib/tree';
import { cn } from '@/lib/utils';

/**
 * The tree on the clock: the answer, the band, then the rows.
 *
 * Everything here is drawn from `tree`, which holds the whole window, so the
 * cursor moves without a round trip. The folds are the URL's: opening one
 * asks the server for that table's statements.
 */
export function TreeView({ database, tree, find, pointers, catalog, grant, kept, storeFailed, actions }: {
  database: string;
  tree: Tree;
  find: string;
  /** What a Server read or the catalog judged, at live. Each points at the page that holds the reading. */
  pointers: readonly Pointer[];
  /** When the catalog behind the quiet tables and the tags was read, and why it could not be. */
  catalog: { at: number | null; failed: string | null };
  /** The statement that lets this role see other sessions. Built on the server: this file may not spell it. */
  grant: string;
  /** 'memory': no store, so the clock holds fifteen minutes. */
  kept: 'store' | 'memory';
  /** Why the store did not answer, when memory is standing in for it. */
  storeFailed: string | null;
  /** Whether this console may terminate. */
  actions: boolean;
}) {
  const clock = useClock();
  const router = useRouter();
  const rows = useMemo(() => flatten(tree), [tree]);
  const ties = useMemo(() => tiesOf(rows, tree), [rows, tree]);
  const ranked = findingsAt(tree, clock.at);
  const ctx: RowContext = {
    database, from: tree.from, to: tree.to, scale: tree.scale,
    at: clock.at, col: columnAt(tree, clock.at), canAct: actions && clock.live, offset: clock.offset,
    blocked: new Set(ranked.filter((r) => r.finding.kind === 'chain').map((r) => r.finding.table)), seen: tree.seen,
  };
  const nothingSampled = tree.seen.every((k) => k < UNSEEN);

  const openNow = [
    ...tree.tables.filter((t) => t.open).map((t) => t.name),
    ...(tree.none?.open ? [FOLD_NONE] : []),
    ...(tree.quietOpen ? [FOLD_QUIET] : []),
  ];
  const here = windowQuery(clock.grid.winSecs, clock.grid.live ? null : clock.grid.to);
  const fold = (key: string): void => {
    router.replace(`${here}${keepQuery(find, toggled(openNow, key))}`, { scroll: false });
  };
  /** A pid in the answer, as a link to its row: the fold it sits under opened, so the row is there to land on. */
  const pidHref = (table: string, pid: number): string => {
    const key = table === NONE ? FOLD_NONE : table;
    return `${here}${keepQuery(find, openNow.includes(key) ? openNow : [...openNow, key])}#pid-${pid}`;
  };

  // An empty database still has a server under it: its findings are not the tree's to hide.
  if (tree.empty) {
    return (
      <>
        {clock.live && pointers.length > 0 ? <Answer database={database} ranked={[]} pointers={pointers} ctx={ctx} pidHref={pidHref} /> : null}
        <p className="my-3 rounded-md border bg-card px-3.5 py-2.5 text-muted-foreground">This database has no tables and no sessions.</p>
      </>
    );
  }

  const seenPids = new Set<number>();
  return (
    <>
      <Answer database={database} ranked={ranked} pointers={clock.live ? pointers : []} ctx={ctx} pidHref={pidHref} />
      <div
        role="treegrid"
        aria-label={`${database}: tables, statements and sessions`}
        className="relative mb-4 overflow-hidden rounded-md border bg-card select-none [--lab:max(240px,40%)] max-md:[--lab:max(132px,42%)]"
      >
        <Band tree={tree} ctx={ctx} />
        <div className="grid h-[26px] grid-cols-[var(--lab)_minmax(0,1fr)] items-center border-t text-xs text-muted-foreground">
          <div className="flex items-center px-2.5">
            <span suppressHydrationWarning className="max-md:hidden">at {clockTime(clock.at, clock.offset(clock.at))}</span>
            <span className="ml-auto">sessions not idle</span>
          </div>
          <div className="self-stretch border-l" />
        </div>
        <div className="relative">
          {rows.map((r) => {
            if (r.kind === 'table') return <TableRow key={r.id} table={r.table} none={r.none} ctx={ctx} onFold={() => fold(r.none ? FOLD_NONE : r.table.name)} />;
            if (r.kind === 'statement') return <StatementRow key={r.id} statement={r.statement} table={r.table} ctx={ctx} />;
            if (r.kind === 'session') {
              const first = !seenPids.has(r.session.pid);
              seenPids.add(r.session.pid);
              return <SessionRow key={r.id} session={r.session} first={first} ctx={ctx} />;
            }
            if (r.kind === 'more') return <MoreRow key={r.id} level={r.level} count={r.count} what={r.what} statement={r.statement} ctx={ctx} />;
            if (r.kind === 'quiet') return <QuietRow key={r.id} count={r.count} open={r.open} onFold={() => fold(FOLD_QUIET)} />;
            return <QuietTableRow key={r.id} fact={r.fact} ctx={ctx} />;
          })}
          {rows.length === 0 ? (
            <div className="grid h-[34px] grid-cols-[var(--lab)_minmax(0,1fr)] items-center border-t">
              <div className="px-2.5 text-muted-foreground">
                {find !== '' ? `nothing named “${find}”` : nothingSampled ? 'nothing was sampled in this window' : 'nothing ran in this window'}
              </div>
              <div className="self-stretch border-l" />
            </div>
          ) : null}
          <div className="pointer-events-none absolute inset-y-0 right-0 left-(--lab)" style={{ height: rows.length * ROW_PX }}>
            <Ties ties={ties} />
          </div>
        </div>
        <div className="grid grid-cols-[var(--lab)_minmax(0,1fr)] items-center border-t">
          <div className="px-2.5 text-right text-xs text-muted-foreground">
            each row 0 – {tree.scale} · sampled every 15 s
          </div>
          <Axis grid={tree} offset={clock.offset} className="border-l" />
        </div>
        <ClockLines className="right-0 left-(--lab)" />
      </div>
      {tree.hidden ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <i aria-hidden className="size-2 flex-none rounded-full shadow-[inset_0_0_0_1.5px_var(--muted-foreground)]" />
          Other roles’ sessions are hidden from this role. <code className="font-mono text-body">{grant}</code>
        </p>
      ) : null}
      {tree.truncated ? <p className="text-xs text-muted-foreground">Only the first 500 sessions were read.</p> : null}
      {catalog.failed === null ? null : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <i aria-hidden className="size-2 flex-none rounded-full shadow-[inset_0_0_0_1.5px_var(--muted-foreground)]" />
          The catalog could not be read: {catalog.failed}
        </p>
      )}
      {catalog.at === null ? null : (
        <p suppressHydrationWarning className="text-xs text-muted-foreground">
          tables as of {clockTime(catalog.at, clock.offset(catalog.at))}
        </p>
      )}
      {storeFailed !== null ? (
        <p className="text-xs text-muted-foreground">The store is not answering, so the clock holds this process’s last 15 minutes: {storeFailed}</p>
      ) : kept === 'memory' && (!tree.live || tree.to - tree.from > 15 * 60_000) ? (
        <p className="text-xs text-muted-foreground">No store is configured, so the clock holds the last 15 minutes.</p>
      ) : null}
      <Readout />
    </>
  );
}

/** Every finding at the cursor, worst first. The first is the loudest thing on the page. */
function Answer({ database, ranked, pointers, ctx, pidHref }: {
  database: string; ranked: readonly Ranked[]; pointers: readonly Pointer[]; ctx: RowContext;
  pidHref: (table: string, pid: number) => string;
}) {
  const worstFirst = [...pointers].sort((a, b) => Number(b.level === 'critical') - Number(a.level === 'critical'));
  if (ranked.length === 0 && worstFirst.length === 0) {
    // Where nobody looked, nothing can be said to be fine.
    return (
      <p suppressHydrationWarning className="my-3 rounded-md border bg-card px-3.5 py-2.5 text-muted-foreground">
        {unseenAt(ctx.seen, ctx.col) ? 'not sampled at' : 'nothing needs attention at'} {clockTime(ctx.at, ctx.offset(ctx.at))}
      </p>
    );
  }
  const line = 'flex flex-wrap items-center gap-2.5 border-t border-warning-ink/25 py-2.5 first:border-t-0 first:py-2.5 first:text-sm';
  const where = (table: string) => (table === NONE
    ? null
    : <> on <EntityLink database={database} name={table} className="font-mono font-semibold hover:underline" /></>);
  return (
    <div role="status" className="relative my-3 rounded-md border border-l-[3px] border-l-warning-ink bg-warning-surface px-3.5 text-foreground">
      {ranked.map(({ finding: f, waiting, secs }) => (
        <div key={f.id} className={line} data-level={f.kind}>
          {f.kind === 'idle' ? (
            <span><Link href={pidHref(f.table, f.pid!)} className="font-mono font-semibold hover:underline">{f.pid}</Link> idle in transaction{where(f.table)}</span>
          ) : f.pid === null ? (
            <span suppressHydrationWarning>
              lock chain{where(f.table)} · {clockTime(f.from, ctx.offset(f.from))} – {clockTime(f.to, ctx.offset(f.to))}
            </span>
          ) : (
            <span>
              <Link href={pidHref(f.table, f.pid)} className="font-mono font-semibold hover:underline">{f.pid}</Link> blocks {waiting}{where(f.table)}
            </span>
          )}
          {f.pid === null ? null : <span className="font-mono tabular-nums">{formatDuration(secs)}</span>}
          {/* A root the sample does not hold (another role's, an autovacuum worker, a prepared
              transaction) has no identity to guard a terminate with, so none is offered. Not
              positioned: its confirm is placed against the answer, wide enough on a phone. */}
          {ctx.canAct && f.pid !== null && f.backendStart !== null ? (
            <span className="ml-auto"><KillButton prominent database={database} pid={f.pid} backendStart={f.backendStart} /></span>
          ) : null}
        </div>
      ))}
      {worstFirst.map((s) => (
        <div key={`${s.label}/${s.note}`} className={line}>
          <span>{s.label} <b className="font-mono font-semibold">{s.note}</b></span>
          <Link href={s.href} className="ml-auto text-[13px] text-muted-foreground hover:text-foreground hover:underline">where ›</Link>
        </div>
      ))}
    </div>
  );
}

/** What the database is doing: sessions not idle, split by class, with the events on it. */
function Band({ tree, ctx }: { tree: Tree; ctx: RowContext }) {
  const now = readingAt(tree.band, ctx.col);
  const unseen = unseenAt(tree.seen, ctx.col);
  const steps = scaleSteps(tree.band.reduce((m, c) => Math.max(m, c[0]! + c[1]! + c[2]! + c[3]! + c[4]!), 0) * 1.05);
  const top = steps.at(-1)!;
  const marks = tree.events.filter((e) => EVENT_NAMES[e.kind] !== undefined);
  return (
    <div className="grid grid-cols-[var(--lab)_minmax(0,1fr)] items-stretch">
      <div className="flex min-w-0 flex-col px-2.5 py-2 pr-[30px]">
        <span className="font-mono text-[22px]/7 font-medium text-foreground tabular-nums">
          {unseen ? '—' : now.total.toFixed(1)}<small className="ml-1.5 font-sans text-xs/4 font-normal text-muted-foreground">{unseen ? 'not sampled' : 'sessions not idle'}</small>
        </span>
        <span className="mb-1.5 text-xs/4 text-muted-foreground max-md:hidden">connections busy at once, by what they were doing</span>
        {[...CLASSES].reverse().map((c) => (
          <div key={c} className="flex items-center gap-[7px] text-xs/[18px]">
            <i aria-hidden className={cn('size-2 flex-none rounded-xs', CLASS_BG[c])} />{CLASS_NAMES[c]}
            <b className="ml-auto font-mono font-normal text-foreground tabular-nums">{unseen ? '—' : now.byClass[CLASSES.indexOf(c)]!.toFixed(1)}</b>
          </div>
        ))}
      </div>
      <div className="relative min-w-0">
        <Track
          className="aspect-[2.8/1] max-h-[280px] min-h-40 w-full border-l"
          tip={(t) => {
            const c = Math.max(0, Math.min(tree.columns - 1, Math.floor(fractionAt(tree, t) * tree.columns)));
            return reading(null, tree.band, c, unseenAt(tree.seen, c));
          }}
        >
          <Unseen seen={tree.seen} />
          {steps.slice(1).map((v) => (
            <i key={v} aria-hidden className="absolute inset-x-0 border-t border-border" style={{ bottom: `${(v / top) * 100}%` }}>
              <span className="absolute -top-2 left-1 rounded-xs bg-card px-0.5 font-mono text-xs/4 text-body">{v}</span>
            </i>
          ))}
          <StripSvg strip={tree.band} scale={top} floor={0} className="absolute inset-0" />
          {marks.map((e) => (
            <i
              key={`${e.at}/${e.kind}/${e.relation}`}
              aria-hidden
              className="absolute inset-y-0 border-l border-dashed border-foreground"
              style={{ left: `${Math.max(0, Math.min(1, fractionAt(tree, e.at))) * 100}%` }}
            >
              <span className="absolute top-0 left-1 rounded-xs bg-card px-0.5 text-xs/4 whitespace-nowrap text-foreground">
                {EVENT_NAMES[e.kind]}{e.relation === '' ? '' : ` ${e.relation.replace(/^public\./, '')}`}
              </span>
            </i>
          ))}
        </Track>
        <BandTable tree={tree} offset={ctx.offset} />
      </div>
    </div>
  );
}

/** The band as numbers, for a reader who cannot use the plot. */
function BandTable({ tree, offset }: { tree: Tree; offset: (t: number) => number }) {
  const width = (tree.to - tree.from) / tree.columns;
  return (
    <table className="sr-only">
      <caption>Sessions not idle, by class</caption>
      <thead><tr><th>Time</th><th>Total</th>{CLASSES.map((c) => <th key={c}>{CLASS_NAMES[c]}</th>)}</tr></thead>
      <tbody>
        {tree.band.map((col, i) => (
          <tr key={i}>
            <th suppressHydrationWarning>{clockTime(tree.from + i * width, offset(tree.from + i * width))}</th>
            {unseenAt(tree.seen, i)
              ? <td colSpan={CLASSES.length + 1}>not sampled</td>
              : <><td>{readingAt(tree.band, i).total.toFixed(1)}</td>{col.map((v, j) => <td key={CLASSES[j]}>{v.toFixed(1)}</td>)}</>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Rows with no band above them: a population's statements, one table's
 * statements and sessions, or one statement's sessions. The tree's own row
 * components, under a key row, on the same clock and the same row scale.
 */
export function RowsView({ database, tree, show, actions, moreHref }: {
  database: string;
  tree: Tree;
  show: Show;
  actions: boolean;
  /** Where "+ N more statements" leads: the fold that shows them. */
  moreHref?: string;
}) {
  const clock = useClock();
  const rows = useMemo(() => listRows(tree, show), [tree, show]);
  const ties = useMemo(() => tiesOf(rows, tree), [rows, tree]);
  const ranked = findingsAt(tree, clock.at);
  const ctx: RowContext = {
    database, from: tree.from, to: tree.to, scale: tree.scale,
    at: clock.at, col: columnAt(tree, clock.at), canAct: actions && clock.live, offset: clock.offset,
    blocked: new Set(ranked.filter((r) => r.finding.kind === 'chain').map((r) => r.finding.table)), seen: tree.seen,
  };
  const sessionsOnly = show.kind === 'sessions';
  const seenPids = new Set<number>();
  return (
    <>
      <div
        role="treegrid"
        aria-label={sessionsOnly ? 'Sessions' : 'Statements and sessions'}
        className="relative mb-4 overflow-hidden rounded-md border bg-card select-none [--lab:max(300px,46%)] max-md:[--lab:max(132px,42%)]"
      >
        {/* No band stands above these rows, so this row is their key. */}
        <div className="grid min-h-[26px] grid-cols-[var(--lab)_minmax(0,1fr)] items-center text-xs text-muted-foreground">
          <div className="flex items-center px-2.5">
            <span suppressHydrationWarning className="max-md:hidden">at {clockTime(clock.at, clock.offset(clock.at))}</span>
            <span className="ml-auto">{sessionsOnly ? 'in this state for' : 'sessions not idle'}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 self-stretch border-l px-2.5">
            {CLASSES.map((c) => (
              <span key={c} className="flex items-center gap-1.5">
                <i aria-hidden className={cn('size-2 rounded-xs', CLASS_BG[c])} />{CLASS_NAMES[c]}
              </span>
            ))}
          </div>
        </div>
        <div className="relative">
          {rows.map((r) => {
            if (r.kind === 'statement') return <StatementRow key={r.id} statement={r.statement} table={r.table} level={r.level} ctx={ctx} />;
            if (r.kind === 'session') {
              const first = !seenPids.has(r.session.pid);
              seenPids.add(r.session.pid);
              return <SessionRow key={r.id} session={r.session} first={first} level={r.level} ctx={ctx} />;
            }
            if (r.kind === 'more') {
              return <MoreRow key={r.id} level={r.level} count={r.count} what={r.what} statement={r.statement} ctx={ctx} href={r.what === 'statements' ? moreHref : undefined} />;
            }
            return null;
          })}
          {rows.length === 0 ? (
            <div className="grid h-[34px] grid-cols-[var(--lab)_minmax(0,1fr)] items-center border-t">
              <div className="px-2.5 text-muted-foreground">
                {!tree.sessionsShown && sessionsOnly ? 'a window wider than two hours lists no sessions'
                  : tree.seen.every((k) => k < UNSEEN) ? 'nothing was sampled in this window' : 'nothing in this window'}
              </div>
              <div className="self-stretch border-l" />
            </div>
          ) : null}
          <div className="pointer-events-none absolute inset-y-0 right-0 left-(--lab)" style={{ height: rows.length * ROW_PX }}>
            <Ties ties={ties} />
          </div>
        </div>
        <div className="grid grid-cols-[var(--lab)_minmax(0,1fr)] items-center border-t">
          <div className="px-2.5 text-right text-xs text-muted-foreground">{sessionsOnly ? null : `each row 0 – ${tree.scale}`}</div>
          <Axis grid={tree} offset={clock.offset} className="border-l" />
        </div>
        <ClockLines className="right-0 left-(--lab)" />
      </div>
      <Readout />
    </>
  );
}
