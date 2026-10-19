import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, type Rendered } from './render.js';
import { HealthChart, type HealthChartPoint } from '@/components/health-chart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let view: Rendered | undefined;
afterEach(() => { view?.unmount(); view = undefined; });

const FROM = 0;
const TO = 600_000;
const at = (values: (number | null)[]): HealthChartPoint[] =>
  values.map((value, i) => ({ at: FROM + i * 120_000, value }));

describe('HealthChart', () => {
  it('breaks the line at a null instead of drawing through it', async () => {
    view = await render(
      <HealthChart label="Blocked" unit="count" points={at([1, 2, null, 3, 4])} from={FROM} to={TO} />);
    expect(view.container.querySelectorAll('polyline[data-series="main"]')).toHaveLength(2);
  });

  it('draws a reading with a gap on both sides as a dot, so it is not lost', async () => {
    view = await render(
      <HealthChart label="Blocked" unit="count" points={at([null, 5, null, null, null])} from={FROM} to={TO} />);
    expect(view.container.querySelectorAll('polyline[data-series="main"]')).toHaveLength(0);
    expect(view.container.querySelectorAll('line[data-series="main"]')).toHaveLength(1);
  });

  it('replaces the plot with the reason when every reading is null', async () => {
    view = await render(
      <HealthChart label="Replication lag" unit="secs" points={at([null, null, null, null, null])}
        from={FROM} to={TO} empty="No standby reported a replay lag." />);
    expect(view.container.querySelector('svg')).toBeNull();
    expect(view.text()).toContain('Replication lag');
    expect(view.text()).toContain('No standby reported a replay lag.');
  });

  it('measures from zero, so a count of 3 is not drawn at the top', async () => {
    view = await render(
      <HealthChart label="Blocked" unit="count" points={at([3, 3, 3, 3, 3])} from={FROM} to={TO} />);
    const y = Number(view.container.querySelector('polyline[data-series="main"]')!
      .getAttribute('points')!.split(' ')[0]!.split(',')[1]);
    expect(y).toBeLessThan(28);   // above the baseline
    expect(y).toBeLessThan(3);    // 3 is the peak, so it sits at the top of a zero-based axis
    const flatZero = await render(
      <HealthChart label="Blocked" unit="count" points={at([0, 0, 0, 0, 0])} from={FROM} to={TO} />);
    const y0 = Number(flatZero.container.querySelector('polyline[data-series="main"]')!
      .getAttribute('points')!.split(' ')[0]!.split(',')[1]);
    expect(y0).toBe(28);          // zero is on the baseline, not floating mid-chart
    flatZero.unmount();
  });

  it('scales to the ceiling when there is one, and rules it', async () => {
    view = await render(
      <HealthChart label="Connections" unit="count" points={at([10, 12, 11, 12, 10])} from={FROM} to={TO} ceiling={100} />);
    expect(view.container.querySelector('line[data-series="ceiling"]')).not.toBeNull();
    const y = Number(view.container.querySelector('polyline[data-series="main"]')!
      .getAttribute('points')!.split(' ')[0]!.split(',')[1]);
    expect(y).toBeGreaterThan(24); // 10 of 100 sits near the bottom
  });

  it('draws the inner series under the same scale', async () => {
    view = await render(
      <HealthChart label="Connections" unit="count" points={at([40, 40, 40, 40, 40])}
        inner={at([10, 10, 10, 10, 10])} innerLabel="this database" from={FROM} to={TO} />);
    expect(view.container.querySelectorAll('polyline[data-series="inner"]')).toHaveLength(1);
    expect(view.text()).toContain('this database');
  });

  it('states the latest reading, and the reading under the cursor when there is one', async () => {
    view = await render(
      <HealthChart label="Blocked" unit="count" points={at([1, 2, 7, 3, 4])} from={FROM} to={TO} cursor={null} />);
    expect(view.text()).toContain('4');
    await view.rerender(
      <HealthChart label="Blocked" unit="count" points={at([1, 2, 7, 3, 4])} from={FROM} to={TO} cursor={250_000} />);
    expect(view.find('7')).not.toBeNull();
    await view.rerender(
      <HealthChart label="Blocked" unit="count" points={at([1, 2, null, 3, 4])} from={FROM} to={TO} cursor={250_000} />);
    expect(view.text()).toContain('no reading');
  });

  /** A value alone is not a reading: it has to say when, and of what. */
  it('says when the reading under the cursor was, marks it, and reads the inner series beside it', async () => {
    view = await render(
      <HealthChart label="Connections" unit="count" points={at([40, 41, 47, 43, 44])}
        inner={at([10, 11, 17, 13, 14])} innerLabel="this database" from={FROM} to={TO} cursor={250_000} />);
    const readout = view.container.querySelector('figcaption')!.lastElementChild!.textContent;
    expect(readout).toBe('01-01 00:04 · 47 · this database 17');
    expect(view.container.querySelectorAll('line[data-series="marker"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('line[data-series="inner-marker"]')).toHaveLength(1);
  });

  it('snaps the cursor to the nearest reading rather than the pointer', async () => {
    view = await render(
      <HealthChart label="Blocked" unit="count" points={at([1, 2, 7, 3, 4])} from={FROM} to={TO} cursor={200_000} />);
    // 200s is nearer the third reading at 240s than the second at 120s.
    expect(view.text()).toContain('· 7');
    expect(view.container.querySelector('[data-plot] > span')!.getAttribute('style')).toContain('left: 40%');
  });

  /** A chart on a page with no board tracks the pointer over its own plot. */
  it('keeps its own cursor when none is passed, and drops it when the pointer leaves', async () => {
    view = await render(
      <HealthChart label="Blocked" unit="count" points={at([1, 2, 7, 3, 4])} from={FROM} to={TO} />);
    const plot = view.container.querySelector<HTMLElement>('[data-plot]')!;
    plot.getBoundingClientRect = () => ({
      left: 0, right: 600, width: 600, top: 0, bottom: 100, height: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    await act(async () => { plot.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 240 })); });
    expect(view.text()).toContain('00:04 · 7');
    // React derives onPointerLeave from pointerout and where the pointer went.
    await act(async () => {
      plot.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(view.text()).not.toContain('00:04');
    expect(view.container.querySelectorAll('line[data-series="marker"]')).toHaveLength(0);
  });

  /** Reading a value off a position needs rows between the bounds, at round numbers. */
  it('rules the plot at round values up to the first one past the peak, and labels each', async () => {
    view = await render(
      <HealthChart label="Calls" unit="count" points={at([0, 300, 900, 100, 50])} from={FROM} to={TO} />);
    expect(view.container.querySelectorAll('line[data-gridline]')).toHaveLength(6);
    for (const label of ['0', '200', '400', '600', '800', '1,000']) expect(view.find(label)).not.toBeNull();
  });

  it('rules a series that never left zero with its baseline only', async () => {
    view = await render(
      <HealthChart label="Deadlocks" unit="count" points={at([0, 0, 0, 0, 0])} from={FROM} to={TO} />);
    expect(view.container.querySelectorAll('line[data-gridline]')).toHaveLength(1);
    expect(view.find(/^1$/)).toBeNull();
  });

  it('rules a compact chart at its baseline and nothing else', async () => {
    view = await render(
      <HealthChart compact label="Calls" unit="count" points={at([0, 300, 900, 100, 50])} from={FROM} to={TO} />);
    expect(view.container.querySelectorAll('line[data-gridline]')).toHaveLength(1);
  });

  /**
   * Autoscaled to min..max, a 102 MB relation that grew 8 KB draws a line
   * climbing the full plot. The 2% range floor stops that.
   */
  it('does not magnify a change far smaller than the reading', async () => {
    const mb = 1024 * 1024;
    view = await render(
      <HealthChart label="Size" unit="bytes" zero={false}
        points={at([102 * mb, 102 * mb + 4096, 102 * mb + 8192, 102 * mb + 8192, 102 * mb + 8192])} from={FROM} to={TO} />);
    const ys = view.container.querySelector('polyline[data-series="main"]')!.getAttribute('points')!
      .trim().split(/\s+/).map((pt) => Number(pt.split(',')[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1);
  });

  it('names the series, its latest and its peak for a screen reader', async () => {
    view = await render(
      <HealthChart label="Blocked" unit="count" points={at([1, 2, 7, 3, 4])} from={FROM} to={TO} />);
    expect(view.container.querySelector('svg')!.getAttribute('aria-label'))
      .toBe('Blocked. Latest 4, peak 7.');
  });

  /**
   * At 390 wide a truncated label reads "Average active s…". The plot stands
   * clear because a limit ruled at its top otherwise reads as the label's
   * underline.
   */
  it('wraps a long label instead of cutting it, and stands the plot clear of it', async () => {
    view = await render(
      <HealthChart compact label="Average active sessions" unit="sessions" points={at([1, 2, 7, 3, 4])}
        from={FROM} to={TO} ceiling={10} />);
    const label = view.find('Average active sessions')!;
    expect(label.className).not.toContain('truncate');
    expect(view.container.querySelector('[data-plot]')!.parentElement!.className).toContain('mt-2');
  });

  /**
   * Where the axis does not start at zero the change is small against the
   * reading, so both ends would print the same figure ("10 MB" twice).
   */
  it('labels the foot of a non-zero axis by its distance from the top', async () => {
    view = await render(
      <HealthChart label="Database size" unit="bytes" zero={false}
        points={at([10_485_760, 10_485_760 + 524_288, 10_485_760 + 1_048_576, 11_534_336, 11_534_336])}
        from={FROM} to={TO} />);
    expect(view.text()).toContain('−1 MB');
  });

  /** The range floor must not rule a table that never grew with 500 bytes of invented axis. */
  it('draws a flat non-zero series as one line under one label', async () => {
    view = await render(
      <HealthChart label="Size" unit="bytes" zero={false} points={at([24_576, 24_576, 24_576, 24_576, 24_576])}
        from={FROM} to={TO} />);
    expect(view.container.querySelectorAll('line[data-gridline]')).toHaveLength(1);
    expect(view.find('24 KB')).not.toBeNull();
    expect(view.text()).not.toContain('−');
    const y = Number(view.container.querySelector('polyline[data-series="main"]')!
      .getAttribute('points')!.split(' ')[0]!.split(',')[1]);
    expect(y).toBe(15);
  });

  it('keeps a compact chart to its plot and one line of text', async () => {
    view = await render(
      <HealthChart compact label="Blocked" unit="count" points={at([1, 2, 7, 3, 4])} from={FROM} to={TO} />);
    expect(view.text()).not.toContain('UTC');
  });
});
