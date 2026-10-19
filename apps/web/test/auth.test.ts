import { describe, expect, it } from 'vitest';
import { ACTOR_HEADER, authorize } from '@/lib/auth';

// Real clients base64-encode the UTF-8 bytes of the credentials (RFC 7617).
// Plain `btoa` encodes Latin-1 characters such as "ä" as single bytes, so it
// would not exercise the non-ASCII case below.
const utf8Base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const basic = (u: string, p: string) => `Basic ${utf8Base64(`${u}:${p}`)}`;
const CONFIGURED = { PGOPS_USERNAME: 'alice', PGOPS_PASSWORD: 'hunter2' };

describe('authorize', () => {
  it('allows everything, with no actor, when neither variable is set', () => {
    expect(authorize({}, null)).toEqual({ ok: true, user: null });
  });

  it('rejects a request with no Authorization header when auth is configured', () => {
    expect(authorize(CONFIGURED, null)).toMatchObject({ ok: false, status: 401 });
  });

  it('accepts the configured pair and reports the username as the actor', () => {
    expect(authorize(CONFIGURED, basic('alice', 'hunter2'))).toEqual({ ok: true, user: 'alice' });
  });

  it('rejects the right username with the wrong password', () => {
    expect(authorize(CONFIGURED, basic('alice', 'hunter3'))).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects the wrong username with the right password', () => {
    expect(authorize(CONFIGURED, basic('bob', 'hunter2'))).toMatchObject({ ok: false, status: 401 });
  });

  /** RFC 7617: only the first colon separates user from password. */
  it('accepts a password containing colons', () => {
    const env = { PGOPS_USERNAME: 'alice', PGOPS_PASSWORD: 'a:b:c' };
    expect(authorize(env, basic('alice', 'a:b:c'))).toEqual({ ok: true, user: 'alice' });
  });

  /**
   * `atob` yields one char per byte; the env password is one char per code
   * point. `decodeBasic` must UTF-8-decode the bytes, or a correctly typed
   * non-ASCII password is rejected.
   */
  it('accepts a password containing non-ASCII characters', () => {
    const env = { PGOPS_USERNAME: 'alice', PGOPS_PASSWORD: 'pässwörd' };
    expect(authorize(env, basic('alice', 'pässwörd'))).toEqual({ ok: true, user: 'alice' });
  });

  it('rejects a non-Basic scheme', () => {
    expect(authorize(CONFIGURED, 'Bearer abcdef')).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects credentials that are not valid base64', () => {
    expect(authorize(CONFIGURED, 'Basic !!!not-base64!!!')).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects credentials with no colon at all', () => {
    expect(authorize(CONFIGURED, `Basic ${btoa('alice')}`)).toMatchObject({ ok: false, status: 401 });
  });

  /**
   * Half the pair must neither serve openly nor answer a 401 nobody can
   * satisfy: 503, naming the missing variable.
   */
  it('fails closed with 503 when only the username is set', () => {
    const r = authorize({ PGOPS_USERNAME: 'alice' }, basic('alice', 'anything'));
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(r.ok === false && r.message).toContain('PGOPS_PASSWORD');
  });

  it('fails closed with 503 when only the password is set', () => {
    const r = authorize({ PGOPS_PASSWORD: 'hunter2' }, null);
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(r.ok === false && r.message).toContain('PGOPS_USERNAME');
  });

  it('names the actor header once, so proxy and the kill route agree', () => {
    expect(ACTOR_HEADER).toBe('x-pgops-user');
  });
});
