#!/usr/bin/env bash
#
# Local dev Postgres for pgops. Starts a throwaway container you can point
# the web console at. Not for production.
#
#   ./scripts/dev-db.sh up      # start (idempotent) and print DATABASE_URL
#   ./scripts/dev-db.sh down    # stop and remove
#   ./scripts/dev-db.sh url     # print the connection string
#   ./scripts/dev-db.sh psql    # open psql inside the container
#   ./scripts/dev-db.sh seed    # manufacture a lock chain for the locks route
#
# Override defaults via env: PGOPS_DEV_PORT, PGOPS_DEV_IMAGE.
set -euo pipefail

NAME="pgops-dev"
IMAGE="${PGOPS_DEV_IMAGE:-postgres:17}"
PORT="${PGOPS_DEV_PORT:-55432}"
DB="appdb"
PASSWORD="secret"
URL="postgres://postgres:${PASSWORD}@localhost:${PORT}/${DB}"

need_docker() {
  command -v docker >/dev/null 2>&1 || { echo "docker not found — install Docker Desktop." >&2; exit 1; }
}

is_running() { [ -n "$(docker ps -q -f "name=^${NAME}$" 2>/dev/null)" ]; }
exists()     { [ -n "$(docker ps -aq -f "name=^${NAME}$" 2>/dev/null)" ]; }

up() {
  need_docker
  if is_running; then
    echo "✓ ${NAME} already running"
  else
    exists && docker rm -f "$NAME" >/dev/null
    echo "starting ${NAME} (${IMAGE}) on port ${PORT}…"
    docker run -d --name "$NAME" \
      -e POSTGRES_PASSWORD="$PASSWORD" \
      -e POSTGRES_DB="$DB" \
      -p "${PORT}:5432" \
      "$IMAGE" \
      -c shared_preload_libraries=pg_stat_statements >/dev/null
    printf "waiting for readiness"
    for _ in $(seq 1 30); do
      if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then echo " ✓"; break; fi
      printf "."; sleep 1
    done
    # pg_stat_statements is needed by the queries route; create it now so the
    # dev DB is ready for every route, not just locks.
    docker exec "$NAME" psql -U postgres -d "$DB" -q \
      -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;" >/dev/null 2>&1 || true
  fi
  echo
  echo "DATABASE_URL=${URL}"
  echo
  echo "Run pgops against it:"
  echo "  export DATABASE_URL='${URL}'"
  echo "  npm run --workspace @pgops/web dev   # http://localhost:3000"
}

down() {
  need_docker
  if exists; then docker rm -f "$NAME" >/dev/null && echo "✓ ${NAME} removed"; else echo "${NAME} not present"; fi
}

case "${1:-up}" in
  up)   up ;;
  down) down ;;
  url)  echo "$URL" ;;
  psql) need_docker; docker exec -it "$NAME" psql -U postgres -d "$DB" ;;
  seed) DATABASE_URL="$URL" node "$(dirname "$0")/dev-contention.mjs" ;;
  *) echo "usage: $0 {up|down|url|psql|seed}" >&2; exit 1 ;;
esac
