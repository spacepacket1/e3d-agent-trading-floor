import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { buildMarketDataQuality, summarizeMarketDataQuality } from "./marketDataQuality.js";
import { recordOperatorAction } from "./auditTrail.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// cron invokes this script through the /Users/mini/e3d-agent-trading-floor symlink using its
// absolute path. __filename is realpath-resolved by the module loader, so a naive string compare
// against process.argv[1] (the symlinked path) never matches and the report never runs.
function isDirectlyInvoked() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === __filename;
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

const PORTFOLIO_FILE = path.join(ROOT, "portfolio.json");
const LOG_DIR = path.join(ROOT, "logs");
const REPORTS_DIR = path.join(ROOT, "reports");
const PIPELINE_LOG = path.join(LOG_DIR, "pipeline.jsonl");
const TRAINING_EVENT_LOG = path.join(LOG_DIR, "training-events.jsonl");
const WINDOWS = [
  { key: "6h", label: "6 hours", hours: 6 },
  { key: "24h", label: "24 hours", hours: 24 },
  { key: "48h", label: "48 hours", hours: 48 },
  { key: "7d", label: "7 days", hours: 24 * 7 },
  { key: "all_time", label: "All-time since reset", hours: null }
];
const BREAKDOWN_KEYS = [
  "symbol",
  "contract_address",
  "category",
  "setup_type",
  "story_type",
  "source_agent",
  "exit_reason",
  "market_regime",
  "risk_reason_code",
  "executor_decision",
  "trade_lifecycle"
];

function nowIso() {
  return new Date().toISOString();
}

function localDateStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}${parts.month}${parts.day}`;
}

function readJsonFile(filePath, fallback) {
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

function optionalDateMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function pct(value) {
  return round(value * 100, 2);
}

function median(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function normalizeKey(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function extractReasonRoot(reason) {
  const text = normalizeKey(reason);
  if (text.includes(":")) return text.split(":")[0] || "unknown";
  return text;
}

function classifyReason(reason) {
  const root = extractReasonRoot(reason).toLowerCase();
  if (root.startsWith("target_")) return "target";
  if (root.includes("stop")) return "stop_loss";
  if (root.includes("harvest")) return "harvest_exit";
  if (root.includes("rotation_out")) return "rotation_out";
  if (root.includes("non_tradeable") || root.includes("non-tradeable")) return "non_tradeable_force_exit";
  return root || "unknown";
}

function indexTrainingEvents(events) {
  const byTradeId = new Map();
  const byPositionId = new Map();
  const byCandidateId = new Map();
  const cycles = [];

  for (const event of events) {
    if (event?.trade_id) {
      if (!byTradeId.has(event.trade_id)) byTradeId.set(event.trade_id, []);
      byTradeId.get(event.trade_id).push(event);
    }
    if (event?.position_id) {
      if (!byPositionId.has(event.position_id)) byPositionId.set(event.position_id, []);
      byPositionId.get(event.position_id).push(event);
    }
    if (event?.candidate_id) {
      if (!byCandidateId.has(event.candidate_id)) byCandidateId.set(event.candidate_id, []);
      byCandidateId.get(event.candidate_id).push(event);
    }
    if (event?.event_type === "cycle_end" || event?.event_type === "cycle_start") {
      const tsMs = optionalDateMs(event.ts);
      if (tsMs != null) cycles.push({ tsMs, market_regime: event.market_regime || event.payload?.portfolio_snapshot?.market_regime || "unknown" });
    }
  }

  cycles.sort((a, b) => a.tsMs - b.tsMs);
  return { byTradeId, byPositionId, byCandidateId, cycles };
}

function latestCycleRegime(cycles, tsMs) {
  let regime = "unknown";
  for (const cycle of cycles) {
    if (cycle.tsMs > tsMs) break;
    regime = cycle.market_regime || regime;
  }
  return regime;
}

function latestEvent(events, predicate) {
  return [...events].reverse().find(predicate) || null;
}

function enrichTrade(trade, index) {
  const tradeEvents = index.byTradeId.get(trade.trade_id) || [];
  const positionEvents = index.byPositionId.get(trade.position_id) || [];
  const candidateEvents = index.byCandidateId.get(trade.candidate_id || trade.contract_address) || [];
  const related = [...candidateEvents, ...positionEvents, ...tradeEvents].sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  const riskEvent = latestEvent(related, (event) => event.event_type === "risk_decision");
  const executorEvent = latestEvent(related, (event) => event.event_type === "executor_decision");
  const candidateEvent = latestEvent(related, (event) => event.event_type === "candidate");
  const proposal = riskEvent?.payload?.proposal || executorEvent?.payload?.proposal || null;
  const token = proposal?.token || candidateEvent?.payload?.token || {};
  const evidence = Array.isArray(proposal?.evidence) ? proposal.evidence : [];
  const storyTypes = evidence
    .map((item) => typeof item === "object" ? item.type || item.story_type || item.category : null)
    .filter(Boolean);
  const riskCodes = riskEvent?.payload?.risk_review?.reason_codes || riskEvent?.payload?.risk_review?.blocker_list || [];
  const tsMs = optionalDateMs(trade.ts);
  const openedMs = optionalDateMs(trade.opened_at);
  const ticket = trade.paper_trade_ticket || {};

  return {
    ...trade,
    ts_ms: tsMs,
    opened_ms: openedMs,
    hold_time_hours: tsMs != null && openedMs != null ? Math.max(0, (tsMs - openedMs) / 3600000) : null,
    symbol: normalizeKey(trade.symbol || token.symbol),
    contract_address: normalizeKey(trade.contract_address || token.contract_address),
    category: normalizeKey(trade.category || token.category),
    setup_type: normalizeKey(proposal?.setup_type),
    story_types: storyTypes.length ? storyTypes : ["unknown"],
    source_agent: normalizeKey(proposal?.source_agent || ticket.source_agent || (String(trade.reason || "").startsWith("harvest") ? "harvest" : "unknown")),
    exit_reason: classifyReason(trade.reason),
    market_regime: normalizeKey(trade.market_regime || riskEvent?.market_regime || executorEvent?.market_regime || latestCycleRegime(index.cycles, tsMs || Date.now())),
    risk_reason_codes: Array.isArray(riskCodes) && riskCodes.length ? riskCodes.map((code) => normalizeKey(code)) : ["none"],
    executor_decision: normalizeKey(ticket.executor_decision || executorEvent?.payload?.decision || executorEvent?.payload?.review?.executor_decision || executorEvent?.payload?.review?.decision),
    trade_lifecycle: normalizeKey(trade.trade_lifecycle || (trade.side === "buy" ? "open" : "close"))
  };
}

function buildActionRecords(portfolio, closedTrades) {
  const actions = Array.isArray(portfolio.action_history) ? portfolio.action_history : [];
  const actionIds = new Set(actions.map((trade) => trade.trade_id).filter(Boolean));
  return [
    ...actions,
    ...closedTrades.filter((trade) => trade.trade_id && !actionIds.has(trade.trade_id))
  ];
}

function metricSummary(trades) {
  const closed = trades.filter((trade) => trade.side === "sell" && Number.isFinite(toNum(trade.pnl_usd, NaN)));
  const wins = closed.filter((trade) => toNum(trade.pnl_usd, 0) > 0);
  const losses = closed.filter((trade) => toNum(trade.pnl_usd, 0) < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + toNum(trade.pnl_usd, 0), 0);
  const grossLoss = losses.reduce((sum, trade) => sum + toNum(trade.pnl_usd, 0), 0);
  const realizedPnl = grossProfit + grossLoss;
  const avgWin = average(wins.map((trade) => toNum(trade.pnl_usd, 0))) ?? 0;
  const avgLoss = average(losses.map((trade) => toNum(trade.pnl_usd, 0))) ?? 0;
  const holdTimes = closed.map((trade) => trade.hold_time_hours).filter((value) => Number.isFinite(value));

  return {
    closed_trade_count: closed.length,
    winning_trade_count: wins.length,
    losing_trade_count: losses.length,
    win_rate: closed.length ? pct(wins.length / closed.length) : 0,
    realized_pnl_usd: round(realizedPnl),
    gross_profit_usd: round(grossProfit),
    gross_loss_usd: round(grossLoss),
    profit_factor: grossLoss < 0 ? round(grossProfit / Math.abs(grossLoss), 2) : (grossProfit > 0 ? null : 0),
    average_win_usd: round(avgWin),
    average_loss_usd: round(avgLoss),
    average_win_loss_ratio: avgLoss < 0 ? round(avgWin / Math.abs(avgLoss), 2) : null,
    maximum_closed_trade_loss_usd: losses.length ? round(Math.min(...losses.map((trade) => toNum(trade.pnl_usd, 0)))) : 0,
    median_hold_time_hours: median(holdTimes) == null ? null : round(median(holdTimes), 2),
    average_hold_time_hours: average(holdTimes) == null ? null : round(average(holdTimes), 2),
    target_hit_count: closed.filter((trade) => trade.exit_reason === "target").length,
    stop_loss_count: closed.filter((trade) => trade.exit_reason === "stop_loss").length,
    harvest_exit_count: closed.filter((trade) => trade.exit_reason === "harvest_exit").length,
    rotation_out_count: closed.filter((trade) => trade.exit_reason === "rotation_out").length,
    non_tradeable_force_exit_count: closed.filter((trade) => trade.exit_reason === "non_tradeable_force_exit").length
  };
}

function incrementBreakdown(groups, key, trade) {
  const groupKey = normalizeKey(key);
  if (!groups[groupKey]) groups[groupKey] = { key: groupKey, trades: [] };
  groups[groupKey].trades.push(trade);
}

function buildBreakdowns(trades) {
  const grouped = Object.fromEntries(BREAKDOWN_KEYS.map((key) => [key, {}]));
  for (const trade of trades) {
    incrementBreakdown(grouped.symbol, trade.symbol, trade);
    incrementBreakdown(grouped.contract_address, trade.contract_address, trade);
    incrementBreakdown(grouped.category, trade.category, trade);
    incrementBreakdown(grouped.setup_type, trade.setup_type, trade);
    for (const storyType of trade.story_types || ["unknown"]) incrementBreakdown(grouped.story_type, storyType, trade);
    incrementBreakdown(grouped.source_agent, trade.source_agent, trade);
    incrementBreakdown(grouped.exit_reason, trade.exit_reason, trade);
    incrementBreakdown(grouped.market_regime, trade.market_regime, trade);
    for (const code of trade.risk_reason_codes || ["none"]) incrementBreakdown(grouped.risk_reason_code, code, trade);
    incrementBreakdown(grouped.executor_decision, trade.executor_decision, trade);
    incrementBreakdown(grouped.trade_lifecycle, trade.trade_lifecycle, trade);
  }

  return Object.fromEntries(Object.entries(grouped).map(([dimension, values]) => [
    dimension,
    Object.values(values)
      .map((group) => ({ key: group.key, ...metricSummary(group.trades) }))
      .sort((a, b) => Math.abs(b.realized_pnl_usd) - Math.abs(a.realized_pnl_usd))
  ]));
}

function topGroups(breakdown, direction = "positive", limit = 5) {
  const groups = Array.isArray(breakdown) ? breakdown : [];
  const sorted = groups
    .filter((group) => group.closed_trade_count > 0)
    .filter((group) => direction === "positive" ? group.realized_pnl_usd > 0 : group.realized_pnl_usd < 0)
    .sort((a, b) => direction === "positive"
      ? b.realized_pnl_usd - a.realized_pnl_usd
      : a.realized_pnl_usd - b.realized_pnl_usd);
  return sorted.slice(0, limit).map((group) => ({
    key: group.key,
    trade_count: group.closed_trade_count,
    realized_pnl_usd: group.realized_pnl_usd,
    profit_factor: group.profit_factor,
    win_rate: group.win_rate
  }));
}

function buildWindow(window, trades, generatedAtMs) {
  const startMs = window.hours == null ? null : generatedAtMs - window.hours * 3600000;
  const filtered = startMs == null ? trades : trades.filter((trade) => trade.ts_ms != null && trade.ts_ms >= startMs);
  const breakdowns = buildBreakdowns(filtered);
  return {
    key: window.key,
    label: window.label,
    window_hours: window.hours,
    start_at: startMs == null ? null : new Date(startMs).toISOString(),
    end_at: new Date(generatedAtMs).toISOString(),
    metrics: metricSummary(filtered),
    breakdowns,
    top_positive_setups: topGroups(breakdowns.setup_type, "positive"),
    top_negative_setups: topGroups(breakdowns.setup_type, "negative"),
    top_loss_reasons: topGroups(breakdowns.exit_reason, "negative")
  };
}

function buildRecommendation(window24h, window7d) {
  const metrics24 = window24h?.metrics || {};
  const metrics7d = window7d?.metrics || {};
  const reasons = [];
  if ((metrics24.closed_trade_count || 0) < 10) reasons.push("24h closed-trade sample is below the retraining threshold.");
  if ((metrics7d.closed_trade_count || 0) < 50) reasons.push("7d closed-trade sample is below the retraining threshold.");
  if ((metrics24.profit_factor || 0) < 1 && (metrics24.win_rate || 0) >= 60) {
    reasons.push("High win rate is not yet translating into positive expectancy.");
  }
  if (!reasons.length) reasons.push("Daily scorecard is measurement-only in Phase 1; retraining remains evidence-gated.");
  return {
    recommendation: "hold",
    reasons
  };
}

function appendPerformanceEvent(report, compactWindow) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const payload = {
    window_hours: compactWindow.window_hours,
    trade_count: compactWindow.metrics.closed_trade_count,
    win_rate: compactWindow.metrics.win_rate,
    realized_pnl_usd: compactWindow.metrics.realized_pnl_usd,
    profit_factor: compactWindow.metrics.profit_factor,
    top_positive_setups: compactWindow.top_positive_setups,
    top_negative_setups: compactWindow.top_negative_setups,
    retraining_recommendation: report.retraining.recommendation,
    report_file: report.report_file
  };
  const record = {
    event_id: crypto.randomUUID(),
    schema_version: "1.0",
    ts: report.generated_at,
    event_type: "performance_scorecard",
    actor: "manager",
    pipeline_run_id: null,
    cycle_id: null,
    cycle_index: -1,
    market_regime: report.portfolio_snapshot.market_regime || "unknown",
    candidate_id: null,
    position_id: null,
    trade_id: null,
    payload
  };
  fs.appendFileSync(TRAINING_EVENT_LOG, `${JSON.stringify(record)}\n`);
}

function markdownReport(report) {
  const w24 = report.windows["24h"];
  const all = report.windows.all_time;
  const lines = [
    `# Daily Performance Scorecard - ${report.report_date}`,
    "",
    `Generated: ${report.generated_at}`,
    `Recommendation: ${report.retraining.recommendation}`,
    "",
    "## 24 Hour Summary",
    "",
    `- Closed trades: ${w24.metrics.closed_trade_count}`,
    `- Win rate: ${w24.metrics.win_rate}%`,
    `- Realized PnL: $${w24.metrics.realized_pnl_usd}`,
    `- Profit factor: ${w24.metrics.profit_factor ?? "n/a"}`,
    `- Average win / loss: $${w24.metrics.average_win_usd} / $${w24.metrics.average_loss_usd}`,
    `- Max closed-trade loss: $${w24.metrics.maximum_closed_trade_loss_usd}`,
    "",
    "## All-Time Since Reset",
    "",
    `- Closed trades: ${all.metrics.closed_trade_count}`,
    `- Win rate: ${all.metrics.win_rate}%`,
    `- Realized PnL: $${all.metrics.realized_pnl_usd}`,
    `- Profit factor: ${all.metrics.profit_factor ?? "n/a"}`,
    "",
    "## Top Loss Reasons",
    "",
    ...(w24.top_loss_reasons.length
      ? w24.top_loss_reasons.map((item) => `- ${item.key}: $${item.realized_pnl_usd} across ${item.trade_count} trades`)
      : ["- none"]),
    "",
    "## Retraining Gate",
    "",
    ...report.retraining.reasons.map((reason) => `- ${reason}`)
  ];
  return `${lines.join("\n")}\n`;
}

export function generateDailyPerformanceReport(options = {}) {
  const generatedAt = options.generatedAt || nowIso();
  const generatedAtMs = optionalDateMs(generatedAt) || Date.now();
  const reportDate = options.reportDate || localDateStamp(new Date(generatedAtMs));
  const portfolio = readJsonFile(options.portfolioFile || PORTFOLIO_FILE, {});
  const trainingEvents = readJsonLines(options.trainingEventLog || TRAINING_EVENT_LOG);
  readJsonLines(options.pipelineLog || PIPELINE_LOG);
  const closedTrades = Array.isArray(portfolio.closed_trades) ? portfolio.closed_trades : [];
  const allActions = buildActionRecords(portfolio, closedTrades);
  const index = indexTrainingEvents(trainingEvents);
  const enrichedTrades = allActions.map((trade) => enrichTrade(trade, index)).filter((trade) => trade.ts_ms != null);
  const marketDataQuality = summarizeMarketDataQuality(allActions.map((trade) => buildMarketDataQuality(trade, { evaluated_at: trade.ts })));
  const windows = Object.fromEntries(WINDOWS.map((window) => [window.key, buildWindow(window, enrichedTrades, generatedAtMs)]));
  const retraining = buildRecommendation(windows["24h"], windows["7d"]);
  const reportFile = `reports/performance-daily-${reportDate}.json`;
  const markdownFile = `reports/performance-daily-${reportDate}.md`;
  const report = {
    report_id: `performance-daily-${reportDate}`,
    report_type: "daily_performance",
    report_date: reportDate,
    generated_at: generatedAt,
    report_file: reportFile,
    markdown_file: markdownFile,
    data_sources: {
      portfolio_json: "portfolio.json",
      pipeline_jsonl: "logs/pipeline.jsonl",
      training_events_jsonl: "logs/training-events.jsonl"
    },
    portfolio_snapshot: {
      cash_usd: round(toNum(portfolio.cash_usd, 0)),
      realized_pnl_usd: round(toNum(portfolio.stats?.realized_pnl_usd, 0)),
      unrealized_pnl_usd: round(toNum(portfolio.stats?.unrealized_pnl_usd, 0)),
      equity_usd: round(toNum(portfolio.stats?.equity_usd, 0)),
      market_regime: portfolio.stats?.market_regime || "unknown",
      open_positions: Object.keys(portfolio.positions || {}).length
    },
    market_data_quality: marketDataQuality,
    windows,
    retraining
  };

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ROOT, reportFile), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(ROOT, markdownFile), markdownReport(report));
  if (options.appendEvent !== false) {
    appendPerformanceEvent(report, windows["24h"]);
    recordOperatorAction({
      action_type: "report_generation",
      ts: generatedAt,
      actor: options.actor || "performance_daily",
      role: options.role || "viewer",
      reason: options.reason || "generated daily performance report",
      resource: "performance_report",
      new_state: {
        report_id: report.report_id,
        report_file: report.report_file,
        markdown_file: report.markdown_file,
        report_date: report.report_date
      },
      report_id: report.report_id,
      metadata: {
        retraining_recommendation: report.retraining.recommendation,
        live_submission_enabled: false
      }
    });
  }
  return report;
}

function parseArgs(argv) {
  return {
    appendEvent: !argv.includes("--no-append-event"),
    generatedAt: argv.find((arg) => arg.startsWith("--generated-at="))?.slice("--generated-at=".length) || null,
    reportDate: argv.find((arg) => arg.startsWith("--date="))?.slice("--date=".length) || null
  };
}

if (isDirectlyInvoked()) {
  const report = generateDailyPerformanceReport(parseArgs(process.argv.slice(2)));
  const w24 = report.windows["24h"].metrics;
  console.log(JSON.stringify({
    report_file: report.report_file,
    markdown_file: report.markdown_file,
    window_hours: 24,
    trade_count: w24.closed_trade_count,
    win_rate: w24.win_rate,
    realized_pnl_usd: w24.realized_pnl_usd,
    profit_factor: w24.profit_factor,
    retraining_recommendation: report.retraining.recommendation
  }, null, 2));
}
