import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

describe('parseArgs -- --snapshot flag', () => {
  it('sets snapshot to true when --snapshot is present', () => {
    expect(parseArgs(['locks', '--snapshot']).snapshot).toBe(true);
  });

  it('defaults snapshot to false when --snapshot is absent', () => {
    expect(parseArgs(['locks']).snapshot).toBe(false);
  });
});
