import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render';
import { renderToString } from 'react-dom/server';
import { Axis, Clock, ClockLines, Track, usePinned } from '@/components/clock';
import { gridFor } from '@/lib/clock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const NOW = Date.UTC(2026, 9, 12, 8, 30, 0);
const MIN = 60_000;
const day = { to: NOW, columns: [[1, 0], [2, 1]] as const };

function Pinned() { return <output data-pinned>{String(usePinned())}</output>; }

let view: Rendered;
const mount = async (sp: Record<string, string> = { win: '900' }, events: { at: number; kind: 'chain-begin'; relation: string }[] = [], extra: { keep?: string; initialCursor?: number } = {}) => {
  view = await render(
    <Clock grid={gridFor(sp, NOW)} now={NOW} day={day} events={events} {...extra}>
      <Pinned />
      <div style={{ position: 'relative' }}>
        <Track><span>row</span></Track>
        <ClockLines />
      </div>
    </Clock>,
  );
  // Times in UTC, so the assertions do not depend on the machine's zone.
  await click(button('UTC'));
};
const button = (label: string) => [...view.container.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label)!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const key = async (k: string, target: EventTarget = window) => { await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); }); };
const at = () => view.container.querySelector('[data-clock-at]')!.textContent;
const pinned = () => view.container.querySelector('[data-pinned]')!.textContent;
const pointer = async (el: Element, type: string, clientX: number) => {
  await act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 })); });
};
/** jsdom lays nothing out: give the track a thousand pixels to be measured against. */
const track = () => {
  const el = view.container.querySelector<HTMLElement>('[data-track]')!;
  el.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 34, right: 1000, bottom: 34, x: 0, y: 0, toJSON: () => ({}) });
  return el;
};

beforeEach(() => { router.push.mockClear(); });
afterEach(() => { view?.unmount(); });

describe('the axis', () => {
  it('draws no tick on the server, where the reader\'s zone and so the ticks are unknown', () => {
    const html = renderToString(<Axis grid={{ from: NOW - 24 * 60 * MIN, to: NOW }} offset={() => 330} />);
    expect(html).not.toContain('<span');
  });
});

describe('the clock bar', () => {
  it('is live by default, as of the server\'s moment, with nothing to go back to', async () => {
    await mount();
    expect(at()).toBe('live · 08:30:00');
    expect(button('Back to live')).toBeUndefined();
    expect(pinned()).toBe('false');
    expect(view.container.querySelector('[data-clock-cursor]')).toBeNull();
  });

  it('marks the window in force and keeps the find and the folds on the others', async () => {
    await mount({ win: '900' }, [], { keep: '&find=users' });
    const links = [...view.container.querySelectorAll('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])).toEqual([
      ['15m', '?win=900&find=users', 'true'], ['1h', '?win=3600&find=users', null],
      ['6h', '?win=21600&find=users', null], ['24h', '?win=86400&find=users', null],
    ]);
  });

  it('keeps a past window\'s end when the zoom changes', async () => {
    const end = NOW - 60 * MIN;
    await mount({ win: '900', end: String(end) });
    expect(view.container.querySelector('a')!.getAttribute('href')).toBe(`?win=900&end=${end}`);
    expect(at()).toContain('at 07:29:59');
    expect(pinned()).toBe('true');
  });
});

describe('the cursor', () => {
  it('steps back a sample with the left arrow, and Esc returns to live', async () => {
    await mount();
    await key('ArrowLeft');
    expect(at()).toContain('at 08:29:45');
    expect(pinned()).toBe('true');
    expect(view.container.querySelector('[data-clock-cursor]')).not.toBeNull();
    await key('ArrowLeft');
    expect(at()).toContain('at 08:29:30');
    await key('Escape');
    expect(at()).toBe('live · 08:30:00');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('drops a pinned moment when the window changes, so going back is live again', async () => {
    const clock = (win: string) => (
      <Clock grid={gridFor({ win }, NOW)} now={NOW} day={day} events={[]}><Pinned /></Clock>
    );
    view = await render(clock('3600'));
    await key('ArrowLeft');
    expect(pinned()).toBe('true');
    await view.rerender(clock('900'));
    await view.rerender(clock('3600'));
    expect(pinned()).toBe('false');
  });

  it('steps forward off the end back to live', async () => {
    await mount();
    await key('ArrowLeft');
    await key('ArrowRight');
    expect(pinned()).toBe('false');
  });

  it('leaves the keys alone while the reader types in a box', async () => {
    await mount();
    const input = document.createElement('input');
    view.container.appendChild(input);
    await key('ArrowLeft', input);
    expect(pinned()).toBe('false');
  });

  it('hops to an event inside the window without asking the server', async () => {
    await mount({ win: '900' }, [{ at: NOW - 5 * MIN, kind: 'chain-begin', relation: 'public.users' }]);
    await key('[');
    expect(at()).toContain('at 08:25:00');
    expect(router.push).not.toHaveBeenCalled();
    await key(']');
    expect(at()).toContain('at 08:25:00');   // no later event: it stays
  });

  it('moves the window to an event outside it and asks for that moment pinned', async () => {
    const event = NOW - 3 * 60 * MIN;
    await mount({ win: '900' }, [{ at: event, kind: 'chain-begin', relation: 'public.users' }]);
    await click(button('Previous event'));
    expect(router.push).toHaveBeenCalledWith(`?win=900&end=${event + 4.5 * MIN}&at=${event}`);
  });

  it('pins the moment the URL asks for', async () => {
    await mount({ win: '900' }, [], { initialCursor: NOW - 10 * MIN });
    expect(at()).toContain('at 08:20:00');
  });

  it('goes back to live from a window in the past by asking for the live one', async () => {
    await mount({ win: '900', end: String(NOW - 60 * MIN) });
    await click(button('Back to live'));
    expect(router.push).toHaveBeenCalledWith('?win=900');
  });
});

describe('a track', () => {
  it('pins the moment clicked', async () => {
    await mount();
    const el = track();
    await pointer(el, 'pointerdown', 500);
    await pointer(el, 'pointerup', 500);
    expect(at()).toContain('at 08:22:30');
  });

  it('returns to live on a click at the newest sample', async () => {
    await mount();
    await key('ArrowLeft');
    const el = track();
    await pointer(el, 'pointerdown', 1000);
    await pointer(el, 'pointerup', 1000);
    expect(pinned()).toBe('false');
  });

  it('selects a dragged range and zooms to it', async () => {
    await mount();
    const el = track();
    await pointer(el, 'pointerdown', 200);
    await pointer(el, 'pointermove', 600);
    await pointer(el, 'pointerup', 600);
    expect(at()).toContain('08:18:00 – 08:24:00 · 6m 0s');
    await click(button('Zoom'));
    expect(router.push).toHaveBeenCalledWith(`?win=360&end=${NOW - 6 * MIN}`);
  });

  it('treats a drag of a few pixels as a click', async () => {
    await mount();
    const el = track();
    await pointer(el, 'pointerdown', 500);
    await pointer(el, 'pointermove', 502);
    await pointer(el, 'pointerup', 502);
    expect(at()).toContain('at 08:22:30');
  });
});
