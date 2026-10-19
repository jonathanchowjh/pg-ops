/**
 * The clock's storage.
 *
 * `sample_buckets` is the claim: whoever inserts a database's bucket first
 * writes its sessions, and everyone else skips. An empty bucket is still a
 * row, because "pgops looked and nothing was running" is a reading.
 *
 * `load_minutes` holds the mean sessions per class for the database ('d',
 * key ''), each table ('t', key '' for sessions on no table) and each
 * statement ('q'). Each is counted from the samples, none summed from
 * another: a session on three tables is in three 't' rows and one 'd' row.
 *
 * `backend_start` is text, as Postgres printed it, because the terminate
 * guard compares it as text.
 */
export const SQL = `
CREATE TABLE IF NOT EXISTS pgops.sample_buckets (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  bucket      timestamptz NOT NULL,
  hidden      boolean NOT NULL,
  truncated   boolean NOT NULL,
  PRIMARY KEY (database_id, bucket)
);
CREATE TABLE IF NOT EXISTS pgops.session_samples (
  database_id   int NOT NULL,
  bucket        timestamptz NOT NULL,
  pid           int NOT NULL,
  backend_start text NOT NULL,
  app           text,
  class         text NOT NULL,
  since         timestamptz NOT NULL,
  statement     text,
  relations     text[] NOT NULL,
  blocked_by    int,
  PRIMARY KEY (database_id, bucket, pid),
  FOREIGN KEY (database_id, bucket) REFERENCES pgops.sample_buckets ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pgops.sample_statements (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  key         text NOT NULL,
  query       text NOT NULL,
  relations   text[] NOT NULL,
  PRIMARY KEY (database_id, key)
);
CREATE TABLE IF NOT EXISTS pgops.load_minutes (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  minute      timestamptz NOT NULL,
  kind        text NOT NULL,
  key         text NOT NULL,
  class       text NOT NULL,
  sessions    real NOT NULL,
  PRIMARY KEY (database_id, minute, kind, key, class)
);
CREATE TABLE IF NOT EXISTS pgops.events (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL,
  kind        text NOT NULL,
  relation    text NOT NULL DEFAULT '',
  PRIMARY KEY (database_id, at, kind, relation)
);
`;
