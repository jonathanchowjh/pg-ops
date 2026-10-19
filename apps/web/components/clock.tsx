'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import type { StoredEvent } from '@pgops/checks';
import {
  BUCKET_MS, DAY_MS, WINDOWS, axisTicks, clockTime, endShowing, fractionAt, hop, stamp, step, timeAt,
  windowQuery, zoomTo, type Grid,
} from '@/lib/clock';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The clock: one window and one cursor for everything under it.
 *
 * The window is the URL's and arrives as `grid`. The cursor is state here,
 * so pinning a moment, stepping and selecting never ask the server for
 * anything; only a change of window does.
 */
export interface ClockState {
  grid: Grid;
  /** The pinned moment, or null when the page follows the window's end. */
  cursor: number | null;
  /** The moment the page shows: the cursor, or just inside the window's end. */
  at: number;
  /** A live window with no cursor: the only state with actions on it. */
  live: boolean;
  selection: readonly [number, number] | null;
  /** Minutes east of UTC at `t`, for `clockTime`. */
  offset: (t: number) => number;
  pin: (t: number | null) => void;
  select: (range: readonly [number, number] | null) => void;
}

const ClockContext = createContext<ClockState | null>(null);

export function useClock(): ClockState {
  const clock = useContext(ClockContext);
  if (clock === null) throw new Error('useClock outside <Clock>');
  return clock;
}

/** Whether the page is pinned to a moment, or null outside a clock. `<Refresh>` holds while it is. */
export function usePinned(): boolean | null {
  const clock = useContext(ClockContext);
  return clock === null ? null : !clock.live;
}

/**
 * A moment as a clock time in the reader's zone, dated when it is not
 * within twelve hours. Under a clock it follows the Local/UTC control;
 * outside one, in a page head, it is local.
 */
export function Time({ at }: { at: number | null }) {
  const clock = useContext(ClockContext);
  if (at === null) return <span className="text-muted-foreground">—</span>;
  const offset = clock?.offset(at) ?? -new Date(at).getTimezoneOffset();
  return (
    <time suppressHydrationWarning dateTime={new Date(at).toISOString()} className="font-mono tabular-nums">
      {stamp(at, offset, clock?.grid.to ?? Date.now())}
    </time>
  );
}

/**
 * Where the pointer is on the clock, outside React state: it changes on
 * every pointer move, and only the hover line and the readout should
 * re-render for it, not every row.
 */
export interface Hover { t: number; x: number; y: number; tip: ReactNode }
let hovered: Hover | null = null;
const watchers = new Set<() => void>();
export function setHover(next: Hover | null): void {
  if (next === null && hovered === null) return;
  hovered = next;
  for (const w of watchers) w();
}
export function useHover(): Hover | null {
  return useSyncExternalStore(
    (w) => { watchers.add(w); return () => { watchers.delete(w); }; },
    () => hovered,
    () => null,
  );
}

const SEG = 'inline-flex overflow-hidden rounded-md border bg-card';
const SEG_ITEM = 'border-l px-2.5 py-[3px] text-xs/[18px] text-body first:border-l-0 hover:bg-muted '
  + 'aria-[current=true]:bg-foreground aria-[current=true]:text-card aria-pressed:bg-foreground aria-pressed:text-card';
const BUTTON = 'rounded-[5px] border bg-card px-2 py-0.5 text-xs/[18px] text-foreground hover:bg-muted';
const WINDOW_LABELS: Record<number, string> = { 900: '15m', 3600: '1h', 21600: '6h', 86400: '24h' };

export interface DayLoad {
  /** When the strip ends. It covers the 24 hours before. */
  to: number;
  /** Per column: sessions not waiting on a lock, and sessions waiting on one. */
  columns: readonly (readonly [number, number])[];
}

export function Clock({ grid, now, day, events, keep = '', initialCursor = null, children }: {
  grid: Grid;
  /** The server's moment for this render: what "live" is as of. */
  now: number;
  day: DayLoad;
  /** Every event of the last 24 hours: the marks on the strip and the stops for `[` and `]`. */
  events: readonly StoredEvent[];
  /** What a change of window keeps, from `keepQuery`. */
  keep?: string;
  /** A moment the URL asks to be pinned, after a hop that changed the window. */
  initialCursor?: number | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [cursor, setCursor] = useState<number | null>(initialCursor);
  const [selection, select] = useState<readonly [number, number] | null>(null);
  const [utc, setUtc] = useState(false);
  useEffect(() => { if (initialCursor !== null) setCursor(initialCursor); }, [initialCursor]);
  // A new window drops the cursor, however it came: a moment pinned in one
  // window must not come back pinned when the reader returns to it.
  const windowKey = `${grid.winSecs}/${grid.live ? 'live' : grid.to}`;
  const [shown, setShown] = useState(windowKey);
  if (shown !== windowKey) {
    setShown(windowKey);
    setCursor(initialCursor);
    select(null);
  }

  // A cursor the window no longer holds is not a cursor.
  const held = cursor !== null && cursor >= grid.from && cursor < grid.to ? cursor : null;
  // A wide live window ends when the current minute closes, which is not yet: live is now.
  const at = held ?? (grid.live ? Math.min(grid.to - 1, now) : grid.to - 1);
  const live = grid.live && held === null;

  const state = useMemo<ClockState>(() => ({
    grid, cursor: held, at, live, selection,
    offset: (t) => (utc ? 0 : -new Date(t).getTimezoneOffset()),
    // A click on the newest sample of a live window is a return to live, not a pin.
    pin: (t) => setCursor(t !== null && grid.live && t >= grid.to - BUCKET_MS ? null : t),
    select,
  }), [grid, held, at, live, selection, utc]);

  const go = (winSecs: number, end: number | null, pinAt: number | null = null): void => {
    router.push(`${windowQuery(winSecs, end)}${pinAt === null ? '' : `&at=${Math.round(pinAt)}`}${keep}`);
  };
  const toLive = (): void => {
    setCursor(null);
    select(null);
    if (!grid.live) go(grid.winSecs, null);
  };
  const jump = (dir: -1 | 1): void => {
    const t = hop(events, at, dir);
    if (t === null) return;
    select(null);
    if (t >= grid.from && t < grid.to) { setCursor(t); return; }
    const end = endShowing(grid, t);
    go(grid.winSecs, end >= now ? null : end, t);
  };

  // Rebound on every render: it reads the cursor, the window and the events as they are now.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        select(null);
        setCursor(step(grid, held, e.key === 'ArrowLeft' ? -1 : 1));
      } else if (e.key === '[') jump(-1);
      else if (e.key === ']') jump(1);
      else if (e.key === 'Escape') toLive();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const zoom = (): void => {
    if (selection === null) return;
    const z = zoomTo(selection[0], selection[1]);
    select(null);
    setCursor(null);
    go(z.winSecs, z.end >= now - BUCKET_MS ? null : z.end);
  };

  return (
    <ClockContext.Provider value={state}>
      <div className="sticky top-0 z-10 border-b bg-background pb-1.5">
        <div className="flex flex-wrap items-center gap-2.5 pb-2">
          <div className={SEG} role="group" aria-label="Window">
            {WINDOWS.map((w) => (
              <Link
                key={w}
                href={`${windowQuery(w, grid.live ? null : grid.to)}${keep}`}
                aria-current={grid.winSecs === w ? 'true' : undefined}
                className={SEG_ITEM}
              >
                {WINDOW_LABELS[w]}
              </Link>
            ))}
          </div>
          <div className={SEG} role="group" aria-label="Events">
            <button type="button" aria-label="Previous event" className={SEG_ITEM} onClick={() => jump(-1)}>‹</button>
            <span className="border-l px-2 py-[3px] text-xs/[18px] text-muted-foreground">event</span>
            <button type="button" aria-label="Next event" className={SEG_ITEM} onClick={() => jump(1)}>›</button>
          </div>
          <div className={cn(SEG, 'max-md:hidden')} role="group" aria-label="Time zone">
            <button type="button" aria-pressed={!utc} className={SEG_ITEM} onClick={() => setUtc(false)}>Local</button>
            <button type="button" aria-pressed={utc} className={SEG_ITEM} onClick={() => setUtc(true)}>UTC</button>
          </div>
          {/* The server renders these in its own zone and the browser in the reader's. */}
          <span
            suppressHydrationWarning
            data-clock-at
            className={cn('ml-auto flex items-center gap-2 font-mono text-xs/5 text-foreground', !live && selection === null && 'text-warning-ink')}
          >
            {selection !== null ? (
              <>
                {clockTime(selection[0], state.offset(selection[0]))} – {clockTime(selection[1], state.offset(selection[1]))}
                {' · '}{formatDuration((selection[1] - selection[0]) / 1000)}
                <button type="button" className={BUTTON} onClick={zoom}>Zoom</button>
              </>
            ) : live ? (
              <>
                <span aria-hidden className="size-[7px] rounded-full bg-success-ink" />
                live · {clockTime(now, state.offset(now))}
              </>
            ) : (
              <>
                at {stamp(at, state.offset(at), now)}
                <button type="button" className={BUTTON} onClick={toLive}>Back to live</button>
              </>
            )}
          </span>
        </div>
        <DayStrip
          day={day} grid={grid} events={events} offset={state.offset}
          onMove={(end) => { setCursor(null); select(null); go(grid.winSecs, end >= now ? null : end); }}
        />
      </div>
      {children}
    </ClockContext.Provider>
  );
}

const within = (x: number): number => Math.max(0, Math.min(1, x));

/** An element's width, for laying ticks out. 900 where nothing can be measured. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 900));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Round clock times under a time axis. */
export function Axis({ grid, offset, className }: { grid: Pick<Grid, 'from' | 'to'>; offset: (t: number) => number; className?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  // Ticks fall on the reader's round hours, and how many fit depends on the
  // zone, which the server does not know: they are drawn once mounted, or
  // the two renders would disagree on how many there are.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div ref={ref} className={cn('relative h-5', className)}>
      {!mounted ? null : axisTicks(grid, width, offset(grid.to)).map((k) => (
        <span
          key={k.t}
          className="absolute top-0.5 -translate-x-1/2 font-mono text-xs/4 whitespace-nowrap text-body"
          style={{ left: `${k.at * 100}%` }}
        >
          {k.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The last 24 hours, with the window as a box you drag. The box moves with
 * the pointer and the page follows on release: one read, not one per pixel.
 */
function DayStrip({ day, grid, events, offset, onMove }: {
  day: DayLoad; grid: Grid; events: readonly StoredEvent[];
  offset: (t: number) => number; onMove: (end: number) => void;
}) {
  const from = day.to - DAY_MS;
  const span = grid.to - grid.from;
  const [drag, setDrag] = useState<number | null>(null);
  const dragging = useRef(false);
  // The dragged end is dropped when the window it asked for arrives.
  useEffect(() => { setDrag(null); }, [grid.from, grid.to]);

  const endAt = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    const middle = from + within((e.clientX - r.left) / (r.width || 1)) * DAY_MS;
    return Math.max(from + span, Math.min(day.to, middle + span / 2));
  };
  const end = drag ?? grid.to;
  const top = Math.max(1, ...day.columns.map(([rest, lock]) => rest + lock));

  return (
    <>
      <div
        role="slider"
        tabIndex={0}
        aria-label="The last 24 hours. Drag to move the window."
        aria-valuemin={from + span}
        aria-valuemax={day.to}
        aria-valuenow={Math.round(end)}
        suppressHydrationWarning
        aria-valuetext={`${clockTime(end - span, offset(end - span), false)} to ${clockTime(end, offset(end), false)}`}
        className="relative flex h-[30px] cursor-grab touch-none items-end gap-px overflow-hidden rounded border bg-card"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setDrag(endAt(e));
        }}
        onPointerMove={(e) => { if (dragging.current) setDrag(endAt(e)); }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          onMove(endAt(e));
        }}
        onPointerCancel={() => { dragging.current = false; setDrag(null); }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          // The strip's own arrows move the window; the page's move the cursor.
          e.stopPropagation();
          e.preventDefault();
          onMove(Math.max(from + span, Math.min(day.to, grid.to + (e.key === 'ArrowLeft' ? -span : span) / 2)));
        }}
      >
        {day.columns.map(([rest, lock], i) => (
          <i key={i} className="flex h-full flex-1 flex-col-reverse">
            <b className="bg-muted-foreground/55" style={{ height: `${(rest / top) * 100}%` }} />
            <b className="bg-class-lock" style={{ height: `${(lock / top) * 100}%` }} />
          </i>
        ))}
        {events.filter((e) => e.at >= from && e.at <= day.to && e.kind !== 'chain-end' && e.kind !== 'reachable').map((e) => (
          <u
            key={`${e.at}/${e.kind}/${e.relation}`}
            aria-hidden
            className="absolute top-0 -ml-1 size-0 border-4 border-transparent border-t-foreground"
            style={{ left: `${fractionAt({ from, to: day.to }, e.at) * 100}%` }}
          />
        ))}
        <div
          data-clock-window
          className="absolute inset-y-0 min-w-[5px] rounded-[3px] bg-focus/15 shadow-[inset_0_0_0_1.5px_var(--focus)]"
          style={{ left: `${((end - span - from) / DAY_MS) * 100}%`, width: `${(span / DAY_MS) * 100}%` }}
        />
      </div>
      <Axis grid={{ from, to: day.to }} offset={offset} />
    </>
  );
}

/**
 * A stretch of the clock that reads, pins and selects: a row's time cell,
 * or a plot. A click pins the moment under it, a drag selects a range, and
 * moving over it reports the moment to the hover line and the readout.
 */
export function Track({ tip, className, children }: {
  /** What the readout says at a moment. */
  tip?: (t: number) => ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const { grid, pin, select } = useClock();
  const drag = useRef<{ x: number; t: number; range: readonly [number, number] | null } | null>(null);
  const timeOf = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    return timeAt(grid, (e.clientX - r.left) / (r.width || 1));
  };
  return (
    <div
      data-track
      className={cn('relative cursor-crosshair touch-pan-y', className)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, t: timeOf(e), range: null };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const t = timeOf(e);
        const d = drag.current;
        if (d === null) { setHover({ t, x: e.clientX, y: e.clientY, tip: tip?.(t) ?? null }); return; }
        if (Math.abs(e.clientX - d.x) <= 4) return;
        d.range = [Math.min(d.t, t), Math.max(d.t, t)];
        setHover(null);
        select(d.range);
      }}
      onPointerLeave={() => setHover(null)}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d === null) return;
        if (d.range === null) { select(null); pin(d.t); return; }
        // A drag under two samples is a slip of the hand, not a range.
        if (d.range[1] - d.range[0] < 2 * BUCKET_MS) select(null);
      }}
      onPointerCancel={() => { drag.current = null; }}
    >
      {children}
    </div>
  );
}

/**
 * The cursor, the hover line and the selection, drawn once over a column of
 * tracks. Its parent positions it over the time column.
 */
export function ClockLines({ className }: { className?: string }) {
  const { grid, cursor, selection } = useClock();
  const hover = useHover();
  const left = (t: number): string => `${within(fractionAt(grid, t)) * 100}%`;
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-y-0', className)}>
      {selection !== null ? (
        <div className="absolute inset-y-0 bg-focus/15" style={{ left: left(selection[0]), width: `${(within(fractionAt(grid, selection[1])) - within(fractionAt(grid, selection[0]))) * 100}%` }} />
      ) : null}
      {hover !== null ? <div className="absolute inset-y-0 w-px bg-muted-foreground" style={{ left: left(hover.t) }} /> : null}
      {cursor !== null ? <div data-clock-cursor className="absolute inset-y-0 -ml-px w-0.5 bg-foreground" style={{ left: left(cursor) }} /> : null}
    </div>
  );
}

/** The readout at the pointer: the moment, then whatever the track under it has to say. */
export function Readout() {
  const hover = useHover();
  const { offset } = useClock();
  if (hover === null) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-20 max-w-80 rounded-[5px] bg-foreground px-2 py-1.5 text-xs/[17px] text-card shadow-lg"
      style={{ left: hover.x + 14, top: hover.y + 16 }}
    >
      <span className="font-mono opacity-75">{clockTime(hover.t, offset(hover.t))}</span>
      {hover.tip}
    </div>
  );
}
