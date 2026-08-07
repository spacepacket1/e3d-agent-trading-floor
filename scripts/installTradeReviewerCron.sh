#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/installTradeReviewerCron.sh [--dry-run] [--print]

Installs a cron entry to run scripts/tradeReviewer.js daily at 6am, before
the 6:30am performanceDaily.js run. Writes logs/trade-reviews.jsonl, the
input scripts/retrainingReadiness.js needs to compute a non-stale gate.
EOF
}

DRY_RUN=0
PRINT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --print) PRINT_ONLY=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "installTradeReviewerCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${TRADE_REVIEWER_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${TRADE_REVIEWER_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
CRONTAB_BIN="${TRADE_REVIEWER_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
TARGET_SCRIPT="$REPO_DIR/scripts/tradeReviewer.js"
CRON_LOG="${TRADE_REVIEWER_CRON_LOG:-$REPO_DIR/logs/trade-reviewer.log}"
CRON_SCHEDULE="${TRADE_REVIEWER_CRON_SCHEDULE:-0 6 * * *}"
CRON_LINE="$CRON_SCHEDULE cd $REPO_DIR && $NODE_BIN $TARGET_SCRIPT >> $CRON_LOG 2>&1"

if [[ -z "$NODE_BIN" ]]; then
  echo "installTradeReviewerCron: node is required" >&2
  exit 1
fi

if [[ ! -f "$TARGET_SCRIPT" ]]; then
  echo "installTradeReviewerCron: target script not found at $TARGET_SCRIPT" >&2
  exit 1
fi

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  printf "%s\n" "$CRON_LINE"
  exit 0
fi

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "installTradeReviewerCron: crontab is required" >&2
  exit 1
fi

mkdir -p "$(dirname "$CRON_LOG")"

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "$TARGET_SCRIPT"; then
  echo "installTradeReviewerCron: already installed"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "installTradeReviewerCron: would install"
  printf "%s\n" "$CRON_LINE"
  exit 0
fi

{
  printf "%s\n" "$CURRENT_CRONTAB"
  printf "%s\n" "$CRON_LINE"
} | "$CRONTAB_BIN" -

echo "installTradeReviewerCron: installed"
printf "%s\n" "$CRON_LINE"
