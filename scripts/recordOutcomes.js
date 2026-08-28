#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");
const RUN_LEDGER_LOG = path.join(ROOT, "logs", "run-ledger.jsonl");
const TRAINING_EVENT_LOG = path.join(ROOT, "logs", "training-events.jsonl");
const E3D_API_BASE_URL = process.env.E3D_API_BASE_URL || "https://e3d.ai/api";
const E3D_API_KEY = process.env.E3D_API_KEY || "";

const SCHEMA_VERSION = "1.0.0";
const REJECTION_VALIDATED_MISS_THRESHOLD = 9;   // +9% = missed winner (lowered from 15 pre-CLARITY Act for faster signal capture)
const REJECTION_VALIDATED_WIN_THRESHOLD  = 0;   // < 0% = avoided loss

function readLedger() {
  if (!fs.existsSync(RUN_LEDGER_LOG)) return [];
  return fs.readFileSync(RUN_LEDGER_LOG, "utf8")
    .split("\n").filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function writeLedger(entries) {
  fs.writeFileSync(RUN_LEDGER_LOG, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
}

function appendTrainingEvent(event) {
  try {
    fs.appendFileSync(TRAINING_EVENT_LOG, JSON.stringify(event) + "\n");
  } catch (err) {
    console.error("appendTrainingEvent error:", err.message);
  }
}

function fetchTokenPrice(address) {
  try {
    const url = `${E3D_API_BASE_URL}/token-info/${encodeURIComponent(address)}`;
    const curlArgs = ["-s", "--max-time", "15", url];
    if (E3D_API_KEY) curlArgs.push("-H", `Authorization: Bearer ${E3D_API_KEY}`);
    const stdout = execFileSync("curl", curlArgs, { encoding: "utf8", timeout: 20000 });
    const parsed = JSON.parse(stdout);
    return parsed?.priceUSD ?? parsed?.price_usd ?? parsed?.current_price
      ?? parsed?.market_data?.current_price?.usd ?? null;
  } catch {
    return null;
  }
}

function fetchE3dActionOutcome(actionId) {
  if (!actionId) return null;
  try {
    const url = `${E3D_API_BASE_URL}/actions/${encodeURIComponent(actionId)}/outcome`;
    const curlArgs = ["-s", "--max-time", "15", url];
    if (E3D_API_KEY) curlArgs.push("-H", `x-api-key: ${E3D_API_KEY}`);
    const stdout = execFileSync("curl", curlArgs, { encoding: "utf8", timeout: 20000 });
    const parsed = JSON.parse(stdout);
    if (parsed?.error) return null;
    return parsed;
  } catch {
    return null;
  }
}

function pctChange(from, to) {
  if (!from || from === 0 || to == null) return null;
  return Math.round(((to - from) / from) * 10000) / 100;
}

function now() { return Date.now(); }

function buildBaseEvent(eventType, entry) {
  return {
    event_id: randomUUID(),
    schema_version: SCHEMA_VERSION,
    ts: new Date().toISOString(),
    event_type: eventType,
    actor: "recordOutcomes",
    pipeline_run_id: entry.pipeline_run_id || null,
    cycle_id: entry.cycle_id || null,
    cycle_index: -1,
    market_regime: "unknown",
    candidate_id: null,
    position_id: null,
    trade_id: null,
  };
}

function emitOutcomeEnrichments(entry) {
  const candidates = (entry?.scout?.candidates || []).filter(c => c.candidate_id);
  if (!candidates.length) return 0;

  const outcomes = entry.outcomes || {};
  // Only emit if we have at least one price bucket
  if (outcomes.price_1h_pct == null && outcomes.price_4h_pct == null) return 0;

  let emitted = 0;
  for (const c of candidates) {
    const event = {
      ...buildBaseEvent("outcome_enrichment", entry),
      candidate_id: c.candidate_id,
      payload: {
        candidate_id: c.candidate_id,
        trade_id: null,
        price_1h_pct: outcomes.price_1h_pct ?? null,
        price_4h_pct: outcomes.price_4h_pct ?? null,
        price_24h_pct: outcomes.price_24h_pct ?? null,
        price_72h_pct: outcomes.price_72h_pct ?? null,
        price_7d_pct: outcomes.price_7d_pct ?? null,
        e3d_thesis_confirmed: outcomes.e3d_thesis_confirmed ?? null,
        e3d_confirmation_score: outcomes.e3d_confirmation_score ?? null,
        e3d_outcome_score: outcomes.e3d_outcome_score ?? null,
      }
    };
    appendTrainingEvent(event);
    emitted++;
  }
  return emitted;
}

function emitRejectionOutcomes(entry, nowMs) {
  const rejCandidates = (entry?.risk?.rejected_candidates || [])
    .filter(r => r.candidate_id && r.address && r.market_at_signal?.price_usd > 0);
  if (!rejCandidates.length) return 0;

  const cycleTs = new Date(entry?.cycle_ts || 0).getTime();
  const ageSec = (nowMs - cycleTs) / 1000;
  if (ageSec < 86400) return 0; // enforce 24h horizon

  let emitted = 0;
  for (const r of rejCandidates) {
    const currentPrice = fetchTokenPrice(r.address);
    if (currentPrice == null) continue;
    const priceChangePct = pctChange(r.market_at_signal.price_usd, currentPrice);
    if (priceChangePct == null) continue;

    // Determine whether the rejection was validated:
    // - price fell (< threshold) → avoided a loss → true
    // - price rose past missed-winner threshold → missed opportunity → false
    // - in between → ambiguous → null (extractor will skip)
    const rejectionValidated =
      priceChangePct < REJECTION_VALIDATED_WIN_THRESHOLD ? true
      : priceChangePct >= REJECTION_VALIDATED_MISS_THRESHOLD ? false
      : null;

    const event = {
      ...buildBaseEvent("rejection_outcome", entry),
      candidate_id: r.candidate_id,
      payload: {
        candidate_id: r.candidate_id,
        reject_reason: r.reject_reason || "",
        reason_codes: r.reason_codes || [],
        price_change_pct: priceChangePct,
        rejection_validated: rejectionValidated,
      }
    };
    appendTrainingEvent(event);
    emitted++;
  }
  return emitted;
}

async function main() {
  const entries = readLedger();
  if (!entries.length) { console.log("No ledger entries."); return; }

  const nowMs = now();
  let updatedCount = 0;

  for (const entry of entries) {
    const cycleTs = new Date(entry?.cycle_ts || 0).getTime();
    const ageSec = (nowMs - cycleTs) / 1000;
    const outcomes = { ...(entry.outcomes || {}) };
    const horizonsComplete = outcomes.price_24h_pct != null && outcomes.price_72h_pct != null && outcomes.price_7d_pct != null;

    if (entry?.outcomes?.recorded_at && horizonsComplete) {
      if (!entry.outcomes.enrichment_written) {
        const n = emitOutcomeEnrichments(entry);
        if (n > 0) {
          entry.outcomes.enrichment_written = true;
          updatedCount++;
        }
      }
      if (!entry.outcomes.rejection_outcomes_written) {
        const n = emitRejectionOutcomes(entry, nowMs);
        const expected = (entry?.risk?.rejected_candidates || [])
          .filter(r => r.candidate_id && r.address && r.market_at_signal?.price_usd > 0).length;
        if (expected > 0 && n > 0) {
          entry.outcomes.rejection_outcomes_written = true;
          updatedCount++;
        }
      }
      continue;
    }

    if (ageSec < 3600) continue; // not yet 1h old

    const tradedCandidates = (entry?.scout?.candidates || []).filter(c => c?.market_at_signal?.price_usd > 0 && c?.address);
    if (!tradedCandidates.length) {
      entry.outcomes = { ...outcomes, recorded_at: new Date().toISOString(), outcome_label: "neutral" };
      updatedCount++;
      continue;
    }

    const priceChanges = [];
    for (const c of tradedCandidates) {
      const currentPrice = fetchTokenPrice(c.address);
      if (currentPrice == null) continue;
      const pct = pctChange(c.market_at_signal.price_usd, currentPrice);
      if (pct != null) priceChanges.push(pct);
    }

    if (!priceChanges.length) continue;

    const avgChange = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
    outcomes.recorded_at = new Date().toISOString();

    if (ageSec >= 3600  && outcomes.price_1h_pct  == null) outcomes.price_1h_pct  = avgChange;
    if (ageSec >= 14400 && outcomes.price_4h_pct  == null) outcomes.price_4h_pct  = avgChange;
    if (ageSec >= 86400 && outcomes.price_24h_pct == null) outcomes.price_24h_pct = avgChange;
    if (ageSec >= 259200 && outcomes.price_72h_pct == null) outcomes.price_72h_pct = avgChange;
    if (ageSec >= 604800 && outcomes.price_7d_pct == null) outcomes.price_7d_pct  = avgChange;

    if (ageSec >= 14400 && outcomes.signal_detected_before_move == null) {
      outcomes.signal_detected_before_move = (outcomes.price_4h_pct ?? 0) > 10;
    }

    const scoredPct = outcomes.price_72h_pct ?? outcomes.price_24h_pct ?? outcomes.price_4h_pct ?? outcomes.price_1h_pct;
    if (scoredPct != null) {
      outcomes.outcome_label = scoredPct > 5 ? "win" : scoredPct < -5 ? "loss" : "neutral";
    } else {
      outcomes.outcome_label = "pending";
    }

    const actionId = entry?.scout?.candidates?.[0]?.e3d_action_id || null;
    if (actionId && !outcomes.e3d_outcome_fetched) {
      const e3dOutcome = fetchE3dActionOutcome(actionId);
      if (e3dOutcome) {
        outcomes.e3d_thesis_confirmed    = e3dOutcome.thesis_confirmed ?? null;
        outcomes.e3d_confirmation_score  = e3dOutcome.confirmation_score ?? null;
        outcomes.e3d_outcome_score       = e3dOutcome.outcome_score ?? null;
        outcomes.e3d_price_return        = e3dOutcome.price_return ?? null;
        outcomes.e3d_outcome_fetched     = true;
      }
    }

    entry.outcomes = outcomes;
    updatedCount++;

    // Emit outcome_enrichment events for approved candidates with candidate_id
    if (!outcomes.enrichment_written) {
      const n = emitOutcomeEnrichments(entry);
      if (n > 0) entry.outcomes.enrichment_written = true;
    }

    // Emit rejection_outcome events for rejected candidates
    if (!outcomes.rejection_outcomes_written) {
      const n = emitRejectionOutcomes(entry, nowMs);
      const expected = (entry?.risk?.rejected_candidates || [])
        .filter(r => r.candidate_id && r.address && r.market_at_signal?.price_usd > 0).length;
      if (expected > 0 && n > 0) entry.outcomes.rejection_outcomes_written = true;
    }
  }

  if (updatedCount > 0) {
    writeLedger(entries);
    console.log(`Updated outcomes for ${updatedCount} ledger entries.`);
  } else {
    console.log("No entries ready for outcome recording.");
  }
}

main().catch(err => { console.error("recordOutcomes error:", err.message); process.exit(1); });
