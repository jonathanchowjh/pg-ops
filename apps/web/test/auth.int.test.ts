import { describe, expect, it } from 'vitest';
import { withConsole } from './harness.js';

const AUTH = { PGOPS_USERNAME: 'alice', PGOPS_PASSWORD: 'hunter2' };
const header = (u: string, p: string) => ({ authorization: `Basic ${btoa(`${u}:${p}`)}` });

describe('basic auth, against the running console', () => {
  it('challenges an unauthenticated request and serves an authenticated one', async () => {
    await withConsole(async ({ baseUrl }) => {
      const anon = await fetch(baseUrl, { redirect: 'manual' });
      expect(anon.status).toBe(401);
      expect(anon.headers.get('www-authenticate')).toMatch(/^Basic realm="pgops"/);

      const wrong = await fetch(baseUrl, { headers: header('alice', 'nope'), redirect: 'manual' });
      expect(wrong.status).toBe(401);

      const ok = await fetch(baseUrl, { headers: header('alice', 'hunter2'), redirect: 'manual' });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('primary');
    }, AUTH);
  });

  it('serves everything when neither variable is set', async () => {
    await withConsole(async ({ baseUrl }) => {
      expect((await fetch(baseUrl, { redirect: 'manual' })).status).toBe(200);
    });
  });
});
