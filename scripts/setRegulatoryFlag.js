// scripts/setRegulatoryFlag.js — operator CLI for the manual regulatory/political-event
// flag (see marketData.js's readRegulatoryFlag / docs/token-selection-signal-expansion-
// proposal-20260720.md §3.5). This is the ONLY intended way to set or clear the flag —
// the pipeline and its agents never write to it themselves.
//
// Usage:
//   node scripts/setRegulatoryFlag.js --stance=risk_on --reason="CLARITY Act progress" --hours=12
//   node scripts/setRegulatoryFlag.js --stance=risk_off --reason="SEC enforcement sweep"
//   node scripts/setRegulatoryFlag.js --show
//   node scripts/setRegulatoryFlag.js --clear

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename)); // repo root
const FLAG_PATH = path.join(__dirname, "state", "regulatory-flag.json");

const VALID_STANCES = new Set(["risk_on", "risk_off"]);
const DEFAULT_EXPIRY_HOURS = 24;

function parseArgs(argv) {
  const out = { show: false, clear: false, stance: null, reason: null, hours: null };
  for (const arg of argv) {
    if (arg === "--show") out.show = true;
    else if (arg === "--clear") out.clear = true;
    else if (arg.startsWith("--stance=")) out.stance = arg.slice("--stance=".length);
    else if (arg.startsWith("--reason=")) out.reason = arg.slice("--reason=".length);
    else if (arg.startsWith("--hours=")) out.hours = Number(arg.slice("--hours=".length));
  }
  return out;
}

function readCurrent() {
  try {
    return JSON.parse(fs.readFileSync(FLAG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function printCurrent(label) {
  const current = readCurrent();
  if (!current) {
    console.log(`${label}: no regulatory flag set`);
    return;
  }
  const expired = !current.expires_at || new Date(current.expires_at).getTime() <= Date.now();
  console.log(`${label}:`, JSON.stringify(current, null, 2));
  if (expired) console.log("(expired — the pipeline will treat this as no flag active)");
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.show) {
    printCurrent("Current regulatory flag");
    return;
  }

  if (args.clear) {
    fs.mkdirSync(path.dirname(FLAG_PATH), { recursive: true });
    try { fs.unlinkSync(FLAG_PATH); } catch { /* already absent */ }
    console.log("Regulatory flag cleared.");
    return;
  }

  if (!args.stance) {
    console.error(
      "Usage:\n" +
      '  node scripts/setRegulatoryFlag.js --stance=risk_on|risk_off --reason="..." [--hours=24]\n' +
      "  node scripts/setRegulatoryFlag.js --show\n" +
      "  node scripts/setRegulatoryFlag.js --clear"
    );
    process.exit(1);
  }

  if (!VALID_STANCES.has(args.stance)) {
    console.error(`Invalid --stance="${args.stance}". Must be one of: ${[...VALID_STANCES].join(", ")}`);
    process.exit(1);
  }

  const hours = Number.isFinite(args.hours) && args.hours > 0 ? args.hours : DEFAULT_EXPIRY_HOURS;
  const now = new Date();
  const flag = {
    schema_version: "1.0",
    stance: args.stance,
    reason: args.reason || null,
    set_at: now.toISOString(),
    expires_at: new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString(),
    set_by: "operator",
  };

  fs.mkdirSync(path.dirname(FLAG_PATH), { recursive: true });
  fs.writeFileSync(FLAG_PATH, JSON.stringify(flag, null, 2));
  console.log(`Regulatory flag set: ${flag.stance} for ${hours}h (expires ${flag.expires_at}).`);
  if (flag.reason) console.log(`Reason: ${flag.reason}`);
}

main();
