/**
 * Migration 007 — the catalog as the capture last read it, and its hours.
 *
 * `captures` is one row per captured read: when it was read, whether the
 * read worked, how many rows the catalog held before the cap, and the
 * statistics reset its counters run from. `captured` is that read's rows,
 * replaced whole by each capture: the current catalog, not a history. A
 * row is the check's own, as jsonb, so a field added to a read needs no
 * migration.
 *
 * The history is the two hourly tables. `table_hours` holds what was
 * written and read in the hour, differenced by the capture from the
 * cumulative counters, and the newest gauges. `index_hours` holds scans,
 * and only for an index that was scanned: no row is no scan.
 */
export const SQL = `
CREATE TABLE IF NOT EXISTS pgops.captures (
  database_id    int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  read           text NOT NULL,
  captured_at    timestamptz NOT NULL,
  ok             boolean NOT NULL,
  message        text,
  total          int NOT NULL,
  stats_reset    timestamptz,
  freeze_max_age double precision,
  PRIMARY KEY (database_id, read)
);
CREATE TABLE IF NOT EXISTS pgops.captured (
  database_id int NOT NULL,
  read        text NOT NULL,
  name        text NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (database_id, read, name),
  FOREIGN KEY (database_id, read) REFERENCES pgops.captures ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pgops.table_hours (
  database_id    int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  hour           timestamptz NOT NULL,
  relation       text NOT NULL,
  inserted       bigint NOT NULL,
  updated        bigint NOT NULL,
  deleted        bigint NOT NULL,
  index_rows     bigint NOT NULL,
  scan_rows      bigint NOT NULL,
  live_rows      bigint NOT NULL,
  dead_rows      bigint NOT NULL,
  vacuum_trigger double precision NOT NULL,
  PRIMARY KEY (database_id, relation, hour)
);
CREATE TABLE IF NOT EXISTS pgops.index_hours (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  hour        timestamptz NOT NULL,
  index_name  text NOT NULL,
  scans       bigint NOT NULL,
  PRIMARY KEY (database_id, index_name, hour)
);
`;
