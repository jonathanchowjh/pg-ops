import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { Spark } from '@/components/spark';

describe('Spark', () => {
  it('draws one point per value', async () => {
    const r = await render(<Spark points={[1, 2, 3, 4]} label="size" />);
    const poly = r.container.querySelector('polyline');
    expect(poly).not.toBeNull();
    expect(poly!.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(4);
    r.unmount();
  });

  /**
   * A flat series has a zero range, and `(v - min) / (max - min)` is NaN.
   * An SVG with NaN coordinates renders nothing at all — a chart that
   * silently disappears for the most ordinary case there is, a relation
   * that has not changed size.
   */
  it('draws a flat series as a flat line, not as NaN', async () => {
    const r = await render(<Spark points={[500, 500, 500]} label="size" />);
    const pts = r.container.querySelector('polyline')!.getAttribute('points')!;
    expect(pts).not.toMatch(/NaN/);
    r.unmount();
  });

  it('renders nothing rather than an empty axis for no points', async () => {
    const r = await render(<Spark points={[]} label="size" />);
    expect(r.container.querySelector('polyline')).toBeNull();
    r.unmount();
  });

  it('is labelled, so it is not a picture with no caption to a screen reader', async () => {
    const r = await render(<Spark points={[1, 2]} label="size over 30 days" />);
    expect(r.container.querySelector('svg')!.getAttribute('aria-label'))
      .toBe('size over 30 days');
    r.unmount();
  });
});
