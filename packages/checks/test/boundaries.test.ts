import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src/registry.js';

const SRC = new URL('../src/', import.meta.url).pathname;

function allSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allSourceFiles(join(dir, e.name))
                    : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
}

describe('the package boundary', () => {
  it('declares exactly one runtime dependency', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.dependencies)).toEqual(['pg']);
  });

  /**
   * Four import shapes need catching, not one: a static `from '...'`
   * (single quotes) is what the original regex covered, but nothing in this
   * repo's lint config enforces quote style, so `from "..."` (double
   * quotes) is just as real; a side-effect import (`import 'pkg';`, no
   * `from` at all) and a dynamic `import('pkg')` both bypass `from`
   * entirely. All four are collected and checked the same way.
   *
   * Comments are stripped before scanning: this file's own prose uses
   * "from" immediately ahead of a double-quoted phrase ("indistinguishable
   * from \"no slow queries\"" in query-stats.ts; reads differently from
   * "missed" here in registry.ts) — exactly the shape a quote-agnostic
   * `from ['"]` regex is meant to catch, and it self-triggered on both
   * until comments were excluded.
   */
  it('imports nothing but node builtins and pg', () => {
    const bad: string[] = [];
    for (const file of allSourceFiles(SRC)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      const specs = [
        ...[...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
        ...[...code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
        ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
      ];
      for (const spec of specs) {
        if (spec.startsWith('.') || spec.startsWith('node:') || spec === 'pg') continue;
        bad.push(`${file}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * The original `/^let |^var /` missed `export let cache = 0;` — the
   * most dangerous form of module state there is, being both mutable and
   * visible to every consumer — because it required "let"/"var" literally
   * at column 0. It also required a trailing space, so a bare `let` followed
   * immediately by a newline (an unusual but legal split declaration)
   * escaped too. `\b` replaces the trailing-space requirement and an
   * optional `export\s+` prefix is matched ahead of `let`/`var`, while `^`
   * still anchors to column 0 so a `let`/`var` nested inside a function
   * body (indented) is correctly left alone — this guard is about
   * module-level state, not all mutable bindings.
   */
  it('holds no module-level mutable state', () => {
    const bad: string[] = [];
    for (const file of allSourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const line of src.split('\n')) {
        if (/^(export\s+)?(let|var)\b/.test(line)) {
          bad.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives every threshold a justification', () => {
    for (const [id, check] of Object.entries(CHECKS)) {
      for (const t of check.thresholds ?? []) {
        expect(t.because.length, `${id}/${t.level}`).toBeGreaterThan(20);
      }
    }
  });

  /**
   * The lexicographic-sort trap. A value cast `::text` for the wire (bigint
   * safety — Convention 1: int8/numeric arrive as strings) keeps its
   * numeric SOURCE column's name as its output alias when there is no
   * explicit `AS`, or is given one explicitly when there is. Either way, an
   * `ORDER BY` that references that alias BARE — unqualified by a table or
   * CTE alias — sorts the TEXT column lexicographically: '20000000000'
   * bytes sorts ahead of '5000000000' bytes as text, ranking 5 GB retained
   * above 20 GB. Two correct decisions (cast to text for bigint safety;
   * order by severity) combine into a wrong one unless the ORDER BY reaches
   * past the text alias to the numeric source.
   *
   * This defect shipped three times in this plan — locks.ts, query-stats.ts,
   * slots.ts (each file's own comments name the pitfall and its fix: qualify
   * with a table/CTE alias, as query-stats.ts's `v.` does, or give the CTE's
   * numeric source column a name distinct from the outer text alias, as
   * slots.ts's `retained_bytes_num` vs. `retained_bytes` does) — because the
   * query still runs either way; it just ranks severity backwards, silently.
   *
   * SQL blocks are extracted from backtick template literals containing
   * `SELECT`, and SQL line/block comments are stripped from each before
   * scanning: without that, a file's own prose explaining this exact defect
   * (slots.ts's `-- ORDER BY the CTE's raw numeric column, never the ::text
   * output above... the outer SELECT's retained_bytes alias...`) contains
   * the words "ORDER BY" and the alias name in plain English, and would
   * self-trigger the very check meant to catch the bug it's warning about.
   *
   * Scope, stated rather than left implicit: this catches the alias written
   * DIRECTLY in an ORDER BY clause inside a SQL template literal — the shape
   * slots.ts actually shipped, and the shape reverting its fix reproduces
   * (verified: see the task report). It does NOT follow a `${...}`
   * interpolation back to a lookup table defined elsewhere in the file — the
   * shape query-stats.ts's `calls`/`cache` sort keys took, where the ORDER
   * BY text itself is assembled at runtime from `ORDER[o.sort]`. Chasing
   * interpolations back to their source through arbitrary TypeScript is a
   * real static-analysis problem, not a regex one; query-stats.ts's own `v.`
   * qualification convention plus query-stats.int.test.ts's "sorts by calls
   * and by cache hit rate too" integration test are what guard that shape
   * instead. Verified this guard does NOT (and, honestly, should not be
   * trusted to) catch that indirected form — see the task report.
   */
  it('never sorts a ::text-cast column by its own text alias', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles(SRC)) {
      const raw = readFileSync(file, 'utf8');
      for (const block of [...raw.matchAll(/`([^`]*)`/gs)].map((m) => m[1]!)) {
        if (!/\bSELECT\b/i.test(block)) continue;
        const sql = block.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const aliases = new Set([
          ...[...sql.matchAll(/::text\s+AS\s+(\w+)/gi)].map((m) => m[1]!),
          ...[...sql.matchAll(/(\w+)::text\b(?!\s*AS)/gi)].map((m) => m[1]!),
        ]);
        const orderBy = sql.match(/ORDER BY[\s\S]*$/i)?.[0] ?? '';
        for (const alias of aliases) {
          if (new RegExp(`(^|[^.\\w])${alias}\\b`).test(orderBy)) {
            offenders.push(`${file}: ORDER BY sorts '${alias}' by its ::text alias, not its numeric source`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Controller Ruling 46, restated after P1b deleted the TUI — the facts
   * underneath it moved, so read this before assuming the step is dead
   * weight.
   *
   * As written, the ruling said: the root `tsconfig.json` (`npm run
   * typecheck`) covered only `src/**`, the old Ink TUI, and
   * `tsconfig.test.json` reached this package's source only transitively,
   * through whichever test files imported it — so `index.ts`, the package's
   * public barrel and the file every consumer imports, was compiled by
   * nothing. Proved at the time: appending a type error to `index.ts`
   * produced zero errors from `typecheck:test`.
   *
   * P1b deleted `src/**`, and `tsconfig.test.json` was rerooted onto
   * `tsconfig.base.json` with `packages/*\/src/**\/*` in its `include`. So
   * `typecheck:test` now compiles `index.ts` directly — re-proved the same
   * way, by appending a type error to it and watching `typecheck:test` fail
   * on that line. The original hole is closed by the config itself.
   *
   * The step this test pins is kept anyway, and not from inertia — but the
   * reason is a DIFFERENT PROJECT, not a stronger one. Do not reach for
   * "declaration emit": both projects inherit `declaration: true` from
   * `tsconfig.base.json`, and this package's `typecheck` script is itself
   * `--noEmit`, so any argument of that shape disqualifies the very step it
   * is trying to justify. `build` is the only thing here that emits.
   *
   * What is actually exclusive to this step is the project's SHAPE.
   * `packages/checks/tsconfig.json` sets `rootDir: "./src"` and excludes
   * `test`; `tsconfig.test.json` sets `rootDir: "."` with src and test both
   * inside it. So a src file importing from `test/` — the leak that would
   * drag test-only code into the published `dist/` — is a rootDir escape
   * here and nothing there. Probed both directions: a src file re-exporting
   * from `../test/harness.js` gives
   * `error TS6059: File '…/test/harness.ts' is not under 'rootDir' '…/src'`
   * from this step, and zero errors from `typecheck:test`.
   *
   * This test does not re-run tsc — it asserts CI's `static` job still
   * invokes that script, so a future edit to the workflow that drops the
   * step is a red test rather than a silent loss.
   *
   * The workflow carries a prose comment describing this very step, right
   * above where it runs — an unanchored substring search matches the run
   * command's text equally well from inside a `#` comment, so commenting
   * the real step out while leaving prose that happens to quote it would
   * still read as green. Anchored to a real YAML step line (`- run:`, any
   * leading indentation, nothing after the command but trailing
   * whitespace) so only an actual step satisfies it.
   */
  it('runs this package\'s own typecheck in CI — the package\'s own project, the one build emits from', () => {
    const ciPath = new URL('../../../.github/workflows/ci.yml', import.meta.url);
    const ci = readFileSync(ciPath, 'utf8');
    expect(ci).toMatch(/^\s*-\s*run:\s*npm run --workspace @pgops\/checks typecheck\s*$/m);
  });

  /**
   * M1, the same class of gap as Ruling 46 above and closed the same way.
   * `package.json` declares `main`/`types`/`exports` into `dist/`, but every
   * typecheck in the `static` job is `--noEmit`, so nothing in CI ever
   * produced that directory. `dist/` is gitignored, so what a developer has
   * on disk is whatever they last built by hand — the reviewer found a stale
   * one whose `index.js` still carried "redactSecrets is Task 5's module and
   * does not exist yet". A local import would resolve against that; CI would
   * MODULE_NOT_FOUND.
   *
   * Anchored to a real `- run:` step line for the same reason as the
   * typecheck assertion: the workflow carries prose about this step directly
   * above it, and an unanchored substring match reads a commented-out step
   * as green.
   */
  it('builds this package in CI — main/types/exports point at dist/', () => {
    const ciPath = new URL('../../../.github/workflows/ci.yml', import.meta.url);
    const ci = readFileSync(ciPath, 'utf8');
    expect(ci).toMatch(/^\s*-\s*run:\s*npm run --workspace @pgops\/checks build\s*$/m);
  });

  /**
   * The other half of M1: the build step is only worth having if the paths
   * it produces are the paths package.json advertises. A `build` script
   * whose `outDir` drifts from `main`/`exports` would leave the same hole
   * with a green CI step sitting on top of it.
   */
  it('points main/types/exports at the directory tsconfig actually emits to', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const tsconfig = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'));
    const outDir = tsconfig.compilerOptions.outDir.replace(/^\.\//, '').replace(/\/$/, '');
    for (const declared of [pkg.main, pkg.types, pkg.exports['.']]) {
      expect(declared, 'declared entry point must live under the build output directory')
        .toMatch(new RegExp(`^\\./${outDir}/`));
    }
    expect(pkg.scripts.build).toContain('tsc -p tsconfig.json');
  });
});
