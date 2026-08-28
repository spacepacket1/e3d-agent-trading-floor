#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/installE3dActionOutcomeExportCron.sh [--dry-run] [--print] [--confirm-manual-validation]

Installs the E3D action/outcome exporter cron entry to run every 5 minutes.
The real install requires --confirm-manual-validation so cron is only enabled
after the Phase 6 manual validation steps have passed.
EOF
}

DRY_RUN=0
PRINT_ONLY=0
CONFIRMED=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --print) PRINT_ONLY=1 ;;
    --confirm-manual-validation) CONFIRMED=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "installE3dActionOutcomeExportCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${E3D_EXPORT_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${E3D_EXPORT_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
CRONTAB_BIN="${E3D_EXPORT_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
EXPORT_SCRIPT="$REPO_DIR/scripts/e3dActionOutcomeExport.js"
CRON_LOG="${E3D_EXPORT_CRON_LOG:-$REPO_DIR/logs/e3d-action-outcome-export.log}"
CRON_SCHEDULE="${E3D_EXPORT_CRON_SCHEDULE:-*/5 * * * *}"
CRON_LINE="$CRON_SCHEDULE cd $REPO_DIR && $NODE_BIN $EXPORT_SCRIPT >> $CRON_LOG 2>&1"

if [[ -z "$NODE_BIN" ]]; then
  echo "installE3dActionOutcomeExportCron: node is required" >&2
  exit 1
fi

if [[ ! -f "$EXPORT_SCRIPT" ]]; then
  echo "installE3dActionOutcomeExportCron: exporter script not found at $EXPORT_SCRIPT" >&2
  exit 1
fi

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  printf "%s\n" "$CRON_LINE"
  exit 0
fi

if [[ "$DRY_RUN" -eq 0 && "$CONFIRMED" -ne 1 ]]; then
  echo "installE3dActionOutcomeExportCron: pass --confirm-manual-validation before installing cron" >&2
  exit 1
fi

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "installE3dActionOutcomeExportCron: crontab is required" >&2
  exit 1
fi

mkdir -p "$(dirname "$CRON_LOG")"

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "$EXPORT_SCRIPT"; then
  echo "installE3dActionOutcomeExportCron: already installed"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "installE3dActionOutcomeExportCron: would install"
  printf "%s\n" "$CRON_LINE"
  exit 0
fi

{
  printf "%s\n" "$CURRENT_CRONTAB"
  printf "%s\n" "$CRON_LINE"
} | "$CRONTAB_BIN" -

echo "installE3dActionOutcomeExportCron: installed"
printf "%s\n" "$CRON_LINE"
