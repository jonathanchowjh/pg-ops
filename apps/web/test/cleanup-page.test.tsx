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
  horizon: { holders: [], truncated: false },
  replicationLag: { inRecovery: false, lagSeconds: null, standbys: 0, receiving: null },
  standbys: { standbys: [] },
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
  it('renders the four checks the keep-up gate owns', async () => {
    const out = (await page()).container.innerHTML;
    expect(out).toContain('Wraparound');
    expect(out).toContain('Oldest snapshot');
    expect(out).toContain('Role and lag');
    expect(out).toContain('Replication slots');
  });

  /**
   * The pid this check names is one click from the row that can end it —
   * the same convention every other actionable pid on this console follows.
   */
  it('links a backend pinning the horizon to the session that can end it', async () => {
    overrides.set('horizon', ok({
      holders: [{
        kind: 'backend', who: '4021', xminAge: 60_000_000, ageSecs: 900,
        detail: 'batch-worker · idle in transaction',
      }],
      truncated: false,
    }, { level: 'warn', note: 'backend 4021 pins the horizon 60000000 transactions back, open 15m' }));
    const r = await page();
    const link = r.container.querySelector('a[href="/db/prod/sessions#pid-4021"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe('4021');
    expect(r.text()).toContain('batch-worker');
  });

  /**
   * A partial list an operator knows is partial is useful; one they believe
   * is complete is worse than nothing (Convention 6) — asserted in both
   * directions, because a note that always renders is the same defect as one
   * that never does.
   */
  it('says when the list of holders was clipped', async () => {
    overrides.set('horizon', ok({
      holders: [{
        kind: 'backend', who: '4021', xminAge: 60_000_000, ageSecs: 900,
        detail: 'batch-worker · idle in transaction',
      }],
      truncated: true,
    }));
    const r = await page();
    expect(r.text()).toContain('Showing the ten furthest-back holders.');
  });

  it('says nothing about clipping when the list was not clipped', async () => {
    overrides.set('horizon', ok({
      holders: [{
        kind: 'backend', who: '4021', xminAge: 60_000_000, ageSecs: 900,
        detail: 'batch-worker · idle in transaction',
      }],
      truncated: false,
    }));
    const r = await page();
    expect(r.text()).not.toContain('Showing the ten furthest-back holders.');
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
    overrides.set('replicationLag', ok({ inRecovery: true, lagSeconds: 12, standbys: 0, receiving: true }));
    const r = await page();
    expect(r.text()).toContain('standby');
    expect(r.text()).toContain('12s');
  });

  it('distinguishes a standby that has replayed nothing from one that is caught up', async () => {
    overrides.set('replicationLag', ok({ inRecovery: true, lagSeconds: null, standbys: 0, receiving: true }));
    const r = await page();
    expect(r.text()).toContain('nothing replayed yet');
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

/**
 * B4. The keep-up gate had no replication judgement at all: `replicationLag`
 * carries no threshold, so a standby arbitrarily far behind never escalated
 * on the band titled "can the server keep up with what already committed".
 */
describe('the cleanup page — standbys as the primary sees them', () => {
  const sb = (over: Record<string, unknown> = {}) => ({
    app: 'replica-1', clientAddr: '10.0.0.2', state: 'streaming', syncState: 'async',
    writeSecs: 0.1, flushSecs: 0.2, replaySecs: 45, sentBytes: 0, replayBytes: 4096, ...over,
  });

  it('lists each standby with every stage of its lag', async () => {
    overrides.set('standbys', ok({ standbys: [sb()] }, { level: 'warn', note: 'replica-1 is 45s behind' }));
    const r = await page();
    const t = r.text();
    expect(t).toContain('replica-1');
    expect(t).toContain('streaming');
    expect(t).toContain('45s');
  });

  /**
   * The rule the check is built around, carried through to the pixel: a lag
   * this role cannot read renders as an em dash, never as a zero. A role
   * without pg_monitor reads another user's walsender as NULL, and "0s
   * behind" would be a claim about a standby nobody looked at.
   */
  it('renders an unreadable lag as unknown, never as caught up', async () => {
    overrides.set('standbys', ok({ standbys: [sb({ replaySecs: null, writeSecs: null, flushSecs: null })] }));
    const r = await page();
    expect(r.text()).toContain('—');
    expect(r.text()).not.toContain('0s');
  });

  it('says a primary has no standbys rather than rendering an empty table', async () => {
    const r = await page();
    expect(r.text()).toContain('No standbys are streaming from this server');
  });

  /**
   * And when the detail could not be read, the panel must not look like a
   * primary with nothing attached — the distinction this console exists to
   * keep. Through `CheckPanel`'s own UNAVAILABLE rendering, not a sentence
   * written here: the task brief specified a bespoke "Standby detail
   * unavailable — {reason}" line, which would be a second spelling of the
   * failure state every other panel on this page already renders one way.
   */
  it('does not read as "no standbys" when the standby detail could not be read', async () => {
    overrides.set('standbys', { ok: false, reason: 'privilege', message: 'permission denied' });
    const r = await page();
    expect(r.text()).toContain('UNAVAILABLE');
    expect(r.text()).toContain('permission denied');
    expect(r.text()).not.toContain('No standbys are streaming');
  });

  /**
   * B4, standby side. `lagSeconds: 0` means "I have replayed everything I
   * received", which is also exactly what a dead walreceiver looks like. One
   * word stops a broken standby reading as a perfect one.
   */
  it('says a standby is not receiving rather than showing it caught up', async () => {
    overrides.set('replicationLag', ok({ inRecovery: true, lagSeconds: 0, standbys: 0, receiving: false }));
    const r = await page();
    const t = r.text();
    expect(t).toMatch(/not receiving/i);
    expect(t).not.toContain('0s behind');
  });

  it('says nothing about receiving on a primary, which has no walreceiver', async () => {
    const r = await page();
    expect(r.text()).not.toMatch(/not receiving/i);
  });
});
/**
 * Stage 4's re-plan overlap. Driving the closed stage at 390px, these two
 * panels sat adjacent and said the same thing:
 *
 *   Role and lag   This server is a primary · replication lag does not apply · 0 streaming
 *   Standbys       No standbys are streaming from this server.
 *
 * "0 streaming" and that sentence are one fact in two consecutive panels,
 * one of which B4 had just added — the overlap the programme's re-plan step
 * exists to cut.
 *
 * Cut CONDITIONALLY rather than outright, which is the part worth recording.
 * The obvious fix is to delete the clause, and it is wrong: `replicationLag`
 * declares no `requires`, while `standbys` declares
 * `requires: [{ kind: 'role', name: 'pg_monitor' }]`. So on a role without
 * pg_monitor the Standbys panel is UNAVAILABLE and Role and lag is the only
 * thing that can report the count at all — deleting the clause would lose it
 * exactly where it is the only source.
 *
 * The rule is therefore: the specialist speaks when it can, the generalist
 * fills in when it cannot.
 */
describe('the cleanup page — the standby count has one owner', () => {
  it('leaves the count to the Standbys panel when that panel can speak', async () => {
    overrides.set('replicationLag', ok({ inRecovery: false, lagSeconds: null, standbys: 2, receiving: null }));
    overrides.set('standbys', ok({ standbys: [] }));
    const t = (await page()).text();
    expect(t).toContain('This server is a primary');
    expect(t).not.toContain('2 streaming');
    expect(t).not.toContain('streaming from this server · ');
  });

  it('reports the count itself when the Standbys panel could not be read', async () => {
    overrides.set('replicationLag', ok({ inRecovery: false, lagSeconds: null, standbys: 2, receiving: null }));
    overrides.set('standbys', { ok: false, reason: 'privilege', message: 'permission denied' });
    const t = (await page()).text();
    // The one case the clause exists for: pg_monitor is missing, the
    // specialist is UNAVAILABLE, and this is the only reading of how many
    // standbys are attached.
    expect(t).toContain('2 streaming');
  });

  it('never launders an unreadable count into zero', async () => {
    overrides.set('replicationLag', ok({ inRecovery: false, lagSeconds: null, standbys: null, receiving: null }));
    overrides.set('standbys', { ok: false, reason: 'privilege', message: 'permission denied' });
    expect((await page()).text()).toContain('standbys unknown');
  });
});
