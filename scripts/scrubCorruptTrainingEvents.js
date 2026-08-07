#!/usr/bin/env node
/**
 * Scrub the SATA dual-pricing corruption out of the training-critical logs, consistent with the
 * portfolio void (scripts/repairSataCorruption.js). The entire SATA position was fictional, so every
 * SATA-SPECIFIC training event (candidate/risk/sizing/executor/trade/signal_snapshot/arbitrage_signal/
 * harvest_decision/token_risk_scan whose subject is SATA) is dropped. CYCLE-LEVEL events
 * (cycle_start/cycle_end) are PRESERVED — they embed SATA inside a multi-position snapshot, so deleting
 * them would damage the other positions' training context.
 *
 * Also strips SATA trade objects from each run-ledger cycle's execution.trades array.
 *
 * Streams line-by-line (files are hundreds of MB), writes a temp file, atomically replaces. Backups
 * are taken separately before running. Idempotent. Usage: node scripts/scrubCorruptTrainingEvents.js
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SATA_ADDR = "0x3ebb4a4e91ad83be51f8d596533818b246f4bee1";
const SATA_SYM = '"SATA"';
const KEEP_EVENT_TYPES = new Set(["cycle_start", "cycle_end"]); // cycle-level, multi-position — never drop

function mentionsSata(line) {
  return line.includes(SATA_ADDR) || line.includes(SATA_SYM);
}

async function scrubTrainingEvents(file) {
  const tmp = file + ".tmp";
  const inp = fs.createReadStream(file, "utf8");
  const out = fs.createWriteStream(tmp, "utf8");
  const rl = readline.createInterface({ input: inp, crlfDelay: Infinity });
  let kept = 0, dropped = 0;
  const droppedByType = {};
  for await (const line of rl) {
    if (line.trim() === "") continue;
    if (!mentionsSata(line)) { out.write(line + "\n"); kept++; continue; }
    let o = null;
    try { o = JSON.parse(line); } catch { /* unparseable but mentions SATA — keep to be safe */ }
    const et = o?.event_type ?? "__unparsed";
    if (o && !KEEP_EVENT_TYPES.has(et)) {
      dropped++; droppedByType[et] = (droppedByType[et] || 0) + 1;
    } else {
      out.write(line + "\n"); kept++;     // cycle-level or unparseable -> keep
    }
  }
  await new Promise((res) => out.end(res));
  fs.renameSync(tmp, file);
  console.log(`\n[training-events] ${path.basename(file)}: kept ${kept}, dropped ${dropped}`);
  console.log("  dropped by event_type:", JSON.stringify(droppedByType));
}

async function scrubRunLedger(file) {
  const tmp = file + ".tmp";
  const inp = fs.createReadStream(file, "utf8");
  const out = fs.createWriteStream(tmp, "utf8");
  const rl = readline.createInterface({ input: inp, crlfDelay: Infinity });
  let lines = 0, tradesRemoved = 0, linesTouched = 0;
  for await (const line of rl) {
    if (line.trim() === "") continue;
    lines++;
    if (!mentionsSata(line)) { out.write(line + "\n"); continue; }
    let o;
    try { o = JSON.parse(line); } catch { out.write(line + "\n"); continue; }
    const trades = o?.execution?.trades;
    if (Array.isArray(trades)) {
      const before = trades.length;
      o.execution.trades = trades.filter((t) => (t?.symbol !== "SATA") && (t?.address || "").toLowerCase() !== SATA_ADDR);
      const removed = before - o.execution.trades.length;
      if (removed > 0) { tradesRemoved += removed; linesTouched++; }
    }
    out.write(JSON.stringify(o) + "\n");
  }
  await new Promise((res) => out.end(res));
  fs.renameSync(tmp, file);
  console.log(`\n[run-ledger] ${path.basename(file)}: ${lines} lines, removed ${tradesRemoved} SATA trade objects across ${linesTouched} cycle(s)`);
}

const trainingFile = path.join(ROOT, "logs", "training-events.jsonl");
const ledgerFile = path.join(ROOT, "logs", "run-ledger.jsonl");

await scrubTrainingEvents(trainingFile);
await scrubRunLedger(ledgerFile);
console.log("\nDone.");
