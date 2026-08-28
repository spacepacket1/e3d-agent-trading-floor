#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/removeE3dActionOutcomeExportCron.sh [--dry-run]

Removes the E3D action/outcome exporter cron entry if present.
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
      echo "removeE3dActionOutcomeExportCron: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="${E3D_EXPORT_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CRONTAB_BIN="${E3D_EXPORT_CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
EXPORT_SCRIPT="$REPO_DIR/scripts/e3dActionOutcomeExport.js"

if [[ -z "$CRONTAB_BIN" ]]; then
  echo "removeE3dActionOutcomeExportCron: crontab is required" >&2
  exit 1
fi

CURRENT_CRONTAB="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
if ! printf "%s\n" "$CURRENT_CRONTAB" | grep -qF "$EXPORT_SCRIPT"; then
  echo "removeE3dActionOutcomeExportCron: not installed"
  exit 0
fi

FILTERED_CRONTAB="$(printf "%s\n" "$CURRENT_CRONTAB" | grep -vF "$EXPORT_SCRIPT" || true)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "removeE3dActionOutcomeExportCron: would remove"
  exit 0
fi

printf "%s\n" "$FILTERED_CRONTAB" | "$CRONTAB_BIN" -
echo "removeE3dActionOutcomeExportCron: removed"
