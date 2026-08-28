import assert from "assert/strict";
import {
  SETTINGS_DEFAULTS,
  buildRegimeSentinelPolicy,
  computeRecentClosedTradeMetrics,
  computeRecentPerformanceThrottleMultiplier
} from "../pipeline.js";

function buildPortfolio(overrides = {}) {
  const settings = {
    ...SETTINGS_DEFAULTS,
    ...overrides.settings
  };
  return {
    cash_usd: overrides.cash_usd ?? 50000,
    positions: overrides.positions ?? {},
    closed_trades: overrides.closed_trades ?? [],
    stats: {
      market_regime: "neutral",
      ...(overrides.stats || {})
    },
    settings
  };
}

function sellTrade(hoursAgo, pnlUsd, reason = "target_hit", holdHours = 48) {
  const closedAt = Date.now() - (hoursAgo * 60 * 60 * 1000);
  return {
    side: "sell",
    pnl_usd: pnlUsd,
    reason,
    ts: new Date(closedAt).toISOString(),
    opened_at: new Date(closedAt - (holdHours * 60 * 60 * 1000)).toISOString()
  };
}

const lowSamplePolicy = buildRegimeSentinelPolicy(buildPortfolio({
  closed_trades: [
    sellTrade(1, -40, "thesis_decay"),
    sellTrade(2, -35, "rotation_out"),
    sellTrade(3, -30, "time_stop"),
    sellTrade(4, -25),
    sellTrade(5, 5)
  ]
}), { macro: { regime: "neutral" } });

assert(lowSamplePolicy.reason_codes.includes("throttle_skipped_low_sample"));
assert(!lowSamplePolicy.reason_codes.includes("negative_recent_profit_factor"));

const immaterialLossPolicy = buildRegimeSentinelPolicy(buildPortfolio({
  cash_usd: 100000,
  closed_trades: [
    sellTrade(1, 6),
    sellTrade(2, 6),
    sellTrade(3, 6),
    sellTrade(4, 6),
    sellTrade(5, 6),
    sellTrade(6, -10),
    sellTrade(7, -10),
    sellTrade(8, -10),
    sellTrade(9, -10),
    sellTrade(10, -10)
  ]
}), { macro: { regime: "neutral" } });

assert(immaterialLossPolicy.reason_codes.includes("throttle_skipped_immaterial_loss"));
assert(!immaterialLossPolicy.reason_codes.includes("negative_recent_profit_factor"));

const actualSamplePolicy = buildRegimeSentinelPolicy(buildPortfolio({
  cash_usd: 50000,
  settings: {
    max_buys_per_cycle: 3
  },
  closed_trades: [
    ...Array.from({ length: 60 }, (_, index) => sellTrade((index % 23) + 1, -4, "thesis_decay")),
    sellTrade(2, -7, "rotation_out"),
    sellTrade(3, -7, "target_hit"),
    sellTrade(4, -0.12, "time_stop")
  ]
}), { macro: { regime: "neutral" } });

assert(actualSamplePolicy.reason_codes.includes("negative_recent_profit_factor"));
assert.equal(actualSamplePolicy.allocation_multiplier, 0.3);
assert.equal(actualSamplePolicy.max_buys_per_cycle, 2);

assert.equal(computeRecentPerformanceThrottleMultiplier(0.8), 1);
assert.equal(computeRecentPerformanceThrottleMultiplier(0.55), 0.7);
assert.equal(computeRecentPerformanceThrottleMultiplier(0.3), 0.5);
assert.equal(computeRecentPerformanceThrottleMultiplier(0.06), 0.3);

const recentMetrics = computeRecentClosedTradeMetrics(buildPortfolio({
  settings: {
    recent_performance_window_hours: 48
  },
  closed_trades: [
    sellTrade(12, 30),
    sellTrade(30, -10),
    sellTrade(60, 50)
  ]
}));

assert.equal(recentMetrics.window_hours, 48);
assert.equal(recentMetrics.closed_trade_count, 2);
assert.equal(recentMetrics.realized_pnl_usd, 20);

const dustClipPolicy = buildRegimeSentinelPolicy(buildPortfolio({
  cash_usd: 50000,
  closed_trades: Array.from({ length: 20 }, (_, index) => sellTrade((index % 10) + 1, -20, "harvest_exit", 2))
}), { macro: { regime: "neutral" } });
assert(dustClipPolicy.reason_codes.includes("throttle_skipped_low_sample"));
assert(!dustClipPolicy.reason_codes.includes("negative_recent_profit_factor"));

console.log("verifyRegimeSentinelThrottle: ok");
