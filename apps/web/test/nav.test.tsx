import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import { Nav } from '@/components/nav';
import { GATES, GATE_ORDER } from '@pgops/checks';
import { TABS } from '@/lib/tabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => null,
}));

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; });

/**
 * The gate -> tab href, read from the strip's own model in lib/tabs.ts.
 *
 * This was a second copy of that mapping, written out here because the model
 * used to be a local const inside nav.tsx where no test could import it. Two
 * of the four gate titles are not their segment ("Replication & cleanup" ->
 * "cleanup"), so deriving the mapping from the TITLE is what produced a test
 * that could not pass — which is why a copy was made rather than a derivation.
 * Now each tab declares its gate, so this reads the declaration.
 *
 * The claim these tests make is still not circular: `GATE_ORDER` comes from
 * @pgops/checks, so the loop below ranges over the gates the checks package
 * defines, not over whatever the strip happens to contain. A gate with no tab
 * throws here; tabs.test.ts asserts the same property against the data alone.
 */
const hrefFor = (gate: (typeof GATE_ORDER)[number]): string => {
  const tab = TABS.find((t) => t.gate === gate);
  if (tab === undefined) throw new Error(`no tab declares gate ${gate}`);
  return `/db/prod${tab.href}`;
};

/**
 * The object layer's tabs — the ones on the strip that are deliberately NOT
 * a gate. Hoisted out of the allowlist test below so the two tests that
 * care about this list, the one that widens it and the one that requires
 * it, read from the same array and cannot drift apart from each other.
 */
const OBJECT_TABS = ['/db/prod/tables', '/db/prod/health'];

describe('Nav', () => {
  it('links the cleanup tab', async () => {
    rendered = await render(<Nav name="prod" />);
    expect(rendered.container.innerHTML).toContain('/db/prod/cleanup');
  });

  /**
   * The property gates.ts calls the organising idea: every gate has a tab.
   * Matched by HREF SEGMENT, not by label text — the keep-up gate's title is
   * "Replication & cleanup" while its tab reads "Cleanup", and a naive
   * first-word match on the title asserts "Replication", which is not on the
   * page at all.
   */
  it('has a tab for every gate', async () => {
    rendered = await render(<Nav name="prod" />);
    const hrefs = [...rendered.container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '');
    expect(GATE_ORDER).toHaveLength(4);
    for (const gate of GATE_ORDER) {
      expect(hrefs, `gate ${gate} (${GATES[gate].title}) has no tab`).toContain(hrefFor(gate));
    }
  });

  /**
   * REWRITTEN, NOT DELETED. The old form asserted that the tab strip carried
   * the four gates and nothing else, which was gates.ts's claim and stopped
   * being true on purpose — see the design of 2026-09-23 §4, which names this
   * as the consequence to accept. What survives is the property that actually
   * protects the strip: nothing appears on it by accident. Every tab is
   * either a gate or a named member of the object layer, and a route promoted
   * to the top level by mistake is neither.
   */
  it('carries only gates and the object pages named here', async () => {
    rendered = await render(<Nav name="prod" />);
    const hrefs = [...rendered.container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '');
    const gates = GATE_ORDER.map(hrefFor);
    expect(hrefs.filter((h) => !new Set([...gates, ...OBJECT_TABS]).has(h))).toEqual(['/db/prod']);
  });

  /**
   * The allowlist test above only ever WIDENS when a tab is named in
   * OBJECT_TABS — it has nothing to say about whether that tab is actually
   * on the page. Delete the Tables entry from TABS and the allowlist test
   * keeps passing, because an allowlist with one fewer thing to match
   * against is not a shorter list of hrefs, it just has one item that never
   * gets used. This is the other half: it fails the moment an object tab
   * this file names stops being rendered.
   */
  it('gives the object layer a tab of its own', async () => {
    rendered = await render(<Nav name="prod" />);
    const hrefs = [...rendered.container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '');
    for (const href of OBJECT_TABS) {
      expect(hrefs, `object tab ${href} is missing`).toContain(href);
    }
  });

  /**
   * jsdom computes no layout: there is no box, no viewport, no line-breaking,
   * so nothing here can observe the strip wrapping, overflowing, or measuring
   * 469px wide, the same limit the allowlist test above lives with. What this
   * assertion can do is lock the class that wrapping actually depends on —
   * delete `flex-wrap` from nav.tsx and this fails, the way deleting the
   * Tables tab fails the test above it. The real evidence that the strip
   * wraps instead of scrolling the phone sideways is the measured viewport
   * numbers recorded in this task's commit message, not anything jsdom can
   * check.
   */
  it('keeps the wrap class the phone-width layout depends on', async () => {
    rendered = await render(<Nav name="prod" />);
    expect(rendered.container.querySelector('nav')!.className).toContain('flex-wrap');
  });
});
