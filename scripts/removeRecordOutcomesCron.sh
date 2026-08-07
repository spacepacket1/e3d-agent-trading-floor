#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/removeRecordOutcomesCron.sh [--dry-run]

Removes the recordOutcomes.js cron entry if present.
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
      echo "removeRecordOutcomesCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${RECORD_OUTCOMES_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CRONTAB_BIN="${RECORD_OUTCOMES_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
TARGET_SCRIPT="$REPO_DIR/scripts/recordOutcomes.js"

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "removeRecordOutcomesCron: crontab is required" >&2
  exit 1
fi

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if ! printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "$TARGET_SCRIPT"; then
  echo "removeRecordOutcomesCron: not installed"
  exit 0
fi

FILTERED_CRONTAB="$(printf "%s\n" "$CURRENT_CRONTAB" | grep -vF "$TARGET_SCRIPT" || true)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "removeRecordOutcomesCron: would remove"
  exit 0
fi

printf "%s\n" "$FILTERED_CRONTAB" | "$CRONTAB_BIN" -
echo "removeRecordOutcomesCron: removed"
