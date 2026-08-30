import { describe, expect, it } from 'vitest';
import { formatDuration } from '../lib/format.js';

describe('formatDuration', () => {
  it('renders null as an em dash rather than "0s" or "null"', () => {
    expect(formatDuration(null)).toBe('—');
  });
  it('renders sub-minute durations in seconds', () => {
    expect(formatDuration(45)).toBe('45s');
  });
  it('renders minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2m 5s');
  });
  it('renders hours and minutes, dropping seconds', () => {
    expect(formatDuration(100_366)).toBe('27h 52m');
  });
  /** A negative age means clock skew between client and server, not a bug worth crashing on. */
  it('clamps a negative duration to 0s', () => {
    expect(formatDuration(-5)).toBe('0s');
  });
});
