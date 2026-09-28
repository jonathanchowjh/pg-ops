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

  /**
   * Every ratio in this package divides in NUMERIC arithmetic, never bigint.
   *
   * `pg_statio_*` and `pg_stat_*` counters are all bigint, and bigint /
   * bigint is INTEGER division in Postgres: measured on 17.11, an index with
   * 39,649 hits and 1 read returns exactly `0` where the true rate is
   * 0.99997. The page then reports a 0% cache hit rate under a summary
   * reporting 99.99%, and nothing errors.
   *
   * This is a SOURCE guard because the behaviour is not reachable from a
   * test. Catching it needs a relation with `heap_blks_read > 0`, and a
   * table written inside the test is still entirely in shared buffers — 500k
   * rows (17 MB) and 400k wide rows (54 MB, past the ring-buffer threshold)
   * both measured `heap_blks_read = 0` against the default 128 MB. Only
   * exceeding shared_buffers outright would do it, which is not a fixture
   * worth having. The per-INDEX form is covered behaviourally in
   * indexes.int.test.ts, because index pages do get read once; the per-TABLE
   * form has no such luck, and this stands in for it.
   *
   * `sum(...)` needs no cast: `sum()` over a bigint already returns numeric.
   */
  it('casts to numeric before dividing, in every ratio', () => {
    const bad: string[] = [];
    for (const file of allSourceFiles(SRC)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      for (const m of code.matchAll(/([^/\n]{0,120})\/\s*nullif\(/g)) {
        const numerator = m[1]!;
        if (/::numeric|\bsum\s*\(/.test(numerator)) continue;
        bad.push(`${file}: ${numerator.trim()} / nullif(...)`);
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
        // EACH ORDER BY clause, bounded — not one slice from the first
        // `ORDER BY` to the end of the block. A query whose CTE carries its
        // own `ORDER BY` (sequences.ts uses `DISTINCT ON`, which requires one)
        // put every outer `::text AS` alias inside that slice and reported
        // three offences against a query sorting on `(v.val / v.ceiling)` — a
        // numeric expression. An inner clause cannot reference an outer
        // alias, because the outer SELECT is not in its scope.
        const clauses = [...sql.matchAll(/ORDER BY[\s\S]*?(?=\bLIMIT\b|\n\s*\)|$)/gi)]
          .map((m) => m[0]);
        for (const alias of aliases) {
          for (const clause of clauses) {
            if (new RegExp(`(^|[^.\\w])${alias}\\b`).test(clause)) {
              offenders.push(`${file}: ORDER BY sorts '${alias}' by its ::text alias, not its numeric source`);
            }
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
   * This test does not re-run tsc — it asserts the pre-commit hook still
   * invokes that script, so an edit that drops the step is a red test rather
   * than a silent loss. It pinned `.github/workflows/ci.yml`'s `static` job
   * until the workflow was replaced by `.githooks/`; the step, and the reason
   * for it, are unchanged.
   *
   * The hook carries a prose comment describing this very step — an
   * unanchored substring search matches the command's text equally well from
   * inside a `#` comment, so commenting the real line out while leaving prose
   * that happens to quote it would still read as green. Anchored to a real
   * command line (start of line, nothing after it but trailing whitespace) so
   * only an actual step satisfies it.
   */
  it('runs this package\'s own typecheck before a commit — the package\'s own project, the one build emits from', () => {
    const hook = readFileSync(new URL('../../../.githooks/pre-commit', import.meta.url), 'utf8');
    expect(hook).toMatch(/^npm run --workspace @pgops\/checks typecheck\s*$/m);
  });

  /**
   * M1, the same class of gap as Ruling 46 above and closed the same way.
   * `package.json` declares `main`/`types`/`exports` into `dist/`, but every
   * typecheck in the pre-commit hook is `--noEmit`, so without this step
   * nothing ever produces that directory. `dist/` is gitignored, so what a
   * developer has on disk is whatever they last built by hand — the reviewer
   * found a stale one whose `index.js` still carried "redactSecrets is Task
   * 5's module and does not exist yet". A local import would resolve against
   * that; a clean checkout would MODULE_NOT_FOUND.
   *
   * Anchored to a real command line for the same reason as the typecheck
   * assertion: the hook carries prose about this step directly above it, and
   * an unanchored substring match reads a commented-out step as green.
   */
  it('builds this package before a commit — main/types/exports point at dist/', () => {
    const hook = readFileSync(new URL('../../../.githooks/pre-commit', import.meta.url), 'utf8');
    expect(hook).toMatch(/^npm run --workspace @pgops\/checks build\s*$/m);
  });

  /**
   * THE PRE-PUSH HOOK MUST BE FAST, and this is a correctness rule rather
   * than a comfort one.
   *
   * `git push` opens the connection to the remote BEFORE it runs pre-push —
   * it has to, because the hook is handed each ref's remote SHA on stdin,
   * which git can only know by asking. Traced on 2026-09-25:
   *
   *     run_command: 'ssh -v' git@github.com 'git-receive-pack ...'
   *     debug1: Sending command: git-receive-pack
   *     pre-push: integration tests against Postgres 17     <- AFTER
   *
   * So everything the hook does happens while an idle `git-receive-pack`
   * session is held open. When the hook ran the integration suite and a
   * Docker image build — about fifteen minutes — the remote dropped that
   * session, and git died writing the pack to a closed pipe: exit 141,
   * SIGPIPE, with no output at all, not even `Enumerating objects`. Every
   * push failed, and the only way through was the `--no-verify` the gate
   * exists to prevent.
   *
   * No edit to the hook's BODY can fix that; only making the hook fast can.
   * The slow steps moved to `scripts/gate.sh`, and the tests below pin both
   * halves — that they left here, and that they arrived there.
   */
  it('does not run the slow gates from pre-push — git holds the connection open while it runs', () => {
    const hook = readFileSync(new URL('../../../.githooks/pre-push', import.meta.url), 'utf8');
    // Anchored to real command lines for the same reason as the assertions
    // above: this hook carries prose naming both steps, and an unanchored
    // search cannot tell a live command from the comment explaining why it
    // is no longer here.
    expect(hook).not.toMatch(/^\s*(PGOPS_TEST_PG_VERSION=\S+ )?npm run test:int\s*$/m);
    expect(hook).not.toMatch(/^\s*\.\/scripts\/gate\.sh\s*$/m);
    expect(hook).not.toMatch(/^\s*\.\/scripts\/image-smoke\.sh\s*$/m);
  });

  /**
   * The other half: a fast hook is only a gate if it still refuses an
   * ungated push. It reads the ref lines git writes to its stdin and
   * requires a receipt for each SHA being pushed — so the gate binds to the
   * exact commit, and committing after gating invalidates it.
   */
  it('verifies every pushed sha against a gate receipt', () => {
    const hook = readFileSync(new URL('../../../.githooks/pre-push', import.meta.url), 'utf8');
    expect(hook).toMatch(/while read/);
    expect(hook).toMatch(/pgops-gate-receipt/);
  });

  /**
   * The steps MOVED; they were not dropped. Without this, deleting the
   * integration suite outright would satisfy the "pre-push is fast" test
   * above and lose the gate entirely — the exact shape of vacuous test the
   * pre-commit assertions above are anchored against.
   */
  it('runs the integration suite and the image smoke test from the gate script', () => {
    const gate = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
    expect(gate).toMatch(/^\s*PGOPS_TEST_PG_VERSION="\$v" npm run test:int\s*$/m);
    expect(gate).toMatch(/^\s*\.\/scripts\/image-smoke\.sh\s*$/m);
  });

  /** A gate that does not record what it gated cannot be checked by the hook. */
  it('records the sha the gate passed on', () => {
    const gate = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
    expect(gate).toMatch(/pgops-gate-receipt/);
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
