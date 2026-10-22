'use client';

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Axis, ClockLines, useClock } from '@/components/clock';
import { CLASS_BG } from '@/components/tree-rows';
import { CLASS_NAMES, CLASSES, clockTime, type Grid } from '@/lib/clock';
import type { Tie } from '@/lib/rows';
import { cn } from '@/lib/utils';

/** A row is exactly this tall: the ties are drawn from row numbers. */
const ROW_PX = 34;

/** The five classes, as the key of rows with no band above them to be one. Sits in a header row's time cell. */
function ClassKey() {
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

/** A waiter tied to the session it waits on, at the moment the wait began. Drawn over the time column. */
function Ties({ ties }: { ties: readonly Tie[] }): ReactNode {
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

/**
 * The grid the tree, a list of rows and the fleet stand on: a key row, the
 * rows with the ties over them, a foot with the axis, and the clock's lines.
 */
export function Frame({ role, label, wide = false, top, keyEnd, rows, rowCount, ties, empty, foot, grid }: {
  role: 'treegrid' | 'table';
  label: string;
  /** The wider label column RowsView uses. */
  wide?: boolean;
  /** Above the key row: the band, which is then the class key. */
  top?: ReactNode;
  /** The key row's right-hand text in the label cell. */
  keyEnd: string;
  rows: ReactNode;
  rowCount: number;
  ties?: readonly Tie[];
  /** Said in one row when `rowCount` is 0. Omitted: no row. */
  empty?: string;
  /** The foot's left text; null for none. The Axis is always drawn. */
  foot: string | null;
  grid: Pick<Grid, 'from' | 'to'>;
}): ReactNode {
  const clock = useClock();
  const keys = role === 'treegrid';
  const legend = top === undefined;
  return (
    <div
      role={role}
      tabIndex={keys ? 0 : undefined}
      onKeyDown={keys ? onTreeKey : undefined}
      onMouseDown={keys ? onTreeMouseDown : undefined}
      aria-label={label}
      className={cn('relative mb-4 overflow-hidden rounded-md border bg-card select-none', wide ? '[--lab:max(300px,46%)]' : '[--lab:max(240px,40%)]', 'max-md:[--lab:max(132px,42%)]')}
    >
      {top}
      {/* The class key wraps on a phone, so with no band above this row may grow; under the band it keeps its height. */}
      <div className={cn('grid grid-cols-[var(--lab)_minmax(0,1fr)] items-center text-xs text-muted-foreground', legend ? 'min-h-[26px]' : 'h-[26px] border-t')}>
        <div className="flex items-center px-2.5">
          <span suppressHydrationWarning className="max-md:hidden">at {clockTime(clock.at, clock.offset(clock.at))}</span>
          <span className="ml-auto">{keyEnd}</span>
        </div>
        {legend ? <ClassKey /> : <div className="self-stretch border-l" />}
      </div>
      <div className="relative">
        {rows}
        {rowCount === 0 && empty !== undefined ? (
          <div className="grid h-[34px] grid-cols-[var(--lab)_minmax(0,1fr)] items-center border-t">
            <div className="px-2.5 text-muted-foreground">{empty}</div>
            <div className="self-stretch border-l" />
          </div>
        ) : null}
        {ties === undefined ? null : (
          <div className="pointer-events-none absolute inset-y-0 right-0 left-(--lab)" style={{ height: rowCount * ROW_PX }}>
            <Ties ties={ties} />
          </div>
        )}
      </div>
      <div className="grid grid-cols-[var(--lab)_minmax(0,1fr)] items-center border-t">
        <div className="px-2.5 text-right text-xs text-muted-foreground">{foot}</div>
        <Axis grid={grid} offset={clock.offset} className="border-l" />
      </div>
      <ClockLines className="right-0 left-(--lab)" />
    </div>
  );
}

/**
 * The treegrid's keys. The arrows walk the rows, Home and End jump; right
 * opens a fold, left closes it or climbs to the row above it; Enter follows
 * the row's link. A key in a row's own control is the control's, and with no
 * row focused only the keys that reach one are taken: the rest step the clock.
 * A key with a modifier is the browser's, as it is the clock's.
 */
function onTreeKey(e: KeyboardEvent<HTMLDivElement>): void {
  const target = e.target as HTMLElement;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (target.matches('button, a, input, textarea')) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=row]')];
  const row = target.closest<HTMLElement>('[role=row]');
  const i = row === null ? -1 : rows.indexOf(row);
  if (i < 0 && !['ArrowDown', 'Home', 'End'].includes(e.key)) return;
  const fold = row?.querySelector<HTMLElement>('[role=rowheader] button[aria-expanded]');
  const level = Number(row?.getAttribute('aria-level') ?? 1);
  switch (e.key) {
    case 'ArrowDown': rows[Math.min(rows.length - 1, i + 1)]?.focus(); break;
    case 'ArrowUp': rows[Math.max(0, i - 1)]?.focus(); break;
    case 'Home': rows[0]?.focus(); break;
    case 'End': rows.at(-1)?.focus(); break;
    case 'ArrowRight': if (fold?.getAttribute('aria-expanded') === 'false') fold.click(); break;
    case 'ArrowLeft':
      if (fold?.getAttribute('aria-expanded') === 'true') fold.click();
      else rows.slice(0, i).reverse().find((r) => Number(r.getAttribute('aria-level') ?? 1) < level)?.focus();
      break;
    case 'Enter': row?.querySelector<HTMLElement>('[role=rowheader] a')?.click(); break;
    default: return;
  }
  e.preventDefault();
  e.stopPropagation();
}

/**
 * A click in the tree is for the clock: it pins, or drags a window. A row it
 * focused would keep the arrows, and a pinned page could not step, so the
 * click focuses nothing and lets go of whatever the keys had: a row, or the
 * find box, which the prevented default would otherwise leave focused. A
 * row's own controls take focus as usual.
 */
function onTreeMouseDown(e: MouseEvent<HTMLDivElement>): void {
  if ((e.target as HTMLElement).closest('button, a, input, textarea, select') !== null) return;
  e.preventDefault();
  const held = document.activeElement;
  if (held instanceof HTMLElement) held.blur();
}
