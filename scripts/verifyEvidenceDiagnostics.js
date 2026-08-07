import assert from "assert/strict";
import {
  buildEvidenceDiagnosticsEvent,
  buildHarvestEvidenceDiagnostics,
  buildScoutEvidenceDiagnostics
} from "./evidenceDiagnostics.js";

const scout = buildScoutEvidenceDiagnostics({
  input_candidate_count: 7,
  llm_batches: [
    { prompt_chars: 1200, prompt_tokens: 300, completion_tokens: 80, total_tokens: 380, duration_ms: 900 },
    { prompt_chars: 800, prompt_tokens: 220, completion_tokens: 70, total_tokens: 290, duration_ms: 700 }
  ],
  address_repairs_in_cycle: 2,
  candidates: [
    { evidence: ["THESIS conviction 78", "current_price 1.25 volume_24h 450000", "flow_signal accumulation"] },
    { evidence: ["watchlist support", "liquidity_usd 250000"] },
    { evidence: [] }
  ],
  stories_checked: [{ type: "THESIS" }, { type: "ACCUMULATION" }],
  coverage: {
    coverage_pct: 0.91,
    expected_types: ["THESIS", "ACCUMULATION", "FLOW"],
    self_reported_types: ["THESIS", "ACCUMULATION"],
    evidence_cited_types: ["THESIS"]
  }
});

assert.equal(scout.input_candidate_count, 7);
assert.equal(scout.llm_batch_count, 2);
assert.equal(scout.prompt_chars, 2000);
assert.equal(scout.prompt_tokens, 520);
assert.equal(scout.completion_tokens, 150);
assert.equal(scout.total_tokens, 670);
assert.equal(scout.llm_duration_ms, 1600);
assert.equal(scout.candidates_returned, 3);
assert.equal(scout.address_repairs_in_cycle, 2);
assert.equal(scout.candidates_with_full_evidence, 1);
assert.equal(scout.candidates_with_thin_evidence, 2);
assert.deepEqual(scout.evidence_count_distribution, { 0: 1, 2: 1, 3: 1 });
assert.equal(scout.evidence_source_distribution.thesis, 1);
assert.equal(scout.evidence_source_distribution.market_data, 1);
assert.equal(scout.evidence_source_distribution.flow, 1);
assert.equal(scout.story_coverage.expected_type_count, 3);

const harvest = buildHarvestEvidenceDiagnostics({
  input_candidate_count: 4,
  llm_batches: [
    { prompt_chars: 1400, prompt_tokens: 410, completion_tokens: 120, total_tokens: 530, duration_ms: 1100 }
  ],
  positions_reviewed: 4,
  position_reviews: [
    { evidence: ["position pnl -12%", "MOVER story"] },
    { evidence: ["flow_signal accumulation"] },
    { evidence: [] },
    { evidence: ["THESIS intact", "current_price 2.3"] }
  ],
  exit_candidates: [
    { evidence: ["SECURITY_RISK honeypot", "position pnl -12%"] },
    { evidence: ["flow_signal distribution"] },
    { evidence: ["TREASURY_DISTRIBUTION story", "liquidity_usd 95000"] }
  ],
  stories_checked: [{ type: "SECURITY_RISK" }, { type: "TREASURY_DISTRIBUTION" }, { type: "MOVER" }],
  coverage: {
    coverage_pct: 0.88,
    expected_types: ["SECURITY_RISK", "TREASURY_DISTRIBUTION", "MOVER"],
    self_reported_types: ["SECURITY_RISK", "MOVER"],
    evidence_cited_types: ["SECURITY_RISK", "TREASURY_DISTRIBUTION"]
  }
});

assert.equal(harvest.llm_batch_count, 1);
assert.equal(harvest.positions_reviewed, 4);
assert.equal(harvest.exit_candidates_returned, 3);
assert.equal(harvest.exit_candidates_with_full_evidence, 2);
assert.equal(harvest.exit_candidates_with_thin_evidence, 1);
assert.deepEqual(harvest.evidence_count_distribution, { 1: 1, 2: 2 });
assert.equal(harvest.evidence_source_distribution.token_risk, 1);
assert.equal(harvest.evidence_source_distribution.portfolio, 1);
assert.equal(harvest.story_coverage.coverage_pct, 0.88);

const event = buildEvidenceDiagnosticsEvent({
  cycle_id: "cycle-123",
  pipeline_run_id: "run-456",
  scout,
  harvest
});

assert.equal(event.cycle_id, "cycle-123");
assert.equal(event.scout.total_tokens, 670);
assert.equal(event.scout.address_repairs_in_cycle, 2);
assert.equal(event.harvest.exit_candidates_with_thin_evidence, 1);

// Regression: when callers re-aggregate from an already-built diagnostics object
// (no raw llm_batches), pre-computed LLM aggregates must be preserved, not zeroed.
const rebuiltScout = buildScoutEvidenceDiagnostics({
  ...scout,
  coverage: {
    coverage_pct: 0.91,
    expected_types: ["THESIS", "ACCUMULATION", "FLOW"],
    self_reported_types: ["THESIS", "ACCUMULATION"],
    evidence_cited_types: ["THESIS"]
  },
  stories_checked: [{ type: "THESIS" }, { type: "ACCUMULATION" }],
  candidates: [
    { evidence: ["THESIS conviction 78", "current_price 1.25 volume_24h 450000", "flow_signal accumulation"] },
    { evidence: ["watchlist support", "liquidity_usd 250000"] },
    { evidence: [] }
  ]
});
assert.equal(rebuiltScout.llm_batch_count, 2, "rebuilt scout must preserve llm_batch_count");
assert.equal(rebuiltScout.prompt_chars, 2000, "rebuilt scout must preserve prompt_chars");
assert.equal(rebuiltScout.total_tokens, 670, "rebuilt scout must preserve total_tokens");
assert.equal(rebuiltScout.llm_duration_ms, 1600, "rebuilt scout must preserve llm_duration_ms");

const rebuiltHarvest = buildHarvestEvidenceDiagnostics({
  ...harvest,
  coverage: {
    coverage_pct: 0.88,
    expected_types: ["SECURITY_RISK", "TREASURY_DISTRIBUTION", "MOVER"],
    self_reported_types: ["SECURITY_RISK", "MOVER"],
    evidence_cited_types: ["SECURITY_RISK", "TREASURY_DISTRIBUTION"]
  },
  stories_checked: [{ type: "SECURITY_RISK" }],
  position_reviews: [{ evidence: ["x"] }],
  exit_candidates: [{ evidence: ["x", "y"] }]
});
assert.equal(rebuiltHarvest.llm_batch_count, 1, "rebuilt harvest must preserve llm_batch_count");
assert.equal(rebuiltHarvest.total_tokens, 530, "rebuilt harvest must preserve total_tokens");

console.log(JSON.stringify({
  verified: true,
  scout_batches: scout.llm_batch_count,
  scout_candidates_with_thin_evidence: scout.candidates_with_thin_evidence,
  harvest_positions_reviewed: harvest.positions_reviewed,
  harvest_exit_candidates_with_thin_evidence: harvest.exit_candidates_with_thin_evidence,
  rebuilt_scout_batches: rebuiltScout.llm_batch_count,
  rebuilt_harvest_batches: rebuiltHarvest.llm_batch_count
}, null, 2));
