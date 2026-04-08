#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

log() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "Missing required command: $1"
  fi
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

log "Checking prerequisites"
require_cmd node
require_cmd npm
require_cmd docker

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  die "Docker Compose is required (docker compose or docker-compose)"
fi

log "Installing JavaScript dependencies"
npm install

log "Starting local databases"
"${COMPOSE_CMD[@]}" up -d mongo clickhouse

log "Validating pipeline syntax"
npm run check

log "Installation complete"
printf '\nNext steps:\n'
printf '  - Ensure your LLM server is running on port 5050 (or set LLM_BASE_URL)\n'
printf '  - Start the dashboard: npm run dashboard\n'
printf '  - Start the pipeline loop: npm run loop\n'
printf '  - View local DB status: npm run db:ps\n'
