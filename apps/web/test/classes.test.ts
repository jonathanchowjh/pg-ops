import { describe, expect, it } from 'vitest';
import { BUCKET_MS as OF_THE_CHECKS_MS, CLASSES as OF_THE_CHECKS } from '@pgops/checks';
import { BUCKET_MS, CLASSES } from '@/lib/clock';

describe('the class list the browser draws with', () => {
  it('is the checks package\'s, in the same stacking order', () => {
    expect([...CLASSES]).toEqual([...OF_THE_CHECKS]);
  });

  it('steps the cursor by the bucket the sampler writes', () => {
    expect(BUCKET_MS).toBe(OF_THE_CHECKS_MS);
  });
});
