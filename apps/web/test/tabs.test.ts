// Reads app/ source off disk and renders no DOM, so it does not need jsdom.
// Same per-file environment override, for the same reason, as guards.test.ts
// and scaffold.test.ts.
// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GATE_ORDER } from '@pgops/checks';
import { TABS } from '@/lib/tabs';

const APP = fileURLToPath(new URL('../app', import.meta.url));

/** Line comments first, then block comments — see guards.test.ts for why that order. */
const strip = (code: string) =>
  code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** The page file a tab's segment names. The segment IS the directory. */
const pageFor = (segment: string | null): string =>
  segment === null
    ? join(APP, 'db', '[name]', 'page.tsx')
    : join(APP, 'db', '[name]', segment, 'page.tsx');

/**
 * THE STRIP'S MODEL, HELD AGAINST THE PAGES IT DESCRIBES.
 *
 * lib/tabs.ts makes every tab declare whether it is live (`now`) or durable
 * (`explore`). A declaration nothing checks is prose in a type's clothing: it
 * would read as true under any mutation, and the whole reason the model moved
 * out of nav.tsx is that a model only written down drifts silently from the
 * thing it describes.
 *
 * So the assertion below does not compare the strip to itself. It reads each
 * tab's page off disk and asks whether `<Refresh>` is in it, which is the same
 * observable fact guards.test.ts's poll boundary already ranges over from the
 * other side — that file asserts which pages poll, this one asserts the strip
 * agrees. Both directions are silent failures on their own: an incident tab
 * declared `explore` is a page that stops updating during an incident with
 * nothing on screen saying so, and a hygiene tab declared `now` puts a catalog
 * scan on a five-second timer for as long as the browser tab is open.
 */
describe('the tab strip’s liveness model', () => {
  it('names a page that exists, for every tab', () => {
    for (const tab of TABS) {
      const page = pageFor(tab.segment);
      expect(existsSync(page), `${tab.label} points at no page: ${page}`).toBe(true);
    }
  });

  it('declares now for exactly the tabs whose page polls', () => {
    for (const tab of TABS) {
      const polls = /<Refresh\b/.test(strip(readFileSync(pageFor(tab.segment), 'utf8')));
      expect(
        polls,
        polls
          ? `${tab.label} polls, so its mode must be 'now', not '${tab.mode}'`
          : `${tab.label} does not poll, so its mode must be 'explore', not '${tab.mode}'`,
      ).toBe(tab.mode === 'now');
    }
  });

  /**
   * This list was pinned at ['Tables'] so that a second explore tab would
   * fail here and force the banding question to be asked again. Health is
   * that second tab, and the question was asked (health-over-time design,
   * 2026-10-07): banding still fails. It would be two explore tabs against
   * five live ones, with every hygiene page still sitting under a live tab,
   * so a band labelled "explore" would not contain most of what is explored.
   * The strip stays unbanded. A THIRD explore tab should fail here too.
   */
  it('has two explore tabs, and is still not banded', () => {
    expect(TABS.filter((t) => t.mode === 'explore').map((t) => t.label)).toEqual(['Tables', 'Health']);
  });

  /**
   * Every gate has somewhere to click. Pinned against `GATE_ORDER` from
   * @pgops/checks rather than against the strip's own entries: a test that
   * derived the expected gates FROM the tabs would pass under any mutation of
   * the tabs, which is the circular shape this model was moved into data to
   * avoid. Delete `gate: 'wait'` from the Locks tab and GATE_ORDER still
   * names `wait`, so this fails.
   */
  it('gives every gate exactly one tab', () => {
    expect(GATE_ORDER).toHaveLength(4);
    for (const gate of GATE_ORDER) {
      const tabs = TABS.filter((t) => t.gate === gate).map((t) => t.label);
      expect(tabs, `gate ${gate} has no tab, or more than one`).toHaveLength(1);
    }
  });

  /**
   * And the other direction: a tab declaring `gate: null` is claiming to be an
   * object page rather than a gate's destination, and that claim is checked
   * against a literal here. Deriving this list from TABS would let a route
   * promoted to the strip by mistake widen its own allowlist and pass — the
   * same hole nav.test.tsx's OBJECT_TABS exists to close. Adding a tab means
   * editing this line, which is the point.
   */
  it('carries exactly the non-gate tabs named here', () => {
    expect(TABS.filter((t) => t.gate === null).map((t) => t.label)).toEqual(['Triage', 'Tables', 'Health']);
  });
});
