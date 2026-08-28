import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyMandateScoutBias,
  currentMandateStatus,
  getActiveCapitalMandate,
  submitCapitalMandate,
  validateCapitalMandatePayload,
  validateMandateConstraintsAgainstPolicy
} from "./capitalMandates.js";
import { evaluateRiskDecision } from "./riskEngine.js";

const riskPolicy = {
  max_position_size_pct: 0.12,
  max_token_exposure_pct: 0.12,
  max_category_exposure_pct: 0.70,
  max_strategy_exposure_pct: 0.75,
  max_open_positions: 6,
  max_daily_turnover_usd: 250000,
  min_liquidity_usd: 100000,
  max_spread_bps: 150,
  max_slippage_bps: 150
};

function mandate(overrides = {}) {
  return {
    mandate_id: "mandate-fixture-1",
    version: "1.0",
    owner: "futco",
    status: "active",
    created_at: "2026-08-27T12:00:00.000Z",
    approved_at: "2026-08-27T12:01:00.000Z",
    effective_at: "2026-08-27T12:02:00.000Z",
    expires_at: "2026-09-27T12:02:00.000Z",
    correlation_id: "corr-fixture-1",
    proposal_id: "proposal-fixture-1",
    decision_id: "decision-fixture-1",
    thesis_refs: ["thesis-fixture"],
    story_refs: ["story-fixture"],
    objective: "Bias toward liquid AI infrastructure tokens while preserving Risk limits.",
    constraints: {
      max_position_size_pct: 0.08,
      max_token_exposure_pct: 0.08,
      max_open_positions: 4,
      min_liquidity_usd: 250000,
      allowed_categories: ["ai"],
      max_trade_notional_usd: 6000
    },
    preferences: {
      preferred_categories: ["ai"]
    },
    horizon: "30d",
    confidence: 0.7,
    invalidation: "Thesis invalidates on liquidity collapse.",
    ...overrides
  };
}

function portfolioFixture() {
  return {
    cash_usd: 95000,
    positions: {
      ETH: {
        symbol: "ETH",
        contract_address: "0xeth",
        category: "layer1",
        strategy_version: "paper-pipeline-v1",
        market_value_usd: 5000
      }
    },
    action_history: [],
    closed_trades: [],
    settings: {
      paper_mode: true,
      max_position_pct: 0.12,
      category_cap_pct: 0.70,
      max_open_positions: 6,
      risk_engine: {
        max_token_exposure_pct: 0.12,
        max_strategy_exposure_pct: 0.75,
        max_daily_turnover_usd: 250000,
        min_liquidity_usd: 100000,
        max_spread_bps: 150,
        max_slippage_bps: 150
      }
    },
    stats: {
      market_regime: "neutral"
    }
  };
}

function riskInput(capitalMandate = null, overrides = {}) {
  return {
    mode: "paper",
    enforcement_mode: "enforced",
    evaluated_at: "2026-08-27T13:00:00.000Z",
    portfolio: portfolioFixture(),
    capital_mandate: capitalMandate,
    analytics: {
      evaluated_at: "2026-08-27T13:00:00.000Z",
      market_regime: "neutral",
      day_start_equity_usd: 100000,
      review_stats: { setup_expectancy: [] }
    },
    intent: {
      side: "buy",
      symbol: "AI",
      contract_address: "0xai",
      category: "ai",
      strategy_version: "paper-pipeline-v1",
      setup_type: "breakout",
      requested_notional_usd: 7000,
      requested_quantity: 100,
      liquidity_usd: 500000,
      spread_bps: 20,
      slippage_bps: 30,
      ...overrides.intent
    },
    ...overrides
  };
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "e3d-capital-mandates-"));
const stateFile = path.join(tempDir, "capital-mandates.json");

const active = mandate();
const firstAck = submitCapitalMandate(active, { stateFile, riskPolicy, now: "2026-08-27T13:00:00.000Z" });
assert.equal(firstAck.accepted, true);
assert.equal(firstAck.idempotent, false);
assert.equal(firstAck.status, "active");
assert.equal(getActiveCapitalMandate({ stateFile, now: "2026-08-27T13:00:00.000Z" })?.mandate_id, active.mandate_id);

const secondAck = submitCapitalMandate(active, { stateFile, riskPolicy, now: "2026-08-27T13:00:00.000Z" });
assert.equal(secondAck.idempotent, true, "same mandate payload should be idempotent");
assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).mandates.length, 1, "idempotent submission must not duplicate state");

assert.throws(
  () => submitCapitalMandate(mandate({ objective: "different objective" }), { stateFile, riskPolicy }),
  /CAPITAL_MANDATE_CONFLICT/,
  "same mandate_id with different payload should conflict"
);

const malformed = validateCapitalMandatePayload({ mandate_id: "bad" }, { riskPolicy });
assert.equal(malformed.valid, false, "malformed mandate should be rejected");

const relaxing = validateMandateConstraintsAgainstPolicy({ max_position_size_pct: 0.50, min_liquidity_usd: 1000 }, riskPolicy);
assert.equal(relaxing.valid, false, "loosening constraints must be rejected");
assert.ok(relaxing.errors.some((error) => error.includes("relax")), "loosening errors should be explicit");

assert.equal(currentMandateStatus(mandate({ status: "proposed" }), "2026-08-27T13:00:00.000Z"), "proposed");
assert.equal(currentMandateStatus(mandate({ status: "suspended" }), "2026-08-27T13:00:00.000Z"), "suspended");
assert.equal(currentMandateStatus(mandate({ expires_at: "2026-08-27T12:30:00.000Z" }), "2026-08-27T13:00:00.000Z"), "expired");

const noMandateDecision = evaluateRiskDecision(riskInput(null));
const proposedDecision = evaluateRiskDecision(riskInput(mandate({ status: "proposed" })));
assert.deepEqual(proposedDecision, noMandateDecision, "proposed mandate must not affect Risk behavior");

const mandateBlocked = evaluateRiskDecision(riskInput(active));
assert.equal(mandateBlocked.decision, "block", "active mandate max trade notional should constrain Risk");
assert.ok(mandateBlocked.blockers.includes("mandate_max_trade_notional"));
assert.equal(mandateBlocked.capital_mandate.mandate_id, active.mandate_id);
assert.equal(mandateBlocked.capital_mandate.correlation_id, active.correlation_id);

const universeBlocked = evaluateRiskDecision(riskInput(active, { intent: { symbol: "SOL", contract_address: "0xsol", category: "layer1", requested_notional_usd: 1000 } }));
assert.equal(universeBlocked.decision, "block", "active mandate allowed universe should constrain Risk");
assert.ok(universeBlocked.blockers.includes("mandate_allowed_universe"));

const biased = applyMandateScoutBias([
  { token: { symbol: "AI", category: "ai" }, opportunity_score: 50 },
  { token: { symbol: "SOL", category: "layer1" }, opportunity_score: 50 }
], active);
assert.equal(biased[0].opportunity_score, 55, "matching candidate should receive controlled Scout bias");
assert.equal(biased[0].mandate_trace.mandate_id, active.mandate_id);
assert.equal(biased[1].mandate_trace, undefined, "non-matching candidate should be unchanged");

const inactiveBias = applyMandateScoutBias([{ token: { symbol: "AI", category: "ai" }, opportunity_score: 50 }], mandate({ status: "revoked" }));
assert.deepEqual(inactiveBias, [{ token: { symbol: "AI", category: "ai" }, opportunity_score: 50 }], "inactive mandate must not bias Scout");

console.log("verifyCapitalMandates: ok");
