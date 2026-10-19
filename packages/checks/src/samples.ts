import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { SessionClass, SessionsData } from './checks/sessions.js';
import { statementShape } from './redact.js';
import { guardClient } from './run.js';
import { SAMPLE_LOCK_NS } from './store/lock.js';
import { upsertDatabase } from './store/write.js';

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

/** The bucket a moment falls in. `$1` is the moment; null means the store's now. */
const BUCKET = `to_timestamp(floor(extract(epoch FROM COALESCE($1::timestamptz, now())) / 15) * 15)`;

/**
 * Write one sample into its bucket, or find the bucket already written.
 *
 * The bucket is the store's clock, not this process's: two replicas and
 * three browser tabs all poll the same database, and the bucket row's
 * primary key is what makes exactly one of them the sample.
 *
 * One transaction, and it never waits on the monitored database: the
 * sample was read before this was called.
 */
export async function recordSample(
  store: Pool,
  name: string,
  sample: Sample,
  texts: ReadonlyMap<string, StatementInfo>,
  at?: Date,
): Promise<'written' | 'filled'> {
  const client = await store.connect();
  const release = guardClient(client);
  try {
    const databaseId = await upsertDatabase(client, name);
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [SAMPLE_LOCK_NS, databaseId]);
    const claim = await client.query<{ bucket: Date; at: Date }>(
      `INSERT INTO pgops.sample_buckets (database_id, bucket, hidden, truncated)
       VALUES ($2, ${BUCKET}, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING bucket, COALESCE($1::timestamptz, now()) AS at`,
      [at ?? null, databaseId, sample.hidden, sample.truncated],
    );
    if (claim.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'filled';
    }
    const { bucket, at: storeAt } = claim.rows[0]!;

    // `since` is written as an age back from the store's moment, so a
    // process whose clock is off does not shift every span.
    await client.query(
      `INSERT INTO pgops.session_samples
         (database_id, bucket, pid, backend_start, app, class, since, statement, relations, blocked_by)
       SELECT $1, $2, s.pid, s.backend_start, s.app, s.class,
              $3::timestamptz - s.age_ms * interval '1 millisecond', s.statement,
              ARRAY(SELECT jsonb_array_elements_text(s.relations)), s.blocked_by
         FROM jsonb_to_recordset($4::jsonb)
           AS s(pid int, backend_start text, app text, class text, age_ms double precision,
                statement text, relations jsonb, blocked_by int)
       ON CONFLICT DO NOTHING`,
      [databaseId, bucket, storeAt, JSON.stringify(sample.sessions.map((s) => ({
        pid: s.pid, backend_start: s.backendStart, app: s.app, class: s.cls,
        age_ms: sample.at - s.since, statement: s.statement, relations: s.relations, blocked_by: s.blockedBy,
      })))],
    );

    await client.query(
      `INSERT INTO pgops.sample_statements (database_id, key, query, relations)
       SELECT $1, t.key, t.query, ARRAY(SELECT jsonb_array_elements_text(t.relations))
         FROM jsonb_to_recordset($2::jsonb) AS t(key text, query text, relations jsonb)
       ON CONFLICT (database_id, key) DO UPDATE
          SET relations = ARRAY(SELECT DISTINCT r
                                  FROM unnest(pgops.sample_statements.relations || EXCLUDED.relations) AS r
                                 ORDER BY r
                               )
        WHERE NOT pgops.sample_statements.relations @> EXCLUDED.relations`,
      [databaseId, JSON.stringify([...texts].map(([key, v]) => ({ key, query: v.text, relations: v.relations })))],
    );

    // Every class seen in this minute is recomputed, so each row's mean is
    // over the buckets the minute has so far.
    await client.query(
      `WITH m AS (SELECT date_trunc('minute', $2::timestamptz) AS minute),
       n AS (SELECT count(*)::real AS buckets FROM pgops.sample_buckets b, m
              WHERE b.database_id = $1 AND b.bucket >= m.minute AND b.bucket < m.minute + interval '1 minute'),
       s AS (SELECT x.* FROM pgops.session_samples x, m
              WHERE x.database_id = $1 AND x.bucket >= m.minute AND x.bucket < m.minute + interval '1 minute'),
       r AS (
         SELECT 'd' AS kind, '' AS key, class, count(*) AS c FROM s GROUP BY class
         UNION ALL
         SELECT 't', t.relation, s.class, count(*)
           FROM s CROSS JOIN LATERAL unnest(CASE WHEN cardinality(s.relations) = 0 THEN ARRAY['']
                                                 ELSE s.relations END) AS t(relation)
          GROUP BY t.relation, s.class
         UNION ALL
         SELECT 'q', statement, class, count(*) FROM s WHERE statement IS NOT NULL GROUP BY statement, class
       )
       INSERT INTO pgops.load_minutes (database_id, minute, kind, key, class, sessions)
       SELECT $1, m.minute, r.kind, r.key, r.class, r.c / n.buckets FROM r, m, n
       ON CONFLICT (database_id, minute, kind, key, class) DO UPDATE SET sessions = EXCLUDED.sessions`,
      [databaseId, bucket],
    );

    // The sample before this one, however long ago: `chainEvents` says what a gap means.
    const { rows: prior } = await client.query<{ relations: string[]; bucket: Date }>(
      `SELECT ARRAY(SELECT DISTINCT COALESCE(s.relations[1], '')
                      FROM pgops.session_samples s
                     WHERE s.database_id = $1 AND s.bucket = b.bucket AND s.class = 'lock') AS relations,
              b.bucket
         FROM pgops.sample_buckets b
        WHERE b.database_id = $1 AND b.bucket < $2
        ORDER BY b.bucket DESC
        LIMIT 1`,
      [databaseId, bucket],
    );
    const before = prior[0];
    const marks = chainEvents(
      before === undefined ? null : { bucket: before.bucket.getTime(), tables: before.relations },
      sample,
      bucket.getTime(),
    );
    for (const e of marks) {
      await client.query(
        `INSERT INTO pgops.events (database_id, at, kind, relation) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [databaseId, new Date(e.at), e.kind, e.relation],
      );
    }
    await client.query('COMMIT');
    return 'written';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    release();
  }
}

/** Whether this database's bucket at `at` (the store's now when omitted) is written. The sampler's skip. */
export async function bucketFilled(store: Pool, name: string, at?: Date): Promise<boolean> {
  const { rowCount } = await store.query(
    `SELECT 1 FROM pgops.sample_buckets b JOIN pgops.databases d ON d.id = b.database_id
      WHERE d.name = $2 AND b.bucket = ${BUCKET}`,
    [at ?? null, name],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Record an event at the store's now. `unreachable` and `reachable` are
 * transitions: written only when the last of the pair was the other one, so
 * an outage is one mark and not one per tick.
 */
export async function recordEvent(store: Pool, name: string, kind: EventKind, relation = ''): Promise<void> {
  const client = await store.connect();
  const release = guardClient(client);
  try {
    const databaseId = await upsertDatabase(client, name);
    const transition = kind === 'unreachable' || kind === 'reachable';
    await client.query(
      `INSERT INTO pgops.events (database_id, at, kind, relation)
       SELECT $1, now(), $2, $3
        WHERE NOT $4::boolean
           OR COALESCE((SELECT e.kind FROM pgops.events e
                         WHERE e.database_id = $1 AND e.kind IN ('unreachable', 'reachable')
                         ORDER BY e.at DESC LIMIT 1), 'reachable') <> $2
       ON CONFLICT DO NOTHING`,
      [databaseId, kind, relation, transition],
    );
  } finally {
    release();
  }
}
export interface StoredEvent { at: number; kind: EventKind; /** '' is the database. */ relation: string }
/** One column of one node's load: mean sessions of one class. `kind` is d, t or q. */
export interface LoadCell { col: number; kind: 'd' | 't' | 'q'; key: string; cls: SessionClass; sessions: number }
