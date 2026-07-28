#!/usr/bin/env bash
# Pipes a dummy/*.sql file into the compose `postgres` service via psql, so no
# local psql install is required. Works with either Docker or Podman.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$1"
shift

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v podman >/dev/null 2>&1; then
  COMPOSE=(podman compose)
else
  COMPOSE=(docker-compose)
fi

"${COMPOSE[@]}" exec -T postgres psql -U mailblast -d mailblast "$@" < "$SCRIPT_DIR/$SQL_FILE"
