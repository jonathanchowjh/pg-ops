// This file reads package.json off disk and renders no DOM, so it doesn't
// need jsdom. Forcing `node` here (Vitest's per-file environment override)
// matters beyond speed: the `web` project's jsdom environment runs Vite's
// browser-mode transform, which rewrites the literal
// `new URL('../package.json', import.meta.url)` below into a server-relative
// asset URL (`http://localhost:3000/...`) instead of a `file://` URL, and
// `readFileSync` then throws "The URL must be of scheme file". The `unit`
// project's `node` environment does not apply that transform.
// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('apps/web manifest', () => {
  /**
   * Next 16's App Router needs react 19. The root used to declare react 18
   * for Ink, so npm hoisted one major and nested the other, and declaring 19
   * explicitly here was what made that nesting happen at all. P1b deleted
   * the TUI, so 19 is now the only react in the tree and hoists to the root
   * — but the declaration is still what says which major this app is written
   * against, and is still what a `next` upgrade would have to be reconciled
   * with. Verified for real by `npm ls react`; this assertion only pins the
   * declaration.
   */
  it('declares react 19 explicitly rather than inheriting the root react 18', () => {
    expect(pkg.dependencies.react).toMatch(/^\^?19\./);
    expect(pkg.dependencies['react-dom']).toMatch(/^\^?19\./);
  });

  it('depends on the checks package by workspace protocol', () => {
    expect(pkg.dependencies['@pgops/checks']).toBe('*');
  });

  /**
   * The web app must never reach into packages/checks' source. Ruling 49: the
   * package's declaration is its contract, and a relative import across the
   * workspace boundary would void it silently.
   */
  it('has no dependency that reaches around the checks package', () => {
    expect(Object.keys(pkg.dependencies)).not.toContain('pg');
  });

  /**
   * M1 and M2 (final review): two armed traps, both left declared and both
   * still installed after the decisions that were supposed to remove them.
   *
   * While the repo root carried react 18 for the Ink TUI, npm hoisted a react
   * package declared HERE next to that 18 rather than next to this app's 19.
   * @testing-library/react was ruled DROPPED — the code stopped importing it,
   * but the specifier still resolved, so the next person to reach for the
   * obvious testing library would have rediscovered "Objects are not valid as
   * a React child" from scratch (test/render.tsx exists precisely because that
   * could not be made to work here). lucide-react was declared as a runtime
   * dependency, imported by nothing, and renders React components: the first
   * icon anyone added would have reproduced "Cannot read properties of null
   * (reading 'useRef')" in a brand-new file with nothing guarding it.
   *
   * P1b deleted the TUI, so the mis-resolution half of that is gone: one
   * react major is left and any of these would now resolve against it. The
   * assertion stays regardless, on its own merits. @testing-library/react
   * and @testing-library/dom are a testing stack this app does not use —
   * test/render.tsx is 25 working lines and adopting the library would be a
   * decision, taken deliberately, not something that arrives because an
   * import happened to resolve. lucide-react is still a runtime dependency
   * imported by nothing, and an unused dependency that ships React
   * components is the kind that survives three refactors. Uninstalling is
   * what removed them; this is what keeps them out, the way badge.test.tsx
   * keeps @base-ui/react out.
   *
   * `shadcn` joined the list at the pre-release audit. It is a code generator
   * that copies component source into the repo — the two files under
   * components/ui are the whole of what it ever produced — and it was kept
   * as a runtime dependency only so globals.css could import its
   * `tailwind.css`, a sheet of accordion keyframes and `data-open:`-style
   * variants nothing here used. That one import pulled the MCP SDK, express
   * and a `qs` advisory into the production tree. Run it with `npx shadcn`
   * when a third component is wanted; components.json is what it reads.
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
   * shadcn copies component SOURCE into the repo rather than installing a
   * package. That is the whole point of choosing it — the components are ours
   * to edit — but it also means a missing file is a silent build failure at
   * the point of use rather than an install error. Pin the two we rely on.
   */
  it('has the table and badge components checked in', () => {
    expect(existsSync(new URL('../components/ui/table.tsx', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../components/ui/badge.tsx', import.meta.url))).toBe(true);
  });
});
