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
