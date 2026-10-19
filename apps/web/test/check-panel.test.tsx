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
   * runCheck never rejects, so a denied or broken check arrives as data. A
   * silently missing panel would read as "everything is fine".
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
 * The guidance block: where a crossed threshold's `because` and `remedy`
 * reach the reader.
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

  /** A healthy check crossed no threshold, so no rationale applies to it. */
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

  /** A threshold may carry no remedy: some crossings have no one safe action. */
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

  /** Compact changes the weight of a healthy panel, not what it reports. */
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
 * Only a warn, critical or failed check gets a bordered card. Asserted on the
 * class, which this suite otherwise avoids: the rule is purely visual, so
 * text and roles cannot observe it.
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
    // Still says OK, in words.
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
   * "We could not look" is not a quiet state, so it keeps its box; it has no
   * level, so it gets no tint and no bar.
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
