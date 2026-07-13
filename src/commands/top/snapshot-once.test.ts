import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../../core/snapshot.js';
import { queryStatsToMarkdown } from './render.js';
import { prepareRows } from './stats.js';

describe('snapshot composition for --snapshot', () => {
  it('wraps the top markdown with the snapshot envelope', () => {
    const body = queryStatsToMarkdown(prepareRows([], { sort: 'total', filter: '' }), 'total');
    const md = buildSnapshot({ subcommand: 'top', timestamp: '2026-07-12T00:00:00Z' }, body);
    expect(md).toContain('# pgops top snapshot');
    expect(md).toContain('No query statistics');
  });
});
