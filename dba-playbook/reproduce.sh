#!/usr/bin/env bash
#
# Manufacture a scenario so a playbook file has something real to observe.
# Reuses the dev container from scripts/dev-db.sh (start it first: npm run db:up).
#
#   ./dba-playbook/reproduce.sh lock-chain    # live lock contention   (for 01)
#   ./dba-playbook/reproduce.sh slow-queries  # seed pg_stat_statements (for 02)
#   ./dba-playbook/reproduce.sh bloat         # dead tuples + idle txn  (for 03)
#
# lock-chain and bloat hold a session open until you Ctrl-C (the contention only
# exists while the holding transaction is open — that's the whole point).
# slow-queries just loads data + runs queries, then exits.
#
# Read-only files (04 slots, 05 migration) need no scenario — 04 reads an empty
# slot table on a single-node dev DB (the healthy answer); 05 is preventive.
set -euo pipefail

NAME="pgops-dev"
DB="appdb"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

docker ps -q -f "name=^${NAME}$" | grep -q . || {
  echo "dev container '${NAME}' not running. Start it: npm run db:up" >&2
  exit 1
}

# Run SQL inside the container (mirrors scripts/dev-db.sh's psql access).
psql_c() { docker exec -i "$NAME" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

case "${1:-}" in
  lock-chain)
    # The existing seeder already does this perfectly — defer to it.
    echo "→ manufacturing a lock chain (Ctrl-C to release)…"
    exec "$ROOT/scripts/dev-db.sh" seed
    ;;

  slow-queries)
    echo "→ seeding a table and running queries to populate pg_stat_statements…"
    psql_c <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT pg_stat_statements_reset();
DROP TABLE IF EXISTS events;
CREATE TABLE events (id bigserial PRIMARY KEY, user_id int, kind text, created_at timestamptz DEFAULT now());
-- 200k rows, NO index on user_id → forces a sequential scan (the slow path).
INSERT INTO events (user_id, kind)
SELECT (random()*5000)::int, (ARRAY['click','view','purchase'])[(random()*2+1)::int]
FROM generate_series(1, 200000);
ANALYZE events;
SQL
    # Run the seq-scan query as TOP-LEVEL statements (50x) so pg_stat_statements
    # records it as itself — not buried inside a DO block (default track='top'
    # ignores statements nested inside PL/pgSQL). This is the query you want to
    # see dominate the list.
    for _ in $(seq 1 50); do
      echo "SELECT count(*) FROM events WHERE user_id = (random()*5000)::int;"
    done | psql_c -q >/dev/null
    echo "✓ done. Now run 02-slow-queries.sql — the events seq-scan should top the list."
    echo "  docker exec -it ${NAME} psql -U postgres -d ${DB} -f /dev/stdin < dba-playbook/02-slow-queries.sql"
    ;;

  bloat)
    echo "→ creating a table, churning it to make dead tuples, holding an idle txn open…"
    # First: create + churn to generate dead tuples (autovacuum disabled so they stay).
    psql_c <<'SQL'
DROP TABLE IF EXISTS churn;
CREATE TABLE churn (id int PRIMARY KEY, n int) WITH (autovacuum_enabled = false);
INSERT INTO churn SELECT g, 0 FROM generate_series(1, 50000) g;
-- Update every row 5x: 250k dead tuples, none reclaimed (autovacuum off).
DO $$ BEGIN
  FOR i IN 1..5 LOOP UPDATE churn SET n = n + 1; END LOOP;
END $$;
SQL
    echo "✓ dead tuples created on table 'churn'."
    echo "→ now opening an 'idle in transaction' session (query 3 in file 03 will see it)."
    echo "  Ctrl-C to release."
    # Open a txn, run one statement, then SIT with no running query — that is the
    # 'idle in transaction' state (NOT pg_sleep, which would show as 'active').
    # The trailing `sleep` holds the pipe open so psql waits at its prompt; on
    # Ctrl-C the pipe closes, psql exits, and the transaction rolls back.
    {
      printf "BEGIN;\nUPDATE churn SET n = n WHERE id = 1;\n"
      printf "\\echo 'idle in transaction — pinning the vacuum horizon. Ctrl-C to release.'\n"
      sleep 3600
    } | docker exec -i "$NAME" psql -U postgres -d "$DB"
    ;;

  *)
    echo "usage: $0 {lock-chain|slow-queries|bloat}" >&2
    exit 1
    ;;
esac
