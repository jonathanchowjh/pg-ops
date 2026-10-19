import { describe, expect, it } from 'vitest';
import { redactTree } from '@/components/sql';
import type { StatementNode, Tree } from '@/lib/tree';

const statement = (text: string | null): StatementNode => ({
  key: 'k', text, strip: [], tables: [], sessions: [], more: 0, unplaced: false, callsPerSec: null, meanMs: null,
});
const tree = (s: StatementNode): Tree => ({
  tables: [{ name: 'public.users', strip: [], open: true, shapes: 1, statements: [s], more: 0 }],
  none: { name: '', strip: [], open: true, shapes: 1, statements: [s], more: 0 },
  flat: [s],
} as unknown as Tree);

describe('redactTree', () => {
  it('masks a secret in every statement, under a table and under no table', () => {
    const out = redactTree(tree(statement("ALTER USER app PASSWORD 'hunter2'")));
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(out.tables[0]!.statements[0]!.text).toContain('ALTER USER app');
    expect(out.none!.statements[0]!.text).not.toContain('hunter2');
    expect(out.flat[0]!.text).toContain('ALTER USER app');
  });

  it('leaves a statement the role could not read as it is', () => {
    expect(redactTree(tree(statement(null))).tables[0]!.statements[0]!.text).toBeNull();
  });
});
