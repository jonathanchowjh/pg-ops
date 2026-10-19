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

  it('links a backend pinning the horizon to the session that can end it', async () => {
    overrides.set('horizon', ok({
      holders: [{
        kind: 'backend', who: '4021', xminAge: 60_000_000, ageSecs: 900,
        detail: 'batch-worker · idle in transaction',
      }],
      truncated: false,
    }, { level: 'warn', note: 'backend 4021 pins the horizon 60000000 transactions back, open 15m' }));
    const r = await page();
    const link = r.container.querySelector('a[href="/db/prod#pid-4021"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe('4021');
    expect(r.text()).toContain('batch-worker');
  });

  /** Asserted in both directions: a note that always renders is as wrong as one that never does. */
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
   * `lagSeconds: null` on a primary means the question does not apply; a
   * formatted 0 would read as "perfectly caught up".
   */
  it('renders a primary as a primary, never as zero seconds behind', async () => {
    const r = await page();
    expect(r.text()).toContain('primary');
    expect(r.text()).not.toMatch(/\b0s\b|0 seconds/);
  });

  /** Without this, the test above passes by never rendering a lag at all. */
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

  /** This page renders `class: 'live'` checks and must stay current. */
  it('polls, because the checks it renders are live checks', async () => {
    // Asserts that <Refresh> mounted; guards.test.ts checks the source text.
    const r = await page();
    const buttons = [...r.container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Refresh');
    expect(r.text()).toContain('live');
  });

  /**
   * Settings live here, not in app/db/[name]/layout.tsx: router.refresh()
   * re-renders layouts, so a pg_settings read there would sit behind the
   * 5-second poll.
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

  /** Omitting the section would make a permission error look like a missing feature. */
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

/** `replicationLag` carries no threshold; the standbys check is what escalates a lagging standby. */
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
   * A role without pg_monitor reads another user's walsender as NULL; that
   * renders as an em dash, never as zero.
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

  /** Uses `CheckPanel`'s own UNAVAILABLE rendering, like every other panel on this page. */
  it('does not read as "no standbys" when the standby detail could not be read', async () => {
    overrides.set('standbys', { ok: false, reason: 'privilege', message: 'permission denied' });
    const r = await page();
    expect(r.text()).toContain('UNAVAILABLE');
    expect(r.text()).toContain('permission denied');
    expect(r.text()).not.toContain('No standbys are streaming');
  });

  /**
   * `lagSeconds: 0` means "replayed everything received", which is also what
   * a dead walreceiver looks like.
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
 * "Role and lag" and "Standbys" would otherwise both state the standby count.
 * The Standbys panel owns it when it can run. It requires pg_monitor and
 * `replicationLag` does not, so without that role "Role and lag" is the only
 * source and must report the count itself.
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
    expect(t).toContain('2 streaming');
  });

  it('never launders an unreadable count into zero', async () => {
    overrides.set('replicationLag', ok({ inRecovery: false, lagSeconds: null, standbys: null, receiving: null }));
    overrides.set('standbys', { ok: false, reason: 'privilege', message: 'permission denied' });
    expect((await page()).text()).toContain('standbys unknown');
  });
});
