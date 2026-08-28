import assert from "assert/strict";
import {
  SETTINGS_DEFAULTS,
  resolveScoutEvidenceRefMinimum,
  resolveScoutMaxCandidates
} from "../pipeline.js";

function buildEntry(overrides = {}) {
  return {
    packet_summary: {
      flow_only: false,
      evidence_ids: ["evi-1", "evi-2", "evi-3"],
      ...(overrides.packet_summary || {})
    },
    scout_input: {
      flow: {
        flow_signal: null,
        ...(overrides.scout_input?.flow || {})
      },
      liquidity_data: {
        liquidity_usd: null,
        ...(overrides.scout_input?.liquidity_data || {})
      },
      market_data: {
        market_cap_usd: null,
        ...(overrides.scout_input?.market_data || {})
      },
      ...(overrides.scout_input || {})
    }
  };
}

assert.equal(SETTINGS_DEFAULTS.scout_max_candidates, 1);
assert.equal(resolveScoutMaxCandidates(SETTINGS_DEFAULTS), 1);
assert.equal(resolveScoutMaxCandidates({ scout_max_candidates: 8 }), 8);
assert.equal(resolveScoutMaxCandidates({ scout_max_candidates: 0 }), 1);

const syntheticShortlist = Array.from({ length: 8 }, (_, index) => ({ symbol: `TOK${index + 1}` }));
assert.equal(syntheticShortlist.slice(0, resolveScoutMaxCandidates(SETTINGS_DEFAULTS)).length, 1);

const highConfidenceFlowOnly = buildEntry({
  packet_summary: { flow_only: true },
  scout_input: {
    flow: { flow_signal: "strong_accumulation" },
    liquidity_data: { liquidity_usd: 500000 },
    market_data: { market_cap_usd: 5000000 }
  }
});
assert.equal(resolveScoutEvidenceRefMinimum(highConfidenceFlowOnly), 2);
assert.equal(2 >= resolveScoutEvidenceRefMinimum(highConfidenceFlowOnly), true);

const narrativeCandidate = buildEntry({
  packet_summary: { flow_only: false },
  scout_input: {
    flow: { flow_signal: "strong_accumulation" },
    liquidity_data: { liquidity_usd: 900000 },
    market_data: { market_cap_usd: 25000000 }
  }
});
assert.equal(resolveScoutEvidenceRefMinimum(narrativeCandidate), 3);
assert.equal(2 >= resolveScoutEvidenceRefMinimum(narrativeCandidate), false);

const underThresholdFlowOnly = buildEntry({
  packet_summary: { flow_only: true },
  scout_input: {
    flow: { flow_signal: "strong_accumulation" },
    liquidity_data: { liquidity_usd: 499999 },
    market_data: { market_cap_usd: 5000000 }
  }
});
assert.equal(resolveScoutEvidenceRefMinimum(underThresholdFlowOnly), 3);

console.log("verifyScoutRelaxation: ok");
