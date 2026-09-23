import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { LineChart } from '@/components/line-chart';
import { formatBytes, formatCount } from '@/lib/format';

const MIN = 60_000;
const T0 = new Date('2026-09-23T00:00:00Z').getTime();
/** `n` minutes after the start of the window. */
const at = (n: number) => new Date(T0 + n * MIN);
/**
 * A capture every five minutes, the scheduler's cadence. `skip[i]` adds extra
 * minutes BEFORE point `i`, which is how a missed tick actually appears.
 */
const every5 = (values: number[], skip: number[] = []) => values.map((value, i) => ({
  at: at(i * 5 + skip.slice(0, i + 1).reduce((a, b) => a + b, 0)),
  value,
}));

function polylines(container: Element): string[] {
  return [...container.querySelectorAll('polyline')]
    .map((p) => p.getAttribute('points')!);
}

describe('LineChart', () => {
  it('draws one point per reading', async () => {
    const r = await render(
      <LineChart points={every5([1, 2, 3, 4])} label="calls" format={formatCount} />);
    expect(polylines(r.container)).toHaveLength(1);
    expect(polylines(r.container)[0]!.trim().split(/\s+/)).toHaveLength(4);
    r.unmount();
  });

  /**
   * A flat series has a zero range, and `(v - min) / (max - min)` is NaN.
   * An SVG with NaN coordinates renders nothing at all — a chart that
   * silently disappears for the most ordinary case there is, a relation
   * that has not changed size.
   */
  it('draws a flat series as a flat line, not as NaN', async () => {
    const r = await render(
      <LineChart points={every5([500, 500, 500])} label="size" format={formatBytes} />);
    expect(polylines(r.container)[0]).not.toMatch(/NaN/);
    r.unmount();
  });

  it('renders nothing rather than an empty axis for no points', async () => {
    const r = await render(<LineChart points={[]} label="size" format={formatBytes} />);
    expect(r.container.querySelector('svg')).toBeNull();
    r.unmount();
  });

  /**
   * ONE capture is not a chart either, and it used to draw the most
   * misleading thing on the console: a frame with no line in it, the same
   * number on both value labels, and a time axis reading "-0s . -0s . now"
   * because the span between a point and itself is zero. Every caller states
   * the capture count beside this and says "not enough history" in words, so
   * drawing nothing is what agrees with the page.
   */
  it('renders nothing for a single capture, which has no span and no line', async () => {
    const r = await render(
      <LineChart points={every5([102])} label="size" format={formatBytes} />);
    expect(r.container.querySelector('svg')).toBeNull();
    expect(r.container.textContent).not.toContain('0s');
    r.unmount();
  });

  /**
   * The axis exists to let a value be read off a position, which needs rows
   * BETWEEN the bounds — two numbers and a blank field is a caption, not an
   * axis. Each label is centred on the gridline it belongs to.
   */
  /**
   * A 102 MB relation that grew 8 KB drew a line climbing the full height of
   * the plot, under four axis labels that all read "102 MB" because the
   * range was finer than the formatter could print — while the `Change` fact
   * beside it correctly said "+8 KB". Autoscaling to min..max is what makes
   * a flat series look dramatic; the floor is what stops it.
   */
  it('does not magnify a change far smaller than the reading', async () => {
    const mb = 1024 * 1024;
    const r = await render(
      <LineChart
        points={every5([102 * mb, 102 * mb + 4096, 102 * mb + 8192])}
        label="size"
        format={formatBytes}
      />);
    const ys = polylines(r.container)[0]!.trim().split(/\s+/)
      .map((pt) => Number(pt.split(',')[1]));
    // Full height is 28 units. 0.008% of the reading must stay near-flat.
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1);
    r.unmount();
  });

  /** Real movement is far above the floor and still uses the whole plot. */
  it('still scales a series that genuinely moves', async () => {
    const r = await render(
      <LineChart points={every5([100, 500, 900])} label="calls" format={formatCount} />);
    const ys = polylines(r.container)[0]!.trim().split(/\s+/)
      .map((pt) => Number(pt.split(',')[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(27);
    r.unmount();
  });

  /**
   * The range floor turned an all-zero series into an axis of
   * `0 · -0.333 · -0.667 · -1` — negative call counts, invented by scaling a
   * range around a series that has none. A shape called zero times in every
   * interval is an ordinary reading on a console that keeps 24 hours of
   * history. Flat is a fact: one label, and no numbers that are not readings.
   */
  it('states a flat series as one value, inventing no range around it', async () => {
    const r = await render(
      <LineChart points={every5([0, 0, 0, 0])} label="calls" format={formatCount} />);
    expect(r.container.textContent).not.toContain('-');
    expect(r.container.textContent).toContain('0');
    // One gridline, not four: there is nothing between the bounds.
    expect(r.container.querySelectorAll('line')).toHaveLength(1);
    r.unmount();
  });

  it('rules the value axis between its bounds, not only at them', async () => {
    const r = await render(
      <LineChart points={every5([0, 300, 900])} label="calls" format={formatCount} />);
    const lines = [...r.container.querySelectorAll('line')];
    expect(lines.length).toBeGreaterThanOrEqual(4);
    // 900 down to 0 in four evenly spaced rows: 900, 600, 300, 0.
    expect(r.container.textContent).toContain('600');
    expect(r.container.textContent).toContain('300');
    r.unmount();
  });

  /**
   * Captures are not evenly spaced — a skipped tick, a restarted scheduler and
   * a store that was down for an hour all leave holes. Positioned by index, a
   * point captured an hour after its neighbour sits the same distance along
   * as one captured five minutes after it, which makes the time axis beneath
   * the chart wrong about every point but the two ends.
   */
  it('positions a point by when it was captured, not by its place in the list', async () => {
    const r = await render(
      <LineChart
        points={[
          { at: at(0), value: 1 },
          { at: at(60), value: 2 },
          { at: at(720), value: 3 },
          { at: at(1_440), value: 4 },
        ]}
        label="calls"
        format={formatCount}
      />);
    const xs = polylines(r.container)[0]!.trim().split(/\s+/).map((p) => Number(p.split(',')[0]));
    // Twelve of the window's twenty-four hours in, the third point sits at
    // the halfway mark. Indexed, it would be two thirds of the way across.
    expect(xs[2]).toBeCloseTo(50, 0);
    expect(xs[1]).toBeCloseTo(100 / 24, 0);
    r.unmount();
  });

  /**
   * A line drawn straight across a hole asserts the values in between. The
   * same rule that makes capture write no row for an interval it could not
   * measure applies to the drawing of it.
   */
  it('breaks the line where pgops stopped capturing', async () => {
    // Four captures, then 45 minutes of nothing, then three more.
    const r = await render(
      <LineChart
        points={every5([1, 2, 3, 4, 5, 6, 7], [0, 0, 0, 0, 40, 0, 0])}
        label="calls"
        format={formatCount}
      />);
    const drawn = polylines(r.container);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]!.trim().split(/\s+/)).toHaveLength(4);
    expect(drawn[1]!.trim().split(/\s+/)).toHaveLength(3);
    r.unmount();
  });

  /**
   * And one missed tick is NOT a hole. A capture already running on another
   * replica is skipped rather than queued, so a single gap is the design
   * working — a chart that broke there would be full of holes on every
   * healthy two-replica deployment.
   */
  it('draws through a single skipped capture', async () => {
    const r = await render(
      <LineChart
        points={every5([1, 2, 3, 4, 5, 6], [0, 0, 5, 0, 0, 0])}
        label="calls"
        format={formatCount}
      />);
    expect(polylines(r.container)).toHaveLength(1);
    r.unmount();
  });

  /**
   * The axes are the reason this replaced the sparkline, and a screen reader
   * gets them in the label rather than from the drawing.
   */
  it('reads out what the series is and both of its ends', async () => {
    const r = await render(
      <LineChart points={every5([1_024, 4_096])} label="app.users size" format={formatBytes} />);
    const label = r.container.querySelector('svg')!.getAttribute('aria-label')!;
    expect(label).toContain('app.users size');
    expect(label).toContain(formatBytes(1_024));
    expect(label).toContain(formatBytes(4_096));
    r.unmount();
  });

  it('labels the value axis with the bounds of the series', async () => {
    const r = await render(
      <LineChart points={every5([40, 900, 300])} label="calls" format={formatCount} />);
    expect(r.container.textContent).toContain('900');
    expect(r.container.textContent).toContain('40');
    r.unmount();
  });

  /**
   * Relative, never absolute: this renders on the server, which does not know
   * the reader's timezone, and derived from the points rather than passed in,
   * so a window holding six hours of history says six.
   */
  it('states the span in relative time, taken from the points', async () => {
    const r = await render(
      <LineChart
        points={[{ at: at(0), value: 1 }, { at: at(360), value: 2 }]}
        label="calls"
        format={formatCount}
      />);
    expect(r.container.textContent).toContain('−6h 0m');
    expect(r.container.textContent).toContain('−3h 0m');
    expect(r.container.textContent).toContain('now');
    r.unmount();
  });
});
