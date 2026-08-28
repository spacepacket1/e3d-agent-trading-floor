import crypto from "crypto";
import { evaluateLiveCapabilityStatus, LIVE_CAPABLE_MODES } from "./custodyControls.js";
import { buildOperatorActionRecord, buildOperatorPermissionPolicy } from "./auditTrail.js";
import {
  buildMandateTrace,
  currentMandateStatus,
  validateMandateConstraintsAgainstPolicy
} from "./capitalMandates.js";

export const RISK_ENGINE_SCHEMA_VERSION = "1.0";
export const RISK_POLICY_VERSION = "risk-policy-v1";

export const DEFAULT_RISK_POLICY = Object.freeze({
  daily_realized_loss_limit_usd: 2500,
  daily_equity_drawdown_limit_pct: 0.12,
  rolling_24h_loss_limit_usd: 3500,
  max_position_size_pct: 0.12,
  max_token_exposure_pct: 0.12,
  max_category_exposure_pct: 0.70,
  max_strategy_exposure_pct: 0.75,
  max_open_positions: 6,
  max_daily_turnover_usd: 250000,
  cooldown_after_stop_loss_hours: 12,
  token_repeated_loss_stop_count: 2,
  token_repeated_loss_window_days: 30,
  token_repeated_loss_cooldown_days: 30,
  strategy_loss_cluster_window_hours: 24,
  strategy_loss_cluster_count: 2,
  strategy_loss_cluster_loss_limit_usd: 1500,
  strategy_loss_cluster_cooldown_hours: 12,
  negative_expectancy_min_samples: 3,
  negative_expectancy_negative_rate_threshold: 0.55,
  negative_expectancy_min_expectancy_usd: 0,
  min_liquidity_usd: 100000,
  max_spread_bps: 150,
  max_slippage_bps: 150,
  market_risk_off_blocks_new_buys: true
});

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function cleanAddress(value) {
  const text = String(value || "").trim().toLowerCase();
  return text || null;
}

function cleanSide(value) {
  return String(value || "").trim().toLowerCase() === "sell" ? "sell" : "buy";
}

function cleanList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanText(value))
    .filter(Boolean))];
}

function localDayKey(ts, timezone = null) {
  const date = ts ? new Date(ts) : new Date();
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function optionalMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function tradeNotionalUsd(trade = {}) {
  return round(Math.abs(toNum(
    trade?.cost_usd,
    toNum(
      trade?.proceeds_usd,
      toNum(trade?.gross_proceeds_usd, toNum(trade?.paper_trade_ticket?.allocation_usd, 0))
    )
  )), 2);
}

function tradePnlUsd(trade = {}) {
  return round(toNum(trade?.pnl_usd, 0), 2);
}

function extractTradesForWindow(portfolio = {}) {
  const seen = new Set();
  const trades = [
    ...(Array.isArray(portfolio?.action_history) ? portfolio.action_history : []),
    ...(Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [])
  ].filter((trade) => {
    const key = trade?.trade_id || stableStringify({
      ts: trade?.ts || null,
      side: trade?.side || null,
      symbol: trade?.symbol || null,
      quantity: trade?.quantity || null,
      price: trade?.price || null
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return trades
    .map((trade) => ({ ...trade, ts_ms: optionalMs(trade?.ts) }))
    .filter((trade) => trade.ts_ms != null)
    .sort((a, b) => a.ts_ms - b.ts_ms || String(a.trade_id || "").localeCompare(String(b.trade_id || "")));
}

function positionValueUsd(position = {}) {
  return round(toNum(
    position?.market_value_usd,
    toNum(position?.current_value_usd, toNum(position?.cost_basis_usd, 0))
  ), 2);
}

function computeEquityUsd(portfolio = {}) {
  const marketValue = Object.values(portfolio?.positions || {}).reduce((sum, position) => sum + positionValueUsd(position), 0);
  return round(toNum(portfolio?.cash_usd, 0) + marketValue, 2);
}

function aggregateExposure(portfolio = {}, keyFn) {
  const map = new Map();
  for (const position of Object.values(portfolio?.positions || {})) {
    const key = keyFn(position);
    if (!key) continue;
    map.set(key, round((map.get(key) || 0) + positionValueUsd(position), 2));
  }
  return map;
}

function computeDailyTurnoverUsd(portfolio, evaluationTs, timezone) {
  const dayKey = localDayKey(evaluationTs, timezone);
  return round(extractTradesForWindow(portfolio)
    .filter((trade) => localDayKey(trade.ts, timezone) === dayKey)
    .reduce((sum, trade) => sum + tradeNotionalUsd(trade), 0), 2);
}

function computeDailyRealizedPnlUsd(portfolio, evaluationTs, timezone) {
  const dayKey = localDayKey(evaluationTs, timezone);
  return round((Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [])
    .filter((trade) => String(trade?.side || "").toLowerCase() === "sell")
    .filter((trade) => localDayKey(trade.ts, timezone) === dayKey)
    .reduce((sum, trade) => sum + tradePnlUsd(trade), 0), 2);
}

function computeRollingLossUsd(portfolio, evaluationTs, hours = 24) {
  const evaluationMs = optionalMs(evaluationTs);
  if (evaluationMs == null) return 0;
  const cutoff = evaluationMs - (hours * 60 * 60 * 1000);
  const realizedPnl = (Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [])
    .map((trade) => ({ trade, ts_ms: optionalMs(trade?.ts) }))
    .filter(({ trade, ts_ms }) => String(trade?.side || "").toLowerCase() === "sell" && ts_ms != null && ts_ms >= cutoff && ts_ms <= evaluationMs)
    .reduce((sum, { trade }) => sum + tradePnlUsd(trade), 0);
  return round(realizedPnl, 2);
}

function classifyExitReason(reason) {
  const root = String(reason || "").toLowerCase().split(":")[0];
  if (root.includes("stop")) return "stop_loss";
  return root || "unknown";
}

function summarizeExpectancyRegime(intent = {}, analytics = {}, policy = DEFAULT_RISK_POLICY) {
  const setupKey = cleanText(intent?.setup_type || intent?.setup_label || intent?.reason || "unknown");
  const rows = Array.isArray(analytics?.review_stats?.setup_expectancy) ? analytics.review_stats.setup_expectancy : [];
  const row = rows.find((entry) => cleanText(entry?.setup_label || entry?.setup_type || "unknown") === setupKey) || null;
  if (!row) return { blocked: false, setup_key: setupKey, source: "no_setup_history" };

  const reviewed = toNum(row.reviewed, 0);
  const negativeRate = toNum(row.negative_rate, 0);
  const expectancyUsd = row.expectancy_usd == null ? null : toNum(row.expectancy_usd, 0);
  const blocked = reviewed >= policy.negative_expectancy_min_samples
    && negativeRate >= policy.negative_expectancy_negative_rate_threshold
    && (expectancyUsd == null || expectancyUsd <= policy.negative_expectancy_min_expectancy_usd);

  return {
    blocked,
    setup_key: setupKey,
    reviewed,
    negative_rate: round(negativeRate, 6),
    expectancy_usd: expectancyUsd == null ? null : round(expectancyUsd, 2),
    source: "review_stats"
  };
}

function summarizeStrategyLossCluster(portfolio = {}, intent = {}, evaluationTs, policy = DEFAULT_RISK_POLICY) {
  const evaluationMs = optionalMs(evaluationTs);
  const strategyVersion = cleanText(intent?.strategy_version);
  if (evaluationMs == null || !strategyVersion) {
    return { blocked: false, loss_count: 0, realized_loss_usd: 0, cooldown_until: null };
  }

  const cutoff = evaluationMs - (policy.strategy_loss_cluster_window_hours * 60 * 60 * 1000);
  const losses = (Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [])
    .map((trade) => ({ trade, ts_ms: optionalMs(trade?.ts) }))
    .filter(({ trade, ts_ms }) => ts_ms != null && ts_ms >= cutoff && ts_ms <= evaluationMs)
    .filter(({ trade }) => cleanText(trade?.strategy_version) === strategyVersion)
    .filter(({ trade }) => tradePnlUsd(trade) < 0);

  const realizedLossUsd = round(losses.reduce((sum, { trade }) => sum + Math.abs(tradePnlUsd(trade)), 0), 2);
  const latestLossMs = losses.length ? Math.max(...losses.map(({ ts_ms }) => ts_ms)) : null;
  const cooldownUntil = latestLossMs == null
    ? null
    : new Date(latestLossMs + (policy.strategy_loss_cluster_cooldown_hours * 60 * 60 * 1000)).toISOString();
  const blocked = losses.length >= policy.strategy_loss_cluster_count
    && realizedLossUsd >= policy.strategy_loss_cluster_loss_limit_usd
    && latestLossMs != null
    && latestLossMs + (policy.strategy_loss_cluster_cooldown_hours * 60 * 60 * 1000) > evaluationMs;

  return {
    blocked,
    loss_count: losses.length,
    realized_loss_usd: realizedLossUsd,
    cooldown_until: cooldownUntil
  };
}

function summarizeStopLossCooldown(portfolio = {}, intent = {}, evaluationTs, policy = DEFAULT_RISK_POLICY) {
  const evaluationMs = optionalMs(evaluationTs);
  const symbol = cleanText(intent?.symbol);
  const contractAddress = cleanAddress(intent?.contract_address);
  if (evaluationMs == null || (!symbol && !contractAddress)) {
    return { blocked: false, cooldown_until: null };
  }

  const matching = (Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [])
    .map((trade) => ({ trade, ts_ms: optionalMs(trade?.ts) }))
    .filter(({ trade, ts_ms }) => ts_ms != null && ts_ms <= evaluationMs)
    .filter(({ trade }) => classifyExitReason(trade?.reason) === "stop_loss")
    .filter(({ trade }) => {
      const tradeSymbol = cleanText(trade?.symbol);
      const tradeAddress = cleanAddress(trade?.contract_address);
      return (symbol && tradeSymbol === symbol) || (contractAddress && tradeAddress === contractAddress);
    })
    .sort((a, b) => b.ts_ms - a.ts_ms)[0] || null;

  if (!matching) return { blocked: false, cooldown_until: null };
  const cooldownUntilMs = matching.ts_ms + (policy.cooldown_after_stop_loss_hours * 60 * 60 * 1000);
  return {
    blocked: cooldownUntilMs > evaluationMs,
    cooldown_until: new Date(cooldownUntilMs).toISOString()
  };
}

function summarizeTokenRepeatedLossBlock(portfolio = {}, intent = {}, evaluationTs, policy = DEFAULT_RISK_POLICY) {
  const evaluationMs = optionalMs(evaluationTs);
  const symbol = cleanText(intent?.symbol);
  const contractAddress = cleanAddress(intent?.contract_address);
  if (evaluationMs == null || (!symbol && !contractAddress)) {
    return { blocked: false, stop_loss_count: 0, cooldown_until: null };
  }
  const windowMs = policy.token_repeated_loss_window_days * 24 * 60 * 60 * 1000;
  const cutoff = evaluationMs - windowMs;
  const tokenStopLosses = (Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [])
    .map((trade) => ({ trade, ts_ms: optionalMs(trade?.ts) }))
    .filter(({ ts_ms }) => ts_ms != null && ts_ms >= cutoff && ts_ms <= evaluationMs)
    .filter(({ trade }) => classifyExitReason(trade?.reason) === "stop_loss")
    .filter(({ trade }) => {
      const tradeSymbol = cleanText(trade?.symbol);
      const tradeAddress = cleanAddress(trade?.contract_address);
      return (symbol && tradeSymbol === symbol) || (contractAddress && tradeAddress === contractAddress);
    })
    .sort((a, b) => b.ts_ms - a.ts_ms);
  if (tokenStopLosses.length < policy.token_repeated_loss_stop_count) {
    return { blocked: false, stop_loss_count: tokenStopLosses.length, cooldown_until: null };
  }
  const latestMs = tokenStopLosses[0].ts_ms;
  const cooldownMs = policy.token_repeated_loss_cooldown_days * 24 * 60 * 60 * 1000;
  const cooldownUntilMs = latestMs + cooldownMs;
  return {
    blocked: cooldownUntilMs > evaluationMs,
    stop_loss_count: tokenStopLosses.length,
    cooldown_until: new Date(cooldownUntilMs).toISOString()
  };
}

function buildCheckedLimit(key, label, limit, actual, status, extras = {}) {
  return {
    key,
    label,
    limit,
    actual,
    status,
    ...extras
  };
}

function addLimit(checkedLimits, blockers, warnings, limit) {
  checkedLimits.push(limit);
  if (limit.status === "block") blockers.push(limit.key);
  else if (limit.status === "warn") warnings.push(limit.key);
}

function mandateList(value, lowercase = false) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => cleanText(item))
    .filter(Boolean)
    .map((item) => lowercase ? item.toLowerCase() : item))];
}

export function resolveRiskPolicy(portfolio = {}, overrides = null) {
  const settings = portfolio?.settings || {};
  const embedded = settings?.risk_engine || {};
  return {
    ...DEFAULT_RISK_POLICY,
    max_position_size_pct: toNum(settings.max_position_pct, DEFAULT_RISK_POLICY.max_position_size_pct),
    max_category_exposure_pct: toNum(settings.category_cap_pct, DEFAULT_RISK_POLICY.max_category_exposure_pct),
    max_open_positions: toNum(settings.max_open_positions, DEFAULT_RISK_POLICY.max_open_positions),
    cooldown_after_stop_loss_hours: toNum(settings.cooldown_hours_after_exit, DEFAULT_RISK_POLICY.cooldown_after_stop_loss_hours),
    ...embedded,
    ...(overrides || {})
  };
}

export function buildRiskDecisionRef(decision = null, extras = {}) {
  if (!decision?.risk_decision_id) return null;
  return {
    event_type: "risk_engine_decision",
    risk_decision_id: decision.risk_decision_id,
    input_snapshot_hash: decision.input_snapshot_hash,
    policy_version: decision.policy_version,
    decision: decision.decision,
    order_id: decision.order_id || null,
    trade_id: decision.trade_id || null,
    source_trade_id: decision.source_trade_id || null,
    cycle_id: extras.cycle_id || null,
    pipeline_run_id: extras.pipeline_run_id || null
  };
}

export function evaluateRiskDecision(input = {}) {
  const portfolio = input.portfolio || {};
  const intent = input.intent || {};
  const analytics = input.analytics || {};
  const policy = resolveRiskPolicy(portfolio, input.policy);
  const evaluationTs = input.evaluated_at || intent.ts || analytics.evaluated_at || null;
  const timezone = input.timezone || analytics.timezone || null;
  const side = cleanSide(intent?.side);
  const symbol = cleanText(intent?.symbol);
  const contractAddress = cleanAddress(intent?.contract_address);
  const category = cleanText(intent?.category || "unknown");
  const strategyVersion = cleanText(intent?.strategy_version || "unknown");
  const requestedNotionalUsd = round(Math.max(0, toNum(intent?.requested_notional_usd, 0)), 2);
  const liquidityUsd = round(Math.max(0, toNum(intent?.liquidity_usd, 0)), 2);
  const spreadBps = round(Math.max(0, toNum(intent?.spread_bps, 0)), 4);
  const slippageBps = round(Math.max(0, toNum(intent?.slippage_bps, 0)), 4);
  const evidencePacketId = cleanText(intent?.evidence_packet_id);
  const evidenceQualityScore = intent?.evidence_quality_score == null
    ? null
    : round(Math.max(0, toNum(intent?.evidence_quality_score, 0)), 4);
  const evidenceRefCount = Math.max(0, Math.round(toNum(intent?.evidence_ref_count, 0)));
  const evidenceBlockers = cleanList(intent?.evidence_blockers);
  const evidenceWarnings = cleanList(intent?.evidence_warnings);
  const equityUsd = computeEquityUsd(portfolio);
  const currentPositionKey = symbol || contractAddress;
  const currentPosition = Object.values(portfolio?.positions || {}).find((position) => {
    const posSymbol = cleanText(position?.symbol);
    const posAddress = cleanAddress(position?.contract_address);
    return (symbol && posSymbol === symbol) || (contractAddress && posAddress === contractAddress);
  }) || null;
  const currentPositionValueUsd = currentPosition ? positionValueUsd(currentPosition) : 0;
  const projectedPositionValueUsd = round(currentPositionValueUsd + (side === "buy" ? requestedNotionalUsd : 0), 2);
  const projectedOpenPositions = Object.keys(portfolio?.positions || {}).length + (side === "buy" && !currentPosition ? 1 : 0);
  const tokenKey = contractAddress || symbol || null;
  const tokenExposure = tokenKey ? (aggregateExposure(portfolio, (position) => cleanAddress(position?.contract_address) || cleanText(position?.symbol)).get(tokenKey) || 0) : 0;
  const categoryExposure = aggregateExposure(portfolio, (position) => cleanText(position?.category || "unknown")).get(category) || 0;
  const strategyExposure = aggregateExposure(portfolio, (position) => cleanText(position?.strategy_version)).get(strategyVersion) || 0;
  const projectedTokenExposureUsd = round(tokenExposure + (side === "buy" ? requestedNotionalUsd : 0), 2);
  const projectedCategoryExposureUsd = round(categoryExposure + (side === "buy" ? requestedNotionalUsd : 0), 2);
  const projectedStrategyExposureUsd = round(strategyExposure + (side === "buy" ? requestedNotionalUsd : 0), 2);
  const dailyTurnoverUsd = computeDailyTurnoverUsd(portfolio, evaluationTs, timezone);
  const projectedDailyTurnoverUsd = round(dailyTurnoverUsd + requestedNotionalUsd, 2);
  const dailyRealizedPnlUsd = computeDailyRealizedPnlUsd(portfolio, evaluationTs, timezone);
  const rolling24hPnlUsd = computeRollingLossUsd(portfolio, evaluationTs, 24);
  const dayStartEquityUsd = round(toNum(analytics?.day_start_equity_usd, equityUsd), 2);
  const dailyEquityDrawdownPct = dayStartEquityUsd > 0 ? round(Math.max(0, (dayStartEquityUsd - equityUsd) / dayStartEquityUsd), 6) : 0;
  const marketRegime = cleanText(intent?.market_regime || analytics?.market_regime || portfolio?.stats?.market_regime || "unknown");
  const stopLossCooldown = summarizeStopLossCooldown(portfolio, intent, evaluationTs, policy);
  const tokenRepeatedLossBlock = summarizeTokenRepeatedLossBlock(portfolio, intent, evaluationTs, policy);
  const strategyLossCluster = summarizeStrategyLossCluster(portfolio, intent, evaluationTs, policy);
  const expectancyRegime = summarizeExpectancyRegime(intent, analytics, policy);
  const blockers = [];
  const warnings = [];
  const checked_limits = [];
  const isBuy = side === "buy";
  const capitalMandate = currentMandateStatus(input.capital_mandate) === "active" ? input.capital_mandate : null;
  const mandateTrace = buildMandateTrace(capitalMandate);
  const mode = cleanText(input?.mode || "paper");
  const riskOverrideRequested = Boolean(input.policy);
  const riskOverridePermission = riskOverrideRequested ? buildOperatorPermissionPolicy({
    action_type: "risk_override",
    mode,
    actor: input?.operator?.actor || input?.actor || "risk_engine",
    role: input?.operator?.role || input?.role || "viewer",
    reason: input?.override_reason || input?.reason || null,
    portfolio,
    crypto_controls: input.crypto_controls || input.custody_controls || null
  }) : null;
  const riskOverrideRecord = riskOverrideRequested ? buildOperatorActionRecord({
    action_type: "risk_override",
    ts: evaluationTs,
    actor: input?.operator?.actor || input?.actor || "risk_engine",
    role: input?.operator?.role || input?.role || "viewer",
    reason: input?.override_reason || input?.reason || null,
    resource: "risk_policy",
    previous_state: resolveRiskPolicy(portfolio, null),
    new_state: policy,
    permission: riskOverridePermission,
    metadata: {
      live_submission_enabled: false,
      write_performed: false
    }
  }) : null;
  const liveCapability = evaluateLiveCapabilityStatus({
    mode,
    portfolio,
    crypto_controls: input.crypto_controls || input.custody_controls || null
  });

  if (riskOverrideRequested && riskOverridePermission?.decision === "block") {
    addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
      "risk_override_not_permitted",
      "Risk override permission",
      { required_role: "risk_admin", reason_required: true },
      {
        permission_policy_id: riskOverridePermission.policy_id,
        blockers: riskOverridePermission.blockers,
        audit_event_id: riskOverrideRecord?.audit_event_id || null
      },
      "block"
    ));
  }

  if (LIVE_CAPABLE_MODES.includes(mode)) {
    addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
      "live_capability_blocked",
      "Live venue/wallet/custody/key controls",
      { live_submission_enabled: false },
      {
        capability_status_id: liveCapability.capability_status_id,
        capability_status: liveCapability.capability_status,
        blockers: liveCapability.blockers
      },
      "block"
    ));
  }

  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "evidence_packet_blockers",
    "Evidence packet blockers",
    { evidence_blockers_present: false },
    {
      evidence_packet_id: evidencePacketId,
      evidence_quality_score: evidenceQualityScore,
      evidence_ref_count: evidenceRefCount,
      evidence_blockers: evidenceBlockers,
      evidence_warnings: evidenceWarnings
    },
    isBuy && evidenceBlockers.length > 0 ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "daily_realized_loss_limit",
    "Daily realized loss limit",
    { loss_limit_usd: policy.daily_realized_loss_limit_usd },
    { realized_pnl_usd: dailyRealizedPnlUsd },
    isBuy && dailyRealizedPnlUsd <= -Math.abs(policy.daily_realized_loss_limit_usd) ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "daily_total_equity_drawdown_limit",
    "Daily total equity drawdown limit",
    { drawdown_pct: policy.daily_equity_drawdown_limit_pct },
    { drawdown_pct: dailyEquityDrawdownPct, day_start_equity_usd: dayStartEquityUsd, current_equity_usd: equityUsd },
    isBuy && dailyEquityDrawdownPct >= policy.daily_equity_drawdown_limit_pct ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "rolling_24h_loss_limit",
    "Rolling 24h realized loss limit",
    { loss_limit_usd: policy.rolling_24h_loss_limit_usd },
    { realized_pnl_usd: rolling24hPnlUsd },
    isBuy && rolling24hPnlUsd <= -Math.abs(policy.rolling_24h_loss_limit_usd) ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "maximum_position_size",
    "Maximum position size",
    { max_position_size_pct: policy.max_position_size_pct },
    { projected_position_size_pct: equityUsd > 0 ? round(projectedPositionValueUsd / equityUsd, 6) : 0, projected_position_value_usd: projectedPositionValueUsd },
    isBuy && equityUsd > 0 && projectedPositionValueUsd / equityUsd > policy.max_position_size_pct ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "maximum_token_exposure",
    "Maximum token exposure",
    { max_token_exposure_pct: policy.max_token_exposure_pct },
    { projected_token_exposure_pct: equityUsd > 0 ? round(projectedTokenExposureUsd / equityUsd, 6) : 0, projected_token_exposure_usd: projectedTokenExposureUsd },
    isBuy && equityUsd > 0 && projectedTokenExposureUsd / equityUsd > policy.max_token_exposure_pct ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "maximum_category_exposure",
    "Maximum category exposure",
    { max_category_exposure_pct: policy.max_category_exposure_pct, category },
    { projected_category_exposure_pct: equityUsd > 0 ? round(projectedCategoryExposureUsd / equityUsd, 6) : 0, projected_category_exposure_usd: projectedCategoryExposureUsd, category },
    isBuy && equityUsd > 0 && projectedCategoryExposureUsd / equityUsd > policy.max_category_exposure_pct ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "maximum_strategy_exposure",
    "Maximum strategy exposure",
    { max_strategy_exposure_pct: policy.max_strategy_exposure_pct, strategy_version: strategyVersion },
    { projected_strategy_exposure_pct: equityUsd > 0 ? round(projectedStrategyExposureUsd / equityUsd, 6) : 0, projected_strategy_exposure_usd: projectedStrategyExposureUsd, strategy_version: strategyVersion },
    isBuy && equityUsd > 0 && projectedStrategyExposureUsd / equityUsd > policy.max_strategy_exposure_pct ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "maximum_open_positions",
    "Maximum open positions",
    { max_open_positions: policy.max_open_positions },
    { projected_open_positions: projectedOpenPositions },
    isBuy && projectedOpenPositions > policy.max_open_positions ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "maximum_daily_turnover",
    "Maximum daily turnover",
    { max_daily_turnover_usd: policy.max_daily_turnover_usd },
    { projected_daily_turnover_usd: projectedDailyTurnoverUsd, current_daily_turnover_usd: dailyTurnoverUsd },
    isBuy && projectedDailyTurnoverUsd > policy.max_daily_turnover_usd ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "cooldown_after_stop_loss",
    "Cooldown after stop loss",
    { cooldown_hours: policy.cooldown_after_stop_loss_hours },
    stopLossCooldown,
    isBuy && stopLossCooldown.blocked ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "token_repeated_loss_block",
    "Block re-entry on tokens with repeated stop losses",
    {
      stop_loss_count_threshold: policy.token_repeated_loss_stop_count,
      window_days: policy.token_repeated_loss_window_days,
      cooldown_days: policy.token_repeated_loss_cooldown_days
    },
    tokenRepeatedLossBlock,
    isBuy && tokenRepeatedLossBlock.blocked ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "cooldown_after_strategy_loss_cluster",
    "Cooldown after strategy-level loss cluster",
    {
      loss_cluster_count: policy.strategy_loss_cluster_count,
      loss_cluster_loss_limit_usd: policy.strategy_loss_cluster_loss_limit_usd,
      cooldown_hours: policy.strategy_loss_cluster_cooldown_hours
    },
    strategyLossCluster,
    isBuy && strategyLossCluster.blocked ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "negative_expectancy_regime",
    "New-buy block during negative expectancy regimes",
    {
      min_samples: policy.negative_expectancy_min_samples,
      negative_rate_threshold: policy.negative_expectancy_negative_rate_threshold,
      min_expectancy_usd: policy.negative_expectancy_min_expectancy_usd
    },
    expectancyRegime,
    isBuy && expectancyRegime.blocked ? "block" : "pass"
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "minimum_liquidity_threshold",
    "Minimum liquidity threshold",
    { min_liquidity_usd: policy.min_liquidity_usd },
    { liquidity_usd: liquidityUsd },
    isBuy && liquidityUsd > 0 && liquidityUsd < policy.min_liquidity_usd ? "block" : (liquidityUsd <= 0 ? "warn" : "pass")
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "maximum_spread_slippage_threshold",
    "Maximum spread/slippage threshold",
    { max_spread_bps: policy.max_spread_bps, max_slippage_bps: policy.max_slippage_bps },
    { spread_bps: spreadBps, slippage_bps: slippageBps },
    isBuy && ((spreadBps > 0 && spreadBps > policy.max_spread_bps) || (slippageBps > 0 && slippageBps > policy.max_slippage_bps))
      ? "block"
      : ((spreadBps <= 0 || slippageBps <= 0) ? "warn" : "pass")
  ));
  addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
    "market_wide_risk_off_block",
    "Market-wide risk-off block",
    { block_when_risk_off: policy.market_risk_off_blocks_new_buys },
    { market_regime: marketRegime },
    isBuy && policy.market_risk_off_blocks_new_buys && marketRegime === "risk_off" ? "block" : "pass"
  ));

  if (capitalMandate) {
    const constraints = capitalMandate.constraints || {};
    const constraintValidation = validateMandateConstraintsAgainstPolicy(constraints, policy);
    addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
      "mandate_constraint_validation",
      "Capital mandate constraints tighten Risk policy",
      { must_not_relax_risk_policy: true },
      {
        mandate_id: capitalMandate.mandate_id,
        correlation_id: capitalMandate.correlation_id,
        errors: constraintValidation.errors
      },
      constraintValidation.valid ? "pass" : "block"
    ));

    const allowedSymbols = mandateList(constraints.allowed_symbols).map((value) => value.toLowerCase());
    const excludedSymbols = mandateList(constraints.excluded_symbols).map((value) => value.toLowerCase());
    const allowedAddresses = mandateList(constraints.allowed_contract_addresses, true);
    const excludedAddresses = mandateList(constraints.excluded_contract_addresses, true);
    const allowedCategories = mandateList(constraints.allowed_categories).map((value) => value.toLowerCase());
    const excludedCategories = mandateList(constraints.excluded_categories).map((value) => value.toLowerCase());
    const symbolKey = String(symbol || "").toLowerCase();
    const categoryKey = String(category || "").toLowerCase();

    addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
      "mandate_allowed_universe",
      "Capital mandate allowed universe",
      {
        allowed_symbols: allowedSymbols,
        allowed_contract_addresses: allowedAddresses,
        allowed_categories: allowedCategories
      },
      { symbol, contract_address: contractAddress, category },
      isBuy && (
        (allowedSymbols.length > 0 && !allowedSymbols.includes(symbolKey))
        || (allowedAddresses.length > 0 && !allowedAddresses.includes(contractAddress))
        || (allowedCategories.length > 0 && !allowedCategories.includes(categoryKey))
      ) ? "block" : "pass"
    ));
    addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
      "mandate_excluded_universe",
      "Capital mandate excluded universe",
      {
        excluded_symbols: excludedSymbols,
        excluded_contract_addresses: excludedAddresses,
        excluded_categories: excludedCategories
      },
      { symbol, contract_address: contractAddress, category },
      isBuy && (
        (symbolKey && excludedSymbols.includes(symbolKey))
        || (contractAddress && excludedAddresses.includes(contractAddress))
        || (categoryKey && excludedCategories.includes(categoryKey))
      ) ? "block" : "pass"
    ));

    const addMandateMax = (key, label, limitField, actualField, actualValue, limitValue) => {
      if (limitValue == null) return;
      const limitNum = toNum(limitValue, NaN);
      if (!Number.isFinite(limitNum)) return;
      addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
        key,
        label,
        { [limitField]: limitNum, mandate_id: capitalMandate.mandate_id },
        { [actualField]: actualValue },
        isBuy && actualValue > limitNum ? "block" : "pass"
      ));
    };
    const addMandateMin = (key, label, limitField, actualField, actualValue, limitValue) => {
      if (limitValue == null) return;
      const limitNum = toNum(limitValue, NaN);
      if (!Number.isFinite(limitNum)) return;
      addLimit(checked_limits, blockers, warnings, buildCheckedLimit(
        key,
        label,
        { [limitField]: limitNum, mandate_id: capitalMandate.mandate_id },
        { [actualField]: actualValue },
        isBuy && actualValue > 0 && actualValue < limitNum ? "block" : "pass"
      ));
    };

    addMandateMax("mandate_max_trade_notional", "Capital mandate max trade notional", "max_trade_notional_usd", "requested_notional_usd", requestedNotionalUsd, constraints.max_trade_notional_usd);
    addMandateMax("mandate_max_position_size", "Capital mandate max position size", "max_position_size_pct", "projected_position_size_pct", equityUsd > 0 ? round(projectedPositionValueUsd / equityUsd, 6) : 0, constraints.max_position_size_pct);
    addMandateMax("mandate_max_token_exposure", "Capital mandate max token exposure", "max_token_exposure_pct", "projected_token_exposure_pct", equityUsd > 0 ? round(projectedTokenExposureUsd / equityUsd, 6) : 0, constraints.max_token_exposure_pct);
    addMandateMax("mandate_max_category_exposure", "Capital mandate max category exposure", "max_category_exposure_pct", "projected_category_exposure_pct", equityUsd > 0 ? round(projectedCategoryExposureUsd / equityUsd, 6) : 0, constraints.max_category_exposure_pct);
    addMandateMax("mandate_max_strategy_exposure", "Capital mandate max strategy exposure", "max_strategy_exposure_pct", "projected_strategy_exposure_pct", equityUsd > 0 ? round(projectedStrategyExposureUsd / equityUsd, 6) : 0, constraints.max_strategy_exposure_pct);
    addMandateMax("mandate_max_open_positions", "Capital mandate max open positions", "max_open_positions", "projected_open_positions", projectedOpenPositions, constraints.max_open_positions);
    addMandateMax("mandate_max_daily_turnover", "Capital mandate max daily turnover", "max_daily_turnover_usd", "projected_daily_turnover_usd", projectedDailyTurnoverUsd, constraints.max_daily_turnover_usd);
    addMandateMin("mandate_min_liquidity", "Capital mandate minimum liquidity", "min_liquidity_usd", "liquidity_usd", liquidityUsd, constraints.min_liquidity_usd);
    addMandateMax("mandate_max_spread", "Capital mandate maximum spread", "max_spread_bps", "spread_bps", spreadBps, constraints.max_spread_bps);
    addMandateMax("mandate_max_slippage", "Capital mandate maximum slippage", "max_slippage_bps", "slippage_bps", slippageBps, constraints.max_slippage_bps);
  }

  const inputSnapshot = {
    policy_version: RISK_POLICY_VERSION,
    mode,
    enforcement_mode: cleanText(input?.enforcement_mode || "enforced"),
    evaluated_at: evaluationTs,
    side,
    symbol,
    contract_address: contractAddress,
    category,
    strategy_version: strategyVersion,
    evidence_packet_id: evidencePacketId,
    evidence_quality_score: evidenceQualityScore,
    evidence_ref_count: evidenceRefCount,
    evidence_blockers: evidenceBlockers,
    evidence_warnings: evidenceWarnings,
    capital_mandate: mandateTrace,
    requested_notional_usd: requestedNotionalUsd,
    liquidity_usd: liquidityUsd,
    spread_bps: spreadBps,
    slippage_bps: slippageBps,
    portfolio: {
      cash_usd: round(toNum(portfolio?.cash_usd, 0), 2),
      equity_usd: equityUsd,
      position_count: Object.keys(portfolio?.positions || {}).length,
      positions: Object.values(portfolio?.positions || {}).map((position) => ({
        symbol: cleanText(position?.symbol),
        contract_address: cleanAddress(position?.contract_address),
        category: cleanText(position?.category || "unknown"),
        strategy_version: cleanText(position?.strategy_version),
        market_value_usd: positionValueUsd(position)
      })).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
      daily_realized_pnl_usd: dailyRealizedPnlUsd,
      rolling_24h_pnl_usd: rolling24hPnlUsd,
      daily_turnover_usd: dailyTurnoverUsd,
      day_start_equity_usd: dayStartEquityUsd,
      market_regime: marketRegime
    },
    checked_limits
  };
  const inputSnapshotHash = sha256(stableStringify(inputSnapshot));
  const idBasis = {
    policy_version: RISK_POLICY_VERSION,
    input_snapshot_hash: inputSnapshotHash,
    order_id: cleanText(intent?.order_id),
    trade_id: cleanText(intent?.trade_id),
    source_trade_id: cleanText(intent?.source_trade_id),
    side,
    symbol,
    contract_address: contractAddress,
    requested_notional_usd: requestedNotionalUsd
  };
  const decision = blockers.length === 0 ? "allow" : "block";

  return {
    schema_version: RISK_ENGINE_SCHEMA_VERSION,
    risk_decision_id: `rsk_${sha256(stableStringify(idBasis)).slice(0, 32)}`,
    risk_decision_id_basis: "sha256(policy_version,input_snapshot_hash,order_id,trade_id,source_trade_id,side,symbol,contract_address,requested_notional_usd)",
    policy_version: RISK_POLICY_VERSION,
    input_snapshot_hash: inputSnapshotHash,
    evaluated_at: evaluationTs,
    mode,
    enforcement_mode: cleanText(input?.enforcement_mode || "enforced"),
    decision,
    reason_codes: [...new Set([...blockers, ...warnings])],
    blockers,
    warnings,
    checked_limits,
    order_id: cleanText(intent?.order_id),
    trade_id: cleanText(intent?.trade_id),
    source_trade_id: cleanText(intent?.source_trade_id),
    strategy_version: strategyVersion,
    setup_type: cleanText(intent?.setup_type || intent?.setup_label),
    side,
    symbol,
    contract_address: contractAddress,
    category,
    evidence_packet_id: evidencePacketId,
    evidence_quality_score: evidenceQualityScore,
    evidence_ref_count: evidenceRefCount,
    evidence_blockers: evidenceBlockers,
    evidence_warnings: evidenceWarnings,
    capital_mandate: mandateTrace,
    requested_notional_usd: requestedNotionalUsd,
    requested_quantity: round(toNum(intent?.requested_quantity, 0), 8),
    live_submission_enabled: false,
    live_submission_attempted: false,
    capital_mandate: mandateTrace,
    live_capability: liveCapability,
    risk_override: riskOverrideRecord,
    operator_permission: riskOverridePermission,
    summary: decision === "allow"
      ? "Risk engine allow decision."
      : `Risk engine blocked intent: ${blockers.join(", ")}`,
    audit: {
      equity_usd: equityUsd,
      day_start_equity_usd: dayStartEquityUsd,
      daily_realized_pnl_usd: dailyRealizedPnlUsd,
      rolling_24h_pnl_usd: rolling24hPnlUsd,
      daily_turnover_usd: dailyTurnoverUsd,
      market_regime: marketRegime
    }
  };
}
