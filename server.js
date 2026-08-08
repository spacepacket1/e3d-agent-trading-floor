import fs from "fs";
import http from "http";
import path from "path";
import os from "os";
import crypto from "crypto";
import readline from "readline";
import { fileURLToPath } from "url";
import { execFileSync, spawn } from "child_process";
import {
  clearStoredAuth,
  connectWithApiKey,
  connectWithLogin,
  e3dRequest,
  getAuthStatus
} from "./e3dAuthClient.js";
import { evaluateLiveCapabilityStatus } from "./scripts/custodyControls.js";
import { generateOperationsMonitorReport } from "./scripts/operationsMonitor.js";
import { resolveRiskPolicy } from "./scripts/riskEngine.js";
import { buildOperatorPermissionPolicy, readOperatorActionRecords, recordOperatorAction } from "./scripts/auditTrail.js";
import { buildLiveReadinessActivationSummary, inspectPromotionConfirmation } from "./scripts/liveReadiness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IS_MAIN_MODULE = process.argv[1] ? path.resolve(process.argv[1]) === __filename : false;

// Load .env file from project root if present — simple key=value parser, no npm package needed.
try {
  const envFile = path.join(__dirname, ".env");
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch (_) {}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DASHBOARD_DIR = path.join(ROOT, "dashboard");
const LOG_DIR = path.join(ROOT, "logs");
const REPORTS_DIR = path.join(ROOT, "reports");
const BACKTEST_REPORTS_DIR = path.join(REPORTS_DIR, "backtests");
const PROMOTION_REPORTS_DIR = path.join(REPORTS_DIR, "promotions");
const ATTRIBUTION_REPORTS_DIR = path.join(REPORTS_DIR, "attribution");
const OPERATIONS_REPORTS_DIR = path.join(REPORTS_DIR, "operations");
const INCIDENTS_DIR = path.join(REPORTS_DIR, "incidents");
const RECONCILIATION_REPORTS_DIR = path.join(REPORTS_DIR, "reconciliation");
const PORTFOLIO_FILE = path.join(ROOT, "portfolio.json");
const PIPELINE_LOG = path.join(LOG_DIR, "pipeline.jsonl");
const TRAINING_EVENT_LOG = path.join(LOG_DIR, "training-events.jsonl");
const TRADE_REVIEWS_LOG = path.join(LOG_DIR, "trade-reviews.jsonl");
const RUN_LEDGER_LOG = path.join(LOG_DIR, "run-ledger.jsonl");
const DASHBOARD_HEARTBEAT_FILE = path.join(LOG_DIR, "dashboard-heartbeat.json");
const RETRAINING_READINESS_FILE = path.join(REPORTS_DIR, "retraining-readiness.json");
const ACTIVE_PIPELINE_STRATEGY_VERSION = process.env.E3D_STRATEGY_VERSION || "paper-pipeline-v1";
const DEFAULT_LIVE_PROMOTION_TARGET_STATE = "tiny_live";
const MONGO_CONTAINER_NAME = process.env.E3D_MONGO_CONTAINER || "e3d-mongo";
const MONGO_DATABASE_NAME = process.env.E3D_MONGO_DATABASE || "e3d";
const CLICKHOUSE_HTTP_URL = process.env.AWS_E3D_CLICKHOUSE_HTTP_URL || process.env.E3D_CLICKHOUSE_HTTP_URL || "http://127.0.0.1:8123";
const CLICKHOUSE_DATABASE_NAME = process.env.AWS_E3D_CLICKHOUSE_DATABASE || process.env.E3D_CLICKHOUSE_DATABASE || "e3d";
const CLICKHOUSE_TABLE_NAME = process.env.E3D_CLICKHOUSE_TABLE || "training_events";
const CLICKHOUSE_USER = process.env.AWS_E3D_CLICKHOUSE_USER || process.env.E3D_CLICKHOUSE_USER || "";
const CLICKHOUSE_PASSWORD = process.env.AWS_E3D_CLICKHOUSE_PASSWORD || process.env.E3D_CLICKHOUSE_PASSWORD || "";
const TOKEN_METADATA_CACHE = new Map();
const TOKEN_METADATA_TTL_MS = 6 * 60 * 60 * 1000;
const PIPELINE_ENTRYPOINT = path.join(ROOT, "pipeline.js");
const PIPELINE_PID_FILE = path.join(LOG_DIR, "pipeline.pid");
const PIPELINE_STDOUT_LOG = path.join(LOG_DIR, "pipeline-stdout.log");
const PIPELINE_STDERR_LOG = path.join(LOG_DIR, "pipeline-stderr.log");
const DEFAULT_INITIAL_CASH_USD = 100000;
const DEFAULT_PORTFOLIO_STATE = {
  cash_usd: DEFAULT_INITIAL_CASH_USD,
  positions: {},
  closed_trades: [],
  action_history: [],
  cooldowns: {},
  stats: {
    realized_pnl_usd: 0,
    unrealized_pnl_usd: 0,
    equity_usd: DEFAULT_INITIAL_CASH_USD,
    peak_equity_usd: DEFAULT_INITIAL_CASH_USD,
    max_drawdown_pct: 0,
    market_regime: "unknown"
  }
};
let pipelineProcess = null;
let _pipelineRestartTimer = null;
let pipelineState = {
  running: false,
  pid: null,
  mode: "stopped",
  interval_seconds: null,
  started_at: null,
  stop_requested_at: null,
  exit_code: null,
  signal: null,
  last_error: null
};

// ── PID file helpers ──────────────────────────────────────────────────────────

function writePidFile(pid) {
  try { fs.writeFileSync(PIPELINE_PID_FILE, String(pid), "utf8"); } catch {}
}

function clearPidFile() {
  try { fs.unlinkSync(PIPELINE_PID_FILE); } catch {}
}

function readPidFile() {
  try {
    const n = parseInt(fs.readFileSync(PIPELINE_PID_FILE, "utf8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killProcessGroup(pid, signal = "SIGTERM") {
  if (!pid || !Number.isFinite(pid)) return false;

  const attempts = [
    () => process.kill(-pid, signal),
    () => process.kill(pid, signal)
  ];

  for (const attempt of attempts) {
    try {
      attempt();
      return true;
    } catch {
    }
  }

  return false;
}

// Poll until an externally-spawned pipeline (recovered after server restart) exits.
let _recoveryPollTimer = null;
function watchExternalPipeline(pid) {
  clearInterval(_recoveryPollTimer);
  _recoveryPollTimer = setInterval(() => {
    if (!isProcessAlive(pid)) {
      clearInterval(_recoveryPollTimer);
      _recoveryPollTimer = null;
      clearPidFile();
      if (pipelineState.pid === pid) {
        setPipelineState({ running: false, pid: null, mode: "stopped" });
        wsBroadcast({ type: "pipeline_status", status: getPipelineStatus() });
      }
    }
  }, 5000);
}

// Called once at startup — reattach to a pipeline that survived a server restart.
function recoverPipelineIfRunning() {
  const pid = readPidFile();
  if (!pid || !isProcessAlive(pid)) {
    clearPidFile();
    return false;
  }
  setPipelineState({ running: true, pid, mode: "loop", started_at: null, last_error: null });
  watchExternalPipeline(pid);
  console.log(`[server] Recovered running pipeline PID ${pid}`);
  return true;
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readReportFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listReportFiles() {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return [];
    return fs.readdirSync(REPORTS_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(REPORTS_DIR, name))
      .map((filePath) => ({ filePath, report: readReportFile(filePath) }))
      .filter(({ report }) => report && report.report_id)
      .filter(({ report }) => report.report_type !== "daily_performance")
      .sort((a, b) => String(b.report.generated_at || "").localeCompare(String(a.report.generated_at || "")));
  } catch {
    return [];
  }
}

function listPerformanceReportFiles() {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return [];
    return fs.readdirSync(REPORTS_DIR)
      .filter((name) => /^performance-daily-\d{8}\.json$/.test(name))
      .map((name) => path.join(REPORTS_DIR, name))
      .map((filePath) => ({ filePath, report: readReportFile(filePath) }))
      .filter(({ report }) => report?.report_type === "daily_performance")
      .sort((a, b) => String(b.report.generated_at || "").localeCompare(String(a.report.generated_at || "")));
  } catch {
    return [];
  }
}

function listBacktestReportFiles() {
  try {
    if (!fs.existsSync(BACKTEST_REPORTS_DIR)) return [];
    return fs.readdirSync(BACKTEST_REPORTS_DIR)
      .filter((name) => /^backtest-\d{8}-\d{6}\.json$/.test(name))
      .map((name) => path.join(BACKTEST_REPORTS_DIR, name))
      .map((filePath) => ({ filePath, report: readReportFile(filePath) }))
      .filter(({ report }) => report?.report_type === "backtest_replay")
      .sort((a, b) => String(b.report.generated_at || "").localeCompare(String(a.report.generated_at || "")));
  } catch {
    return [];
  }
}

function listPromotionReportFiles() {
  try {
    if (!fs.existsSync(PROMOTION_REPORTS_DIR)) return [];
    return fs.readdirSync(PROMOTION_REPORTS_DIR)
      .filter((name) => /^promotion-\d{8}-\d{6}\.json$/.test(name))
      .map((name) => path.join(PROMOTION_REPORTS_DIR, name))
      .map((filePath) => ({ filePath, report: readReportFile(filePath) }))
      .filter(({ report }) => report?.report_type === "strategy_promotion_gate")
      .sort((a, b) => String(b.report.generated_at || "").localeCompare(String(a.report.generated_at || "")));
  } catch {
    return [];
  }
}

function listAttributionReportFiles() {
  try {
    if (!fs.existsSync(ATTRIBUTION_REPORTS_DIR)) return [];
    return fs.readdirSync(ATTRIBUTION_REPORTS_DIR)
      .filter((name) => /^signal-attribution-\d{8}-\d{6}\.json$/.test(name))
      .map((name) => path.join(ATTRIBUTION_REPORTS_DIR, name))
      .map((filePath) => ({ filePath, report: readReportFile(filePath) }))
      .filter(({ report }) => report?.report_type === "signal_attribution_expectancy")
      .sort((a, b) => String(b.report.generated_at || "").localeCompare(String(a.report.generated_at || "")));
  } catch {
    return [];
  }
}

function listOperationsReportFiles() {
  try {
    if (!fs.existsSync(OPERATIONS_REPORTS_DIR)) return [];
    return fs.readdirSync(OPERATIONS_REPORTS_DIR)
      .filter((name) => /^operations-\d{8}-\d{6}\.json$/.test(name))
      .map((name) => path.join(OPERATIONS_REPORTS_DIR, name))
      .map((filePath) => ({ filePath, report: readReportFile(filePath) }))
      .filter(({ report }) => report?.report_type === "operations_monitor")
      .sort((a, b) => String(b.report.generated_at || "").localeCompare(String(a.report.generated_at || "")));
  } catch {
    return [];
  }
}

function listReconciliationReportFiles() {
  try {
    if (!fs.existsSync(RECONCILIATION_REPORTS_DIR)) return [];
    return fs.readdirSync(RECONCILIATION_REPORTS_DIR)
      .filter((name) => /^reconciliation-\d{8}-\d{6}\.json$/.test(name))
      .map((name) => path.join(RECONCILIATION_REPORTS_DIR, name))
      .map((filePath) => ({ filePath, report: readReportFile(filePath) }))
      .filter(({ report }) => report?.report_type === "reconciliation_accounting")
      .sort((a, b) => String(b.report.generated_at || "").localeCompare(String(a.report.generated_at || "")));
  } catch {
    return [];
  }
}

function listIncidentFiles() {
  try {
    if (!fs.existsSync(INCIDENTS_DIR)) return [];
    return fs.readdirSync(INCIDENTS_DIR)
      .filter((name) => /^incident-[a-f0-9]{16}\.json$/.test(name))
      .map((name) => path.join(INCIDENTS_DIR, name))
      .map((filePath) => ({ filePath, report: readReportFile(filePath) }))
      .filter(({ report }) => report?.incident_id)
      .sort((a, b) => String(b.report.latest_observed_at || b.report.start_time || "").localeCompare(String(a.report.latest_observed_at || a.report.start_time || "")));
  } catch {
    return [];
  }
}

function summarizePerformanceReport(report) {
  const window24h = report?.windows?.["24h"] || {};
  const metrics = window24h.metrics || {};
  return {
    report_id: report?.report_id || null,
    report_date: report?.report_date || null,
    generated_at: report?.generated_at || null,
    report_file: report?.report_file || null,
    markdown_file: report?.markdown_file || null,
    window_hours: 24,
    trade_count: metrics.closed_trade_count || 0,
    win_rate: metrics.win_rate || 0,
    realized_pnl_usd: metrics.realized_pnl_usd || 0,
    profit_factor: metrics.profit_factor ?? null,
    market_data_quality: report?.market_data_quality || null,
    top_loss_reasons: Array.isArray(window24h.top_loss_reasons) ? window24h.top_loss_reasons.slice(0, 5) : [],
    retraining_recommendation: report?.retraining?.recommendation || "hold"
  };
}

function summarizePromotionReport(report) {
  const confirmation = inspectPromotionConfirmation(report);
  return {
    report_id: report?.report_id || null,
    generated_at: report?.generated_at || null,
    strategy_version: report?.strategy_version || null,
    target_state: report?.target_state || null,
    promotion_decision: report?.promotion_decision || "blocked",
    promotion_allowed: Boolean(report?.promotion_allowed),
    blocker_count: Array.isArray(report?.blockers) ? report.blockers.length : 0,
    warning_count: Array.isArray(report?.warnings) ? report.warnings.length : 0,
    closed_trade_count: report?.evidence?.sample_size?.closed_trade_count ?? null,
    profit_factor: report?.evidence?.performance?.profit_factor ?? null,
    expectancy_usd: report?.evidence?.performance?.expectancy_usd ?? null,
    max_drawdown_pct: report?.evidence?.performance?.max_drawdown_pct ?? null,
    signed: Boolean(report?.signed),
    signature: report?.signature || null,
    readiness: confirmation.readiness || report?.readiness || null,
    threshold_cycle: confirmation.threshold_cycle || report?.readiness?.threshold_cycle || null,
    signed_report_identity: confirmation.signed_report_identity || {
      report_id: report?.report_id || null,
      generated_at: report?.generated_at || null,
      signed_report_marker: report?.signed_report_marker || report?.signed_payload?.signed_report_marker || null,
      strategy_version: report?.strategy_version || null
    },
    signed_timestamp: confirmation.signed_timestamp || report?.signed_payload?.generated_at || null,
    envelope_match: confirmation.envelope_match,
    signature_verification: confirmation.signature_state ? {
      signature_verified: confirmation.signature_verified,
      signature_state: confirmation.signature_state,
      claim_source: confirmation.claim_source
    } : null,
    live_capability: report?.live_capability ? {
      capability_status: report.live_capability.capability_status,
      live_submission_enabled: Boolean(report.live_capability.live_submission_enabled),
      blocker_count: Array.isArray(report.live_capability.blockers) ? report.live_capability.blockers.length : 0,
      blockers: Array.isArray(report.live_capability.blockers) ? report.live_capability.blockers.slice(0, 8) : []
    } : null,
    report_file: report?.report_file || null,
    markdown_file: report?.markdown_file || null
  };
}

function resolveReadinessStrategyVersion(searchParams) {
  const values = searchParams.getAll("strategy_version");
  if (!values.length) {
    return { strategyVersion: ACTIVE_PIPELINE_STRATEGY_VERSION };
  }
  if (values.length !== 1) {
    return {
      error: {
        code: "INVALID_STRATEGY_VERSION",
        detail: "strategy_version must be supplied at most once and as a non-empty string."
      }
    };
  }
  const strategyVersion = String(values[0] || "").trim();
  if (!strategyVersion) {
    return {
      error: {
        code: "INVALID_STRATEGY_VERSION",
        detail: "strategy_version must be a non-empty string."
      }
    };
  }
  return { strategyVersion };
}

function buildReadinessApiResponse(options = {}) {
  return buildLiveReadinessActivationSummary({
    strategyVersion: options.strategyVersion || ACTIVE_PIPELINE_STRATEGY_VERSION,
    readinessReportsDir: options.readinessReportsDir || REPORTS_DIR,
    promotionReportsDir: options.promotionReportsDir || PROMOTION_REPORTS_DIR,
    readinessReports: options.readinessReports,
    promotionReports: options.promotionReports,
    readiness: options.readiness,
    activation: options.activation,
    targetState: options.targetState || DEFAULT_LIVE_PROMOTION_TARGET_STATE,
    policy: options.policy
  });
}

function summarizeBacktestReport(report) {
  const metrics = report?.metrics || {};
  const performance = report?.performance || {};
  const executionQuality = report?.execution_quality || {};
  const executionControls = report?.execution_controls || {};
  const marketDataQuality = report?.market_data_quality || {};
  return {
    report_id: report?.report_id || null,
    generated_at: report?.generated_at || null,
    strategy_version: report?.strategy_version || null,
    seed: report?.seed || null,
    report_file: report?.report_file || null,
    markdown_file: report?.markdown_file || null,
    window: report?.window || null,
    order_count: report?.replay?.order_count ?? (Array.isArray(report?.replay?.orders) ? report.replay.orders.length : null),
    total_return_pct: metrics.total_return_pct ?? null,
    realized_pnl_usd: metrics.realized_pnl_usd ?? null,
    unrealized_pnl_usd: metrics.unrealized_pnl_usd ?? null,
    profit_factor: metrics.profit_factor ?? null,
    max_drawdown_pct: metrics.max_drawdown_pct ?? null,
    win_rate_pct: metrics.win_rate_pct ?? null,
    turnover_usd: metrics.turnover_usd ?? null,
    fee_slippage_drag_usd: metrics.fee_slippage_drag_usd ?? null,
    before_execution_costs: performance.before_execution_costs || null,
    after_execution_costs: performance.after_execution_costs || null,
    execution_cost_impact: performance.cost_impact || null,
    execution_quality: {
      model_version: executionQuality.model_version || report?.execution_model_version || null,
      fill_ratio: executionQuality.fill_ratio ?? null,
      rejection_ratio: executionQuality.rejection_ratio ?? null,
      partial_fill_count: executionQuality.partial_fill_count ?? null,
      average_slippage_bps: executionQuality.average_slippage_bps ?? null,
      average_fee_bps: executionQuality.average_fee_bps ?? null,
      average_time_to_fill_ms: executionQuality.average_time_to_fill_ms ?? null
    },
    execution_controls: {
      model_version: executionControls.model_version || null,
      control_count: executionControls.control_count ?? null,
      quote_count: executionControls.quote_count ?? null,
      by_route_feasibility: executionControls.by_route_feasibility || null,
      by_quote_quality: executionControls.by_quote_quality || null,
      by_liquidity_depth_bucket: executionControls.by_liquidity_depth_bucket || null,
      average_gas_bps: executionControls.average_gas_bps ?? null,
      average_mev_risk_bps: executionControls.average_mev_risk_bps ?? null,
      top_warnings: Array.isArray(executionControls.top_warnings) ? executionControls.top_warnings.slice(0, 5) : []
    },
    market_data_quality: {
      snapshot_count: marketDataQuality.snapshot_count ?? null,
      degraded_count: marketDataQuality.degraded_count ?? null,
      stale_count: marketDataQuality.stale_count ?? null,
      blocker_count: marketDataQuality.blocker_count ?? null,
      warning_count: marketDataQuality.warning_count ?? null,
      average_confidence: marketDataQuality.average_confidence ?? null,
      top_warnings: Array.isArray(marketDataQuality.top_warnings) ? marketDataQuality.top_warnings.slice(0, 5) : [],
      top_blockers: Array.isArray(marketDataQuality.top_blockers) ? marketDataQuality.top_blockers.slice(0, 5) : []
    },
    baselines: report?.baselines || null,
    portfolio_json_mutated: Boolean(report?.safety?.portfolio_json_mutated)
  };
}

function summarizeAttributionReport(report) {
  const summary = report?.summary || {};
  const decisionSummary = report?.decision_summary || {};
  return {
    report_id: report?.report_id || null,
    generated_at: report?.generated_at || null,
    report_file: report?.report_file || null,
    markdown_file: report?.markdown_file || null,
    realized_trade_count: summary.realized_trade_count ?? null,
    reviewed_trade_count: summary.reviewed_trade_count ?? null,
    win_rate_pct: summary.win_rate_pct ?? null,
    expectancy_usd: summary.expectancy_usd ?? null,
    realized_pnl_usd: summary.realized_pnl_usd ?? null,
    fee_slippage_drag_usd: summary.fee_slippage_drag_usd ?? null,
    no_trade_decision_count: summary.no_trade_decision_count ?? null,
    missed_opportunity_count: summary.missed_opportunity_count ?? null,
    negative_expectancy_group_count: summary.negative_expectancy_group_count ?? null,
    top_positive_setups: Array.isArray(summary.top_positive_setups) ? summary.top_positive_setups.slice(0, 5) : [],
    top_negative_setups: Array.isArray(summary.top_negative_setups) ? summary.top_negative_setups.slice(0, 5) : [],
    candidate_count: decisionSummary.candidate_count ?? null
  };
}

function summarizeOperationsReport(report) {
  return {
    report_id: report?.report_id || null,
    generated_at: report?.generated_at || null,
    overall_status: report?.overall_status || "unknown",
    active_alert_count: report?.alerts?.active_count ?? 0,
    active_incident_count: report?.incidents?.active_count ?? 0,
    pipeline_status: report?.health?.pipeline?.status || "unknown",
    dashboard_status: report?.health?.dashboard?.status || "unknown",
    order_queue_status: report?.health?.order_queue?.status || "unknown",
    report_file: report?.report_file || null,
    markdown_file: report?.markdown_file || null
  };
}

function summarizeReconciliationReport(report) {
  return {
    report_id: report?.report_id || null,
    generated_at: report?.generated_at || null,
    status: report?.status || "unknown",
    live_trading_blocked: Boolean(report?.live_trading_blocked),
    issue_count: Array.isArray(report?.issues) ? report.issues.length : 0,
    critical_issue_count: Array.isArray(report?.issues) ? report.issues.filter((issue) => issue.severity === "critical").length : 0,
    paper_status: report?.reconciliation?.paper?.status || null,
    replay_status: report?.reconciliation?.replay?.status || null,
    paper_cash_delta_usd: report?.reconciliation?.paper?.cash?.delta_usd ?? null,
    replay_cash_delta_usd: report?.reconciliation?.replay?.cash?.delta_usd ?? null,
    tax_lot_export: report?.tax_lot_export || null,
    report_file: report?.report_file || null,
    markdown_file: report?.markdown_file || null
  };
}

function listTradeReviews() {
  return readJsonLines(TRADE_REVIEWS_LOG, 5000)
    .sort((a, b) => String(b.reviewed_at || "").localeCompare(String(a.reviewed_at || "")));
}

function indexTradeReviews() {
  const map = new Map();
  for (const review of listTradeReviews()) {
    if (review?.trade_id && !map.has(review.trade_id)) map.set(review.trade_id, review);
  }
  return map;
}

function latestTrainingEvent(eventType) {
  const events = readJsonLines(TRAINING_EVENT_LOG, 2000);
  return [...events].reverse().find((event) => event.event_type === eventType) || null;
}

function summarizeOperationsLatest() {
  const regime = latestTrainingEvent("regime_policy");
  const sizing = latestTrainingEvent("position_sizing_decision");
  const signal = latestTrainingEvent("signal_snapshot");
  const arbitrage = latestTrainingEvent("arbitrage_signal");
  return {
    regime_policy: regime?.payload?.policy || regime?.payload || null,
    latest_sizing_decision: sizing?.payload?.decision || null,
    latest_signal_snapshot: signal?.payload || null,
    latest_arbitrage_signal: arbitrage?.payload || null,
    generated_at: regime?.ts || sizing?.ts || signal?.ts || arbitrage?.ts || null
  };
}

function latestPerformanceReport() {
  return listPerformanceReportFiles()[0]?.report || null;
}

function latestBacktestReport() {
  return listBacktestReportFiles()[0]?.report || null;
}

function latestPromotionReport() {
  return listPromotionReportFiles()[0]?.report || null;
}

function latestAttributionReport() {
  return listAttributionReportFiles()[0]?.report || null;
}

function latestOperationsReport() {
  return listOperationsReportFiles()[0]?.report || null;
}

function latestReconciliationReport() {
  return listReconciliationReportFiles()[0]?.report || null;
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundTo(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function averageFinite(values, digits = 2) {
  const nums = (Array.isArray(values) ? values : []).map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return roundTo(nums.reduce((sum, value) => sum + value, 0) / nums.length, digits);
}

function positionValueUsd(position = {}) {
  return roundTo(toFiniteNumber(
    position?.market_value_usd,
    toFiniteNumber(position?.current_value_usd, toFiniteNumber(position?.cost_basis_usd, 0))
  ), 2);
}

function computePortfolioEquityUsd(portfolio = {}) {
  const positions = Object.values(portfolio?.positions || {});
  const marketValueUsd = positions.reduce((sum, position) => sum + positionValueUsd(position), 0);
  return roundTo(toFiniteNumber(portfolio?.cash_usd, 0) + marketValueUsd, 2);
}

function readTrainingEvents(limit = 1000) {
  return readJsonLines(TRAINING_EVENT_LOG, limit);
}

function collectTradeRecords(portfolio = {}) {
  const actions = Array.isArray(portfolio?.action_history) ? portfolio.action_history : [];
  const closed = Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [];
  const seen = new Set();
  return [...actions, ...closed]
    .filter((trade) => trade && typeof trade === "object")
    .filter((trade) => {
      const key = trade.trade_id || `${trade.ts || ""}:${trade.side || ""}:${trade.symbol || ""}:${trade.contract_address || ""}:${trade.quantity || ""}:${trade.price || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
}

function summarizeKillSwitches(portfolio = {}) {
  const settings = portfolio?.settings && typeof portfolio.settings === "object" ? portfolio.settings : {};
  const candidates = [
    ["disable_new_buys", settings.disable_new_buys],
    ["disable_rotations", settings.disable_rotations],
    ["exit_only", settings.exit_only],
    ["cancel_open_orders", settings.cancel_open_orders],
    ["pause_all_trading", settings.pause_all_trading],
    ["force_shadow_mode", settings.force_shadow_mode]
  ];
  return candidates.filter(([, enabled]) => enabled === true).map(([key]) => key);
}

function topExposureRows(portfolio = {}, keyFn, limit = 5) {
  const map = new Map();
  for (const position of Object.values(portfolio?.positions || {})) {
    const key = keyFn(position);
    if (!key) continue;
    map.set(key, roundTo((map.get(key) || 0) + positionValueUsd(position), 2));
  }
  return [...map.entries()]
    .map(([key, value_usd]) => ({ key, value_usd }))
    .sort((a, b) => b.value_usd - a.value_usd || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}

function summarizeRiskSnapshot(portfolio = {}, trainingEvents = []) {
  const decisions = trainingEvents
    .filter((event) => event?.event_type === "risk_decision")
    .map((event) => {
      const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
      const decision = payload.risk_decision && typeof payload.risk_decision === "object"
        ? payload.risk_decision
        : payload;
      const verdict = String(decision?.decision || payload?.decision || "").toLowerCase();
      return {
        ts: event.ts,
        decision: verdict === "allow" ? "allow" : verdict === "block" ? "block" : "unknown",
        blockers: Array.isArray(decision?.blockers) ? decision.blockers : [],
        warnings: Array.isArray(decision?.warnings) ? decision.warnings : [],
        checked_limits: Array.isArray(decision?.checked_limits) ? decision.checked_limits : [],
        symbol: decision?.symbol || payload?.proposal?.token?.symbol || payload?.symbol || null
      };
    })
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));

  const latest = decisions[0] || null;
  const blockedReasons = new Map();
  for (const decision of decisions.slice(0, 50)) {
    for (const reason of decision.blockers || []) {
      blockedReasons.set(reason, (blockedReasons.get(reason) || 0) + 1);
    }
  }

  const equityUsd = computePortfolioEquityUsd(portfolio);
  const policy = resolveRiskPolicy(portfolio);
  const openPositions = Object.keys(portfolio?.positions || {}).length;
  const tokenExposure = topExposureRows(portfolio, (position) => String(position?.symbol || position?.contract_address || "").trim().toUpperCase(), 5);
  const categoryExposure = topExposureRows(portfolio, (position) => String(position?.category || "unknown").trim().toLowerCase(), 5);
  const strategyExposure = topExposureRows(portfolio, (position) => String(position?.strategy_version || "unknown").trim(), 5);
  const marketRegime = portfolio?.stats?.market_regime || latest?.checked_limits?.find((item) => item?.key === "market_wide_risk_off_block")?.actual?.market_regime || "unknown";
  const killSwitches = summarizeKillSwitches(portfolio);

  return {
    market_regime: marketRegime,
    active_kill_switches: killSwitches,
    new_buys_allowed: !killSwitches.includes("disable_new_buys") && !killSwitches.includes("exit_only") && !killSwitches.includes("pause_all_trading"),
    recent_decision_counts: {
      allow: decisions.filter((decision) => decision.decision === "allow").length,
      block: decisions.filter((decision) => decision.decision === "block").length
    },
    latest_decision: latest ? {
      ts: latest.ts,
      decision: latest.decision,
      symbol: latest.symbol,
      blockers: latest.blockers.slice(0, 8),
      warnings: latest.warnings.slice(0, 8)
    } : null,
    top_blocked_reasons: [...blockedReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || String(a.reason).localeCompare(String(b.reason)))
      .slice(0, 8),
    utilization: [
      {
        key: "open_positions",
        label: "Open positions",
        actual: openPositions,
        limit: policy.max_open_positions,
        utilization_pct: policy.max_open_positions > 0 ? roundTo(openPositions / policy.max_open_positions * 100, 2) : null
      },
      {
        key: "largest_token_exposure",
        label: "Largest token exposure",
        actual: tokenExposure[0]?.value_usd || 0,
        limit: equityUsd > 0 ? roundTo(equityUsd * toFiniteNumber(policy.max_token_exposure_pct, 0), 2) : null,
        utilization_pct: equityUsd > 0 ? roundTo((tokenExposure[0]?.value_usd || 0) / Math.max(equityUsd * toFiniteNumber(policy.max_token_exposure_pct, 0), 1) * 100, 2) : null
      },
      {
        key: "largest_category_exposure",
        label: "Largest category exposure",
        actual: categoryExposure[0]?.value_usd || 0,
        limit: equityUsd > 0 ? roundTo(equityUsd * toFiniteNumber(policy.max_category_exposure_pct, 0), 2) : null,
        utilization_pct: equityUsd > 0 ? roundTo((categoryExposure[0]?.value_usd || 0) / Math.max(equityUsd * toFiniteNumber(policy.max_category_exposure_pct, 0), 1) * 100, 2) : null
      },
      {
        key: "largest_strategy_exposure",
        label: "Largest strategy exposure",
        actual: strategyExposure[0]?.value_usd || 0,
        limit: equityUsd > 0 ? roundTo(equityUsd * toFiniteNumber(policy.max_strategy_exposure_pct, 0), 2) : null,
        utilization_pct: equityUsd > 0 ? roundTo((strategyExposure[0]?.value_usd || 0) / Math.max(equityUsd * toFiniteNumber(policy.max_strategy_exposure_pct, 0), 1) * 100, 2) : null
      }
    ],
    exposure: {
      by_token: tokenExposure,
      by_category: categoryExposure,
      by_strategy: strategyExposure
    }
  };
}

function summarizeExecutionSnapshot(tradeRecords = [], backtest = null) {
  const orders = tradeRecords
    .filter((trade) => trade?.order_lifecycle || trade?.simulated_execution)
    .map((trade) => {
      const lifecycle = trade.order_lifecycle || {};
      const execution = trade.simulated_execution || lifecycle.simulated_execution || {};
      const control = execution?.liquidity_execution_control || {};
      const lastState = Array.isArray(lifecycle?.state_history) ? lifecycle.state_history[lifecycle.state_history.length - 1] : null;
      return {
        ts: trade.ts || null,
        order_id: lifecycle.order_id || trade.order_id || null,
        symbol: trade.symbol || lifecycle.symbol || null,
        side: trade.side || lifecycle.side || null,
        state: lifecycle.current_state || execution.decision || "unknown",
        fill_ratio: Number(execution?.fill_ratio),
        slippage_bps: Number(execution?.slippage_bps),
        fee_bps: Number(execution?.fee_bps),
        fee_usd: toFiniteNumber(execution?.fee_usd, 0),
        slippage_usd: toFiniteNumber(execution?.slippage_usd, 0),
        warnings: Array.isArray(control?.warnings) ? control.warnings : [],
        reason: lastState?.reason || execution?.rejection_reason || null
      };
    });

  const lifecycleCounts = {};
  for (const order of orders) {
    lifecycleCounts[order.state] = (lifecycleCounts[order.state] || 0) + 1;
  }

  const rejectedCount = orders.filter((order) => ["rejected", "failed", "expired", "risk_rejected"].includes(order.state)).length;
  const partialFillCount = orders.filter((order) => order.state === "partially_filled").length;
  const warningCounts = new Map();
  for (const order of orders) {
    for (const warning of order.warnings) {
      warningCounts.set(warning, (warningCounts.get(warning) || 0) + 1);
    }
  }

  const backtestSummary = backtest ? summarizeBacktestReport(backtest) : null;
  return {
    recent_order_count: orders.length,
    lifecycle_counts: lifecycleCounts,
    rejected_count: rejectedCount,
    partial_fill_count: partialFillCount,
    average_fill_ratio: averageFinite(orders.map((order) => order.fill_ratio), 4),
    average_slippage_bps: averageFinite(orders.map((order) => order.slippage_bps), 4),
    average_fee_bps: averageFinite(orders.map((order) => order.fee_bps), 4),
    fee_slippage_drag_usd: roundTo(orders.reduce((sum, order) => sum + order.fee_usd + order.slippage_usd, 0), 2),
    top_warnings: [...warningCounts.entries()]
      .map(([warning, count]) => ({ warning, count }))
      .sort((a, b) => b.count - a.count || String(a.warning).localeCompare(String(b.warning)))
      .slice(0, 6),
    recent_orders: orders.slice(0, 8),
    backtest_execution_quality: backtestSummary ? {
      fill_ratio: backtestSummary.execution_quality.fill_ratio,
      rejection_ratio: backtestSummary.execution_quality.rejection_ratio,
      partial_fill_count: backtestSummary.execution_quality.partial_fill_count,
      average_slippage_bps: backtestSummary.execution_quality.average_slippage_bps,
      average_fee_bps: backtestSummary.execution_quality.average_fee_bps,
      fee_slippage_drag_usd: backtestSummary.fee_slippage_drag_usd
    } : null
  };
}

function summarizeIncidentSnapshot() {
  const incidents = listIncidentFiles().map(({ report }) => report).filter(Boolean);
  const simplify = (incident) => ({
    incident_id: incident.incident_id || null,
    severity: incident.severity || "unknown",
    status: incident.status || (incident.end_time ? "resolved" : "active"),
    summary: incident.summary || incident.title || incident.name || incident.code || "incident",
    root_cause: incident.root_cause || incident.root_cause_summary || null,
    remediation: incident.remediation || incident.remediation_summary || null,
    start_time: incident.start_time || null,
    end_time: incident.end_time || null,
    latest_observed_at: incident.latest_observed_at || null
  });
  const active = incidents.filter((incident) => !incident?.end_time).map(simplify).slice(0, 5);
  const resolved = incidents.filter((incident) => incident?.end_time).map(simplify).slice(0, 5);
  return {
    active_count: active.length,
    resolved_count: resolved.length,
    active,
    resolved
  };
}

async function buildProfessionalDashboardSummary(options = {}) {
  const portfolio = options.portfolio || await loadPortfolioState();
  const trainingEvents = Array.isArray(options.trainingEvents) ? options.trainingEvents : readTrainingEvents(1500);
  const performanceReport = Object.prototype.hasOwnProperty.call(options, "performanceReport") ? options.performanceReport : latestPerformanceReport();
  const backtestReport = Object.prototype.hasOwnProperty.call(options, "backtestReport") ? options.backtestReport : latestBacktestReport();
  const promotionReport = Object.prototype.hasOwnProperty.call(options, "promotionReport") ? options.promotionReport : latestPromotionReport();
  const attributionReport = Object.prototype.hasOwnProperty.call(options, "attributionReport") ? options.attributionReport : latestAttributionReport();
  const operationsReport = Object.prototype.hasOwnProperty.call(options, "operationsReport")
    ? options.operationsReport
    : latestOperationsReport() || generateOperationsMonitorReport({ writeReport: false, writeEvents: false });
  const reconciliationReport = Object.prototype.hasOwnProperty.call(options, "reconciliationReport") ? options.reconciliationReport : latestReconciliationReport();
  const tradeRecords = collectTradeRecords(portfolio);
  const custody = evaluateLiveCapabilityStatus({ mode: "paper", portfolio });
  const auditPolicy = buildOperatorPermissionPolicy({
    action_type: "mode_change_request",
    mode: "paper",
    actor: "dashboard_local",
    role: "viewer",
    reason: "professional dashboard status view",
    portfolio
  });
  const risk = summarizeRiskSnapshot(portfolio, trainingEvents);
  const execution = summarizeExecutionSnapshot(tradeRecords, backtestReport);
  const incidents = summarizeIncidentSnapshot();
  const performance = performanceReport ? summarizePerformanceReport(performanceReport) : null;
  const backtest = backtestReport ? summarizeBacktestReport(backtestReport) : null;
  const promotion = promotionReport ? summarizePromotionReport(promotionReport) : null;
  const liveReadiness = options.liveReadiness || buildReadinessApiResponse({
    strategyVersion: ACTIVE_PIPELINE_STRATEGY_VERSION,
    readinessReportsDir: REPORTS_DIR,
    promotionReportsDir: PROMOTION_REPORTS_DIR
  });
  const attribution = attributionReport ? summarizeAttributionReport(attributionReport) : null;
  const operations = operationsReport ? summarizeOperationsReport(operationsReport) : null;
  const reconciliation = reconciliationReport ? summarizeReconciliationReport(reconciliationReport) : null;

  const overallBlockers = [];
  const overallWarnings = [];
  const killSwitches = risk.active_kill_switches || [];

  if (killSwitches.includes("pause_all_trading")) overallBlockers.push("pause_all_trading");
  if (killSwitches.includes("exit_only")) overallWarnings.push("exit_only");
  if (killSwitches.includes("disable_new_buys")) overallWarnings.push("disable_new_buys");
  if (!getPipelineStatus().running) overallWarnings.push("pipeline_not_running");
  if ((operations?.overall_status || "").toLowerCase() === "failed") overallBlockers.push("operations_failed");
  else if ((operations?.overall_status || "").toLowerCase() === "degraded") overallWarnings.push("operations_degraded");
  if ((reconciliation?.status || "").toLowerCase() === "mismatch") overallWarnings.push("reconciliation_mismatch");
  if (promotion && !promotion.promotion_allowed) overallWarnings.push("promotion_blocked");
  if (backtest?.portfolio_json_mutated) overallBlockers.push("backtest_mutated_portfolio_json");

  const canPaperTradeNow = overallBlockers.length === 0;
  const newBuysAllowed = canPaperTradeNow && risk.new_buys_allowed;
  const overallStatus = overallBlockers.length
    ? "blocked"
    : overallWarnings.length
      ? "degraded"
      : "paper_ready";

  return {
    generated_at: new Date().toISOString(),
    trading_mode: "paper",
    live_submission_enabled: false,
    live_submission_attempted: false,
    overall: {
      status: overallStatus,
      can_trade_now: canPaperTradeNow,
      can_paper_trade_now: canPaperTradeNow,
      new_buys_allowed: newBuysAllowed,
      live_trading_enabled: false,
      summary: canPaperTradeNow
        ? (newBuysAllowed ? "Paper trading is available. Live submission remains disabled." : "Paper trading is available in reduced mode. Live submission remains disabled.")
        : "Trading is blocked by dashboard-visible controls. Live submission remains disabled.",
      blockers: [...new Set(overallBlockers)],
      warnings: [...new Set(overallWarnings)]
    },
    performance: {
      daily: performance,
      backtest: backtest ? {
        total_return_pct: backtest.total_return_pct,
        profit_factor: backtest.profit_factor,
        max_drawdown_pct: backtest.max_drawdown_pct,
        fee_slippage_drag_usd: backtest.fee_slippage_drag_usd,
        before_execution_costs: backtest.before_execution_costs,
        after_execution_costs: backtest.after_execution_costs,
        execution_cost_impact: backtest.execution_cost_impact,
        baselines: backtest.baselines,
        portfolio_json_mutated: backtest.portfolio_json_mutated
      } : null,
      attribution: attribution ? {
        expectancy_usd: attribution.expectancy_usd,
        realized_pnl_usd: attribution.realized_pnl_usd,
        negative_expectancy_group_count: attribution.negative_expectancy_group_count,
        top_positive_setups: attribution.top_positive_setups,
        top_negative_setups: attribution.top_negative_setups
      } : null
    },
    strategy: {
      backtest,
      promotion,
      live_readiness: liveReadiness,
      attribution
    },
    execution,
    risk,
    data_quality: backtest?.market_data_quality || performance?.market_data_quality || null,
    crypto_ops: {
      operations,
      reconciliation,
      custody: {
        capability_status: custody.capability_status,
        blocker_count: Array.isArray(custody.blockers) ? custody.blockers.length : 0,
        blockers: Array.isArray(custody.blockers) ? custody.blockers.slice(0, 8) : [],
        enabled_venue_count: Array.isArray(custody.controls?.venues) ? custody.controls.venues.filter((venue) => venue.enabled).length : 0,
        enabled_wallet_count: Array.isArray(custody.controls?.wallets) ? custody.controls.wallets.filter((wallet) => wallet.enabled).length : 0,
        enabled_signer_count: Array.isArray(custody.controls?.signers) ? custody.controls.signers.filter((signer) => signer.enabled).length : 0
      }
    },
    audit: {
      current_mode: getPipelineStatus().mode,
      permission_decision: auditPolicy.decision,
      blockers: auditPolicy.blockers,
      live_submission_enabled: false,
      recent_operator_actions: readOperatorActionRecords({ maxRecords: 8 })
    },
    incidents
  };
}

function summarizeReport(report, filePath) {
  const criticalFlags = Number(report?.critical_flags ?? (Array.isArray(report?.flags) ? report.flags.filter((flag) => flag.severity === "critical").length : 0));
  const warningFlags = Number(report?.warning_flags ?? (Array.isArray(report?.flags) ? report.flags.filter((flag) => flag.severity === "warning").length : 0));
  const scoutVisibility = report?.dashboard_visibility?.scout || {};
  const harvestVisibility = report?.dashboard_visibility?.harvest || {};
  return {
    report_id: report?.report_id || null,
    generated_at: report?.generated_at || null,
    cycle_index: report?.cycle_index ?? null,
    overall_grade: report?.overall_grade || "F",
    overall_score: report?.overall_score ?? 0,
    critical_flags: criticalFlags,
    warning_flags: warningFlags,
    market_regime: report?.market_regime || "unknown",
    cycle_duration_seconds: report?.cycle_duration_seconds ?? null,
    dashboard_visibility: {
      scout: {
        latest_token_usage: scoutVisibility?.latest_token_usage ?? report?.agents?.scout?.llm_tokens ?? null,
        shortlist_candidate_count: scoutVisibility?.shortlist_candidate_count ?? report?.evidence_summary?.scout?.shortlist_candidate_count ?? report?.agents?.scout?.shortlisted_candidates ?? null,
        evidence_qualified_count: scoutVisibility?.evidence_qualified_count ?? report?.evidence_summary?.scout?.evidence_qualified_candidates ?? null,
        evidence_blocked_count: scoutVisibility?.evidence_blocked_count ?? report?.evidence_summary?.scout?.evidence_blocked_candidates ?? null,
        downgraded_weak_candidates: scoutVisibility?.downgraded_weak_candidates ?? report?.evidence_summary?.scout?.weak_candidate_downgrade_count ?? null
      },
      harvest: {
        latest_token_usage: harvestVisibility?.latest_token_usage ?? report?.agents?.harvest?.llm_tokens ?? null,
        downgraded_weak_exits: harvestVisibility?.downgraded_weak_exits ?? report?.evidence_summary?.harvest?.weak_exit_downgrade_count ?? report?.evidence_summary?.harvest?.evidence_downgrade_count ?? null
      }
    },
    report_file: report?.report_file || path.relative(ROOT, filePath)
  };
}

function nowLocalIso() {
  const date = new Date();
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const minutes = String(absMinutes % 60).padStart(2, "0");
  const local = new Date(date.getTime() + offsetMinutes * 60000);
  return `${local.toISOString().slice(0, 19)}${sign}${hours}:${minutes}`;
}

function logExternalApi(stage, data) {
  fs.appendFileSync(
    PIPELINE_LOG,
    JSON.stringify({ ts: nowLocalIso(), stage, data }) + "\n"
  );
}

function writeEmptyFile(filePath) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, "", "utf8");
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
}

function writeDashboardHeartbeat() {
  try {
    ensureDir(DASHBOARD_HEARTBEAT_FILE);
    fs.writeFileSync(DASHBOARD_HEARTBEAT_FILE, `${JSON.stringify({
      updated_at: nowLocalIso(),
      pid: process.pid,
      host: HOST,
      port: PORT
    }, null, 2)}\n`, "utf8");
  } catch {
  }
}

function readJsonLines(filePath, limit = 250) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf8").trim().split(/\n+/).filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function readAllJsonLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8")
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const FUNNEL_WINDOWS_MS = Object.freeze({
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000
});

const ATTRIBUTION_MIN_MATCHED_TRADES = 3;
const ATTRIBUTION_VERDICT_DELTA_PCT = 1;

const FUNNEL_TRANSITIONS = Object.freeze([
  { from: "universe_seen", to: "universe_filtered" },
  { from: "universe_filtered", to: "shortlist_built" },
  { from: "shortlist_built", to: "shortlist_blocked" },
  { from: "shortlist_built", to: "llm_input" },
  { from: "llm_input", to: "llm_returned" },
  { from: "llm_returned", to: "address_repaired" },
  { from: "llm_returned", to: "risk_input" },
  { from: "risk_input", to: "risk_approved" },
  { from: "risk_approved", to: "executor_input" },
  { from: "executor_input", to: "trade_opened" }
]);

function parseFunnelWindow(rawWindow = "24h") {
  const normalized = String(rawWindow || "24h").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(FUNNEL_WINDOWS_MS, normalized)) {
    const error = new Error("INVALID_WINDOW");
    error.statusCode = 400;
    error.details = {
      ok: false,
      error: "INVALID_WINDOW",
      allowed: Object.keys(FUNNEL_WINDOWS_MS)
    };
    throw error;
  }
  return {
    label: normalized,
    duration_ms: FUNNEL_WINDOWS_MS[normalized]
  };
}

function parseTimestampMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFunnelCount(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildReasonHistogram() {
  return new Map();
}

function addReason(reasonMap, value) {
  const normalized = String(value || "").trim();
  if (!normalized) return;
  reasonMap.set(normalized, (reasonMap.get(normalized) || 0) + 1);
}

function addReasons(reasonMap, values) {
  for (const value of normalizeArray(values)) addReason(reasonMap, value);
}

function reasonMapToTop3(reasonMap) {
  return [...reasonMap.entries()]
    .map(([reason_code, count]) => ({ reason_code, count }))
    .sort((a, b) => b.count - a.count || a.reason_code.localeCompare(b.reason_code))
    .slice(0, 3);
}

function extractRiskReasonCodes(item) {
  const codes = [];
  const push = (values) => {
    for (const value of normalizeArray(values)) {
      const normalized = String(value || "").trim();
      if (normalized) codes.push(normalized);
    }
  };
  push(item?.reason_codes);
  push(item?.blockers);
  push(item?.blocker_list);
  push(item?.risk_review?.reason_codes);
  push(item?.risk_review?.blocker_list);
  push(item?.proposal?._risk?.reason_codes);
  push(item?.proposal?._risk?.blocker_list);
  push(item?.proposal?.evidence_blockers);
  push(item?.proposal?.evidence_warnings);
  return codes;
}

function extractExecutorReasonCodes(record) {
  const payload = record?.payload || {};
  const review = payload?.review || {};
  const proposal = payload?.proposal || {};
  const actionCandidate = payload?.action?.candidate || {};
  const codes = [];
  const push = (values) => {
    for (const value of normalizeArray(values)) {
      const normalized = String(value || "").trim();
      if (normalized) codes.push(normalized);
    }
  };
  push(review?.blocker_list);
  push(review?.risk_checks);
  push(review?.execution_checks);
  push(review?.portfolio_checks);
  push(proposal?._risk?.blocker_list);
  push(proposal?._risk?.checks_failed);
  push(actionCandidate?.evidence_blockers);
  return codes;
}

function buildCycleWindowMap(trainingEntries) {
  const cycles = new Map();
  let latestTsMs = 0;

  for (const entry of trainingEntries) {
    const tsMs = parseTimestampMs(entry?.ts);
    if (tsMs != null) latestTsMs = Math.max(latestTsMs, tsMs);
    const cycleId = String(entry?.cycle_id || "").trim();
    if (!cycleId || tsMs == null) continue;

    let cycle = cycles.get(cycleId);
    if (!cycle) {
      cycle = {
        cycle_id: cycleId,
        start_ms: null,
        end_ms: null,
        min_ts_ms: tsMs,
        max_ts_ms: tsMs
      };
      cycles.set(cycleId, cycle);
    }

    cycle.min_ts_ms = Math.min(cycle.min_ts_ms, tsMs);
    cycle.max_ts_ms = Math.max(cycle.max_ts_ms, tsMs);

    if (entry.event_type === "cycle_start") {
      cycle.start_ms = cycle.start_ms == null ? tsMs : Math.min(cycle.start_ms, tsMs);
    } else if (entry.event_type === "cycle_end") {
      cycle.end_ms = cycle.end_ms == null ? tsMs : Math.max(cycle.end_ms, tsMs);
    }
  }

  return {
    latest_ts_ms: latestTsMs,
    cycles: [...cycles.values()]
      .map((cycle) => ({
        cycle_id: cycle.cycle_id,
        start_ms: cycle.start_ms ?? cycle.min_ts_ms,
        end_ms: cycle.end_ms ?? cycle.max_ts_ms
      }))
      .sort((a, b) => a.start_ms - b.start_ms)
  };
}

function intervalContains(tsMs, interval) {
  return tsMs != null && tsMs >= interval.start_ms && tsMs <= interval.end_ms;
}

function buildEmptyFunnelCycle(cycleId) {
  return {
    cycle_id: cycleId,
    universe_seen: 0,
    universe_filtered: 0,
    shortlist_packets: 0,
    shortlist_built: 0,
    shortlist_blocked: 0,
    llm_request_seen: false,
    llm_input: 0,
    llm_response_seen: false,
    llm_returned: 0,
    address_repaired: 0,
    risk_input: 0,
    risk_approved: 0,
    risk_rejected: 0,
    executor_input: 0,
    trade_opened: 0
  };
}

export function buildFunnelRollup({ window = "24h", cycleId = null } = {}) {
  const parsedWindow = parseFunnelWindow(window);
  const normalizedCycleId = cycleId == null ? null : String(cycleId).trim() || null;
  const pipelineEntries = readAllJsonLines(PIPELINE_LOG);
  const trainingEntries = readAllJsonLines(TRAINING_EVENT_LOG);
  const pipelineLatestTsMs = pipelineEntries.reduce((max, entry) => Math.max(max, parseTimestampMs(entry?.ts) || 0), 0);
  const cycleWindowData = buildCycleWindowMap(trainingEntries);
  const referenceNowMs = Math.max(Date.now(), pipelineLatestTsMs, cycleWindowData.latest_ts_ms);
  const windowStartMs = referenceNowMs - parsedWindow.duration_ms;

  const selectedCycleWindows = cycleWindowData.cycles.filter((cycle) => {
    if (normalizedCycleId && cycle.cycle_id !== normalizedCycleId) return false;
    return cycle.end_ms >= windowStartMs && cycle.start_ms <= referenceNowMs;
  });
  const selectedCycleIds = new Set(selectedCycleWindows.map((cycle) => cycle.cycle_id));
  const cycleSummaries = new Map(selectedCycleWindows.map((cycle) => [cycle.cycle_id, buildEmptyFunnelCycle(cycle.cycle_id)]));
  const pseudoCycleId = "__window__";
  const fallbackCycle = buildEmptyFunnelCycle(pseudoCycleId);

  const shortlistReasons = buildReasonHistogram();
  const riskReasons = buildReasonHistogram();
  const executorReasons = buildReasonHistogram();

  for (const entry of pipelineEntries) {
    const tsMs = parseTimestampMs(entry?.ts);
    if (tsMs == null || tsMs < windowStartMs || tsMs > referenceNowMs) continue;

    const matchingCycle = selectedCycleWindows.find((cycle) => intervalContains(tsMs, cycle));
    if (normalizedCycleId && !matchingCycle) continue;

    const summary = matchingCycle ? cycleSummaries.get(matchingCycle.cycle_id) : fallbackCycle;
    const data = entry?.data || {};

    if (entry.stage === "scout_universe_filter") {
      summary.universe_seen += toFunnelCount(data.before, 0);
      summary.universe_filtered += toFunnelCount(data.after, 0);
    } else if (entry.stage === "scout_evidence_shortlist") {
      const packetsBuilt = toFunnelCount(data.packets_built, 0);
      const shortlistCount = toFunnelCount(data.shortlist_count, 0);
      const blockedCount = toFunnelCount(data.blocked_count, 0);
      summary.shortlist_packets += packetsBuilt || shortlistCount + blockedCount;
      summary.shortlist_built += shortlistCount;
      summary.shortlist_blocked += blockedCount;
    } else if (entry.stage === "scout_shortlist_blocked") {
      addReasons(shortlistReasons, data.reasons);
      addReasons(shortlistReasons, data.hard_blockers);
    } else if (entry.stage === "llm_request" && data.agent === "scout") {
      summary.llm_request_seen = true;
    } else if (entry.stage === "llm_response" && data.agent === "scout") {
      summary.llm_response_seen = true;
    } else if (entry.stage === "scout_candidate_downgraded") {
      summary.llm_returned += 1;
    } else if (entry.stage === "scout_candidate_address_repaired") {
      summary.address_repaired += 1;
    } else if (entry.stage === "scout") {
      const candidateCount = normalizeArray(data.candidates).length;
      summary.llm_returned += candidateCount;
      summary.risk_input += candidateCount;
    } else if (entry.stage === "risk_approved") {
      summary.risk_approved += normalizeArray(data).length;
    } else if (entry.stage === "risk_rejected") {
      const rejected = normalizeArray(data);
      summary.risk_rejected += rejected.length;
      for (const item of rejected) addReasons(riskReasons, extractRiskReasonCodes(item));
    }
  }

  for (const summary of cycleSummaries.values()) {
    if (summary.shortlist_packets === 0 && summary.universe_filtered > 0) {
      summary.shortlist_packets = summary.universe_filtered;
    }
    if (summary.llm_request_seen) {
      summary.llm_input = summary.shortlist_built;
    }
    if (!summary.risk_input && (summary.risk_approved || summary.risk_rejected)) {
      summary.risk_input = summary.risk_approved + summary.risk_rejected;
    }
  }

  if (!selectedCycleWindows.length && !normalizedCycleId) {
    if (fallbackCycle.shortlist_packets === 0 && fallbackCycle.universe_filtered > 0) {
      fallbackCycle.shortlist_packets = fallbackCycle.universe_filtered;
    }
    if (fallbackCycle.llm_request_seen) {
      fallbackCycle.llm_input = fallbackCycle.shortlist_built;
    }
    if (!fallbackCycle.risk_input && (fallbackCycle.risk_approved || fallbackCycle.risk_rejected)) {
      fallbackCycle.risk_input = fallbackCycle.risk_approved + fallbackCycle.risk_rejected;
    }
  }

  for (const entry of trainingEntries) {
    const tsMs = parseTimestampMs(entry?.ts);
    if (tsMs == null || tsMs < windowStartMs || tsMs > referenceNowMs) continue;

    const cycleKey = String(entry?.cycle_id || "").trim();
    let summary = null;
    if (cycleKey && selectedCycleIds.has(cycleKey)) {
      summary = cycleSummaries.get(cycleKey) || null;
    } else if (!normalizedCycleId && !selectedCycleWindows.length) {
      summary = fallbackCycle;
    } else {
      continue;
    }

    if (entry.event_type === "executor_decision") {
      const payload = entry?.payload || {};
      const decision = String(payload.decision || payload.review?.executor_decision || "").trim().toLowerCase();
      const actionType = String(payload?.action?.type || payload?.trade_kind || "").trim().toLowerCase();
      if (actionType === "buy") {
        summary.executor_input += 1;
        if (decision && decision !== "paper_trade" && decision !== "approve_live" && decision !== "reduce_size") {
          addReasons(executorReasons, extractExecutorReasonCodes(entry));
        }
      }
    } else if (entry.event_type === "trade") {
      const lifecycle = String(entry?.payload?.trade_lifecycle || "").trim().toLowerCase();
      const tradeStatus = String(entry?.payload?.trade_status || "").trim().toLowerCase();
      if (lifecycle === "open" && (tradeStatus === "filled" || !tradeStatus)) {
        summary.trade_opened += 1;
      }
    }
  }

  const summaries = selectedCycleWindows.length
    ? [...cycleSummaries.values()]
    : normalizedCycleId
      ? []
      : [fallbackCycle];

  const totals = summaries.reduce((acc, summary) => {
    acc.universe_seen += summary.universe_seen;
    acc.universe_filtered += summary.universe_filtered;
    acc.shortlist_packets += summary.shortlist_packets;
    acc.shortlist_built += summary.shortlist_built;
    acc.shortlist_blocked += summary.shortlist_blocked;
    acc.llm_input += summary.llm_input;
    acc.llm_returned += summary.llm_returned;
    acc.address_repaired += summary.address_repaired;
    acc.risk_input += summary.risk_input;
    acc.risk_approved += summary.risk_approved;
    acc.executor_input += summary.executor_input;
    acc.trade_opened += summary.trade_opened;
    return acc;
  }, {
    universe_seen: 0,
    universe_filtered: 0,
    shortlist_packets: 0,
    shortlist_built: 0,
    shortlist_blocked: 0,
    llm_input: 0,
    llm_returned: 0,
    address_repaired: 0,
    risk_input: 0,
    risk_approved: 0,
    executor_input: 0,
    trade_opened: 0
  });

  return {
    window: parsedWindow.label,
    generated_at: new Date(referenceNowMs).toISOString(),
    transitions: FUNNEL_TRANSITIONS.map(({ from, to }) => {
      const key = `${from}->${to}`;
      const counts = {
        "universe_seen->universe_filtered": [totals.universe_seen, totals.universe_filtered, []],
        "universe_filtered->shortlist_built": [totals.shortlist_packets, totals.shortlist_built, []],
        "shortlist_built->shortlist_blocked": [totals.shortlist_packets, totals.shortlist_blocked, reasonMapToTop3(shortlistReasons)],
        "shortlist_built->llm_input": [totals.shortlist_built, totals.llm_input, []],
        "llm_input->llm_returned": [totals.llm_input, totals.llm_returned, []],
        "llm_returned->address_repaired": [totals.llm_returned, totals.address_repaired, []],
        "llm_returned->risk_input": [totals.llm_returned, totals.risk_input, []],
        "risk_input->risk_approved": [totals.risk_input, totals.risk_approved, reasonMapToTop3(riskReasons)],
        "risk_approved->executor_input": [totals.risk_approved, totals.executor_input, []],
        "executor_input->trade_opened": [totals.executor_input, totals.trade_opened, reasonMapToTop3(executorReasons)]
      }[key] || [0, 0, []];
      return {
        from,
        to,
        count_in: counts[0],
        count_out: counts[1],
        drop_reasons_top3: counts[2]
      };
    }),
    totals: {
      trades_opened: totals.trade_opened,
      cycles_observed: summaries.length
    },
    top_block_reasons: {
      shortlist: reasonMapToTop3(shortlistReasons),
      risk: reasonMapToTop3(riskReasons),
      executor: reasonMapToTop3(executorReasons)
    }
  };
}

function normalizeTextKey(value, fallback = "unknown") {
  const text = String(value ?? "").trim().toLowerCase();
  return text || fallback;
}

function uniqueTextList(values = []) {
  return [...new Set(normalizeArray(values)
    .map((value) => normalizeTextKey(value, ""))
    .filter(Boolean))];
}

function averageNumber(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function roundNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function rootReasonCode(value) {
  const text = normalizeTextKey(value);
  return text.includes(":") ? normalizeTextKey(text.split(":")[0], "unknown") : text;
}

function extractStoryTypesFromEvidenceSummary(summary) {
  if (!summary || typeof summary !== "object") return [];
  return uniqueTextList(
    normalizeArray(summary.highlights).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      return [item.label, item.source_type, item.story_type, item.type];
    })
  );
}

function extractStoryTypesFromTrade(trade = {}) {
  const direct = uniqueTextList(normalizeArray(trade.story_types));
  if (direct.length) return direct;

  const evidenceTypes = uniqueTextList(normalizeArray(trade.evidence).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    return [item.story_type, item.type, item.category, item.label, item.signal];
  }));
  if (evidenceTypes.length) return evidenceTypes;

  const summaryTypes = extractStoryTypesFromEvidenceSummary(trade.evidence_summary);
  if (summaryTypes.length) return summaryTypes;

  const ticketSummaryTypes = extractStoryTypesFromEvidenceSummary(trade.paper_trade_ticket?.evidence_summary);
  if (ticketSummaryTypes.length) return ticketSummaryTypes;

  const setupType = normalizeTextKey(trade.setup_type || trade.paper_trade_ticket?.setup_type || "", "");
  return setupType ? [setupType] : ["unknown"];
}

function numericLogBand(value) {
  const n = Number(value);
  if (!(n > 0)) return "unknown";
  return String(Math.floor(Math.log10(n)));
}

function bucketKeyFromFields(category, liquidityUsd, marketCapUsd, flowSignal) {
  return [
    normalizeTextKey(category),
    numericLogBand(liquidityUsd),
    numericLogBand(marketCapUsd),
    normalizeTextKey(flowSignal)
  ].join("|");
}

function bucketKeyFromTradeRow(row = {}) {
  return bucketKeyFromFields(row.category, row.liquidity_usd, row.market_cap_usd, row.flow_signal);
}

function proposalFlowSignal(proposal = {}) {
  return proposal?._dex_flow?.flow_signal
    || proposal?.flow_signal
    || proposal?.narrative_data?.flow_direction
    || proposal?.position?.flow_signal
    || null;
}

function buildBucketKeyFromProposal(proposal = {}) {
  return bucketKeyFromFields(
    proposal?.token?.category,
    proposal?.liquidity_data?.liquidity_usd,
    proposal?.market_data?.market_cap_usd,
    proposalFlowSignal(proposal)
  );
}

function extractRuleCodes(item = {}) {
  return uniqueTextList([
    ...normalizeArray(item?.risk?.reason_codes),
    ...normalizeArray(item?.risk?.blocker_list),
    ...normalizeArray(item?.risk?.checks_failed),
    ...normalizeArray(item?.reason_codes),
    ...normalizeArray(item?.blockers)
  ]);
}

async function streamJsonLines(filePath, onEntry) {
  if (!fs.existsSync(filePath)) return;
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        await onEntry(entry);
      } catch {
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }
}

async function loadAttributionTradeData(trainingEventLog) {
  let latestTsMs = 0;
  const openTradesByPosition = new Map();
  const completedTrades = [];

  await streamJsonLines(trainingEventLog, (entry) => {
    const tsMs = parseTimestampMs(entry?.ts);
    if (tsMs != null) latestTsMs = Math.max(latestTsMs, tsMs);

    if (entry?.event_type === "trade") {
      const trade = entry?.payload?.trade || {};
      if (normalizeTextKey(trade.side) !== "buy") return;
      if (normalizeTextKey(trade.trade_lifecycle) !== "open") return;
      const positionId = String(entry?.position_id || entry?.payload?.position_id || trade.position_id || "").trim();
      if (!positionId) return;

      openTradesByPosition.set(positionId, {
        position_id: positionId,
        source_agent: normalizeTextKey(
          trade?.paper_trade_ticket?.source_agent
          || entry?.payload?.source_agent
          || trade?.source_agent
        ),
        story_types: extractStoryTypesFromTrade(trade),
        opened_at_ms: tsMs
      });
      return;
    }

    if (entry?.event_type !== "outcome") return;

    const payload = entry?.payload || {};
    const closeTrade = payload.trade || {};
    const positionBefore = payload.position_before || {};
    const entryPrice = Number(payload.entry_price ?? positionBefore.avg_entry_price);
    const quantity = Number(closeTrade.quantity ?? positionBefore.quantity);
    const fallbackCostUsd = Number.isFinite(entryPrice) && Number.isFinite(quantity) ? entryPrice * quantity : NaN;
    const costBasisUsd = Number(payload.trade?.cost_portion_usd ?? positionBefore.cost_basis_usd ?? fallbackCostUsd);
    const pnlUsd = Number(payload.pnl_usd);
    completedTrades.push({
      ts_ms: tsMs,
      position_id: String(entry?.position_id || payload.position_id || closeTrade.position_id || "").trim() || null,
      category: positionBefore.category || closeTrade.category || "unknown",
      liquidity_usd: Number(positionBefore.liquidity_usd ?? positionBefore?.last_market_snapshot?.liquidity_data?.liquidity_usd),
      market_cap_usd: Number(positionBefore?.last_market_snapshot?.market_data?.market_cap_usd),
      flow_signal: positionBefore.flow_signal || positionBefore?.last_market_snapshot?.flow_data?.flow_signal || "unknown",
      exit_reason: rootReasonCode(closeTrade.reason),
      pnl_pct: Number.isFinite(costBasisUsd) && costBasisUsd > 0 && Number.isFinite(pnlUsd)
        ? (pnlUsd / costBasisUsd) * 100
        : null
    });
  });

  const rows = completedTrades.map((trade) => {
    const openTrade = trade.position_id ? openTradesByPosition.get(trade.position_id) || null : null;
    return {
      ...trade,
      source_agent: openTrade?.source_agent || "unknown",
      story_types: openTrade?.story_types?.length ? openTrade.story_types : ["unknown"],
      bucket_key: bucketKeyFromTradeRow(trade)
    };
  });

  return { latestTsMs, rows };
}

async function loadAttributionRejectionData(pipelineLog) {
  let latestTsMs = 0;
  const allRules = new Set();
  const rejections = [];

  await streamJsonLines(pipelineLog, (entry) => {
    const tsMs = parseTimestampMs(entry?.ts);
    if (tsMs != null) latestTsMs = Math.max(latestTsMs, tsMs);
    if (entry?.stage !== "risk_rejected" && entry?.stage !== "harvest_rejected") return;

    const items = normalizeArray(entry?.data);
    if (!items.length) return;

    for (const item of items) {
      const proposal = item?.proposal || {};
      const ruleCodes = extractRuleCodes(item);
      for (const rule of ruleCodes) allRules.add(rule);
      rejections.push({
        ts_ms: tsMs,
        bucket_key: buildBucketKeyFromProposal(proposal),
        rule_codes: ruleCodes
      });
    }
  });

  return { latestTsMs, allRules, rejections };
}

function buildDistribution(rows, keyName, extractor) {
  const groups = new Map();
  for (const row of rows) {
    for (const key of uniqueTextList(extractor(row))) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row.pnl_pct);
    }
  }
  return [...groups.entries()]
    .map(([key, pnlValues]) => ({
      [keyName]: key,
      completed_trades: pnlValues.length,
      avg_realized_pnl_pct: roundNumber(averageNumber(pnlValues), 2)
    }))
    .sort((a, b) => b.completed_trades - a.completed_trades || String(a[keyName]).localeCompare(String(b[keyName])));
}

function deriveRuleVerdict({ rejections, matchedOpenedTrades, blockedBucketAvgPct, openedTradeAvgPct }) {
  if (!rejections || matchedOpenedTrades < ATTRIBUTION_MIN_MATCHED_TRADES) return "inconclusive";
  if (!Number.isFinite(blockedBucketAvgPct) || !Number.isFinite(openedTradeAvgPct)) return "inconclusive";
  if (blockedBucketAvgPct <= openedTradeAvgPct - ATTRIBUTION_VERDICT_DELTA_PCT) return "rule_helps";
  if (blockedBucketAvgPct > 0 && blockedBucketAvgPct >= openedTradeAvgPct + ATTRIBUTION_VERDICT_DELTA_PCT) return "rule_might_hurt";
  return "inconclusive";
}

export async function buildAttributionReport({
  window = "7d",
  pipelineLog = PIPELINE_LOG,
  trainingEventLog = TRAINING_EVENT_LOG,
  nowMs = null
} = {}) {
  const parsedWindow = parseFunnelWindow(window || "7d");
  const [tradeData, rejectionData] = await Promise.all([
    loadAttributionTradeData(trainingEventLog),
    loadAttributionRejectionData(pipelineLog)
  ]);
  const referenceNowMs = Number.isFinite(nowMs)
    ? Math.max(nowMs, tradeData.latestTsMs, rejectionData.latestTsMs)
    : Math.max(Date.now(), tradeData.latestTsMs, rejectionData.latestTsMs);
  const windowStartMs = referenceNowMs - parsedWindow.duration_ms;
  const completedTrades = tradeData.rows.filter((row) => row.ts_ms != null && row.ts_ms >= windowStartMs && row.ts_ms <= referenceNowMs);
  const rejectionsInWindow = rejectionData.rejections.filter((row) => row.ts_ms != null && row.ts_ms >= windowStartMs && row.ts_ms <= referenceNowMs);

  const bucketStats = new Map();
  for (const trade of completedTrades) {
    if (!Number.isFinite(trade.pnl_pct)) continue;
    const existing = bucketStats.get(trade.bucket_key) || { pnlValues: [] };
    existing.pnlValues.push(trade.pnl_pct);
    bucketStats.set(trade.bucket_key, existing);
  }

  const overallOpenedAvgPct = averageNumber(
    completedTrades.map((trade) => trade.pnl_pct).filter((value) => Number.isFinite(value))
  );
  const ruleStats = new Map([...rejectionData.allRules].map((rule) => [rule, {
    rule,
    rejections: 0,
    bucket_keys: new Set()
  }]));

  for (const rejection of rejectionsInWindow) {
    for (const rule of rejection.rule_codes) {
      if (!ruleStats.has(rule)) {
        ruleStats.set(rule, { rule, rejections: 0, bucket_keys: new Set() });
      }
      const stat = ruleStats.get(rule);
      stat.rejections += 1;
      stat.bucket_keys.add(rejection.bucket_key);
    }
  }

  const byRule = [...ruleStats.values()]
    .map((stat) => {
      const matchedPnlValues = [...stat.bucket_keys].flatMap((bucketKey) => bucketStats.get(bucketKey)?.pnlValues || []);
      const avgRealizedPnlPct = averageNumber(matchedPnlValues);
      return {
        rule: stat.rule,
        rejections: stat.rejections,
        matched_opened_trades: matchedPnlValues.length,
        avg_realized_pnl_pct: roundNumber(avgRealizedPnlPct, 2),
        verdict: deriveRuleVerdict({
          rejections: stat.rejections,
          matchedOpenedTrades: matchedPnlValues.length,
          blockedBucketAvgPct: avgRealizedPnlPct,
          openedTradeAvgPct: overallOpenedAvgPct
        })
      };
    })
    .sort((a, b) => b.rejections - a.rejections || b.matched_opened_trades - a.matched_opened_trades || a.rule.localeCompare(b.rule));

  return {
    window: parsedWindow.label,
    by_rule: byRule,
    by_signal_source: buildDistribution(completedTrades, "signal_source", (row) => [row.source_agent]),
    by_story_type: buildDistribution(completedTrades, "story_type", (row) => row.story_types || ["unknown"]),
    by_exit_reason: buildDistribution(completedTrades, "exit_reason", (row) => [row.exit_reason])
  };
}

function clearLocalStateFiles() {
  fs.writeFileSync(PORTFOLIO_FILE, `${JSON.stringify(DEFAULT_PORTFOLIO_STATE, null, 2)}\n`, "utf8");
  writeEmptyFile(PIPELINE_LOG);
  writeEmptyFile(TRAINING_EVENT_LOG);
}

function clearMongoState() {
  try {
    const script = `
      const dbName = process.env.MONGO_DATABASE_NAME || ${JSON.stringify(MONGO_DATABASE_NAME)};
      const dbRef = db.getSiblingDB(dbName);
      try { dbRef.dropDatabase(); } catch (err) { }
      print(JSON.stringify({ ok: true }));
    `;

    runShell("docker", [
      "exec",
      "-i",
      MONGO_CONTAINER_NAME,
      "mongosh",
      "--quiet"
    ], {
      input: script,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        MONGO_DATABASE_NAME
      }
    });
    return true;
  } catch {
    return false;
  }
}

function clearClickHouseState() {
  try {
    const query = `TRUNCATE TABLE IF EXISTS ${CLICKHOUSE_DATABASE_NAME}.${CLICKHOUSE_TABLE_NAME}`;
    const chHeaders = CLICKHOUSE_USER ? { Authorization: `Basic ${Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString("base64")}` } : {};
    const response = fetch(`${CLICKHOUSE_HTTP_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE_NAME)}&query=${encodeURIComponent(query)}`, {
      method: "POST", headers: chHeaders
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

function clearSystemState() {
  const status = getPipelineStatus();
  const pipelineWasRunning = status.running;
  if (pipelineWasRunning) stopPipelineProcess();
  clearPidFile();
  clearInterval(_recoveryPollTimer);

  clearLocalStateFiles();
  TOKEN_METADATA_CACHE.clear();

  const mongoCleared = clearMongoState();
  const clickhouseCleared = clearClickHouseState();

  pipelineProcess = null;
  setPipelineState({
    running: false,
    pid: null,
    mode: "stopped",
    started_at: null,
    stop_requested_at: null,
    exit_code: null,
    signal: null,
    last_error: null
  });

  return {
    mongoCleared,
    clickhouseCleared,
    pipelineWasRunning
  };
}

function runShell(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
}

function getPipelineStatus() {
  const pid = pipelineProcess?.pid ?? pipelineState.pid ?? null;
  const alive = isProcessAlive(pid);
  if (pipelineState.running && !alive) {
    // Process died without us knowing (e.g. OOM kill) — reconcile
    pipelineProcess = null;
    clearPidFile();
    setPipelineState({ running: false, pid: null, mode: "stopped" });
  }
  return { ...pipelineState, running: pipelineState.running && alive, pid };
}

function setPipelineState(nextState) {
  pipelineState = { ...pipelineState, ...nextState };
}

function operatorContextFromBody(body = {}, fallbackReason = null) {
  return {
    actor: body.actor || body.operator || "dashboard_local",
    role: body.role || body.operator_role || "operator",
    reason: body.reason || fallbackReason
  };
}

function stopPipelineProcess(signal = "SIGTERM") {
  clearTimeout(_pipelineRestartTimer);
  _pipelineRestartTimer = null;
  const pid = pipelineProcess?.pid ?? pipelineState.pid ?? null;
  if (!pid || !isProcessAlive(pid)) {
    pipelineProcess = null;
    clearPidFile();
    setPipelineState({ running: false, mode: "stopped", pid: null });
    return false;
  }
  try {
    const stopRequestedAt = nowLocalIso();
    const stopped = killProcessGroup(pid, signal);
    if (!stopped) {
      throw new Error(`Unable to signal process ${pid}`);
    }
    setPipelineState({
      running: false,
      mode: "stopped",
      pid: null,
      stop_requested_at: stopRequestedAt,
      signal,
      last_error: null
    });
    pipelineProcess = null;
    setTimeout(() => {
      if (isProcessAlive(pid)) {
        try {
          killProcessGroup(pid, "SIGKILL");
        } catch {
        }
      }
    }, 1500);
  } catch (err) {
    pipelineProcess = null;
    clearPidFile();
    setPipelineState({ running: false, mode: "stopped", pid: null, last_error: err.message });
    return false;
  }
  return true;
}

function startPipelineProcess(intervalSeconds = 300) {
  // Stop any currently managed process
  if (pipelineProcess) stopPipelineProcess();

  // Kill any orphaned pipeline PID from before a server restart
  const orphanPid = readPidFile();
  if (orphanPid && isProcessAlive(orphanPid)) {
    try { process.kill(orphanPid, "SIGINT"); } catch {}
  }
  clearPidFile();
  clearInterval(_recoveryPollTimer);

  const safeIntervalSeconds = Math.max(1, Number(intervalSeconds) || 300);

  // Redirect pipeline stdout/stderr to log files so the process outlives the server.
  const outFd = fs.openSync(PIPELINE_STDOUT_LOG, "a");
  const errFd = fs.openSync(PIPELINE_STDERR_LOG, "a");

  const child = spawn(process.execPath, [PIPELINE_ENTRYPOINT, "--loop", "--interval-seconds", String(safeIntervalSeconds)], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", outFd, errFd],
    detached: true   // survives server restart
  });

  fs.closeSync(outFd);
  fs.closeSync(errFd);

  child.unref(); // server exit won't kill the pipeline

  pipelineProcess = child;
  writePidFile(child.pid);

  setPipelineState({
    running: true,
    pid: child.pid,
    mode: "loop",
    interval_seconds: safeIntervalSeconds,
    started_at: nowLocalIso(),
    stop_requested_at: null,
    exit_code: null,
    signal: null,
    last_error: null
  });

  child.on("exit", (code, signal) => {
    const wasCurrent = pipelineProcess === child;
    if (wasCurrent) pipelineProcess = null;
    clearPidFile();

    const wasUserRequested = !!pipelineState.stop_requested_at;
    setPipelineState({
      running: false,
      pid: null,
      mode: "stopped",
      exit_code: code,
      signal,
      last_error: code && code !== 0 ? `Pipeline exited with code ${code}` : null
    });

    if (wasCurrent && !wasUserRequested) {
      const restartDelay = 30_000;
      console.log(`[server] Pipeline exited unexpectedly (code=${code}, signal=${signal}), restarting in ${restartDelay / 1000}s`);
      _pipelineRestartTimer = setTimeout(() => startPipelineProcess(safeIntervalSeconds), restartDelay);
    }
  });

  child.on("error", (err) => {
    if (pipelineProcess === child) pipelineProcess = null;
    clearPidFile();
    setPipelineState({ running: false, pid: null, mode: "stopped", last_error: err.message });
  });

  return getPipelineStatus();
}

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapTokenCandidates(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.tokens)) return payload.tokens;
  if (payload.token && typeof payload.token === "object") return [payload.token];
  return [payload];
}

function normalizeTokenMetadata(payload, address) {
  const candidate = unwrapTokenCandidates(payload).find((item) => item && typeof item === "object") || null;
  if (!candidate) return null;
  const currentPrice = asNumber(candidate.current_price, asNumber(candidate.priceUSD, asNumber(candidate.price_usd, asNumber(candidate.price, NaN))));
  return {
    contract_address: String(candidate.contract_address || candidate.address || address || "").toLowerCase(),
    symbol: candidate.symbol || candidate.ticker || null,
    name: candidate.name || candidate.token_name || candidate.display_name || candidate.title || null,
    icon_url: candidate.icon_url || candidate.icon || candidate.logo_url || candidate.image_url || candidate.token_icon_url || null,
    image_url: candidate.image_url || candidate.icon || candidate.logo_url || candidate.icon_url || candidate.token_image_url || null,
    current_price: Number.isFinite(currentPrice) ? currentPrice : null,
    price_usd: Number.isFinite(currentPrice) ? currentPrice : null
  };
}

async function fetchTokenMetadata(address) {
  const cleanAddress = String(address || "").trim().toLowerCase();
  if (!cleanAddress) return null;

  const cached = TOKEN_METADATA_CACHE.get(cleanAddress);
  if (cached && (Date.now() - cached.fetched_at) < TOKEN_METADATA_TTL_MS) {
    return cached.value;
  }

  const urls = [
    `https://e3d.ai/api/token-info/${encodeURIComponent(cleanAddress)}`,
    `https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?search=${encodeURIComponent(cleanAddress)}&limit=1&offset=0&hideNoCirc=1`
  ];

  for (const url of urls) {
    try {
      const startedAt = Date.now();
      logExternalApi("e3d_api_request", { url, pathname: new URL(url).pathname, query: Object.fromEntries(new URL(url).searchParams.entries()) });
      const response = await e3dRequest(url, {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      });
      const durationMs = Date.now() - startedAt;
      if (!response.ok) {
        logExternalApi("e3d_api_error", { url, pathname: new URL(url).pathname, status: response.status, duration_ms: durationMs });
        continue;
      }
      const payload = await readJsonResponse(response);
      const normalized = normalizeTokenMetadata(payload, cleanAddress);
      if (normalized) {
        logExternalApi("e3d_api_response", { url, pathname: new URL(url).pathname, status: response.status, duration_ms: durationMs });
        TOKEN_METADATA_CACHE.set(cleanAddress, { fetched_at: Date.now(), value: normalized });
        return normalized;
      }
      logExternalApi("e3d_api_response", { url, pathname: new URL(url).pathname, status: response.status, duration_ms: durationMs, bytes: payload ? JSON.stringify(payload).length : 0 });
    } catch {
      logExternalApi("e3d_api_error", { url, pathname: new URL(url).pathname, message: "request_failed" });
    }
  }

  TOKEN_METADATA_CACHE.set(cleanAddress, { fetched_at: Date.now(), value: null });
  return null;
}

async function enrichPortfolioPosition(pos) {
  const quantity = asNumber(pos.quantity, 0);
  const avgEntryPrice = asNumber(pos.avg_entry_price, 0);
  const costUsd = avgEntryPrice * quantity;
  const tokenMeta = await fetchTokenMetadata(pos.contract_address);
  const storedCurrentPrice = asNumber(pos.current_price, NaN);
  const storedCurrentValueUsd = asNumber(pos.current_value_usd, asNumber(pos.market_value_usd, 0));
  const fallbackPrice = quantity > 0
    ? (storedCurrentValueUsd > 0 ? storedCurrentValueUsd / quantity : avgEntryPrice)
    : avgEntryPrice;
  const currentPrice = asNumber(
    tokenMeta?.current_price,
    asNumber(
      tokenMeta?.price_usd,
      Number.isFinite(storedCurrentPrice) && storedCurrentPrice > 0 ? storedCurrentPrice : fallbackPrice
    )
  );
  const liveCurrentValueUsd = currentPrice > 0 ? currentPrice * quantity : 0;
  const currentValueUsd = asNumber(
    liveCurrentValueUsd,
    storedCurrentValueUsd > 0 ? storedCurrentValueUsd : costUsd
  );
  const openedAt = pos.opened_at || pos.purchased_at || pos.bought_at || pos.created_at || null;

  return {
    contract_address: pos.contract_address,
    symbol: tokenMeta?.symbol || pos.symbol || null,
    name: tokenMeta?.name || pos.name || pos.token?.name || pos.symbol || null,
    category: pos.category || "unknown",
    icon_url: tokenMeta?.icon_url || pos.icon_url || pos.token?.icon_url || null,
    image_url: tokenMeta?.image_url || pos.image_url || pos.token?.image_url || null,
    opened_at: openedAt,
    market_value_usd: currentValueUsd,
    current_value_usd: currentValueUsd,
    cost_usd: costUsd,
    score: pos.score,
    quantity,
    avg_entry_price: avgEntryPrice,
    current_price: currentPrice
  };
}

async function enrichSoldTrade(trade, review = null) {
  const quantity = asNumber(trade.quantity, 0);
  const salePrice = asNumber(trade.price, 0);
  const proceedsUsd = asNumber(trade.proceeds_usd, salePrice * quantity);
  const costUsd = asNumber(trade.cost_portion_usd, 0);
  const avgEntryPrice = quantity > 0 ? costUsd / quantity : asNumber(trade.avg_entry_price, 0);
  const tokenMeta = await fetchTokenMetadata(trade.contract_address);

  return {
    contract_address: trade.contract_address,
    trade_id: trade.trade_id || null,
    order_id: trade.order_id || trade.order_lifecycle?.order_id || null,
    order_ids: Array.isArray(trade.order_ids) ? trade.order_ids : (trade.order_id ? [trade.order_id] : []),
    risk_decision_id: trade.risk_decision_id || trade.order_lifecycle?.risk_decision_id || trade.paper_trade_ticket?.risk_decision_id || null,
    risk_decision_ref: trade.risk_decision_ref || trade.paper_trade_ticket?.risk_decision_ref || null,
    position_id: trade.position_id || null,
    symbol: tokenMeta?.symbol || trade.symbol || null,
    name: tokenMeta?.name || trade.name || trade.symbol || null,
    category: trade.category || "unknown",
    icon_url: tokenMeta?.icon_url || trade.icon_url || null,
    image_url: tokenMeta?.image_url || trade.image_url || null,
    opened_at: trade.opened_at || null,
    sold_at: trade.ts || null,
    trade_lifecycle: trade.trade_lifecycle || "close",
    market_value_usd: proceedsUsd,
    current_value_usd: proceedsUsd,
    cost_usd: costUsd,
    pnl_usd: asNumber(trade.pnl_usd, proceedsUsd - costUsd),
    score: trade.score,
    quantity,
    avg_entry_price: avgEntryPrice,
    current_price: salePrice,
    review
  };
}

function tryLoadPortfolioFromMongo() {
  try {
    const script = `
      const dbName = process.env.MONGO_DATABASE_NAME || ${JSON.stringify(MONGO_DATABASE_NAME)};
      const dbRef = db.getSiblingDB(dbName);
      const doc = dbRef.portfolio_state.findOne({ _id: "current" });
      if (!doc) {
        print(JSON.stringify(null));
      } else {
        delete doc._id;
        print(JSON.stringify(doc));
      }
    `;

    const output = runShell("docker", [
      "exec",
      "-i",
      MONGO_CONTAINER_NAME,
      "mongosh",
      "--quiet"
    ], {
      input: script,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        MONGO_DATABASE_NAME
      }
    }).trim();

    if (!output || output === "null") return null;
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function tryLoadEventsFromClickHouse() {
  try {
    const query = `
      SELECT
        event_id,
        schema_version,
        ts,
        event_type,
        actor,
        pipeline_run_id,
        cycle_id,
        cycle_index,
        market_regime,
        candidate_id,
        position_id,
        trade_id,
        payload
      FROM ${CLICKHOUSE_DATABASE_NAME}.${CLICKHOUSE_TABLE_NAME}
      ORDER BY ts DESC
      LIMIT 250
      FORMAT JSONEachRow
    `;
    const chHeaders2 = CLICKHOUSE_USER ? { Authorization: `Basic ${Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString("base64")}` } : {};
    const response = fetch(`${CLICKHOUSE_HTTP_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE_NAME)}&query=${encodeURIComponent(query)}`, {
      method: "POST", headers: chHeaders2
    });

    if (!response.ok) return null;
    return response.text().then((text) => {
      const rows = text.trim().split(/\n+/).filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
      return rows;
    });
  } catch {
    return null;
  }
}

async function loadPortfolioState() {
  const fromMongo = tryLoadPortfolioFromMongo();
  if (fromMongo) return fromMongo;
  return readJsonFile(PORTFOLIO_FILE, DEFAULT_PORTFOLIO_STATE);
}

function normalizeEvent(record) {
  return {
    id: record.event_id || `${record.ts}-${record.event_type}`,
    ts: record.ts,
    type: record.event_type,
    actor: record.actor,
    candidate_id: record.candidate_id || null,
    position_id: record.position_id || null,
    trade_id: record.trade_id || null,
    market_regime: record.market_regime || null,
    summary: record.payload ? safeSummary(record.payload) : null,
    raw: record
  };
}

function safeSummary(payload) {
  try {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    return {
      decision: parsed.executor_decision || parsed.decision || parsed.outcome_label || null,
      risk_decision_id: parsed.risk_decision_id || parsed.risk_decision?.risk_decision_id || null,
      symbol: parsed?.token?.symbol || parsed?.symbol || null,
      side: parsed.side || null,
      trade_lifecycle: parsed.trade_lifecycle || null,
      pnl_usd: parsed.pnl_usd ?? null,
      reason_summary: parsed.reason_summary || parsed.short_summary || parsed.summary || null
    };
  } catch {
    return null;
  }
}

async function loadActivity() {
  const pipeline = readJsonLines(PIPELINE_LOG, 200);
  const training = readJsonLines(TRAINING_EVENT_LOG, 250);

  let clickhouse = [];
  try {
    const query = `
      SELECT
        event_id,
        schema_version,
        ts,
        event_type,
        actor,
        pipeline_run_id,
        cycle_id,
        cycle_index,
        market_regime,
        candidate_id,
        position_id,
        trade_id,
        payload
      FROM ${CLICKHOUSE_DATABASE_NAME}.${CLICKHOUSE_TABLE_NAME}
      ORDER BY ts DESC
      LIMIT 250
      FORMAT JSONEachRow
    `;
    const chHeaders3 = CLICKHOUSE_USER ? { Authorization: `Basic ${Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString("base64")}` } : {};
    const response = await fetch(`${CLICKHOUSE_HTTP_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE_NAME)}&query=${encodeURIComponent(query)}`, {
      method: "POST", headers: chHeaders3
    });
    if (response.ok) {
      const text = await response.text();
      clickhouse = text.trim().split(/\n+/).filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean).map((row) => ({
        id: row.event_id,
        ts: row.ts,
        type: row.event_type,
        actor: row.actor,
        candidate_id: row.candidate_id || null,
        position_id: row.position_id || null,
        trade_id: row.trade_id || null,
        market_regime: row.market_regime || null,
        summary: safeSummary(row.payload),
        raw: row,
        source: "clickhouse"
      }));
    }
  } catch {
    clickhouse = [];
  }

  const normalizedTraining = training.map((record) => normalizeEvent(record)).map((row) => ({ ...row, source: "jsonl" }));
  const recentPipeline = pipeline.map((record) => ({
    id: `${record.ts}-${record.stage}`,
    ts: record.ts,
    type: record.stage,
    actor: "pipeline",
    summary: record.data ? summarizePipelineStage(record.stage, record.data) : null,
    raw: record,
    source: "pipeline"
  }));

  return {
    events: [...clickhouse, ...normalizedTraining, ...recentPipeline]
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
      .slice(0, 250),
    pipeline,
    training,
    clickhouse
  };
}

function groupPipelineIntoCycles(entries) {
  const cycles = [];
  let cur = null;
  for (const e of entries) {
    if (e.stage === "scout") {
      if (cur) cycles.push(cur);
      cur = { ts: e.ts, scout: e.data || {}, harvest: null, risk_approved: null, risk_rejected: null, market_regime: null, stats: null };
    } else if (cur) {
      if (e.stage === "harvest") cur.harvest = e.data || {};
      else if (e.stage === "risk_approved") cur.risk_approved = Array.isArray(e.data) ? e.data : [];
      else if (e.stage === "risk_rejected") cur.risk_rejected = Array.isArray(e.data) ? e.data : [];
      else if (e.stage === "market_regime") cur.market_regime = e.data || {};
      else if (e.stage === "stats") cur.stats = e.data || {};
    }
  }
  if (cur) cycles.push(cur);
  return cycles.reverse();
}

function summarizePipelineStage(stage, data) {
  if (stage === "market_regime") {
    return {
      regime: data?.regime || null,
      approved_count: data?.approved_count ?? null,
      average_change_24h_pct: data?.average_change_24h_pct ?? null
    };
  }
  if (stage === "buy_trades" || stage === "sell_trades" || stage === "rotations") {
    return { count: Array.isArray(data) ? data.length : 0 };
  }
  if (stage === "stats") {
    return {
      equity_usd: data?.equity_usd ?? null,
      realized_pnl_usd: data?.realized_pnl_usd ?? null,
      unrealized_pnl_usd: data?.unrealized_pnl_usd ?? null
    };
  }
  return null;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function serveFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const readRequestJson = async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return {};
    return JSON.parse(text);
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Access-Control-Max-Age": "86400"
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    const [portfolio, activity] = await Promise.all([loadPortfolioState(), loadActivity()]);
    sendJson(res, 200, {
      ok: true,
      portfolio_loaded: Boolean(portfolio),
      activity_events: activity.events.length,
      mongo_container: MONGO_CONTAINER_NAME,
      clickhouse_url: CLICKHOUSE_HTTP_URL,
      e3d_auth: getAuthStatus(),
      pipeline: getPipelineStatus()
    });
    return;
  }

  if (url.pathname === "/funnel" && req.method === "GET") {
    try {
      const report = buildFunnelRollup({
        window: url.searchParams.get("window") || "24h",
        cycleId: url.searchParams.get("cycle_id") || null
      });
      sendJson(res, 200, report);
    } catch (err) {
      if (err?.statusCode === 400 && err?.details) {
        sendJson(res, 400, err.details);
      } else {
        throw err;
      }
    }
    return;
  }

  if (url.pathname === "/attribution" && req.method === "GET") {
    try {
      const report = await buildAttributionReport({
        window: url.searchParams.get("window") || "7d"
      });
      sendJson(res, 200, report);
    } catch (err) {
      if (err?.statusCode === 400 && err?.details) {
        sendJson(res, 400, err.details);
      } else {
        throw err;
      }
    }
    return;
  }

  if (url.pathname === "/api/pipeline/status") {
    sendJson(res, 200, getPipelineStatus());
    return;
  }

  if (url.pathname === "/api/e3d/auth/status") {
    sendJson(res, 200, getAuthStatus());
    return;
  }

  if (url.pathname === "/api/e3d/auth/connect" && req.method === "POST") {
    const body = await readRequestJson();
    const mode = String(body.mode || body.auth_mode || "").trim().toLowerCase();

    try {
      if (mode === "api_key") {
        const apiKey = String(body.apiKey || body.api_key || body.key || "").trim();
        const result = await connectWithApiKey(apiKey);
        sendJson(res, 200, result);
        return;
      }

      if (mode === "login") {
        const username = String(body.username || body.email || "").trim();
        const password = String(body.password || "").trim();
        const result = await connectWithLogin({ username, password });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 400, { ok: false, error: "INVALID_AUTH_MODE" });
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err?.message || "AUTH_CONNECT_FAILED"
      });
    }
    return;
  }

  if (url.pathname === "/api/e3d/auth/clear" && req.method === "POST") {
    clearStoredAuth();
    sendJson(res, 200, {
      ok: true,
      auth: getAuthStatus()
    });
    return;
  }

  if (url.pathname === "/api/e3d/decision-layer/summary") {
    const E3D_API_BASE = process.env.E3D_API_BASE_URL || "https://e3d.ai/api";
    const [actionsRes, outcomesRes] = await Promise.allSettled([
      e3dRequest(`${E3D_API_BASE}/actions/summary`, { method: "GET", headers: { Accept: "application/json" } }).then(r => r.ok ? r.json() : null).catch(() => null),
      e3dRequest(`${E3D_API_BASE}/outcomes/summary`, { method: "GET", headers: { Accept: "application/json" } }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    sendJson(res, 200, {
      actions:  actionsRes.status === "fulfilled"  ? actionsRes.value  : null,
      outcomes: outcomesRes.status === "fulfilled" ? outcomesRes.value : null,
    });
    return;
  }

  if (url.pathname === "/api/pipeline/start" && req.method === "POST") {
    const body = await readRequestJson();
    const intervalSeconds = body.interval_seconds ?? body.intervalSeconds ?? 300;
    const operator = operatorContextFromBody(body, "dashboard pipeline start request");
    recordOperatorAction({
      action_type: "pipeline_start",
      actor: operator.actor,
      role: operator.role,
      reason: operator.reason,
      resource: "pipeline",
      previous_state: getPipelineStatus(),
      new_state: { requested_mode: "loop", interval_seconds: intervalSeconds },
      metadata: { source: "dashboard_api" }
    });
    const status = startPipelineProcess(intervalSeconds);
    sendJson(res, 200, status);
    return;
  }

  if (url.pathname === "/api/pipeline/stop" && req.method === "POST") {
    const body = await readRequestJson();
    const operator = operatorContextFromBody(body, "dashboard pipeline stop request");
    const previous = getPipelineStatus();
    const stopped = stopPipelineProcess();
    recordOperatorAction({
      action_type: "pipeline_stop",
      actor: operator.actor,
      role: operator.role,
      reason: operator.reason,
      resource: "pipeline",
      previous_state: previous,
      new_state: getPipelineStatus(),
      metadata: { source: "dashboard_api", stopped }
    });
    sendJson(res, 200, {
      ok: stopped,
      pipeline: getPipelineStatus()
    });
    return;
  }

  if (url.pathname === "/api/reset-all" && req.method === "POST") {
    const body = await readRequestJson();
    const operator = operatorContextFromBody(body, "dashboard reset request");
    const previous = getPipelineStatus();
    const result = clearSystemState();
    recordOperatorAction({
      action_type: "reset_request",
      actor: operator.actor,
      role: operator.role,
      reason: operator.reason,
      resource: "system_state",
      previous_state: previous,
      new_state: { reset_at: nowLocalIso(), pipeline: getPipelineStatus() },
      metadata: { source: "dashboard_api", ...result }
    });
    sendJson(res, 200, {
      ok: true,
      reset_at: nowLocalIso(),
      ...result,
      pipeline: getPipelineStatus()
    });
    return;
  }

  if (url.pathname === "/api/portfolio") {
    const portfolio = await loadPortfolioState();
    sendJson(res, 200, portfolio);
    return;
  }

  if (url.pathname === "/api/activity") {
    const activity = await loadActivity();
    sendJson(res, 200, activity);
    return;
  }

  if (url.pathname === "/api/reports" && req.method === "GET") {
    const reports = listReportFiles().slice(0, 50).map(({ filePath, report }) => summarizeReport(report, filePath));
    sendJson(res, 200, reports);
    return;
  }

  if (url.pathname === "/api/performance/latest" && req.method === "GET") {
    const latest = listPerformanceReportFiles()[0]?.report || null;
    sendJson(res, 200, latest ? summarizePerformanceReport(latest) : null);
    return;
  }

  if (url.pathname === "/api/performance/reports" && req.method === "GET") {
    const reports = listPerformanceReportFiles().slice(0, 30).map(({ report }) => summarizePerformanceReport(report));
    sendJson(res, 200, reports);
    return;
  }

  if (url.pathname === "/api/backtests/latest" && req.method === "GET") {
    const latest = listBacktestReportFiles()[0]?.report || null;
    sendJson(res, 200, latest ? summarizeBacktestReport(latest) : null);
    return;
  }

  if (url.pathname === "/api/backtests/reports" && req.method === "GET") {
    const reports = listBacktestReportFiles().slice(0, 30).map(({ report }) => summarizeBacktestReport(report));
    sendJson(res, 200, reports);
    return;
  }

  if (url.pathname === "/api/promotions/latest" && req.method === "GET") {
    const latest = listPromotionReportFiles()[0]?.report || null;
    sendJson(res, 200, latest ? summarizePromotionReport(latest) : null);
    return;
  }

  if (url.pathname === "/api/promotions/readiness" && req.method === "GET") {
    const resolvedStrategy = resolveReadinessStrategyVersion(url.searchParams);
    if (resolvedStrategy.error) {
      sendJson(res, 400, {
        ok: false,
        error: resolvedStrategy.error.code,
        detail: resolvedStrategy.error.detail
      });
      return;
    }

    sendJson(res, 200, buildReadinessApiResponse({
      strategyVersion: resolvedStrategy.strategyVersion,
      readinessReportsDir: REPORTS_DIR,
      promotionReportsDir: PROMOTION_REPORTS_DIR
    }));
    return;
  }

  if (url.pathname === "/api/promotions/reports" && req.method === "GET") {
    const reports = listPromotionReportFiles().slice(0, 30).map(({ report }) => summarizePromotionReport(report));
    sendJson(res, 200, reports);
    return;
  }

  if (url.pathname === "/api/attribution/latest" && req.method === "GET") {
    const latest = listAttributionReportFiles()[0]?.report || null;
    sendJson(res, 200, latest ? summarizeAttributionReport(latest) : null);
    return;
  }

  if (url.pathname === "/api/attribution/reports" && req.method === "GET") {
    const reports = listAttributionReportFiles().slice(0, 30).map(({ report }) => summarizeAttributionReport(report));
    sendJson(res, 200, reports);
    return;
  }

  if (url.pathname === "/api/operations/latest" && req.method === "GET") {
    const latest = listOperationsReportFiles()[0]?.report || null;
    if (latest) {
      sendJson(res, 200, latest);
      return;
    }
    const report = generateOperationsMonitorReport({ writeReport: false, writeEvents: false });
    recordOperatorAction({
      action_type: "report_generation",
      actor: "dashboard_local",
      role: "viewer",
      reason: "generated in-memory operations monitor report for dashboard request",
      resource: "operations_report",
      new_state: { report_id: report.report_id, report_file: null },
      report_id: report.report_id,
      metadata: { source: "dashboard_api", write_performed: false }
    });
    sendJson(res, 200, report);
    return;
  }

  if (url.pathname === "/api/operations/reports" && req.method === "GET") {
    const reports = listOperationsReportFiles().slice(0, 30).map(({ report }) => summarizeOperationsReport(report));
    sendJson(res, 200, reports);
    return;
  }

  if (url.pathname === "/api/reconciliation/latest" && req.method === "GET") {
    const latest = listReconciliationReportFiles()[0]?.report || null;
    sendJson(res, 200, latest ? summarizeReconciliationReport(latest) : null);
    return;
  }

  if (url.pathname === "/api/reconciliation/reports" && req.method === "GET") {
    const reports = listReconciliationReportFiles().slice(0, 30).map(({ report }) => summarizeReconciliationReport(report));
    sendJson(res, 200, reports);
    return;
  }

  if (url.pathname === "/api/incidents" && req.method === "GET") {
    const incidents = listIncidentFiles().slice(0, 100).map(({ report }) => report);
    sendJson(res, 200, incidents);
    return;
  }

  if (url.pathname === "/api/trade-reviews" && req.method === "GET") {
    sendJson(res, 200, listTradeReviews().slice(0, 200));
    return;
  }

  if (url.pathname === "/api/retraining/readiness" && req.method === "GET") {
    sendJson(res, 200, readJsonFile(RETRAINING_READINESS_FILE, null));
    return;
  }

  if (url.pathname === "/api/operations/state" && req.method === "GET") {
    sendJson(res, 200, summarizeOperationsLatest());
    return;
  }

  if (url.pathname === "/api/custody/status" && req.method === "GET") {
    const portfolio = await loadPortfolioState();
    sendJson(res, 200, evaluateLiveCapabilityStatus({ mode: url.searchParams.get("mode") || "paper", portfolio }));
    return;
  }

  if (url.pathname === "/api/audit/status" && req.method === "GET") {
    const portfolio = await loadPortfolioState();
    const mode = url.searchParams.get("mode") || "paper";
    sendJson(res, 200, {
      permission_policy: buildOperatorPermissionPolicy({
        action_type: url.searchParams.get("action_type") || "mode_change_request",
        mode,
        actor: url.searchParams.get("actor") || "dashboard_local",
        role: url.searchParams.get("role") || "viewer",
        reason: url.searchParams.get("reason") || null,
        portfolio
      }),
      current_mode: getPipelineStatus().mode,
      pipeline: getPipelineStatus(),
      recent_operator_actions: readOperatorActionRecords({ maxRecords: 50 })
    });
    return;
  }

  if (url.pathname === "/api/professional/summary" && req.method === "GET") {
    sendJson(res, 200, await buildProfessionalDashboardSummary());
    return;
  }

  if (url.pathname.startsWith("/api/reports/") && req.method === "GET") {
    const reportId = decodeURIComponent(url.pathname.slice("/api/reports/".length)).trim();
    const match = [
      ...listReportFiles(),
      ...listPerformanceReportFiles(),
      ...listBacktestReportFiles(),
      ...listPromotionReportFiles(),
      ...listAttributionReportFiles(),
      ...listOperationsReportFiles(),
      ...listReconciliationReportFiles()
    ].find(({ report }) => report?.report_id === reportId);
    if (!match) {
      sendJson(res, 404, { ok: false, error: "REPORT_NOT_FOUND" });
      return;
    }
    sendJson(res, 200, match.report);
    return;
  }

  if (url.pathname === "/api/pipeline-log") {
    // Return recent pipeline log entries filtered to stages relevant for the network debugger:
    // API calls, LLM calls, and key agent decision events.
    const DEBUGGER_STAGES = new Set([
      "e3d_api_response", "e3d_api_error", "e3d_api_budget_exceeded",
      "llm_request", "llm_response", "llm_error",
      "scout", "harvest",
      "executor_buy", "executor_exit",
      "sell_trades", "buy_trades",
      "quant_context", "scout_flow_enrichment",
      "scout_candidate_dropped",
    ]);
    const all = readJsonLines(PIPELINE_LOG, 2000);
    const filtered = all.filter(e => DEBUGGER_STAGES.has(e.stage)).slice(-400);
    sendJson(res, 200, { entries: filtered });
    return;
  }

  if (url.pathname === "/api/run-ledger") {
    const limit = Math.min(Number(url.searchParams?.get("limit") || 100), 500);
    const since = url.searchParams?.get("since") || null;
    const entries = readJsonLines(RUN_LEDGER_LOG, limit);
    const filtered = since
      ? entries.filter(e => e?.cycle_ts && e.cycle_ts >= since)
      : entries;
    sendJson(res, 200, { entries: filtered.slice(-limit) });
    return;
  }

  if (url.pathname === "/api/cycles") {
    const pipeline = readJsonLines(PIPELINE_LOG, 600);
    const cycles = groupPipelineIntoCycles(pipeline);
    sendJson(res, 200, { cycles: cycles.slice(0, 25) });
    return;
  }

  if (url.pathname === "/api/summary") {
    const [portfolio, activity] = await Promise.all([loadPortfolioState(), loadActivity()]);
    const positions = Object.values(portfolio.positions || {});
    const historyTrades = Array.isArray(portfolio.closed_trades) ? [...portfolio.closed_trades].reverse() : [];
    const reviewIndex = indexTradeReviews();
    // Sequential enrichment — concurrent Promise.all causes a request burst that
    // exhausts the API rate limit and causes 429s in the pipeline stories call.
    const enrichedPositions = [];
    for (const pos of positions) enrichedPositions.push(await enrichPortfolioPosition(pos));
    const enrichedHistory = [];
    for (const trade of historyTrades.slice(0, 20)) enrichedHistory.push(await enrichSoldTrade(trade, reviewIndex.get(trade.trade_id) || null));
    const unrealizedPnlUsd = enrichedPositions.reduce((sum, pos) => {
      const currentValueUsd = asNumber(pos?.current_value_usd, asNumber(pos?.market_value_usd, 0));
      const costUsd = asNumber(pos?.cost_usd, 0);
      return sum + (currentValueUsd - costUsd);
    }, 0);
    const currentMarketValueUsd = enrichedPositions.reduce((sum, pos) => sum + asNumber(pos?.current_value_usd, asNumber(pos?.market_value_usd, 0)), 0);
    const equityUsd = asNumber(portfolio.cash_usd, 0) + currentMarketValueUsd;
    sendJson(res, 200, {
      portfolio: {
        cash_usd: portfolio.cash_usd || 0,
        equity_usd: equityUsd,
        realized_pnl_usd: portfolio.stats?.realized_pnl_usd || 0,
        unrealized_pnl_usd: unrealizedPnlUsd,
        market_regime: portfolio.stats?.market_regime || "unknown",
        open_positions: positions.length,
        positions: enrichedPositions,
        history: enrichedHistory
      },
      activity: activity.events.slice(0, 40)
    });
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    const filePath = path.join(DASHBOARD_DIR, url.pathname.replace("/assets/", ""));
    const ext = path.extname(filePath);
    const contentType = ext === ".js" ? "application/javascript; charset=utf-8" : ext === ".css" ? "text/css; charset=utf-8" : "text/plain; charset=utf-8";
    serveFile(res, filePath, contentType);
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    serveFile(res, path.join(DASHBOARD_DIR, "index.html"), "text/html; charset=utf-8");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

// ── WebSocket server ─────────────────────────────────────────────────────────
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wsClients = new Set();

function wsFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x81; // FIN + text opcode
  if (len < 126) {
    header[1] = len;
  } else if (len < 65536) {
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsSend(socket, data) {
  try { socket.write(wsFrame(JSON.stringify(data))); } catch { wsClients.delete(socket); }
}

function wsBroadcast(data) {
  for (const socket of wsClients) wsSend(socket, data);
}

function wsPushCycles(socket) {
  const cycles = groupPipelineIntoCycles(readJsonLines(PIPELINE_LOG, 600));
  wsSend(socket, { type: "cycles", cycles: cycles.slice(0, 25) });
}

function wsHandleUpgrade(req, socket) {
  if (req.url !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }

  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  socket.on("data", (buf) => {
    if (buf.length >= 2 && (buf[0] & 0x0f) === 8) { wsClients.delete(socket); socket.destroy(); }
  });
  socket.on("close", () => wsClients.delete(socket));
  socket.on("error", () => wsClients.delete(socket));

  wsClients.add(socket);
  wsPushCycles(socket); // send current state immediately on connect
}

export {
  buildProfessionalDashboardSummary,
  buildReadinessApiResponse,
  resolveReadinessStrategyVersion,
  summarizePromotionReport
};

if (IS_MAIN_MODULE) {
  // Watch log dir so we catch both file creation and appends
  let wsBroadcastTimer = null;
  fs.watch(LOG_DIR, { persistent: false }, (_, filename) => {
    if (filename !== "pipeline.jsonl") return;
    clearTimeout(wsBroadcastTimer);
    wsBroadcastTimer = setTimeout(() => {
      const cycles = groupPipelineIntoCycles(readJsonLines(PIPELINE_LOG, 600));
      wsBroadcast({ type: "cycles", cycles: cycles.slice(0, 25) });
    }, 400);
  });

  // ── HTTP server ─────────────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
  });

  server.on("upgrade", wsHandleUpgrade);

  const recovered = recoverPipelineIfRunning();
  if (!recovered && process.env.AUTO_START_PIPELINE !== "false") {
    // No surviving pipeline child to reattach to — spawn a fresh one so a
    // server restart doesn't leave the cycle loop dead.
    const intervalSeconds = Number(process.env.AUTO_START_PIPELINE_INTERVAL_SECONDS) || 300;
    console.log(`[server] No pipeline recovered — auto-starting (interval ${intervalSeconds}s)`);
    startPipelineProcess(intervalSeconds);
  }
  writeDashboardHeartbeat();
  const dashboardHeartbeatTimer = setInterval(writeDashboardHeartbeat, 30000);
  dashboardHeartbeatTimer.unref?.();

  server.listen(PORT, HOST, () => {
    writeDashboardHeartbeat();
    console.log(`Dashboard server running at http://${HOST}:${PORT}`);
  });
}
