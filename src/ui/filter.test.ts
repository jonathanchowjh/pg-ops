import { describe, expect, it } from 'vitest';
import { reduceFilter } from './filter.js';

const ON = { filter: 'use', filtering: true };

describe('reduceFilter', () => {
  it('appends a typed character to the filter', () => {
    expect(reduceFilter(ON, 'r', {})).toEqual({ filter: 'user', filtering: true });
  });

  it('removes the last character on backspace', () => {
    expect(reduceFilter(ON, '', { backspace: true })).toEqual({ filter: 'us', filtering: true });
  });

  it('removes the last character on delete', () => {
    expect(reduceFilter(ON, '', { delete: true })).toEqual({ filter: 'us', filtering: true });
  });

  it('stays empty when backspacing an empty filter', () => {
    expect(reduceFilter({ filter: '', filtering: true }, '', { backspace: true })).toEqual({
      filter: '',
      filtering: true,
    });
  });

  it('confirms on Enter — keeps the filter, leaves filtering mode', () => {
    expect(reduceFilter(ON, '', { return: true })).toEqual({ filter: 'use', filtering: false });
  });

  it('cancels on Escape — clears the filter and leaves filtering mode', () => {
    expect(reduceFilter(ON, '', { escape: true })).toEqual({ filter: '', filtering: false });
  });

  it('ignores control-key chords (does not type them into the filter)', () => {
    expect(reduceFilter(ON, 'c', { ctrl: true })).toEqual(ON);
    expect(reduceFilter(ON, 'x', { meta: true })).toEqual(ON);
  });

  it('ignores raw control characters and pasted newlines/escape sequences', () => {
    const ESC = String.fromCharCode(27);
    expect(reduceFilter(ON, '\n', {})).toEqual(ON);
    expect(reduceFilter(ON, ESC, {})).toEqual(ON); // bare ESC byte
    expect(reduceFilter(ON, ESC + '[A', {})).toEqual(ON); // arrow-key escape sequence
  });
});
