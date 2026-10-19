// Reads the filesystem and renders no DOM, so it does not need jsdom.
// @vitest-environment node
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NEXT_BIN } from './harness.js';

/**
 * `withConsole` spawns NEXT_BIN first, so a wrong path fails every
 * integration test late in `npm run gate` with a bare `MODULE_NOT_FOUND`.
 * npm hoisting can move `next` between apps/web/node_modules and the repo
 * root without notice; this names the problem in the fast suite.
 */
describe('the integration harness', () => {
  it('spawns a next binary that exists', () => {
    expect(existsSync(NEXT_BIN), `NEXT_BIN does not exist: ${NEXT_BIN}`).toBe(true);
  });
});
