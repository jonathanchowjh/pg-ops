// Reads the filesystem and renders no DOM, so it does not need jsdom — the
// same per-file environment override, for the same reason, as guards.test.ts
// and scaffold.test.ts.
// @vitest-environment node
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NEXT_BIN } from './harness.js';

/**
 * WHY ONE ASSERTION EARNS A FILE. `withConsole` spawns NEXT_BIN as its very
 * first act, so if that path is wrong every integration test in apps/web
 * fails — and it fails fifteen minutes into `npm run gate`, after a
 * Testcontainer and a production build, with `MODULE_NOT_FOUND` from
 * node:internal/modules/cjs/loader and no mention of this repository in the
 * stack. This check costs a stat in the one-minute pre-commit suite and
 * names the problem instead.
 *
 * It has already caught it once. NEXT_BIN was
 * `new URL('../node_modules/next/dist/bin/next', import.meta.url)`, which is
 * apps/web/node_modules — correct only while npm nested `next` under this
 * workspace. A routine `npm update` hoisted `next` to the repo root and the
 * path stopped existing. Nothing in the repository chose that layout and
 * nothing announced the change.
 *
 * That is the third time hoisting has moved a dependency here, and the other
 * two are written down: the Dockerfile's build stage copies the context and
 * installs once rather than copying apps/web/node_modules, and this app keeps
 * its own vitest config because Vite resolves bare specifiers from the
 * config's directory. Both of those docblocks end by warning that the next
 * dependency to move will not announce itself either. This is that warning,
 * as a test.
 */
describe('the integration harness', () => {
  it('spawns a next binary that exists', () => {
    expect(existsSync(NEXT_BIN), `NEXT_BIN does not exist: ${NEXT_BIN}`).toBe(true);
  });
});
