import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import { Nav } from '@/components/nav';
import { GATES, GATE_ORDER } from '@pgops/checks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => null,
}));

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; });

/**
 * The gate -> tab segment map, declared here rather than derived from the
 * title. Two of the four titles are not their segment ("Replication &
 * cleanup" -> "cleanup"), so deriving it is what produced a test that could
 * not pass. If a gate is ever added, this map fails to compile.
 */
const GATE_TAB: Record<(typeof GATE_ORDER)[number], string> = {
  connect: 'sessions',
  wait: 'locks',
  work: 'queries',
  'keep-up': 'cleanup',
};

/**
 * The object layer's tabs — the ones on the strip that are deliberately NOT
 * a gate. Hoisted out of the allowlist test below so the two tests that
 * care about this list, the one that widens it and the one that requires
 * it, read from the same array and cannot drift apart from each other.
 */
const OBJECT_TABS = ['/db/prod/tables'];

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
      const segment = GATE_TAB[gate];
      expect(
        hrefs.some((h) => h === `/db/prod/${segment}` || (segment === '' && h === '/db/prod')),
        `gate ${gate} (${GATES[gate].title}) has no tab`,
      ).toBe(true);
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
    const gates = GATE_ORDER.map((g) => (GATE_TAB[g] === '' ? '/db/prod' : `/db/prod/${GATE_TAB[g]}`));
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
});
