import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryStat } from './query.js';

/**
 * The REAL TopApp, not the hub's mock of it. Home.test.tsx stubs the child views,
 * so nothing proved that the retrofitted `top` honours `onBack` — the hub could
 * be a one-way door (`t` in, no way out) and the suite would stay green.
 */

const mockFetch = vi.fn();
vi.mock('./query.js', async (orig) => ({ ...(await orig()), fetchQueryStats: (...a: unknown[]) => mockFetch(...a) }));

const { TopApp } = await import('./index.js');

const stat: QueryStat = {
  queryid: '42',
  query: 'SELECT * FROM orders WHERE id = $1',
  calls: 120,
  totalMs: 5400,
  meanMs: 45,
  stddevMs: 10,
  rows: 120,
  sharedBlksHit: 900,
  sharedBlksRead: 100,
};

async function flush() {
  await new Promise((r) => setTimeout(r, 20));
}

const ESC = String.fromCharCode(27);

describe('TopApp', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue([stat]);
  });

  it('renders pg_stat_statements rows', async () => {
    const { lastFrame } = render(<TopApp />);
    await flush();
    expect(lastFrame()).toContain('SELECT * FROM orders');
  });

  it('Esc fires onBack when provided', async () => {
    const onBack = vi.fn();
    const { stdin } = render(<TopApp onBack={onBack} />);
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onBack).toHaveBeenCalled();
  });

  it('shows freshness in the status bar once a poll lands', async () => {
    const { lastFrame } = render(<TopApp />);
    await flush();
    expect(lastFrame()).toContain('updated just now');
  });

  it('turns the missing-extension error into an install hint', async () => {
    mockFetch.mockRejectedValue(new Error('relation "pg_stat_statements" does not exist'));
    const { lastFrame } = render(<TopApp />);
    await flush();
    expect(lastFrame()).toContain('shared_preload_libraries');
  });
});
