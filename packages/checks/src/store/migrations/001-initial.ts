/**
 * Migration 001 — the initial pgops schema.
 *
 * A TypeScript module exporting a string, not a .sql file: `packages/checks`
 * builds with plain `tsc`, which would not copy a .sql file into dist/.
 *
 * This directory is the only place in the product permitted to contain DDL;
 * apps/web/test/guards.test.ts holds this.
 */
export const SQL = `
CREATE SCHEMA IF NOT EXISTS pgops;

CREATE TABLE IF NOT EXISTS pgops.schema_version (
  version int NOT NULL,
  -- One row, enforced. A second row would make "what version is this store"
  -- ambiguous, and the runner reads it with a bare SELECT.
  singleton bool NOT NULL DEFAULT true UNIQUE CHECK (singleton)
);

CREATE TABLE IF NOT EXISTS pgops.databases (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Query text is stored ONCE per shape, not once per capture. A 5,000-shape
-- database capturing every 5 minutes would otherwise write roughly
-- 1 kB x 5,000 x 288/day of duplicated text. pgHero normalises the same way.
CREATE TABLE IF NOT EXISTS pgops.queries (
  id          serial PRIMARY KEY,
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  -- bigint: pg_stat_statements' 64-bit hash. Identity only, never arithmetic.
  queryid     bigint NOT NULL,
  -- Redacted before insert (redactSecrets). The store is durable; a secret in
  -- a query literal written here outlives every screenshot.
  query       text NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (database_id, queryid)
);

-- CUMULATIVE counters, never deltas. pgops does not reset pg_stat_statements
-- (doing so silently breaks every other consumer on the database), so deltas
-- are computed at read time from consecutive snapshots. See series/query-stats.
CREATE TABLE IF NOT EXISTS pgops.query_stats (
  database_id      int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  query_id         int NOT NULL REFERENCES pgops.queries(id) ON DELETE CASCADE,
  captured_at      timestamptz NOT NULL,
  calls            bigint NOT NULL,
  total_exec_time  double precision NOT NULL,
  rows             bigint NOT NULL,
  shared_blks_hit  bigint NOT NULL,
  shared_blks_read bigint NOT NULL,
  -- From pg_stat_statements_info (PG14+). An advance here marks a
  -- discontinuity: the interval spanning it is dropped, never charted.
  stats_reset      timestamptz,
  PRIMARY KEY (database_id, query_id, captured_at)
);

CREATE INDEX IF NOT EXISTS query_stats_captured_at_idx
  ON pgops.query_stats (database_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS pgops.space_stats (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  relation    text NOT NULL,
  captured_at timestamptz NOT NULL,
  size_bytes  bigint NOT NULL,
  PRIMARY KEY (database_id, relation, captured_at)
);

CREATE INDEX IF NOT EXISTS space_stats_captured_at_idx
  ON pgops.space_stats (database_id, captured_at DESC);
`;
