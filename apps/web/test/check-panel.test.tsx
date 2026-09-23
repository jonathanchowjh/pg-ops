import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { CheckPanel } from '../components/check-panel.js';

describe('CheckPanel', () => {
  it('renders the children with the data when the check succeeded', async () => {
    const r = await render(
      <CheckPanel
        title="Connections"
        result={{ ok: true, data: { used: 5 }, verdict: { level: 'ok' }, measuredAt: 0 }}
      >
        {(d) => <span>{d.used} used</span>}
      </CheckPanel>,
    );
    expect(r.text()).toContain('5 used');
  });

  /**
   * The !ok path is the one that matters. runCheck never rejects, so a denied
   * or broken check arrives here as data — and if this component rendered
   * nothing for it, the page would show a silently missing panel, which reads
   * as "everything is fine" during an incident. It must say what went wrong.
   */
  it('renders the failure reason and message when the check failed', async () => {
    const r = await render(
      <CheckPanel
        title="Query statistics"
        result={{ ok: false, reason: 'missing-extension', message: 'pg_stat_statements is not installed' }}
      >
        {() => <span>never rendered</span>}
      </CheckPanel>,
    );
    expect(r.text()).toContain('pg_stat_statements is not installed');
    expect(r.text()).not.toContain('never rendered');
  });

  it('renders the remedy when the failure carries one', async () => {
    const r = await render(
      <CheckPanel
        title="Query statistics"
        result={{ ok: false, reason: 'missing-extension', message: 'not installed', remedy: 'CREATE EXTENSION pg_stat_statements' }}
      >
        {() => null}
      </CheckPanel>,
    );
    expect(r.text()).toContain('CREATE EXTENSION pg_stat_statements');
  });
});

/**
 * The guidance block, which is the reason `Threshold.because` exists at all.
 *
 * The checks package documents that field as "the sentence justifying this
 * number. MUST NOT be empty" and unit-tests it, and a grep for it across
 * apps/web returned NOTHING: the console rendered `CRITICAL` and a duration
 * and never once said why that duration was bad. `remedy` beside it is the
 * other half — registry.ts already names the rule ("pgHero's capability is
 * the probe plus the remedy") and the package had applied it only to the
 * path where a check BROKE, never to the path where a check worked and found
 * something.
 */
describe('CheckPanel guidance', () => {
  const crossed = {
    level: 'critical' as const,
    value: 10,
    unit: 'percent' as const,
    because: 'below a tenth, connection refusals are minutes away',
    remedy: 'Terminate idle-in-transaction sessions now.',
  };

  it('explains why the threshold matters and what to do about it', async () => {
    const r = await render(
      <CheckPanel
        title="Connections"
        result={{ ok: true, data: {}, verdict: { level: 'critical' }, crossed, measuredAt: 0 }}
      >
        {() => <span>8 free</span>}
      </CheckPanel>,
    );
    expect(r.text()).toContain('below a tenth, connection refusals are minutes away');
    expect(r.text()).toContain('Terminate idle-in-transaction sessions now.');
  });

  /**
   * The other half, and the reason `crossed` is resolved in run.ts rather
   * than looked up here from the verdict level. A healthy check crossed no
   * threshold, so there is no sentence that applies to it — and inventing
   * one ("connections are fine because below a tenth...") would attach a
   * critical rationale to an OK reading, which is the same over-claim as
   * substituting `{level:'ok'}` for a check that does not judge.
   */
  it('says nothing at all when no threshold was crossed', async () => {
    const r = await render(
      <CheckPanel
        title="Connections"
        result={{ ok: true, data: {}, verdict: { level: 'ok' }, measuredAt: 0 }}
      >
        {() => <span>74 free</span>}
      </CheckPanel>,
    );
    expect(r.text()).toContain('74 free');
    expect(r.text()).not.toContain('Why this matters');
  });

  /**
   * A threshold may legitimately carry no remedy: some crossings have no one
   * safe action, and the package's own docblock says silence is correct where
   * advice would be a guess. The explanation must still render.
   */
  it('renders the explanation alone when the threshold carries no remedy', async () => {
    const { remedy: _drop, ...noRemedy } = crossed;
    const r = await render(
      <CheckPanel
        title="Wraparound"
        result={{ ok: true, data: {}, verdict: { level: 'critical' }, crossed: noRemedy, measuredAt: 0 }}
      >
        {() => <span>reading</span>}
      </CheckPanel>,
    );
    expect(r.text()).toContain('below a tenth');
    expect(r.text()).not.toContain('Terminate idle-in-transaction');
  });

  /**
   * Compact is how the triage page stops spending a full card on good news.
   * The value and the badge must survive it — this is a change of weight,
   * not a change of what is reported — but the guidance must not, because a
   * compact panel is by definition one that crossed nothing.
   */
  it('keeps the value and the badge when compact', async () => {
    const r = await render(
      <CheckPanel
        title="Replication slots"
        compact
        result={{ ok: true, data: { n: 0 }, verdict: { level: 'ok' }, measuredAt: 0 }}
      >
        {(d) => <span>{d.n} slots</span>}
      </CheckPanel>,
    );
    expect(r.text()).toContain('0 slots');
    expect(r.text()).toContain('OK');
  });
});

/**
 * A box means look here.
 *
 * Compact halved the space a healthy check took and left it wearing the same
 * bordered card as an incident, so a triage page with nothing wrong was still
 * nine outlined boxes — furniture at the weight of a signal. The border is
 * now the third thing, after the accent bar and the badge, that says the same
 * one word.
 *
 * Asserted on the CLASS, which this suite otherwise avoids — every other test
 * here reads text and roles. There is no other way to see it: the rule is
 * entirely visual, it is the whole content of this phase, and "renders a
 * border" is not something a screen reader or a text assertion can observe.
 */
describe('a box means look here', () => {
  const box = (el: Element | null) => el!.className.includes('border') && !el!.className.includes('border-b');

  const panel = async (
    result: Parameters<typeof CheckPanel<{ n: number }>>[0]['result'],
    compact = false,
  ) => {
    const r = await render(
      <CheckPanel title="Replication slots" result={result} compact={compact}>
        {(d) => <span>{d.n} slots</span>}
      </CheckPanel>,
    );
    return r;
  };

  const ok = { ok: true as const, data: { n: 0 }, verdict: { level: 'ok' as const }, measuredAt: 0 };
  const warn = { ...ok, verdict: { level: 'warn' as const, note: '3 inactive' } };
  const critical = { ...ok, verdict: { level: 'critical' as const, note: '3 inactive' } };
  const reading = { ...ok, verdict: null };
  const broken = {
    ok: false as const, reason: 'privilege' as const, message: 'permission denied',
  };

  it('draws no card around a healthy check', async () => {
    const r = await panel(ok);
    expect(box(r.container.querySelector('section'))).toBe(false);
    // Still says OK, in words. This is a change of weight, not of content.
    expect(r.text()).toContain('OK');
    expect(r.text()).toContain('0 slots');
  });

  it('draws no card around a check with no verdict either', async () => {
    const r = await panel(reading);
    expect(box(r.container.querySelector('section'))).toBe(false);
  });

  it.each([['warn', warn], ['critical', critical]] as const)(
    'draws a card, an accent bar and a tint at %s',
    async (level, result) => {
      const r = await panel(result);
      const section = r.container.querySelector('section')!;
      expect(box(section)).toBe(true);
      expect(section.className).toContain('border-l-4');
      expect(section.className).toContain(
        level === 'critical' ? 'bg-critical-surface' : 'bg-warning-surface');
    },
  );

  /**
   * "We could not look" keeps its box. It is not a quiet state — it is the
   * one this console exists to hold apart from "we looked and it is fine" —
   * but it gets NO tint and NO bar, because gray is what the absence of a
   * verdict looks like here and a failed check has no level to colour with.
   */
  it('keeps the card for a check that could not run, without colouring it', async () => {
    const r = await panel(broken);
    const section = r.container.querySelector('section')!;
    expect(box(section)).toBe(true);
    expect(section.className).not.toContain('border-l-4');
    expect(section.className).not.toContain('surface');
  });

  it('applies the same rule to a compact panel', async () => {
    const healthy = await panel(ok, true);
    expect(box(healthy.container.firstElementChild)).toBe(false);

    const loud = await panel(critical, true);
    expect(box(loud.container.firstElementChild)).toBe(true);
    expect(loud.container.firstElementChild!.className).toContain('bg-critical-surface');
  });
});
