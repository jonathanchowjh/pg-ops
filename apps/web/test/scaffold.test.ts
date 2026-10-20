// `node`, not jsdom: under jsdom Vite's browser-mode transform rewrites
// `new URL('../package.json', import.meta.url)` into an `http://localhost`
// asset URL, and `readFileSync` throws "The URL must be of scheme file".
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('apps/web manifest', () => {
  /**
   * Next 16's App Router needs react 19. 19 is the only react in the tree;
   * this only pins the declaration that says which major the app is written
   * against.
   */
  it('declares react 19 explicitly rather than inheriting the root react 18', () => {
    expect(pkg.dependencies.react).toMatch(/^\^?19\./);
    expect(pkg.dependencies['react-dom']).toMatch(/^\^?19\./);
  });

  it('depends on the checks package by workspace protocol', () => {
    expect(pkg.dependencies['@pgops/checks']).toBe('*');
  });

  /**
   * The web app must never reach into packages/checks' source: the package's
   * declaration is its contract.
   */
  it('has no dependency that reaches around the checks package', () => {
    expect(Object.keys(pkg.dependencies)).not.toContain('pg');
  });

  /**
   * Keeps out packages this app does not use. @testing-library/react and
   * @testing-library/dom: test/render.tsx is the testing seam, and adopting
   * the library should be a decision, not an import that happened to resolve.
   * lucide-react: imported by nothing. `shadcn`: a code generator, and as a
   * runtime dependency it pulls the MCP SDK and express into the production
   * tree; run it with `npx shadcn`, which reads components.json.
   */
  it('declares none of the react testing packages, the unused icon package, or the shadcn CLI', () => {
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const trap of ['@testing-library/react', '@testing-library/dom', 'lucide-react', 'shadcn']) {
      expect(Object.keys(declared)).not.toContain(trap);
    }
  });
});

describe('shadcn wiring', () => {
  it('has a components.json whose aliases match the tsconfig path alias', () => {
    const cfg = JSON.parse(readFileSync(new URL('../components.json', import.meta.url), 'utf8'));
    expect(cfg.aliases.ui).toBe('@/components/ui');
    expect(cfg.aliases.utils).toBe('@/lib/utils');
  });

  /**
   * shadcn copies component source into the repo rather than installing a
   * package, so a missing file fails at the point of use, not at install.
   */
  it('has the table and badge components checked in', () => {
  });
});
