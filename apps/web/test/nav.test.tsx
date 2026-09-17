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
   * The tab strip carries exactly the gates and nothing else. Without this,
   * a stray tab — a hygiene route promoted to the top level by mistake —
   * satisfies "every gate has a tab" while quietly breaking the claim
   * gates.ts actually makes, which is that the four tabs ARE the four gates.
   */
  it('carries no tab that is not a gate', async () => {
    rendered = await render(<Nav name="prod" />);
    const hrefs = [...rendered.container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '');
    const allowed = new Set(
      GATE_ORDER.map((g) => (GATE_TAB[g] === '' ? '/db/prod' : `/db/prod/${GATE_TAB[g]}`)),
    );
    expect(hrefs.filter((h) => !allowed.has(h))).toEqual(['/db/prod']);
  });
});
