import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { Bullet } from '../components/bullet.js';

const bar = (c: HTMLElement) => Array.from(c.querySelectorAll('div')).at(-1)!;

describe('Bullet', () => {
  it('draws the measure as a proportion of the scale', async () => {
    const r = await render(<Bullet value={25} max={100} />);
    expect(bar(r.container).style.width).toBe('25%');
  });

  /**
   * The bar's colour tracks the band it has entered, so the picture and the
   * badge above it cannot disagree — a bar drawn in the neutral colour under
   * a CRITICAL badge would be the console contradicting itself in the one
   * place a reader looks first.
   */
  it('takes the colour of the worst band it has reached', async () => {
    const bands = [
      { from: 80, level: 'warn' as const },
      { from: 90, level: 'critical' as const },
    ];
    const ok = await render(<Bullet value={50} max={100} bands={bands} />);
    const warn = await render(<Bullet value={85} max={100} bands={bands} />);
    const crit = await render(<Bullet value={95} max={100} bands={bands} />);
    expect(bar(ok.container).className).toContain('bg-foreground/70');
    expect(bar(warn.container).className).toContain('bg-warning');
    expect(bar(crit.container).className).toContain('bg-destructive');
  });

  /**
   * Order is not assumed. `bands` is written at the call site beside the
   * thresholds it mirrors, and nothing there guarantees critical is listed
   * last — a bar that reported `warn` for a value past the critical line
   * would understate an incident.
   */
  it('finds the critical band even when it is listed first', async () => {
    const r = await render(<Bullet value={95} max={100} bands={[
      { from: 90, level: 'critical' }, { from: 80, level: 'warn' },
    ]} />);
    expect(bar(r.container).className).toContain('bg-destructive');
  });

  /**
   * No scale, no drawing. A bar rendered against a max of zero is a picture
   * of a number nobody measured, and `max_connections` arriving as 0 from a
   * server that refused the setting is exactly the case that produces it.
   */
  it('renders nothing when there is no scale to draw against', async () => {
    expect((await render(<Bullet value={5} max={0} />)).container.querySelector('div')).toBeNull();
    expect((await render(<Bullet value={5} max={Number.NaN} />)).container.querySelector('div')).toBeNull();
  });

  it('clamps rather than overflowing when the measure exceeds the scale', async () => {
    // `used` can exceed `max` on a server whose max_connections was lowered
    // while sessions were connected. A 140%-wide bar breaks the row it sits in.
    expect(bar((await render(<Bullet value={140} max={100} />)).container).style.width).toBe('100%');
  });

  /**
   * Every value here is already rendered as text beside the bar, and the
   * thresholds are stated in words by CheckPanel's guidance. A screen reader
   * announcing the bar too would read the same fact twice.
   */
  it('is hidden from assistive technology, because it is redundant with the text', async () => {
    const r = await render(<Bullet value={25} max={100} />);
    expect(r.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});
