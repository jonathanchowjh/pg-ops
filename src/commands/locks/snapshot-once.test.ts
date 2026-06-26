import { describe, expect, it } from 'vitest';
import { buildChains } from './chain.js';
import { chainsToMarkdown } from './render.js';
import { buildSnapshot } from '../../core/snapshot.js';

describe('snapshot composition for --snapshot', () => {
  it('wraps the chain markdown with the snapshot envelope', () => {
    const body = chainsToMarkdown(buildChains([]));
    const md = buildSnapshot({ subcommand: 'locks', timestamp: '2026-06-26T00:00:00Z' }, body);
    expect(md).toContain('# pgops locks snapshot');
    expect(md).toContain('No lock contention');
  });
});
