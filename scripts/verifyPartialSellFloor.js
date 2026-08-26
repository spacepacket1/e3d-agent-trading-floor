import assert from "assert/strict";
import { SETTINGS_DEFAULTS, evaluateSellActions } from "../pipeline.js";

function makePosition(overrides) {
  return {
    symbol: "TESTA",
    contract_address: "0x" + "2".repeat(40),
    current_price: 10,
    quantity: 40,
    market_value_usd: 400,
    stop_price: 1,
    fraud_risk: 0,
    targets: { target_1: 10, target_2: 20, target_3: 30 },
    partials_taken: { target_1: false, target_2: false, target_3: false },
    ...overrides
  };
}

// Below the floor: 0.25 * $400 = $100 < min_partial_sell_usd ($150) -> take the whole position.
const smallLeg = {
  positions: { TESTA: makePosition({ market_value_usd: 400, quantity: 40 }) },
  settings: SETTINGS_DEFAULTS
};
const smallLegActions = evaluateSellActions(smallLeg);
assert.equal(smallLegActions.length, 1);
assert.equal(smallLegActions[0].fraction, 1.0);
assert.equal(smallLegActions[0].reason, "target_1_full_min_leg");

// Above the floor: 0.25 * $1000 = $250 >= min_partial_sell_usd -> take the normal partial.
const normalLeg = {
  positions: { TESTA: makePosition({ market_value_usd: 1000, quantity: 100 }) },
  settings: SETTINGS_DEFAULTS
};
const normalLegActions = evaluateSellActions(normalLeg);
assert.equal(normalLegActions.length, 1);
assert.equal(normalLegActions[0].fraction, SETTINGS_DEFAULTS.target_partial_pct);
assert.equal(normalLegActions[0].reason, "target_1");

// Floor disabled (0) -> always take the normal partial, even on a tiny position.
const floorDisabled = {
  positions: { TESTA: makePosition({ market_value_usd: 400, quantity: 40 }) },
  settings: { ...SETTINGS_DEFAULTS, min_partial_sell_usd: 0 }
};
const floorDisabledActions = evaluateSellActions(floorDisabled);
assert.equal(floorDisabledActions[0].fraction, SETTINGS_DEFAULTS.target_partial_pct);
assert.equal(floorDisabledActions[0].reason, "target_1");

console.log("verifyPartialSellFloor: ok");
