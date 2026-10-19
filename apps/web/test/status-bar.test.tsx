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
   * A standby is not a fault, but "you are on a replica" changes what the
   * terminate button below means. The negative case is asserted because a
   * badge that renders unconditionally would pass the positive one alone.
   */
  it('flags a replica, and stays quiet on a primary', async () => {
    const replica = await render(<StatusBar result={ok({ replica: true })} />);
    expect(replica.text()).toMatch(/replica/i);
    replica.unmount();

    const primary = await render(<StatusBar result={ok({ replica: false })} />);
    expect(primary.text()).not.toMatch(/replica/i);
    primary.unmount();
  });

  /**
   * Settings render in a disclosure on /cleanup, not here: this component is
   * in the layout shared by the incident pages, and settings would bury the
   * line saying which server the terminate button acts on.
   */
  it('states the server facts on one line and nothing else', async () => {
    const r = await render(<StatusBar result={ok()} />);
    expect(r.container.querySelectorAll('p')).toHaveLength(1);
    expect(r.container.querySelector('details')).toBeNull();
    expect(r.text()).not.toMatch(/shared_buffers|settings/i);
    r.unmount();
  });

  it('says so when the connection is not encrypted', async () => {
    const r = await render(<StatusBar result={ok({ ssl: false })} />);
    expect(r.text()).toMatch(/no ssl/i);
    r.unmount();
  });

  /** "We could not look" is neither `SSL` nor `no SSL`. */
  it('distinguishes an unknown SSL status from an unencrypted one', async () => {
    const r = await render(<StatusBar result={ok({ ssl: null })} />);
    expect(r.text()).toMatch(/ssl unknown/i);
    expect(r.text()).not.toMatch(/no ssl/i);
    r.unmount();
  });

  /**
   * The check is a scalar SELECT, so failing means the database was
   * unreachable. The header says so rather than silently omitting itself.
   */
  it('admits when it could not establish the identity at all', async () => {
    const r = await render(
      <StatusBar result={{ ok: false, reason: 'unreachable', message: 'connection refused' }} />,
    );
    expect(r.text()).toMatch(/identity unavailable/i);
    r.unmount();
  });
});
