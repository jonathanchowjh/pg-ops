import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Triage from '@/app/db/[name]/page';
import { GATES, GATE_ORDER } from '@pgops/checks';

// Per-file requirement — see kill-button.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'all-alike' | 'all-different' | 'one-critical' | 'lock-incident' | 'mixed-slow',
}));

// Same shim the other page tests use: <Refresh> calls useRouter() on its
// render path, and there is no app router mounted in a unit test.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) => {
    if (state.mode === 'all-alike') {
      // What a missing database looks like: every check fails identically,
      // because none of them ever got a connection.
      return { ok: false, reason: 'unreachable', message: 'database "gone" does not exist' };
    }
    if (state.mode === 'all-different') {
      // Every check failed, but for its OWN reason — a role denied some
      // catalogs, an extension missing for others. Nine different sentences.
      return { ok: false, reason: 'denied', message: `permission denied for ${check.id}` };
    }
    // Shapes are per-check; the panels only read fields when ok, and these
    // render through the same children callbacks the page defines.
    const data: Record<string, any> = {
      connections: { used: 5, max: 100, headroom: 95 },
      sessionStates: {
        // Deliberately uneven value labels: "17 · 2s" against "6 · 6m 17s" is
        // the exact width difference that broke the shared baseline.
        byState: [
          { state: 'idle', sessions: 17, longestInStateSecs: 2 },
          { state: 'active', sessions: 6, longestInStateSecs: 377 },
          { state: 'idle in transaction', sessions: 1, longestInStateSecs: 377 },
        ],
        oldestIdleInTxnSecs: null,
      },
      blocked: { count: 0, longestQueryAgeSecs: null, suspectPid: null },
      longRunning: { queries: [] },
      locks: { roots: [], truncated: false },
      wraparound: { worst: [] },
      slots: { slots: [] },
      queryStats: { rows: [], totalShapes: 0, sort: 'total', statsResetAt: null },
      replicationLag: { inRecovery: false, lagSeconds: null, standbys: 0 },
    };
    if (state.mode === 'one-critical' && check.id === 'sessionStates') {
      return {
        ok: true,
        data: data.sessionStates,
        verdict: { level: 'warn', note: 'idle in transaction for 377s' },
        crossed: {
          level: 'warn', value: 60, unit: 'seconds',
          because: 'a transaction idle for a minute is holding row locks',
        },
        measuredAt: 0,
      };
    }
    // A real lock chain: 9401 holds, 9403 queues behind it, 9402 queues
    // behind 9403. Both waiters are `state = 'active'` in pg_stat_activity,
    // so `longRunning` returns them too — which is the whole point.
    if (state.mode === 'lock-incident' || state.mode === 'mixed-slow') {
      if (check.id === 'blocked') {
        return {
          ok: true,
          data: { count: 2, longestQueryAgeSecs: 1115, suspectPid: 9403 },
          verdict: { level: 'critical', note: '2 session(s) blocked' },
          crossed: {
            level: 'critical', value: 60, unit: 'seconds',
            because: 'past a minute of query age, most client timeouts have already fired',
            remedy: 'Treat this as an outage in progress.',
          },
          measuredAt: 0,
        };
      }
      if (check.id === 'locks') {
        const leaf = {
          pid: 9402, user: 'postgres', app: 'web-api', state: 'active',
          query: 'UPDATE users SET n = n + 1 WHERE id = 1',
          waitingMode: 'ExclusiveLock', waitingOn: 'tuple', xactAgeSecs: 1115,
          waitSecs: 1115, cycle: false, waiters: [],
        };
        return {
          ok: true,
          data: {
            roots: [{
              pid: 9401, user: 'postgres', app: 'batch-worker', state: 'idle in transaction',
              query: 'UPDATE users SET n = n + 1 WHERE id = 1',
              waitingMode: null, waitingOn: null, xactAgeSecs: 1115, waitSecs: null,
              totalWaiters: 2,
              waiters: [{ ...leaf, pid: 9403, app: 'cron-cleanup', waiters: [leaf] }],
            }],
            truncated: false,
          },
          verdict: { level: 'critical', note: '2 session(s) blocked' },
          crossed: {
            level: 'critical', value: 60, unit: 'seconds',
            because: 'a minute of blocking outlives most application timeouts',
            remedy: 'Terminate the ROOT blocker, not a waiter.',
          },
          measuredAt: 0,
        };
      }
      if (check.id === 'longRunning') {
        const waiters = [
          { pid: 9403, runningSecs: 1115, query: 'DELETE FROM users WHERE id = 1' },
          { pid: 9402, runningSecs: 1115, query: 'UPDATE users SET n = n + 1 WHERE id = 1' },
        ];
        return {
          ok: true,
          data: {
            // 'mixed-slow' adds one query that is genuinely slow — nowhere in
            // the wait graph — which is the case a blanket "these are all
            // waiters" note would get wrong.
            queries: state.mode === 'mixed-slow'
              ? [...waiters, { pid: 7777, runningSecs: 900, query: 'SELECT count(*) FROM events' }]
              : waiters,
            truncated: false,
          },
          verdict: { level: 'critical', note: 'pid 9403 running 1115s' },
          crossed: {
            level: 'critical', value: 300, unit: 'seconds',
            because: 'five minutes exceeds almost every application timeout',
            remedy: 'terminating this backend usually frees work nobody is waiting for',
          },
          measuredAt: 0,
        };
      }
    }
    // One check in trouble, the rest fine — the ordinary incident, and the
    // shape the band ranking exists for.
    if (state.mode === 'one-critical' && check.id === 'blocked') {
      return {
        ok: true,
        data: { count: 2, longestQueryAgeSecs: 2542, suspectPid: 2318 },
        verdict: { level: 'critical', note: '2 session(s) blocked' },
        crossed: {
          level: 'critical', value: 60, unit: 'seconds',
          because: 'past a minute of query age, most client timeouts have already fired',
          remedy: 'Terminate the root blocker from Sessions.',
        },
        measuredAt: 0,
      };
    }
    return { ok: true, data: data[check.id] ?? {}, verdict: { level: 'ok' }, measuredAt: 0 };
  }),
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  state.mode = 'ok';
});

const draw = async () => render(await Triage({ params: Promise.resolve({ name: 'prod' }) }));

describe('Triage — an unreachable database says so once', () => {
  /**
   * Found by pointing the console at a database that does not exist and
   * reading the page: all nine panels failed with the same two sentences, so
   * the screen showed that message NINE times, laid out in the full band
   * structure as though there were something here to triage. The one fact
   * that mattered was the least prominent thing on it.
   */
  it('collapses to a single message when every check failed the same way', async () => {
    state.mode = 'all-alike';
    rendered = await draw();

    const text = rendered.text();
    expect(text).toContain('prod is unreachable');
    expect(text.match(/database "gone" does not exist/g)).toHaveLength(1);
    // The bands are gone: there is nothing to group.
    expect(text).not.toContain('is anything waiting instead of working?');
  });

  /**
   * The other half, and the reason this is not just "collapse whenever
   * everything failed". Nine checks failing for nine DIFFERENT reasons is
   * nine different things the operator needs to read — a partially-privileged
   * role is the ordinary case — and collapsing those would hide eight of
   * them behind whichever one happened to be first.
   */
  it('keeps a panel per check when the failures differ from each other', async () => {
    state.mode = 'all-different';
    rendered = await draw();

    const text = rendered.text();
    expect(text).not.toContain('is unreachable');
    expect(text).toContain('is anything waiting instead of working?');
    expect(text).toContain('permission denied for blocked');
    expect(text).toContain('permission denied for locks');
  });
});

describe('Triage — the document outline matches the visual grouping', () => {
  /**
   * The bands were added so the page has a structure to navigate. Both the
   * band and the panels inside it rendered `h2`, which made each panel a
   * SIBLING of the band containing it — thirteen flat `h2`s, so a reader
   * moving by heading got exactly none of the grouping the bands provide.
   */
  it('nests panel headings under their band heading', async () => {
    state.mode = 'ok';
    rendered = await draw();

    const levels = Array.from(rendered.container.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .map((h) => Number(h.tagName[1]));

    expect(levels.length).toBeGreaterThan(4);
    // Four bands, and every panel one level below one of them.
    expect(levels.filter((l) => l === 2)).toHaveLength(4);
    expect(levels.filter((l) => l === 3)).toHaveLength(9);
    // No heading is more than one level deeper than the one before it.
    const jumps = levels.filter((l, i) => i > 0 && l > levels[i - 1]! + 1);
    expect(jumps).toEqual([]);
  });
});

describe('Triage — weight tracks severity, position does not move', () => {
  /**
   * The page was nine cards of identical size in a two-column grid, so a
   * 42-minute lock chain and `0 slot(s)` occupied the same real estate and
   * the screen ranked nothing. A `<section>` is a full panel; a healthy check
   * renders as a compact `<div>` row instead, so counting sections counts
   * exactly the things asking to be read (plus the four band wrappers).
   */
  it('spends a full panel only on the check that needs one', async () => {
    state.mode = 'one-critical';
    rendered = await draw();

    // Four band wrappers, plus a full panel for each of the two checks in
    // trouble — and nothing for the seven that are fine.
    expect(rendered.container.querySelectorAll('section')).toHaveLength(6);

    state.mode = 'ok';
    const allOk = await render(await Triage({ params: Promise.resolve({ name: 'prod' }) }));
    try {
      // Nothing wrong: four band wrappers and not one full panel.
      expect(allOk.container.querySelectorAll('section')).toHaveLength(4);
    } finally { allOk.unmount(); }
  });

  /**
   * Ranked in the DOM, not with CSS `order`. A grid can reorder visually
   * while leaving the source sequence alone, which would put the incident
   * first for a sighted reader and fourth for anyone using a screen reader or
   * the Tab key — the same visual/structure split the heading levels were
   * fixed to close.
   */
  it('puts the incident before its quiet neighbours in reading order', async () => {
    state.mode = 'one-critical';
    rendered = await draw();

    const headings = Array.from(rendered.container.querySelectorAll('h2,h3'))
      .map((h) => h.textContent);
    expect(headings.indexOf('Blocked')).toBeLessThan(headings.indexOf('Lock wait graph'));
    // And still inside its own band, not floated to the top of the page.
    expect(headings.indexOf('Locks')).toBeLessThan(headings.indexOf('Blocked'));
  });

  /**
   * The point of the whole exercise: a red badge that does not say why.
   */
  it('explains the verdict and offers a remedy', async () => {
    state.mode = 'one-critical';
    rendered = await draw();

    expect(rendered.text()).toContain('most client timeouts have already fired');
    expect(rendered.text()).toContain('Terminate the root blocker from Sessions.');
  });
});

describe('Triage — the session-state bars share one baseline', () => {
  /**
   * The bars were laid out `grid-cols-[9rem_1fr_auto]`, and `auto` sizes to
   * its own content: "17 · 2s" is narrower than "6 · 6m 17s", so the value
   * column changed width per row and the `1fr` track changed with it. Each
   * bar was then drawn to 100% of a DIFFERENT length — which removes the only
   * property aligned bars have. Measured in a real browser before the fix the
   * three tracks differed; after it they are 659px, 659px, 659px.
   *
   * Asserted structurally because jsdom has no layout engine — every
   * getBoundingClientRect here returns 0, so a width comparison would pass
   * whether or not the bug were present. What CAN be pinned is the cause: the
   * column carrying the value must be a FIXED width, never content-sized.
   */
  it('gives every row an identically-sized track', async () => {
    // The bars only render at full size, and a panel is only full size when
    // it needs attention — which is also when anyone reads them.
    state.mode = 'one-critical';
    rendered = await draw();

    const rows = Array.from(rendered.container.querySelectorAll('li'))
      .filter((li) => li.querySelector('div[aria-hidden]'));
    expect(rows.length).toBeGreaterThan(1);
    for (const li of rows) {
      const cls = li.getAttribute('class') ?? '';
      expect(cls).toMatch(/grid-cols-\[[^\]]+\]/);
      // `auto` or a bare `fr` in the LAST column is the defect: both size to
      // content, so the track between them absorbs the difference.
      const template = /grid-cols-\[([^\]]+)\]/.exec(cls)![1]!;
      expect(template.split('_').at(-1)).not.toBe('auto');
    }
  });
});

describe('Triage — one incident, one card, one answer', () => {
  /**
   * `blocked` counts the waiters and `locks` walks the chain that produced
   * them, so a single stuck transaction escalates BOTH — and the Locks
   * band rendered two full-width cards, two red accent bars and two
   * four-line explanations that differed only in wording. blocked.ts even
   * carries a comment acknowledging the duplication, and worked around it by
   * rephrasing rather than removing it.
   *
   * The accent bars are the part that actually misleads: they exist to be
   * counted in peripheral vision before anything is read, so two bars for one
   * incident overstates the page's own headline before a value is reached.
   */
  it('demotes the corroborating panel when both escalate on the same incident', async () => {
    state.mode = 'lock-incident';
    rendered = await draw();

    const sections = Array.from(rendered.container.querySelectorAll('section'));
    const titles = sections.map((el) => el.querySelector('h3')?.textContent).filter(Boolean);
    expect(titles).toContain('Lock wait graph');
    expect(titles).not.toContain('Blocked');

    // Demoted, never dropped: the count and the longest wait are still on
    // screen, and so is its badge.
    const text = rendered.text();
    expect(text).toContain('Blocked');
    expect(text).toContain('2 waiting');
    expect(text).toContain('longest 18m 35s');
    // ...and its duplicate explanation is not.
    expect(text).not.toContain('Treat this as an outage in progress.');
    expect(text).toContain('Terminate the ROOT blocker, not a waiter.');
  });

  /**
   * The lead has to have RUN. "We could not look" is the state this console
   * exists to keep distinct from a reading, and two checks that failed
   * differently are two things to read. Demoting there also literally hid
   * text: a compact panel renders `reason` and drops `message`, so the
   * sentence naming what Postgres refused went missing.
   */
  it('never demotes a check that could not run', async () => {
    state.mode = 'all-different';
    rendered = await draw();

    const titles = Array.from(rendered.container.querySelectorAll('section'))
      .map((el) => el.querySelector('h3')?.textContent);
    expect(titles).toContain('Blocked');
    expect(rendered.text()).toContain('permission denied for blocked');
  });
});

describe('Triage — a waiter is not a slow query', () => {
  /**
   * The contradiction this join exists to remove. `long-running.ts` selects
   * `state = 'active'`, and a session blocked on a lock IS active in
   * pg_stat_activity — so every waiter in a chain is also a long-running
   * query, always, by construction. The screen therefore said "Terminate the
   * ROOT blocker, not a waiter. Killing a waiter frees nothing" in one band,
   * and, one band below, offered those exact two waiters with "terminating
   * this backend usually frees work nobody is waiting for".
   */
  it('names the blocker on a long-running query that is only waiting', async () => {
    state.mode = 'lock-incident';
    rendered = await draw();

    const text = rendered.text();
    // Both waiters point at the ROOT of the chain, not at their immediate
    // blocker: 9402 waits on 9403, but the session to act on is 9401.
    expect(text.match(/blocked by 9401/g)).toHaveLength(2);
    expect(text).toContain('Not slow — waiting');
    // The remedy that was wrong of every row it sat beside.
    expect(text).not.toContain('terminating this backend usually frees work nobody is waiting for');
  });

  /**
   * The case a blanket note would get wrong, and the reason the marker is
   * per-row. With one genuinely slow query in the list, the check's remedy is
   * correct for that row and must still render — so the only thing that can
   * separate the two is the row itself.
   */
  it('keeps the remedy when something in the list is genuinely slow', async () => {
    state.mode = 'mixed-slow';
    rendered = await draw();

    const text = rendered.text();
    expect(text).toContain('terminating this backend usually frees work nobody is waiting for');
    expect(text).not.toContain('Not slow — waiting');
    // Still marked individually, which is what tells the operator the remedy
    // above applies to 7777 and not to these two.
    expect(text.match(/blocked by 9401/g)).toHaveLength(2);
  });
});

describe('Triage — the page is derived from the tree', () => {
  /**
   * The bands are not written in the page any more: gates.ts is the model,
   * and this file renders `GATE_ORDER` and reads each heading out of `GATES`.
   * Asserting against the same source would be circular if the page had a
   * second copy — it does not, and that is exactly what this pins. Change a
   * title in gates.ts and the page changes with it; change the page and there
   * is nothing left to change.
   */
  it('renders one band per gate, in the order a request meets them', async () => {
    state.mode = 'ok';
    rendered = await draw();

    const bands = Array.from(rendered.container.querySelectorAll('h2')).map((h) => h.textContent);
    expect(bands).toEqual(GATE_ORDER.map((g) => GATES[g].title));
  });

  /**
   * The subtitle is the tree stated one sentence at a time, and it is the
   * whole reason the bands stopped being jargon. `Saturation` told a reader
   * nothing about which gate their query was stuck at.
   */
  it('states what each gate asks, on screen and not only in a doc', async () => {
    state.mode = 'ok';
    rendered = await draw();

    const text = rendered.text();
    for (const gate of GATE_ORDER) {
      expect(text, `gate ${gate}`).toContain(GATES[gate].question);
    }
  });

  /**
   * Every panel lands in the band its CHECK names, so moving a check between
   * gates moves its panel with nothing in the page to keep in step. Wraparound
   * is the one that actually moved: it used to sit beside Connections on the
   * reasoning that both measure headroom, which put it a gate away from the
   * vacuum that closes its horizon.
   */
  it('files each panel under the gate its check declares', async () => {
    state.mode = 'ok';
    rendered = await draw();

    const sections = Array.from(rendered.container.querySelectorAll('section'));
    const bandOf = (panelTitle: string) => {
      const band = sections.find((el) =>
        Array.from(el.querySelectorAll('h3')).some((h) => h.textContent === panelTitle));
      return band?.querySelector('h2')?.textContent;
    };
    expect(bandOf('Connections')).toBe(GATES.connect.title);
    expect(bandOf('Lock wait graph')).toBe(GATES.wait.title);
    expect(bandOf('Long-running')).toBe(GATES.work.title);
    expect(bandOf('Wraparound')).toBe(GATES['keep-up'].title);
  });
});
