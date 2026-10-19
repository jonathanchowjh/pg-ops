import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { Badge } from '../components/ui/badge.js';

describe('Badge', () => {
  /**
   * shadcn's stock Badge routes through @base-ui/react's `useRender` only to
   * support a polymorphic `render` prop we never use. Ours is a plain <span>
   * that keeps every cva variant; this stops the dependency coming back.
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
