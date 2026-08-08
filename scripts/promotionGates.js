import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { evaluateLiveCapabilityStatus, LIVE_CAPABLE_MODES } from "./custodyControls.js";
import { buildOperatorPermissionPolicy, recordOperatorAction } from "./auditTrail.js";
import { PROMOTION_SIGNED_REPORT_MARKER, evaluateLiveReadiness } from "./liveReadiness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REPORTS_DIR = path.join(ROOT, "reports");
const BACKTEST_REPORTS_DIR = path.join(REPORTS_DIR, "backtests");
const PROMOTION_REPORTS_DIR = path.join(REPORTS_DIR, "promotions");
const TRAINING_EVENT_LOG = path.join(ROOT, "logs", "training-events.jsonl");
const PORTFOLIO_FILE = path.join(ROOT, "portfolio.json");
const STATES = ["research", "paper", "shadow", "tiny_live", "scaled_live"];
const DEFAULT_TARGET_STATE = "paper";

const GATE_POLICY = {
  research: {
    minClosedTrades: 0,
    minOutOfSampleTrades: 0,
    minProfitFactor: 0,
    maxDrawdownPct: 100,
    minExpectancyUsd: null,
    minOutOfSampleReturnPct: null
  },
  paper: {
    minClosedTrades: 20,
    minOutOfSampleTrades: 4,
    minProfitFactor: 1.05,
    maxDrawdownPct: 20,
    minExpectancyUsd: 0,
    minOutOfSampleReturnPct: 0
  },
  shadow: {
    minClosedTrades: 50,
    minOutOfSampleTrades: 10,
    minProfitFactor: 1.15,
    maxDrawdownPct: 15,
    minExpectancyUsd: 0,
    minOutOfSampleReturnPct: 0
  },
  tiny_live: {
    minClosedTrades: 100,
    minOutOfSampleTrades: 20,
    minProfitFactor: 1.25,
    maxDrawdownPct: 10,
    minExpectancyUsd: 0,
    minOutOfSampleReturnPct: 0
  },
  scaled_live: {
    minClosedTrades: 200,
    minOutOfSampleTrades: 40,
    minProfitFactor: 1.4,
    maxDrawdownPct: 8,
    minExpectancyUsd: 0,
    minOutOfSampleReturnPct: 0
  }
};

function nowIso() {
  return new Date().toISOString();
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function pct(value) {
  return round(value * 100, 4);
}

function optionalMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function formatReportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function latestBacktestReport() {
  try {
    return fs.readdirSync(BACKTEST_REPORTS_DIR)
      .filter((name) => /^backtest-\d{8}-\d{6}\.json$/.test(name))
      .map((name) => path.join(BACKTEST_REPORTS_DIR, name))
      .map((filePath) => ({ filePath, report: readJsonFile(filePath) }))
      .filter(({ report }) => report?.report_type === "backtest_replay")
      .sort((a, b) => String(b.report.generated_at || "").localeCompare(String(a.report.generated_at || "")))[0] || null;
  } catch {
    return null;
  }
}

function listPriorPromotionReports(strategyVersion) {
  try {
    return fs.readdirSync(PROMOTION_REPORTS_DIR)
      .filter((name) => /^promotion-\d{8}-\d{6}\.json$/.test(name))
      .map((name) => readJsonFile(path.join(PROMOTION_REPORTS_DIR, name)))
      .filter((report) => report?.report_type === "strategy_promotion_gate")
      .filter((report) => !strategyVersion || report.strategy_version === strategyVersion)
      .sort((a, b) => String(a.generated_at || "").localeCompare(String(b.generated_at || "")));
  } catch {
    return [];
  }
}

function normalizeTradeFromEvent(event) {
  const pnl = toNum(event?.fill?.realized_pnl_usd, NaN);
  if (!Number.isFinite(pnl)) return null;
  const tsMs = optionalMs(event.ts);
  if (tsMs == null) return null;
  const gross = toNum(event?.fill?.gross_notional_usd, toNum(event?.fill?.net_proceeds_usd, 0));
  return {
    ts: event.ts,
    ts_ms: tsMs,
    day: String(event.ts).slice(0, 10),
    symbol: String(event.symbol || "unknown"),
    contract_address: String(event.contract_address || ""),
    setup: String(event.reason || "unknown").split(":")[0] || "unknown",
    pnl_usd: pnl,
    gross_notional_usd: gross,
    fee_usd: toNum(event?.fill?.fee_usd, 0),
    slippage_usd: toNum(event?.fill?.slippage_usd, 0)
  };
}

function closedReplayTrades(backtest) {
  return (backtest?.replay?.simulated_fills || [])
    .map(normalizeTradeFromEvent)
    .filter(Boolean)
    .sort((a, b) => a.ts_ms - b.ts_ms || a.symbol.localeCompare(b.symbol));
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function metricsForTrades(trades, initialEquityUsd = 0, finalEquityUsd = null) {
  const wins = trades.filter((trade) => trade.pnl_usd > 0);
  const losses = trades.filter((trade) => trade.pnl_usd < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl_usd, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + trade.pnl_usd, 0);
  const realizedPnl = grossProfit + grossLoss;
  const grossNotional = trades.reduce((sum, trade) => sum + Math.abs(toNum(trade.gross_notional_usd, 0)), 0);
  const feeDrag = trades.reduce((sum, trade) => sum + toNum(trade.fee_usd, 0), 0);
  const slippageDrag = trades.reduce((sum, trade) => sum + toNum(trade.slippage_usd, 0), 0);
  const denominator = initialEquityUsd > 0 ? initialEquityUsd : Math.max(grossNotional, 1);

  return {
    closed_trade_count: trades.length,
    winning_trade_count: wins.length,
    losing_trade_count: losses.length,
    win_rate_pct: trades.length ? pct(wins.length / trades.length) : 0,
    realized_pnl_usd: round(realizedPnl),
    gross_profit_usd: round(grossProfit),
    gross_loss_usd: round(grossLoss),
    profit_factor: grossLoss < 0 ? round(grossProfit / Math.abs(grossLoss), 4) : (grossProfit > 0 ? null : 0),
    expectancy_usd: round(average(trades.map((trade) => trade.pnl_usd)) ?? 0),
    average_win_usd: round(average(wins.map((trade) => trade.pnl_usd)) ?? 0),
    average_loss_usd: round(average(losses.map((trade) => trade.pnl_usd)) ?? 0),
    turnover_usd: round(grossNotional),
    fee_drag_usd: round(feeDrag),
    slippage_drag_usd: round(slippageDrag),
    fee_slippage_drag_usd: round(feeDrag + slippageDrag),
    total_return_pct: finalEquityUsd != null && initialEquityUsd > 0
      ? pct((finalEquityUsd - initialEquityUsd) / initialEquityUsd)
      : pct(realizedPnl / denominator)
  };
}

function splitTrades(trades) {
  const n = trades.length;
  const trainEnd = Math.floor(n * 0.6);
  const validationEnd = Math.floor(n * 0.8);
  return {
    train: trades.slice(0, trainEnd),
    validation: trades.slice(trainEnd, validationEnd),
    out_of_sample: trades.slice(validationEnd)
  };
}

function rollingWindows(trades, size = null) {
  if (!trades.length) return [];
  const windowSize = size || Math.max(5, Math.ceil(trades.length / 4));
  if (trades.length <= windowSize) return [{ index: 1, trades }];
  const step = Math.max(1, Math.floor(windowSize / 2));
  const windows = [];
  for (let start = 0; start < trades.length; start += step) {
    const windowTrades = trades.slice(start, start + windowSize);
    if (windowTrades.length < Math.min(5, windowSize)) break;
    windows.push({ index: windows.length + 1, trades: windowTrades });
    if (start + windowSize >= trades.length) break;
  }
  return windows;
}

function concentrationBy(trades, keyFn) {
  const grossAbs = trades.reduce((sum, trade) => sum + Math.abs(trade.pnl_usd), 0);
  const groups = new Map();
  for (const trade of trades) {
    const key = String(keyFn(trade) || "unknown");
    const current = groups.get(key) || { key, realized_pnl_usd: 0, absolute_pnl_usd: 0, closed_trade_count: 0 };
    current.realized_pnl_usd += trade.pnl_usd;
    current.absolute_pnl_usd += Math.abs(trade.pnl_usd);
    current.closed_trade_count += 1;
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      closed_trade_count: group.closed_trade_count,
      realized_pnl_usd: round(group.realized_pnl_usd),
      absolute_pnl_usd: round(group.absolute_pnl_usd),
      absolute_pnl_share_pct: grossAbs > 0 ? pct(group.absolute_pnl_usd / grossAbs) : 0
    }))
    .sort((a, b) => b.absolute_pnl_usd - a.absolute_pnl_usd);
}

function maxDrawdownFromBacktest(backtest) {
  return toNum(backtest?.metrics?.max_drawdown_pct, 0);
}

function buildWalkForward(backtest, trades) {
  const initialEquity = toNum(backtest?.metrics?.initial_equity_usd, 0);
  const splits = splitTrades(trades);
  const rolling = rollingWindows(trades).map((window) => ({
    index: window.index,
    start_at: window.trades[0]?.ts || null,
    end_at: window.trades[window.trades.length - 1]?.ts || null,
    metrics: metricsForTrades(window.trades, initialEquity)
  }));

  return {
    split_policy: "chronological_60_20_20_by_closed_replay_trade",
    train: {
      start_at: splits.train[0]?.ts || null,
      end_at: splits.train[splits.train.length - 1]?.ts || null,
      metrics: metricsForTrades(splits.train, initialEquity)
    },
    validation: {
      start_at: splits.validation[0]?.ts || null,
      end_at: splits.validation[splits.validation.length - 1]?.ts || null,
      metrics: metricsForTrades(splits.validation, initialEquity)
    },
    out_of_sample: {
      start_at: splits.out_of_sample[0]?.ts || null,
      end_at: splits.out_of_sample[splits.out_of_sample.length - 1]?.ts || null,
      metrics: metricsForTrades(splits.out_of_sample, initialEquity)
    },
    rolling_windows: rolling
  };
}

function latestPerformanceSummary() {
  try {
    return fs.readdirSync(REPORTS_DIR)
      .filter((name) => /^performance-daily-\d{8}\.json$/.test(name))
      .map((name) => readJsonFile(path.join(REPORTS_DIR, name)))
      .filter((report) => report?.report_type === "daily_performance")
      .sort((a, b) => String(b.generated_at || "").localeCompare(String(a.generated_at || "")))[0] || null;
  } catch {
    return null;
  }
}

function setupSampleCounts(trades) {
  return concentrationBy(trades, (trade) => trade.setup)
    .map((group) => ({
      setup: group.key,
      closed_trade_count: group.closed_trade_count,
      realized_pnl_usd: group.realized_pnl_usd
    }));
}

function detectOverfitting(backtest, trades, walkForward) {
  const flags = [];
  const byDay = concentrationBy(trades, (trade) => trade.day);
  const byToken = concentrationBy(trades, (trade) => trade.symbol);
  const absolutePnl = trades.reduce((sum, trade) => sum + Math.abs(trade.pnl_usd), 0);
  const largestTrade = [...trades].sort((a, b) => Math.abs(b.pnl_usd) - Math.abs(a.pnl_usd))[0] || null;
  const metrics = metricsForTrades(
    trades,
    toNum(backtest?.metrics?.initial_equity_usd, 0),
    toNum(backtest?.metrics?.final_equity_usd, null)
  );
  const drag = toNum(backtest?.metrics?.fee_slippage_drag_usd, metrics.fee_slippage_drag_usd);

  if (byDay[0]?.absolute_pnl_share_pct >= 45) {
    flags.push({
      code: "performance_concentrated_in_one_day",
      severity: "blocker",
      detail: `${byDay[0].key} accounts for ${byDay[0].absolute_pnl_share_pct}% of absolute realized PnL.`
    });
  }
  if (byToken[0]?.absolute_pnl_share_pct >= 45) {
    flags.push({
      code: "performance_concentrated_in_one_token",
      severity: "blocker",
      detail: `${byToken[0].key} accounts for ${byToken[0].absolute_pnl_share_pct}% of absolute realized PnL.`
    });
  }
  if (largestTrade && absolutePnl > 0 && Math.abs(largestTrade.pnl_usd) / absolutePnl >= 0.35) {
    flags.push({
      code: "performance_from_one_large_outlier",
      severity: "blocker",
      detail: `${largestTrade.symbol} trade on ${largestTrade.day} accounts for ${pct(Math.abs(largestTrade.pnl_usd) / absolutePnl)}% of absolute realized PnL.`
    });
  }
  if (toNum(backtest?.metrics?.turnover_ratio, 0) >= 2 && metrics.realized_pnl_usd > 0 && drag / Math.max(metrics.realized_pnl_usd, 1) >= 0.5) {
    flags.push({
      code: "high_turnover_fee_sensitive_edge",
      severity: "blocker",
      detail: `Fee/slippage drag is ${round(drag / Math.max(metrics.realized_pnl_usd, 1), 2)}x realized PnL with turnover ratio ${backtest.metrics.turnover_ratio}.`
    });
  }
  if (metrics.win_rate_pct > 50 && metrics.expectancy_usd < 0) {
    flags.push({
      code: "positive_win_rate_negative_expectancy",
      severity: "blocker",
      detail: `Win rate is ${metrics.win_rate_pct}% while expectancy is $${metrics.expectancy_usd}.`
    });
  }
  if (walkForward.out_of_sample.metrics.closed_trade_count > 0 && walkForward.out_of_sample.metrics.expectancy_usd < 0) {
    flags.push({
      code: "negative_out_of_sample_expectancy",
      severity: "blocker",
      detail: `Out-of-sample expectancy is $${walkForward.out_of_sample.metrics.expectancy_usd}.`
    });
  }

  return {
    flags,
    concentrations: {
      by_day: byDay.slice(0, 8),
      by_token: byToken.slice(0, 8),
      largest_trade: largestTrade ? {
        ts: largestTrade.ts,
        symbol: largestTrade.symbol,
        pnl_usd: round(largestTrade.pnl_usd),
        absolute_pnl_share_pct: absolutePnl > 0 ? pct(Math.abs(largestTrade.pnl_usd) / absolutePnl) : 0
      } : null
    }
  };
}

function gateChecks(targetState, backtest, trades, walkForward, overfitting, options, liveCapability, readiness) {
  const policy = GATE_POLICY[targetState] || GATE_POLICY[DEFAULT_TARGET_STATE];
  const metrics = backtest?.metrics || {};
  const blockers = [];
  const warnings = [];
  const addBlocker = (code, detail) => blockers.push({ code, detail });
  const addWarning = (code, detail) => warnings.push({ code, detail });

  if (!backtest) addBlocker("missing_backtest_report", "No Phase 1 backtest report was found.");
  if (targetState !== "research" && !backtest?.signature && !backtest?.determinism?.output_hash) {
    addBlocker("unsigned_or_unhashed_backtest", "Promotion requires a deterministic backtest hash or signed source report.");
  }
  if (trades.length < policy.minClosedTrades) {
    addBlocker("minimum_sample_size_not_met", `Need at least ${policy.minClosedTrades} closed replay trades for ${targetState}; found ${trades.length}.`);
  }
  if (walkForward.out_of_sample.metrics.closed_trade_count < policy.minOutOfSampleTrades) {
    addBlocker("out_of_sample_sample_size_not_met", `Need at least ${policy.minOutOfSampleTrades} out-of-sample trades; found ${walkForward.out_of_sample.metrics.closed_trade_count}.`);
  }
  if (policy.minProfitFactor != null && toNum(metrics.profit_factor, 0) < policy.minProfitFactor) {
    addBlocker("profit_factor_below_gate", `Need profit factor >= ${policy.minProfitFactor}; found ${metrics.profit_factor ?? "n/a"}.`);
  }
  if (policy.maxDrawdownPct != null && maxDrawdownFromBacktest(backtest) > policy.maxDrawdownPct) {
    addBlocker("drawdown_above_gate", `Need max drawdown <= ${policy.maxDrawdownPct}%; found ${maxDrawdownFromBacktest(backtest)}%.`);
  }
  if (policy.minExpectancyUsd != null && metricsForTrades(trades).expectancy_usd <= policy.minExpectancyUsd) {
    addBlocker("expectancy_below_gate", `Need positive expectancy; found $${metricsForTrades(trades).expectancy_usd}.`);
  }
  if (policy.minOutOfSampleReturnPct != null && walkForward.out_of_sample.metrics.total_return_pct <= policy.minOutOfSampleReturnPct) {
    addBlocker("out_of_sample_return_below_gate", `Need positive out-of-sample return; found ${walkForward.out_of_sample.metrics.total_return_pct}%.`);
  }

  for (const flag of overfitting.flags) {
    if (flag.severity === "blocker") addBlocker(flag.code, flag.detail);
    else addWarning(flag.code, flag.detail);
  }

  const setupCounts = setupSampleCounts(trades);
  const thinSetups = setupCounts.filter((item) => item.closed_trade_count > 0 && item.closed_trade_count < 5);
  if (thinSetups.length && targetState !== "research") {
    addWarning("thin_setup_samples", `${thinSetups.length} setup buckets have fewer than 5 closed examples.`);
  }

  if (LIVE_CAPABLE_MODES.includes(targetState)) {
    addBlocker("live_trading_phases_not_enabled", `${targetState} remains blocked until execution simulation, risk engine, data quality, operations, reconciliation, and compliance phases are complete.`);
    for (const code of liveCapability?.blockers || []) {
      const check = (liveCapability?.checks || []).find((item) => item.code === code);
      addBlocker(`live_capability_${code}`, check?.detail || liveCapability?.summary || "Live capability controls are incomplete or disabled.");
    }
    if (!readiness?.readiness_met) {
      addBlocker("live_readiness_not_met", `Need ${readiness?.required_consecutive_cycles || 50} consecutive A/B Manager cycles before live-capable promotion.`);
    }
  }
  if (targetState === "scaled_live") {
    addBlocker("scaled_live_requires_later_phase_approval", "Scaled live mode is explicitly outside the Phase 2 scope.");
  }

  if (options.requireSignature === false) {
    addWarning("signature_requirement_disabled", "Signature enforcement was disabled by CLI option.");
  }

  return { blockers, warnings, policy, setup_sample_counts: setupCounts };
}

function signReport(report) {
  const payload = report?.signed_payload && typeof report.signed_payload === "object"
    ? report.signed_payload
    : {
        ...report,
        signature: null,
        signed: false,
        signed_payload_hash: null
      };
  const payloadHash = sha256(stableStringify(payload));
  return {
    signed: true,
    signature_scheme: "sha256-stable-json",
    signer: "promotion_gates",
    signed_at: payload.generated_at || report.generated_at,
    signed_payload_hash: payloadHash,
    signature: sha256(`promotion_gates:${payloadHash}`)
  };
}

function buildReadinessProof(readiness) {
  return {
    strategy_version: readiness?.strategy_version || null,
    required_consecutive_cycles: readiness?.required_consecutive_cycles ?? 50,
    qualifying_grades: Array.isArray(readiness?.qualifying_grades) ? [...readiness.qualifying_grades] : ["A", "B"],
    readiness_met: readiness?.readiness_met === true,
    threshold_cycle: readiness?.threshold_cycle ? {
      report_id: readiness.threshold_cycle.report_id || null,
      generated_at: readiness.threshold_cycle.generated_at || null
    } : null
  };
}

function buildPromotionSignedPayload(report, readiness) {
  return {
    report_id: report.report_id,
    generated_at: report.generated_at,
    signed_report_marker: PROMOTION_SIGNED_REPORT_MARKER,
    strategy_version: report.strategy_version,
    target_state: report.target_state,
    promotion_decision: report.promotion_decision,
    promotion_allowed: report.promotion_allowed,
    blockers: report.blockers,
    warnings: report.warnings,
    readiness_summary: readiness,
    readiness_proof: buildReadinessProof(readiness)
  };
}

function markdownReport(report) {
  const lines = [
    `# Strategy Promotion Gate - ${report.report_id}`,
    "",
    `Generated: ${report.generated_at}`,
    `Strategy version: ${report.strategy_version}`,
    `Target state: ${report.target_state}`,
    `Decision: ${report.promotion_decision}`,
    `Signed: ${report.signed ? "yes" : "no"}`,
    "",
    "## Required Evidence",
    "",
    `- Closed replay trades: ${report.evidence.sample_size.closed_trade_count}`,
    `- Out-of-sample trades: ${report.walk_forward.out_of_sample.metrics.closed_trade_count}`,
    `- Profit factor: ${report.evidence.performance.profit_factor ?? "n/a"}`,
    `- Expectancy: $${report.evidence.performance.expectancy_usd}`,
    `- Max drawdown: ${report.evidence.performance.max_drawdown_pct}%`,
    `- Total return: ${report.evidence.performance.total_return_pct}%`,
    "",
    "## Walk Forward",
    "",
    `- Train: ${report.walk_forward.train.metrics.closed_trade_count} trades, ${report.walk_forward.train.metrics.total_return_pct}% return`,
    `- Validation: ${report.walk_forward.validation.metrics.closed_trade_count} trades, ${report.walk_forward.validation.metrics.total_return_pct}% return`,
    `- Out of sample: ${report.walk_forward.out_of_sample.metrics.closed_trade_count} trades, ${report.walk_forward.out_of_sample.metrics.total_return_pct}% return`,
    "",
    "## Blockers",
    "",
    ...(report.blockers.length ? report.blockers.map((item) => `- ${item.code}: ${item.detail}`) : ["- none"]),
    "",
    "## Live Capability",
    "",
    `- Status: ${report.live_capability.capability_status}`,
    `- Live submission enabled: ${report.live_capability.live_submission_enabled ? "yes" : "no"}`,
    `- Blockers: ${report.live_capability.blockers.length ? report.live_capability.blockers.join(", ") : "none"}`,
    "",
    "## Warnings",
    "",
    ...(report.warnings.length ? report.warnings.map((item) => `- ${item.code}: ${item.detail}`) : ["- none"]),
    "",
    "## Known Weaknesses",
    "",
    ...(report.known_weaknesses.length ? report.known_weaknesses.map((item) => `- ${item}`) : ["- none recorded"]),
    "",
    "## Signature",
    "",
    `- Payload hash: ${report.signed_payload_hash}`,
    `- Signature: ${report.signature}`
  ];
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const get = (name, fallback = null) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const targetState = String(get("target-state", DEFAULT_TARGET_STATE)).trim();
  return {
    strategyVersion: get("strategy-version", null),
    parentStrategyVersion: get("parent-strategy-version", null),
    targetState: STATES.includes(targetState) ? targetState : DEFAULT_TARGET_STATE,
    generatedAt: get("generated-at", null),
    backtestReport: get("backtest-report", null),
    appendEvent: !argv.includes("--no-append-event"),
    assertPromotable: argv.includes("--assert-promotable"),
    requireSignature: !argv.includes("--no-require-signature")
  };
}

export function evaluatePromotionGates(options = {}) {
  const generatedAt = new Date(optionalMs(options.generatedAt) || Date.now()).toISOString();
  const targetState = STATES.includes(options.targetState) ? options.targetState : DEFAULT_TARGET_STATE;
  const explicitBacktest = options.backtestReport ? { filePath: path.resolve(ROOT, options.backtestReport), report: readJsonFile(path.resolve(ROOT, options.backtestReport)) } : null;
  const source = explicitBacktest?.report ? explicitBacktest : latestBacktestReport();
  const backtest = source?.report || null;
  const strategyVersion = options.strategyVersion || backtest?.strategy_version || "unknown";
  const parentStrategyVersion = options.parentStrategyVersion || null;
  const readiness = evaluateLiveReadiness({
    strategyVersion,
    reports: options.readinessReports || undefined,
    reportsDir: options.readinessReportsDir || REPORTS_DIR,
    policy: options.readinessPolicy || undefined
  });
  const trades = closedReplayTrades(backtest);
  const initialEquity = toNum(backtest?.metrics?.initial_equity_usd, 0);
  const aggregateTradeMetrics = metricsForTrades(trades, initialEquity, toNum(backtest?.metrics?.final_equity_usd, null));
  const walkForward = buildWalkForward(backtest, trades);
  const overfitting = detectOverfitting(backtest, trades, walkForward);
  const performanceReport = latestPerformanceSummary();
  const portfolio = readJsonFile(PORTFOLIO_FILE, {});
  const liveCapability = evaluateLiveCapabilityStatus({
    mode: targetState,
    portfolio,
    crypto_controls: options.cryptoControls || null
  });
  const operatorPermission = buildOperatorPermissionPolicy({
    action_type: "promotion_decision",
    mode: targetState,
    actor: options.actor || "promotion_gates",
    role: options.role || "risk_admin",
    reason: options.reason || `evaluate strategy promotion to ${targetState}`,
    portfolio,
    crypto_controls: options.cryptoControls || null,
    approvals: options.approvals || []
  });
  const gate = gateChecks(targetState, backtest, trades, walkForward, overfitting, options, liveCapability, readiness);
  const priorReports = listPriorPromotionReports(strategyVersion);
  const reportTimestamp = formatReportTimestamp(new Date(optionalMs(generatedAt) || Date.now()));
  const reportFile = `reports/promotions/promotion-${reportTimestamp}.json`;
  const markdownFile = `reports/promotions/promotion-${reportTimestamp}.md`;
  const blockers = gate.blockers;
  const promotionAllowed = blockers.length === 0;
  const reportId = `promotion-${sha256(`${strategyVersion}:${targetState}:${backtest?.input_hash || ""}:${generatedAt}`).slice(0, 16)}`;
  const knownWeaknesses = [
    ...gate.warnings.map((warning) => `${warning.code}: ${warning.detail}`),
    ...(overfitting.flags.length ? [] : ["No overfitting blockers detected by Phase 2 heuristics."]),
    ...(backtest?.baselines?.buy_and_hold_eth?.available === false ? ["Buy-and-hold ETH baseline unavailable for this replay window."] : [])
  ];

  const report = {
    report_id: reportId,
    report_type: "strategy_promotion_gate",
    schema_version: "1.0",
    generated_at: generatedAt,
    strategy_version: strategyVersion,
    target_state: targetState,
    parent_strategy_version: parentStrategyVersion,
    promotion_states: STATES,
    current_phase: "phase_2_walk_forward_validation_and_promotion_gates",
    promotion_decision: promotionAllowed ? `approved_for_${targetState}` : "blocked",
    promotion_allowed: promotionAllowed,
    report_file: reportFile,
    markdown_file: markdownFile,
    data_sources: {
      backtest_report: source?.filePath ? path.relative(ROOT, source.filePath) : null,
      performance_report: performanceReport?.report_file || null,
      training_events_jsonl: "logs/training-events.jsonl"
    },
    strategy_lineage: {
      strategy_version: strategyVersion,
      parent_strategy_version: parentStrategyVersion,
      prior_promotion_reports: priorReports.map((item) => ({
        report_id: item.report_id,
        generated_at: item.generated_at,
        target_state: item.target_state,
        promotion_decision: item.promotion_decision,
        signature: item.signature || null
      }))
    },
    evidence: {
      sample_size: {
        closed_trade_count: trades.length,
        train_closed_trade_count: walkForward.train.metrics.closed_trade_count,
        validation_closed_trade_count: walkForward.validation.metrics.closed_trade_count,
        out_of_sample_closed_trade_count: walkForward.out_of_sample.metrics.closed_trade_count,
        setup_sample_counts: gate.setup_sample_counts
      },
      performance: {
        ...aggregateTradeMetrics,
        max_drawdown_pct: maxDrawdownFromBacktest(backtest),
        backtest_total_return_pct: backtest?.metrics?.total_return_pct ?? null,
        backtest_profit_factor: backtest?.metrics?.profit_factor ?? null,
        cash_baseline_return_pct: backtest?.baselines?.cash?.total_return_pct ?? null,
        buy_and_hold_eth_return_pct: backtest?.baselines?.buy_and_hold_eth?.available
          ? backtest.baselines.buy_and_hold_eth.total_return_pct
          : null
      }
    },
    walk_forward: walkForward,
    overfitting,
    gates: {
      target_policy: gate.policy,
      require_signed_report: options.requireSignature !== false,
      live_trading_enabled: false
    },
    live_capability: liveCapability,
    operator_permission: operatorPermission,
    readiness,
    blockers,
    warnings: gate.warnings,
    known_weaknesses: knownWeaknesses,
    safety: {
      portfolio_json_mutation: "not_performed",
      live_trading_enabled: false,
      mode_change_performed: false
    }
  };

  report.signed_payload = buildPromotionSignedPayload(report, readiness);
  Object.assign(report, signReport(report));

  if (options.writeReport !== false) {
    fs.mkdirSync(PROMOTION_REPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ROOT, reportFile), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(ROOT, markdownFile), markdownReport(report));
  }

  if (options.appendEvent !== false) {
    fs.mkdirSync(path.dirname(TRAINING_EVENT_LOG), { recursive: true });
    fs.appendFileSync(TRAINING_EVENT_LOG, `${JSON.stringify({
      event_id: sha256(`${report.report_id}:${report.signature}`).slice(0, 32),
      schema_version: "1.0",
      ts: generatedAt,
      event_type: "strategy_promotion_gate",
      actor: "promotion_gates",
      pipeline_run_id: null,
      cycle_id: null,
      cycle_index: -1,
      market_regime: "unknown",
      candidate_id: null,
      position_id: null,
      trade_id: null,
      payload: {
        report_id: report.report_id,
        strategy_version: report.strategy_version,
        target_state: report.target_state,
        promotion_decision: report.promotion_decision,
        blocker_count: report.blockers.length,
        warning_count: report.warnings.length,
        signature: report.signature,
        report_file: report.report_file
      }
    })}\n`);
    recordOperatorAction({
      action_type: "promotion_decision",
      ts: generatedAt,
      actor: options.actor || "promotion_gates",
      role: options.role || "risk_admin",
      reason: options.reason || `evaluate strategy promotion to ${targetState}`,
      resource: "strategy_promotion",
      previous_state: { strategy_version: strategyVersion, target_state: targetState },
      new_state: {
        report_id: report.report_id,
        promotion_decision: report.promotion_decision,
        promotion_allowed: report.promotion_allowed,
        target_state: report.target_state
      },
      permission: operatorPermission,
      report_id: report.report_id,
      metadata: {
        signature: report.signature,
        blocker_count: report.blockers.length,
        warning_count: report.warnings.length,
        live_submission_enabled: false,
        report_file: report.report_file
      }
    });
  }

  return report;
}

if (process.argv[1] === __filename) {
  const options = parseArgs(process.argv.slice(2));
  const report = evaluatePromotionGates(options);
  console.log(JSON.stringify({
    report_id: report.report_id,
    report_file: report.report_file,
    markdown_file: report.markdown_file,
    strategy_version: report.strategy_version,
    target_state: report.target_state,
    promotion_decision: report.promotion_decision,
    promotion_allowed: report.promotion_allowed,
    blocker_count: report.blockers.length,
    signature: report.signature
  }, null, 2));
  if (options.assertPromotable && !report.promotion_allowed) process.exit(1);
}
