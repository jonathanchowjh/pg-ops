// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKS, HOMES, type Home } from '@pgops/checks';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const DB = join(WEB, 'app', 'db', '[name]');
const strip = (code: string) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The pages a node kind is drawn on: the tree, or that node's own page and
 * its population. Server has no page until Stage 3; until then its reads
 * are on the layout's status line, the tree's findings and the old Cleanup
 * page, which 3.1 replaces with `/server`.
 */
const PAGES: Record<Home, string[]> = {
  database: ['page.tsx'],
  session: ['page.tsx'],
  table: ['tables/page.tsx', 'tables/[relation]/page.tsx'],
  query: ['queries/page.tsx', 'queries/[queryid]/page.tsx'],
  index: ['indexes/page.tsx', 'tables/[relation]/page.tsx'],
  sequence: ['tables/page.tsx', 'tables/[relation]/page.tsx'],
  server: ['layout.tsx', 'page.tsx', 'cleanup/page.tsx'],
};

/**
 * Checks with no reader under `/db/[name]` yet, each with the task that
 * gives it one or takes it away. The fleet page is their one reader, which
 * the third test holds, so an entry here cannot hide an orphan.
 */
const UNTIL_STAGE_3: Record<string, string> = {
  activity: '3.2 deletes it with the old fleet page',
  blocked: '3.2 deletes it with the old fleet page',
  locks: '3.2 deletes it with the old fleet page',
  longRunning: '3.2 deletes it with the old fleet page',
  sessionStates: '3.2 deletes it with the old fleet page',
  connectionDetail: '3.1 draws it on Server: who holds the connections',
  databaseActivity: '3.1 draws it on Server: the deadlock counter and the statistics reset',
};

/** A page's source and the source of each `@/lib` module it imports. */
function reach(page: string): string {
  const file = join(DB, page);
  if (!existsSync(file)) throw new Error(`no page at ${page}`);
  const code = strip(readFileSync(file, 'utf8'));
  const libs = [...code.matchAll(/from\s+'@\/lib\/([\w-]+)'/g)].map((m) => join(WEB, 'lib', `${m[1]!}.ts`));
  return [code, ...libs.filter((f) => existsSync(f)).map((f) => strip(readFileSync(f, 'utf8')))].join('\n');
}
const names = (code: string, id: string): boolean => new RegExp(`CHECKS\\.${id}\\b`).test(code);

describe('every check has a home that draws it', () => {
  it('names a page that exists for every node kind', () => {
    expect(Object.keys(PAGES).sort()).toEqual([...HOMES].sort());
    for (const pages of Object.values(PAGES)) for (const p of pages) expect(existsSync(join(DB, p)), p).toBe(true);
  });

  it('reads each check from the tree or from its node\'s own page', () => {
    const orphans: string[] = [];
    for (const [id, check] of Object.entries(CHECKS)) {
      if (id in UNTIL_STAGE_3) continue;
      if (!PAGES[check.home].some((p) => names(reach(p), id))) orphans.push(`${id} (${check.home})`);
    }
    expect(orphans).toEqual([]);
  });

  it('holds each exception to the fleet page, and to still being one', () => {
    const fleet = strip(readFileSync(join(WEB, 'app', 'page.tsx'), 'utf8'));
    for (const id of Object.keys(UNTIL_STAGE_3)) {
      expect(CHECKS, `${id} is gone; delete its line`).toHaveProperty(id);
      expect(names(fleet, id), `${id} has no reader at all`).toBe(true);
      const home = (CHECKS as Record<string, { home: Home }>)[id]!.home;
      expect(PAGES[home].some((p) => names(reach(p), id)), `${id} is drawn now; delete its line`).toBe(false);
    }
  });

  it('draws no captured read from a page that polls without going through the catalog', () => {
    for (const page of ['page.tsx', 'queries/page.tsx', 'queries/[queryid]/page.tsx', 'tables/[relation]/page.tsx']) {
      const own = strip(readFileSync(join(DB, page), 'utf8'));
      for (const [id, check] of Object.entries(CHECKS)) {
        if (check.class === 'captured') expect(names(own, id), `${page} runs ${id} on its poll`).toBe(false);
      }
    }
  });
});
