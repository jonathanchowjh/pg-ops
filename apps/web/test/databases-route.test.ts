import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, POST } from '@/app/api/databases/route';

vi.mock('next/server', () => ({ connection: async () => {} }));

const { probe } = vi.hoisted(() => ({
  probe: vi.fn(async (_url: string) => ({
    identity: { database: 'app', user: 'pgops', serverVersion: '17.2', replica: false, ssl: true },
    readOnly: true,
  })),
}));
vi.mock('@/lib/pools', async (orig) => ({ ...(await orig<typeof import('@/lib/pools')>()), probe }));

const URL_ = 'postgres://pgops:hunter2@db.internal:5432/app';
let file: string;

const call = (method: 'POST' | 'DELETE', body: unknown, type = 'application/json') =>
  (method === 'POST' ? POST : DELETE)(new Request('http://console.example/api/databases', {
    method, headers: { 'content-type': type }, body: JSON.stringify(body),
  }));
const saved = () => JSON.parse(readFileSync(file, 'utf8')) as { name: string }[];

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'pgops-route-')), 'databases.json');
  writeFileSync(file, '[]\n');
  vi.stubEnv('PGOPS_CONFIG_FILE', file);
  vi.stubEnv('PGOPS_DATABASES', undefined);
  vi.stubEnv('DATABASE_URL', 'postgres://h/one');
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.spyOn(console, 'info').mockRestore(); });

describe('POST /api/databases', () => {
  it('requires a JSON body: the CSRF defence', async () => {
    expect((await call('POST', { name: 'prod', url: URL_ }, 'text/plain')).status).toBe(415);
    expect(probe).not.toHaveBeenCalled();
  });

  it('tests without saving, and answers what the server said, never the URL', async () => {
    const res = await call('POST', { name: 'prod', url: URL_ });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ identity: 'app · pgops · PG 17.2 · SSL', readOnly: true });
    expect(text).not.toContain('hunter2');
    expect(probe).toHaveBeenCalledWith(URL_);
    expect(saved()).toEqual([]);
  });

  /** A name problem is answered before pgops connects anywhere. */
  it('refuses a bad or taken name without connecting', async () => {
    expect((await call('POST', { name: 'a/b', url: URL_ })).status).toBe(400);
    expect((await call('POST', { name: 'default', url: URL_ })).status).toBe(400);
    expect((await call('POST', { name: 'prod', url: '' })).status).toBe(400);
    expect(probe).not.toHaveBeenCalled();
  });

  it('says why it could not connect', async () => {
    probe.mockRejectedValueOnce(new Error('password authentication failed for user "pgops"'));
    const res = await call('POST', { name: 'prod', url: URL_ });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain('password authentication failed');
  });

  it('saves on save: true, after testing, and logs who added it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const res = await call('POST', { name: 'prod', url: URL_, save: true });
    expect(res.status).toBe(201);
    expect(probe).toHaveBeenCalledOnce();
    expect(saved()).toEqual([{ name: 'prod', url: URL_ }]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('added database'), 'anonymous', 'prod');
  });

  /** The promise in the modal is the server's answer; without it there is nothing to promise. */
  it('will not save a database whose session the server did not keep read only', async () => {
    probe.mockResolvedValueOnce({ ...(await probe('')), readOnly: false });
    const res = await call('POST', { name: 'prod', url: URL_, save: true });
    expect(res.status).toBe(422);
    expect(saved()).toEqual([]);
  });
});

describe('DELETE /api/databases', () => {
  it('removes a saved database and refuses one set in the environment', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await call('POST', { name: 'prod', url: URL_, save: true });
    expect((await call('DELETE', { name: ' prod ' })).status).toBe(200);
    expect(saved()).toEqual([]);
    expect((await call('DELETE', { name: 'default' })).status).toBe(409);
    expect((await call('DELETE', { name: 'prod' }, 'text/plain')).status).toBe(415);
  });
});
