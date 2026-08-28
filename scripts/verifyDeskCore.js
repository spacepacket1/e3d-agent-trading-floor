import assert from "assert/strict";
import {
  SETTINGS_DEFAULTS,
  computePositionScoreLike,
  deriveLiquidityQuality,
  deriveFraudRisk,
  estimateAtrPct,
  computeStopDistancePct,
  hydrateCandidateTradingMetrics
} from "../pipeline.js";
import { buildBookRegimeFromTrends } from "../marketData.js";
import { SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT } from "./evidencePackets.js";

assert.equal(SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT, 0);
assert.equal(SETTINGS_DEFAULTS.risk_r_pct, 0.02);
assert.equal(SETTINGS_DEFAULTS.trend_sleeve_enabled, true);
assert.equal(SETTINGS_DEFAULTS.max_thesis_positions, 6);

assert.equal(deriveLiquidityQuality({ liquidity_data: { liquidity_usd: 80000 } }), 0);
assert.equal(deriveLiquidityQuality({ liquidity_data: { liquidity_usd: 200000 } }), 40);
assert.equal(deriveLiquidityQuality({ liquidity_data: { liquidity_usd: 2000000 } }), 100);
assert.equal(deriveFraudRisk({ token_risk_scan: { decision: "block" } }), 80);
assert.equal(deriveFraudRisk({ token_risk_scan: { decision: "warn" } }), 25);

const cheapIlliquid = {
  conviction_score: 90,
  opportunity_score: 90,
  market_data: { change_24h_pct: 40 },
  liquidity_data: { liquidity_usd: 80000 },
  execution_data: { estimated_slippage_bps: 20 }
};
const liquidThesis = {
  conviction_score: 70,
  setup_type: "e3d_candidate",
  liquidity_data: { liquidity_usd: 2000000 },
  execution_data: { estimated_slippage_bps: 20 },
  market_data: { change_24h_pct: 40 }
};
assert.ok(
  computePositionScoreLike(liquidThesis) > computePositionScoreLike(cheapIlliquid),
  "liquid E3D candidate should outrank a 24h-pumped illiquid name"
);

const atr = estimateAtrPct({
  market_data: { change_24h_pct: 6 },
  _dex_flow: { price_change_6h_pct: 2, price_change_1h_pct: 0.5 }
});
assert.ok(atr >= 8);
const stopPct = computeStopDistancePct({
  market_data: { change_24h_pct: 6 },
  _dex_flow: { price_change_6h_pct: 2 }
});
assert.ok(stopPct >= SETTINGS_DEFAULTS.min_stop_distance_pct);
assert.ok(stopPct <= SETTINGS_DEFAULTS.max_stop_distance_pct);

const hydrated = hydrateCandidateTradingMetrics({
  token: { symbol: "TEST", contract_address: "0x" + "1".repeat(40) },
  conviction_score: 70,
  setup_type: "thesis",
  market_data: { current_price: 10, change_24h_pct: 3 },
  liquidity_data: { liquidity_usd: 800000 },
  execution_data: { estimated_slippage_bps: 30 }
}, { settings: SETTINGS_DEFAULTS });
assert.equal(hydrated.liquidity_quality, 80);
assert.ok(hydrated._stop_distance_pct >= 0.15);
assert.ok(hydrated.invalidation_price < 10);

assert.equal(buildBookRegimeFromTrends({ signal: "long", return_20d_pct: 8 }), "risk_on");
assert.equal(buildBookRegimeFromTrends({ signal: "flat", return_20d_pct: -9 }), "risk_off");
assert.equal(buildBookRegimeFromTrends({ signal: "flat", return_20d_pct: 1 }), "neutral");

console.log("verifyDeskCore: ok");
