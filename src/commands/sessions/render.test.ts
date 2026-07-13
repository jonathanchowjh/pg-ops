import { describe, expect, it } from 'vitest';
import { sessionsToMarkdown } from './render.js';
import type { SessionRow } from './query.js';

const row: SessionRow = {
  pid: 4711,
  state: 'idle in transaction',
  user: 'app',
  app: 'web',
  clientAddr: '10.0.0.1',
  backendStart: '2026-07-12 10:00:00+00',
  inStateSecs: 840,
  runningSecs: null,
  query: 'BEGIN; UPDATE orders SET status = $1',
};

describe('sessionsToMarkdown', () => {
  it('renders a table with pid, state, age, user@app, and query', () => {
    const md = sessionsToMarkdown([row]);
    expect(md).toContain('| 4711 |');
    expect(md).toContain('idle in transaction');
    expect(md).toContain('app@web');
    expect(md).toContain('14m');
  });

  it('says so when there are no client sessions', () => {
    expect(sessionsToMarkdown([])).toContain('No client sessions');
  });

  it('escapes pipes in the query so the markdown table is not shattered', () => {
    const pipeRow: SessionRow = {
      ...row,
      query: "SELECT first_name || ' ' || last_name FROM users",
    };
    const md = sessionsToMarkdown([pipeRow]);
    const dataLine = md.split('\n').find((l) => l.startsWith(`| ${pipeRow.pid} |`))!;
    // header has 6 columns -> 7 pipe-delimiters; the data row must match, meaning
    // every `|` from the query text was escaped rather than left as a raw delimiter.
    const headerLine = md.split('\n')[0];
    const headerPipes = (headerLine.match(/\|/g) || []).length;
    const dataPipes = (dataLine.match(/(?<!\\)\|/g) || []).length;
    expect(dataPipes).toBe(headerPipes);
    expect(dataLine).toContain("first_name \\|\\| ' ' \\|\\| last_name");
  });

  it('escapes pipes in other text fields too', () => {
    const pipeRow: SessionRow = {
      ...row,
      app: 'weird|app',
      clientAddr: '10.0.0.1|extra',
    };
    const md = sessionsToMarkdown([pipeRow]);
    const dataLine = md.split('\n').find((l) => l.startsWith(`| ${pipeRow.pid} |`))!;
    const headerPipes = (md.split('\n')[0].match(/\|/g) || []).length;
    const dataPipes = (dataLine.match(/(?<!\\)\|/g) || []).length;
    expect(dataPipes).toBe(headerPipes);
    expect(dataLine).toContain('weird\\|app');
    expect(dataLine).toContain('10.0.0.1\\|extra');
  });
});
