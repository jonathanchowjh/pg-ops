import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Cleanup from '@/app/db/[name]/cleanup/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { overrides } = vi.hoisted(() => ({ overrides: new Map<string, unknown>() }));

const ok = (data: unknown, verdict: unknown = null) => ({ ok: true, data, verdict, measuredAt: 0 });

const HEALTHY: Record<string, unknown> = {
  wraparound: {
    worst: [{
      database: 'prod', xactAge: 1_000_000,
      txnsUntilShutdown: 2_146_483_647, pctToForcedVacuum: 1,
    }],
  },
  replicationLag: { inRecovery: false, lagSeconds: null, standbys: 0 },
  slots: { slots: [] },
  settings: {
    main: [{ name: 'shared_buffers', value: '128MB' }, { name: 'work_mem', value: '4MB' }],
    autovacuum: [{ name: 'autovacuum', value: 'on' }],
    vacuum: [{ name: 'vacuum_cost_limit', value: '200' }],
  },
};

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) =>
    overrides.get(check.id) ?? ok(HEALTHY[check.id] ?? {})),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => null,
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  overrides.clear();
  vi.clearAllMocks();
});

const page = async () => {
  const element = await Cleanup({ params: Promise.resolve({ name: 'prod' }) });
  rendered = await render(element);
  return rendered;
};

describe('the cleanup page', () => {
  it('renders the three checks the keep-up gate owns', async () => {
    const out = (await page()).container.innerHTML;
    expect(out).toContain('Wraparound');
    expect(out).toContain('Role and lag');
    expect(out).toContain('Replication slots');
  });

  /**
   * The README's stated divergence from pgHero, held at the page rather than
   * only in the check. pgHero answers 0 for a primary, which on a dashboard
   * reads as "perfectly caught up" — a claim about replication health made
   * about a server that is not replicating. `lagSeconds: null` on a primary
   * means the question does not apply, and the page must not format it.
   */
  it('renders a primary as a primary, never as zero seconds behind', async () => {
    const r = await page();
    expect(r.text()).toContain('primary');
    expect(r.text()).not.toMatch(/\b0s\b|0 seconds/);
  });

  /**
   * A standby that HAS replayed is the case that must still print a number —
   * without this, "never render a lag" passes by rendering nothing ever.
   */
  it('still reports a real lag when the server is a standby', async () => {
    overrides.set('replicationLag', ok({ inRecovery: true, lagSeconds: 12, standbys: 0 }));
    const r = await page();
    expect(r.text()).toContain('standby');
    expect(r.text()).toContain('12s');
  });

  it('distinguishes a standby that has replayed nothing from one that is caught up', async () => {
    overrides.set('replicationLag', ok({ inRecovery: true, lagSeconds: null, standbys: 0 }));
    const r = await page();
    expect(r.text()).toContain('nothing replayed yet');
  });

  it('links every hygiene sub-route', async () => {
    const hrefs = [...(await page()).container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('/db/prod/cleanup/space');
    expect(hrefs).toContain('/db/prod/cleanup/maintenance');
    expect(hrefs).toContain('/db/prod/cleanup/sequences');
  });

  /**
   * This is the one page in P2 that legitimately polls: it renders
   * `class: 'incident'` checks and must stay current during an incident,
   * while its sub-routes run catalog scans on visit and must not.
   * test/guards.test.ts holds the same fact from the other direction.
   */
  it('polls, because the checks it renders are incident checks', async () => {
    // Asserted through what <Refresh> actually RENDERS — its control and its
    // pre-first-tick readout — rather than through the source text, which is
    // guards.test.ts's job. The two are different facts: the guard says the
    // element appears in this file, this says the component mounted here.
    const r = await page();
    const buttons = [...r.container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Refresh');
    expect(r.text()).toContain('live');
  });

  /**
   * #56 lands here rather than in app/db/[name]/layout.tsx, where StatusBar
   * renders. That layout is shared by the four incident pages and
   * router.refresh() re-renders layouts, so a pg_settings read there would
   * sit behind the 5-second poll — the load §4.2's poll boundary exists to
   * prevent. This is the one keep-up page, and it does not poll settings.
   */
  it('renders the settings disclosure with all three groups', async () => {
    const r = await page();
    expect(r.text()).toContain('Settings');
    expect(r.text()).toContain('Autovacuum');
    expect(r.text()).toContain('Vacuum');
    expect(r.text()).toContain('shared_buffers');
    expect(r.text()).toContain('128MB');
    expect(r.text()).toContain('vacuum_cost_limit');
  });

  /**
   * The value is the SHOW-equivalent, so it carries its own unit. A page that
   * rendered `setting` plus `unit` would print `16384 8kB`; one that rendered
   * `setting` alone would print a number 8192 times too small.
   */
  it('prints a memory setting the way an operator would paste it back', async () => {
    const r = await page();
    expect(r.text()).not.toContain('16384');
    expect(r.text()).not.toContain('8kB');
  });

  it('starts the disclosure closed, so settings do not push findings below the fold', async () => {
    const r = await page();
    const details = r.container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.hasAttribute('open')).toBe(false);
  });

  /**
   * A failed settings read still renders the disclosure, with the reason
   * inside it. Omitting the section would make a permission error
   * indistinguishable from a build that never had the feature.
   */
  it('keeps the disclosure and states the reason when settings could not be read', async () => {
    overrides.set('settings', {
      ok: false, reason: 'privilege', message: 'permission denied for view pg_settings',
    });
    const r = await page();
    expect(r.container.querySelector('details')).not.toBeNull();
    expect(r.text()).toContain('permission denied for view pg_settings');
  });

  it('says why a check could not run instead of rendering it empty', async () => {
    overrides.set('slots', {
      ok: false, reason: 'privilege',
      message: 'permission denied for view pg_replication_slots',
    });
    const out = (await page()).container.innerHTML;
    expect(out).toContain('permission denied for view pg_replication_slots');
    expect(out).not.toContain('None configured.');
  });
});
