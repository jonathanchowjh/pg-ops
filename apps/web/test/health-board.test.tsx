import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, type Rendered } from './render.js';
import { HealthBoard } from '@/components/health-board';
import type { BoardChart, BoardGroup } from '@/lib/health';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FROM = Date.parse('2026-10-01T00:00:00Z');
const TO = FROM + 6 * 3_600_000;
const STEP = (TO - FROM) / 6;

const chart = (metric: string, label: string, values: (number | null)[]): BoardChart => ({
  metric: metric as BoardChart['metric'], label, unit: 'count', scope: 'database',
  points: values.map((value, i) => ({ at: FROM + i * STEP, value })),
  ceiling: null, zero: true, empty: 'No reading in this window.', caveat: null, note: null, fit: null,
});

const GROUPS: BoardGroup[] = [
  { gate: 'wait', title: 'Locks', charts: [chart('blocked', 'Blocked sessions', [0, 0, 0, 7, 0, 1])] },
  { gate: 'work', title: 'Queries', charts: [chart('active', 'Active sessions, sampled', [2, 2, 2, null, 2, 3])] },
];

let view: Rendered | undefined;
afterEach(() => { view?.unmount(); view = undefined; });

/** jsdom lays nothing out, so give every plot a 600px box starting at x=100. */
function layOut(container: HTMLElement) {
  for (const plot of container.querySelectorAll<HTMLElement>('[data-plot]')) {
    plot.getBoundingClientRect = () => ({
      left: 100, right: 700, width: 600, top: 0, bottom: 100, height: 100, x: 100, y: 0, toJSON: () => ({}),
    });
  }
}

async function point(el: Element, type: string, clientX: number) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
  });
}

const readouts = (container: HTMLElement) =>
  [...container.querySelectorAll('figcaption')].map((f) => f.lastElementChild!.textContent);

describe('HealthBoard', () => {
  it('shows each chart\'s latest reading until a moment is chosen', async () => {
    view = await render(<HealthBoard name="prod" from={FROM} to={TO} groups={GROUPS} />);
    expect(readouts(view.container)).toEqual(['1', '3']);
    expect(view.text()).not.toContain('Sessions now');
  });

  it('puts one cursor on every chart from a move over any one of them', async () => {
    view = await render(<HealthBoard name="prod" from={FROM} to={TO} groups={GROUPS} />);
    layOut(view.container);
    const plots = view.container.querySelectorAll('[data-plot]');
    // x=420 is 320/600 across: 3.2 hours in, nearest the fourth bucket at 03:00.
    await point(plots[0]!, 'pointermove', 420);
    expect(readouts(view.container)).toEqual(['10-01 03:00 · 7', '10-01 03:00 · no reading']);
    expect(view.container.querySelectorAll('[data-plot] > span')).toHaveLength(2);
  });

  it('follows a touch, which arrives as pointerdown before any move', async () => {
    view = await render(<HealthBoard name="prod" from={FROM} to={TO} groups={GROUPS} />);
    layOut(view.container);
    await point(view.container.querySelectorAll('[data-plot]')[1]!, 'pointerdown', 110);
    expect(readouts(view.container)).toEqual(['10-01 00:00 · 0', '10-01 00:00 · 2']);
  });

  it('ignores a move over anything that is not a plot', async () => {
    view = await render(<HealthBoard name="prod" from={FROM} to={TO} groups={GROUPS} />);
    layOut(view.container);
    await point(view.container.querySelector('h2')!, 'pointermove', 450);
    expect(readouts(view.container)).toEqual(['1', '3']);
  });

  it('clamps a pointer past either edge to the window', async () => {
    view = await render(<HealthBoard name="prod" from={FROM} to={TO} groups={GROUPS} />);
    layOut(view.container);
    const plot = view.container.querySelector('[data-plot]')!;
    await point(plot, 'pointermove', 5_000);
    expect(readouts(view.container)).toEqual(['10-01 05:00 · 1', '10-01 05:00 · 3']);   // the last bucket
    await point(plot, 'pointermove', -50);
    expect(readouts(view.container)).toEqual(['10-01 00:00 · 0', '10-01 00:00 · 2']);   // the first
  });

  it('names the moment, and offers the live pages as "now", not as that moment', async () => {
    view = await render(<HealthBoard name="prod" from={FROM} to={TO} groups={GROUPS} />);
    layOut(view.container);
    await point(view.container.querySelector('[data-plot]')!, 'pointermove', 400);
    // x=400 is half way: 03:00.
    expect(view.text()).toContain('10-01 03:00 UTC');
    const hrefs = Object.fromEntries(
      [...view.container.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]));
    expect(hrefs['Sessions now']).toBe('/db/prod');
    expect(hrefs['Queries now']).toBe('/db/prod/queries');
  });

  it('offers a six-hour window centred on the moment', async () => {
    view = await render(<HealthBoard name="prod" from={FROM} to={TO} groups={GROUPS} />);
    layOut(view.container);
    await point(view.container.querySelector('[data-plot]')!, 'pointermove', 400);
    const zoom = [...view.container.querySelectorAll('a')].find((a) => a.textContent === 'Zoom to ±3 hours')!;
    const url = new URL(zoom.getAttribute('href')!, 'http://x');
    expect(url.pathname).toBe('/db/prod/health');
    expect(url.searchParams.get('from')).toBe('2026-10-01T00:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-10-01T06:00:00.000Z');
  });

  it('clears', async () => {
    view = await render(<HealthBoard name="prod" from={FROM} to={TO} groups={GROUPS} />);
    layOut(view.container);
    await point(view.container.querySelector('[data-plot]')!, 'pointermove', 450);
    await act(async () => {
      [...view!.container.querySelectorAll('button')].find((b) => b.textContent === 'Clear')!.click();
    });
    expect(readouts(view.container)).toEqual(['1', '3']);
    expect(view.container.querySelectorAll('[data-plot] > span')).toHaveLength(0);
  });
});
