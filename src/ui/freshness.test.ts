import { describe, expect, it } from 'vitest';
import { formatFreshness } from './freshness.js';

describe('formatFreshness', () => {
  it('reads "just now" under a second', () => expect(formatFreshness(0)).toBe('updated just now'));
  it('reads seconds', () => expect(formatFreshness(3)).toBe('updated 3s ago'));
  it('reads minutes past 60s', () => expect(formatFreshness(125)).toBe('updated 2m ago'));
  it('treats NaN, Infinity, and negatives as "just now" (no garbled output)', () => {
    expect(formatFreshness(NaN)).toBe('updated just now');
    expect(formatFreshness(Infinity)).toBe('updated just now');
    expect(formatFreshness(-5)).toBe('updated just now');
  });
});
