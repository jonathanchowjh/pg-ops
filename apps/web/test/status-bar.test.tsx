import { describe, expect, it } from 'vitest';
import type { CheckResult, IdentityData } from '@pgops/checks';
import { render } from './render.js';
import { StatusBar } from '../components/status-bar.js';

const ok = (over: Partial<IdentityData> = {}): CheckResult<IdentityData> => ({
  ok: true,
  verdict: { level: 'ok' },
  measuredAt: 1_700_000_000_000,
  data: {
    database: 'appdb', user: 'postgres', serverVersion: '17.2',
    replica: false, ssl: true, ...over,
  },
});

describe('StatusBar', () => {
  it('names the server the console is actually talking to', async () => {
    const r = await render(<StatusBar result={ok()} />);
    expect(r.text()).toContain('appdb');
    expect(r.text()).toContain('postgres');
    expect(r.text()).toContain('17.2');
    r.unmount();
  });

  /**
   * The pair that matters. A standby is not a fault, so it gets no verdict —
   * but a terminate button sits two lines below this, and "you are on a
   * replica" changes what pressing it means. The negative case is asserted
   * beside it because a badge that renders unconditionally would pass the
   * positive test alone.
   */
  it('flags a replica, and stays quiet on a primary', async () => {
    const replica = await render(<StatusBar result={ok({ replica: true })} />);
    expect(replica.text()).toMatch(/replica/i);
    replica.unmount();

    const primary = await render(<StatusBar result={ok({ replica: false })} />);
    expect(primary.text()).not.toMatch(/replica/i);
    primary.unmount();
  });

  it('says so when the connection is not encrypted', async () => {
    const r = await render(<StatusBar result={ok({ ssl: false })} />);
    expect(r.text()).toMatch(/no ssl/i);
    r.unmount();
  });

  /**
   * The invariant this whole console is built on, at its smallest scale:
   * "we could not look" must not render as "we looked and it is fine", and
   * must not render as its opposite either. An unknown SSL status is neither
   * `SSL` nor `no SSL`.
   */
  it('distinguishes an unknown SSL status from an unencrypted one', async () => {
    const r = await render(<StatusBar result={ok({ ssl: null })} />);
    expect(r.text()).toMatch(/ssl unknown/i);
    expect(r.text()).not.toMatch(/no ssl/i);
    r.unmount();
  });

  /**
   * A header that silently omits itself on failure reads as a header that
   * had nothing to add. The check cannot fail on its own — it is a scalar
   * SELECT — so reaching here means the database was unreachable, which the
   * panels below will also say. It still says it: this line is the one that
   * claims which server we are on, and a claim that quietly disappears is
   * worse than one that admits it is missing.
   */
  it('admits when it could not establish the identity at all', async () => {
    const r = await render(
      <StatusBar result={{ ok: false, reason: 'unreachable', message: 'connection refused' }} />,
    );
    expect(r.text()).toMatch(/identity unavailable/i);
    r.unmount();
  });
});
