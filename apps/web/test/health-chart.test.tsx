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
      <HealthChart label="Blocked" unit="count" points={at([1, 2, 7, 3, 4])} from={FROM} to={TO} />);
    expect(view.text()).toContain('4');
    await view.rerender(
      <HealthChart label="Blocked" unit="count" points={at([1, 2, 7, 3, 4])} from={FROM} to={TO} cursor={250_000} />);
    expect(view.find('7')).not.toBeNull();
    await view.rerender(
      <HealthChart label="Blocked" unit="count" points={at([1, 2, null, 3, 4])} from={FROM} to={TO} cursor={250_000} />);
    expect(view.text()).toContain('no reading');
  });

  it('names the series, its latest and its peak for a screen reader', async () => {
    view = await render(
      <HealthChart label="Blocked" unit="count" points={at([1, 2, 7, 3, 4])} from={FROM} to={TO} />);
    expect(view.container.querySelector('svg')!.getAttribute('aria-label'))
      .toBe('Blocked. Latest 4, peak 7.');
  });

  /**
   * Found on screen at 390 wide: the fleet page showed "Average active s…"
   * and "Shared-buff…". A label that cannot be read names nothing, so it
   * wraps; and the plot stands clear of it, because a limit ruled at the
   * very top of the plot otherwise reads as the label's underline.
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
   * Found on screen: Database size read "10 MB" at the top of its axis and
   * "10 MB" at the bottom. Where the axis does not start at zero the change
   * is small against the reading by definition, so the lower label states
   * the distance down from the top instead of repeating it.
   */
  it('labels the foot of a non-zero axis by its distance from the top', async () => {
    view = await render(
      <HealthChart label="Database size" unit="bytes" zero={false}
        points={at([10_485_760, 10_485_760 + 524_288, 10_485_760 + 1_048_576, 11_534_336, 11_534_336])}
        from={FROM} to={TO} />);
    expect(view.text()).toContain('−1 MB');
  });

  it('keeps a compact chart to its plot and one line of text', async () => {
    view = await render(
      <HealthChart compact label="Blocked" unit="count" points={at([1, 2, 7, 3, 4])} from={FROM} to={TO} />);
    expect(view.text()).not.toContain('UTC');
  });
});
