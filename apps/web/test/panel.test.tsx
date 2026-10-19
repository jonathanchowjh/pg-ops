import { act, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render';
import { Clock, Readout, setHover } from '@/components/clock';
import { Panel, Rhythm } from '@/components/panel';
import { gridFor } from '@/lib/clock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

/** 14:30 UTC; the tests pin UTC through the cursor rather than the zone control. */
const NOW = Date.UTC(2026, 9, 12, 14, 30, 0);
const grid = gridFor({ win: '900' }, NOW);
let view: Rendered;
afterEach(() => { view.unmount(); });
const under = async (el: ReactElement, cursor: number | null = null) => {
  view = await render(<Clock grid={grid} now={NOW} day={{ to: NOW, columns: [] }} events={[]} initialCursor={cursor}>{el}</Clock>);
};
const cols = (v: number | null) => Array.from({ length: grid.columns }, () => v);

describe('a panel', () => {
  it('stacks its series in their inks, with a legend, a ruled axis in its unit and a table of the same numbers', async () => {
    await under(
      <Panel title="Rows written" note="an hour" unit="compact" kind="stack"
        series={[{ name: 'Inserted', tone: 0, values: cols(1500) }, { name: 'Updated', tone: 1, values: cols(500) }]} />,
    );
    const paths = [...view.container.querySelectorAll('svg path')];
    expect(paths.map((p) => p.getAttribute('class'))).toEqual(['fill-foreground/75', 'fill-foreground/45']);
    expect(view.text()).toContain('Rows written');
    expect(view.text()).toContain('Inserted');
    // 2,000 at the peak: ruled in round steps, printed short.
    expect(view.text()).toContain('2K');
    const table = view.container.querySelector('table')!;
    expect(table.querySelectorAll('tbody tr')).toHaveLength(grid.columns);
    expect(table.querySelector('tbody td')!.textContent).toBe('1.5K');
  });

  it('wears a class hue only for a class', async () => {
    await under(<Panel title="Load" unit="sessions" kind="stack" series={[{ name: 'Lock wait', tone: 'lock', values: cols(2) }]} />);
    expect(view.container.querySelector('svg path')!.getAttribute('class')).toBe('fill-class-lock');
    // One series needs no legend.
    expect(view.container.querySelector('[data-legend]')).toBeNull();
  });

  it('draws a line against a dashed limit, and breaks it where nothing was kept', async () => {
    const dead = [...cols(40).slice(0, 10), ...cols(null).slice(0, 10), ...cols(60).slice(0, grid.columns - 20)];
    await under(
      <Panel title="Dead rows" unit="compact" kind="line" series={[{ name: 'Dead rows', tone: 0, values: dead }]}
        limit={{ name: 'Autovacuum trigger', values: cols(50) }} />,
    );
    const [line, limit] = [...view.container.querySelectorAll('svg path')];
    expect(line!.getAttribute('d')!.match(/M/g)).toHaveLength(2);
    expect(limit!.getAttribute('stroke-dasharray')).toBe('5 4');
    expect(view.text()).toContain('Autovacuum trigger');
  });

  it('marks its events on its own clock, and does not label two that touch', async () => {
    await under(
      <Panel title="Dead rows" unit="compact" kind="line" series={[{ name: 'Dead rows', tone: 0, values: cols(1) }]}
        marks={[{ at: NOW - 600_000, label: 'vacuum' }, { at: NOW - 590_000, label: 'vacuum' }, { at: NOW - 86_400_000, label: 'vacuum' }]} />,
    );
    expect(view.container.querySelectorAll('[data-mark]')).toHaveLength(2);
    expect(view.text().match(/vacuum/g)).toHaveLength(1);
  });
});

describe('a panel, read closely', () => {
  /** jsdom lays nothing out: give the track a thousand pixels, then point at its middle. */
  const hover = async () => {
    const el = view.container.querySelector<HTMLElement>('[data-track]')!;
    el.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 100, right: 1000, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => { el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 500, button: 0 })); });
    const said = document.querySelector('[role=tooltip]')!.textContent!;
    // The pointer lives outside React, for the whole file.
    await act(async () => { setHover(null); });
    return said;
  };
  const rules = () => [...view.container.querySelectorAll('[data-track] > i > span')].map((s) => s.textContent);

  it('says once that nothing was kept, rather than drawing a bare axis', async () => {
    await under(<Panel title="Size" unit="bytes" kind="line" series={[{ name: 'Size', tone: 0, values: cols(null) }]} />);
    expect(view.text()).toContain('nothing kept for this window');
    expect(view.container.querySelector('[data-track]')).toBeNull();
  });

  it('rules a byte axis in steps of a binary unit, so every rule prints round', async () => {
    await under(<Panel title="Size" unit="bytes" kind="line" series={[{ name: 'Size', tone: 0, values: cols(19_000_000) }]} />);
    expect(rules()).toEqual(['5 MB', '10 MB', '15 MB', '20 MB']);
  });

  it('reads out a class only where it is above 0.05, as the tree does, and every other series always', async () => {
    await under(
      <>
        <Panel title="Load" unit="sessions" kind="stack" series={[
          { name: 'On CPU', tone: 'cpu', values: cols(2) },
          { name: 'Lock wait', tone: 'lock', values: cols(0.04) },
          { name: 'I/O', tone: 'io', values: cols(0) },
        ]} />
        <Readout />
      </>,
    );
    const said = await hover();
    expect(said).toContain('On CPU');
    expect(said).not.toContain('Lock wait');
    expect(said).not.toContain('I/O');
    view.unmount();
    await under(<><Panel title="Rows read" unit="compact" kind="stack" series={[{ name: 'By index', tone: 0, values: cols(5) }, { name: 'By full scan', tone: 2, values: cols(0) }]} /><Readout /></>);
    expect(await hover()).toContain('By full scan');
  });
});

describe('the rhythm', () => {
  const at = (daysAgo: number, hour: number) => Date.UTC(2026, 9, 12 - daysAgo, hour, 0, 0);

  it('draws this day over the mean, leaves the hours it has not reached empty, and rings the cursor\'s hour', async () => {
    const hours = [...Array(7)].map((_, i) => ({ at: at(i + 1, 9), sessions: 4 }));
    await under(<Rhythm hours={[...hours, { at: at(0, 9), sessions: 2 }]} />, NOW - 300_000);
    // The clock is on local time unless told otherwise, so the expectation is too.
    const hourNow = new Date(NOW - 300_000).getHours();
    expect(view.container.querySelectorAll('[data-hour]')).toHaveLength(24);
    expect(view.container.querySelector('[data-marked]')!.getAttribute('data-hour')).toBe(String(hourNow));
    // An hour this day has not reached has a mean and no bar of its own.
    const later = view.container.querySelector(`[data-hour="${(hourNow + 1) % 24}"]`)!;
    if (hourNow < 23) expect(later.querySelector('u')).toBeNull();
    expect(view.text()).toContain('Rhythm');
  });
});
