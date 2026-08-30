import { describe, expect, it } from 'vitest';
import { ACTOR_HEADER, authorize } from '@/lib/auth';

// RFC 7617 mandates UTF-8. Plain `btoa` treats the string's UTF-16 code
// units as bytes directly, which happens to round-trip for anything in the
// Latin-1 range (0-255) — including "ä"/"ö" — so it would NOT have caught
// I1's bug. Real clients base64-encode the UTF-8 BYTES of the credentials,
// which is what this helper now does, so it can actually stand in for one.
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

  /**
   * RFC 7617: the credentials are `user-id ":" password`, and only the FIRST
   * colon separates them — a password may contain any of them. Splitting on
   * every colon locks out anyone whose password contains one, which is a
   * large fraction of generated passwords, and does it with a 401 that reads
   * as "wrong password".
   */
  it('accepts a password containing colons', () => {
    const env = { PGOPS_USERNAME: 'alice', PGOPS_PASSWORD: 'a:b:c' };
    expect(authorize(env, basic('alice', 'a:b:c'))).toEqual({ ok: true, user: 'alice' });
  });

  /**
   * I1 (review): `atob` decodes base64 to a BINARY string — one JS char per
   * BYTE. `process.env.PGOPS_PASSWORD` is a UTF-8-decoded JS string — one
   * char per CODE POINT. For a non-ASCII password those two disagree on
   * every multi-byte character, so `safeEqual` compared byte-string against
   * code-point-string and rejected a password that was typed correctly,
   * locking the operator out with a 401 indistinguishable from a wrong
   * password — the same failure mode the colon-splitting case above exists
   * to prevent. `decodeBasic` must decode the base64 to raw bytes and then
   * UTF-8-decode those bytes, so both sides of `safeEqual` are code-point
   * strings.
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
   * Ruling 4. The dangerous default is serving openly because the operator
   * set half the pair; the second-most dangerous is a 401 nobody can ever
   * satisfy. 503, naming the variable that is missing.
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
