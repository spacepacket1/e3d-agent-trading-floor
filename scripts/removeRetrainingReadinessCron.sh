#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/removeRetrainingReadinessCron.sh [--dry-run]

Removes the retrainingReadiness.js cron entry if present.
EOF
}

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "removeRetrainingReadinessCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${RETRAINING_READINESS_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CRONTAB_BIN="${RETRAINING_READINESS_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
TARGET_SCRIPT="$REPO_DIR/scripts/retrainingReadiness.js"

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "removeRetrainingReadinessCron: crontab is required" >&2
  exit 1
fi

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if ! printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "$TARGET_SCRIPT"; then
  echo "removeRetrainingReadinessCron: not installed"
  exit 0
fi

FILTERED_CRONTAB="$(printf "%s\n" "$CURRENT_CRONTAB" | grep -vF "$TARGET_SCRIPT" || true)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "removeRetrainingReadinessCron: would remove"
  exit 0
fi

printf "%s\n" "$FILTERED_CRONTAB" | "$CRONTAB_BIN" -
echo "removeRetrainingReadinessCron: removed"
