import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import { SubNav } from '@/components/sub-nav';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mutable so the null case — the tab's own landing page — is reachable.
// `vi.mock` replaces the WHOLE module and is hoisted above ordinary consts,
// so the state has to come from `vi.hoisted`; queries-page.test.tsx does the
// same for its row fixtures.
const { segmentState } = vi.hoisted(() => ({
  segmentState: { value: 'indexes' as string | null },
}));

// SubNav calls useSelectedLayoutSegment unconditionally; without this there
// is no router context and the render throws.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => segmentState.value,
}));

const ITEMS = [
  { segment: 'indexes', label: 'Indexes' },
  { segment: 'tables', label: 'Tables' },
] as const;

let rendered: Rendered | undefined;
beforeEach(() => { segmentState.value = 'indexes'; });
afterEach(() => { rendered?.unmount(); rendered = undefined; });

describe('SubNav', () => {
  it('links each item under the tab it belongs to', async () => {
    rendered = await render(<SubNav name="prod" base="queries" items={ITEMS} />);
    // hrefs are attributes, so assert on innerHTML — text() is textContent
    // and will never contain them.
    const html = rendered.container.innerHTML;
    expect(html).toContain('/db/prod/queries/indexes');
    expect(html).toContain('/db/prod/queries/tables');
  });

  /**
   * The landing page must stay reachable. Without this link an operator who
   * clicks into Indexes can only get back with the browser's back button,
   * and the tab looks replaced rather than extended.
   */
  it('links back to the tab itself', async () => {
    rendered = await render(<SubNav name="prod" base="queries" items={ITEMS} />);
    expect(rendered.container.querySelector('a[href="/db/prod/queries"]')).not.toBeNull();
  });

  it('marks the active sub-route', async () => {
    rendered = await render(<SubNav name="prod" base="queries" items={ITEMS} />);
    const active = rendered.container.querySelector('[aria-current="page"]');
    expect(active?.getAttribute('href')).toBe('/db/prod/queries/indexes');
  });

  /**
   * `null` is the segment on the tab's own page, and it must mark the
   * Overview entry rather than nothing. A strip where no entry is current on
   * the page you are actually looking at answers "where am I?" with silence,
   * which is the defect Nav was changed to fix.
   */
  it('marks the tab itself when there is no sub-segment', async () => {
    segmentState.value = null;
    rendered = await render(<SubNav name="prod" base="queries" items={ITEMS} />);
    const current = rendered.container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('href')).toBe('/db/prod/queries');
  });

  /** Exactly one entry is current, whichever entry that is. */
  it('never marks two entries at once', async () => {
    rendered = await render(<SubNav name="prod" base="queries" items={ITEMS} />);
    expect(rendered.container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it('renders every label', async () => {
    rendered = await render(<SubNav name="prod" base="queries" items={ITEMS} />);
    expect(rendered.text()).toContain('Indexes');
    expect(rendered.text()).toContain('Tables');
  });

});
