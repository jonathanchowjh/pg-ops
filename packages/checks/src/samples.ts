import { createHash } from 'node:crypto';
import type { SessionClass, SessionsData } from './checks/sessions.js';
import { statementShape } from './redact.js';

/** One sample per database per this many milliseconds, whoever takes it. */
export const BUCKET_MS = 15_000;

export interface SampleSession {
  pid: number;
  /** As Postgres printed it. With `pid` it is the session; the terminate guard compares it as text. */
  backendStart: string;
  app: string | null;
  cls: SessionClass;
  /** When this state began; for a lock wait, when the wait began. Milliseconds. */
  since: number;
  /** A key into the statements map, or null when this role cannot read the text. */
  statement: string | null;
  /**
   * Tables it holds or wants a lock on. A lock waiter's first is the table
   * it waits for, which is where its chain is; the rest are strongest first.
   * Empty: not on any table.
   */
  relations: string[];
  blockedBy: number | null;
}

export interface Sample { at: number; sessions: SampleSession[]; hidden: boolean; truncated: boolean }
export interface StatementInfo { text: string; relations: string[] }

const HIDDEN_TEXT = '<insufficient privilege>';

/**
 * A statement's key: its `query_id`, or a hash of its shape when
 * `compute_query_id` is off. The text is the shape, literals out, because
 * it is stored for as long as the samples: two sessions whose statements
 * differ only in a value share a key, and no value is hashed into something
 * that could be compared.
 */
function keyed(queryId: string | null, query: string | null): { key: string; text: string } | null {
  if (query === null || query === HIDDEN_TEXT) return null;
  const text = statementShape(query);
  if (text === '') return null;
  return { key: queryId ?? `t${createHash('md5').update(text).digest('hex').slice(0, 16)}`, text };
}

/**
 * The sample a sessions read is: one row per session not idle. Idle
 * sessions, sessions this role cannot see and pgops's own are not counted.
 */
export function sampleOf(data: SessionsData, at: number): { sample: Sample; texts: Map<string, StatementInfo> } {
  const texts = new Map<string, StatementInfo>();
  const sessions: SampleSession[] = [];
  for (const s of data.sessions) {
    if (s.cls === null || s.own || s.backendStart === null) continue;
    const statement = keyed(s.queryId, s.query);
    if (statement !== null) {
      const known = texts.get(statement.key);
      const relations = [...new Set([...(known?.relations ?? []), ...s.relations])].sort();
      texts.set(statement.key, { text: known?.text ?? statement.text, relations });
    }
    const ageSecs = s.cls === 'lock' && s.waitSecs !== null ? s.waitSecs : s.inStateSecs ?? 0;
    sessions.push({
      pid: s.pid,
      backendStart: s.backendStart,
      app: s.app,
      cls: s.cls,
      since: Math.round(at - ageSecs * 1000),
      statement: statement?.key ?? null,
      relations: s.cls === 'lock' && s.wanted != null
        ? [s.wanted, ...s.relations.filter((r) => r !== s.wanted)] : s.relations,
      blockedBy: s.blockedBy.length === 0 ? null : Math.min(...s.blockedBy),
    });
  }
  return { sample: { at, sessions, hidden: data.hidden > 0, truncated: data.truncated }, texts };
}

/** The tables a sample has a lock wait on. '' is a wait on no table. */
export function lockTables(sample: Sample): string[] {
  return [...new Set(sample.sessions.filter((s) => s.cls === 'lock').map((s) => s.relations[0] ?? ''))].sort();
}

/** Past this since the sample before, the sampler is taken to have stopped looking. */
const RECENT_MS = 60_000;

/**
 * What changed between the sample before and this one, each stamped. Within
 * a minute, `before` is what "before" means. Older than that is a gap: what
 * it saw waiting is closed at the bucket after it, the last moment anyone
 * saw it, or a chain that cleared while nobody looked would run to the end
 * of every window that holds its beginning; and a wait seen now begins
 * again. The store and the memory of a console with no store both say it
 * this way.
 */
export function chainEvents(
  before: { bucket: number; tables: readonly string[] } | null,
  sample: Sample,
  bucket: number,
): { at: number; kind: 'chain-begin' | 'chain-end'; relation: string }[] {
  const recent = before !== null && bucket - before.bucket <= RECENT_MS;
  const now = lockTables(sample);
  const was = recent ? before.tables : [];
  return [
    ...(before !== null && !recent
      ? before.tables.map((relation) => ({ at: before.bucket + BUCKET_MS, kind: 'chain-end' as const, relation })) : []),
    ...now.filter((r) => !was.includes(r)).map((relation) => ({ at: bucket, kind: 'chain-begin' as const, relation })),
    ...was.filter((r) => !now.includes(r)).map((relation) => ({ at: bucket, kind: 'chain-end' as const, relation })),
  ];
}

export type EventKind =
  | 'chain-begin' | 'chain-end' | 'unreachable' | 'reachable' | 'terminate' | 'analyze' | 'reset' | 'vacuum';

export interface StoredEvent { at: number; kind: EventKind; /** '' is the database. */ relation: string }
/** One column of one node's load: mean sessions of one class. `kind` is d, t or q. */
export interface LoadCell { col: number; kind: 'd' | 't' | 'q'; key: string; cls: SessionClass; sessions: number }
