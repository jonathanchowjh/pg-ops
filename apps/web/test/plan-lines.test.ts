import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanNode } from '@pgops/checks';
import { planLines } from '@/lib/format';

/**
 * Each case is one statement's `EXPLAIN (FORMAT JSON, VERBOSE)` and its
 * `EXPLAIN (VERBOSE)` text, captured together from Postgres 17. planLines
 * claims to print "the shape EXPLAIN has printed for decades"; this holds it
 * to what EXPLAIN actually printed, node line by node line.
 *
 * Node lines only — the ones carrying a cost. Detail lines are a subset by
 * design (no `Output:`), and are held by format.test.ts.
 */
const CASES = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'plans-pg17.json'), 'utf8')) as
  { statement: string; json: PlanNode; text: string[] }[];

const nodeLines = (lines: string[]) => lines.filter((l) => l.includes('(cost='));

describe('planLines against real EXPLAIN output', () => {
  it.each(CASES.map((c) => [c.statement, c] as const))('%s', (_s, c) => {
    expect(nodeLines(planLines(c.json))).toEqual(nodeLines(c.text));
  });
});
