import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import type { Check, CheckContext } from '../src/types.js';

/** A pool stub. `runCheck` only ever calls `.query`. */
function ctxReturning(rows: unknown[]): CheckContext {
  return {
    target: { query: async () => ({ rows }) } as unknown as CheckContext['target'],
    serverVersion: 170000,
  };
}

const reporting: Check<{ n: number }, number> = {
  id: 'reporting', home: 'database', title: 'Reporting', class: 'captured',
  sql: 'SELECT 1 AS n',
  map: (rows) => rows.length,
};

const escalating: Check<{ n: number }, number> = {
  id: 'escalating', home: 'database', title: 'Escalating', class: 'live',
  sql: 'SELECT 1 AS n',
  map: (rows) => rows.length,
  verdict: () => ({ level: 'warn' }),
};

describe('a check with no verdict function', () => {
  it('reports null, not ok — "we do not judge" is not "we judged and it is fine"', async () => {
    const result = await runCheck(ctxReturning([{ n: 1 }]), reporting);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict).toBeNull();
  });

  it('still returns its data', async () => {
    const result = await runCheck(ctxReturning([{ n: 1 }, { n: 2 }]), reporting);
    expect(result.ok && result.data).toBe(2);
  });
});

describe('a check with a verdict function', () => {
  it('returns the verdict it computed', async () => {
    const result = await runCheck(ctxReturning([{ n: 1 }]), escalating);
    expect(result.ok && result.verdict).toEqual({ level: 'warn' });
  });
});
