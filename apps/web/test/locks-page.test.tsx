import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Locks from '@/app/db/[name]/locks/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const waiter = (pid: number) => ({
  pid, user: 'app', app: 'web', query: 'UPDATE t SET x = 1', state: 'active', backendStart: 'w',
  waitingMode: state.waiterMode, waitingOn: 't', xactAgeSecs: 10, waitSecs: 10, waiters: [], cycle: false,
});
const state = vi.hoisted(() => ({
  backendStart: 'root-start' as string | null,
  waiterMode: 'RowExclusiveLock' as string | null,
  rootState: 'idle in transaction' as string | null,
}));

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async () => ({
    ok: true,
    data: { roots: [{
      pid: 102, user: 'app', app: 'batch', query: 'UPDATE t SET x = 2', state: state.rootState,
      backendStart: state.backendStart, waitingMode: null, waitingOn: null, xactAgeSecs: 84, waitSecs: null,
      waiters: [waiter(103)], totalWaiters: 1,
    }], truncated: false },
    verdict: { level: 'critical', note: '1 session blocked' },
    measuredAt: 0,
  })),
}));

let rendered: Rendered | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  state.backendStart = 'root-start';
  state.waiterMode = 'RowExclusiveLock';
  state.rootState = 'idle in transaction';
  rendered?.unmount();
  rendered = undefined;
});

const page = async () => render(await Locks({ params: Promise.resolve({ name: 'prod' }) }));

describe('Locks page — the root blocker can be ended here', () => {
  it('renders exactly one Terminate, on the root, when actions are on', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    rendered = await page();
    const buttons = [...rendered.container.querySelectorAll('button')].filter((b) => b.textContent === 'Terminate');
    expect(buttons).toHaveLength(1);
  });

  it('renders no Terminate when actions are off', async () => {
    rendered = await page();
    expect(rendered.text()).not.toContain('Terminate');
  });

  it('links the root pid to its row on the Sessions page', async () => {
    rendered = await page();
    expect(rendered.container.innerHTML).toContain('/db/prod/sessions#pid-102');
  });

  it('still offers the control when backendStart could not be read', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    state.backendStart = null;
    rendered = await page();
    expect(rendered.text()).toContain('Terminate');
  });
});

describe('Locks page — what each waiter wants, and the DDL amplifier', () => {
  it('says what each waiter is waiting for', async () => {
    rendered = await page();
    const t = rendered.text();
    // Two different facts, so two different verbs: how long it HAS waited, and
    // what it is waiting FOR. The draft said "waiting" for both.
    expect(t).toContain('wants RowExclusiveLock on t');
    expect(t).toContain('waiting 10s');
  });

  it('does NOT mark an ordinary row lock as a DDL amplifier', async () => {
    // The absence half. Without this, rendering the DDL warning unconditionally
    // passes every other test in this file.
    rendered = await page();
    expect(rendered.text()).not.toContain('DDL');
  });

  it('marks an ACCESS EXCLUSIVE waiter as a DDL amplifier', async () => {
    state.waiterMode = 'AccessExclusiveLock';
    rendered = await page();
    const t = rendered.text();
    expect(t).toContain('DDL — every reader behind it is queued too');
    expect(t).toContain('wants AccessExclusiveLock on t');
  });

  /**
   * The defect this test exists for: `waitingMode` is a
   * `string_agg(DISTINCT l.mode, ',')` over EVERY ungranted lock a waiter
   * wants (locks.ts), so a session queued on two different modes at once —
   * the real shape of a migration pile-up — arrives as
   * 'AccessExclusiveLock,RowExclusiveLock', not as either mode alone. An
   * exact-equality test against 'AccessExclusiveLock' misses this, making
   * the DDL marker disappear on exactly the case it exists for.
   */
  it('still marks a waiter queued on AccessExclusiveLock alongside another mode', async () => {
    state.waiterMode = 'AccessExclusiveLock,RowExclusiveLock';
    rendered = await page();
    const t = rendered.text();
    expect(t).toContain('DDL — every reader behind it is queued too');
  });

  it("labels an idle-in-transaction root's statement as its last, not its current", async () => {
    rendered = await page();
    expect(rendered.text()).toContain('last statement (transaction idle)');
  });

  it('does NOT label an active root\'s statement as its last', async () => {
    // The other absence half, for the same reason.
    state.rootState = 'active';
    rendered = await page();
    expect(rendered.text()).not.toContain('last statement');
  });
});
