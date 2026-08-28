import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e3d-export-cron-"));
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fakeCrontabFile = path.join(fixtureRoot, "crontab.txt");
const fakeCrontabBin = path.join(fixtureRoot, "crontab");
const nodeBin = process.execPath;
const installScript = path.join(repoRoot, "scripts", "installE3dActionOutcomeExportCron.sh");
const removeScript = path.join(repoRoot, "scripts", "removeE3dActionOutcomeExportCron.sh");
const exportScript = path.join(repoRoot, "scripts", "e3dActionOutcomeExport.js");
const cronLog = path.join(repoRoot, "logs", "e3d-action-outcome-export.log");

fs.writeFileSync(fakeCrontabFile, "0 3 * * 0 /tmp/weekly-job.sh >> /tmp/weekly-job.log 2>&1\n", "utf8");
fs.writeFileSync(fakeCrontabBin, `#!/usr/bin/env bash
set -euo pipefail
STORE_FILE="${fakeCrontabFile}"
if [[ "$#" -eq 1 && "$1" == "-l" ]]; then
  if [[ -f "$STORE_FILE" ]]; then
    cat "$STORE_FILE"
    exit 0
  fi
  exit 1
fi
if [[ "$#" -eq 1 && "$1" == "-" ]]; then
  cat > "$STORE_FILE"
  exit 0
fi
echo "unsupported fake crontab args: $*" >&2
exit 1
`, { mode: 0o755 });

function runScript(scriptPath, args = []) {
  return execFileSync("bash", [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      E3D_EXPORT_REPO_DIR: repoRoot,
      E3D_EXPORT_NODE_BIN: nodeBin,
      E3D_EXPORT_CRONTAB_BIN: fakeCrontabBin,
      E3D_EXPORT_CRON_LOG: cronLog
    }
  }).trim();
}

const expectedCronLine = `*/5 * * * * cd ${repoRoot} && ${nodeBin} ${exportScript} >> ${cronLog} 2>&1`;

assert.equal(runScript(installScript, ["--print"]), expectedCronLine);

const dryRunOutput = runScript(installScript, ["--dry-run"]);
assert(dryRunOutput.includes("would install"));
assert(dryRunOutput.includes(expectedCronLine));

assert.throws(
  () => runScript(installScript),
  /pass --confirm-manual-validation/
);

const installOutput = runScript(installScript, ["--confirm-manual-validation"]);
assert(installOutput.includes("installed"));
assert(installOutput.includes(expectedCronLine));

const installedCrontab = fs.readFileSync(fakeCrontabFile, "utf8");
assert(installedCrontab.includes("/tmp/weekly-job.sh"));
assert(installedCrontab.includes(expectedCronLine));

const secondInstallOutput = runScript(installScript, ["--confirm-manual-validation"]);
assert.equal(secondInstallOutput, "installE3dActionOutcomeExportCron: already installed");

const removeDryRun = runScript(removeScript, ["--dry-run"]);
assert.equal(removeDryRun, "removeE3dActionOutcomeExportCron: would remove");
assert(fs.readFileSync(fakeCrontabFile, "utf8").includes(expectedCronLine));

const removeOutput = runScript(removeScript);
assert.equal(removeOutput, "removeE3dActionOutcomeExportCron: removed");

const removedCrontab = fs.readFileSync(fakeCrontabFile, "utf8");
assert(removedCrontab.includes("/tmp/weekly-job.sh"));
assert(!removedCrontab.includes(expectedCronLine));

const secondRemoveOutput = runScript(removeScript);
assert.equal(secondRemoveOutput, "removeE3dActionOutcomeExportCron: not installed");

console.log("verifyE3dActionOutcomeExportCron: ok");
