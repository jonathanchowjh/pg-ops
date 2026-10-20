import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
   * Catches a third-party import in any of four shapes: `from '...'`,
   * `from "..."`, a side-effect `import 'pkg'` and a dynamic `import('pkg')`.
   * Comments are stripped first, because prose such as `from "missed"`
   * matches the regex.
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
   * Catches a `let`/`var` at column 0, including `export let` and a `let`
   * followed directly by a newline. Indented bindings inside a function body
   * are left alone: the guard is about module-level state.
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
   * Catches a ratio divided in bigint arithmetic. `pg_stat*` counters are
   * bigint and bigint / bigint is integer division: 39,649 hits and 1 read
   * returns `0`, not 0.99997, and nothing errors.
   *
   * A source guard because a test cannot reach the per-table form: a table
   * written inside a test stays in shared buffers, so `heap_blks_read` is 0.
   * The per-index form is covered in indexes.int.test.ts.
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
   * Catches an `ORDER BY` on the bare alias of a column cast `::text` for the
   * wire. That sorts lexicographically — '20000000000' ahead of '5000000000'
   * — so severity ranks backwards and the query still runs. The fix is to
   * qualify with a table/CTE alias or give the numeric source its own name.
   *
   * SQL comments are stripped first, since prose about this defect names
   * "ORDER BY" and the alias.
   *
   * Scope: only an alias written directly in an ORDER BY inside a SQL
   * template literal. An ORDER BY assembled from a `${...}` interpolation, as
   * in query-stats.ts, is not followed; query-stats.int.test.ts guards that.
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
        // Each ORDER BY clause, bounded — not one slice from the first
        // `ORDER BY` to the end of the block. A CTE with its own `ORDER BY`
        // (sequences.ts's `DISTINCT ON` requires one) would otherwise put
        // every outer `::text AS` alias inside the slice and report it.
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
   * Catches the pre-commit hook dropping this package's own typecheck.
   * `typecheck:test` also compiles src, but only this project sets
   * `rootDir: "./src"` and excludes `test`, so only it rejects a src file
   * importing from `test/` (TS6059) — the leak that would drag test-only code
   * into the published `dist/`.
   *
   * Anchored to a whole command line: the hook's own `#` comments quote the
   * command, and an unanchored match would read a commented-out step as green.
   */
  it('runs this package\'s own typecheck before a commit — the package\'s own project, the one build emits from', () => {
    const hook = readFileSync(new URL('../../../.githooks/pre-commit', import.meta.url), 'utf8');
    expect(hook).toMatch(/^npm run --workspace @pgops\/checks typecheck\s*$/m);
  });

  /**
   * Catches the pre-commit hook dropping the build. `package.json` points
   * into `dist/`, which is gitignored and which no `--noEmit` typecheck
   * produces, so without this step a local import resolves against a stale
   * build and a clean checkout fails with MODULE_NOT_FOUND.
   * Anchored for the same reason as the typecheck assertion.
   */
  it('builds this package before a commit — main/types/exports point at dist/', () => {
    const hook = readFileSync(new URL('../../../.githooks/pre-commit', import.meta.url), 'utf8');
    expect(hook).toMatch(/^npm run --workspace @pgops\/checks build\s*$/m);
  });

  /**
   * Catches a slow step returning to pre-push. `git push` opens the
   * connection to the remote before it runs the hook, so a fifteen-minute
   * hook holds an idle `git-receive-pack` session until the remote drops it
   * and git dies with exit 141 (SIGPIPE) and no output. The slow steps live
   * in `scripts/gate.sh`.
   */
  it('does not run the slow gates from pre-push — git holds the connection open while it runs', () => {
    const hook = readFileSync(new URL('../../../.githooks/pre-push', import.meta.url), 'utf8');
    // Anchored to command lines: the hook's comments name these steps too.
    expect(hook).not.toMatch(/^\s*(PGOPS_TEST_PG_VERSION=\S+ )?npm run test:int\s*$/m);
    expect(hook).not.toMatch(/^\s*\.\/scripts\/gate\.sh\s*$/m);
    expect(hook).not.toMatch(/^\s*\.\/scripts\/image-smoke\.sh\s*$/m);
  });

  /**
   * Catches a fast hook that no longer refuses an ungated push. It requires a
   * receipt for each SHA pushed, so committing after gating invalidates it.
   */
  it('verifies every pushed sha against a gate receipt', () => {
    const hook = readFileSync(new URL('../../../.githooks/pre-push', import.meta.url), 'utf8');
    expect(hook).toMatch(/while read/);
    expect(hook).toMatch(/pgops-gate-receipt/);
  });

  /**
   * Catches the slow steps being dropped rather than moved: deleting them
   * outright would satisfy the "pre-push is fast" test above.
   */
  it('runs the integration suite and the image smoke test from the gate script', () => {
    const gate = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
    expect(gate).toMatch(/^\s*PGOPS_TEST_PG_VERSION="\$v" npm run test:int\s*$/m);
    expect(gate).toMatch(/^\s*\.\/scripts\/image-smoke\.sh\s*$/m);
  });

  /**
   * Catches a release that bumps some of the four copies of the version and
   * not the rest: three manifests and the README's status line, which no
   * build reads. A mismatch throws nowhere.
   */
  it('names one version in every manifest and in the README', () => {
    const version = (path: string): string =>
      JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).version;
    const root = version('../../../package.json');
    expect(root, 'the root package.json must carry a version').toMatch(/^\d+\.\d+\.\d+$/);
    expect(version('../package.json'), 'packages/checks disagrees with the root').toBe(root);
    expect(version('../../../apps/web/package.json'), 'apps/web disagrees with the root').toBe(root);

    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const stated = /^- \*\*Status:\*\* v(\d+\.\d+\.\d+)\./m.exec(readme);
    expect(stated, 'no "- **Status:** vX.Y.Z." line in the README').not.toBeNull();
    expect(stated![1], "the README's status line disagrees with the manifests").toBe(root);
  });

  /** A gate that does not record what it gated cannot be checked by the hook. */
  it('records the sha the gate passed on', () => {
    const gate = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
    expect(gate).toMatch(/pgops-gate-receipt/);
  });

  /** Catches `outDir` drifting from the paths package.json advertises. */
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

/**
 * The pre-push hook, run rather than read: a source grep cannot answer "does
 * a push of X succeed". For refs/tags/* git feeds the hook the tag object's
 * sha, while the receipt holds commits, so a hook comparing them directly
 * refuses every annotated tag.
 *
 * A throwaway repository, because the tests need an ungated commit and a
 * published one, and making either here would write to this repository's
 * own receipt.
 */
/**
 * What migrate() tells an operator whose store a newer pgops has migrated
 * must be true of the migrations that exist: a rolling deploy with an older
 * replica loses whatever a dropping migration took.
 */
describe('the store migrations', () => {
  it('are not called additive while one of them drops a table', () => {
    const dir = join(SRC, 'store', 'migrations');
    const drops = readdirSync(dir).filter((f) => /\bDROP TABLE\b/.test(readFileSync(join(dir, f), 'utf8')));
    expect(drops).toEqual(['008-drop-check-results.ts']);
    const schema = readFileSync(join(SRC, 'store', 'schema.ts'), 'utf8');
    expect(schema.replace(/\n\s*\/\/ ?/g, ' ')).not.toMatch(/migrations are additive/);
    expect(schema).toContain('008 drops pgops.check_results');
  });
});

describe('the pre-push hook, against a throwaway repository', () => {
  const HOOK = new URL('../../../.githooks/pre-push', import.meta.url).pathname;
  const ZERO = '0'.repeat(40);
  /**
   * Run from the pre-commit hook, git has set GIT_DIR and GIT_INDEX_FILE. In
   * a worktree GIT_DIR is absolute, and a child git would commit, tag and
   * configure this repository instead of the throwaway one.
   */
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

  /**
   * Three commits: one already on the remote, one named by the receipt, one
   * neither. `update-ref` stands in for a real push: the hook only reads
   * refs/remotes/origin/*.
   */
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'pgops-pre-push-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'Test');
    const commit = (name: string): string => {
      writeFileSync(join(dir, name), name);
      git(dir, 'add', name);
      git(dir, 'commit', '-qm', name);
      return git(dir, 'rev-parse', 'HEAD');
    };
    const published = commit('a');
    const gated = commit('b');
    const ungated = commit('c');
    git(dir, 'update-ref', 'refs/remotes/origin/main', published);
    writeFileSync(join(dir, '.git', 'pgops-gate-receipt'), `${gated}\n`);
    return { dir, published, gated, ungated };
  }

  /** One stdin line per ref, exactly as git writes them. */
  const push = (dir: string, lines: string[]) =>
    spawnSync('sh', [HOOK, 'origin', 'git@example.invalid:o/r.git'], {
      cwd: dir,
      env,
      input: lines.map((l) => `${l}\n`).join(''),
      encoding: 'utf8',
    });

  it('accepts an annotated tag whose commit the receipt names', () => {
    const { dir, gated } = fixture();
    git(dir, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0', gated);
    const tagObject = git(dir, 'rev-parse', 'v1.0.0');
    // Precondition: the sha git hands the hook is not the commit.
    expect(tagObject).not.toBe(gated);

    const r = push(dir, [`refs/tags/v1.0.0 ${tagObject} refs/tags/v1.0.0 ${ZERO}`]);
    expect(r.stderr).not.toMatch(/refusing/);
    expect(r.status).toBe(0);
  });

  it('accepts a tag whose commit predates the receipt but is already on the remote', () => {
    const { dir, published } = fixture();
    git(dir, 'tag', '-a', 'v0.9.0', '-m', 'v0.9.0', published);
    const tagObject = git(dir, 'rev-parse', 'v0.9.0');
    const r = push(dir, [`refs/tags/v0.9.0 ${tagObject} refs/tags/v0.9.0 ${ZERO}`]);
    expect(r.stderr).not.toMatch(/refusing/);
    expect(r.status).toBe(0);
  });

  /** A commit made after the gate ran is neither published nor in the receipt. */
  it('still refuses a commit that is neither gated nor already published', () => {
    const { dir, ungated } = fixture();
    const r = push(dir, [`refs/heads/main ${ungated} refs/heads/main ${ZERO}`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing/);
    expect(r.stderr).toContain(ungated);
  });

  it('accepts a branch deletion, which publishes nothing', () => {
    const { dir, ungated } = fixture();
    const r = push(dir, [`(delete) ${ZERO} refs/heads/gone ${ungated}`]);
    expect(r.status).toBe(0);
  });
});
