#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/removeTradeReviewerCron.sh [--dry-run]

Removes the tradeReviewer.js cron entry if present.
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
      echo "removeTradeReviewerCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${TRADE_REVIEWER_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CRONTAB_BIN="${TRADE_REVIEWER_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
TARGET_SCRIPT="$REPO_DIR/scripts/tradeReviewer.js"

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "removeTradeReviewerCron: crontab is required" >&2
  exit 1
fi

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if ! printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "$TARGET_SCRIPT"; then
  echo "removeTradeReviewerCron: not installed"
  exit 0
fi

FILTERED_CRONTAB="$(printf "%s\n" "$CURRENT_CRONTAB" | grep -vF "$TARGET_SCRIPT" || true)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "removeTradeReviewerCron: would remove"
  exit 0
fi

printf "%s\n" "$FILTERED_CRONTAB" | "$CRONTAB_BIN" -
echo "removeTradeReviewerCron: removed"
