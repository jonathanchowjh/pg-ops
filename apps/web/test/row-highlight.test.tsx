import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, type Rendered } from './render.js';
import { HighlightedRow, pidFromHash } from '@/components/row-highlight';

// A mutable hoisted binding rather than a constant closure, unlike the mock
// in sessions-page.test.tsx and sessions-fold.test.tsx: THIS file exercises
// what happens when the pathname itself changes across a rerender of an
// already-mounted HighlightedRow, so `usePathname` must be able to return a
// different value on the second read without remounting anything.
const nav = vi.hoisted(() => ({ pathname: '/db/prod/sessions' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  window.location.hash = '';
  window.history.replaceState(null, '', '/');
  nav.pathname = '/db/prod/sessions';
});

describe('pidFromHash', () => {
  it('reads the pid out of a pid fragment', () => {
    expect(pidFromHash('#pid-4511')).toBe(4511);
  });
  it('is null for anything else', () => {
    expect(pidFromHash('')).toBeNull();
    expect(pidFromHash('#pid-')).toBeNull();
    expect(pidFromHash('#pid-abc')).toBeNull();
    expect(pidFromHash('#section-4511')).toBeNull();
  });
});

describe('HighlightedRow', () => {
  it('marks the row whose pid is in the fragment, without relying on :target', async () => {
    window.location.hash = '#pid-7';
    rendered = await render(
      <table><tbody>
        <HighlightedRow pid={7}><td>seven</td></HighlightedRow>
        <HighlightedRow pid={8}><td>eight</td></HighlightedRow>
      </tbody></table>,
    );
    const rows = [...rendered.container.querySelectorAll('tr')];
    expect(rows[0]!.className).toContain('bg-warning-surface');
    expect(rows[1]!.className).not.toContain('bg-warning-surface');
    expect(rows[0]!.getAttribute('id')).toBe('pid-7');
  });

  it('follows the fragment when it changes without a page load', async () => {
    window.location.hash = '#pid-7';
    rendered = await render(
      <table><tbody>
        <HighlightedRow pid={7}><td>seven</td></HighlightedRow>
        <HighlightedRow pid={8}><td>eight</td></HighlightedRow>
      </tbody></table>,
    );
    await act(async () => {
      window.location.hash = '#pid-8';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const rows = [...rendered.container.querySelectorAll('tr')];
    expect(rows[0]!.className).not.toContain('bg-warning-surface');
    expect(rows[1]!.className).toContain('bg-warning-surface');
  });

  it('marks nothing when there is no fragment', async () => {
    rendered = await render(
      <table><tbody><HighlightedRow pid={7}><td>seven</td></HighlightedRow></tbody></table>,
    );
    expect(rendered.container.querySelector('tr')!.className).not.toContain('bg-warning-surface');
  });

  /**
   * Pins the `pathname` entry in `useHighlightedPid`'s dependency array.
   *
   * A History-API navigation between two instances of the SAME route
   * pattern (e.g. `/db/prod/sessions` → `/db/other/sessions`) can update an
   * already-mounted `HighlightedRow` without unmounting it and without
   * firing `hashchange` — neither the mount read nor the hashchange
   * listener sees that. Rerendering the same element tree with both the
   * hash and the mocked pathname changed, and no unmount and no
   * `hashchange` dispatch in between, is what that navigation looks like
   * from inside the component.
   */
  it('re-reads the fragment when the route changes without an unmount or a hashchange', async () => {
    // Each call below builds a FRESH element tree rather than reusing one
    // JSX literal: `root.render` bails out of reprocessing a subtree when
    // the incoming element is referentially identical to the one already
    // committed, which would silently make this test pass — or fail to
    // exercise the effect at all — regardless of the dependency array.
    const tree = () => (
      <table><tbody>
        <HighlightedRow pid={7}><td>seven</td></HighlightedRow>
        <HighlightedRow pid={8}><td>eight</td></HighlightedRow>
      </tbody></table>
    );
    window.location.hash = '#pid-7';
    rendered = await render(tree());
    let rows = [...rendered.container.querySelectorAll('tr')];
    expect(rows[0]!.className).toContain('bg-warning-surface');

    // `history.replaceState`, not `window.location.hash = ...`: jsdom 29
    // (this repo's pinned version, confirmed by running it directly)
    // DOES queue a `hashchange` event for a hash assignment, only
    // asynchronously, on the timer/macrotask phase — after this test's
    // `await act(...)` chain, which drains microtasks only, has already
    // taken its assertions. That queued event happening to land before the
    // assertions run — on a jsdom version bump, or any future `await` in
    // this test that yields to the timer phase — would let the
    // `hashchange` listener move the highlight and pass this test with the
    // `pathname` dependency deleted, which is exactly the hollow-test shape
    // this test exists to rule out. `replaceState` never fires
    // `hashchange` at all — specified behaviour, not a jsdom detail — so no
    // event is ever queued and the `pathname` dependency is the only thing
    // that can move the highlight here. It is also the more faithful
    // reproduction: the History API is what the App Router actually uses to
    // change the URL, which is the reason `:target` failed and this
    // component exists in the first place.
    window.history.replaceState(null, '', '/db/other/sessions#pid-8');
    nav.pathname = '/db/other/sessions';
    await rendered.rerender(tree());

    rows = [...rendered.container.querySelectorAll('tr')];
    expect(rows[0]!.className).not.toContain('bg-warning-surface');
    expect(rows[1]!.className).toContain('bg-warning-surface');
  });
});
