#!/usr/bin/env bash
# Spec §9, "Runtime env": build an image with one DATABASE_URL, run it with
# another, assert it uses the second.
#
# The whole configuration model is `docker run -e PGOPS_DATABASES=... pgops`
# against an image built months earlier. A statically prerendered route
# evaluates process.env in the BUILD process and freezes the result into HTML —
# Turbopack does not textually inline server-side env, so nothing about the
# built output looks wrong; the page is simply already rendered.
#
# The proof this script gives is that the `/` ROUTE stays dynamic, not that
# any one file does. This app has four `connection()` gates and they guard
# different routes — an earlier version of this comment said all four protect
# `/`, which over-corrected from one wrong claim into another. Which gate
# guards which route:
#   - app/page.tsx                     `/` — calls databaseNames() before any
#                                      check runs, so it is the gate that has
#                                      to be there ahead of the first env read
#   - apps/web/lib/check.ts            `/` and every other check-rendering
#                                      page, via runCheckFor
#   - app/db/[name]/layout.tsx         /db/* — resolves the database name from
#                                      configuration
#   - app/api/db/[name]/kill/route.ts  no route: a POST-only route handler is
#                                      never a prerender candidate (that file's
#                                      docblock cites Next's own
#                                      hasNonStaticMethods). Its call is
#                                      defence for a future GET on that path.
# All four stay. Two of them cover the route under test here, and deleting
# only one of those does NOT redden this script — task 6's own investigation
# deleted lib/check.ts's line alone and the script still printed OK, because
# app/page.tsx's own gate was still standing. Reddening this script requires
# removing every gate on the route under test, not one file.
# See task-6-report.md's "Attempt 3" for the run that did that and the red it
# produced (the page froze to `default`, the name a lone build-time
# DATABASE_URL produces).
set -euo pipefail

IMAGE=pgops:smoke
PG=pgops-smoke-pg
APP=pgops-smoke-app
NET=pgops-smoke
cleanup() {
  docker rm -f "$PG" "$APP" >/dev/null 2>&1 || true
  # Removing the network too — not just the containers — is what makes a
  # second consecutive run of this script work. `docker network create`
  # already tolerates "already exists" (below), but a network left behind by
  # a run that failed mid-way is exactly the state a re-run should not have
  # to reason about.
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

# Built pointing at a host that does not resolve. If any part of the build
# freezes this in, the running container cannot possibly work.
docker build \
  --build-arg DATABASE_URL=postgres://build:build@build-machine.invalid:5432/frozen \
  -t "$IMAGE" .

docker network create "$NET" >/dev/null 2>&1 || true
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=smoke postgres:17-alpine >/dev/null

# Wait for it, rather than sleeping and hoping. Exhausting the loop falls
# through silently otherwise — this checks explicitly and fails loudly with
# the container's own logs, the same as every other failure path below.
pg_ready=0
for _ in $(seq 1 60); do
  if docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; then pg_ready=1; break; fi
  sleep 1
done
if [ "$pg_ready" != "1" ]; then
  echo "FAIL: postgres never became ready within 60s." >&2
  docker logs "$PG" >&2
  exit 1
fi

# The distinguishing evidence: a database NAME that a build-time freeze could
# not have known. A frozen DATABASE_URL would have produced the name "default".
docker run -d --name "$APP" --network "$NET" -p 8080:8080 \
  -e PGOPS_DATABASES='[{"name":"runtime-wins","url":"postgres://postgres:smoke@'"$PG"':5432/postgres"}]' \
  "$IMAGE" >/dev/null

# Same shape as the postgres wait above: a `for` loop with `&&` inside its
# body sits outside `set -e`'s reach, so 60 failed iterations would otherwise
# fall through into the plain `curl` below with no diagnostic at all — the
# single most likely CI failure (the app crashing on startup) would then exit
# with no FAIL message and no logs. Check explicitly instead.
app_ready=0
for _ in $(seq 1 60); do
  if curl -fsS localhost:8080 >/dev/null 2>&1; then app_ready=1; break; fi
  sleep 1
done
if [ "$app_ready" != "1" ]; then
  echo "FAIL: the console never became reachable within 60s." >&2
  docker logs "$APP" >&2
  exit 1
fi

body=$(curl -fsS localhost:8080)
docker logs "$APP" | tail -20

if ! grep -q 'runtime-wins' <<<"$body"; then
  echo "FAIL: the page does not name the database this container was RUN with." >&2
  echo "$body" | head -40 >&2
  exit 1
fi
# Backstop, not part of the discriminating evidence above (that's
# 'runtime-wins'). This has never been observed to fire: task 6's mutation
# testing found a frozen build surfaces as the database NAME ('default') in
# an <a href="/db/default">, never the raw connection string — and
# NODE_ENV=production suppresses detailed framework error output besides. The
# class it guards against is still real in this codebase (§7.3,
# redactSecrets exists for exactly "a connection string reaching rendered
# HTML"), and one grep is cheap, so it stays as a backstop. It would start to
# matter if some future error path rendered a raw DATABASE_URL verbatim
# instead of the resolved database name.
if grep -q 'build-machine.invalid' <<<"$body"; then
  echo "FAIL: the build-time DATABASE_URL reached the rendered page." >&2
  exit 1
fi

# Non-root, spec §8.
uid=$(docker exec "$APP" id -u)
if [ "$uid" = "0" ]; then
  echo "FAIL: the container runs as root." >&2
  exit 1
fi

echo "OK: runtime configuration wins, and the container runs as uid $uid."
