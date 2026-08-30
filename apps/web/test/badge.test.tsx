import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { Badge } from '../components/ui/badge.js';

describe('Badge', () => {
  /**
   * shadcn's stock Badge routes through @base-ui/react's `useRender` purely to
   * support a polymorphic `render` prop. When this was written that package
   * hoisted to the repo ROOT next to the Ink TUI's react 18, so its hooks ran
   * against react 18's dispatcher while the tree rendered under the app's
   * react 19 — every render threw "Cannot read properties of null (reading
   * 'useRef')". P1b deleted the TUI and that mis-resolution with it, so the
   * assertion below now rests on the second reason rather than the first.
   *
   * shadcn vendors component SOURCE into the repo rather than installing a
   * package; that is the whole reason for choosing it. So the fix is to own
   * the file: a plain <span> keeps every cva variant (the actual value here)
   * and drops the primitive we never use. This test is what stops the
   * dependency being reintroduced.
   */
  it('renders its text without a runtime primitive library', async () => {
    const r = await render(<Badge>CRITICAL</Badge>);
    expect(r.text()).toBe('CRITICAL');
    r.unmount();
  });

  it('applies the variant class it was asked for', async () => {
    const r = await render(<Badge variant="destructive">WARN</Badge>);
    expect(r.container.querySelector('span')?.className).toContain('destructive');
    r.unmount();
  });
});
