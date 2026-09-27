#!/bin/sh
# Runs typecheck, build and the vitest suite in node:24-alpine against a
# throwaway postgres:16-alpine on a private Docker network; both are removed
# afterwards. Never touches a real database or Discord.
#   usage: scripts/test-docker.sh            (from the repo root)
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ID=$$
NET=et-test-net-$ID
PG=et-test-pg-$ID
cleanup() { docker rm -f "$PG" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tickets_test postgres:16-alpine >/dev/null
i=0
until docker exec "$PG" pg_isready -U postgres -d tickets_test >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "postgres did not start" >&2; exit 1; }; sleep 1
done

docker run --rm --network "$NET" \
  -v "$ROOT":/app -v efm-tickets-pnpm-store:/pnpm-store -w /app \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e TEST_DATABASE_URL="postgres://postgres:test@$PG:5432/tickets_test" \
  node:24-alpine sh -c '
    corepack enable pnpm >/dev/null &&
    pnpm config set store-dir /pnpm-store >/dev/null &&
    pnpm install --frozen-lockfile &&
    node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit &&
    pnpm build &&
    pnpm test
  '
