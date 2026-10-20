'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Track } from '@/components/clock';
import { EntityLink } from '@/components/entity-link';
import { KillButton } from '@/components/actions';
import { CLASS_NAMES, CLASS_STATES, CLASSES, clockTime, fractionAt } from '@/lib/clock';
import { formatBytes, formatCount, formatDuration, formatMillis, formatRate } from '@/lib/format';
import { readingAt, stripPaths, type Tie } from '@/lib/rows';
import { unseenAt, type SessionNode, type Span, type StatementNode, type Strip, type TableFact, type TableNode } from '@/lib/tree';
import { cn } from '@/lib/utils';

/** A readout's number: right-aligned in a fixed width, so a column of them lines up. */
export const NUM = 'mr-1.5 inline-block min-w-10 text-right font-mono';

/** A row is exactly this tall: the ties are drawn from row numbers. */
export const ROW_PX = 34;

/** What every row reads the same: where it is, when, and whether there is anything to act on. */
export interface RowContext {
  database: string;
  from: number;
  to: number;
  /** The row scale. */
  scale: number;
  /** The moment the page shows, and the column it falls in. */
  at: number;
  col: number;
  /** Tables a chain is on at this moment, from the same findings the answer reads. */
  blocked: ReadonlySet<string>;
  /** How much of each column some sample covered: the tree's `seen`. */
  seen: readonly number[];
  /** A live page with no cursor, on a console with actions enabled. */
  canAct: boolean;
  offset: (t: number) => number;
}

export const CLASS_FILL: Record<(typeof CLASSES)[number], string> = {
  cpu: 'fill-class-cpu', io: 'fill-class-io', idle: 'fill-class-idle', other: 'fill-class-other', lock: 'fill-class-lock',
};
export const CLASS_BG: Record<(typeof CLASSES)[number], string> = {
  cpu: 'bg-class-cpu', io: 'bg-class-io', idle: 'bg-class-idle', other: 'bg-class-other', lock: 'bg-class-lock',
};

const ROW = 'grid h-[34px] grid-cols-[var(--lab)_minmax(0,1fr)] items-center border-t focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset';
const LABEL = 'flex min-w-0 items-center gap-[7px] self-stretch px-2.5 whitespace-nowrap';
const LEVEL = ['', 'pl-[30px] max-md:pl-4', 'pl-12 max-md:pl-6'] as const;
/** The label cell as the row's one link. */
const GO = 'group -mx-2.5 flex min-w-0 flex-1 items-center gap-[7px] self-stretch px-2.5 hover:bg-muted hover:text-foreground';
const CHEVRON = 'ml-1.5 text-[15px] text-muted-foreground opacity-0 group-hover:opacity-100 max-md:hidden';
const END = 'ml-auto flex flex-none items-center gap-2 font-mono text-xs text-foreground tabular-nums';
const QUIET = 'text-muted-foreground';
const TAG = 'flex-none rounded-[3px] px-1.5 text-[11px]/4 text-warning-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning-ink)_35%,transparent)] max-md:hidden';
const CARET = 'w-3.5 flex-none p-0 text-[11px] text-muted-foreground';
const TRACK = 'h-[34px] border-l py-[3px]';

/** The five classes, as the key of rows with no band above them to be one. Sits in a header row's time cell. */
export function ClassKey() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 self-stretch border-l px-2.5">
      {CLASSES.map((c) => (
        <span key={c} className="flex items-center gap-1.5">
          <i aria-hidden className={cn('size-2 rounded-xs', CLASS_BG[c])} />{CLASS_NAMES[c]}
        </span>
      ))}
    </div>
  );
}

/** The stretches nobody sampled, hatched over a strip or a panel. */
export function Unseen({ seen }: { seen: readonly number[] }) {
  const runs: [number, number][] = [];
  seen.forEach((_, c) => {
    if (!unseenAt(seen, c)) return;
    const last = runs.at(-1);
    if (last !== undefined && last[1] === c) last[1] = c + 1;
    else runs.push([c, c + 1]);
  });
  return (
    <>
      {runs.map(([a, b]) => (
        <i
          key={a}
          data-unseen
          aria-hidden
          className="pointer-events-none absolute inset-y-0 bg-[repeating-linear-gradient(135deg,var(--border)_0_1px,transparent_1px_6px)]"
          style={{ left: `${(a / seen.length) * 100}%`, width: `${((b - a) / seen.length) * 100}%` }}
        />
      ))}
    </>
  );
}

/** One node's load on the clock: stacked columns by class, on the row scale. */
export function StripSvg({ strip, scale, floor, className }: { strip: Strip; scale: number; floor?: number; className?: string }) {
  if (strip.length === 0) return null;
  return (
    <svg aria-hidden viewBox={`0 0 ${strip.length} 100`} preserveAspectRatio="none" className={cn('block size-full', className)}>
      {stripPaths(strip, scale, floor).map((d, i) => (d === '' ? null : <path key={CLASSES[i]} d={d} className={CLASS_FILL[CLASSES[i]!]} />))}
    </svg>
  );
}

/** What a strip reads at a moment, for the hover readout. */
export function reading(name: ReactNode, strip: Strip, col: number, unseen = false): ReactNode {
  if (unseen) return <>{' '}{name}<br />not sampled</>;
  const r = readingAt(strip, col);
  return (
    <>
      {' '}{name}
      <br /><b className={NUM}>{r.total.toFixed(1)}</b>sessions not idle
      {CLASSES.map((c, i) => (r.byClass[i]! > 0.05 ? (
        <span key={c}>
          <br /><b className={NUM}>{r.byClass[i]!.toFixed(1)}</b>
          <i className={cn('mr-1.5 inline-block size-2 rounded-xs align-middle', CLASS_BG[c])} />{CLASS_NAMES[c]}
        </span>
      ) : null))}
    </>
  );
}

const columnOf = (ctx: RowContext, strip: Strip, t: number): number =>
  Math.max(0, Math.min(strip.length - 1, Math.floor(fractionAt(ctx, t) * strip.length)));

export function TableRow({ table, none, ctx, onFold }: { table: TableNode; none: boolean; ctx: RowContext; onFold: () => void }) {
  const now = readingAt(table.strip, ctx.col);
  const name = none ? 'not on any table' : table.name;
  // The chain first: it is the one a reader is here for. Two at most.
  const tags = [...(ctx.blocked.has(table.name) ? ['blocked'] : []), ...table.flags].slice(0, 2);
  const inner = (
    <>
      <span className={cn('truncate', none ? QUIET : 'font-mono text-[13px] font-semibold text-foreground')}>{name}</span>
      {tags.map((t) => <span key={t} className={TAG}>{t}</span>)}
      <span className={END}>
        {!table.open && table.shapes > 0 ? <span className={cn(QUIET, 'font-sans max-md:hidden')}>{formatCount(table.shapes)} {table.shapes === 1 ? 'statement' : 'statements'}</span> : null}
        {unseenAt(ctx.seen, ctx.col) ? '—' : now.total.toFixed(1)}
      </span>
      {none ? null : <span aria-hidden className={CHEVRON}>›</span>}
    </>
  );
  return (
    <div role="row" tabIndex={-1} aria-level={1} className={cn(ROW, 'bg-muted/50')}>
      <div role="rowheader" className={LABEL}>
        <button type="button" className={CARET} aria-expanded={table.open} aria-label={`Fold ${name}`} onClick={onFold}>
          {table.open ? '▾' : '▸'}
        </button>
        {none
          ? <span className="flex min-w-0 flex-1 items-center gap-[7px]">{inner}</span>
          : <EntityLink database={ctx.database} name={table.name} className={GO}>{inner}</EntityLink>}
      </div>
      <Track className={TRACK} tip={(t) => { const c = columnOf(ctx, table.strip, t); return reading(name, table.strip, c, unseenAt(ctx.seen, c)); }}>
        <StripSvg strip={table.strip} scale={ctx.scale} />
      </Track>
    </div>
  );
}

/** A statement the old statement page can show: one pg_stat_statements knows by id. */
const hasPage = (key: string): boolean => /^-?\d+$/.test(key);

export function StatementRow({ statement, table, level = 1, ctx }: {
  statement: StatementNode;
  /** The table it is listed under; null on a flat list. */
  table: string | null;
  level?: 0 | 1;
  ctx: RowContext;
}) {
  const elsewhere = statement.tables.filter((t) => t !== table && t !== '');
  // Under a table the row says how many others it is on; on a flat list it says which.
  const where = table !== null
    ? (elsewhere.length === 0 ? null : `+${elsewhere.length} ${elsewhere.length === 1 ? 'table' : 'tables'}`)
    : (elsewhere.length === 0 ? null : `${elsewhere[0]!.replace(/^public\./, '')}${elsewhere.length > 1 ? ` +${elsewhere.length - 1}` : ''}`);
  const inner = (
    <>
      {/* Redacted on the server before it was handed to this component. */}
      <span className={cn('truncate font-mono text-xs/5', statement.text === null && QUIET)}>
        {statement.text ?? 'statement not visible to this role'}
      </span>
      {statement.unplaced ? <span className={TAG}>not placed</span> : null}
      <span className={END}>
        {where === null ? null : <span className={cn(QUIET, 'font-sans max-md:hidden')}>{where}</span>}
        {statement.callsPerSec === null || statement.meanMs === null ? null : (
          <span className={cn(QUIET, 'font-sans max-md:hidden')}>
            {formatRate(statement.callsPerSec)} calls/s · {formatMillis(statement.meanMs)} each
          </span>
        )}
        {unseenAt(ctx.seen, ctx.col) ? '—' : readingAt(statement.strip, ctx.col).total.toFixed(1)}
      </span>
      {hasPage(statement.key) ? <span aria-hidden className={CHEVRON}>›</span> : null}
    </>
  );
  return (
    <div role="row" tabIndex={-1} aria-level={level + 1} className={ROW}>
      <div role="rowheader" className={cn(LABEL, LEVEL[level])}>
        {hasPage(statement.key)
          ? <Link href={`/db/${ctx.database}/queries/${encodeURIComponent(statement.key)}`} className={GO}>{inner}</Link>
          : <span className="flex min-w-0 flex-1 items-center gap-[7px]">{inner}</span>}
      </div>
      <Track className={TRACK} tip={(t) => { const c = columnOf(ctx, statement.strip, t); return reading(null, statement.strip, c, unseenAt(ctx.seen, c)); }}>
        <StripSvg strip={statement.strip} scale={ctx.scale} />
      </Track>
    </div>
  );
}

const spanAt = (spans: readonly Span[], t: number): Span | undefined => spans.find((p) => p.from <= t && t < p.to);

export function SessionRow({ session, first, level = 2, ctx }: {
  session: SessionNode;
  /** The first row this pid has on the page: the one `#pid-N` lands on. */
  first: boolean;
  level?: 0 | 1 | 2;
  ctx: RowContext;
}) {
  const now = spanAt(session.spans, ctx.at);
  const waiting = now?.cls === 'lock' && now.blockedBy !== null;
  return (
    <div
      role="row" tabIndex={-1}
      aria-level={level + 1}
      id={first ? `pid-${session.pid}` : undefined}
      className={cn(ROW, 'scroll-mt-28 target:bg-warning-surface', now === undefined && '[&>[role=rowheader]>*]:opacity-40')}
    >
      <div role="rowheader" className={cn(LABEL, LEVEL[level], 'relative')}>
        {/* Clipped sideways on a phone, where the cell is narrower than its contents and what
            overflowed would sit under the strip, where a tap pins the clock instead. Terminate
            comes first so the duration is what is cut. Not positioned, so the confirm, placed
            against the cell, is not clipped with it. */}
        <span data-clip className="flex min-w-0 flex-1 items-center gap-[7px] max-sm:overflow-x-clip">
          <span className="font-mono text-foreground">{session.pid}</span>
          <span className={cn(QUIET, 'truncate max-md:hidden')}>{session.app}</span>
          <span className={END}>
            {/* Never on a waiter: terminating one frees nothing. */}
            {ctx.canAct && now !== undefined && !waiting
              ? <KillButton database={ctx.database} pid={session.pid} backendStart={session.backendStart} />
              : null}
            {now === undefined ? null : (
              <>
                <i aria-hidden className={cn('size-2 flex-none rounded-xs', CLASS_BG[now.cls])} />
                <span className={cn(QUIET, 'font-sans max-md:hidden')}>{CLASS_STATES[now.cls]}</span>
                {formatDuration((ctx.at - now.from) / 1000)}
              </>
            )}
          </span>
        </span>
      </div>
      <Track
        className={TRACK}
        tip={(t) => {
          const p = spanAt(session.spans, t);
          return (
            <>
              {' '}{session.pid} {session.app}<br />
              {p === undefined ? 'idle' : (
                <>
                  <i className={cn('mr-1.5 inline-block size-2 rounded-xs align-middle', CLASS_BG[p.cls])} />
                  {CLASS_NAMES[p.cls]} since {clockTime(p.from, ctx.offset(p.from))} · {formatDuration((t - p.from) / 1000)}
                  {p.blockedBy === null ? null : <><br />behind {p.blockedBy}</>}
                </>
              )}
            </>
          );
        }}
      >
        {session.spans.filter((p) => p.to > ctx.from && p.from < ctx.to).map((p) => {
          const left = Math.max(0, fractionAt(ctx, p.from));
          const right = Math.min(1, fractionAt(ctx, p.to));
          return (
            <i
              key={`${p.from}/${p.cls}`}
              className={cn('absolute top-3 h-2.5 min-w-0.5 rounded-xs', CLASS_BG[p.cls])}
              style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
            />
          );
        })}
      </Track>
    </div>
  );
}

/**
 * What a list was cut at. The rest of a statement's sessions are on its own
 * page, when it has one; `href` is where the rest of a list is, when it has
 * a fold that opens it.
 */
export function MoreRow({ level, count, what, statement, ctx, href }: {
  level: 0 | 1 | 2; count: number; what: 'tables' | 'statements' | 'sessions'; statement: string | null; ctx: RowContext; href?: string;
}) {
  const text = `+ ${formatCount(count)} more${what === 'sessions' ? '' : ` ${what}`}`;
  return (
    <div role="row" tabIndex={-1} aria-level={level + 1} className={ROW}>
      <div role="rowheader" className={cn(LABEL, LEVEL[level], QUIET)}>
        {href !== undefined
          ? <Link href={href} className={GO}>{text}</Link>
          : what === 'sessions' && statement !== null && hasPage(statement)
            ? <Link href={`/db/${ctx.database}/queries/${encodeURIComponent(statement)}`} className={GO}>{text}</Link>
            : text}
      </div>
      <div className={cn(TRACK, 'cursor-default')} />
    </div>
  );
}

export function QuietRow({ count, open, onFold }: { count: number; open: boolean; onFold: () => void }) {
  return (
    <div role="row" tabIndex={-1} aria-level={1} className={ROW}>
      <div role="rowheader" className={cn(LABEL, QUIET)}>
        <button type="button" className={CARET} aria-expanded={open} aria-label="Fold quiet tables" onClick={onFold}>
          {open ? '▾' : '▸'}
        </button>
        {formatCount(count)} quiet {count === 1 ? 'table' : 'tables'}
      </div>
      <div className={cn(TRACK, 'cursor-default')} />
    </div>
  );
}

export function QuietTableRow({ fact, ctx }: { fact: TableFact; ctx: RowContext }) {
  return (
    <div role="row" tabIndex={-1} aria-level={2} className={ROW}>
      <div role="rowheader" className={cn(LABEL, 'pl-[31px] max-md:pl-4')}>
        <EntityLink database={ctx.database} name={fact.name} className={GO}>
          <span className="truncate font-mono text-[13px] text-body">{fact.name}</span>
          {fact.flags.slice(0, 2).map((t) => <span key={t} className={TAG}>{t}</span>)}
          <span className={cn(END, QUIET)}>{formatCount(fact.liveRows)} rows · {formatBytes(fact.sizeBytes)}</span>
          <span aria-hidden className={CHEVRON}>›</span>
        </EntityLink>
      </div>
      <div className={cn(TRACK, 'cursor-default')} />
    </div>
  );
}

/** A waiter tied to the session it waits on, at the moment the wait began. Drawn over the time column. */
export function Ties({ ties }: { ties: readonly Tie[] }): ReactNode {
  return ties.map((t) => {
    const up = t.to < t.from;
    const y1 = t.from * ROW_PX + ROW_PX / 2;
    const y2 = t.to * ROW_PX + ROW_PX / 2 + (up ? 7 : -7);
    return (
      <div
        key={`${t.from}-${t.to}`}
        data-tie
        aria-hidden
        className="pointer-events-none absolute w-0"
        style={{ left: `${t.at * 100}%`, top: Math.min(y1, y2), height: Math.abs(y1 - y2) }}
      >
        <i className="absolute inset-y-0 -left-px w-[1.5px] bg-foreground" />
        <i className={cn('absolute -left-[3px] size-1.5 rounded-full bg-foreground', up ? '-bottom-[3px]' : '-top-[3px]')} />
        <i className={cn(
          'absolute -left-1 size-0 border-x-4 border-x-transparent',
          up ? 'top-0 border-b-[6px] border-b-foreground' : 'bottom-0 border-t-[6px] border-t-foreground',
        )} />
      </div>
    );
  });
}
