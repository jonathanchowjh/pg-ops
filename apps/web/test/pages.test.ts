// `node`, not jsdom, for the reason given in scaffold.test.ts.
// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGES } from '@/components/sidebar';

const APP = fileURLToPath(new URL('../app', import.meta.url));
const strip = (code: string) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const pageFor = (segment: string | null): string =>
  (segment === null ? join(APP, 'db', '[name]', 'page.tsx') : join(APP, 'db', '[name]', segment, 'page.tsx'));

describe('the sidebar\'s pages', () => {
  it('names a page that exists, for every entry', () => {
    for (const p of PAGES) expect(existsSync(pageFor(p.segment)), `${p.label || 'the tree'} points at no page`).toBe(true);
  });

  it('declares that a page polls for exactly the pages that do', () => {
    for (const p of PAGES) {
      const polls = /<Refresh\b/.test(strip(readFileSync(pageFor(p.segment), 'utf8')));
      expect(polls, `${p.label || 'the tree'}: polls is declared ${p.polls}`).toBe(p.polls);
    }
  });

  it('puts the database first, with no label of its own', () => {
    expect(PAGES[0]).toMatchObject({ segment: null, href: '', label: '' });
  });
});
