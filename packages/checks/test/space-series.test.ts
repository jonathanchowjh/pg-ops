import { describe, expect, it } from 'vitest';
import { relationSpace } from '../src/series/space.js';

describe('the space series', () => {
  it('carries no verdict, because a series reports movement and does not judge it', () => {
    expect('verdict' in relationSpace).toBe(false);
  });

  it('is named for what it answers', () => {
    expect(relationSpace.id).toBe('relationSpace');
  });
});
