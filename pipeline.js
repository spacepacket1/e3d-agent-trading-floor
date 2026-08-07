import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { buildCurlAuthArgs } from "./e3dAuthClient.js";
import { buildCycleQuantContext, enrichCandidateQuant, batchEnrichTokenFlow } from "./marketData.js";
import { createOrderLifecycleRecord } from "./scripts/orderLifecycle.js";
import { evaluateRiskDecision, buildRiskDecisionRef } from "./scripts/riskEngine.js";
import { buildTokenRiskScan, buildTokenRiskScanRef } from "./scripts/tokenRiskScanner.js";
import { buildLiquidityExecutionControls } from "./scripts/liquidityExecutionControls.js";
import { buildMarketDataQuality, buildMarketDataQualityRef } from "./scripts/marketDataQuality.js";
import { recordOperatorAction } from "./scripts/auditTrail.js";
import {
  buildEvidenceDiagnosticsEvent,
  buildHarvestEvidenceDiagnostics,
  buildScoutEvidenceDiagnostics
} from "./scripts/evidenceDiagnostics.js";
import {
  buildHarvestEvidencePacket,
  buildScoutEvidencePacket,
  rankScoutPacket,
  SCOUT_EVIDENCE_SHORTLIST_DEFAULT_LIMIT,
  SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT
} from "./scripts/evidencePackets.js";
import { fetchMapsContext } from "./scripts/mapsClient.js";
import { buildMapsNavigatorPrecheck } from "./scripts/mapsHarvestPrecheck.js";
import { applyMapsRouteScoreAdjustment, buildScoutMapsRoute } from "./scripts/mapsScoutRoute.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env so env vars are always fresh regardless of how this process was spawned.
try {
  const envLines = fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n");
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key) process.env[key] = val;
  }
} catch (_) {}

const LOG_DIR = path.join(__dirname, "logs");
const REPORTS_DIR = path.join(__dirname, "reports");
const PORTFOLIO_FILE = path.join(__dirname, "portfolio.json");
const PIPELINE_LOG = path.join(LOG_DIR, "pipeline.jsonl");
const AGENT_RAW_LOG = path.join(LOG_DIR, "agent-raw.jsonl");
const TRAINING_EVENT_LOG = path.join(LOG_DIR, "training-events.jsonl");
const TRADE_REVIEWS_LOG = path.join(LOG_DIR, "trade-reviews.jsonl");
const RUN_LEDGER_LOG = path.join(LOG_DIR, "run-ledger.jsonl");
const RETRAINING_READINESS_FILE = path.join(REPORTS_DIR, "retraining-readiness.json");
const TRAINING_EVENT_SCHEMA_VERSION = "1.0";
const MONGO_CONTAINER_NAME = process.env.E3D_MONGO_CONTAINER || "e3d-mongo";
const MONGO_DATABASE_NAME = process.env.E3D_MONGO_DATABASE || "e3d";
const CLICKHOUSE_HTTP_URL = process.env.AWS_E3D_CLICKHOUSE_HTTP_URL || process.env.E3D_CLICKHOUSE_HTTP_URL || "http://127.0.0.1:8123";
const CLICKHOUSE_DATABASE_NAME = process.env.AWS_E3D_CLICKHOUSE_DATABASE || process.env.E3D_CLICKHOUSE_DATABASE || "e3d";
const CLICKHOUSE_TABLE_NAME = process.env.E3D_CLICKHOUSE_TABLE || "training_events";
const CLICKHOUSE_USER = process.env.AWS_E3D_CLICKHOUSE_USER || process.env.E3D_CLICKHOUSE_USER || "";
const CLICKHOUSE_PASSWORD = process.env.AWS_E3D_CLICKHOUSE_PASSWORD || process.env.E3D_CLICKHOUSE_PASSWORD || "";
const E3D_API_BASE_URL = process.env.E3D_API_BASE_URL || "https://e3d.ai/api";
const E3D_TOKENS_DATA_SOURCE = Number(process.env.E3D_TOKENS_DATA_SOURCE || 1);
const E3D_TRANSACTIONS_DATA_SOURCE = Number(process.env.E3D_TRANSACTIONS_DATA_SOURCE || 1);
const PIPELINE_DEBUG_MODE = ["1", "true", "yes", "on"].includes(String(process.env.PIPELINE_DEBUG_MODE || "").trim().toLowerCase());
const E3D_DOSSIER_CACHE_TTL_MS = 10 * 60 * 1000;
const E3D_DOSSIER_MAX_POSITIONS = 5;
const E3D_DOSSIER_MAX_STORIES = 4;
const E3D_DOSSIER_MAX_COUNTERPARTIES = 5;
const PAPER_ORDER_STRATEGY_VERSION = process.env.E3D_STRATEGY_VERSION || "paper-pipeline-v1";
const PAPER_FILL_MODEL_VERSION = "paper-portfolio-fill-v1";
const HARVEST_EVIDENCE_PACKET_MAX_ITEMS = 8;
const MAPS_CLOSED_ROUTE_PENALTY = Number(process.env.MAPS_CLOSED_ROUTE_PENALTY || 0.25);
const MAPS_STRENGTHENING_ROUTE_BONUS = Number(process.env.MAPS_STRENGTHENING_ROUTE_BONUS || 0.10);
const MAPS_MIN_CONFIDENCE_THRESHOLD = Number(process.env.MAPS_MIN_CONFIDENCE_THRESHOLD || 0.50);

// Rate-limit budget management.
// Tiers: free=100/day @5000ms, premium=1000/day @1000ms, enterprise=100000/day @10ms
// Enterprise-safe: 500ms between requests, 90000/day cap (leaves 10% buffer).
// Note: /stories has a separate burst limit — avoid hammering it back-to-back.
const E3D_REQUEST_MIN_INTERVAL_MS = Number(process.env.E3D_REQUEST_MIN_INTERVAL_MS || 500);
const E3D_REQUEST_DAILY_BUDGET = Number(process.env.E3D_REQUEST_DAILY_BUDGET || 90000);
let _e3dRequestCount = 0;
let _e3dLastRequestAt = 0;
const E3D_DOSSIER_CACHE = new Map();
const E3D_API_DEBUG = process.env.E3D_API_DEBUG === "1" || process.env.E3D_DEBUG === "1";
const E3D_ACTIONS_MIN_CONFIDENCE     = Number(process.env.E3D_ACTIONS_MIN_CONFIDENCE || 0.40);
const E3D_ACTIONS_MAX_RISK           = Number(process.env.E3D_ACTIONS_MAX_RISK || 0.65);
const E3D_ACTIONS_ENRICH_LIMIT       = Number(process.env.E3D_ACTIONS_ENRICH_LIMIT || 12);
const E3D_AVOID_RISK_FAST_PATH_FLOOR = Number(process.env.E3D_AVOID_RISK_FAST_PATH_FLOOR || 0.65);
let _cycleE3dActions = [];
let ACTIVE_TRAINING_CONTEXT = null;
const LAST_LLM_META = new Map();
let DATABASE_SCHEMA_READY = false;

const HARVEST_EXIT_RISK_TYPES = ["LIQUIDITY_DRAIN", "WASH_TRADE", "SPREAD_WIDENING", "MOMENTUM_DIVERGENCE", "EXCHANGE_FLOW", "LOOP",
  "SECURITY_RISK", "RUG_LIQUIDITY_PULL", "TREASURY_DISTRIBUTION", "CONCENTRATION_SHIFT", "VOLUME_PROFILE_ANOMALY"];
const HARVEST_HOLD_CONFIRM_TYPES = ["ACCUMULATION", "SMART_MONEY", "SMART_MONEY_LEADER", "FLOW", "CLUSTER", "STAGING", "FUNNEL"];
const HARVEST_PUMP_EXHAUSTION_TYPES = ["MOVER", "SURGE"];

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const SETTINGS_DEFAULTS = {
  paper_mode: true,
  initial_cash_usd: 100000,
  max_open_positions: 8,
  max_position_pct: 0.10,              // 10% of equity max per position
  risk_per_trade_pct: 0.015,           // 1.5% default new allocation
  min_trade_usd: 250,
  max_buys_per_cycle: 2,
  max_rotations_per_cycle: 1,
  rotation_threshold: 10,              // score delta needed to rotate
  rotation_sell_fraction: 0.50,        // rotate 50% of weakest position
  cooldown_hours_after_exit: 12,
  category_cap_pct: 0.30,              // 30% max category exposure
  reject_fraud_risk_gte: 35,
  target_partial_pct: 0.25,
  age_decay_per_day: 0.75,             // score penalty per day held
  recent_performance_window_hours: 24,
  scout_max_candidates: 6,
  fee_bps_per_side: 12.5,
  max_mark_deviation_ratio: 5,         // reject a position mark that deviates >5x from the e3d anchor
  max_source_price_divergence_ratio: 3,        // general band: drop a candidate whose e3d price diverges >3x from an independent feed
  max_source_price_divergence_ratio_pegged: 1.25, // peg-sensitive tokens (stables/FX/soft-pegs): tolerate at most ±25% across sources
  require_independent_price_below_liquidity_usd: 250000 // below this liquidity, refuse to trade without an independent price (fail closed)
};

function nowIso() {
  const date = new Date();
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const minutes = String(absMinutes % 60).padStart(2, "0");
  const local = new Date(date.getTime() + offsetMinutes * 60000);
  return `${local.toISOString().slice(0, 19)}${sign}${hours}:${minutes}`;
}

function formatReportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}

function nowMs() {
  return Date.now();
}

function log(stage, data) {
  fs.appendFileSync(
    PIPELINE_LOG,
    JSON.stringify({ ts: nowIso(), stage, data }) + "\n"
  );
}

function logAgentRaw(entry = {}) {
  fs.appendFileSync(
    AGENT_RAW_LOG,
    JSON.stringify({ ts: nowIso(), ...entry }) + "\n"
  );
}

function setLastLLMMeta(agent, meta) {
  if (!agent) return;
  LAST_LLM_META.set(agent, { ...(meta || {}) });
}

function getLastLLMMeta(agent) {
  return LAST_LLM_META.get(agent) ? { ...LAST_LLM_META.get(agent) } : null;
}

function runShell(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
}

function buildHarvestMapsPrecheckBlock(entries = []) {
  const lines = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const precheckLines = Array.isArray(entry?.maps_precheck?.lines) ? entry.maps_precheck.lines : [];
    if (!precheckLines.length) continue;
    lines.push(`Position ${entry.symbol || entry.address || "unknown"}:`);
    lines.push(...precheckLines);
  }
  if (!lines.length) return [];
  return ["--- MAPS NAVIGATOR PRE-CHECKS ---", ...lines];
}

function computeScoutThesisSignalScore(candidate = null, thesis = null, action = null) {
  const actionScore = Number(action?.action_score);
  if (Number.isFinite(actionScore)) {
    return Math.max(0, Math.min(100, Math.round(actionScore * 100)));
  }

  const conviction = Number(
    thesis?.conviction
    ?? candidate?.thesis_conviction
    ?? candidate?.conviction
    ?? 0
  );
  if (!Number.isFinite(conviction) || conviction <= 0) return 0;
  if (conviction > 80) return 95;
  if (conviction >= 65) return 75;
  if (conviction >= 50) return 55;
  return 30;
}

function buildScoutMapsRoutePromptLines(entries = []) {
  const lines = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const mapsRoute = entry?.packet_summary?.maps_route;
    if (!mapsRoute) continue;
    const symbol = entry?.symbol || entry?.packet_summary?.symbol || "unknown";
    const confidence = Number(mapsRoute?.edge_confidence);
    const formattedConfidence = Number.isFinite(confidence) ? confidence.toFixed(2) : "0.00";
    lines.push(`MAPS ROUTE [${symbol}]: ${mapsRoute.destination ?? "unknown"} edge=${mapsRoute.edge_status ?? "unknown"} conf=${formattedConfidence} hazard=${mapsRoute.hazard_level ?? "unknown"}`);
  }
  return lines;
}

// Repair truncated JSON from LLM responses that hit max_tokens mid-output.
// Closes any unclosed strings, objects, and arrays so JSON.parse can succeed.
function repairTruncatedJson(str) {
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  // Strip trailing comma/colon that would produce invalid JSON, then close open structures
  let repaired = str.trimEnd().replace(/[,:{]\s*$/, "");
  if (inString) repaired += '"';
  while (stack.length > 0) repaired += stack.pop();
  return repaired;
}

function validateHarvestPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("INVALID_HARVEST_PAYLOAD");
  }

  if (!Array.isArray(payload.exit_candidates)) {
    throw new Error("HARVEST_EXIT_CANDIDATES_NOT_ARRAY");
  }

  const validExitCandidates = [];

  payload.exit_candidates.forEach((proposal, index) => {
    if (!proposal || typeof proposal !== "object") {
      log("harvest_invalid_candidate", { index, reason: "INVALID_HARVEST_PROPOSAL" });
      return;
    }

    const addr = cleanAddress(proposal?.token?.contract_address);
    proposal.token = proposal.token && typeof proposal.token === "object" ? proposal.token : {};
    proposal.token.contract_address = addr;

    if (!isEvmAddress(addr)) {
      log("harvest_invalid_candidate", { index, reason: "INVALID_HARVEST_ADDRESS", contract_address: addr || null, proposal });
      return;
    }

    if (!proposal.position || typeof proposal.position !== "object") {
      proposal.position = {};
    }

    if (!proposal.evidence_packet_id || typeof proposal.evidence_packet_id !== "string") {
      log("harvest_invalid_candidate", { index, reason: "MISSING_HARVEST_EVIDENCE_PACKET_ID", contract_address: addr || null });
      return;
    }

    validExitCandidates.push(proposal);
  });

  payload.exit_candidates = validExitCandidates;
}

function validateScoutPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("INVALID_SCOUT_PAYLOAD");
  }

  if (!Array.isArray(payload.candidates)) {
    throw new Error("SCOUT_CANDIDATES_NOT_ARRAY");
  }

  const validCandidates = [];
  for (const proposal of payload.candidates) {
    if (!proposal || typeof proposal !== "object") {
      log("scout_candidate_dropped", { reason: "INVALID_SCOUT_PROPOSAL" });
      continue;
    }
    if (!proposal.token || typeof proposal.token !== "object") {
      log("scout_candidate_dropped", { reason: "SCOUT_TOKEN_MISSING", proposal });
      continue;
    }

    const addr = cleanAddress(proposal.token.contract_address);
    proposal.token.contract_address = addr;

    if (!proposal.token.symbol || typeof proposal.token.symbol !== "string") {
      log("scout_candidate_dropped", { reason: "SCOUT_TOKEN_SYMBOL_MISSING", addr });
      continue;
    }
    if (!isEvmAddress(addr)) {
      log("scout_candidate_dropped", { reason: "INVALID_SCOUT_ADDRESS", addr });
      continue;
    }
    if (!proposal.entry_zone || typeof proposal.entry_zone !== "object") {
      proposal.entry_zone = { low: null, high: null };
    }
    if (!proposal.targets || typeof proposal.targets !== "object") {
      proposal.targets = { target_1: null, target_2: null, target_3: null };
    }
    validCandidates.push(proposal);
  }
  payload.candidates = validCandidates;

  if (payload.holdings_updates != null && !Array.isArray(payload.holdings_updates)) {
    throw new Error("SCOUT_HOLDINGS_UPDATES_NOT_ARRAY");
  }
}

function isScoutCandidateAlreadyHeld(candidate, portfolio) {
  const positions = Object.values(portfolio?.positions || {});
  const candidateAddress = cleanAddress(candidate?.token?.contract_address || candidate?.contract_address || "");
  const candidateSymbol = String(candidate?.token?.symbol || candidate?.symbol || "").trim().toLowerCase();

  return positions.some((pos) => {
    const heldAddress = cleanAddress(pos?.contract_address || "");
    const heldSymbol = String(pos?.symbol || "").trim().toLowerCase();
    return (candidateAddress && heldAddress && candidateAddress === heldAddress) || (candidateSymbol && heldSymbol && candidateSymbol === heldSymbol);
  });
}

function filterScoutCandidatesAgainstPortfolio(candidates, portfolio) {
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => !isScoutCandidateAlreadyHeld(candidate, portfolio));
}

function clickHouseQuery(query, input = "") {
  const url = `${CLICKHOUSE_HTTP_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE_NAME)}&query=${encodeURIComponent(query)}`;
  const curlArgs = ["-sS", "-X", "POST", url, "--data-binary", "@-"];
  if (CLICKHOUSE_USER) curlArgs.push("-u", `${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`);
  const result = runShell("curl", curlArgs, { input });
  if (result && /^Code:\s*\d+/.test(result.trim())) {
    throw new Error(`ClickHouse error: ${result.trim().slice(0, 300)}`);
  }
  return result;
}

function ensurePersistentStores() {
  if (DATABASE_SCHEMA_READY) return;

  try {
    clickHouseQuery(`CREATE DATABASE IF NOT EXISTS ${CLICKHOUSE_DATABASE_NAME}`);
    clickHouseQuery(`
      CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_DATABASE_NAME}.${CLICKHOUSE_TABLE_NAME} (
        event_id String,
        schema_version String,
        ts String,
        event_type String,
        actor String,
        pipeline_run_id String,
        cycle_id String,
        cycle_index Int32,
        market_regime String,
        candidate_id String,
        position_id String,
        trade_id String,
        payload String
      )
      ENGINE = MergeTree
      ORDER BY (ts, event_type, event_id)
    `);
    DATABASE_SCHEMA_READY = true;
  } catch (err) {
    log("clickhouse_schema_error", { message: err.message });
  }
}

function clickHouseRowFromEvent(record) {
  return {
    event_id: String(record?.event_id || crypto.randomUUID()),
    schema_version: String(record?.schema_version || TRAINING_EVENT_SCHEMA_VERSION),
    ts: String(record?.ts || nowIso()),
    event_type: String(record?.event_type || ""),
    actor: String(record?.actor || ""),
    pipeline_run_id: String(record?.pipeline_run_id || ""),
    cycle_id: String(record?.cycle_id || ""),
    cycle_index: Number.isFinite(record?.cycle_index) ? Math.trunc(record.cycle_index) : -1,
    market_regime: String(record?.market_regime || ""),
    candidate_id: String(record?.candidate_id || ""),
    position_id: String(record?.position_id || ""),
    trade_id: String(record?.trade_id || ""),
    payload: JSON.stringify(record)
  };
}

function buildScoutIntelUrls(portfolioIntelligence) {
  const urls = [];
  const holdings = endpointArray(portfolioIntelligence?.holdings || []).slice(0, E3D_DOSSIER_MAX_POSITIONS);

  urls.push(`${E3D_API_BASE_URL}/fetchTokenPricesWithHistoryAllRanges?dataSource=${E3D_TOKENS_DATA_SOURCE}&sortBy=change_30m_pct&sortDir=desc&limit=50`);
  urls.push(`${E3D_API_BASE_URL}/fetchTokenPricesWithHistoryAllRanges?dataSource=${E3D_TOKENS_DATA_SOURCE}&sortBy=change_30m_pct&sortDir=asc&limit=50`);
  urls.push(`${E3D_API_BASE_URL}/fetchTokensDB?dataSource=${E3D_TOKENS_DATA_SOURCE}&limit=50&offset=0`);
  urls.push(`${E3D_API_BASE_URL}/fetchTransactionsDB?dataSource=${E3D_TRANSACTIONS_DATA_SOURCE}&limit=25`);

  for (const holding of holdings) {
    const address = cleanAddress(holding?.token?.contract_address || holding?.position?.contract_address || "");
    const symbol = String(holding?.token?.symbol || holding?.position?.symbol || "").trim();
    const chain = String(holding?.token?.chain || holding?.position?.chain || "ETH").trim() || "ETH";

    if (address) {
      urls.push(`${E3D_API_BASE_URL}/addressMeta?address=${encodeURIComponent(address)}`);
      urls.push(`${E3D_API_BASE_URL}/token-info/${encodeURIComponent(address)}`);
      urls.push(`${E3D_API_BASE_URL}/stories?q=${encodeURIComponent(address)}&scope=opportunity&limit=${E3D_DOSSIER_MAX_STORIES}`);
      urls.push(`${E3D_API_BASE_URL}/addressCounterparties?address=${encodeURIComponent(address)}&limit=${E3D_DOSSIER_MAX_COUNTERPARTIES}`);
      urls.push(`${E3D_API_BASE_URL}/tokenCounterparties?token=${encodeURIComponent(address)}&limit=${E3D_DOSSIER_MAX_COUNTERPARTIES}`);
      urls.push(`${E3D_API_BASE_URL}/stories?q=${encodeURIComponent(address)}&scope=any&limit=${E3D_DOSSIER_MAX_STORIES}`);
      urls.push(`${E3D_API_BASE_URL}/fetchTransactionsDB?dataSource=${E3D_TRANSACTIONS_DATA_SOURCE}&search=${encodeURIComponent(address)}&limit=25`);
    }

    if (symbol) {
      urls.push(`${E3D_API_BASE_URL}/fetchTokensDB?dataSource=${E3D_TOKENS_DATA_SOURCE}&search=${encodeURIComponent(symbol)}&limit=10&offset=0`);
      urls.push(`${E3D_API_BASE_URL}/stories?q=${encodeURIComponent(symbol)}&scope=any&limit=${E3D_DOSSIER_MAX_STORIES}`);
      urls.push(`${E3D_API_BASE_URL}/fetchTransactionsDB?dataSource=${E3D_TRANSACTIONS_DATA_SOURCE}&search=${encodeURIComponent(symbol)}&limit=25`);
    }
  }

  urls.push(`${E3D_API_BASE_URL}/actions?status=open&actionType=accumulate_signal,paper_buy,watch&sort=action_score_desc&limit=30&maxRisk=${E3D_ACTIONS_MAX_RISK}&minConfidence=${E3D_ACTIONS_MIN_CONFIDENCE}`);

  return Array.from(new Set(urls));
}

function fetchScoutIntelDebug(portfolioIntelligence) {
  const holdings = endpointArray(portfolioIntelligence?.holdings || []).slice(0, E3D_DOSSIER_MAX_POSITIONS);
  const debugIntel = {
    market_trends: {
      gainers: fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
        dataSource: E3D_TOKENS_DATA_SOURCE,
        sortBy: "change_30m_pct",
        sortDir: "desc",
        limit: 50
      }),
      losers: fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
        dataSource: E3D_TOKENS_DATA_SOURCE,
        sortBy: "change_30m_pct",
        sortDir: "asc",
        limit: 50
      })
    },
    token_universe: fetchJson("/fetchTokensDB", {
      dataSource: E3D_TOKENS_DATA_SOURCE,
      limit: 50,
      offset: 0
    }),
    recent_transactions: fetchJson("/fetchTransactionsDB", {
      dataSource: E3D_TRANSACTIONS_DATA_SOURCE,
      limit: 25
    }),
    holdings: []
  };

  for (const holding of holdings) {
    const address = cleanAddress(holding?.token?.contract_address || holding?.position?.contract_address || "");
    const symbol = String(holding?.token?.symbol || holding?.position?.symbol || "").trim();
    const chain = String(holding?.token?.chain || holding?.position?.chain || "ETH").trim() || "ETH";

    if (!address) continue;

    debugIntel.holdings.push({
      address,
      symbol: symbol || null,
      identity: fetchJson("/addressMeta", { address }),
      token_info: fetchJson(`/token-info/${encodeURIComponent(address)}`),
      stories_opportunity: fetchJson("/stories", { q: address, scope: "opportunity", limit: E3D_DOSSIER_MAX_STORIES }),
      address_counterparties: fetchJson("/addressCounterparties", { address, limit: E3D_DOSSIER_MAX_COUNTERPARTIES }),
      token_counterparties: fetchJson("/tokenCounterparties", { token: address, limit: E3D_DOSSIER_MAX_COUNTERPARTIES }),
      stories_by_address: fetchJson("/stories", { q: address, scope: "any", limit: E3D_DOSSIER_MAX_STORIES }),
      stories_by_symbol: symbol ? fetchJson("/stories", { q: symbol, scope: "any", limit: E3D_DOSSIER_MAX_STORIES }) : null,
      transactions_by_address: fetchJson("/fetchTransactionsDB", {
        dataSource: E3D_TRANSACTIONS_DATA_SOURCE,
        search: address,
        limit: 25
      }),
      transactions_by_symbol: symbol ? fetchJson("/fetchTransactionsDB", {
        dataSource: E3D_TRANSACTIONS_DATA_SOURCE,
        search: symbol,
        limit: 25
      }) : null
    });
  }

  return debugIntel;
}

function buildHeldTokenIndex(portfolio) {
  const index = new Map();
  for (const position of Object.values(portfolio?.positions || {})) {
    const address = cleanAddress(position?.contract_address || "");
    const symbol = String(position?.symbol || "").trim().toLowerCase();
    const key = address || symbol;
    if (!key) continue;
    index.set(key, {
      symbol: position?.symbol || null,
      contract_address: address || null,
      category: position?.category || null
    });
  }
  return index;
}

function normalizeScoutIntelToken(token, source) {
  if (!token || typeof token !== "object") return null;
  return {
    source,
    bucket: token.bucket || source,
    symbol: compactText(token.symbol || token.ticker || token.name || "", 40) || null,
    name: compactText(token.name || token.token_name || token.display_name || token.title || "", 80) || null,
    contract_address: cleanAddress(token.contract_address || token.address || token.token_address || "") || null,
    change_30m_pct: toNum(token.change_30m_pct || token.changes?.["30M"]?.percent, 0),
    change_24h_pct: toNum(token.change_24h_pct || token.change_24H || token.change_24h || token.price_change_24h_pct || token.changes?.["24H"]?.percent, 0),
    current_price: toNum(token.current_price || token.priceUSD || token.price_usd || token.price, 0),
    market_cap_usd: toNum(token.market_cap_usd || token.marketCapUSD || token.marketCap || token.market_cap, 0),
    liquidity_usd: toNum(token.liquidity_usd || token.liquidity, 0),
    price_timestamp: token.price_timestamp || token.timestamp || token.ts_created || token.updated_at || null
  };
}

function summarizeScoutCandidateReason(token, heldIndex) {
  const reasons = [];
  const signals = [];
  const address = cleanAddress(token?.contract_address || "");
  const symbol = String(token?.symbol || "").trim().toLowerCase();
  const heldMatch = (address && heldIndex.get(address)) || (symbol && heldIndex.get(symbol)) || null;
  const change = toNum(token?.change_24h_pct, 0);
  const change30m = toNum(token?.change_30m_pct, 0);

  if (!address) {
    reasons.push("missing_contract_address");
  } else {
    signals.push("has_contract_address");
  }

  if (heldMatch) {
    reasons.push("already_held_in_portfolio");
    signals.push(`held_match:${heldMatch.symbol || heldMatch.contract_address || "unknown"}`);
  }

  if (token?.bucket === "gainers") {
    signals.push("from_top_gainers_feed");
    if (change30m > 0) signals.push("positive_30m_change");
    if (change > 0) signals.push("positive_24h_change");
  }

  if (token?.bucket === "losers") {
    signals.push("from_top_losers_feed");
    if (change30m < 0) reasons.push("negative_30m_change");
  }

  if (token?.bucket === "token_universe") {
    signals.push("from_token_universe_feed");
  }

  if (token?.liquidity_usd > 0) signals.push("has_liquidity_data");
  if (token?.market_cap_usd > 0) signals.push("has_market_cap_data");

  const isCandidate = Boolean(
    address &&
    !heldMatch &&
    token?.bucket === "gainers" &&
    (change30m > 0 || change > 0)
  );

  if (!isCandidate) {
    if (!token?.bucket || token.bucket === "token_universe") reasons.push("not_in_top_momentum_feed");
    if (token?.bucket === "losers") reasons.push("appears_in_losers_feed");
    if (change30m <= 0 && change <= 0) reasons.push("no_positive_momentum");
    if (!token?.liquidity_usd && !token?.market_cap_usd) reasons.push("limited_market_context");
  } else {
    reasons.push("top_gainer_with_valid_address_not_held");
  }

  return {
    symbol: token?.symbol || null,
    name: token?.name || null,
    contract_address: address || null,
    source: token?.source || null,
    bucket: token?.bucket || null,
    change_24h_pct: change,
    market_cap_usd: token?.market_cap_usd || 0,
    liquidity_usd: token?.liquidity_usd || 0,
    is_candidate: isCandidate,
    held_match: heldMatch,
    reasons,
    signals
  };
}

function buildScoutUniverseFilterReasons(token, storyTokenAddresses) {
  const reasons = [];
  const address = cleanAddress(token?.address || token?.contract_address || "");
  const storyCount1h = toNum(token?.story_count_1h, 0);
  if (!address) reasons.push("missing_contract_address");
  if (!(storyCount1h > 0)) reasons.push("story_count_1h_zero");
  if (!(address && storyTokenAddresses.has(address))) reasons.push("not_confirmed_by_story_api");
  return reasons;
}

function buildScoutE3dCandidateFilterDecision(candidate, nonTradeablePattern) {
  const address = cleanAddress(candidate?.entity_address || candidate?.token_address || candidate?.address || candidate?.contract_address || "");
  const symbol = String(candidate?.entity_symbol || candidate?.symbol || "").trim();
  const reasons = [];
  if (!address) reasons.push("missing_contract_address");
  if (/^0+$/.test(address)) reasons.push("zero_address");
  if (address === "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") reasons.push("native_placeholder_address");
  if (nonTradeablePattern.test(symbol)) reasons.push("non_tradeable_symbol");
  if (/[\s#]/.test(symbol)) reasons.push("nft_style_symbol");
  return {
    keep: reasons.length === 0,
    symbol: symbol || null,
    contract_address: address || null,
    reasons
  };
}

function buildScoutWatchlistFilterDecision(item, nonTradeablePattern) {
  const address = cleanAddress(item?.address || "");
  const label = String(item?.label || "").trim();
  const reasons = [];
  if (item?.type !== "token") reasons.push("non_token_watchlist_item");
  if (!address) reasons.push("missing_contract_address");
  if (/^0+$/.test(address)) reasons.push("zero_address");
  if (nonTradeablePattern.test(label)) reasons.push("non_tradeable_label");
  return {
    keep: reasons.length === 0,
    symbol: label || null,
    contract_address: address || null,
    reasons
  };
}

function buildScoutCandidateDebug(portfolio, scoutIntel) {
  const heldIndex = buildHeldTokenIndex(portfolio);
  const tokens = mergeUniqueTokens(
    endpointArray(scoutIntel?.market_trends?.gainers).map((row) => normalizeScoutIntelToken(row, "gainers")),
    endpointArray(scoutIntel?.market_trends?.losers).map((row) => normalizeScoutIntelToken(row, "losers")),
    endpointArray(scoutIntel?.token_universe).map((row) => normalizeScoutIntelToken(row, "token_universe"))
  )
    .filter(Boolean)
    .slice(0, 40);

  const reasons = tokens.map((token) => summarizeScoutCandidateReason(token, heldIndex));
  return {
    total_tokens_reviewed: reasons.length,
    candidate_count: reasons.filter((item) => item.is_candidate).length,
    not_candidate_count: reasons.filter((item) => !item.is_candidate).length,
    reviewed_tokens: reasons
  };
}

function syncTrainingEventToClickHouse(record) {
  try {
    ensurePersistentStores();
    const row = clickHouseRowFromEvent(record);
    clickHouseQuery(
      `INSERT INTO ${CLICKHOUSE_DATABASE_NAME}.${CLICKHOUSE_TABLE_NAME} FORMAT JSONEachRow`,
      `${JSON.stringify(row)}\n`
    );
  } catch (err) {
    log("clickhouse_sync_error", { message: err.message, event_type: record?.event_type || null });
  }
}

function syncPortfolioToMongo(portfolio) {
  try {
    const updatedAt = nowIso();
    const mongoScript = `
      const dbName = process.env.MONGO_DATABASE_NAME || ${JSON.stringify(MONGO_DATABASE_NAME)};
      const payload = ${JSON.stringify(portfolio)};
      const dbRef = db.getSiblingDB(dbName);
      dbRef.portfolio_state.updateOne(
        { _id: "current" },
        { $set: { ...payload, _id: "current", updated_at: ${JSON.stringify(updatedAt)} } },
        { upsert: true }
      );
    `;

    // Pipe script via stdin to avoid ARG_MAX when the portfolio JSON is large.
    // stderr is ignored so a missing docker daemon doesn't flood the log on every cycle.
    runShell("docker", [
      "exec",
      "-i",
      MONGO_CONTAINER_NAME,
      "mongosh",
      "--quiet"
    ], { input: mongoScript, stdio: ["pipe", "pipe", "ignore"] });
  } catch (err) {
    log("mongo_sync_error", { message: err.message });
  }
}

function setTrainingContext(context) {
  ACTIVE_TRAINING_CONTEXT = { ...(context || {}) };
}

function getTrainingContext() {
  return ACTIVE_TRAINING_CONTEXT || {};
}

function appendTrainingEvent(record) {
  fs.appendFileSync(TRAINING_EVENT_LOG, JSON.stringify(record) + "\n");
  syncTrainingEventToClickHouse(record);
}

function readJsonLines(filePath, maxLines = 1000) {
  // Read only a bounded tail window instead of the whole file. Log files like
  // training-events.jsonl grow unbounded (500MB+); fs.readFileSync(..., "utf8") on a file
  // over ~512MB throws "Cannot create a string longer than 0x1fffffe8 characters" (V8's max
  // string length), which the old implementation's catch swallowed — silently returning []
  // and making every caller believe the log was empty.
  try {
    const stat = fs.statSync(filePath);
    const bytesPerLineBudget = 100_000; // generous upper bound per JSON line
    const requestedBytes = maxLines > 0 ? maxLines * bytesPerLineBudget : stat.size;
    const maxBytes = Math.min(stat.size, Math.max(2_000_000, requestedBytes), 400_000_000);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    let content;
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      content = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const lines = content.split("\n");
    // A non-zero start means the read began mid-line; drop that partial fragment.
    const usableLines = start > 0 ? lines.slice(1) : lines;
    const tail = maxLines > 0 ? usableLines.slice(-maxLines) : usableLines;
    const records = [];
    for (const line of tail) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { records.push(JSON.parse(trimmed)); } catch { /* skip malformed lines */ }
    }
    return records;
  } catch {
    return [];
  }
}

function readJsonFileSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function buildTrainingEventRecord(eventType, actor, portfolio, context = {}, details = {}) {
  const mergedContext = { ...(getTrainingContext() || {}), ...(context || {}) };
  const record = {
    event_id: crypto.randomUUID(),
    schema_version: TRAINING_EVENT_SCHEMA_VERSION,
    ts: nowIso(),
    event_type: eventType,
    actor,
    pipeline_run_id: mergedContext.pipeline_run_id || null,
    cycle_id: mergedContext.cycle_id || null,
    cycle_index: Number.isFinite(mergedContext.cycle_index) ? Math.trunc(mergedContext.cycle_index) : -1,
    market_regime: mergedContext.market_regime || portfolio?.stats?.market_regime || "unknown",
    candidate_id: details.candidate_id || null,
    position_id: details.position_id || null,
    trade_id: details.trade_id || null,
    payload: {
      ...details,
      portfolio_snapshot: portfolio
        ? {
            cash_usd: toNum(portfolio.cash_usd, 0),
            equity_usd: equityUsd(portfolio),
            open_positions: Object.keys(portfolio.positions || {}).length,
            market_regime: portfolio?.stats?.market_regime || "unknown"
          }
        : null
    }
  };

  return record;
}

function recordCycleEvent(stage, context, portfolio, details = {}) {
  const record = buildTrainingEventRecord(stage, "pipeline", portfolio, context, details);
  appendTrainingEvent(record);
  return record;
}

function writeRunLedgerEntry(entry) {
  try {
    fs.appendFileSync(RUN_LEDGER_LOG, JSON.stringify(entry) + "\n");
  } catch (err) {
    log("run_ledger_error", { message: String(err?.message || err) });
  }
}

function buildRunLedgerRecord({ trainingContext, cycleStartTs, cycleEndTs, scoutPayload, harvestPayload, approved, rejected, buyTrades, sellTrades, harvestTrades, stats, portfolio, quantContext }) {
  const cogState = _lastCognitiveState;
  const scoutMeta = getLastLLMMeta("scout") || {};
  const harvestMeta = getLastLLMMeta("harvest") || {};

  const scoutCandidates = (scoutPayload?.candidates || []).map(c => ({
    candidate_id: c?.training_candidate_id ?? null,
    symbol: c?.token?.symbol || "",
    address: cleanAddress(c?.token?.contract_address || ""),
    source: c?.source || "unknown",
    signal_types: Array.isArray(c?.signal_types) ? c.signal_types : [],
    story_ids: Array.isArray(c?.story_ids) ? c.story_ids : [],
    conviction: c?.conviction_score || 0,
    confidence: c?.confidence || 0,
    scorecard: c?.scorecard || null,
    why_now: c?.why_now || "",
    entry_zone: c?.entry_zone || null,
    market_at_signal: {
      price_usd: c?.market_data?.current_price ?? null,
      liquidity_usd: c?.liquidity_data?.liquidity_usd ?? null,
      volume_24h_usd: c?.market_data?.volume_24h_usd ?? null,
      market_cap_usd: c?.market_data?.market_cap_usd ?? null,
      change_30m_pct: c?.market_data?.change_30m_pct ?? null,
      change_24h_pct: c?.market_data?.change_24h_pct ?? null
    },
    e3d_action_id:   c?.e3d_action_id   ?? null,
    e3d_action_type: c?.e3d_action_type ?? null,
  }));

  const rejectedCandidates = (rejected || [])
    .map(r => ({
      candidate_id: r?.proposal?.training_candidate_id || r?.proposal?.candidate_id || r?.proposal?.token?.contract_address || r?.proposal?.token?.symbol || null,
      symbol: r?.proposal?.token?.symbol || "",
      address: cleanAddress(r?.proposal?.token?.contract_address || ""),
      market_at_signal: {
        price_usd: r?.proposal?.market_data?.current_price ?? null
      },
      reject_reason: r?.risk?.reason_summary || "",
      reason_codes: Array.isArray(r?.risk?.reason_codes) ? r.risk.reason_codes : []
    }))
    .filter(r => r.candidate_id && r.address && r.market_at_signal.price_usd > 0);

  // Count harvest actions
  const harvestActionCounts = { hold: 0, monitor: 0, trim: 0, exit: 0 };
  for (const r of harvestPayload?.position_reviews || []) {
    const act = String(r?.action || "hold").toLowerCase();
    if (act in harvestActionCounts) harvestActionCounts[act]++;
    else harvestActionCounts.hold++;
  }

  const allTrades = [...(buyTrades || []), ...(sellTrades || []), ...(harvestTrades || [])];
  const tradeRecords = allTrades.map(t => ({
    symbol: t?.symbol || t?.token?.symbol || "",
    address: cleanAddress(t?.contract_address || t?.token?.contract_address || ""),
    side: t?.side || (t?.action === "sell" ? "sell" : "buy"),
    price_usd: t?.price || t?.avg_entry_price || null,
    cost_usd: t?.cost_usd || null,
    ts: t?.opened_at || t?.closed_at || cycleEndTs
  }));

  const macro = quantContext?.macro || {};

  return {
    ledger_version: "1.0",
    cycle_id: trainingContext.cycle_id,
    cycle_ts: cycleStartTs,
    pipeline_run_id: trainingContext.pipeline_run_id,

    perception: {
      mode: "cognitive_state",
      api_calls: cogState?.meta?.api_calls ?? 3,
      e3d_candidates_found: cogState?.meta?.e3d_candidates ?? 0,
      story_signals_found: cogState?.meta?.story_signals ?? 0,
      disqualified_count: cogState?.meta?.disqualified ?? 0,
      cognitive_state_candidates: cogState?.meta?.output_candidates ?? 0,
      duration_ms: cogState?.meta?.duration_ms ?? null
    },

    scout: {
      tool_rounds: scoutMeta.tool_rounds ?? 0,
      tool_calls: _cycleScoutToolCalls,
      prompt_tokens: scoutMeta.prompt_tokens ?? null,
      completion_tokens: scoutMeta.completion_tokens ?? null,
      duration_ms: scoutMeta.duration_ms ?? null,
      candidates_raw: (scoutPayload?.candidates?.length || 0),
      candidates_after_quality_gate: scoutCandidates.length,
      candidates: scoutCandidates
    },

    harvest: {
      positions_reviewed: (harvestPayload?.position_reviews?.length || 0),
      tool_rounds: harvestMeta.tool_rounds ?? 0,
      exits_proposed: (harvestPayload?.exit_candidates?.length || 0),
      actions: harvestActionCounts
    },

    risk: {
      approved: (approved?.length || 0),
      rejected: (rejected?.length || 0),
      rejection_reasons: (rejected || []).map(r => r?.reason || r?.reject_reason || "").filter(Boolean),
      rejected_candidates: rejectedCandidates
    },

    execution: {
      buys: (buyTrades?.length || 0),
      sells: ((sellTrades?.length || 0) + (harvestTrades?.length || 0)),
      trades: tradeRecords
    },

    portfolio_snapshot: {
      cash_usd: portfolio?.cash_usd ?? null,
      equity_usd: stats?.equity_usd ?? null,
      position_count: Object.keys(portfolio?.positions || {}).length,
      unrealized_pnl_usd: stats?.unrealized_pnl_usd ?? null
    },

    macro: {
      regime: macro.regime || "unknown",
      new_positions_ok: macro.new_positions_ok ?? null,
      tighten_stops: macro.tighten_stops ?? null,
      btc_change_24h_pct: macro.btc?.change_24h_pct ?? null,
      fear_greed: macro.fear_greed?.value ?? null
    },

    outcomes: {
      recorded_at: null,
      price_1h_pct: null,
      price_4h_pct: null,
      price_24h_pct: null,
      price_7d_pct: null,
      signal_detected_before_move: null,
      outcome_label: null
    }
  };
}

function recordHarvestDecisionEvent(proposal, harvest, portfolio, context = {}, intelligence = null) {
  const token = proposal?.token || {};
  const record = buildTrainingEventRecord("harvest_decision", "harvest", portfolio, context, {
    candidate_id: token?.contract_address || token?.symbol || null,
    decision: harvest?.decision ?? proposal?.action ?? null,
    portfolio_intelligence: intelligence || null,
    harvest_review: harvest || null,
    proposal: proposal || null
  });
  appendTrainingEvent(record);
  return record;
}

function recordCandidateEvent(candidate, portfolio, context = {}, intelligence = null) {
  const token = candidate?.token || {};
  const record = buildTrainingEventRecord("candidate", "scout", portfolio, context, {
    candidate_id: candidate?.candidate_id || candidate?.id || token.contract_address || token.symbol || null,
    portfolio_intelligence: intelligence || null,
    token,
    summary: candidate?.summary ?? candidate?.thesis_summary ?? null,
    opportunity_score: candidate?.opportunity_score ?? null,
    conviction_score: candidate?.conviction_score ?? null,
    liquidity_quality: candidate?.liquidity_quality ?? null,
    fraud_risk: candidate?.fraud_risk ?? null,
    market_data: candidate?.market_data || null,
    liquidity_data: candidate?.liquidity_data || null,
    execution_data: candidate?.execution_data || null
  });
  appendTrainingEvent(record);
  return record;
}

function recordRiskDecisionEvent(proposal, risk, portfolio, context = {}, handoffToExecutor = false) {
  const candidate = proposal?.token || {};
  const record = buildTrainingEventRecord("risk_decision", "risk", portfolio, context, {
    candidate_id: candidate?.contract_address || candidate?.symbol || null,
    decision: risk?.decision ?? null,
    handoff_to_executor: Boolean(handoffToExecutor),
    risk_review: risk || null,
    proposal: proposal || null
  });
  appendTrainingEvent(record);
  return record;
}

function recordRiskEngineDecisionEvent(decision, portfolio, context = {}, details = {}) {
  const record = buildTrainingEventRecord("risk_engine_decision", "risk_engine", portfolio, context, {
    decision: decision?.decision || null,
    risk_decision_id: decision?.risk_decision_id || null,
    trade_id: decision?.trade_id || details.trade_id || null,
    candidate_id: details.candidate_id || null,
    position_id: details.position_id || null,
    source_trade_id: decision?.source_trade_id || null,
    risk_decision: decision || null,
    ...details
  });
  appendTrainingEvent(record);
  return record;
}

function recordExecutorDecisionEvent(bundle, portfolio, context = {}, tradeKind = "buy") {
  const action = bundle?.action || {};
  const proposal = bundle?.proposal || {};
  const review = bundle?.review || {};
  const candidate = tradeKind === "rotation" ? proposal?.token : proposal?.token || action?.candidate?.token || {};
  const record = buildTrainingEventRecord("executor_decision", "executor", portfolio, context, {
    candidate_id: candidate?.contract_address || candidate?.symbol || null,
    trade_kind: tradeKind,
    decision: executorDecision(review) || null,
    proposal: proposal || null,
    review: review || null,
    action: action || null
  });
  appendTrainingEvent(record);
  return record;
}

function recordTradeEvent(trade, portfolio, context = {}, details = {}) {
  const record = buildTrainingEventRecord("trade", "pipeline", portfolio, context, {
    trade_id: trade?.trade_id || null,
    position_id: trade?.position_id || null,
    candidate_id: trade?.candidate_id || null,
    quoted_price: trade?.quoted_price ?? null,
    fill_price: trade?.fill_price ?? null,
    slippage_bps_applied: trade?.slippage_bps_applied ?? null,
    fee_bps_applied: trade?.fee_bps_applied ?? null,
    fee_usd: trade?.fee_usd ?? null,
    slippage_usd: trade?.slippage_usd ?? null,
    trade: trade || null,
    ...details
  });
  appendTrainingEvent(record);
  return record;
}

function recordOutcomeEvent(trade, positionBefore, portfolio, context = {}) {
  const pnlUsd = toNum(trade?.pnl_usd, 0);
  const exitPrice = trade?.fill_price ?? trade?.price ?? null;
  const entryPrice = positionBefore?.avg_entry_price ?? null;
  const returnPct = (exitPrice != null && entryPrice != null && entryPrice !== 0)
    ? Math.round(((exitPrice - entryPrice) / entryPrice) * 10000) / 100
    : null;
  const holdingMs = positionBefore?.opened_at && trade?.ts
    ? new Date(trade.ts).getTime() - new Date(positionBefore.opened_at).getTime()
    : null;
  const holdingHours = holdingMs != null ? Math.max(0, Math.round(holdingMs / 360000) / 10) : null;
  const realizedDirection = pnlUsd > 1 ? "up" : pnlUsd < -1 ? "down" : "flat";
  const peakPrice = positionBefore?.peak_price ?? null;
  const troughPrice = positionBefore?.trough_price ?? null;
  const maxGainPct = (peakPrice != null && entryPrice != null && entryPrice !== 0)
    ? Math.round(((peakPrice - entryPrice) / entryPrice) * 10000) / 100
    : null;
  const maxDrawdownPct = (troughPrice != null && entryPrice != null && entryPrice !== 0)
    ? Math.round(((troughPrice - entryPrice) / entryPrice) * 10000) / 100
    : null;
  const record = buildTrainingEventRecord("outcome", "pipeline", portfolio, context, {
    trade_id: trade?.trade_id || null,
    position_id: trade?.position_id || null,
    candidate_id: trade?.candidate_id || null,
    outcome_label: pnlUsd >= 0 ? "profit" : "loss",
    pnl_usd: pnlUsd,
    return_pct: returnPct,
    holding_hours: holdingHours,
    max_gain_pct: maxGainPct,
    max_drawdown_pct: maxDrawdownPct,
    realized_direction: realizedDirection,
    exit_price: exitPrice,
    entry_price: entryPrice,
    holding_days: holdingMs != null ? Math.max(0, holdingMs / 86400000) : null,
    position_before: positionBefore || null,
    trade: trade || null
  });
  appendTrainingEvent(record);
  return record;
}

function recordAuxiliaryEvent(eventType, actor, portfolio, details = {}) {
  const record = buildTrainingEventRecord(eventType, actor, portfolio, getTrainingContext(), details);
  appendTrainingEvent(record);
  return record;
}

function sha256(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function optionalMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function saneStopPrice(rawStop, entryPrice) {
  const entry = optionalNum(entryPrice);
  if (!(entry > 0)) return 0;
  const stop = optionalNum(rawStop);
  if (stop > 0 && stop < entry) return stop;
  return entry * 0.9;
}

function sanitizeTargets(targets, entryPrice) {
  const entry = optionalNum(entryPrice);
  const source = targets && typeof targets === "object" ? targets : {};
  const out = {};
  for (const key of ["target_1", "target_2", "target_3"]) {
    const value = optionalNum(source[key]);
    out[key] = value > 0 && (!(entry > 0) || value > entry) ? value : null;
  }
  return out;
}

function targetHit(price, target) {
  const p = optionalNum(price);
  const t = optionalNum(target);
  return p > 0 && t > 0 && p >= t;
}

// Normalize a confidence/conviction value to 0-100 integer scale.
// Handles: string labels ("high"→80, "medium"→55, "low"→30),
// decimal 0-1 values (0.9→90), and already-correct 0-100 integers.
function normalizeScore(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.toLowerCase().trim();
    if (s === "high") return 80;
    if (s === "medium" || s === "moderate") return 55;
    if (s === "low") return 30;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n > 0 && n <= 1 ? Math.round(n * 100) : Math.round(n);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n > 0 && n <= 1 ? Math.round(n * 100) : Math.round(n);
}

function equityUsd(portfolio) {
  if (!portfolio || typeof portfolio !== "object") return 0;

  const statsEquity = toNum(portfolio?.stats?.equity_usd, NaN);
  if (Number.isFinite(statsEquity)) return statsEquity;

  const cash = toNum(portfolio.cash_usd, 0);
  const positions = Object.values(portfolio.positions || {});
  const marketValue = positions.reduce((sum, pos) => sum + toNum(pos.market_value_usd, 0), 0);
  return cash + marketValue;
}

function computePositionScoreLike(candidate) {
  if (!candidate || typeof candidate !== "object") return 0;

  const opportunity = toNum(candidate.opportunity_score, 0);
  const conviction = toNum(candidate.conviction_score, 0);
  const liquidityQuality = toNum(candidate.liquidity_quality, 0);
  const fraudPenalty = toNum(candidate.fraud_risk, 0);
  const marketMomentum = toNum(candidate?.market_data?.change_24h_pct, 0);
  const slippagePenalty = toNum(candidate?.execution_data?.estimated_slippage_bps, 0) / 10;

  return (
    opportunity * 0.35 +
    conviction * 0.3 +
    liquidityQuality * 0.2 +
    marketMomentum * 0.1 -
    fraudPenalty * 0.25 -
    slippagePenalty * 0.05
  );
}

function computePositionScore(position, settings = SETTINGS_DEFAULTS) {
  if (!position || typeof position !== "object") return 0;

  const baseScore = computePositionScoreLike(position);
  const ageDecayPerDay = toNum(settings?.age_decay_per_day, SETTINGS_DEFAULTS.age_decay_per_day);
  const openedAtMs = position?.opened_at ? new Date(position.opened_at).getTime() : NaN;
  const ageDays = Number.isFinite(openedAtMs)
    ? Math.max(0, (Date.now() - openedAtMs) / 86400000)
    : 0;

  const pnlPct = toNum(position.pnl_pct, NaN);
  const derivedPnlPct = Number.isFinite(pnlPct)
    ? pnlPct
    : (() => {
        const costBasis = toNum(position.cost_basis_usd, 0);
        const marketValue = toNum(position.market_value_usd, 0);
        if (!(costBasis > 0)) return 0;
        return ((marketValue - costBasis) / costBasis) * 100;
      })();

  return baseScore + derivedPnlPct * 0.1 - ageDays * ageDecayPerDay;
}

function isEvmAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function cleanAddress(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/[\s\u00A0\u200B-\u200D\uFEFF]+/g, "")
    .trim()
    .toLowerCase();
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function average(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function computeMarketRegime(scoutPayload, approved, portfolio) {
  const candidates = Array.isArray(scoutPayload?.candidates) ? scoutPayload.candidates : [];
  const approvedCandidates = Array.isArray(approved) ? approved : [];
  const heldPositions = Object.values(portfolio?.positions || {});

  const candidateMomentum = average(candidates.map((item) => toNum(item?.market_data?.change_24h_pct, NaN)));
  const approvedMomentum = average(approvedCandidates.map((item) => toNum(item?.market_data?.change_24h_pct, NaN)));
  const heldMomentum = average(heldPositions.map((item) => toNum(item?.last_market_snapshot?.market_data?.change_24h_pct, item?.market_data?.change_24h_pct)));
  const approvedScore = average(approvedCandidates.map((item) => toNum(item?._score, NaN)));
  const approvedFraudRisk = average(approvedCandidates.map((item) => toNum(item?.fraud_risk, NaN)));

  const compositeMomentum = average([candidateMomentum, approvedMomentum, heldMomentum]);

  let regime = "neutral";
  if (approvedCandidates.length === 0 && candidates.length > 0 && candidateMomentum < -5) {
    regime = "risk_off";
  } else if (compositeMomentum >= 12 && approvedScore >= 25 && approvedFraudRisk < 20) {
    regime = "risk_on";
  } else if (compositeMomentum <= -8 || approvedFraudRisk >= toNum(portfolio?.settings?.reject_fraud_risk_gte, 35)) {
    regime = "risk_off";
  }

  return {
    regime,
    candidate_count: candidates.length,
    approved_count: approvedCandidates.length,
    candidate_momentum_24h_pct: candidateMomentum,
    approved_momentum_24h_pct: approvedMomentum,
    held_momentum_24h_pct: heldMomentum,
    approved_score_avg: approvedScore,
    approved_fraud_risk_avg: approvedFraudRisk
  };
}

function regimePolicy(regime, settings = SETTINGS_DEFAULTS) {
  const normalizedRegime = String(regime || "neutral").toLowerCase();

  if (normalizedRegime === "risk_on") {
    return {
      regime: normalizedRegime,
      allow_buys: true,
      allow_rotations: true,
      allocation_multiplier: 1.35,
      max_buys_per_cycle: Math.min(settings.max_buys_per_cycle + 2, 5),
      max_rotations_per_cycle: settings.max_rotations_per_cycle
    };
  }

  if (normalizedRegime === "risk_off") {
    return {
      regime: normalizedRegime,
      allow_buys: false,
      allow_rotations: false,
      allocation_multiplier: 0,
      max_buys_per_cycle: 0,
      max_rotations_per_cycle: 0
    };
  }

  return {
    regime: "neutral",
    allow_buys: true,
    allow_rotations: true,
    allocation_multiplier: 1,
    max_buys_per_cycle: Math.max(1, settings.max_buys_per_cycle),
    max_rotations_per_cycle: settings.max_rotations_per_cycle
  };
}

function readLatestJsonReport(prefix) {
  try {
    return fs.readdirSync(REPORTS_DIR)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .map((name) => readJsonFileSafe(path.join(REPORTS_DIR, name), null))
      .filter(Boolean)
      .sort((a, b) => String(b.generated_at || "").localeCompare(String(a.generated_at || "")))[0] || null;
  } catch {
    return null;
  }
}

function buildRecentReviewStats(limit = 200) {
  const reviews = readJsonLines(TRADE_REVIEWS_LOG, limit);
  const negative = reviews.filter((review) => review.training_label === "negative");
  const avoidableLosses = reviews.filter((review) => review.avoidable_loss);
  const bySetup = new Map();
  for (const review of reviews) {
    const key = String(review.setup_label || "unknown");
    const stats = bySetup.get(key) || { setup_label: key, reviewed: 0, positive: 0, negative: 0, neutral: 0 };
    stats.reviewed += 1;
    stats[review.training_label] = (stats[review.training_label] || 0) + 1;
    bySetup.set(key, stats);
  }
  return {
    review_count: reviews.length,
    negative_count: negative.length,
    avoidable_loss_count: avoidableLosses.length,
    setup_expectancy: [...bySetup.values()].map((stats) => ({
      ...stats,
      negative_rate: stats.reviewed ? stats.negative / stats.reviewed : 0
    }))
  };
}

function computeDailyEquityBaseline(portfolio, referenceTs = nowIso()) {
  const targetDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(referenceTs));
  const events = readJsonLines(TRAINING_EVENT_LOG, 2000)
    .filter((record) => record?.event_type === "cycle_start" || record?.event_type === "cycle_end")
    .map((record) => ({
      record,
      tsMs: optionalMs(record?.ts),
      day: record?.ts ? new Intl.DateTimeFormat("en-CA", {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date(record.ts)) : null
    }))
    .filter((entry) => entry.tsMs != null && entry.day === targetDay)
    .sort((a, b) => a.tsMs - b.tsMs);

  const first = events[0]?.record?.payload?.portfolio_snapshot?.equity_usd;
  return toNum(first, equityUsd(portfolio));
}

function buildPortfolioRiskAnalytics(portfolio, evaluationTs = nowIso()) {
  return {
    evaluated_at: evaluationTs,
    market_regime: portfolio?.stats?.market_regime || "unknown",
    recent_performance: computeRecentClosedTradeMetrics(portfolio),
    review_stats: buildRecentReviewStats(200),
    day_start_equity_usd: computeDailyEquityBaseline(portfolio, evaluationTs)
  };
}

function buildBuyRiskIntent(candidate, allocationUsd, tradeKind = "buy") {
  const token = candidate?.token || {};
  const marketDataQuality = candidate?.market_data_quality || buildMarketDataQuality(candidate, {
    evaluated_at: candidate?.created_at || nowIso()
  });
  const evidenceMetadata = extractEvidenceMetadata(candidate);
  return {
    side: "buy",
    symbol: token.symbol || null,
    contract_address: token.contract_address || null,
    category: token.category || "unknown",
    strategy_version: candidate?.strategy_version || PAPER_ORDER_STRATEGY_VERSION,
    setup_type: candidate?.setup_type || null,
    requested_notional_usd: allocationUsd,
    requested_quantity: toNum(marketDataQuality.normalized?.price_usd, 0) > 0 ? allocationUsd / toNum(marketDataQuality.normalized.price_usd, 0) : 0,
    liquidity_usd: toNum(marketDataQuality.normalized?.liquidity_usd, 0),
    spread_bps: toNum(marketDataQuality.normalized?.spread_bps, 0),
    slippage_bps: toNum(marketDataQuality.normalized?.slippage_bps, 0),
    market_regime: _cycleRegimePolicy?.regime || null,
    reason: tradeKind,
    evidence_packet_id: evidenceMetadata.evidence_packet_id,
    evidence_quality_score: evidenceMetadata.evidence_quality_score,
    evidence_ref_count: evidenceMetadata.evidence_ref_count,
    evidence_blockers: evidenceMetadata.evidence_blockers,
    evidence_warnings: evidenceMetadata.evidence_warnings,
    market_data_quality_id: marketDataQuality.data_quality_id,
    market_data_quality_warnings: marketDataQuality.warnings || [],
    market_data_quality_blockers: marketDataQuality.blockers || []
  };
}

function attachTokenRiskScanMetadata(target, scan, context = {}) {
  if (!target || !scan?.token_risk_scan_id) return null;
  const ref = buildTokenRiskScanRef(scan, context);
  target.token_risk_scan_id = scan.token_risk_scan_id;
  target.token_risk_scan_ref = ref;
  target.token_risk_scan = deepClone(scan);
  if (target.paper_trade_ticket && typeof target.paper_trade_ticket === "object") {
    target.paper_trade_ticket.token_risk_scan_id = scan.token_risk_scan_id;
    target.paper_trade_ticket.token_risk_scan_ref = ref;
    target.paper_trade_ticket.token_risk_scan = deepClone(scan);
  }
  return ref;
}

function recordTokenRiskScanEvent(scan, portfolio, context = {}, details = {}) {
  if (!scan?.token_risk_scan_id) return null;
  return recordAuxiliaryEvent("token_risk_scan", "token_risk_scanner", portfolio, {
    token_risk_scan_id: scan.token_risk_scan_id,
    token_risk_scan: scan,
    ...details
  });
}

function buildCandidateTokenRiskScan(candidate, portfolio, details = {}) {
  const token = candidate?.token || {};
  return buildTokenRiskScan({
    evaluated_at: details.evaluated_at || nowIso(),
    mode: details.mode || "paper",
    side: details.side || "buy",
    candidate_id: candidate?.training_candidate_id || candidate?.candidate_id || token?.contract_address || token?.symbol || null,
    position_id: candidate?.training_position_id || candidate?.position_id || null,
    signal_snapshot_ref: details.signal_snapshot_ref || null,
    risk_decision_id: details.risk_decision_id || null,
    risk_decision_ref: details.risk_decision_ref || null,
    token: {
      ...deepClone(token),
      liquidity_usd: toNum(candidate?.liquidity_data?.liquidity_usd, toNum(token?.liquidity_usd, 0)),
      liquidity_quality: candidate?.liquidity_quality ?? token?.liquidity_quality ?? null,
      fraud_risk: candidate?.fraud_risk ?? token?.fraud_risk ?? null,
      current_price: toNum(candidate?.market_data?.current_price, toNum(token?.current_price, 0)),
      spread_bps: toNum(candidate?.execution_data?.spread_bps, toNum(token?.spread_bps, 0)),
      slippage_bps: toNum(candidate?.execution_data?.estimated_slippage_bps, toNum(token?.slippage_bps, 0))
    },
    market_data: candidate?.market_data || null,
    liquidity_data: candidate?.liquidity_data || null,
    execution_data: candidate?.execution_data || null,
    category: token?.category || candidate?.category || null
  });
}

function buildPositionTokenRiskScan(position, portfolio, details = {}) {
  if (!position || typeof position !== "object") return null;
  return buildTokenRiskScan({
    evaluated_at: details.evaluated_at || nowIso(),
    mode: details.mode || "paper",
    side: details.side || "sell",
    candidate_id: position.training_candidate_id || null,
    position_id: position.training_position_id || null,
    trade_id: details.trade_id || null,
    source_trade_id: details.source_trade_id || null,
    signal_snapshot_ref: details.signal_snapshot_ref || null,
    risk_decision_id: details.risk_decision_id || null,
    risk_decision_ref: details.risk_decision_ref || null,
    token: {
      symbol: position.symbol,
      contract_address: position.contract_address,
      category: position.category,
      liquidity_usd: toNum(position.liquidity_usd, 0),
      liquidity_quality: position.liquidity_quality ?? null,
      fraud_risk: position.fraud_risk ?? null,
      current_price: toNum(position.current_price, 0),
      ...(position.last_market_snapshot || {})
    },
    market_data: position.last_market_snapshot?.market_data || null,
    liquidity_data: position.last_market_snapshot?.liquidity_data || null,
    execution_data: position.last_market_snapshot?.execution_data || null
  });
}

function attachRiskDecisionMetadata(target, decision, context = {}) {
  if (!target || !decision?.risk_decision_id) return null;
  const ref = buildRiskDecisionRef(decision, context);
  target.risk_decision_id = decision.risk_decision_id;
  target.risk_decision_ref = ref;
  applyEvidenceMetadata(target, decision);
  if (target.paper_trade_ticket && typeof target.paper_trade_ticket === "object") {
    target.paper_trade_ticket.risk_decision_id = decision.risk_decision_id;
    target.paper_trade_ticket.risk_decision_ref = ref;
    target.paper_trade_ticket.risk_engine = {
      decision: decision.decision,
      policy_version: decision.policy_version,
      input_snapshot_hash: decision.input_snapshot_hash,
      blockers: decision.blockers,
      warnings: decision.warnings,
      checked_limits: decision.checked_limits
    };
  }
  return ref;
}

function classifyExitReasonForPolicy(reason) {
  const text = String(reason || "").toLowerCase();
  const root = text.split(":")[0];
  if (root.includes("stop")) return "stop_loss";
  if (root.includes("target")) return "target";
  if (root.includes("rotation_out")) return "rotation_out";
  if (root.includes("non_tradeable")) return "non_tradeable_force_exit";
  if (root.includes("harvest")) return "harvest_exit";
  return root || "unknown";
}

function computeRecentClosedTradeMetrics(portfolio, windowMs = null) {
  const settings = portfolio?.settings || SETTINGS_DEFAULTS;
  const resolvedWindowMs = windowMs ?? Math.max(1, toNum(settings.recent_performance_window_hours, 24)) * 60 * 60 * 1000;
  const cutoff = Date.now() - resolvedWindowMs;
  const closed = (Array.isArray(portfolio?.closed_trades) ? portfolio.closed_trades : [])
    .filter((trade) => trade?.side === "sell")
    .filter((trade) => Number.isFinite(toNum(trade?.pnl_usd, NaN)))
    .filter((trade) => {
      const ts = Date.parse(trade?.ts || "");
      return Number.isFinite(ts) && ts >= cutoff;
    });
  const wins = closed.filter((trade) => toNum(trade.pnl_usd, 0) > 0);
  const losses = closed.filter((trade) => toNum(trade.pnl_usd, 0) < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + toNum(trade.pnl_usd, 0), 0);
  const grossLoss = losses.reduce((sum, trade) => sum + toNum(trade.pnl_usd, 0), 0);
  const realizedPnl = grossProfit + grossLoss;

  return {
    source: "portfolio_recent_window",
    window_hours: resolvedWindowMs / (60 * 60 * 1000),
    closed_trade_count: closed.length,
    win_rate: closed.length ? (wins.length / closed.length) * 100 : 0,
    realized_pnl_usd: realizedPnl,
    gross_profit_usd: grossProfit,
    gross_loss_usd: grossLoss,
    profit_factor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : (grossProfit > 0 ? null : 0),
    stop_loss_count: closed.filter((trade) => classifyExitReasonForPolicy(trade.reason) === "stop_loss").length
  };
}

function computeRecentPerformanceThrottleMultiplier(profitFactor) {
  const normalizedProfitFactor = toNum(profitFactor, 1);
  let multiplier = 1;
  if (normalizedProfitFactor < 0.2) multiplier = 0.3;
  else if (normalizedProfitFactor < 0.4) multiplier = 0.5;
  else if (normalizedProfitFactor < 0.7) multiplier = 0.7;
  return Math.max(0.3, Math.min(1, multiplier));
}

function buildRegimeSentinelPolicy(portfolio, quantContext) {
  const perf = readLatestJsonReport("performance-daily-");
  const reportPerf24 = perf?.windows?.["24h"]?.metrics || {};
  const rollingPerf24 = computeRecentClosedTradeMetrics(portfolio);
  const perf24 = rollingPerf24.closed_trade_count > 0 ? rollingPerf24 : { ...reportPerf24, source: "performance_daily_report" };
  const reviewStats = buildRecentReviewStats(200);
  const macro = quantContext?.macro || {};
  const settings = portfolio?.settings || SETTINGS_DEFAULTS;
  const base = regimePolicy(macro.regime || portfolio?.stats?.market_regime || "neutral", settings);
  const reasonCodes = [];
  let allocationMultiplier = toNum(base.allocation_multiplier, 1);
  let allowBuys = Boolean(base.allow_buys);
  let allowRotations = Boolean(base.allow_rotations);
  let maxBuys = toNum(base.max_buys_per_cycle, settings.max_buys_per_cycle);
  let maxRotations = toNum(base.max_rotations_per_cycle, settings.max_rotations_per_cycle);
  const equity = equityUsd(portfolio);
  const hasSufficientSample = toNum(perf24.closed_trade_count, 0) >= 10;
  const hasMaterialLoss = toNum(perf24.realized_pnl_usd, 0) <= (-0.005 * equity);

  if (toNum(perf24.profit_factor, 1) < 0.7) {
    if (!hasSufficientSample) {
      reasonCodes.push("throttle_skipped_low_sample");
    } else if (!hasMaterialLoss) {
      reasonCodes.push("throttle_skipped_immaterial_loss");
    } else {
      allowBuys = Boolean(base.allow_buys);
      maxBuys = allowBuys ? Math.max(1, maxBuys - 1) : 0;
      allocationMultiplier = allowBuys ? Math.min(allocationMultiplier, computeRecentPerformanceThrottleMultiplier(perf24.profit_factor)) : 0;
      reasonCodes.push("negative_recent_profit_factor");
      reasonCodes.push("new_buys_throttled_by_recent_losses");
    }
  }
  if (toNum(perf24.stop_loss_count, 0) >= 2) {
    allowBuys = false;
    maxBuys = 0;
    reasonCodes.push("stop_loss_cluster");
  }
  if (toNum(perf24.win_rate, 0) >= 60 && toNum(perf24.realized_pnl_usd, 0) < 0) {
    allocationMultiplier = Math.min(allocationMultiplier, 0.6);
    reasonCodes.push("high_win_rate_negative_expectancy");
  }
  if (String(base.regime) === "risk_off") {
    allowBuys = false;
    allowRotations = false;
    maxBuys = 0;
    maxRotations = 0;
    reasonCodes.push("risk_off_blocks_speculative_buys");
  }
  if (macro?.btc && toNum(macro.btc.change_24h_pct, 0) < -3) reasonCodes.push("btc_downtrend");
  // Cross-asset macro annotations — informational only. The actual gating already happened
  // via `regime` (computed in buildCycleQuantContext, which folds these same readings in);
  // these reason codes exist purely so it's visible in logs *why* a cycle got throttled.
  if (macro?.equity_index && toNum(macro.equity_index.change_24h_pct, 0) < -2) reasonCodes.push("equity_selloff_correlated");
  if (macro?.dxy && toNum(macro.dxy.change_24h_pct, 0) > 0.5) reasonCodes.push("dollar_strength_headwind");
  if (macro?.regulatory?.stance === "risk_on") reasonCodes.push("regulatory_flag_risk_on");
  if (macro?.regulatory?.stance === "risk_off") reasonCodes.push("regulatory_flag_risk_off");
  if (!reasonCodes.length) reasonCodes.push("baseline_regime_policy");

  return {
    regime: base.regime || "neutral",
    confidence: Math.min(0.95, 0.55 + reasonCodes.length * 0.08),
    allow_new_buys: allowBuys,
    allow_buys: allowBuys,
    allow_rotations: allowRotations,
    allow_harvest_exits: true,
    max_buys_per_cycle: maxBuys,
    max_rotations_per_cycle: maxRotations,
    allocation_multiplier: allocationMultiplier,
    tighten_stops: Boolean(macro.tighten_stops || reasonCodes.includes("negative_recent_profit_factor")),
    reason_codes: reasonCodes,
    recent_performance: {
      win_rate: perf24.win_rate ?? null,
      realized_pnl_usd: perf24.realized_pnl_usd ?? null,
      profit_factor: perf24.profit_factor ?? null,
      stop_loss_count: perf24.stop_loss_count ?? null,
      closed_trade_count: perf24.closed_trade_count ?? null,
      window_hours: perf24.window_hours ?? null,
      source: perf24.source || "unknown"
    },
    review_stats: {
      review_count: reviewStats.review_count,
      negative_count: reviewStats.negative_count,
      avoidable_loss_count: reviewStats.avoidable_loss_count
    }
  };
}

function buildSignalSnapshotForToken(token, portfolio) {
  const addr = cleanAddress(token?.contract_address || "");
  const sym = String(token?.symbol || "").toUpperCase();
  const flow = addr ? _cycleQuantContext?.token_flow?.[addr] : null;
  const funding = sym ? _cycleQuantContext?.funding_rates?.[sym] : null;
  const liquidity = toNum(token?.liquidity_usd ?? token?.liquidity_data?.liquidity_usd, 0);
  const change24 = toNum(token?.change_24h_pct ?? token?.market_data?.change_24h_pct, 0);
  const positiveReasons = [];
  const negativeReasons = [];
  const missingSources = [];
  if (change24 > 5) positiveReasons.push("positive_24h_momentum");
  if (change24 < -5) negativeReasons.push("negative_24h_momentum");
  if (liquidity >= 250000) positiveReasons.push("liquidity_sufficient");
  if (liquidity > 0 && liquidity < 100000) negativeReasons.push("liquidity_thin");
  if (!liquidity) missingSources.push("liquidity");
  if (flow?.flow_direction === "accumulation") positiveReasons.push("smart_wallet_accumulation");
  if (flow?.flow_direction === "distribution") negativeReasons.push("smart_wallet_distribution");
  if (!flow) missingSources.push("token_flow");
  if (funding?.signal === "overcrowded_long") negativeReasons.push("overcrowded_long_funding");
  if (!funding) missingSources.push("funding");

  return {
    symbol: token?.symbol || "unknown",
    contract_address: token?.contract_address || null,
    generated_at: nowIso(),
    signals: {
      story_momentum: Math.max(0, Math.min(1, (change24 + 20) / 40)),
      smart_wallet_accumulation: flow?.flow_direction === "accumulation" ? 0.7 : 0.35,
      liquidity_trend: liquidity >= 250000 ? 0.8 : liquidity >= 100000 ? 0.55 : 0.2,
      holder_concentration_risk: 0.5,
      social_velocity: 0,
      contract_risk: toNum(token?.fraud_risk, 0) / 100,
      quote_depth_quality: liquidity >= 250000 ? 0.8 : liquidity >= 100000 ? 0.5 : 0.2
    },
    positive_reasons: positiveReasons,
    negative_reasons: negativeReasons,
    missing_sources: missingSources,
    source_metadata: {
      generated_from: ["e3d", "quant_context", "portfolio"],
      market_regime: portfolio?.stats?.market_regime || "unknown"
    }
  };
}

function buildCycleSignalSnapshot(portfolio) {
  const tokens = Object.values(portfolio?.positions || {}).map((pos) => ({
    symbol: pos.symbol,
    contract_address: pos.contract_address,
    liquidity_usd: pos.liquidity_usd,
    change_24h_pct: pos.last_market_snapshot?.market_data?.change_24h_pct,
    fraud_risk: pos.fraud_risk
  }));
  return {
    generated_at: nowIso(),
    signals: tokens.map((token) => buildSignalSnapshotForToken(token, portfolio))
  };
}

function buildArbitrageSignals(portfolio) {
  return Object.values(portfolio?.positions || {}).slice(0, 8).map((pos) => {
    const price = toNum(pos.current_price, 0);
    const snapshotPrice = toNum(pos.last_market_snapshot?.market_data?.current_price, price);
    const grossSpreadPct = price > 0 && snapshotPrice > 0 ? Math.abs(price - snapshotPrice) / price * 100 : 0;
    const estimatedCostPct = 0.9;
    const netEdgePct = grossSpreadPct - estimatedCostPct;
    return {
      symbol: pos.symbol,
      contract_address: pos.contract_address,
      observed_at: nowIso(),
      venue_a: "e3d_portfolio_mark",
      venue_b: "latest_market_snapshot",
      gross_spread_pct: Number(grossSpreadPct.toFixed(4)),
      estimated_cost_pct: estimatedCostPct,
      net_edge_pct: Number(netEdgePct.toFixed(4)),
      feasibility: netEdgePct > 0 ? "watch_only" : "not_viable",
      reason_codes: netEdgePct > 0 ? ["spread_positive_after_costs"] : ["spread_below_estimated_costs"],
      execution_allowed: false
    };
  });
}

function isInCooldown(portfolio, symbol) {
  if (!portfolio || !symbol) return false;
  const entry = normalizeCooldownEntry(portfolio.cooldowns?.[symbol]);
  if (!entry?.until) return false;
  return new Date(entry.until).getTime() > Date.now();
}

function categoryExposurePct(portfolio, category) {
  if (!portfolio || !category) return 0;
  const positions = Object.values(portfolio.positions || {});
  const equity = equityUsd(portfolio);
  if (!(equity > 0)) return 0;

  const categoryMarketValue = positions.reduce((sum, pos) => {
    if (String(pos.category || "unknown") !== String(category || "unknown")) return sum;
    return sum + toNum(pos.market_value_usd, 0);
  }, 0);

  return categoryMarketValue / equity;
}

function resolveExecutorExitFraction(action, review) {
  const reviewed = toNum(review?.approved_exit_fraction, NaN);
  if (Number.isFinite(reviewed) && reviewed > 0) {
    return Math.max(0, Math.min(1, reviewed));
  }

  const actionFraction = toNum(action?.suggested_exit_fraction, NaN);
  if (Number.isFinite(actionFraction) && actionFraction > 0) {
    return Math.max(0, Math.min(1, actionFraction));
  }

  return 0.5;
}

function buildTradeId(trade, context = {}) {
  return sha256({
    side: trade?.side || null,
    symbol: trade?.symbol || null,
    contract_address: trade?.contract_address || null,
    reason: trade?.reason || null,
    quantity: toNum(trade?.quantity, 0),
    price: toNum(trade?.price, 0),
    candidate_id: trade?.candidate_id || null,
    position_id: trade?.position_id || null,
    ts: trade?.ts || null,
    pipeline_run_id: context?.pipeline_run_id || null,
    cycle_id: context?.cycle_id || null,
    cycle_index: context?.cycle_index ?? null
  });
}

function ensureCandidateTrainingMetadata(candidate, context = {}) {
  const token = candidate?.token || {};
  const candidateId =
    candidate?.candidate_id ||
    candidate?.id ||
    token.contract_address ||
    token.symbol ||
    sha256({ token, context, summary: candidate?.summary || candidate?.thesis_summary || null });

  const positionId =
    candidate?.position_id ||
    candidate?.training_position_id ||
    sha256({ candidate_id: candidateId, context, kind: candidate?.action || candidate?.trade_kind || "position" });

  if (candidate && typeof candidate === "object") {
    candidate.candidate_id = candidateId;
    candidate.training_candidate_id = candidateId;
    candidate.training_position_id = positionId;
  }

  return {
    candidate_id: candidateId,
    position_id: positionId
  };
}

function buildExecutorProposal(action, portfolio, tradeKind) {
  const candidate = action?.candidate || action?.to_candidate || null;
  const token = candidate?.token || candidate || action?.token || null;

  return {
    trade_kind: tradeKind,
    action: deepClone(action || {}),
    candidate: candidate ? deepClone(candidate) : null,
    token: token ? deepClone(token) : null,
    portfolio_snapshot: {
      cash_usd: toNum(portfolio?.cash_usd, 0),
      equity_usd: equityUsd(portfolio),
      market_regime: portfolio?.stats?.market_regime || "unknown",
      open_positions: Object.keys(portfolio?.positions || {}).length
    },
    proposed_allocation_usd: toNum(action?.allocation_usd, 0),
    proposed_exit_fraction: toNum(action?.suggested_exit_fraction ?? action?.sell_fraction, 0),
    position_sizing: action?.position_sizing || null,
    regime_policy: _cycleRegimePolicy || null,
    signal_snapshot: token?.contract_address && _cycleSignalSnapshot?.signals
      ? _cycleSignalSnapshot.signals.find((item) => cleanAddress(item.contract_address) === cleanAddress(token.contract_address)) || null
      : null,
    arbitrage_signal: token?.contract_address && Array.isArray(_cycleArbitrageSignals)
      ? _cycleArbitrageSignals.find((item) => cleanAddress(item.contract_address) === cleanAddress(token.contract_address)) || null
      : null,
    reason: action?.reason || null,
    from_symbol: action?.from_symbol || null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCliArgs(argv) {
  const args = {
    loop: false,
    intervalMs: 5 * 60 * 1000,
    maxIterations: Infinity,
    debug: PIPELINE_DEBUG_MODE
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--loop") {
      args.loop = true;
      continue;
    }

    if (arg === "--once") {
      args.loop = false;
      continue;
    }

    if (arg === "--interval-seconds" && argv[i + 1]) {
      args.intervalMs = Math.max(1000, toNum(argv[i + 1], 300) * 1000);
      i += 1;
      continue;
    }

    if (arg.startsWith("--interval-seconds=")) {
      const value = arg.split("=")[1];
      args.intervalMs = Math.max(1000, toNum(value, 300) * 1000);
      continue;
    }

    if (arg === "--max-iterations" && argv[i + 1]) {
      args.maxIterations = Math.max(1, Math.floor(toNum(argv[i + 1], Infinity)));
      i += 1;
      continue;
    }

    if (arg.startsWith("--max-iterations=")) {
      const value = arg.split("=")[1];
      args.maxIterations = Math.max(1, Math.floor(toNum(value, Infinity)));
      continue;
    }

    if (arg === "--debug") {
      args.debug = true;
      continue;
    }

    if (arg === "--no-debug") {
      args.debug = false;
      continue;
    }
  }

  return args;
}

function printPortfolioSummary(portfolio) {
  const stats = portfolio.stats || {};
  const positions = Object.values(portfolio.positions || {});
  const summary = {
    cash_usd: toNum(portfolio.cash_usd, 0),
    equity_usd: toNum(stats.equity_usd, toNum(portfolio.cash_usd, 0)),
    realized_pnl_usd: toNum(stats.realized_pnl_usd, 0),
    unrealized_pnl_usd: toNum(stats.unrealized_pnl_usd, 0),
    max_drawdown_pct: toNum(stats.max_drawdown_pct, 0),
    market_regime: stats.market_regime || "unknown",
    open_positions: positions.length,
    symbols: positions.map((pos) => pos.symbol).sort()
  };

  console.log("📊 Portfolio summary:\n");
  console.log(JSON.stringify(summary, null, 2));
  log("portfolio_summary", {
    ...summary,
    maps_context: _cycleMapsContext || null
  });
}

function buildUrl(baseUrl, pathname, query = {}) {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/^\/+|\/+$/g, "");
  const rawPathname = String(pathname || "");
  let relativePath = rawPathname.replace(/^\/+/, "");

  if (basePath && relativePath.startsWith(`${basePath}/`)) {
    relativePath = relativePath.slice(basePath.length + 1);
  } else if (relativePath === basePath) {
    relativePath = "";
  }

  const resolvedBase = `${base.origin}${basePath ? `/${basePath}/` : "/"}`;
  const url = new URL(relativePath, resolvedBase);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function fetchJson(pathname, query = {}, fallback = null) {
  // Enforce daily budget
  if (_e3dRequestCount >= E3D_REQUEST_DAILY_BUDGET) {
    log("e3d_api_budget_exceeded", { count: _e3dRequestCount, budget: E3D_REQUEST_DAILY_BUDGET });
    return fallback;
  }

  // Enforce minimum interval between requests
  const now = Date.now();
  const elapsed = now - _e3dLastRequestAt;
  if (_e3dLastRequestAt > 0 && elapsed < E3D_REQUEST_MIN_INTERVAL_MS) {
    sleepSync(E3D_REQUEST_MIN_INTERVAL_MS - elapsed);
  }
  _e3dLastRequestAt = Date.now();
  _e3dRequestCount++;

  const url = buildUrl(E3D_API_BASE_URL, pathname, query);
  try {
    const startedAt = Date.now();
    log("e3d_api_request", { url, pathname, query, req_num: _e3dRequestCount });
    const marker = "__E3D_HTTP_STATUS__";
    const stdout = runShell("curl", ["-s", "--max-time", "30", "-L", "-o", "-", "-w", `${marker}%{http_code}`, ...buildCurlAuthArgs(url), url]);
    const output = String(stdout || "");
    const markerIndex = output.lastIndexOf(marker);
    const text = markerIndex >= 0 ? output.slice(0, markerIndex).trim() : output.trim();
    const statusText = markerIndex >= 0 ? output.slice(markerIndex + marker.length).trim() : "000";
    const statusCode = Number(statusText) || 0;
    const durationMs = Date.now() - startedAt;

    if (statusCode < 200 || statusCode >= 300) {
      log("e3d_api_error", { url, pathname, query, status: statusCode || null, duration_ms: durationMs });
      return fallback;
    }

    log("e3d_api_response", { url, pathname, query, status: statusCode, duration_ms: durationMs, bytes: text.length });
    if (!text) return fallback;
    return JSON.parse(text);
  } catch (err) {
    log("e3d_api_error", { url, pathname, query, message: err.message });
    return fallback;
  }
}

function e3dFetch(url, fallback = null) {
  try {
    const parsed = new URL(String(url || ""));
    const pathname = parsed.pathname.replace(/^\/+/, "");
    const query = Object.fromEntries(parsed.searchParams.entries());
    const cleanPath = pathname.startsWith("api/") ? pathname.slice(3) : pathname;
    return fetchJson(cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`, query, fallback);
  } catch (err) {
    log("e3d_api_error", { url: String(url || ""), message: err.message });
    return fallback;
  }
}

function postJson(pathname, body) {
  const url = buildUrl(E3D_API_BASE_URL, pathname, {});
  const marker = "__E3D_HTTP_STATUS__";
  try {
    const stdout = runShell("curl", [
      "-s", "--max-time", "30",
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "-o", "-", "-w", `${marker}%{http_code}`,
      "--data-binary", "@-",
      ...buildCurlAuthArgs(url),
      url
    ], { input: JSON.stringify(body) });
    const output = String(stdout || "");
    const markerIndex = output.lastIndexOf(marker);
    const statusCode = Number(markerIndex >= 0 ? output.slice(markerIndex + marker.length).trim() : "0") || 0;
    const text = markerIndex >= 0 ? output.slice(0, markerIndex).trim() : output.trim();
    if (statusCode < 200 || statusCode >= 300) {
      log("e3d_api_error", { url, pathname, status: statusCode });
      return null;
    }
    return text ? JSON.parse(text) : null;
  } catch (err) {
    log("e3d_api_error", { url, pathname, message: err.message });
    return null;
  }
}

function sendTradeEmail(trade) {
  try {
    const side = trade.side === "buy" ? "BUY" : "SELL";
    const symbol = trade.symbol || "?";
    const price = trade.price ? `$${toNum(trade.price, 0).toFixed(6)}` : "?";
    const decision = trade.paper_trade_ticket?.executor_decision || null;
    const mode = decision === "approve_live" ? "LIVE" : "PAPER";
    const subject = `[${mode}] ${side} ${symbol} @ ${price}`;

    const amountLine = trade.side === "buy"
      ? `Amount: $${toNum(trade.cost_usd, 0).toFixed(2)}`
      : `Proceeds: $${toNum(trade.proceeds_usd, 0).toFixed(2)} &nbsp;|&nbsp; PnL: $${toNum(trade.pnl_usd, 0).toFixed(2)}`;

    const html = `<h2>${side} ${symbol}</h2><ul>`
      + `<li><b>Mode:</b> ${mode}</li>`
      + `<li><b>Price:</b> ${price}</li>`
      + `<li><b>${amountLine}</b></li>`
      + `<li><b>Reason:</b> ${trade.reason || "—"}</li>`
      + `<li><b>Lifecycle:</b> ${trade.trade_lifecycle || "—"}</li>`
      + `<li><b>Trade ID:</b> ${trade.trade_id || "—"}</li>`
      + `<li><b>Time:</b> ${trade.ts}</li>`
      + `</ul>`;

    postJson("/email", { subject, html });
    log("trade_email_sent", { side: trade.side, symbol, mode });
  } catch (err) {
    log("trade_email_error", { message: err.message });
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["stories", "candidates", "tokens", "items", "data", "results", "theses", "opportunities", "wallets", "rows"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function clampScore(value, min = 0, max = 100) {
  const n = toNum(value, min);
  return Math.max(min, Math.min(max, n));
}

function stripText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function compactText(value, maxLength = 220) {
  const text = stripText(value);
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function extractFirstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function daysSince(value) {
  if (!value) return NaN;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return NaN;
  return Math.max(0, (Date.now() - ts) / 86400000);
}

function endpointArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["candidates", "stories", "actions", "items", "data", "results", "theses", "opportunities", "wallets", "rows", "transactions", "txs"] ) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function mergeUniqueStories(...groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const item of endpointArray(group)) {
      const story = item && typeof item === "object" ? item : null;
      if (!story) continue;
      const key = String(story.id || story.story_id || story.source_story_id || `${story.title || ""}::${story.subtitle || ""}`).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(story);
    }
  }
  return out;
}

function classifyStoryTone(story) {
  const text = stripText([
    story?.story_type,
    story?.title,
    story?.subtitle,
    story?.ai_narrative,
    story?.summary,
    story?.meta?.ai_narrative,
    story?.meta?.ai_takeaways,
    story?.meta?.ai_risks
  ].filter(Boolean).join(" ")).toLowerCase();

  const positiveKeywords = [
    "accum",
    "breakout",
    "catalyst",
    "rotation",
    "inflow",
    "sponsor",
    "support",
    "launch",
    "conviction",
    "confirmation",
    "broadening",
    "strength",
    "bull",
    "buy",
    "surge",
    "reversal"
  ];
  const negativeKeywords = [
    "distribution",
    "decay",
    "exhaustion",
    "risk",
    "warning",
    "sell",
    "exit",
    "drain",
    "fade",
    "weak",
    "fraud",
    "collapse",
    "bear",
    "outflow",
    "liquidity"
  ];

  const positiveHits = positiveKeywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0);
  const negativeHits = negativeKeywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0);

  if (positiveHits > negativeHits) return "opportunity";
  if (negativeHits > positiveHits) return "risk";
  return positiveHits || negativeHits ? "mixed" : "neutral";
}

function summarizeStory(story, source = "legacy") {
  if (!story || typeof story !== "object") return null;
  const tone = classifyStoryTone(story);
  const summaryText = stripText(story.ai_narrative || story.subtitle || story.summary || story.title || "");
  return {
    id: String(story.id || story.story_id || story.source_story_id || sha256(story)),
    source,
    tone,
    story_type: String(story.story_type || story.type || tone || "unknown").toUpperCase(),
    title: compactText(story.title || story.story_title || story.name || ""),
    subtitle: compactText(summaryText || story.subtitle || ""),
    score: toNum(story.score || story.opportunity_score || story.thesis_score, 0),
    derived_count: toNum(story.derived_count || story.meta?.derived_count, 0),
    source_story_id: String(story.source_story_id || story.meta?.source_story_id || story.derived_from_story_id || "") || null,
    question_type: String(story.question_type || story.meta?.question_type || story.derived_question_type || "") || null,
    ts_created: story.ts_created || story.created_at || story.timestamp || null,
    evidence: compactText(story.evidence || story.rationale || story.description || summaryText, 260)
  };
}

function summarizeStories(stories, source, limit = E3D_DOSSIER_MAX_STORIES) {
  return mergeUniqueStories(endpointArray(stories))
    .map((story) => summarizeStory(story, source))
    .filter(Boolean)
    .sort((a, b) => {
      const aPriority = String(a?.story_type || "").toUpperCase() === "THESIS" ? 2 : a.tone === "opportunity" ? 1 : 0;
      const bPriority = String(b?.story_type || "").toUpperCase() === "THESIS" ? 2 : b.tone === "opportunity" ? 1 : 0;
      return (
        bPriority - aPriority ||
        toNum(b.score, 0) - toNum(a.score, 0) ||
        new Date(b.ts_created || 0).getTime() - new Date(a.ts_created || 0).getTime()
      );
    })
    .slice(0, limit);
}

function summarizeTransaction(transaction, source = "fetchTransactionsDB") {
  if (!transaction || typeof transaction !== "object") return null;
  const ts = transaction.ts || transaction.timestamp || transaction.block_timestamp || transaction.created_at || transaction.time || null;
  const amount = toNum(transaction.amount, transaction.token_amount || transaction.qty || transaction.quantity || 0, 0);
  const usdValue = toNum(transaction.usd_value, transaction.value_usd, transaction.valueUsd, transaction.value, 0);
  return {
    id: String(transaction.id || transaction.tx_hash || transaction.hash || transaction.transaction_hash || sha256(transaction)),
    source,
    ts,
    tx_hash: String(transaction.tx_hash || transaction.hash || transaction.transaction_hash || transaction.id || "") || null,
    block_number: transaction.block_number ?? transaction.blockNumber ?? null,
    from: cleanAddress(transaction.from || transaction.from_address || transaction.sender || "") || null,
    to: cleanAddress(transaction.to || transaction.to_address || transaction.recipient || "") || null,
    symbol: compactText(transaction.symbol || transaction.token_symbol || transaction.ticker || "", 40) || null,
    contract_address: cleanAddress(transaction.contract_address || transaction.token_address || transaction.address || "") || null,
    side: String(transaction.side || transaction.direction || transaction.trade_side || transaction.type || "").trim() || null,
    amount,
    usd_value: usdValue,
    price: toNum(transaction.price || transaction.unit_price || transaction.token_price, 0),
    method: compactText(transaction.method || transaction.function_name || transaction.action || transaction.category || "", 80) || null,
    chain: String(transaction.chain || transaction.network || transaction.chain_name || "").trim() || null
  };
}

function summarizeTransactions(transactions, source, limit = 25) {
  return endpointArray(transactions)
    .map((transaction) => summarizeTransaction(transaction, source))
    .filter(Boolean)
    .sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime())
    .slice(0, limit);
}

function summarizeTrendingToken(row, bucket = "trending") {
  if (!row || typeof row !== "object") return null;
  return {
    id: String(row.id || row.contract_address || row.address || row.token_address || row.symbol || sha256(row)),
    bucket,
    symbol: compactText(row.symbol || row.ticker || row.name || "", 40) || null,
    name: compactText(row.name || row.token_name || row.display_name || row.title || "", 80) || null,
    contract_address: cleanAddress(row.contract_address || row.address || row.token_address || "") || null,
    current_price: toNum(row.current_price || row.priceUSD || row.price_usd || row.price, 0),
    change_24h_pct: toNum(row.change_24h_pct || row.change_24H || row.change_24h || row.price_change_24h_pct, 0),
    volume_24h_usd: toNum(row.volume_24h_usd || row.volume24h || row.volume_24H || row.volume, 0),
    market_cap_usd: toNum(row.market_cap_usd || row.marketCap || row.market_cap, 0),
    liquidity_usd: toNum(row.liquidity_usd || row.liquidity, 0),
    price_timestamp: row.timestamp || row.ts_created || row.updated_at || null
  };
}

function summarizeTrendingTokens(rows, bucket, limit = 10) {
  return endpointArray(rows)
    .map((row) => summarizeTrendingToken(row, bucket))
    .filter(Boolean)
    .sort((a, b) => toNum(b.change_24h_pct, 0) - toNum(a.change_24h_pct, 0))
    .slice(0, limit);
}

function mergeUniqueTokens(...groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const item of endpointArray(group)) {
      const token = item && typeof item === "object" ? item : null;
      if (!token) continue;
      const key = cleanAddress(token.contract_address || token.address || token.token_address || token.id || "") || String(token.symbol || token.ticker || token.name || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  }
  return out;
}

function summarizeCounterparties(rows, limit = E3D_DOSSIER_MAX_COUNTERPARTIES) {
  return endpointArray(rows)
    .slice(0, limit)
    .map((row) => ({
      address: cleanAddress(row?.address || row?.counterparty || row?.wallet || "") || null,
      name: compactText(row?.name || row?.label || "", 80) || null,
      symbol: compactText(row?.symbol || row?.token_symbol || "", 40) || null,
      value: toNum(row?.value || row?.tx_count || row?.count || 0, 0),
      icon: row?.icon || null,
      icon2: row?.icon2 || null
    }))
    .filter((item) => item.address || item.name || item.symbol);
}

function pickMarketRow(feed, address, symbol) {
  const rows = endpointArray(feed);
  if (!rows.length) return null;
  const normalizedAddress = cleanAddress(address || "");
  const normalizedSymbol = String(symbol || "").trim().toLowerCase();
  const byAddress = rows.find((row) => cleanAddress(row?.address || row?.contract_address || row?.token_address || row?.id || "") === normalizedAddress);
  if (byAddress) return byAddress;
  const bySymbol = rows.find((row) => String(row?.symbol || row?.ticker || row?.name || "").trim().toLowerCase() === normalizedSymbol);
  if (bySymbol) return bySymbol;
  return rows[0] || null;
}

function extractMarketSnapshot(position, identity, tokenInfo, marketFeed) {
  const row = pickMarketRow(marketFeed, position?.contract_address, position?.symbol);
  const baseCurrentPrice = toNum(position?.current_price, NaN);
  const currentPrice = Number.isFinite(baseCurrentPrice)
    ? baseCurrentPrice
    : extractFirstNumber(row?.current_price, row?.priceUSD, row?.price_usd, row?.price, tokenInfo?.current_price, tokenInfo?.price, tokenInfo?.market_data?.current_price, 0);

  const volume24hUsd = extractFirstNumber(
    row?.volume_24h_usd,
    row?.volume24h,
    row?.volume_24H,
    row?.volume,
    tokenInfo?.volume_24h_usd,
    tokenInfo?.volume_24h,
    tokenInfo?.market_data?.volume_24h_usd,
    0
  );

  const marketCapUsd = extractFirstNumber(
    row?.market_cap_usd,
    row?.marketCap,
    row?.market_cap,
    tokenInfo?.market_cap_usd,
    tokenInfo?.market_cap,
    tokenInfo?.market_data?.market_cap_usd,
    0
  );

  const liquidityUsd = extractFirstNumber(
    position?.liquidity_usd,
    position?.last_market_snapshot?.liquidity_data?.liquidity_usd,
    row?.liquidity_usd,
    row?.liquidity,
    tokenInfo?.liquidity_usd,
    tokenInfo?.liquidity,
    0
  );

  const change24hPct = extractFirstNumber(
    position?.last_market_snapshot?.market_data?.change_24h_pct,
    row?.change_24h_pct,
    row?.change_24H,
    row?.change_24h,
    row?.price_change_24h_pct,
    tokenInfo?.change_24h_pct,
    tokenInfo?.market_data?.change_24h_pct,
    0
  );

  return {
    current_price: currentPrice || 0,
    change_24h_pct: change24hPct || 0,
    volume_24h_usd: volume24hUsd || 0,
    market_cap_usd: marketCapUsd || 0,
    liquidity_usd: liquidityUsd || 0,
    price_source: row ? "fetchTokensDB" : tokenInfo ? "token-info" : "position",
    price_timestamp: row?.timestamp || row?.ts_created || position?.last_updated_at || nowIso(),
    liquidity_timestamp: position?.last_updated_at || nowIso()
  };
}

function deriveActionTilt(metrics) {
  const opportunityScore = toNum(metrics?.opportunity_score, 0);
  const thesisFreshness = toNum(metrics?.thesis_freshness, 0);
  const narrativeDecay = toNum(metrics?.narrative_decay, 0);
  const fraudRisk = toNum(metrics?.fraud_risk, 0);
  const pnlPct = toNum(metrics?.pnl_pct, 0);

  if (fraudRisk >= 70 || narrativeDecay >= 75) return "exit";
  if (narrativeDecay >= 50 || thesisFreshness < 35 || (pnlPct < -20 && narrativeDecay >= 35)) return "trim";
  if (opportunityScore >= 70 && thesisFreshness >= 45 && fraudRisk < 40) return "buy";
  if (pnlPct > 25 && opportunityScore < 55) return "trim";
  if (opportunityScore >= 55) return "hold";
  return "watch";
}

function computeDossierScores({ position, stories, opportunityStories, thesisStories, riskStories, counterparties, tokenCounterparties, marketData, flowSummary, walletCohort }) {
  const allStories = endpointArray(stories);
  const opportunityList = endpointArray(opportunityStories);
  const thesisList = endpointArray(thesisStories);
  const riskList = endpointArray(riskStories);
  const latestStoryDates = allStories
    .map((story) => daysSince(story?.ts_created || story?.created_at || story?.timestamp))
    .filter((value) => Number.isFinite(value));
  const latestStoryAgeDays = latestStoryDates.length ? Math.min(...latestStoryDates) : NaN;
  const derivedStoryCount = allStories.reduce((sum, story) => sum + toNum(story?.derived_count || story?.meta?.derived_count, 0), 0);
  const positiveStoryCount = allStories.filter((story) => classifyStoryTone(story) === "opportunity").length + opportunityList.length + thesisList.length;
  const negativeStoryCount = allStories.filter((story) => classifyStoryTone(story) === "risk").length + riskList.length;
  const conflictCount = allStories.filter((story) => classifyStoryTone(story) === "mixed").length;
  const counterpartyCount = endpointArray(counterparties).length + endpointArray(tokenCounterparties).length;
  const flowSignal = stripText(flowSummary?.direction || flowSummary?.trend || flowSummary?.flow_direction || walletCohort?.flow_direction || "neutral").toLowerCase();
  const positionPnlPct = (() => {
    const basis = toNum(position?.cost_basis_usd, 0);
    const marketValue = toNum(position?.market_value_usd, 0);
    return basis > 0 ? ((marketValue - basis) / basis) * 100 : 0;
  })();
  const marketChange = toNum(marketData?.change_24h_pct, 0);
  const liquidityUsd = toNum(marketData?.liquidity_usd, 0);
  const liquidityQuality = clampScore(
    toNum(position?.liquidity_quality, NaN) ||
    (liquidityUsd > 0 ? Math.log10(liquidityUsd + 10) * 18 : 55) ||
    (marketData?.market_cap_usd > 0 ? Math.log10(marketData.market_cap_usd + 10) * 10 : 55)
  );

  const thesisFreshness = clampScore(
    100 - (Number.isFinite(latestStoryAgeDays) ? latestStoryAgeDays * 12 : 35) + Math.min(12, positiveStoryCount * 2 + thesisList.length * 2)
  );
  const thesisStrength = clampScore(
    20 + positiveStoryCount * 14 + thesisList.length * 10 + derivedStoryCount * 3 + (counterpartyCount > 0 ? 8 : 0) + (marketChange > 0 ? Math.min(12, marketChange) : 0) - negativeStoryCount * 9 - conflictCount * 4
  );
  const narrativeDecay = clampScore(
    100 - thesisFreshness + negativeStoryCount * 10 + conflictCount * 6 + Math.max(0, latestStoryAgeDays - 7) * 2
  );
  const flowAlignment = clampScore(
    45 + counterpartyCount * 5 + (flowSignal.includes("in") || flowSignal.includes("accum") ? 18 : 0) + (flowSignal.includes("out") || flowSignal.includes("dist") ? -18 : 0) - negativeStoryCount * 4
  );
  const fraudRisk = clampScore(
    toNum(position?.fraud_risk, NaN) ||
    (negativeStoryCount > positiveStoryCount ? 20 + (negativeStoryCount - positiveStoryCount) * 8 : 0) +
    (counterpartyCount === 0 && marketChange < 0 ? 10 : 0)
  );
  const opportunityScore = clampScore(
    thesisStrength * 0.36 + thesisFreshness * 0.2 + flowAlignment * 0.2 + liquidityQuality * 0.14 + Math.max(0, marketChange) * 0.5 - narrativeDecay * 0.22 - fraudRisk * 0.25 + Math.max(0, positionPnlPct) * 0.05
  );

  return {
    opportunity_score: opportunityScore,
    thesis_strength: thesisStrength,
    thesis_freshness: thesisFreshness,
    narrative_decay: narrativeDecay,
    flow_alignment: flowAlignment,
    liquidity_quality: liquidityQuality,
    fraud_risk: fraudRisk,
    pnl_pct: positionPnlPct,
    latest_story_age_days: Number.isFinite(latestStoryAgeDays) ? Number(latestStoryAgeDays.toFixed(1)) : null,
    positive_story_count: positiveStoryCount,
    negative_story_count: negativeStoryCount,
    conflict_count: conflictCount,
    derived_story_count: derivedStoryCount
  };
}

function getCachedDossier(cacheKey) {
  const cached = E3D_DOSSIER_CACHE.get(cacheKey);
  if (!cached) return null;
  if (!cached.expires_at || cached.expires_at <= Date.now()) {
    E3D_DOSSIER_CACHE.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function setCachedDossier(cacheKey, value) {
  if (E3D_DOSSIER_CACHE.size > 200) {
    const firstKey = E3D_DOSSIER_CACHE.keys().next().value;
    if (firstKey) E3D_DOSSIER_CACHE.delete(firstKey);
  }
  E3D_DOSSIER_CACHE.set(cacheKey, {
    expires_at: Date.now() + E3D_DOSSIER_CACHE_TTL_MS,
    value
  });
}

// Shared market context fetched once per cycle and passed into per-position dossiers.
// Avoids re-fetching gainers/losers/token-universe for every held position.
let _cycleMarketContext = null;
// Quant context: DexScreener order flow, macro regime, Binance funding rates — reset each cycle.
let _cycleQuantContext = null;
// Maps context: capital flow navigator signals — reset each cycle.
let _cycleMapsContext = null;
let _cycleRegimePolicy = null;
let _cycleSignalSnapshot = null;
let _cycleArbitrageSignals = [];
// Story types actually returned by the E3D API this cycle — used to make coverage scoring fair.
// Coverage only grades against types that were present in the data, not the full expected list.
let _cycleAvailableStoryTypes = null;

function getOrFetchCycleMarketContext() {
  if (_cycleMarketContext) return _cycleMarketContext;
  const tokenUniverse = endpointArray(fetchJson("/fetchTokensDB", { dataSource: E3D_TOKENS_DATA_SOURCE, limit: 50, offset: 0 }));
  const trendingGainers = summarizeTrendingTokens(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    dataSource: E3D_TOKENS_DATA_SOURCE, sortBy: "change_30m_pct", sortDir: "desc", limit: 50
  }), "gainers", 10);
  const trendingLosers = summarizeTrendingTokens(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    dataSource: E3D_TOKENS_DATA_SOURCE, sortBy: "change_30m_pct", sortDir: "asc", limit: 50
  }), "losers", 8);
  // Fetch global stories once per cycle. Both the dossier and Scout use this cached copy,
  // eliminating N per-position stories API calls and keeping us well under the rate limit.
  // Retry once on 429 — a cold-start burst from the dashboard can briefly exhaust the budget.
  let allStories = endpointArray(fetchJson("/stories", { limit: 200, chain: "ETH" }));
  if (!allStories.length) {
    sleepSync(15000);
    allStories = endpointArray(fetchJson("/stories", { limit: 200, chain: "ETH" }));
  }
  _cycleMarketContext = { tokenUniverse, trendingGainers, trendingLosers, allStories };
  return _cycleMarketContext;
}

function buildTokenIntelligenceDossier(position, portfolio, options = {}) {
  const address = cleanAddress(position?.contract_address || position?.address || "");
  const symbol = String(position?.symbol || position?.token?.symbol || options?.symbol || "").trim();
  const category = String(position?.category || options?.category || "unknown").trim() || "unknown";
  const cacheKey = `${address || symbol || category}`;
  const cached = getCachedDossier(cacheKey);
  if (cached) return cached;

  // Use shared cycle-level market data and stories — fetched once, reused for every position
  const { tokenUniverse, trendingGainers, trendingLosers, allStories: cycleStories } = getOrFetchCycleMarketContext();
  const marketFeed = mergeUniqueTokens(trendingGainers, trendingLosers, tokenUniverse);

  const identity = address ? fetchJson("/addressMeta", { address }) : null;
  const tokenInfo = address ? fetchJson(`/token-info/${encodeURIComponent(address)}`) : null;
  const recentTransactions = endpointArray(fetchJson("/fetchTransactionsDB", {
    dataSource: E3D_TRANSACTIONS_DATA_SOURCE,
    search: address || symbol || undefined,
    limit: 25
  }));
  // Use the cycle-level cached stories filtered to this address — no extra API call.
  // This preserves the stories rate limit budget for the Scout's global call.
  const tokenStories = address
    ? (cycleStories || []).filter(s => {
        const sAddr = cleanAddress(s?.meta?.token_address || s?.primary_token || s?.meta?.primary?.address || s?.address || "");
        return sAddr === address;
      }).slice(0, E3D_DOSSIER_MAX_STORIES)
    : [];
  const thesisRows = tokenStories.filter((story) => {
    const storyType = String(story?.story_type || story?.type || "").toUpperCase();
    return storyType === "THESIS";
  }).slice(0, 3);
  const riskRows = tokenStories.filter((story) => classifyStoryTone(story) === "risk").slice(0, 3);
  const counterparties = address ? summarizeCounterparties(fetchJson("/addressCounterparties", { address, limit: E3D_DOSSIER_MAX_COUNTERPARTIES })) : [];
  const tokenCounterparties = address ? summarizeCounterparties(fetchJson("/tokenCounterparties", { token: address, limit: E3D_DOSSIER_MAX_COUNTERPARTIES })) : [];
  const capabilityStories = tokenStories;
  const stories = summarizeStories(capabilityStories, "dossier", E3D_DOSSIER_MAX_STORIES);
  const marketData = extractMarketSnapshot(position, identity, tokenInfo, marketFeed);
  const transactionSnapshot = summarizeTransactions(recentTransactions, "fetchTransactionsDB", 25);
  const positionSnapshot = {
    symbol: position?.symbol || symbol || null,
    contract_address: address || null,
    category,
    quantity: toNum(position?.quantity, 0),
    avg_entry_price: toNum(position?.avg_entry_price, 0),
    current_price: toNum(position?.current_price, marketData.current_price || 0),
    market_value_usd: toNum(position?.market_value_usd, 0),
    cost_basis_usd: toNum(position?.cost_basis_usd, 0),
    stop_price: position?.stop_price || null,
    targets: position?.targets || null,
    opened_at: position?.opened_at || null,
    last_updated_at: position?.last_updated_at || null
  };
  const scores = computeDossierScores({
    position,
    stories: capabilityStories,
    opportunityStories: tokenStories,
    thesisStories: thesisRows,
    riskStories: riskRows,
    counterparties,
    tokenCounterparties,
    marketData,
    flowSummary: null,
    walletCohort: null
  });
  const action = deriveActionTilt({ ...scores, pnl_pct: scores.pnl_pct });
  const strongestStory = stories[0] || null;
  const thesisState = scores.narrative_decay >= 70 ? "decaying" : scores.thesis_freshness >= 70 ? "confirmed" : scores.thesis_freshness >= 45 ? "watch" : "weak";
  const whyNow = compactText(
    strongestStory?.subtitle || strongestStory?.title || identity?.name || position?.symbol || "No active thesis signal yet",
    220
  );
  const invalidation = action === "buy"
    ? "If fresh bearish stories or outflow evidence overtake the opportunity layer"
    : action === "trim"
      ? "If thesis freshness improves and flow re-accelerates"
      : action === "exit"
        ? "If the thesis repairs materially or fraud/liquidity risk fades"
        : "If new stories confirm stronger thesis and flow alignment";

  const dossier = {
    generated_at: nowIso(),
    position: positionSnapshot,
    token: {
      symbol: symbol || position?.symbol || null,
      name: compactText(identity?.name || tokenInfo?.name || position?.name || symbol || "", 120) || null,
      chain: position?.chain || options?.chain || "ethereum",
      contract_address: address || null,
      category,
      likes: toNum(identity?.likes, 0),
      icon: identity?.icon || identity?.icon2 || null,
      icon2: identity?.icon2 || null
    },
    identity: identity || null,
    market_data: marketData,
    market_trends: {
      gainers: trendingGainers,
      losers: trendingLosers
    },
    stories: {
      opportunity: stories.filter((story) => story.tone === "opportunity"),
      risk: stories.filter((story) => story.tone === "risk"),
      mixed: stories.filter((story) => story.tone === "mixed"),
      all: stories
    },
    theses: endpointArray(thesisRows).slice(0, 3),
    flow: {
      counterparties,
      token_counterparties: tokenCounterparties,
      counterparty_count: counterparties.length + tokenCounterparties.length,
      recent_transactions: transactionSnapshot
    },
    scores,
    thesis: {
      state: thesisState,
      strength: scores.thesis_strength,
      freshness: scores.thesis_freshness,
      decay: scores.narrative_decay,
      flow_alignment: scores.flow_alignment,
      liquidity_quality: scores.liquidity_quality,
      fraud_risk: scores.fraud_risk,
      opportunity_score: scores.opportunity_score
    },
    recommendation: {
      action,
      confidence: clampScore(scores.opportunity_score * 0.7 + scores.thesis_freshness * 0.2 - scores.fraud_risk * 0.1),
      why_now: whyNow,
      invalidation,
      next_best_alternative: action === "buy" ? "Compare against the current weakest held position and the strongest near-term alternative" : "Monitor the next thesis-confirming story"
    },
    prompt: {
      position: positionSnapshot,
      token: {
        symbol: symbol || position?.symbol || null,
        name: compactText(identity?.name || tokenInfo?.name || position?.name || symbol || "", 120) || null,
        chain: position?.chain || options?.chain || "ethereum",
        contract_address: address || null,
        category,
        likes: toNum(identity?.likes, 0)
      },
      market_data: marketData,
      market_trends: {
        gainers: trendingGainers,
        losers: trendingLosers
      },
      thesis: {
        state: thesisState,
        strength: scores.thesis_strength,
        freshness: scores.thesis_freshness,
        decay: scores.narrative_decay,
        flow_alignment: scores.flow_alignment,
        liquidity_quality: scores.liquidity_quality,
        fraud_risk: scores.fraud_risk,
        opportunity_score: scores.opportunity_score
      },
      story_snapshot: {
        opportunity_count: stories.filter((story) => story.tone === "opportunity").length,
        risk_count: stories.filter((story) => story.tone === "risk").length,
        mixed_count: stories.filter((story) => story.tone === "mixed").length,
        top_stories: stories.slice(0, 3)
      },
      flow: {
        counterparty_count: counterparties.length + tokenCounterparties.length,
        flow_direction: "neutral"
      },
      recommendation: {
        action,
        confidence: clampScore(scores.opportunity_score * 0.7 + scores.thesis_freshness * 0.2 - scores.fraud_risk * 0.1),
        why_now: whyNow,
        invalidation
      }
    }
  };

  setCachedDossier(cacheKey, dossier);
  return dossier;
}

function buildPortfolioIntelligenceDossier(portfolio) {
  const positions = Object.values(portfolio?.positions || {})
    .slice()
    .sort((a, b) => computePositionScore(b, portfolio?.settings || SETTINGS_DEFAULTS) - computePositionScore(a, portfolio?.settings || SETTINGS_DEFAULTS))
    .slice(0, E3D_DOSSIER_MAX_POSITIONS);

  const holdings = positions.map((position) => buildTokenIntelligenceDossier(position, portfolio));
  const categories = Array.from(new Set(holdings.map((item) => item?.token?.category || "unknown"))).filter(Boolean);
  const summary = {
    generated_at: nowIso(),
    market_regime: portfolio?.stats?.market_regime || "unknown",
    portfolio: {
      cash_usd: toNum(portfolio?.cash_usd, 0),
      equity_usd: equityUsd(portfolio),
      position_count: Object.keys(portfolio?.positions || {}).length,
      tracked_positions: holdings.length,
      categories,
      top_symbols: holdings.map((item) => item?.token?.symbol).filter(Boolean)
    },
    thesis_snapshot: {
      average_thesis_strength: holdings.length ? Number((holdings.reduce((sum, item) => sum + toNum(item?.thesis?.strength, 0), 0) / holdings.length).toFixed(1)) : 0,
      average_thesis_freshness: holdings.length ? Number((holdings.reduce((sum, item) => sum + toNum(item?.thesis?.freshness, 0), 0) / holdings.length).toFixed(1)) : 0,
      average_narrative_decay: holdings.length ? Number((holdings.reduce((sum, item) => sum + toNum(item?.thesis?.decay, 0), 0) / holdings.length).toFixed(1)) : 0,
      average_opportunity_score: holdings.length ? Number((holdings.reduce((sum, item) => sum + toNum(item?.thesis?.opportunity_score, 0), 0) / holdings.length).toFixed(1)) : 0,
      positive_positions: holdings.filter((item) => item?.recommendation?.action === "buy" || item?.recommendation?.action === "hold").length,
      defensive_positions: holdings.filter((item) => item?.recommendation?.action === "trim" || item?.recommendation?.action === "exit").length
    },
    holdings: holdings.map((item) => item.prompt)
  };

  return {
    generated_at: nowIso(),
    market_regime: portfolio?.stats?.market_regime || "unknown",
    portfolio: summary.portfolio,
    holdings,
    prompt_snapshot: summary
  };
}

function loadPortfolio() {
  if (!fs.existsSync(PORTFOLIO_FILE)) {
    return {
      cash_usd: SETTINGS_DEFAULTS.initial_cash_usd,
      positions: {},
      closed_trades: [],
      action_history: [],
      cooldowns: {},
      stats: {
        realized_pnl_usd: 0,
        unrealized_pnl_usd: 0,
        equity_usd: SETTINGS_DEFAULTS.initial_cash_usd,
        peak_equity_usd: SETTINGS_DEFAULTS.initial_cash_usd,
        max_drawdown_pct: 0,
        market_regime: "unknown"
      },
      settings: { ...SETTINGS_DEFAULTS }
    };
  }

  const loaded = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf8"));
  loaded.settings = { ...SETTINGS_DEFAULTS, ...(loaded.settings || {}) };
  loaded.positions = loaded.positions || {};
  loaded.closed_trades = loaded.closed_trades || [];
  loaded.action_history = loaded.action_history || [];
  loaded.cooldowns = normalizePortfolioCooldowns(loaded.cooldowns || {});
  loaded.stats = loaded.stats || {
    realized_pnl_usd: 0,
    unrealized_pnl_usd: 0,
    equity_usd: loaded.cash_usd || SETTINGS_DEFAULTS.initial_cash_usd,
    peak_equity_usd: loaded.cash_usd || SETTINGS_DEFAULTS.initial_cash_usd,
    max_drawdown_pct: 0,
    market_regime: "unknown"
  };
  loaded.stats.market_regime = loaded.stats.market_regime || "unknown";
  return loaded;
}

function savePortfolio(portfolio) {
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2));
  syncPortfolioToMongo(portfolio);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const EXPECTED_STORY_TYPES = {
  // v1 names (still appear when conditions exist) + v2 names (dominate current API responses).
  // Coverage is measured as: how many of these types appear in either stories_checked[] or
  // evidence[] of the agent's output, intersected with types that were actually in the cycle data.
  scout: [
    // v1 disqualifiers
    "WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN", "SPREAD_WIDENING", "MOMENTUM_DIVERGENCE", "EXCHANGE_FLOW",
    // v1 buy signals
    "ACCUMULATION", "SMART_MONEY", "STEALTH_ACCUMULATION", "BREAKOUT_CONFIRMED", "MOVER", "SURGE",
    // v1 secondary
    "CONCENTRATION_SHIFT", "INSIDER_TIMING", "TOKEN_QUALITY_SCORE", "SANDWICH",
    // v2 signals (current API)
    "CLUSTER", "THESIS", "STAGING", "FLOW", "HOTLINKS", "FUNNEL", "WHALE",
    "DELEGATE_SURGE", "NEW_WALLETS", "MIRROR", "VOLUME_PROFILE_ANOMALY", "ECOSYSTEM_SHIFT",
  ],
  harvest: [
    // v1 exit risk
    "LIQUIDITY_DRAIN", "RUG_LIQUIDITY_PULL", "SPREAD_WIDENING", "EXCHANGE_FLOW",
    "MOMENTUM_DIVERGENCE", "WASH_TRADE", "LOOP",
    // v1 positioning
    "CONCENTRATION_SHIFT", "WHALE", "VOLUME_PROFILE_ANOMALY", "MIRROR",
    // v1 hold confirm
    "ACCUMULATION", "SMART_MONEY",
    // v2 equivalents (current API)
    "CLUSTER", "THESIS", "FLOW", "STAGING", "FUNNEL",
  ],
};

function buildAgentCoverageLog(agentId, payload) {
  const allExpected = EXPECTED_STORY_TYPES[agentId] || [];
  // Only grade against story types that the E3D API actually returned this cycle.
  // This prevents unfair penalisation when a type simply doesn't exist in today's data.
  // Fall back to the full list when cycle data isn't available (e.g. unit tests, ad-hoc calls).
  const expected = _cycleAvailableStoryTypes
    ? allExpected.filter((t) => _cycleAvailableStoryTypes.has(t))
    : allExpected;

  // Self-reported: agent may include stories_checked[] in its output
  const selfReported = Array.isArray(payload?.stories_checked)
    ? payload.stories_checked
    : [];
  const selfReportedTypes = selfReported.map((s) => String(s?.type || s || "").toUpperCase()).filter(Boolean);

  // Evidence-cited: extract story type mentions from candidate evidence[] and risks[].
  // The tool-use scout/harvest emit evidence as free-text strings; the v1 evidence-shortlist
  // path emits {type, ...} objects. Scan both shapes.
  const evidenceCited = new Set();
  const allItems = [
    ...(payload?.candidates || []),
    ...(payload?.exit_candidates || []),
    ...(payload?.holdings_updates || []),
  ];
  const expectedUpper = expected.map((t) => t.toUpperCase());
  const scanText = (text) => {
    if (!text) return;
    const upper = String(text).toUpperCase();
    for (const t of expectedUpper) {
      // Whole-word match (\b treats underscore as a word char, so WASH_TRADE
      // matches as one token and won't false-positive on substrings).
      if (new RegExp(`\\b${t}\\b`).test(upper)) evidenceCited.add(t);
    }
  };
  for (const item of allItems) {
    for (const e of item?.evidence || []) {
      if (typeof e === "string") {
        scanText(e);
      } else {
        const t = String(e?.type || e?.story_type || "").toUpperCase();
        if (t) evidenceCited.add(t);
      }
    }
    for (const r of item?.risks || []) {
      if (typeof r === "string") {
        scanText(r);
      } else {
        const t = String(r?.type || r?.story_type || "").toUpperCase();
        if (t) evidenceCited.add(t);
      }
    }
  }

  const covered = new Set([...selfReportedTypes, ...evidenceCited]);
  const missing = expected.filter((t) => !covered.has(t));
  const coverage_pct = expected.length > 0
    ? Math.round((100 * (expected.length - missing.length)) / expected.length)
    : null;

  return {
    agent: agentId,
    self_reported_types: selfReportedTypes,
    evidence_cited_types: [...evidenceCited],
    expected_types: expected,
    missing_types: missing,
    coverage_pct,
    stories_checked_field_present: Array.isArray(payload?.stories_checked),
  };
}

const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://127.0.0.1:5050";
const SCOUT_ADAPTER_PATH = process.env.SCOUT_ADAPTER_PATH || null;
const HARVEST_ADAPTER_PATH = process.env.HARVEST_ADAPTER_PATH || null;
const LLM_MODEL = process.env.LLM_MODEL || "mlx-community/Qwen2.5-14B-Instruct-4bit";

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || "";
const COINGECKO_BASE = "https://pro-api.coingecko.com/api/v3";

// Batch price lookup — one call for up to 30 contract addresses.
// Returns { address: { usd, usd_market_cap, usd_24h_vol, usd_24h_change, usd_7d_change } }
function fetchCoinGeckoBatch(addresses) {
  if (!COINGECKO_API_KEY || !addresses.length) return {};
  try {
    const params = `contract_addresses=${addresses.slice(0, 30).join(",")}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_7d_change=true`;
    const stdout = execFileSync("curl", [
      "-s", `${COINGECKO_BASE}/simple/token_price/ethereum?${params}`,
      "-H", `x-cg-pro-api-key: ${COINGECKO_API_KEY}`,
      "--max-time", "15",
    ], { encoding: "utf8", timeout: 20000 });
    const result = JSON.parse(stdout);
    if (result?.error_code) { log("coingecko_error", { error: result.error_code }); return {}; }
    return result;
  } catch { return {}; }
}

// Full detail for a single contract — ATH, sentiment, categories, developer scores, description.
function fetchCoinGeckoDetail(address) {
  if (!COINGECKO_API_KEY || !address) return null;
  try {
    const stdout = execFileSync("curl", [
      "-s", `${COINGECKO_BASE}/coins/ethereum/contract/${address}`,
      "-H", `x-cg-pro-api-key: ${COINGECKO_API_KEY}`,
      "--max-time", "15",
    ], { encoding: "utf8", timeout: 20000 });
    const d = JSON.parse(stdout);
    if (d?.error || !d?.id) return null;
    return {
      id: d.id,
      symbol: (d.symbol || "").toUpperCase(),
      name: d.name,
      market_cap_rank: d.market_cap_rank ?? null,
      price_usd: d.market_data?.current_price?.usd ?? null,
      market_cap_usd: d.market_data?.market_cap?.usd ?? null,
      volume_24h_usd: d.market_data?.total_volume?.usd ?? null,
      change_24h_pct: d.market_data?.price_change_percentage_24h ?? null,
      change_7d_pct: d.market_data?.price_change_percentage_7d ?? null,
      change_30d_pct: d.market_data?.price_change_percentage_30d ?? null,
      ath_usd: d.market_data?.ath?.usd ?? null,
      ath_change_pct: d.market_data?.ath_change_percentage?.usd ?? null,
      sentiment_up_pct: d.sentiment_votes_up_percentage ?? null,
      categories: (d.categories || []).slice(0, 5),
      description: (d.description?.en || "").slice(0, 300),
      coingecko_score: d.coingecko_score ?? null,
      developer_score: d.developer_score ?? null,
      community_score: d.community_score ?? null,
      liquidity_score: d.liquidity_score ?? null,
    };
  } catch { return null; }
}

function callLLMDirect(systemPrompt, userMessage, { maxRetries = 1, agent = "unknown" } = {}) {
  const bodyObj = {
    model: LLM_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ],
    max_tokens: 6000,
    temperature: 0
  };
  const bodyJson = JSON.stringify(bodyObj);
  const reqId = crypto.randomUUID();

  // Write body to a temp file so curl can read it via -d @file (avoids ARG_MAX
  // and stdin-piping issues with execFileSync).
  const tmpFile = `/tmp/llm-req-${reqId}.json`;

  const startMs = nowMs();
  log("llm_request", {
    req_id: reqId,
    agent,
    model: LLM_MODEL,
    prompt_chars: systemPrompt.length + userMessage.length,
    system_chars: systemPrompt.length,
    user_chars: userMessage.length,
  });
  logAgentRaw({
    kind: "request",
    agent,
    req_id: reqId,
    mode: "direct",
    system_prompt: systemPrompt,
    user_message: userMessage
  });

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.writeFileSync(tmpFile, bodyJson);
      let stdout;
      try {
        const adapterPath = agent === "scout" ? SCOUT_ADAPTER_PATH : agent === "harvest" ? HARVEST_ADAPTER_PATH : null;
        const curlArgs = [
          "-s", "-X", "POST",
          `${LLM_BASE_URL}/v1/chat/completions`,
          "-H", "Content-Type: application/json",
          "-H", `X-Request-Id: ${reqId}`,
        ];
        if (adapterPath) curlArgs.push("-H", `X-Adapter-Path: ${adapterPath}`);
        stdout = execFileSync("curl", [
          ...curlArgs,
          "--max-time", "1200",
          "-d", `@${tmpFile}`
        ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 1220000 });
      } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
      }

      let parsed;
      try { parsed = JSON.parse(stdout); } catch (_) {
        throw new Error(`LLM_JSON_PARSE_FAILED\n${stdout.slice(0, 500)}`);
      }
      if (parsed?.error) throw new Error(`LLM_SERVER_ERROR: ${JSON.stringify(parsed.error)}`);

      const msg = parsed?.choices?.[0]?.message;
      let text = msg?.content;
      if (Array.isArray(text)) text = text.map((c) => c?.text ?? "").join("");
      if (typeof text !== "string" || !text.trim()) {
        throw new Error(`LLM_EMPTY_RESPONSE\n${stdout.slice(0, 500)}`);
      }
      const durationMs = nowMs() - startMs;
      const meta = {
        req_id: reqId,
        agent,
        duration_ms: durationMs,
        output_chars: text.length,
        prompt_tokens: parsed?.usage?.prompt_tokens ?? null,
        completion_tokens: parsed?.usage?.completion_tokens ?? null,
        total_tokens: parsed?.usage?.total_tokens ?? null,
        finish_reason: parsed?.choices?.[0]?.finish_reason ?? null,
      };
      log("llm_response", meta);
      setLastLLMMeta(agent, meta);
      logAgentRaw({
        kind: "response",
        agent,
        req_id: reqId,
        mode: "direct",
        raw_response: text.trim(),
        meta
      });
      return text.trim();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) sleepSync(5000);
    }
  }
  const errorMeta = { req_id: reqId, agent, duration_ms: nowMs() - startMs, error: lastErr?.message?.slice(0, 200) };
  log("llm_error", errorMeta);
  setLastLLMMeta(agent, errorMeta);
  throw lastErr;
}

// ─── Tool-calling infrastructure ──────────────────────────────────────────────
// Enabled via LLM_TOOL_USE=1 env var. Agents call e3d.ai APIs themselves
// instead of receiving pre-fetched data in the prompt.
const TOOL_USE_MODE = process.env.LLM_TOOL_USE_OVERRIDE ?? process.env.LLM_TOOL_USE ?? "";
const TOOL_USE_ENABLED = ["1", "true", "yes"].includes(String(TOOL_USE_MODE).trim().toLowerCase());
// Keep KV cache manageable on 25GB RAM: truncate large API responses before
// they enter the conversation history. 6000 chars ≈ 1500 tokens per result.
const MAX_TOOL_RESULT_CHARS = 6000;
// Hard ceiling on tool-call rounds per LLM session to prevent runaway loops.
const MAX_TOOL_ROUNDS = 15;

function truncateToolResult(data) {
  const str = typeof data === "string" ? data : JSON.stringify(data ?? null);
  if (str.length <= MAX_TOOL_RESULT_CHARS) return str;
  return str.slice(0, MAX_TOOL_RESULT_CHARS) + `...[truncated, ${str.length - MAX_TOOL_RESULT_CHARS} more chars]`;
}

const E3D_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "e3d_get_candidates",
      description: "Fetch E3D pre-computed buy candidates — highest-quality signals, already multi-story correlated. Use to discover candidates not yet in your cognitive state, or to refresh stale data.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Max results (default 20, max 50)" },
          scope: { type: "string", enum: ["all", "new"], description: "all=all candidates, new=only unseen" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "e3d_get_stories",
      description: "Fetch on-chain signal stories. PRE-PUMP (buy alpha): STAGING, CLUSTER, FUNNEL, ACCUMULATION, SMART_MONEY, SMART_MONEY_LEADER, STEALTH_ACCUMULATION, THESIS, BREAKOUT_CONFIRMED. POST-PUMP (skip as entry): MOVER, SURGE. DISQUALIFIERS: WASH_TRADE, LIQUIDITY_DRAIN, TREASURY_DISTRIBUTION, SECURITY_RISK.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "Story type filter (e.g. THESIS, ACCUMULATION, SMART_MONEY, STAGING). Omit for all types." },
          chain: { type: "string", enum: ["ETH", "all"], description: "Chain filter (default ETH)" },
          limit: { type: "integer", description: "Max results (default 50, max 200)" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "e3d_get_token_universe",
      description: "Fetch the full tracked token universe with price, volume, liquidity, and market cap. Use to verify quality gates: price_usd > 0, liquidity_usd > 100000, market_cap_usd > 2000000, volume_24h_usd > 10000.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Max tokens (default 50)" },
          search: { type: "string", description: "Filter by symbol or contract address" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "e3d_get_trending",
      description: "Fetch tokens sorted by recent price change. Gainers spot momentum, losers spot capitulation.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["gainers", "losers"], description: "Sort direction (required)" },
          timeframe: { type: "string", enum: ["30m", "24h"], description: "Price change timeframe (default 30m)" },
          limit: { type: "integer", description: "Max results (default 20)" }
        },
        required: ["direction"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "e3d_get_token_info",
      description: "Get detailed price and market data for a specific token by contract address.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "Contract address (0x...)" }
        },
        required: ["address"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "e3d_get_transactions",
      description: "Fetch recent on-chain transactions for a token or wallet — reveals whale moves, wash trading, accumulation patterns.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "Contract or wallet address to look up" },
          limit: { type: "integer", description: "Max results (default 25)" }
        },
        required: ["address"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "e3d_get_address_meta",
      description: "Look up identity metadata for a contract address — name, symbol, type, description, links.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "Contract address to look up" }
        },
        required: ["address"]
      }
    }
  }
];

const NONTRADEABLE_ADDRESSES = new Set([
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
]);

function executeE3DTool(name, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  try {
    if (name === "e3d_get_candidates") {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const query = { limit };
      if (args.scope) query.scope = String(args.scope);
      return truncateToolResult(fetchJson("/candidates", query) ?? { candidates: [], message: "none currently" });
    }
    if (name === "e3d_get_stories") {
      const limit = Math.min(Number(args.limit) || 50, 200);
      const query = { limit, chain: String(args.chain || "ETH") };
      if (args.type) query.type = String(args.type);
      return truncateToolResult(fetchJson("/stories", query) ?? []);
    }
    if (name === "e3d_get_token_universe") {
      const limit = Math.min(Number(args.limit) || 50, 100);
      const query = { dataSource: E3D_TOKENS_DATA_SOURCE, limit, offset: 0 };
      if (args.search) query.search = String(args.search);
      return truncateToolResult(fetchJson("/fetchTokensDB", query) ?? []);
    }
    if (name === "e3d_get_trending") {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const sortBy = args.timeframe === "24h" ? "change_24h_pct" : "change_30m_pct";
      const sortDir = args.direction === "losers" ? "asc" : "desc";
      return truncateToolResult(fetchJson("/fetchTokenPricesWithHistoryAllRanges", { dataSource: E3D_TOKENS_DATA_SOURCE, sortBy, sortDir, limit }) ?? []);
    }
    if (name === "e3d_get_token_info") {
      const address = cleanAddress(String(args.address || ""));
      if (!address) return JSON.stringify({ error: "address required" });
      if (NONTRADEABLE_ADDRESSES.has(address)) {
        log("tool_blocked_nontradeable", { tool: name, address });
        return JSON.stringify({ error: "non-tradeable address, skip", address });
      }
      const tokenInfo = fetchJson(`/token-info/${encodeURIComponent(address)}`);
      if (tokenInfo) return truncateToolResult(tokenInfo);
      // /token-info returned 500 — fall back to the cached universe snapshot
      const fromUniverse = _activeTokensCache.find(
        t => cleanAddress(t?.address || t?.contract_address || "") === address
      );
      if (fromUniverse) return truncateToolResult(fromUniverse);
      return JSON.stringify({ error: "token not found in E3D database — skip this candidate" });
    }
    if (name === "e3d_get_transactions") {
      const address = cleanAddress(String(args.address || ""));
      if (!address) return JSON.stringify({ error: "address required" });
      if (NONTRADEABLE_ADDRESSES.has(address)) {
        log("tool_blocked_nontradeable", { tool: name, address });
        return JSON.stringify({ error: "non-tradeable address, skip", address });
      }
      const limit = Math.min(Number(args.limit) || 25, 50);
      return truncateToolResult(fetchJson("/fetchTransactionsDB", { dataSource: E3D_TRANSACTIONS_DATA_SOURCE, search: address, limit }) ?? []);
    }
    if (name === "e3d_get_address_meta") {
      const address = cleanAddress(String(args.address || ""));
      if (!address) return JSON.stringify({ error: "address required" });
      if (NONTRADEABLE_ADDRESSES.has(address)) {
        log("tool_blocked_nontradeable", { tool: name, address });
        return JSON.stringify({ error: "non-tradeable address, skip", address });
      }
      return truncateToolResult(fetchJson("/addressMeta", { address }) ?? { error: "not found" });
    }
    return JSON.stringify({ error: `unknown tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ error: String(err?.message || err) });
  }
}

// Multi-round tool-calling loop. Sends request to LLM, executes any tool_calls,
// appends results to the conversation, and repeats until the model emits a final
// text response or MAX_TOOL_ROUNDS is hit.
// ─── Cognitive state ──────────────────────────────────────────────────────────
// Max candidates to surface in the cognitive state snapshot.
const COGNITIVE_STATE_MAX_CANDIDATES = 10;
let _activeTokensCache = []; // shared with tool handler for /token-info fallback
// Max rounds when the agent is doing targeted drill-down (cognitive state mode).
// 3 drill-down tool calls + 1 final answer = 4 rounds total.
const DRILL_DOWN_MAX_ROUNDS = 4;
// Symbols that are never trading candidates — filtered out before the LLM sees them.
// Stripping wrapper prefixes (Aave V2/V3, Compound, Spark, Yearn) catches aEthUSDC,
// aUSDC, cUSDC, sDAI, yvUSDC, etc. — previously these slipped past an anchored regex
// and one (aEthUSDC) cost us $950 on 2026-05-19.
const NONTRADEABLE_BASE_RE = /^(USDC?|USDT|DAI|USDS|BUSD|TUSD|FRAX|LUSD|SUSD|GUSD|PYUSD|FDUSD|USDE|SUSDE|USDY|USDP|HUSD|MUSD|CRVUSD|GHO|RLUSD|USDX|USDK|USDM|XAUt|PAXG|CACHE|XAUT|WETH|WBTC|cbBTC|rETH|stETH|wstETH|cbETH|ankrETH|BETH|sETH2|ETH2x|STETH|ETH|TBTC|E3D)$/i;
// Longest first so aeth/apol/etc. aren't partial-matched by the bare `a`.
const NONTRADEABLE_WRAPPER_PREFIXES = ["aeth","apol","aarb","aavax","aopt","abas","abase","aop","yv","cm","a","c","sd","s"];
function isNonTradeable(sym) {
  const s = String(sym || "").toLowerCase();
  if (!s) return false;
  if (NONTRADEABLE_BASE_RE.test(s)) return true;
  for (const p of NONTRADEABLE_WRAPPER_PREFIXES) {
    if (s.length > p.length && s.startsWith(p) && NONTRADEABLE_BASE_RE.test(s.slice(p.length))) return true;
  }
  return false;
}
// Regex-shaped facade so existing `.test()` callers keep working.
const NONTRADEABLE_RE = { test: isNonTradeable };

function computeCandidateScorecard(candidate, storySig) {
  const signalTypes = Array.isArray(candidate.signal_types) ? candidate.signal_types : [];
  const nonE3dSignals = signalTypes.filter(t => t !== "E3D_CANDIDATE");
  const strongSignals = new Set(["ACCUMULATION", "SMART_MONEY", "SMART_MONEY_LEADER", "STEALTH_ACCUMULATION", "WHALE"]);
  const thesisSignals = new Set(["THESIS"]);

  // story_signal_score
  let story_signal_score = 0;
  if (nonE3dSignals.length > 0) {
    const hasThesis = nonE3dSignals.some(t => thesisSignals.has(t));
    const hasStrong = nonE3dSignals.some(t => strongSignals.has(t));
    if (hasThesis) story_signal_score = 60;
    else if (hasStrong) story_signal_score = 50;
    else story_signal_score = 30;
    if (nonE3dSignals.length > 1) story_signal_score = Math.min(100, story_signal_score + 15 * (nonE3dSignals.length - 1));
  }

  // thesis_signal_score
  const conviction = Number(candidate.conviction || 0);
  let thesis_signal_score = 0;
  if (signalTypes.includes("THESIS") || conviction > 0) {
    if (conviction > 80) thesis_signal_score = 95;
    else if (conviction >= 65) thesis_signal_score = 75;
    else if (conviction >= 50) thesis_signal_score = 55;
    else if (conviction > 0) thesis_signal_score = 30;
  }

  // If this candidate matches a Decision Layer action, use Q_A (action_score) directly.
  // action_score is normalized 0–1; multiply by 100 to match the score scale.
  if (_cycleE3dActions.length > 0) {
    const cAddr = cleanAddress(candidate?.address || candidate?.entity_address || candidate?.token_address || "");
    if (cAddr) {
      const matchingAction = _cycleE3dActions.find(a => cleanAddress(a.token_address || "") === cAddr);
      if (matchingAction && Number.isFinite(matchingAction.action_score)) {
        thesis_signal_score = Math.round(matchingAction.action_score * 100);
      }
    }
  }

  // liquidity_score — hard fail if < 100k
  const liq = Number(candidate.market?.liquidity_usd || 0);
  let liquidity_score = 0;
  let liq_hard_fail = false;
  if (liq < 100000) { liquidity_score = 0; liq_hard_fail = true; }
  else if (liq < 250000) liquidity_score = 40;
  else if (liq < 500000) liquidity_score = 65;
  else if (liq < 1000000) liquidity_score = 80;
  else liquidity_score = 100;

  // momentum_score — hard fail if change_7d > 300%
  const change30m = Number(candidate.market?.change_30m_pct ?? 0);
  const change7d = Number(candidate.market?.change_7d_pct ?? 0);
  let momentum_score = 0;
  let momentum_hard_fail = false;
  if (change7d > 300) { momentum_score = 0; momentum_hard_fail = true; }
  else if (change30m < 0) momentum_score = 20;
  else if (change30m < 2) momentum_score = 50;
  else if (change30m < 5) momentum_score = 70;
  else if (change30m < 10) momentum_score = 85;
  else momentum_score = 60;

  // risk_score
  let risk_score = 100;
  if (storySig?.has_warning) risk_score = 60;

  // bonuses
  const signalTypeCount = new Set(nonE3dSignals).size;
  const multi_signal_bonus = signalTypeCount >= 3 ? 25 : signalTypeCount >= 2 ? 15 : 0;
  const e3d_candidate_bonus = candidate.source === "e3d_candidate" ? 50 : 0;

  const raw = (story_signal_score * 0.25) + (thesis_signal_score * 0.20) + (liquidity_score * 0.20)
    + (momentum_score * 0.15) + (risk_score * 0.20) + multi_signal_bonus + e3d_candidate_bonus;
  const composite_score = Math.min(100, Math.round(raw));

  const hard_fail = liq_hard_fail || momentum_hard_fail;
  let decision;
  if (hard_fail || composite_score < 40) decision = "fail";
  else if (composite_score < 60) decision = "weak";
  else if (composite_score < 75) decision = "watch";
  else decision = "pass";

  const decision_reasons = [];
  if (liq_hard_fail) decision_reasons.push("liquidity below 100k hard floor");
  if (momentum_hard_fail) decision_reasons.push("change_7d > 300% already pumped");
  if (candidate.source === "e3d_candidate") decision_reasons.push("e3d_candidate +50 bonus");
  if (multi_signal_bonus > 0) decision_reasons.push(`multi_signal_bonus +${multi_signal_bonus}`);

  return {
    story_signal_score, thesis_signal_score, liquidity_score, momentum_score, risk_score,
    multi_signal_bonus, e3d_candidate_bonus, composite_score, decision, decision_reasons
  };
}

// buildCognitiveState — the Node.js perception layer.
// Makes 3 targeted API calls, fuses the results, and returns a compact ranked
// candidate list. This is the "E3D visual cortex" — Qwen acts as the strategist
// on top of it, with optional drill-down tool calls for deeper investigation.
function buildCognitiveState(portfolio) {
  const heldAddresses = new Set(
    Object.values(portfolio?.positions || {}).map(p => cleanAddress(p?.contract_address || "")).filter(Boolean)
  );
  const startMs = nowMs();
  const warningSignalTypes = new Set(["MOVER", "SURGE"]);

  // Three focused API calls — candidates, stories, and tokens sorted by signal activity
  const e3dCandidates  = endpointArray(fetchJson("/candidates", { limit: 20 }));
  const allStories     = endpointArray(fetchJson("/stories", { limit: 100, chain: "ETH" }));
  const activeTokens   = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    dataSource: E3D_TOKENS_DATA_SOURCE, sortBy: "storyCount", sortDir: "desc",
    trendInterval: "1H", limit: 200
  }));
  _activeTokensCache = activeTokens; // share with tool handler for /token-info fallback

  // Classify story types
  const disqualifierTypes = new Set(["WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN", "SPREAD_WIDENING",
    "EXCHANGE_FLOW", "SECURITY_RISK", "RUG_LIQUIDITY_PULL", "TREASURY_DISTRIBUTION"]);
  const buySignalTypes = new Set(["STAGING", "CLUSTER", "FUNNEL", "NEW_WALLETS", "ACCUMULATION",
    "SMART_MONEY", "SMART_MONEY_LEADER", "STEALTH_ACCUMULATION", "THESIS",
    "BREAKOUT_CONFIRMED", "FLOW", "HOTLINKS", "DISCOVERY", "WHALE"]);

  // Build disqualified address set and story signal map in one pass
  const disqualifiedAddresses = new Set([...heldAddresses]);
  const storySignals = new Map(); // address → { types, conviction, summaries }

  for (const s of allStories) {
    const type = String(s?.story_type || s?.type || "").toUpperCase();
    const addr = cleanAddress(s?.meta?.token_address || s?.primary_token || s?.address || "");
    if (!type || !addr) continue;

    if (disqualifierTypes.has(type)) {
      if (type === "EXCHANGE_FLOW" && s?.meta?.direction !== "deposits") continue;
      disqualifiedAddresses.add(addr);
      continue;
    }
    if (warningSignalTypes.has(type)) {
      if (!storySignals.has(addr)) storySignals.set(addr, { types: new Set(), conviction: 0, summaries: [], ids: [], has_warning: false });
      storySignals.get(addr).has_warning = true;
      continue;
    }
    if (!buySignalTypes.has(type)) continue;

    if (!storySignals.has(addr)) storySignals.set(addr, { types: new Set(), conviction: 0, summaries: [], ids: [], has_warning: false });
    const sig = storySignals.get(addr);
    sig.types.add(type);
    sig.conviction = Math.max(sig.conviction, Number(s?.meta?.conviction_score || s?.conviction || 0));
    const blurb = compactText(s?.title || s?.subtitle || "", 80);
    if (blurb && sig.summaries.length < 2) sig.summaries.push(`${type}: ${blurb}`);
    const sid = String(s?.id || s?.story_id || "");
    if (sid && !sig.ids.includes(sid)) sig.ids.push(sid);
  }

  // Build market data lookup from active tokens
  const marketByAddr = new Map();
  for (const t of activeTokens) {
    const addr = cleanAddress(t?.address || t?.contract_address || "");
    if (!addr) continue;
    marketByAddr.set(addr, {
      symbol: String(t.symbol || "").toUpperCase(),
      price_usd:       t.priceUSD ?? t.price_usd ?? null,
      change_30m_pct:  t.changes?.["30M"]?.percent ?? t.change_30m_pct ?? null,
      change_24h_pct:  t.changes?.["24H"]?.percent ?? t.change_24h_pct ?? null,
      volume_24h_usd:  t.volume24hUSD ?? t.volume_24h_usd ?? null,
      liquidity_usd:   t.effectiveLiquidityUSD || t.liquidityUSD || t.liquidity_usd || null,
      market_cap_usd:  t.marketCapUSD ?? t.market_cap_usd ?? null
    });
  }

  // Build candidate pool — E3D candidates first, then story signals
  const pool = new Map(); // address → entry

  for (const c of e3dCandidates) {
    const addr = cleanAddress(c?.entity_address || c?.token_address || c?.address || c?.contract_address || "");
    // entity_symbol is the correct field on the /candidates response
    const sym  = String(c?.entity_symbol || c?.symbol || c?.token?.symbol || "").toUpperCase();
    if (!addr || disqualifiedAddresses.has(addr) || heldAddresses.has(addr)) continue;
    if (NONTRADEABLE_RE.test(sym)) continue;
    // Drop candidates with zero opportunity score AND zero price — these are empty
    // placeholder records with no usable market data (REFLEXIVE_CROWDING junk).
    if (!Number(c?.opportunity_score) && !Number(c?.price_at_creation)) continue;
    const market = marketByAddr.get(addr) || {};
    const storySig = storySignals.get(addr);
    pool.set(addr, {
      symbol:       sym || market.symbol || "",
      address:      addr,
      source:       "e3d_candidate",
      signal_types: ["E3D_CANDIDATE", ...(storySig ? [...storySig.types] : [])],
      story_ids:    storySig ? [...storySig.ids] : [],
      conviction:   Math.max(Number(c?.conviction_score || c?.score || 65), storySig?.conviction || 0),
      why_now:      compactText(c?.why_now || c?.rationale || c?.description || "", 120),
      market,
      // E3D-provided risk metadata, carried through so it can override the LLM's
      // output (which never reports these) before buy ranking/gating runs on it.
      fraud_risk:        optionalNum(c?.fraud_risk),
      liquidity_quality: optionalNum(c?.liquidity_quality),
      drill_down:   ["token_info", "transactions"]
    });
  }

  for (const [addr, sig] of storySignals.entries()) {
    if (disqualifiedAddresses.has(addr) || heldAddresses.has(addr) || pool.has(addr)) continue;
    const market = marketByAddr.get(addr) || {};
    const sym = market.symbol || "";
    if (NONTRADEABLE_RE.test(sym)) continue;
    // Require the token to appear in the E3D universe snapshot. Tokens absent from the
    // universe are micro-caps or wallet addresses: they'll fail /token-info (500) and
    // can't pass the quality gate (liq>$100k, mcap>$2M) anyway.
    if (!marketByAddr.has(addr)) continue;
    // Skip tokens that clearly fail a soft quality check (price known but zero, or tiny liquidity)
    if ((market.price_usd ?? -1) === 0) continue;
    if (toNum(market.liquidity_usd, -1) > 0 && toNum(market.liquidity_usd, 0) < 50000) continue;

    const isMulti = sig.types.size >= 2;
    pool.set(addr, {
      symbol:       sym,
      address:      addr,
      source:       isMulti ? "multi_signal" : "single_signal",
      signal_types: [...sig.types],
      story_ids:    [...sig.ids],
      conviction:   sig.conviction,
      why_now:      sig.summaries.join("; ") || [...sig.types].join(", "),
      market,
      drill_down:   toNum(market.liquidity_usd, 0) === 0 ? ["token_info"] : []
    });
  }

  // Rank and cap
  const sourceWeight = { e3d_candidate: 100, multi_signal: 50, single_signal: 10 };
  const ranked = [...pool.values()]
    .map(c => ({ ...c, _score: (sourceWeight[c.source] || 0) + c.conviction + (c.signal_types.length * 5) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, COGNITIVE_STATE_MAX_CANDIDATES)
    .map(({ _score, ...c }, i) => {
      const storySig = storySignals.get(c.address);
      return { rank: i + 1, ...c, scorecard: computeCandidateScorecard(c, storySig) };
    });

  log("cognitive_state_built", {
    api_calls: 3, e3d_candidates: e3dCandidates.length, story_signals: storySignals.size,
    disqualified: disqualifiedAddresses.size, output_candidates: ranked.length,
    duration_ms: nowMs() - startMs
  });

  const cogStateDurationMs = nowMs() - startMs;
  _lastCognitiveState = { generated_at: nowIso(), candidates: ranked, meta: { e3d_candidates: e3dCandidates.length, story_signals: storySignals.size, api_calls: 3, disqualified: disqualifiedAddresses.size, output_candidates: ranked.length, duration_ms: cogStateDurationMs } };
  return _lastCognitiveState;
}

function callLLMWithTools(systemPrompt, userMessage, tools, toolExecutor, { agent = "unknown", maxRounds = MAX_TOOL_ROUNDS } = {}) {
  const reqId = crypto.randomUUID();
  const startMs = nowMs();
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];

  log("llm_request", {
    req_id: reqId, agent, model: LLM_MODEL, mode: "tool_calling",
    tools: tools.map(t => t.function.name),
    prompt_chars: systemPrompt.length + userMessage.length,
    system_chars: systemPrompt.length, user_chars: userMessage.length
  });
  logAgentRaw({
    kind: "request",
    agent,
    req_id: reqId,
    mode: "tool_calling",
    system_prompt: systemPrompt,
    user_message: userMessage
  });

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (let round = 0; round < maxRounds; round++) {
    const bodyObj = { model: LLM_MODEL, messages, tools, tool_choice: "auto", max_tokens: 6000, temperature: 0 };
    const roundId = `${reqId}-r${round}`;
    const tmpFile = `/tmp/llm-req-${roundId}.json`;

    const adapterPath = agent === "scout" ? SCOUT_ADAPTER_PATH : agent === "harvest" ? HARVEST_ADAPTER_PATH : null;
    const curlArgs = ["-s", "-X", "POST", `${LLM_BASE_URL}/v1/chat/completions`,
      "-H", "Content-Type: application/json", "-H", `X-Request-Id: ${roundId}`];
    if (adapterPath) curlArgs.push("-H", `X-Adapter-Path: ${adapterPath}`);

    let stdout;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(bodyObj));
      stdout = execFileSync("curl", [...curlArgs, "--max-time", "1200", "-d", `@${tmpFile}`],
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 1220000 });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }

    let parsed;
    try { parsed = JSON.parse(stdout); } catch (_) {
      throw new Error(`LLM_JSON_PARSE_FAILED\n${stdout.slice(0, 500)}`);
    }
    if (parsed?.error) throw new Error(`LLM_SERVER_ERROR: ${JSON.stringify(parsed.error)}`);

    totalPromptTokens += parsed?.usage?.prompt_tokens ?? 0;
    totalCompletionTokens += parsed?.usage?.completion_tokens ?? 0;

    const choice = parsed?.choices?.[0];
    const finishReason = choice?.finish_reason;
    const assistantMsg = choice?.message;

    if (finishReason === "tool_calls" && Array.isArray(assistantMsg?.tool_calls)) {
      messages.push({ role: "assistant", content: assistantMsg.content ?? null, tool_calls: assistantMsg.tool_calls });
      for (const tc of assistantMsg.tool_calls) {
        const toolName = tc?.function?.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(tc?.function?.arguments || "{}"); } catch (_) {}
        log("llm_tool_call", { req_id: reqId, agent, round, tool: toolName, args: toolArgs });
        if (agent === "scout") _cycleScoutToolCalls.push({ tool: toolName, args: toolArgs, round });
        const result = toolExecutor(toolName, toolArgs);
        log("llm_tool_result", { req_id: reqId, agent, round, tool: toolName, chars: String(result).length });
        messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
      }
      continue;
    }

    // Final response — extract text content
    let text = assistantMsg?.content;
    if (Array.isArray(text)) text = text.map(c => c?.text ?? "").join("");
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`LLM_EMPTY_RESPONSE\n${stdout.slice(0, 500)}`);
    }

    const durationMs = nowMs() - startMs;
    const meta = {
      req_id: reqId, agent, mode: "tool_calling", duration_ms: durationMs,
      tool_rounds: round + 1, output_chars: text.trim().length,
      prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens,
      total_tokens: totalPromptTokens + totalCompletionTokens, finish_reason: finishReason
    };
    log("llm_response", meta);
    setLastLLMMeta(agent, meta);
    logAgentRaw({
      kind: "response",
      agent,
      req_id: reqId,
      mode: "tool_calling",
      raw_response: text.trim(),
      meta
    });
    return text.trim();
  }

  throw new Error(`LLM_MAX_TOOL_ROUNDS: exceeded ${maxRounds} rounds without final response`);
}

let _lastCognitiveState = null;
let _cycleScoutToolCalls = [];
let _scoutCycleIndex = 0;

function fetchScoutData() {
  // Story type categorisation — used to label whatever the API returns
  const disqualifierTypes = new Set(["WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN", "SPREAD_WIDENING",
    "MOMENTUM_DIVERGENCE", "EXCHANGE_FLOW", "SECURITY_RISK", "RUG_LIQUIDITY_PULL", "AIRDROP",
    "TREASURY_DISTRIBUTION"]);
  // PRE-PUMP early signals — fire before price moves, this is the alpha window
  const buySignalTypes = new Set(["STAGING", "CLUSTER", "FUNNEL", "NEW_WALLETS", "WHALE",
    "ACCUMULATION", "SMART_MONEY", "STEALTH_ACCUMULATION", "DEEP_DIVE", "THESIS",
    "BREAKOUT_CONFIRMED", "FLOW", "HOTLINKS", "DISCOVERY", "DELEGATE_SURGE",
    "SMART_MONEY_LEADER"]);
  // POST-PUMP late signals — move already happened, NOT a buy trigger on its own
  const lateSignalTypes = new Set(["MOVER", "SURGE"]);
  const secondaryTypes = new Set(["CONCENTRATION_SHIFT", "INSIDER_TIMING", "TOKEN_QUALITY_SCORE",
    "SANDWICH", "MIRROR", "VOLUME_PROFILE_ANOMALY"]);

  // Use the cycle-level cached global stories — already fetched by getOrFetchCycleMarketContext().
  // This is the single stories API call for the entire cycle; no per-position calls are made.
  const { allStories: cycleAllStories } = getOrFetchCycleMarketContext();
  const allStories = cycleAllStories || [];
  const stories = {};
  const thesisStories = [];
  const seenStoryIds = new Set();
  function addStory(s) {
    const t = String(s?.story_type || s?.type || "").toUpperCase();
    if (!t) return;
    if (!stories[t]) stories[t] = [];
    const sid = s?.id || s?.story_id || null;
    if (sid && seenStoryIds.has(sid)) return;
    if (sid) seenStoryIds.add(sid);
    stories[t].push(s);
    if (t === "THESIS") thesisStories.push(s);
  }
  for (const s of allStories) addStory(s);

  _scoutCycleIndex++;

  const mapToken = (t) => ({
    symbol: t.symbol,
    name: t.name || "",
    address: cleanAddress(t.address || t.contract_address || ""),
    price_usd: t.priceUSD ?? t.price_usd ?? t.priceUsd ?? null,
    change_30m: t.changes?.["30M"]?.percent ?? t.change_30m_pct ?? null,
    change_24h: t.changes?.["24H"]?.percent ?? t.change_24h_pct ?? null,
    market_cap_usd: t.marketCapUSD ?? t.market_cap_usd ?? null,
    // effectiveLiquidityUSD is the real DEX depth; liquidityUSD is often 0
    // even when effectiveLiquidityUSD is non-zero — use || not ?? to prefer non-zero
    liquidity_usd: t.effectiveLiquidityUSD || t.liquidityUSD || t.liquidity_usd || null,
    volume_24h_usd: t.volume24hUSD || t.volume_24h_usd || null,
    fragility_score: t.fragilityScore ?? null,
    story_count_1h: t.storyCount ?? null,
  });

  // Primary: tokens ranked by story activity in the last hour — freshest on-chain signals first.
  const byStory = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    sortBy: "storyCount", sortDir: "desc", trendInterval: "1H", limit: 200
  })).map(mapToken);

  // Secondary: top-volume tokens for flow-only fallback (tokens with strong DEX activity
  // but no story yet — kept as a last-resort pool for the flow-only entry path).
  const byVolume = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    sortBy: "volume24hUSD", sortDir: "desc", limit: 200
  })).map(mapToken);

  // Merge, deduplicate — story-sorted tokens first so they win dedup priority.
  const seen = new Set();
  const raw = [];
  for (const t of [...byStory, ...byVolume]) {
    if (!t.address || seen.has(t.address)) continue;
    seen.add(t.address);
    raw.push(t);
  }

  // Sort: story count descending (freshest signals first), then volume as tiebreaker.
  const tokenUniverseAll = raw.sort((a, b) => {
    const storyDiff = (b.story_count_1h || 0) - (a.story_count_1h || 0);
    if (storyDiff !== 0) return storyDiff;
    return (b.volume_24h_usd || 0) - (a.volume_24h_usd || 0);
  });

  // Strip stablecoins, gold tokens, and base/wrapped assets — these are not momentum-trading
  // candidates and dominate the volume ranking, causing the LLM to propose them when
  // there are no stories to guide it toward real opportunities.
  const nonTradeablePattern = NONTRADEABLE_RE;
  const tokenUniverse = tokenUniverseAll.filter(t => !nonTradeablePattern.test(t.symbol || ""));

  // Enrich universe with story-mentioned tokens not in the top-volume list.
  // Stories (ACCUMULATION, SMART_MONEY, THESIS, etc.) often fire on tokens accumulating
  // before they show up in volume rankings — that's the alpha window. Fetch price data
  // for story-mentioned tokens and add them so Scout can propose them.
  // Includes pre-pump early signals (STAGING, CLUSTER, FUNNEL, DISCOVERY, HOTLINKS, NEW_WALLETS)
  // which fire before tokens reach the volume rankings — these were previously excluded,
  // causing in_token_universe=false and silently dropping all early-signal candidates.
  const highSignalStoryTypes = new Set([
    "THESIS", "ACCUMULATION", "SMART_MONEY", "STEALTH_ACCUMULATION", "BREAKOUT_CONFIRMED",
    "STAGING", "CLUSTER", "FUNNEL", "DISCOVERY", "HOTLINKS", "NEW_WALLETS", "DEEP_DIVE",
    "SMART_STAGING", "WHALE", "SMART_MONEY_LEADER",
  ]);
  const enrichQueue = [];
  for (const [type, items] of Object.entries(stories)) {
    if (!highSignalStoryTypes.has(type)) continue;
    for (const s of items) {
      const addr = cleanAddress(s?.meta?.token_address || s?.primary_token || s?.address || "");
      if (addr && !seen.has(addr)) enrichQueue.push({ addr, score: s?.score ?? 0, type });
    }
  }
  enrichQueue.sort((a, b) => b.score - a.score);
  for (const { addr } of enrichQueue) {
    try {
      const rows = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
        dataSource: 1, search: addr, limit: 1
      }));
      const row = rows.find((r) => cleanAddress(r.address || r.contract_address || "") === addr) || rows[0];
      if (!row) continue;
      const enriched = mapToken(row);
      if (enriched.address && (enriched.price_usd ?? 0) > 0 && !seen.has(enriched.address) &&
          !nonTradeablePattern.test(enriched.symbol || "")) {
        seen.add(enriched.address);
        tokenUniverse.push(enriched);
      }
    } catch (_) {}
  }
  log("scout_story_enrichment", { queued: enrichQueue.length, added: tokenUniverse.length - tokenUniverseAll.length + tokenUniverseAll.filter(t => nonTradeablePattern.test(t.symbol || "")).length });

  // Probe stories for high-volume tokens whose storyCount field is stale (shows 0 despite
  // having active on-chain stories when queried by address). The global /stories endpoint
  // returns only one story per type; active tokens with real signal but no recent type-slot
  // are invisible until probed. Without this, ASTEROID/ZBT/RIVER-class tokens pass volume
  // ranking but are dropped at the universe filter (story_count_1h=0, not in global feed).
  {
    const coveredByGlobal = new Set();
    for (const items of Object.values(stories)) {
      for (const s of items) {
        const addr = cleanAddress(s?.meta?.token_address || s?.primary_token || s?.address || "");
        if (addr) coveredByGlobal.add(addr);
      }
    }
    const probeTargets = tokenUniverse
      .filter(t => t.address && !coveredByGlobal.has(t.address) && (t.volume_24h_usd ?? 0) > 1_000_000)
      .slice(0, 25);
    let probeAdded = 0;
    for (const t of probeTargets) {
      const probeStories = endpointArray(fetchJson("/stories", { q: t.address, scope: "any", limit: 10 }));
      for (const s of probeStories) {
        addStory(s);
        if (_cycleMarketContext) _cycleMarketContext.allStories.push(s);
        probeAdded++;
      }
    }
    log("scout_story_probe", { probed: probeTargets.length, stories_added: probeAdded });
  }

  // Build a set of token addresses that appear in any E3D story this cycle.
  // The price API's storyCount field and the stories API update at different rates,
  // causing legitimate story tokens to show story_count_1h=0 and get dropped.
  // Tokens confirmed by the stories API feed are always included.
  const storyTokenAddresses = new Set();
  for (const items of Object.values(stories)) {
    for (const s of items) {
      const addr = cleanAddress(s?.meta?.token_address || s?.primary_token || s?.address || "");
      if (addr) storyTokenAddresses.add(addr);
    }
  }

  // Filter universe to tokens with price-API story activity OR confirmed by the stories feed.
  const tokenUniverseWithStories = [];
  const tokenUniverseFilteredOut = [];
  for (const token of tokenUniverse) {
    const include = token.address && ((token.story_count_1h || 0) > 0 || storyTokenAddresses.has(token.address));
    if (include) {
      tokenUniverseWithStories.push(token);
    } else {
      tokenUniverseFilteredOut.push(token);
    }
  }
  log("scout_universe_filter", {
    before: tokenUniverse.length,
    after: tokenUniverseWithStories.length,
    by_story_count: tokenUniverse.filter(t => t.address && (t.story_count_1h || 0) > 0).length,
    by_story_api: tokenUniverseWithStories.filter(t => (t.story_count_1h || 0) === 0).length,
  });
  for (const token of tokenUniverseFilteredOut.slice(0, 100)) {
    log("scout_universe_filtered_token", {
      symbol: token?.symbol || null,
      contract_address: cleanAddress(token?.address || token?.contract_address || "") || null,
      story_count_1h: toNum(token?.story_count_1h, 0),
      reasons: buildScoutUniverseFilterReasons(token, storyTokenAddresses)
    });
  }
  // Replace the working universe with the filtered set.
  tokenUniverse.length = 0;
  tokenUniverseWithStories.forEach(t => tokenUniverse.push(t));

  const thesisSignalStories = thesisStories.length ? thesisStories : endpointArray(stories.THESIS);

  // Supplemental per-address story probing is done above in the probe block (up to 25 calls).
  // No further per-token calls here — the dossier phase consumed per-position calls already.

  const storyTypeDist = Object.fromEntries(Object.entries(stories).map(([k, v]) => [k, v.length]));
  log("scout_story_types", { types: Object.keys(storyTypeDist).length, dist: storyTypeDist });

  // Fetch pre-computed multi-signal convergence candidates from the E3D agent system.
  // These are tokens where multiple story types have converged — much stronger signal
  // than any single story type alone. Joined with thesis data when one exists.
  const e3dCandidatesRaw = endpointArray(fetchJson("/candidates", { status: "new,promoted", limit: 100 }));
  const e3dCandidates = [];
  for (const candidate of e3dCandidatesRaw) {
    const decision = buildScoutE3dCandidateFilterDecision(candidate, nonTradeablePattern);
    if (decision.keep) {
      e3dCandidates.push(candidate);
    } else {
      log("scout_e3d_candidate_filtered", {
        symbol: decision.symbol,
        contract_address: decision.contract_address,
        reasons: decision.reasons
      });
    }
  }
  log("scout_e3d_candidates", { count: e3dCandidates.length, filtered_out: e3dCandidatesRaw.length - e3dCandidates.length });

  // Fetch structured investment theses — direction, conviction, price targets, invalidation.
  // Higher signal quality than THESIS-type stories since these are the agent's finalised views.
  const e3dTheses = endpointArray(fetchJson("/theses", { status: "active", limit: 25 }));
  log("scout_e3d_theses", { count: e3dTheses.length });

  // Fetch Decision Layer actions — pre-computed Q_A scores for accumulate/watch tokens.
  const e3dActionsRaw = endpointArray(fetchJson("/actions", {
    status: "open",
    actionType: "accumulate_signal,paper_buy,watch",
    sort: "action_score_desc",
    limit: 30,
    maxRisk: E3D_ACTIONS_MAX_RISK,
    minConfidence: E3D_ACTIONS_MIN_CONFIDENCE
  }));
  const e3dActions = e3dActionsRaw.filter(a => a?.token_address);
  log("scout_e3d_actions", { count: e3dActions.length });

  // Build avoid address set from high-risk structural actions.
  const e3dAvoidActionsRaw = endpointArray(fetchJson("/actions", {
    status: "open",
    actionType: "avoid,confirm_risk",
    minRisk: 0.50,
    limit: 50
  }));
  const avoidAddresses = new Set(
    e3dAvoidActionsRaw.map(a => cleanAddress(a.token_address || "")).filter(Boolean)
  );
  log("scout_avoid_set", { count: avoidAddresses.size });

  _cycleE3dActions = e3dActions;
  const e3dActionsByAddr = new Map(
    e3dActions.map(a => [cleanAddress(a.token_address || ""), a]).filter(([k]) => k)
  );

  // Fetch the authenticated user's watchlist — tokens they are personally monitoring.
  // Filtered to type=token only; non-tradeable symbols excluded using the same pattern
  // as the token universe filter so stablecoins/wrapped assets don't leak through.
  const watchlistRaw = endpointArray(fetchJson("/watchlist"));
  const e3dWatchlist = [];
  for (const item of watchlistRaw) {
    const decision = buildScoutWatchlistFilterDecision(item, nonTradeablePattern);
    if (decision.keep) {
      e3dWatchlist.push(item);
    } else {
      log("scout_watchlist_filtered", {
        symbol: decision.symbol,
        contract_address: decision.contract_address,
        reasons: decision.reasons
      });
    }
  }
  log("scout_watchlist", { total: watchlistRaw.length, filtered: e3dWatchlist.length });

  // Enrich universe with thesis tokens not already present. Theses cover tokens that have
  // high-conviction signals but may not surface in the standard volume/liquidity rankings.
  let thesisEnrichAdded = 0;
  for (const thesis of e3dTheses.slice(0, 8)) {
    const addr = cleanAddress(thesis?.entity_address || thesis?.token_address || thesis?.address || thesis?.contract_address || "");
    if (!addr || seen.has(addr)) continue;
    try {
      const rows = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
        dataSource: 1, search: addr, limit: 1
      }));
      const row = rows.find((r) => cleanAddress(r.address || r.contract_address || "") === addr) || rows[0];
      if (!row) continue;
      const enriched = mapToken(row);
      if (enriched.address && (enriched.price_usd ?? 0) > 0 && !seen.has(enriched.address) &&
          !nonTradeablePattern.test(enriched.symbol || "")) {
        seen.add(enriched.address);
        tokenUniverse.push(enriched);
        thesisEnrichAdded++;
      }
    } catch (_) {}
  }
  log("scout_thesis_enrichment", { checked: Math.min(e3dTheses.length, 8), added: thesisEnrichAdded });

  // Enrich universe with Decision Layer action tokens not already present.
  let actionEnrichAdded = 0;
  for (const action of e3dActions.slice(0, E3D_ACTIONS_ENRICH_LIMIT)) {
    const addr = cleanAddress(action.token_address || "");
    if (!addr || seen.has(addr)) continue;
    try {
      const rows = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
        dataSource: 1, search: addr, limit: 1
      }));
      const row = rows.find(r => cleanAddress(r.address || r.contract_address || "") === addr) || rows[0];
      if (!row) continue;
      const enriched = mapToken(row);
      if (enriched.address && (enriched.price_usd ?? 0) > 0 && !seen.has(enriched.address) &&
          !nonTradeablePattern.test(enriched.symbol || "")) {
        seen.add(enriched.address);
        enriched._e3d_action = {
          action_id:          action.action_id,
          action_type:        action.action_type,
          action_score:       action.action_score,
          confidence:         action.confidence,
          risk_score:         action.risk_score,
          expected_direction: action.expected_direction,
          expected_horizon:   action.expected_horizon,
          trigger_reason:     action.trigger_reason,
          n_supporting:       action.n_supporting,
        };
        tokenUniverse.push(enriched);
        actionEnrichAdded++;
      }
    } catch (_) {}
  }
  log("scout_action_enrichment", { checked: Math.min(e3dActions.length, E3D_ACTIONS_ENRICH_LIMIT), added: actionEnrichAdded });

  // Attach _e3d_action to tokens already in the universe that match an action address.
  for (const token of tokenUniverse) {
    if (!token._e3d_action && token.address) {
      const a = e3dActionsByAddr.get(token.address);
      if (a) {
        token._e3d_action = {
          action_id:          a.action_id,
          action_type:        a.action_type,
          action_score:       a.action_score,
          confidence:         a.confidence,
          risk_score:         a.risk_score,
          expected_direction: a.expected_direction,
          expected_horizon:   a.expected_horizon,
          trigger_reason:     a.trigger_reason,
          n_supporting:       a.n_supporting,
        };
      }
    }
  }

  // CoinGecko enrichment — batch price lookup for thesis tokens + top flow accumulation tokens,
  // then detailed lookup for any thesis token that passes the quality gate.
  const cgDetailMap = new Map(); // address -> full CoinGecko detail
  if (COINGECKO_API_KEY) {
    const thesisAddrs = e3dTheses
      .map(t => cleanAddress(t?.entity_address || t?.token_address || t?.address || t?.contract_address || ""))
      .filter(a => a);
    const flowAccumAddrs = tokenUniverse
      .filter(t => (t.flow_signal === "strong_accumulation" || t.flow_signal === "accumulation") && t.address)
      .slice(0, 15).map(t => t.address);
    const batchAddrs = [...new Set([...thesisAddrs, ...flowAccumAddrs])].slice(0, 30);
    const batchPrices = fetchCoinGeckoBatch(batchAddrs);
    log("scout_coingecko_batch", { queried: batchAddrs.length, found: Object.keys(batchPrices).length });

    // Resolve thesis tokens not yet in the universe using CoinGecko as authoritative source
    for (const addr of thesisAddrs) {
      if (seen.has(addr)) continue;
      const cg = batchPrices[addr];
      if (!cg?.usd || (cg.usd_market_cap || 0) < 2000000) continue;
      const detail = fetchCoinGeckoDetail(addr);
      if (!detail || nonTradeablePattern.test(detail.symbol || "")) continue;
      cgDetailMap.set(addr, detail);
      seen.add(addr);
      tokenUniverse.push({
        address: addr, symbol: detail.symbol, name: detail.name,
        price_usd: detail.price_usd, market_cap_usd: detail.market_cap_usd,
        volume_24h_usd: detail.volume_24h_usd, liquidity_usd: null,
        change_24h: detail.change_24h_pct, change_30m: null, _cg_source: true,
      });
    }

    // Overlay 7d price change from batch onto existing universe tokens (free, no extra calls)
    for (const t of tokenUniverse) {
      const cg = t.address ? batchPrices[t.address] : null;
      if (!cg) continue;
      t._cg_change_7d_pct = cg.usd_7d_change ?? null;
      if (!(t.market_cap_usd > 0) && cg.usd_market_cap > 0) t.market_cap_usd = cg.usd_market_cap;
    }
  }

  // Suppress tokens with active avoid/confirm_risk Decision Layer actions before the LLM sees them.
  if (avoidAddresses.size > 0) {
    for (let i = tokenUniverse.length - 1; i >= 0; i--) {
      const t = tokenUniverse[i];
      if (t.address && avoidAddresses.has(t.address)) {
        log("scout_token_suppressed_avoid_action", { address: t.address, symbol: t.symbol });
        tokenUniverse.splice(i, 1);
      }
    }
  }

  return { stories, thesisSignalStories, tokenUniverse, disqualifierTypes, buySignalTypes, lateSignalTypes, secondaryTypes, sortLabel: "storyCount:1H desc", e3dCandidates, e3dTheses, cgDetailMap, e3dWatchlist, e3dActions, avoidAddresses };
}

const SCOUT_EVIDENCE_PACKET_SAFE_PROMPT_CHARS = 42000;

function holdingAgeHours(position, fallbackPosition = null, asOf = nowIso()) {
  const openedAt = position?.opened_at || fallbackPosition?.opened_at || null;
  if (!openedAt) return null;
  const openedMs = new Date(openedAt).getTime();
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(openedMs) || !Number.isFinite(asOfMs) || asOfMs < openedMs) return null;
  return Number(((asOfMs - openedMs) / 3600000).toFixed(2));
}

function buildHarvestStoryEvidence(story, storyType) {
  const type = String(storyType || story?.story_type || story?.type || "").toUpperCase();
  if (!type) return null;
  const hint = String(
    story?.meta?.narrative_hint
    || story?.ai_narrative
    || story?.meta?.ai_narrative
    || story?.title
    || story?.subtitle
    || ""
  ).trim();
  const direction = HARVEST_HOLD_CONFIRM_TYPES.includes(type)
    ? "bullish"
    : HARVEST_PUMP_EXHAUSTION_TYPES.includes(type)
      ? "bearish"
      : ["SECURITY_RISK", "RUG_LIQUIDITY_PULL", "TREASURY_DISTRIBUTION", "CONCENTRATION_SHIFT"].includes(type)
        ? "risk"
        : "bearish";
  return {
    source_type: "story",
    source_ref: story?.id || story?.story_id || null,
    label: `story_${type.toLowerCase()}`,
    direction,
    strength: Math.max(40, Math.min(95, Math.round(toNum(story?.score, direction === "bullish" ? 72 : 78)))),
    summary: `${type}${hint ? `: ${hint.slice(0, 110)}` : ""}`.slice(0, 160)
  };
}

function extractHarvestEvidenceRefs(review) {
  const refs = Array.isArray(review?.evidence) ? review.evidence : [];
  const normalized = [];
  const seen = new Set();
  for (const ref of refs) {
    const evidenceId = String(
      typeof ref === "string"
        ? ref
        : ref?.evidence_id || ref?.id || ref?.ref || ""
    ).trim();
    if (!evidenceId || seen.has(evidenceId)) continue;
    seen.add(evidenceId);
    normalized.push(evidenceId);
  }
  return normalized;
}

function cleanEvidenceText(value) {
  const text = stripText(value);
  return text || null;
}

function cleanEvidenceList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanEvidenceText(value))
    .filter(Boolean))];
}

function buildCompactEvidenceSummary(packet = null, refs = []) {
  const packetEvidence = Array.isArray(packet?.evidence) ? packet.evidence : [];
  const refsUsed = cleanEvidenceList(refs);
  const refSet = new Set(refsUsed);
  const highlights = packetEvidence
    .filter((item) => refSet.size === 0 || refSet.has(item?.evidence_id))
    .slice(0, 3)
    .map((item) => ({
      evidence_id: item?.evidence_id || null,
      source_type: item?.source_type || null,
      label: item?.label || null,
      direction: item?.direction || null,
      strength: item?.strength == null ? null : Math.max(0, Math.min(100, Math.round(toNum(item.strength, 0))))
    }))
    .filter((item) => item.evidence_id);
  return {
    evidence_packet_id: packet?.evidence_packet_id || null,
    quality_score: packet?.quality_score == null ? null : Math.max(0, Math.min(100, Math.round(toNum(packet.quality_score, 0)))),
    evidence_count: Math.max(0, Math.round(toNum(packet?.evidence_count, packetEvidence.length))),
    refs_used: refsUsed,
    blockers: cleanEvidenceList(packet?.blockers),
    warnings: cleanEvidenceList(packet?.warnings),
    highlights
  };
}

function extractEvidenceMetadata(source = {}) {
  const refs = extractHarvestEvidenceRefs(source);
  const summarySource = source?.evidence_summary && typeof source.evidence_summary === "object"
    ? source.evidence_summary
    : null;
  const summary = summarySource
    ? {
        evidence_packet_id: summarySource.evidence_packet_id || source?.evidence_packet_id || null,
        quality_score: summarySource.quality_score == null ? null : Math.max(0, Math.min(100, Math.round(toNum(summarySource.quality_score, 0)))),
        evidence_count: Math.max(0, Math.round(toNum(summarySource.evidence_count, 0))),
        refs_used: cleanEvidenceList(summarySource.refs_used),
        blockers: cleanEvidenceList(summarySource.blockers),
        warnings: cleanEvidenceList(summarySource.warnings),
        highlights: (Array.isArray(summarySource.highlights) ? summarySource.highlights : [])
          .slice(0, 3)
          .map((item) => ({
            evidence_id: item?.evidence_id || null,
            source_type: item?.source_type || null,
            label: item?.label || null,
            direction: item?.direction || null,
            strength: item?.strength == null ? null : Math.max(0, Math.min(100, Math.round(toNum(item.strength, 0))))
          }))
          .filter((item) => item.evidence_id)
      }
    : null;
  return {
    evidence_packet_id: source?.evidence_packet_id || summary?.evidence_packet_id || null,
    evidence_quality_score: source?.evidence_quality_score != null
      ? Math.max(0, Math.min(100, Math.round(toNum(source.evidence_quality_score, 0))))
      : (summary?.quality_score ?? null),
    evidence_ref_count: Math.max(0, Math.round(toNum(source?.evidence_ref_count, refs.length))),
    evidence_blockers: cleanEvidenceList(source?.evidence_blockers || summary?.blockers),
    evidence_warnings: cleanEvidenceList(source?.evidence_warnings || summary?.warnings),
    evidence_refs: refs,
    evidence_summary: summary
  };
}

function applyEvidenceMetadata(target, source = {}) {
  if (!target || !source) return target;
  const metadata = extractEvidenceMetadata(source);
  if (metadata.evidence_packet_id) target.evidence_packet_id = metadata.evidence_packet_id;
  if (metadata.evidence_quality_score != null) target.evidence_quality_score = metadata.evidence_quality_score;
  if (metadata.evidence_ref_count > 0) target.evidence_ref_count = metadata.evidence_ref_count;
  if (metadata.evidence_blockers.length) target.evidence_blockers = metadata.evidence_blockers;
  if (metadata.evidence_warnings.length) target.evidence_warnings = metadata.evidence_warnings;
  if (metadata.evidence_refs.length) target.evidence_refs = metadata.evidence_refs;
  if (metadata.evidence_summary) target.evidence_summary = deepClone(metadata.evidence_summary);
  return target;
}

function decorateRiskReviewWithEvidence(risk = {}, proposal = {}) {
  return {
    ...risk,
    ...extractEvidenceMetadata(proposal)
  };
}

function buildHarvestEvidenceReviewContext(portfolio, portfolioIntelligence = null, options = {}) {
  const createdAt = options.createdAt || nowIso();
  const dossier = portfolioIntelligence || buildPortfolioIntelligenceDossier(portfolio);
  const positions = Object.values(portfolio?.positions || {});
  const heldAddresses = positions.map((p) => cleanAddress(p?.contract_address || "")).filter(Boolean);
  const addrSet = new Set(heldAddresses);
  const { allStories: cycleHarvestStories, tokenUniverse } = getOrFetchCycleMarketContext();
  const allHarvestStories = cycleHarvestStories || [];
  const tokenByAddress = new Map(
    (tokenUniverse || [])
      .filter((token) => cleanAddress(token?.address || ""))
      .map((token) => [cleanAddress(token.address), token])
  );
  const storyMatchesByType = {};
  for (const type of [...HARVEST_EXIT_RISK_TYPES, ...HARVEST_HOLD_CONFIRM_TYPES, ...HARVEST_PUMP_EXHAUSTION_TYPES]) {
    storyMatchesByType[type] = [];
  }
  for (const story of allHarvestStories) {
    const type = String(story?.story_type || story?.type || "").toUpperCase();
    if (!type || !storyMatchesByType[type]) continue;
    const addr = cleanAddress(story?.meta?.token_address || story?.primary_token || story?.token_address || story?.address || "");
    if (!addr || !addrSet.has(addr)) continue;
    storyMatchesByType[type].push(story);
  }

  const dossierByAddress = new Map();
  const dossierBySymbol = new Map();
  for (const item of dossier.holdings || []) {
    const addr = cleanAddress(item?.token?.contract_address || "");
    const sym = String(item?.token?.symbol || "").trim().toLowerCase();
    if (addr) dossierByAddress.set(addr, item);
    if (sym) dossierBySymbol.set(sym, item);
  }

  const entries = positions.map((livePos) => {
    const addr = cleanAddress(livePos?.contract_address || "");
    const symbol = String(livePos?.symbol || "").trim().toUpperCase() || null;
    const dossierItem = (addr && dossierByAddress.get(addr)) || (symbol && dossierBySymbol.get(symbol.toLowerCase())) || null;
    const tokenRow = addr ? tokenByAddress.get(addr) || null : null;
    const flowData = addr ? (_cycleQuantContext?.token_flow?.[addr] ?? null) : null;
    const funding = symbol ? (_cycleQuantContext?.funding_rates?.[symbol] ?? _cycleQuantContext?.funding_rates?.[symbol.toLowerCase()] ?? null) : null;
    const livePrice = toNum(
      livePos?.current_price,
      toNum(flowData?.price_usd, toNum(tokenRow?.price_usd, toNum(dossierItem?.market_data?.current_price, 0)))
    );
    const qty = toNum(livePos?.quantity, toNum(dossierItem?.position?.quantity, 0));
    const costBasis = toNum(livePos?.cost_basis_usd, toNum(dossierItem?.position?.cost_basis_usd, qty * toNum(livePos?.avg_entry_price, toNum(dossierItem?.position?.avg_entry_price, 0))));
    const marketValue = qty * livePrice;
    const pnlUsd = marketValue - costBasis;
    const pnlPct = costBasis > 0 ? Number(((pnlUsd / costBasis) * 100).toFixed(2)) : 0;
    const holdAgeHours = holdingAgeHours(livePos, dossierItem?.position, createdAt);
    const liquidityUsd = toNum(
      livePos?.liquidity_usd,
      toNum(livePos?.last_market_snapshot?.liquidity_data?.liquidity_usd, toNum(tokenRow?.liquidity_usd, NaN))
    );
    const executionData = {
      ...estimateScoutExecutionData(liquidityUsd),
      ...(livePos?.last_market_snapshot?.execution_data || {}),
      quote_timestamp: createdAt
    };
    const marketData = {
      current_price: livePrice,
      change_24h_pct: toNum(
        livePos?.last_market_snapshot?.market_data?.change_24h_pct,
        toNum(tokenRow?.change_24h, toNum(dossierItem?.market_data?.change_24h_pct, NaN))
      ),
      change_30m_pct: toNum(
        livePos?.last_market_snapshot?.market_data?.change_30m_pct,
        toNum(tokenRow?.change_30m, NaN)
      ),
      volume_24h_usd: toNum(
        livePos?.last_market_snapshot?.market_data?.volume_24h_usd,
        toNum(tokenRow?.volume_24h_usd, toNum(dossierItem?.market_data?.volume_24h_usd, NaN))
      ),
      market_cap_usd: toNum(
        livePos?.last_market_snapshot?.market_data?.market_cap_usd,
        toNum(tokenRow?.market_cap_usd, toNum(dossierItem?.market_data?.market_cap_usd, NaN))
      ),
      price_source: livePos?.last_market_snapshot?.market_data?.price_source || (flowData?.price_usd ? "dexscreener" : "e3d"),
      price_timestamp: createdAt
    };
    const liquidityData = {
      liquidity_usd: liquidityUsd,
      liquidity_source: livePos?.last_market_snapshot?.liquidity_data?.liquidity_source || "e3d",
      liquidity_timestamp: createdAt
    };
    const evidence = [];
    for (const type of [...HARVEST_EXIT_RISK_TYPES, ...HARVEST_HOLD_CONFIRM_TYPES, ...HARVEST_PUMP_EXHAUSTION_TYPES]) {
      for (const story of storyMatchesByType[type]) {
        const storyAddr = cleanAddress(story?.meta?.token_address || story?.primary_token || story?.token_address || story?.address || "");
        if (storyAddr !== addr) continue;
        const normalized = buildHarvestStoryEvidence(story, type);
        if (normalized) evidence.push(normalized);
      }
    }
    const flowSignal = String(flowData?.flow_signal || "").toLowerCase();
    if (flowSignal.includes("distribution")) {
      evidence.push({
        source_type: "flow",
        source_ref: "token_flow",
        label: "flow_distribution_exit_risk",
        direction: "bearish",
        strength: flowSignal.includes("strong_") ? 86 : 74,
        summary: [
          `flow ${flowData.flow_signal}`,
          flowData?.buy_sell_ratio_1h != null ? `b/s 1h ${toNum(flowData.buy_sell_ratio_1h, 0).toFixed(2)}` : null
        ].filter(Boolean).join(", ").slice(0, 160)
      });
    } else if (flowSignal.includes("accumulation")) {
      evidence.push({
        source_type: "flow",
        source_ref: "token_flow",
        label: "flow_accumulation_hold_confirm",
        direction: "bullish",
        strength: flowSignal.includes("strong_") ? 84 : 72,
        summary: [
          `flow ${flowData.flow_signal}`,
          flowData?.buy_sell_ratio_1h != null ? `b/s 1h ${toNum(flowData.buy_sell_ratio_1h, 0).toFixed(2)}` : null
        ].filter(Boolean).join(", ").slice(0, 160)
      });
    }
    const spreadBps = toNum(executionData?.spread_bps, NaN);
    const slippageBps = toNum(executionData?.estimated_slippage_bps, NaN);
    if (Number.isFinite(spreadBps) && spreadBps >= 150 || Number.isFinite(slippageBps) && slippageBps >= 200) {
      evidence.push({
        source_type: "liquidity",
        source_ref: "execution_snapshot",
        label: "spread_slippage_degradation",
        direction: "bearish",
        strength: Math.max(60, Math.min(95, Math.round(Math.max(toNum(spreadBps, 0) / 3, toNum(slippageBps, 0) / 4)))),
        summary: [
          Number.isFinite(spreadBps) ? `spread ${spreadBps.toFixed(1)}bps` : null,
          Number.isFinite(slippageBps) ? `slip ${slippageBps.toFixed(1)}bps` : null
        ].filter(Boolean).join(", ")
      });
    } else if (Number.isFinite(liquidityUsd) && liquidityUsd >= 200000 && (!Number.isFinite(spreadBps) || spreadBps <= 60) && (!Number.isFinite(slippageBps) || slippageBps <= 80)) {
      evidence.push({
        source_type: "liquidity",
        source_ref: "execution_snapshot",
        label: "improving_liquidity_hold_confirm",
        direction: "bullish",
        strength: 68,
        summary: [
          `liq $${Math.round(liquidityUsd).toLocaleString("en-US")}`,
          Number.isFinite(spreadBps) ? `spread ${spreadBps.toFixed(1)}bps` : null,
          Number.isFinite(slippageBps) ? `slip ${slippageBps.toFixed(1)}bps` : null
        ].filter(Boolean).join(", ")
      });
    }

    const harvestInput = {
      created_at: createdAt,
      strategy_version: PAPER_ORDER_STRATEGY_VERSION,
      token: {
        symbol,
        name: livePos?.name || dossierItem?.token?.name || symbol,
        chain: "ethereum",
        contract_address: addr,
        category: livePos?.category || dossierItem?.token?.category || "unknown"
      },
      symbol,
      contract_address: addr,
      position: {
        position_id: addr || symbol,
        symbol,
        contract_address: addr,
        quantity: qty,
        avg_entry_price: toNum(livePos?.avg_entry_price, toNum(dossierItem?.position?.avg_entry_price, 0)),
        current_price: livePrice,
        market_value_usd: Number(marketValue.toFixed(2)),
        cost_basis_usd: Number(costBasis.toFixed(2)),
        unrealized_pnl_usd: Number(pnlUsd.toFixed(2)),
        unrealized_pnl_pct: pnlPct,
        holding_age_hours: holdAgeHours,
        opened_at: livePos?.opened_at || dossierItem?.position?.opened_at || null,
        risk_metadata: {
          fraud_risk: toNum(livePos?.fraud_risk, toNum(dossierItem?.thesis?.fraud_risk, NaN)),
          liquidity_quality: toNum(livePos?.liquidity_quality, toNum(dossierItem?.thesis?.liquidity_quality, NaN)),
          flow_alignment: toNum(dossierItem?.thesis?.flow_alignment, NaN),
          last_position_score: toNum(livePos?.score, NaN)
        }
      },
      market_data: marketData,
      liquidity_data: liquidityData,
      execution_data: executionData,
      flow: flowData ? {
        flow_signal: flowData.flow_signal,
        buy_sell_ratio_1h: flowData.buy_sell_ratio_1h,
        price_change_1h_pct: flowData.price_change_1h_pct,
        source: "dexscreener",
        timestamp: createdAt
      } : null,
      thesis: dossierItem?.thesis ? {
        thesis_id: addr || symbol,
        conviction: dossierItem?.thesis?.strength ?? dossierItem?.recommendation?.confidence ?? null,
        direction: dossierItem?.recommendation?.action === "exit" ? "bearish" : "bullish",
        summary: dossierItem?.recommendation?.why_now || dossierItem?.recommendation?.invalidation || null,
        freshness_seconds: null,
        strength: dossierItem?.thesis?.strength ?? null
      } : null,
      evidence,
      performance: {
        expectancy_usd: pnlUsd,
        win_rate: pnlPct > 0 ? 1 : 0
      }
    };
    harvestInput.market_data_quality = buildMarketDataQuality(harvestInput, { evaluated_at: createdAt });
    harvestInput.token_risk_scan = buildPositionTokenRiskScan({
      symbol,
      contract_address: addr,
      category: harvestInput.token.category,
      current_price: livePrice,
      liquidity_usd: liquidityUsd,
      liquidity_quality: harvestInput.position.risk_metadata.liquidity_quality,
      fraud_risk: harvestInput.position.risk_metadata.fraud_risk,
      last_market_snapshot: {
        market_data: marketData,
        liquidity_data: liquidityData,
        execution_data: executionData
      }
    }, portfolio, { evaluated_at: createdAt, mode: "paper", side: "sell" });
    const mapsPrecheck = buildMapsNavigatorPrecheck({
      symbol,
      mapsContext: _cycleMapsContext
    });
    harvestInput.maps_precheck = mapsPrecheck;
    const packet = buildHarvestEvidencePacket(harvestInput, { created_at: createdAt });
    const packetSummary = {
      evidence_packet_id: packet.evidence_packet_id,
      symbol,
      contract_address: addr,
      token: harvestInput.token,
      position: {
        quantity: harvestInput.position.quantity,
        avg_entry_price: harvestInput.position.avg_entry_price,
        current_price: harvestInput.position.current_price,
        market_value_usd: harvestInput.position.market_value_usd,
        unrealized_pnl_usd: harvestInput.position.unrealized_pnl_usd,
        unrealized_pnl_pct: harvestInput.position.unrealized_pnl_pct,
        holding_age_hours: harvestInput.position.holding_age_hours
      },
      position_risk: harvestInput.position.risk_metadata,
      quality_score: packet.quality_score,
      warnings: packet.warnings,
      blockers: packet.blockers,
      maps_navigator_precheck: mapsPrecheck.prompt_prefix || null,
      evidence: packet.evidence.slice(0, HARVEST_EVIDENCE_PACKET_MAX_ITEMS).map((item) => ({
        evidence_id: item.evidence_id,
        source_type: item.source_type,
        label: item.label,
        direction: item.direction,
        strength: item.strength,
        summary: item.summary
      })),
      evidence_ids: packet.evidence.slice(0, HARVEST_EVIDENCE_PACKET_MAX_ITEMS).map((item) => item.evidence_id)
    };
    return {
      address: addr,
      symbol,
      dossier_item: dossierItem,
      harvest_input: harvestInput,
      maps_precheck: mapsPrecheck,
      packet,
      packet_summary: packetSummary
    };
  });

  const storiesChecked = [...HARVEST_EXIT_RISK_TYPES, ...HARVEST_HOLD_CONFIRM_TYPES, ...HARVEST_PUMP_EXHAUSTION_TYPES].map((type) => ({
    type,
    found: storyMatchesByType[type]?.length || 0,
    flagged_addresses: Array.from(new Set((storyMatchesByType[type] || []).map((story) =>
      cleanAddress(story?.meta?.token_address || story?.primary_token || story?.token_address || story?.address || "")
    ).filter(Boolean)))
  }));

  return {
    dossier,
    positions,
    entries,
    stories_checked: storiesChecked
  };
}

function finalizeHarvestLLMResult(parsed, portfolio, reviewContext, dossier, createdAt, expiresAt, harvestLlmBatches) {
  const rawParsed = parsed && typeof parsed === "object" ? parsed : {};
  const normalizedReviews = [];
  let downgradedForEvidenceCount = 0;
  const parsedReviews = Array.isArray(rawParsed?.position_reviews) ? rawParsed.position_reviews : [];
  const parsedExits = Array.isArray(rawParsed?.exit_candidates) ? rawParsed.exit_candidates : [];
  const rawReviewByAddress = new Map();
  const rawExitByAddress = new Map();

  for (const review of parsedReviews) {
    const addr = cleanAddress(review?.token?.contract_address || "");
    if (addr && !rawReviewByAddress.has(addr)) rawReviewByAddress.set(addr, review);
  }
  for (const candidate of parsedExits) {
    const addr = cleanAddress(candidate?.token?.contract_address || "");
    if (addr && !rawExitByAddress.has(addr)) rawExitByAddress.set(addr, candidate);
  }

  for (const entry of reviewContext.entries) {
    const rawReview = rawReviewByAddress.get(entry.address) || rawExitByAddress.get(entry.address) || {};
    const validEvidenceIds = new Set(entry.packet_summary.evidence_ids);
    const validRefs = extractHarvestEvidenceRefs(rawReview).filter((ref) => validEvidenceIds.has(ref));
    const requestedAction = ["hold", "monitor", "trim", "exit"].includes(String(rawReview?.action || "").toLowerCase())
      ? String(rawReview.action).toLowerCase()
      : "monitor";
    const finalAction = ["trim", "exit"].includes(requestedAction) && validRefs.length < 2 ? "monitor" : requestedAction;
    if (["trim", "exit"].includes(requestedAction) && finalAction === "monitor") {
      downgradedForEvidenceCount += 1;
      log("harvest_candidate_downgraded", {
        reason: "too_few_valid_evidence_refs",
        contract_address: entry.address,
        symbol: entry.symbol,
        evidence_packet_id: entry.packet.evidence_packet_id,
        valid_ref_count: validRefs.length
      });
    }

    normalizedReviews.push({
      ...rawReview,
      source_agent: "harvest",
      created_at: createdAt,
      expires_at: expiresAt,
      evidence_packet_id: entry.packet.evidence_packet_id,
      evidence_quality_score: entry.packet.quality_score,
      evidence_blockers: cleanEvidenceList(entry.packet.blockers),
      evidence_warnings: cleanEvidenceList(entry.packet.warnings),
      token: {
        ...(rawReview?.token || {}),
        ...deepClone(entry.harvest_input.token)
      },
      position: {
        ...(rawReview?.position || {}),
        ...deepClone(entry.harvest_input.position)
      },
      action: finalAction,
      thesis_state: rawReview?.thesis_state || entry.dossier_item?.thesis?.state || "watch",
      thesis_summary: rawReview?.thesis_summary || entry.dossier_item?.recommendation?.why_now || entry.packet.evidence[0]?.summary || "Evidence packet review.",
      what_changed: rawReview?.what_changed || null,
      why_now: rawReview?.why_now || rawReview?.summary || entry.dossier_item?.recommendation?.why_now || "Monitor packet evidence and thesis state.",
      confidence: Math.max(0, Math.min(100, Math.round(toNum(rawReview?.confidence, entry.dossier_item?.recommendation?.confidence ?? entry.packet.quality_score)))),
      conviction_score: Math.max(0, Math.min(100, Math.round(toNum(rawReview?.conviction_score, entry.dossier_item?.thesis?.strength ?? entry.packet.quality_score)))),
      opportunity_score: Math.max(0, Math.min(100, Math.round(toNum(rawReview?.opportunity_score, entry.dossier_item?.thesis?.opportunity_score ?? entry.packet.quality_score)))),
      review_priority: Math.max(1, Math.min(5, Math.round(toNum(rawReview?.review_priority, finalAction === "exit" ? 5 : finalAction === "trim" ? 4 : finalAction === "monitor" ? 3 : 2)))),
      summary: rawReview?.summary || entry.dossier_item?.recommendation?.why_now || "Evidence-first harvest review.",
      evidence: validRefs,
      evidence_ref_count: validRefs.length,
      evidence_summary: buildCompactEvidenceSummary(entry.packet, validRefs),
      risks: Array.isArray(rawReview?.risks) ? rawReview.risks : [],
      what_would_change_my_mind: Array.isArray(rawReview?.what_would_change_my_mind) ? rawReview.what_would_change_my_mind : [],
      next_best_alternative: rawReview?.next_best_alternative || entry.dossier_item?.recommendation?.next_best_alternative || "Monitor next cycle evidence packet.",
      current_regime: rawReview?.current_regime || dossier.market_regime || "unknown",
      market_data: {
        ...(entry.harvest_input.market_data || {}),
        ...(rawReview?.market_data || {})
      },
      liquidity_data: {
        ...(entry.harvest_input.liquidity_data || {}),
        ...(rawReview?.liquidity_data || {})
      },
      narrative_data: {
        ...(rawReview?.narrative_data || {}),
        story_strength: Math.max(0, Math.min(100, Math.round(toNum(rawReview?.narrative_data?.story_strength, entry.dossier_item?.thesis?.strength ?? entry.packet.quality_score)))),
        thesis_health: Math.max(0, Math.min(100, Math.round(toNum(rawReview?.narrative_data?.thesis_health, entry.dossier_item?.thesis?.freshness ?? entry.packet.quality_score)))),
        flow_direction: rawReview?.narrative_data?.flow_direction || entry.harvest_input.flow?.flow_signal || "neutral"
      },
      portfolio_data: rawReview?.portfolio_data && typeof rawReview.portfolio_data === "object"
        ? rawReview.portfolio_data
        : { current_token_exposure_pct: 0, current_category_exposure_pct: 0, current_total_exposure_pct: 0, portfolio_timestamp: createdAt, portfolio_source: "system" },
      market_data_quality: deepClone(entry.harvest_input.market_data_quality),
      market_data_quality_id: entry.harvest_input.market_data_quality?.data_quality_id || null,
      market_data_quality_ref: buildMarketDataQualityRef(entry.harvest_input.market_data_quality, { context: "harvest_packet" }),
      token_risk_scan: deepClone(entry.harvest_input.token_risk_scan),
      token_risk_scan_id: entry.harvest_input.token_risk_scan?.token_risk_scan_id || null,
      token_risk_scan_ref: buildTokenRiskScanRef(entry.harvest_input.token_risk_scan, { context: "harvest_packet" }),
      fraud_risk: toNum(entry.harvest_input.position?.risk_metadata?.fraud_risk, NaN),
      liquidity_quality: toNum(entry.harvest_input.position?.risk_metadata?.liquidity_quality, NaN)
    });
  }

  const exitCandidates = normalizedReviews
    .filter((review) => ["trim", "exit"].includes(String(review?.action || "").toLowerCase()))
    .map((review) => {
      const rawExit = rawExitByAddress.get(cleanAddress(review?.token?.contract_address || "")) || {};
      return {
        ...review,
        ...rawExit,
        source_agent: "harvest",
        created_at: createdAt,
        expires_at: expiresAt,
        evidence_packet_id: review.evidence_packet_id,
        token: review.token,
        position: review.position,
        action: review.action,
        evidence: review.evidence,
        evidence_ref_count: review.evidence_ref_count,
        setup_type: rawExit?.setup_type || "harvest_review",
        edge_source: rawExit?.edge_source || "evidence_packet",
        suggested_exit_fraction: Math.max(0.1, Math.min(1, toNum(rawExit?.suggested_exit_fraction, review.action === "exit" ? 1 : 0.5))),
        target_exit_price: toNum(rawExit?.target_exit_price, toNum(review?.market_data?.current_price, 0)),
        decision_price: toNum(rawExit?.decision_price, toNum(review?.market_data?.current_price, 0)),
        exit_priority: Math.max(1, Math.min(5, Math.round(toNum(rawExit?.exit_priority, review.review_priority || (review.action === "exit" ? 5 : 4)))))
      };
    });

  const result = {
    scan_timestamp: rawParsed?.scan_timestamp || createdAt,
    portfolio_summary: rawParsed?.portfolio_summary && typeof rawParsed.portfolio_summary === "object"
      ? rawParsed.portfolio_summary
      : {
          market_regime: dossier.market_regime || "unknown",
          cash_usd: portfolio.cash_usd || 0,
          equity_usd: portfolio.equity_usd || 0,
          position_count: Object.keys(portfolio?.positions || {}).length,
          tracked_positions: reviewContext.entries.length,
          average_thesis_strength: 0,
          average_thesis_freshness: 0,
          average_narrative_decay: 0,
          average_opportunity_score: 0
        },
    position_reviews: normalizedReviews,
    exit_candidates: exitCandidates,
    stories_checked: reviewContext.stories_checked
  };
  result.evidence_diagnostics = buildHarvestEvidenceDiagnostics({
    input_candidate_count: reviewContext.entries.length,
    llm_batches: harvestLlmBatches,
    positions_reviewed: result.position_reviews.length,
    position_reviews: result.position_reviews,
    exit_candidates: result.exit_candidates,
    stories_checked: result.stories_checked,
    coverage: null
  });
  result.evidence_diagnostics.evidence_downgrade_count = downgradedForEvidenceCount;
  return result;
}

function buildScoutStoryEvidence(story, data) {
  const type = String(story?.story_type || story?.type || "").toUpperCase();
  if (!type) return null;
  const direction = data?.disqualifierTypes?.has(type)
    ? "risk"
    : data?.lateSignalTypes?.has(type)
      ? "bearish"
      : "bullish";
  const score = toNum(story?.score, 68);
  const title = String(story?.title || story?.subtitle || story?.ai_narrative || story?.meta?.ai_narrative || "").trim();
  return {
    source_type: "story",
    source_ref: story?.id || story?.story_id || null,
    label: `story_${type.toLowerCase()}`,
    direction,
    strength: Math.max(35, Math.min(95, Math.round(score))),
    story_type: type,
    summary: `${type}${title ? `: ${title.slice(0, 110)}` : ""}`.slice(0, 160)
  };
}

function estimateScoutExecutionData(liquidityUsd) {
  const liquidity = toNum(liquidityUsd, 0);
  const slippageBps = liquidity > 100000 ? 50 : liquidity > 20000 ? 150 : liquidity > 5000 ? 300 : 999;
  return {
    estimated_slippage_bps: slippageBps,
    quote_source: "e3d"
  };
}

function extractScoutEvidenceRefs(proposal) {
  const refs = Array.isArray(proposal?.evidence) ? proposal.evidence : [];
  const normalized = [];
  const seen = new Set();
  for (const ref of refs) {
    const evidenceId = String(
      typeof ref === "string"
        ? ref
        : ref?.evidence_id || ref?.id || ref?.ref || ""
    ).trim();
    if (!evidenceId || seen.has(evidenceId)) continue;
    seen.add(evidenceId);
    normalized.push(evidenceId);
  }
  return normalized;
}

function resolveScoutMaxCandidates(settings = SETTINGS_DEFAULTS) {
  return Math.max(1, Math.trunc(toNum(settings?.scout_max_candidates, SETTINGS_DEFAULTS.scout_max_candidates)));
}

function resolveScoutEvidenceRefMinimum(entry = {}) {
  const packetSummary = entry?.packet_summary && typeof entry.packet_summary === "object" ? entry.packet_summary : {};
  const scoutInput = entry?.scout_input && typeof entry.scout_input === "object" ? entry.scout_input : {};
  const flow = scoutInput?.flow && typeof scoutInput.flow === "object" ? scoutInput.flow : {};
  const liquidityData = scoutInput?.liquidity_data && typeof scoutInput.liquidity_data === "object" ? scoutInput.liquidity_data : {};
  const marketData = scoutInput?.market_data && typeof scoutInput.market_data === "object" ? scoutInput.market_data : {};

  const isHighConfidenceFlowOnly =
    packetSummary.flow_only === true
    && String(flow?.flow_signal || "").trim().toLowerCase() === "strong_accumulation"
    && toNum(liquidityData?.liquidity_usd, 0) >= 500000
    && toNum(marketData?.market_cap_usd, 0) >= 5000000;

  return isHighConfidenceFlowOnly ? 2 : 3;
}

function buildScoutEvidenceShortlist(data, portfolio, options = {}) {
  const createdAt = options.createdAt || nowIso();
  const heldAddresses = options.heldAddresses || new Set();
  const heldSymbols = options.heldSymbols || new Set();
  const disqualifiedAddresses = options.disqualifiedAddresses || new Set();
  const shortlistLimit = Math.max(1, Math.trunc(toNum(process.env.SCOUT_EVIDENCE_SHORTLIST_LIMIT, SCOUT_EVIDENCE_SHORTLIST_DEFAULT_LIMIT)));

  const tokenByAddr = new Map(
    (data?.tokenUniverse || [])
      .filter((token) => cleanAddress(token?.address || ""))
      .map((token) => [cleanAddress(token.address), token])
  );
  const storyMap = new Map();
  for (const items of Object.values(data?.stories || {})) {
    for (const story of (items || [])) {
      const addr = cleanAddress(story?.meta?.primary?.address || story?.meta?.token_address || story?.meta?.token?.address || story?.primary_token || story?.address || "");
      if (!addr) continue;
      if (!storyMap.has(addr)) storyMap.set(addr, []);
      const normalized = buildScoutStoryEvidence(story, data);
      if (normalized) storyMap.get(addr).push(normalized);
    }
  }

  const candidateByAddr = new Map();
  for (const candidate of (data?.e3dCandidates || [])) {
    const addr = cleanAddress(candidate?.entity_address || candidate?.token_address || candidate?.address || candidate?.contract_address || "");
    if (addr) candidateByAddr.set(addr, candidate);
  }

  const thesisByAddr = new Map();
  for (const thesis of (data?.e3dTheses || [])) {
    const addr = cleanAddress(thesis?.entity_address || thesis?.token_address || thesis?.address || thesis?.contract_address || "");
    if (addr) thesisByAddr.set(addr, thesis);
  }

  const watchlistByAddr = new Map();
  for (const watchlist of (data?.e3dWatchlist || [])) {
    const addr = cleanAddress(watchlist?.address || "");
    if (addr) watchlistByAddr.set(addr, watchlist);
  }

  const actionByAddr = new Map();
  for (const action of (data?.e3dActions || [])) {
    const addr = cleanAddress(action?.token_address || "");
    if (addr) actionByAddr.set(addr, action);
  }

  const candidateAddresses = new Set([
    ...tokenByAddr.keys(),
    ...candidateByAddr.keys(),
    ...thesisByAddr.keys(),
    ...watchlistByAddr.keys(),
    ...actionByAddr.keys(),
    ...storyMap.keys()
  ]);

  const entries = [];
  const packetErrors = [];
  for (const addr of candidateAddresses) {
    if (!addr || disqualifiedAddresses.has(addr) || heldAddresses.has(addr)) continue;
    if (data?.avoidAddresses?.has(addr)) continue;

    try {
      const tokenRow = tokenByAddr.get(addr) || null;
      const candidate = candidateByAddr.get(addr) || null;
      const thesis = thesisByAddr.get(addr) || null;
      const watchlist = watchlistByAddr.get(addr) || null;
      const action = actionByAddr.get(addr) || null;
      const stories = storyMap.get(addr) || [];
      const cg = data?.cgDetailMap?.get(addr) || null;

      const symbol = String(
        tokenRow?.symbol
        || cg?.symbol
        || thesis?.entity_symbol
        || thesis?.symbol
        || candidate?.entity_symbol
        || candidate?.symbol
        || watchlist?.label
        || ""
      ).trim().toUpperCase();
      if (!symbol || heldSymbols.has(symbol.toLowerCase())) continue;

      const marketData = {
        current_price: tokenRow?.price_usd ?? cg?.price_usd ?? thesis?.price_usd ?? null,
        change_24h_pct: tokenRow?.change_24h ?? cg?.change_24h_pct ?? null,
        change_30m_pct: tokenRow?.change_30m ?? null,
        volume_24h_usd: tokenRow?.volume_24h_usd ?? cg?.volume_24h_usd ?? null,
        market_cap_usd: tokenRow?.market_cap_usd ?? cg?.market_cap_usd ?? null,
        price_source: tokenRow?._cg_source ? "coingecko" : cg && !tokenRow ? "coingecko" : "e3d",
        price_timestamp: createdAt
      };
      const liquidityData = {
        liquidity_usd: tokenRow?.liquidity_usd ?? null,
        liquidity_source: "e3d",
        liquidity_timestamp: createdAt
      };
      const executionData = {
        ...estimateScoutExecutionData(liquidityData.liquidity_usd),
        quote_timestamp: createdAt
      };
      const flow = tokenRow ? {
        flow_signal: tokenRow.flow_signal ?? null,
        buy_sell_ratio_1h: tokenRow.buy_sell_ratio_1h ?? null,
        price_change_1h_pct: tokenRow.price_change_1h_pct ?? null,
        source: "dexscreener",
        timestamp: createdAt
      } : null;

      const evidence = [];
      if (candidate) {
        evidence.push({
          source_type: "story",
          source_ref: candidate?.id || candidate?.candidate_id || addr,
          label: "e3d_candidate_context",
          direction: "bullish",
          strength: Math.max(50, Math.min(95, Math.round(toNum(candidate?.convergence_score, 72)))),
          summary: [
            `E3D candidate`,
            candidate?.convergence_score != null ? `conv ${Math.round(toNum(candidate.convergence_score, 0))}` : null,
            Array.isArray(candidate?.story_types) && candidate.story_types.length ? `signals ${candidate.story_types.slice(0, 3).join("|")}` : null,
            String(candidate?.signal_summary || "").trim().slice(0, 70) || null
          ].filter(Boolean).join(", ").slice(0, 160)
        });
      }
      evidence.push(...stories);

      // Include Decision Layer action as structured evidence when present.
      if (action) {
        evidence.push({
          source_type: "decision_layer",
          source_ref: action.action_id || addr,
          label: "e3d_decision_layer_action",
          direction: action.expected_direction === "bearish" ? "risk" : "bullish",
          strength: Math.max(40, Math.min(95, Math.round((action.action_score ?? 0.5) * 100))),
          summary: [
            "E3D Decision Layer",
            action.action_type ? `type=${action.action_type}` : null,
            action.action_score != null ? `Q_A=${action.action_score.toFixed(3)}` : null,
            action.confidence != null ? `conf=${action.confidence.toFixed(2)}` : null,
            action.expected_direction ? `dir=${action.expected_direction}` : null,
            String(action.trigger_reason || "").slice(0, 70) || null
          ].filter(Boolean).join(", ").slice(0, 160)
        });
      }

      const sourceAgentHint = watchlist && !candidate && !thesis ? "user_watchlist" : "scout";
      const scoutInput = {
        created_at: createdAt,
        strategy_version: PAPER_ORDER_STRATEGY_VERSION,
        source_agent: sourceAgentHint,
        token: {
          symbol,
          name: tokenRow?.name || cg?.name || thesis?.entity_name || watchlist?.label || "",
          chain: "ethereum",
          contract_address: addr,
          category: "unknown"
        },
        evidence,
        market_data: marketData,
        liquidity_data: liquidityData,
        execution_data: executionData,
        flow,
        thesis: thesis ? {
          thesis_id: thesis?.id || thesis?.thesis_id || addr,
          conviction: thesis?.conviction ?? null,
          direction: thesis?.direction || "LONG",
          summary: thesis?.thesis || thesis?.thesis_text || thesis?.summary || null
        } : null,
        watchlist: watchlist ? {
          watchlist_id: watchlist?.id || watchlist?.watchlist_id || addr,
          label: watchlist?.label || symbol,
          added_at: watchlist?.added_at || null
        } : null,
        action: action ? {
          action_id:          action.action_id,
          action_type:        action.action_type,
          action_score:       action.action_score,
          confidence:         action.confidence,
          risk_score:         action.risk_score,
          expected_direction: action.expected_direction,
          expected_horizon:   action.expected_horizon,
          trigger_reason:     action.trigger_reason,
          n_supporting:       action.n_supporting,
        } : null
      };

      scoutInput.market_data_quality = buildMarketDataQuality(scoutInput, { evaluated_at: createdAt });
      scoutInput.token_risk_scan = buildCandidateTokenRiskScan(scoutInput, portfolio, {
        evaluated_at: createdAt,
        mode: "paper",
        side: "buy"
      });

      const packet = buildScoutEvidencePacket(scoutInput, { created_at: createdAt });
      const ranking = rankScoutPacket(packet, {
        e3d_candidate: candidate,
        thesis,
        watchlist,
        stories,
        market_data: marketData,
        liquidity_data: liquidityData,
        flow
      });
      const mapsRoute = buildScoutMapsRoute(symbol, _cycleMapsContext);
      const thesisSignalScoreBase = computeScoutThesisSignalScore(candidate, thesis, action);
      const mapsRouteScoreAdjustment = applyMapsRouteScoreAdjustment(thesisSignalScoreBase, mapsRoute, {
        closedRoutePenalty: MAPS_CLOSED_ROUTE_PENALTY,
        strengtheningRouteBonus: MAPS_STRENGTHENING_ROUTE_BONUS,
        minConfidenceThreshold: MAPS_MIN_CONFIDENCE_THRESHOLD
      });
      ranking.score += Number(mapsRouteScoreAdjustment.score_delta || 0);
      ranking.maps_route_score_adjustment = mapsRouteScoreAdjustment;
      ranking.maps_route = mapsRoute;

      entries.push({
        address: addr,
        symbol,
        scout_input: scoutInput,
        packet,
        ranking,
        source_agent_hint: sourceAgentHint,
        e3d_action_ref: action ? { action_id: action.action_id, action_type: action.action_type } : null,
        packet_summary: {
          evidence_packet_id: packet.evidence_packet_id,
          symbol,
          contract_address: addr,
          source_agent: sourceAgentHint,
          flow_only: ranking.eligibility.flow_only,
          quality_score: packet.quality_score,
          evidence_count: packet.evidence_count,
          market_evidence_count: packet.market_evidence_count,
          story_evidence_count: packet.story_evidence_count,
          candidate_score: candidate?.convergence_score ?? null,
          thesis_conviction: thesis?.conviction ?? null,
          thesis_signal_score: mapsRouteScoreAdjustment.adjusted_score,
          thesis_signal_score_base: mapsRouteScoreAdjustment.base_score,
          maps_route_score_adjustment: mapsRouteScoreAdjustment,
          maps_route: mapsRoute,
          market_data: marketData,
          liquidity_data: liquidityData,
          execution_data: executionData,
          evidence: packet.evidence.slice(0, 8).map((item) => ({
            evidence_id: item.evidence_id,
            source_type: item.source_type,
            label: item.label,
            direction: item.direction,
            strength: item.strength,
            summary: item.summary
          })),
          evidence_ids: packet.evidence.slice(0, 8).map((item) => item.evidence_id)
        }
      });
    } catch (err) {
      packetErrors.push({ address: addr, error: String(err?.message || err).slice(0, 200) });
    }
  }

  if (!entries.length && packetErrors.length) {
    const error = new Error("SCOUT_EVIDENCE_PACKET_BUILD_FAILED");
    error.packet_errors = packetErrors;
    throw error;
  }

  const sorted = [...entries].sort((a, b) =>
    (b.ranking.score - a.ranking.score)
    || (b.packet.quality_score - a.packet.quality_score)
    || String(a.symbol).localeCompare(String(b.symbol))
    || String(a.address).localeCompare(String(b.address))
  );

  const shortlist = [];
  const blocked = [];
  let flowOnlyCount = 0;

  for (const entry of sorted) {
    const eligibility = entry.ranking.eligibility;
    if (!eligibility.eligible) {
      blocked.push({
        symbol: entry.symbol,
        contract_address: entry.address,
        evidence_packet_id: entry.packet.evidence_packet_id,
        reasons: eligibility.reasons,
        hard_blockers: eligibility.hard_blockers
      });
      continue;
    }
    if (eligibility.flow_only) {
      if (flowOnlyCount >= SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT) {
        blocked.push({
          symbol: entry.symbol,
          contract_address: entry.address,
          evidence_packet_id: entry.packet.evidence_packet_id,
          reasons: ["flow_only_cap_exceeded"],
          hard_blockers: []
        });
        continue;
      }
      flowOnlyCount += 1;
    }
    shortlist.push(entry);
    if (shortlist.length >= shortlistLimit) break;
  }

  return {
    entries,
    shortlist,
    blocked,
    packet_errors: packetErrors,
    shortlist_limit: shortlistLimit
  };
}

function parseScoutJSON(rawText) {
  let jsonStr = rawText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const firstBrace = jsonStr.indexOf("{");
  if (firstBrace !== -1) {
    let depth = 0, end = -1;
    for (let i = firstBrace; i < jsonStr.length; i++) {
      if (jsonStr[i] === "{") depth++;
      else if (jsonStr[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    jsonStr = end !== -1 ? jsonStr.slice(firstBrace, end + 1) : jsonStr.slice(firstBrace);
  }
  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    try {
      const repaired = JSON.parse(repairTruncatedJson(jsonStr));
      log("scout_json_repaired", { raw_length: rawText.length });
      return repaired;
    } catch (_2) {
      throw new Error(`SCOUT_REPLY_NOT_JSON\n${rawText.slice(0, 500)}`);
    }
  }
}

function runScoutWithTools(portfolio, portfolioIntelligence = null) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  const heldAddresses = new Set(
    Object.values(portfolio?.positions || {}).map(p => cleanAddress(p?.contract_address || "")).filter(Boolean)
  );
  const heldSymbols = new Set(
    Object.values(portfolio?.positions || {}).map(p => String(p?.symbol || "").trim().toLowerCase()).filter(Boolean)
  );
  const scoutMaxCandidates = resolveScoutMaxCandidates(portfolio?.settings || SETTINGS_DEFAULTS);
  const macroContext = _cycleQuantContext?.macro;

  // ── Step 1: Node.js perception layer builds compact cognitive state ──
  // 3 targeted API calls → ranked candidates with evidence.
  // Qwen sees only what matters, not a firehose of raw data.
  const cognitiveState = buildCognitiveState(portfolio);
  const stateJson = JSON.stringify(cognitiveState, null, 0);

  // Short-circuit: no candidates in either the E3D feed or story signals means
  // the LLM has nothing to evaluate. Skip the inference call (saves ~2 min/cycle).
  if (cognitiveState.candidates.length === 0) {
    log("scout_tool_candidates", { raw: 0, after_held: 0, qualified: 0 });
    log("scout", {
      scan_timestamp: cognitiveState.generated_at, candidates: [], holdings_updates: [],
      stories_checked: [], evidence_diagnostics: {
        agent: "scout", input_candidate_count: 0, llm_batch_count: 0,
        prompt_chars: 0, total_tokens: null, llm_duration_ms: 0,
        candidates_returned: 0, candidates_qualified: 0
      }
    });
    return [];
  }

  // ── Step 2: Qwen reasons on the state, optionally drills down ──
  const systemPrompt = [
    "You are Scout, an elite crypto trading research agent for a quantitative hedge fund.",
    "You have been given a pre-computed cognitive state: the top-ranked candidates with their signals and market data.",
    "Return STRICT JSON only — one object, no markdown, no commentary.",
    "",
    "DECISION FLOW:",
    "1. Review the cognitive_state candidates in order of rank.",
    "2. For any candidate where drill_down is non-empty AND you need more evidence to decide, call the appropriate tool (max 3 tool calls total).",
    "   - e3d_get_token_info(address): get current price, liquidity, volume for a specific token",
    "   - e3d_get_transactions(address): check for whale moves or unusual activity",
    "   - e3d_get_stories(type=...): fetch a specific story type not yet in the state",
    "   Do NOT call e3d_get_candidates — your cognitive state was built from it already.",
    "3. Once satisfied, return your final candidate list. Do NOT call tools if the state already contains enough evidence.",
    "",
    "SIGNAL PRIORITY:",
    "1. source=e3d_candidate — highest conviction, already multi-signal correlated",
    "2. source=multi_signal — 2+ independent signals on same token",
    "3. THESIS conviction >= 65 — structured investment thesis",
    "4. source=single_signal — only if signal is strong (SMART_MONEY, ACCUMULATION) and market data is clean",
    `5. FLOW-ONLY (last resort): buy_sell_ratio_1h >= 3.5, liquidity > 150k, vol > 75k, mcap > 5M. Max ${SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT}.`,
    "",
    "",
    "SCORECARD: Each candidate in the cognitive state has a scorecard{} with composite_score (0–100) and decision (pass/watch/weak/fail).",
    "Prefer candidates with decision=pass or watch. You may propose weak candidates only with explicit justification.",
    "Reference the scorecard in your why_now field.",
    "",
    "QUALITY GATE — required for ALL proposals: price_usd > 0, liquidity_usd > 100000, market_cap_usd > 2000000, volume_24h_usd > 10000.",
    "SKIP: stablecoins, wrapped assets, change_7d_pct > 300% (already pumped), MOVER/SURGE alone.",
    `SKIP ALREADY HELD: symbols=${JSON.stringify([...heldSymbols])}, addresses=${JSON.stringify([...heldAddresses])}`,
    macroContext ? `MACRO: regime=${macroContext.regime} new_positions_ok=${macroContext.new_positions_ok} tighten_stops=${macroContext.tighten_stops}` +
      (macroContext.dxy ? ` dxy_24h=${macroContext.dxy.change_24h_pct}%` : "") +
      (macroContext.equity_index ? ` equity_24h=${macroContext.equity_index.change_24h_pct}%` : "") +
      (macroContext.regulatory ? ` regulatory=${macroContext.regulatory.stance}(${macroContext.regulatory.reason || "operator flag"})` : "")
      : "",
    _cycleMapsContext?.destinations?.length
      ? `MAPS DESTINATIONS: ${_cycleMapsContext.destinations
          .slice(0, 3)
          .map(d => `${d.destination}(conf=${(Number(d.confidence) || 0).toFixed(2)},${d.risk_level})`)
          .join(", ")}`
      : "",
    _cycleMapsContext?.congestion?.length
      ? `MAPS CONGESTION: ${_cycleMapsContext.congestion
          .slice(0, 2)
          .map(c => `${c.destination}(conf=${(Number(c.confidence) || 0).toFixed(2)})`)
          .join(", ")}`
      : "",
    _cycleMapsContext?.hazards?.length
      ? `MAPS HAZARDS: ${_cycleMapsContext.hazards
          .slice(0, 2)
          .map(h => `${h.origin}→${h.destination}(${h.risk_level})`)
          .join(", ")}`
      : "",
    _cycleMapsContext?.closures?.length
      ? `MAPS ROUTE CLOSURES: ${_cycleMapsContext.closures
          .map(c => `${c.origin}→${c.destination} CLOSED — ${c.recommended_action}`)
          .join("; ")}`
      : "",
    macroContext?.new_positions_ok === false ? "MACRO GATE: only TIER 1 setups with conviction >= 80." : "",
    "",
    `Return up to ${scoutMaxCandidates} candidates. Prefer 0 over weak candidates.`,
    `Output shape: {scan_timestamp, candidates[], holdings_updates:[], stories_checked[]}`,
    `Each candidate: {source_agent:"scout", created_at:"${createdAt}", expires_at:"${expiresAt}", token:{symbol,name,chain:"ethereum",contract_address,category}, setup_type, action:"buy", confidence:integer(0-100), conviction_score:integer(0-100), opportunity_score:integer(0-100), why_now, evidence:["string"], risks:[], entry_zone:{low,high}, invalidation_price, targets:{target_1,target_2,target_3}, market_data:{current_price,change_24h_pct,change_30m_pct,price_source:"e3d",volume_24h_usd,market_cap_usd}, liquidity_data:{liquidity_usd,liquidity_source:"e3d"}, execution_data:{estimated_slippage_bps,quote_source:"e3d"}, portfolio_data:{current_token_exposure_pct:0,current_category_exposure_pct:0,current_total_exposure_pct:0}}`,
    `evidence[] must contain 2-5 strings describing WHY this candidate qualifies (signal type, conviction, price action).`,
    `story_ids[]: copy the story_ids array exactly from the candidate's cognitive_state entry into your output for each candidate. These are the source story IDs that justify the pick.`,
    `stories_checked[]: list story types you examined — {type, found:bool, tokens:[]}. May be empty.`
  ].filter(Boolean).join("\n");

  const userMessage = [
    `Scout task — ${createdAt}`,
    `Portfolio: cash=$${portfolio?.cash_usd ?? 100000}, held=${Object.keys(portfolio?.positions || {}).length} positions`,
    `Max candidates: ${scoutMaxCandidates}`,
    ``,
    `COGNITIVE STATE (${cognitiveState.candidates.length} pre-ranked candidates, ${cognitiveState.meta.api_calls} API calls made):`,
    stateJson
  ].join("\n");

  const scoutLlmBatches = [];
  let rawText;
  try {
    rawText = callLLMWithTools(systemPrompt, userMessage, E3D_AGENT_TOOLS, executeE3DTool,
      { agent: "scout", maxRounds: DRILL_DOWN_MAX_ROUNDS });
    const meta = getLastLLMMeta("scout") || {};
    scoutLlmBatches.push({
      prompt_chars: systemPrompt.length + userMessage.length,
      prompt_tokens: meta.prompt_tokens, completion_tokens: meta.completion_tokens,
      total_tokens: meta.total_tokens, duration_ms: meta.duration_ms, tool_rounds: meta.tool_rounds
    });
  } catch (err) {
    const meta = getLastLLMMeta("scout") || {};
    scoutLlmBatches.push({
      prompt_chars: systemPrompt.length + userMessage.length,
      prompt_tokens: meta.prompt_tokens, completion_tokens: meta.completion_tokens,
      total_tokens: meta.total_tokens, duration_ms: meta.duration_ms
    });
    throw err;
  }

  const batchResult = parseScoutJSON(rawText);
  const rawCandidates = Array.isArray(batchResult?.candidates) ? batchResult.candidates : [];
  const unhelded = filterScoutCandidatesAgainstPortfolio(rawCandidates, portfolio);

  // Build a real-market lookup from cognitive state to override LLM-reported values in the
  // quality gate. The LLM sometimes hallucitates market data (e.g. identical $925 liquidity
  // for unrelated tokens). Cognitive state market data comes from the token universe API call
  // made by Node.js, so it is authoritative.
  const cogStateMarketByAddr = new Map();
  // Deterministic fraud_risk/liquidity_quality per candidate, keyed by address — see
  // buildCognitiveState's e3dCandidates loop. Scout's own output schema never asks the LLM
  // for these fields, so without this override they silently stay unset (0) all the way into
  // computePositionScoreLike's buy ranking and deterministicBuyGate's fraud_risk_high check.
  const cogStateRiskByAddr = new Map();
  for (const entry of (cognitiveState.candidates || [])) {
    const addr = cleanAddress(entry?.address || "");
    if (!addr) continue;
    if (entry?.market) cogStateMarketByAddr.set(addr, entry.market);
    if (entry?.fraud_risk != null || entry?.liquidity_quality != null) {
      cogStateRiskByAddr.set(addr, { fraud_risk: entry.fraud_risk ?? null, liquidity_quality: entry.liquidity_quality ?? null });
    }
  }

  const qualifiedCandidates = unhelded.filter(c => {
    const addr = cleanAddress(c?.token?.contract_address || "");
    if (!addr) { log("scout_tool_candidate_dropped", { reason: "no_address", symbol: c?.token?.symbol }); return false; }
    const real = cogStateMarketByAddr.get(addr) || {};
    const liq   = toNum(real.liquidity_usd, 0) || toNum(c?.liquidity_data?.liquidity_usd, 0);
    const mcap  = toNum(real.market_cap_usd, 0) || toNum(c?.market_data?.market_cap_usd, 0);
    const vol   = toNum(real.volume_24h_usd, 0) || toNum(c?.market_data?.volume_24h_usd, 0);
    const price = toNum(real.price_usd, 0) || toNum(c?.market_data?.current_price, 0);
    if (price <= 0 || liq < 100000 || mcap < 2000000 || vol < 10000) {
      log("scout_tool_candidate_dropped", { reason: "quality_gate_failed", symbol: c?.token?.symbol, addr, liq, mcap, vol, price, real_data_available: cogStateMarketByAddr.has(addr) });
      return false;
    }
    if (heldAddresses.has(addr)) { log("scout_tool_candidate_dropped", { reason: "already_held", addr }); return false; }
    return true;
  }).map(c => {
    const addr = cleanAddress(c?.token?.contract_address || "");
    const risk = cogStateRiskByAddr.get(addr);
    return risk ? { ...c, fraud_risk: risk.fraud_risk, liquidity_quality: risk.liquidity_quality } : c;
  });

  log("scout_tool_candidates", { raw: rawCandidates.length, after_held: unhelded.length, qualified: qualifiedCandidates.length });

  return {
    scan_timestamp: createdAt,
    candidates: qualifiedCandidates,
    holdings_updates: Array.isArray(batchResult?.holdings_updates) ? batchResult.holdings_updates : [],
    stories_checked: Array.isArray(batchResult?.stories_checked) ? batchResult.stories_checked : [],
    evidence_diagnostics: buildScoutEvidenceDiagnostics({
      input_candidate_count: cognitiveState.candidates.length,
      llm_batches: scoutLlmBatches,
      candidates: qualifiedCandidates,
      stories_checked: [],
      coverage: null
    })
  };
}

function runScoutDirect(portfolio, portfolioIntelligence = null) {
  if (TOOL_USE_ENABLED) return runScoutWithTools(portfolio, portfolioIntelligence);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const dossier = portfolioIntelligence || buildPortfolioIntelligenceDossier(portfolio);

  const heldAddresses = new Set(
    Object.values(portfolio?.positions || {})
      .map((p) => cleanAddress(p?.contract_address || "")).filter(Boolean)
  );
  const heldSymbols = new Set(
    Object.values(portfolio?.positions || {})
      .map((p) => String(p?.symbol || "").trim().toLowerCase()).filter(Boolean)
  );
  const scoutMaxCandidates = resolveScoutMaxCandidates(portfolio?.settings || SETTINGS_DEFAULTS);

  // Pre-fetch all E3D data
  const data = fetchScoutData();
  // Capture which story types the E3D API actually returned so coverage grading
  // only penalises the agent for types that existed in the data this cycle.
  _cycleAvailableStoryTypes = new Set(Object.keys(data.stories));

  // Expand token_flow to cover top-60 liquid tokens in the universe (not just held positions).
  // This lets Scout rank candidates by live order flow even when e3d.ai has no candidates/theses.
  // Two DexScreener batch calls (30 addrs each) — ~600ms total.
  if (_cycleQuantContext) {
    const topTokens = data.tokenUniverse
      .filter(t => t.address && (t.liquidity_usd ?? 0) > 5000)
      .slice(0, 60);
    _cycleQuantContext.token_flow = batchEnrichTokenFlow(topTokens, _cycleQuantContext.token_flow || {});
    log("scout_flow_enrichment", { flow_tokens_total: Object.keys(_cycleQuantContext.token_flow).length });
  }

  // Overlay DexScreener order-flow onto all universe tokens that now have flow data.
  if (_cycleQuantContext?.token_flow) {
    for (const t of data.tokenUniverse) {
      const addr = cleanAddress(t.address || "");
      const flow = addr ? _cycleQuantContext.token_flow[addr] : null;
      if (flow) {
        t.flow_signal         = flow.flow_signal;
        t.buy_sell_ratio_1h   = flow.buy_sell_ratio_1h;
        t.price_change_1h_pct = flow.price_change_1h_pct;
        if ((flow.price_usd ?? 0) > 0 && !(t.price_usd > 0)) t.price_usd = flow.price_usd;
      }
    }
  }

  // Build story-based price fallback: address → story meta with price data
  const storyPriceMap = new Map();
  for (const items of Object.values(data.stories)) {
    for (const s of (items || [])) {
      const addr = cleanAddress(s?.meta?.token_address || s?.primary_token || s?.address || "");
      if (!addr) continue;
      const existing = storyPriceMap.get(addr);
      const price = s?.meta?.entities?.current_price_usd ?? s?.meta?.current_price_usd ?? null;
      const mcap = s?.meta?.entities?.marketCapUSD ?? s?.meta?.marketCapUSD ?? null;
      const liq = s?.meta?.entities?.liquidityUSD ?? s?.meta?.liquidityUSD ?? s?.meta?.liquidity_usd ?? null;
      if (price != null && (!existing || (existing.price == null))) {
        storyPriceMap.set(addr, {
          price,
          mcap: mcap ?? (existing?.mcap ?? null),
          liq: liq ?? (existing?.liq ?? null),
          symbol: s?.meta?.token?.symbol || s?.meta?.token_symbol || ""
        });
      }
    }
  }

  // Build disqualified address set from stories tagged as disqualifiers
  const disqualifiedAddresses = new Set([...heldAddresses]);
  for (const [type, items] of Object.entries(data.stories)) {
    if (!data.disqualifierTypes.has(type)) continue;
    for (const s of (items || [])) {
      const addr = cleanAddress(s?.meta?.token_address || s?.primary_token || s?.token_address || s?.address || "");
      if (addr) disqualifiedAddresses.add(addr);
      if (type === "EXCHANGE_FLOW" && s?.meta?.direction !== "deposits") disqualifiedAddresses.delete(addr);
    }
  }

  // Bucket stories into signal categories
  const disqualifierStories = Object.entries(data.stories).filter(([t]) => data.disqualifierTypes.has(t));
  const buySignalStories = Object.entries(data.stories).filter(([t]) => data.buySignalTypes.has(t));
  const lateSignalStories = Object.entries(data.stories).filter(([t]) => data.lateSignalTypes.has(t));
  const secondaryStories = Object.entries(data.stories).filter(([t]) => data.secondaryTypes.has(t) || (!data.disqualifierTypes.has(t) && !data.buySignalTypes.has(t) && !data.lateSignalTypes.has(t)));

  // Collect addresses covered by any buy-signal story or thesis story.
  // Used below to gate momentum tokens — price move alone is not enough.
  const signalBackedAddresses = new Set();
  for (const [, items] of buySignalStories) {
    for (const s of (items || [])) {
      const a = cleanAddress(s?.meta?.primary?.address || s?.meta?.token_address || s?.meta?.token?.address || s?.primary_token || "");
      if (a) signalBackedAddresses.add(a);
    }
  }
  for (const s of (data.thesisSignalStories || [])) {
    const a = cleanAddress(s?.meta?.primary?.address || s?.meta?.token_address || s?.meta?.token?.address || s?.primary_token || "");
    if (a) signalBackedAddresses.add(a);
  }
  for (const c of (data.e3dCandidates || [])) {
    const a = cleanAddress(c?.entity_address || c?.token_address || c?.address || c?.contract_address || "");
    if (a) signalBackedAddresses.add(a);
  }

  // Tokens that are already moving (change_30m > 3%) AND have on-chain signal backing.
  // This is the "momentum confirmed by signal" pattern — price just started moving but
  // a pre-pump story already existed, so it is not a pure late entry.
  const momentumWithSignal = data.tokenUniverse
    .filter(t => t.address && !disqualifiedAddresses.has(t.address))
    .filter(t => signalBackedAddresses.has(t.address))
    .filter(t => (t.change_30m ?? 0) > 3)
    .sort((a, b) => (b.change_30m ?? 0) - (a.change_30m ?? 0))
    .slice(0, 15);

  // Build a fast address → token lookup from the universe so we can match story
  // subjects to tokens that actually have market data.
  const tokenByAddr = new Map(
    data.tokenUniverse
      .filter((t) => t.address && (t.price_usd > 0 || t.liquidity_usd > 0))
      .map((t) => [t.address, t])
  );

  const formatStory = (s) => {
    const storyAddr = cleanAddress(s?.meta?.primary?.address || s?.meta?.token_address || s?.meta?.token?.address || s?.primary_token || "");
    const storyTitle = s?.title || s?.subtitle || "";
    const hint = (s?.ai_narrative || s?.meta?.ai_narrative || s?.meta?.narrative_hint || s?.subtitle || "").slice(0, 180);
    const score = s?.score ?? null;
    // Check if this story subject is a tradeable token in our universe
    const tokenMatch = storyAddr ? tokenByAddr.get(storyAddr) : null;
    return JSON.stringify({
      story_subject_address: storyAddr,
      story_title: storyTitle.slice(0, 80),
      score,
      hint,
      in_token_universe: !!tokenMatch,
      token_symbol: tokenMatch?.symbol || null,
      price_usd: tokenMatch?.price_usd ?? null,
      volume_24h_usd: tokenMatch?.volume_24h_usd ?? null,
      change_30m: tokenMatch?.change_30m ?? null,
      change_24h: tokenMatch?.change_24h ?? null,
      liquidity_usd: tokenMatch?.liquidity_usd ?? null,
    });
  };

  try {
    const shortlistBuild = buildScoutEvidenceShortlist(data, portfolio, {
      createdAt,
      heldAddresses,
      heldSymbols,
      disqualifiedAddresses
    });
    log("scout_evidence_shortlist", {
      packets_built: shortlistBuild.entries.length,
      shortlist_count: shortlistBuild.shortlist.length,
      blocked_count: shortlistBuild.blocked.length,
      packet_errors: shortlistBuild.packet_errors.length,
      shortlist_limit: shortlistBuild.shortlist_limit
    });
    for (const blocked of shortlistBuild.blocked) {
      log("scout_shortlist_blocked", blocked);
    }
    for (const packetError of shortlistBuild.packet_errors) {
      log("scout_evidence_packet_error", packetError);
    }

    if (shortlistBuild.shortlist.length === 0) {
      refreshPositionPrices(portfolio, data.tokenUniverse);
      if (_cycleQuantContext?.token_flow) {
        for (const pos of Object.values(portfolio.positions)) {
          const addr = cleanAddress(pos.contract_address || "");
          const flow = addr ? _cycleQuantContext.token_flow[addr] : null;
          if ((flow?.price_usd ?? 0) > 0 && flow.price_usd !== pos.current_price) {
            applyPositionMark(pos, flow.price_usd, "dexscreener_flow", markDeviationLimit(portfolio));
          }
        }
      }

      return {
        scan_timestamp: new Date().toISOString(),
        candidates: [],
        holdings_updates: [],
        stories_checked: Object.entries(data.stories).map(([type, items]) => ({
          type,
          found: Array.isArray(items) && items.length > 0,
          tokens: Array.isArray(items)
            ? items.slice(0, 5).map((s) => s.token_address || s.address || "").filter(Boolean)
            : []
        })),
        token_universe: data.tokenUniverse.map((t) => ({
          symbol: t.symbol || null,
          address: t.address || null,
          price_usd: t.price_usd ?? null,
          volume_24h_usd: t.volume_24h_usd ?? null,
          liquidity_usd: t.liquidity_usd ?? null,
          market_cap_usd: t.market_cap_usd ?? null,
          change_24h: t.change_24h ?? null,
          flow_signal: t.flow_signal ?? null,
        })),
        evidence_diagnostics: {
          ...buildScoutEvidenceDiagnostics({
          input_candidate_count: shortlistBuild.entries.length,
          llm_batches: [],
          candidates: [],
          stories_checked: [],
          coverage: null
          }),
          evidence_qualified_candidates: 0,
          evidence_blocked_candidates: shortlistBuild.blocked.length,
          shortlist_candidate_reduction: shortlistBuild.entries.length,
          shortlist_candidate_reduction_pct: shortlistBuild.entries.length > 0 ? 1 : 0
        }
      };
    }

    const shortlistPackets = shortlistBuild.shortlist.map((entry, index) => ({
      rank: index + 1,
      ...entry.packet_summary
    }));
    const scoutMapsRoutePromptLines = buildScoutMapsRoutePromptLines(shortlistBuild.shortlist);
    const systemPrompt = [
      "You are Scout, a crypto trading research agent.",
      "You are given compact evidence packets that were already ranked and filtered deterministically.",
      "Return STRICT JSON only: one object, no markdown, no commentary.",
      "Use only supplied evidence packets, tokens, contract addresses, evidence_packet_id values, and evidence_id values.",
      "Do not invent evidence. Do not cite evidence from a different packet. Do not propose a token that is not in the packets.",
      ...scoutMapsRoutePromptLines,
      `Return up to ${scoutMaxCandidates} buy candidates. Prefer 0 candidates over a weak candidate.`,
      `Output shape: {scan_timestamp, candidates[], holdings_updates[], stories_checked[]}`,
      `Each candidate: {source_agent:"scout"|"user_watchlist", created_at:"${createdAt}", expires_at:"${expiresAt}", evidence_packet_id, token:{symbol,name,chain:"ethereum",contract_address,category}, setup_type, action:"buy", confidence:integer(0-100), conviction_score:integer(0-100), opportunity_score:integer(0-100), why_now, evidence:["evi_..."], risks[], entry_zone:{low,high}, invalidation_price, targets:{target_1,target_2,target_3}, market_data:{current_price,change_24h_pct,change_30m_pct,price_source,volume_24h_usd,market_cap_usd}, liquidity_data:{liquidity_usd,liquidity_source}, execution_data:{estimated_slippage_bps,quote_source}, portfolio_data:{current_token_exposure_pct:0,current_category_exposure_pct:0,current_total_exposure_pct:0}}`,
      "evidence[] must contain 3 to 5 evidence_id strings copied exactly from that candidate packet.",
      "stories_checked[] may be []. holdings_updates[] should normally be []."
    ].join("\n");
    const userMessage = [
      `Scout task — ${createdAt} [evidence shortlist]`,
      `Portfolio: cash=$${portfolio?.cash_usd ?? 100000} positions=${Object.keys(portfolio?.positions || {}).length}`,
      `Shortlist packets=${shortlistPackets.length} limit=${shortlistBuild.shortlist_limit}`,
      JSON.stringify({ scout_packets: shortlistPackets })
    ].join("\n");
    const promptChars = systemPrompt.length + userMessage.length;

    if (promptChars <= SCOUT_EVIDENCE_PACKET_SAFE_PROMPT_CHARS) {
      const scoutLlmBatches = [];
      let batchRaw = "";
      try {
        batchRaw = callLLMDirect(systemPrompt, userMessage, { agent: "scout" });
        const batchMeta = getLastLLMMeta("scout") || {};
        scoutLlmBatches.push({
          prompt_chars: promptChars,
          prompt_tokens: batchMeta.prompt_tokens,
          completion_tokens: batchMeta.completion_tokens,
          total_tokens: batchMeta.total_tokens,
          duration_ms: batchMeta.duration_ms
        });
      } catch (err) {
        const batchMeta = getLastLLMMeta("scout") || {};
        scoutLlmBatches.push({
          prompt_chars: promptChars,
          prompt_tokens: batchMeta.prompt_tokens,
          completion_tokens: batchMeta.completion_tokens,
          total_tokens: batchMeta.total_tokens,
          duration_ms: batchMeta.duration_ms
        });
        throw err;
      }

      const batchResult = parseScoutJSON(batchRaw);
      const shortlistMap = new Map(shortlistBuild.shortlist.map((entry) => [entry.address, entry]));
      const shortlistBySymbol = new Map();
      for (const entry of shortlistBuild.shortlist) {
        const sym = String(entry.symbol || "").trim().toLowerCase();
        if (!sym) continue;
        if (!shortlistBySymbol.has(sym)) shortlistBySymbol.set(sym, []);
        shortlistBySymbol.get(sym).push(entry);
      }
      const validatedCandidates = [];
      const seenCandidateAddresses = new Set();
      let addressRepairsInCycle = 0;
      for (const proposal of (Array.isArray(batchResult?.candidates) ? batchResult.candidates : [])) {
        const proposalAddr = cleanAddress(proposal?.token?.contract_address || "");
        const proposalSymbol = String(proposal?.token?.symbol || "").trim().toLowerCase();
        if (!proposalAddr) continue;

        let shortlistEntry = shortlistMap.get(proposalAddr) || null;
        let resolutionMethod = shortlistEntry ? "exact" : null;

        // LLM sometimes truncates/extends contract addresses. If the proposal addr
        // is a unique prefix (or extension) of a canonical shortlist addr, repair.
        if (!shortlistEntry && proposalAddr.length >= 12 && proposalAddr.length !== 42) {
          const prefixMatches = shortlistBuild.shortlist.filter((entry) =>
            entry.address.startsWith(proposalAddr) || proposalAddr.startsWith(entry.address)
          );
          if (prefixMatches.length === 1) {
            shortlistEntry = prefixMatches[0];
            resolutionMethod = "address_prefix";
          }
        }

        // Last resort: unambiguous symbol match.
        if (!shortlistEntry && proposalSymbol) {
          const symMatches = shortlistBySymbol.get(proposalSymbol) || [];
          if (symMatches.length === 1) {
            shortlistEntry = symMatches[0];
            resolutionMethod = "symbol";
          }
        }

        if (!shortlistEntry) {
          log("scout_candidate_downgraded", {
            reason: "candidate_not_in_evidence_shortlist",
            contract_address: proposalAddr,
            symbol: proposal?.token?.symbol || null
          });
          continue;
        }

        const addr = shortlistEntry.address;
        if (seenCandidateAddresses.has(addr)) continue;

        if (resolutionMethod !== "exact") {
          addressRepairsInCycle += 1;
          log("scout_candidate_address_repaired", {
            method: resolutionMethod,
            proposal_address: proposalAddr,
            canonical_address: addr,
            symbol: shortlistEntry.symbol
          });
        }
        const validEvidenceIds = new Set(shortlistEntry.packet_summary.evidence_ids);
        const validRefs = extractScoutEvidenceRefs(proposal).filter((ref) => validEvidenceIds.has(ref));
        const minEvidenceRefs = resolveScoutEvidenceRefMinimum(shortlistEntry);
        if (validRefs.length < minEvidenceRefs) {
          log("scout_candidate_downgraded", {
            reason: "too_few_valid_evidence_refs",
            contract_address: addr,
            symbol: shortlistEntry.symbol,
            evidence_packet_id: shortlistEntry.packet.evidence_packet_id,
            valid_ref_count: validRefs.length,
            min_required_refs: minEvidenceRefs
          });
          continue;
        }

        const mergedCandidate = {
          ...proposal,
          source_agent: shortlistEntry.source_agent_hint,
          created_at: createdAt,
          expires_at: expiresAt,
          evidence_packet_id: shortlistEntry.packet.evidence_packet_id,
          evidence: validRefs,
          evidence_ref_count: validRefs.length,
          evidence_quality_score: shortlistEntry.packet.quality_score,
          evidence_blockers: cleanEvidenceList(shortlistEntry.packet.blockers),
          evidence_warnings: cleanEvidenceList(shortlistEntry.packet.warnings),
          evidence_summary: buildCompactEvidenceSummary(shortlistEntry.packet, validRefs),
          token: {
            ...(proposal?.token || {}),
            symbol: shortlistEntry.scout_input.token.symbol,
            name: shortlistEntry.scout_input.token.name,
            chain: shortlistEntry.scout_input.token.chain || "ethereum",
            contract_address: addr,
            category: shortlistEntry.scout_input.token.category || "unknown"
          },
          market_data: {
            ...(shortlistEntry.scout_input.market_data || {}),
            ...(proposal?.market_data || {})
          },
          liquidity_data: {
            ...(shortlistEntry.scout_input.liquidity_data || {}),
            ...(proposal?.liquidity_data || {})
          },
          execution_data: {
            ...(shortlistEntry.scout_input.execution_data || {}),
            ...(proposal?.execution_data || {})
          },
          market_data_quality: deepClone(shortlistEntry.scout_input.market_data_quality),
          market_data_quality_id: shortlistEntry.scout_input.market_data_quality?.data_quality_id || null,
          market_data_quality_ref: buildMarketDataQualityRef(shortlistEntry.scout_input.market_data_quality, { context: "scout_shortlist" }),
          token_risk_scan: deepClone(shortlistEntry.scout_input.token_risk_scan),
          token_risk_scan_id: shortlistEntry.scout_input.token_risk_scan?.token_risk_scan_id || null,
          token_risk_scan_ref: buildTokenRiskScanRef(shortlistEntry.scout_input.token_risk_scan, { context: "scout_shortlist" }),
          maps_route: shortlistEntry.packet_summary.maps_route || null,
          maps_route_score_adjustment: shortlistEntry.packet_summary.maps_route_score_adjustment || null,
          portfolio_data: proposal?.portfolio_data && typeof proposal.portfolio_data === "object"
            ? proposal.portfolio_data
            : { current_token_exposure_pct: 0, current_category_exposure_pct: 0, current_total_exposure_pct: 0 }
        };
        if (shortlistEntry.e3d_action_ref?.action_id) {
          mergedCandidate.e3d_action_id   = shortlistEntry.e3d_action_ref.action_id;
          mergedCandidate.e3d_action_type = shortlistEntry.e3d_action_ref.action_type;
        }
        seenCandidateAddresses.add(addr);
        validatedCandidates.push(mergedCandidate);
      }

      validatedCandidates.sort((a, b) => (b.conviction_score ?? 0) - (a.conviction_score ?? 0));
      const result = {
        scan_timestamp: new Date().toISOString(),
        candidates: validatedCandidates.slice(0, scoutMaxCandidates),
        holdings_updates: Array.isArray(batchResult?.holdings_updates) ? batchResult.holdings_updates : [],
        stories_checked: Array.isArray(batchResult?.stories_checked) ? batchResult.stories_checked : []
      };

      const now = new Date().toISOString();
      for (const candidate of result.candidates || []) {
        const addr = cleanAddress(candidate?.token?.contract_address || "");
        if (!addr) continue;

        let tokenRow = null;
        try {
          const rows = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
            dataSource: 1, search: addr, limit: 1
          }));
          tokenRow = rows.find((row) => cleanAddress(row.address || "") === addr) || rows[0] || null;
        } catch (_) {}

        const storyPrice = storyPriceMap.get(addr);
        if (tokenRow || storyPrice) {
          if (!candidate.token.name && tokenRow?.name) candidate.token.name = tokenRow.name;
          if (!candidate.token.name && storyPrice?.symbol) candidate.token.name = storyPrice.symbol;
          const price = tokenRow?.priceUSD ?? tokenRow?.price_usd ?? storyPrice?.price ?? candidate.market_data?.current_price ?? 0;
          const liq = tokenRow?.effectiveLiquidityUSD || tokenRow?.liquidityUSD || tokenRow?.liquidity_usd || storyPrice?.liq || candidate.liquidity_data?.liquidity_usd || 0;
          const mcap = tokenRow?.marketCapUSD ?? tokenRow?.market_cap_usd ?? storyPrice?.mcap ?? candidate.market_data?.market_cap_usd ?? 0;
          const vol24 = tokenRow?.volume24hUSD ?? tokenRow?.volume_24h_usd ?? candidate.market_data?.volume_24h_usd ?? 0;
          const chg30m = tokenRow?.changes?.["30M"]?.percent ?? candidate.market_data?.change_30m_pct ?? 0;
          const chg24h = tokenRow?.changes?.["24H"]?.percent ?? candidate.market_data?.change_24h_pct ?? 0;
          candidate.market_data = {
            ...candidate.market_data,
            current_price: price,
            change_24h_pct: chg24h,
            change_30m_pct: chg30m,
            price_timestamp: now,
            price_source: "e3d",
            volume_24h_usd: vol24,
            market_cap_usd: mcap
          };
          candidate.liquidity_data = {
            ...candidate.liquidity_data,
            liquidity_usd: liq,
            liquidity_timestamp: now,
            liquidity_source: "e3d"
          };
          candidate.execution_data = {
            ...candidate.execution_data,
            estimated_slippage_bps: estimateScoutExecutionData(liq).estimated_slippage_bps,
            quote_source: "e3d"
          };
          if (tokenRow?.fragilityScore != null) candidate._fragility_score = tokenRow.fragilityScore;
        }
      }

      if (!Array.isArray(result.stories_checked)) result.stories_checked = [];
      const reportedTypes = new Set(result.stories_checked.map((story) => String(story?.type || "").toUpperCase()));
      for (const [type, items] of Object.entries(data.stories)) {
        if (reportedTypes.has(type.toUpperCase())) continue;
        result.stories_checked.push({
          type,
          found: Array.isArray(items) && items.length > 0,
          tokens: Array.isArray(items)
            ? items.slice(0, 5).map((s) => s.token_address || s.address || "").filter(Boolean)
            : []
        });
      }

      result.candidates = (result.candidates || []).filter((candidate) => {
        const change7d = candidate?._coingecko?.change_7d_pct;
        if (change7d != null && change7d > 300) {
          log("scout_pump_filter", { symbol: candidate.token?.symbol, change_7d_pct: change7d });
          return false;
        }
        return true;
      });

      refreshPositionPrices(portfolio, data.tokenUniverse);
      if (_cycleQuantContext?.token_flow) {
        for (const pos of Object.values(portfolio.positions)) {
          const addr = cleanAddress(pos.contract_address || "");
          const flow = addr ? _cycleQuantContext.token_flow[addr] : null;
          if ((flow?.price_usd ?? 0) > 0 && flow.price_usd !== pos.current_price) {
            applyPositionMark(pos, flow.price_usd, "dexscreener_flow", markDeviationLimit(portfolio));
          }
        }
      }

      result.token_universe = data.tokenUniverse.map((t) => ({
        symbol: t.symbol || null,
        address: t.address || null,
        price_usd: t.price_usd ?? null,
        volume_24h_usd: t.volume_24h_usd ?? null,
        liquidity_usd: t.liquidity_usd ?? null,
        market_cap_usd: t.market_cap_usd ?? null,
        change_24h: t.change_24h ?? null,
        flow_signal: t.flow_signal ?? null,
      }));
      result.evidence_diagnostics = buildScoutEvidenceDiagnostics({
        input_candidate_count: shortlistBuild.entries.length,
        llm_batches: scoutLlmBatches,
        address_repairs_in_cycle: addressRepairsInCycle,
        candidates: result.candidates,
        stories_checked: result.stories_checked,
        coverage: null
      });
      result.evidence_diagnostics.evidence_qualified_candidates = shortlistBuild.shortlist.length;
      result.evidence_diagnostics.evidence_blocked_candidates = shortlistBuild.blocked.length;
      result.evidence_diagnostics.shortlist_candidate_reduction = Math.max(0, shortlistBuild.entries.length - shortlistBuild.shortlist.length);
      result.evidence_diagnostics.shortlist_candidate_reduction_pct = shortlistBuild.entries.length > 0
        ? Number((Math.max(0, shortlistBuild.entries.length - shortlistBuild.shortlist.length) / shortlistBuild.entries.length).toFixed(4))
        : 0;
      return result;
    }
  } catch (err) {
    log("scout_evidence_shortlist_fallback", {
      error: String(err?.message || err).slice(0, 200),
      packet_errors: Array.isArray(err?.packet_errors) ? err.packet_errors.slice(0, 10) : []
    });
  }

  const systemPrompt = [
    "You are Scout, an elite crypto trading research agent for a quantitative hedge fund.",
    "You have been given pre-fetched E3D market intelligence data. Return STRICT JSON only — one object, no markdown, no commentary.",
    "",
    "SIGNAL PRIORITY — work down this list and stop when you find qualified candidates:",
    "1. E3D AGENT CANDIDATES — pre-computed multi-story convergence. The E3D system has already correlated signals across time. These are the highest-quality setups; always prioritize them.",
    "2. E3D THESES — structured investment theses with direction, conviction, and price targets. A LONG thesis with conviction >= 65 is a strong buy signal. If in_token_universe=false but conviction >= 65, STILL propose it — use the thesis price data and note 'thesis-driven entry' in why_now. Set price_source to 'thesis'.",
    "3. USER WATCHLIST — tokens the authenticated user is personally monitoring. Check whether any watchlist token has supporting story signals or thesis coverage in the data provided. If so, apply the same quality gates and propose it as a candidate. Tag these with source_agent:'user_watchlist'. Do NOT propose a watchlist token that has no supporting signal unless it independently meets FLOW-ONLY criteria.",
    "4. THESIS STORIES — THESIS-type on-chain stories with in_token_universe=true.",
    "5. BUY SIGNAL STORIES — ACCUMULATION, SMART_MONEY, BREAKOUT_CONFIRMED stories with in_token_universe=true.",
    "6. FLOW-ONLY — absolute last resort only when ALL above are empty. See FLOW-ONLY ENTRY rules. Prefer 0 candidates over a weak flow pick.",
    "",
    "SIGNAL TIMING — this is how you catch moves early instead of late:",
    "- PRE-PUMP (your alpha window — buy here): STAGING, CLUSTER, FUNNEL, NEW_WALLETS, ACCUMULATION, SMART_MONEY, SMART_MONEY_LEADER, STEALTH_ACCUMULATION, DEEP_DIVE, THESIS. These fire BEFORE price moves. A STAGING or CLUSTER story with flat price is your best entry. SMART_MONEY_LEADER means tracked profitable wallets are accumulating together — check cohort_quality_score (≥75 = high conviction) and late_crowding (true = weakened signal).",
    "- BREAKOUT (early-mid entry, still valid): BREAKOUT_CONFIRMED, FLOW, HOTLINKS — price is moving but momentum is fresh. On BREAKOUT_CONFIRMED check participation_type: broad = organic demand confirmed; thin-liquidity = likely pump, skip.",
    "- POST-PUMP (already happened — do NOT buy as a new entry): MOVER, SURGE — the move is over. These appear in LATE SIGNALS section. Exception: SURGE with participation_type=broad and vol/TVL ≥ 0.1 is an early momentum signal, not late — treat it like BREAKOUT_CONFIRMED in that case.",
    "- PUMP EXHAUSTION (exit signal when you already hold): If you held a token and now see MOVER + declining price, that is the dump phase. Harvest should exit, not hold.",
    "- DISQUALIFIERS: TREASURY_DISTRIBUTION means a team/foundation wallet is moving tokens to an exchange — immediate sell pressure, do NOT propose. SECURITY_RISK with is_honeypot=true means the token cannot be sold — never propose.",
    "",
    "WHERE ALPHA COMES FROM:",
    "- THESIS-BACKED ENTRY: An E3D thesis with conviction >= 65 has already done multi-source research — trust it, build an entry plan.",
    "- EARLY ACCUMULATION: STAGING/CLUSTER/FUNNEL/NEW_WALLETS on a token where change_24h < 10% and price is flat. This is the setup before the move.",
    "- MULTI-SIGNAL CONVERGENCE: Token in 2+ early story types simultaneously (e.g. STAGING + ACCUMULATION, or CLUSTER + FUNNEL). Strongest possible entry.",
    "- MOMENTUM TOKENS: The TOP MOMENTUM TOKENS section lists all tokens with change_30m > 3%. Check signal_types on each — if populated, a pre-existing story confirmed the move (BREAKOUT-phase, higher conviction). If signal_types is empty, it is a price-only move with no story backing (lower conviction, apply stricter quality gates). Do NOT confuse with MOVER/SURGE late signals — those are in the LATE SIGNALS section and represent exhausted moves.",
    "- DISQUALIFY post-pump entries: change_7d_pct > 300% = already pumped. Do NOT propose. change_7d_pct > 100% on a MOVER story = late entry, skip.",
    "- WARNING: A MOVER or SURGE story alone is NEVER a buy signal. It may be useful to confirm a thesis-backed position you already hold is working, but it is not an entry trigger.",
    "",
    "QUANT SIGNAL TIERS:",
    "TIER 1 (full size, highest conviction): E3D candidate or thesis (conviction >= 65) + flow_signal=accumulation or strong_accumulation + funding=neutral or squeeze_potential.",
    "TIER 2 (standard size): Story signal (ACCUMULATION/SMART_MONEY/SMART_MONEY_LEADER/THESIS/BREAKOUT_CONFIRMED) with in_token_universe=true + liquidity_usd > 200000 + volume_24h_usd > 50000.",
    "TIER 3 (small size, max 1 per cycle): Signal-backed setup (story or thesis) with good conviction but below TIER 2 liquidity/volume thresholds. NEVER use TIER 3 for pure flow-only entries.",
    `FLOW-ONLY ENTRY (only when E3D AGENT CANDIDATES shows 'none currently' AND E3D THESES shows 'none currently' AND zero buy-signal stories have in_token_universe=true): require ALL of — buy_sell_ratio_1h >= 3.5, liquidity_usd > 150000, volume_24h_usd > 75000, market_cap_usd > 5000000. Maximum ${SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT} candidate${SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT === 1 ? "" : "s"}. If any threshold is not met, return 0 candidates — do NOT force an entry.`,
    "SKIP: flow_signal=distribution or strong_distribution. funding_signal=overcrowded_long. market_cap_usd < 2000000 (cannot size or exit safely). price_usd = 0 or volume_24h_usd = 0.",
    "MACRO GATE: If new_positions_ok=false, only propose TIER 1 setups with conviction >= 80.",
    "",
    "CRITICAL RULES:",
    "1. Quality gate — required for ALL proposals: price_usd > 0, liquidity_usd > 100000, market_cap_usd > 2000000, volume_24h_usd > 10000. No exceptions. Low-liquidity micro-caps cannot be sized or exited safely.",
    "2. NEVER propose stablecoins, gold tokens, or wrapped/base assets (already filtered from TOKEN UNIVERSE).",
    "3. Stories show ON-CHAIN SIGNALS. A story's subject may be a wallet, LP, or contract — only use as a candidate if in_token_universe=true AND quality gate is met.",
    "4. THESIS EXCEPTION: If a thesis has direction=LONG and conviction >= 65, propose it even when in_token_universe=false, provided the thesis includes a price. Quality gate still applies to whatever market data is available.",
    `5. Return up to ${scoutMaxCandidates} candidates. 1 strong candidate is better than ${scoutMaxCandidates} weak ones. Returning 0 candidates is correct when nothing genuinely meets the bar — the pipeline will survive a skipped cycle; a bad entry will not.`,
    "6. Exclude addresses in DISQUALIFIERS and already-held: " + `symbols=${JSON.stringify([...heldSymbols])} addresses=${JSON.stringify([...heldAddresses])}`,
    "",
    `Output shape: {scan_timestamp, candidates[], holdings_updates[], stories_checked[]}`,
    `Each candidate: {source_agent:"scout"|"user_watchlist", created_at:"${createdAt}", expires_at:"${expiresAt}", token:{symbol,name,chain:"ethereum",contract_address,category}, setup_type, action:"buy", confidence:integer(0-100), conviction_score:integer(0-100), opportunity_score:integer(0-100), why_now, evidence[], risks[], entry_zone:{low,high}, invalidation_price, targets:{target_1,target_2,target_3}, market_data:{current_price,change_24h_pct,change_30m_pct,price_source:"e3d",market_cap_usd}, liquidity_data:{liquidity_usd,liquidity_source:"e3d"}, execution_data:{estimated_slippage_bps,quote_source:"e3d"}, portfolio_data:{current_token_exposure_pct:0,current_category_exposure_pct:0,current_total_exposure_pct:0}}`,
    `confidence/conviction_score/opportunity_score MUST be integers 0-100. Do NOT use decimals (0.9) or strings ("high"). Example: confidence:72, conviction_score:65.`,
    `Use source_agent:"scout" for agent-discovered candidates (E3D candidates, theses, stories, flow). Use source_agent:"user_watchlist" only for candidates sourced from the USER WATCHLIST section.`,
    `stories_checked[]: one entry per EVERY story type present in the ON-CHAIN SIGNALS section — {type, found, tokens[]}. List ALL types, even ones with in_token_universe=false (set found=false, tokens=[]). Do NOT invent story types not in the data.`
  ].join("\n");

  const allStoryTypes = Object.keys(data.stories);

  const formatCandidate = (c) => {
    const addr = cleanAddress(c?.entity_address || c?.token_address || c?.address || c?.contract_address || "");
    const tokenMatch = addr ? tokenByAddr.get(addr) : null;
    return JSON.stringify({
      address: addr,
      symbol: tokenMatch?.symbol || c?.entity_symbol || c?.symbol || null,
      convergence_score: c?.convergence_score ?? null,
      signal_count: c?.signal_count ?? null,
      story_types: c?.story_types || null,
      direction_hint: c?.direction_hint || null,
      signal_summary: (c?.signal_summary || "").slice(0, 200),
      thesis_conviction: c?.thesis_conviction ?? null,
      fraud_risk: c?.fraud_risk ?? null,
      liquidity_quality: c?.liquidity_quality ?? null,
      in_token_universe: !!tokenMatch,
      price_usd: tokenMatch?.price_usd ?? null,
      volume_24h_usd: tokenMatch?.volume_24h_usd ?? null,
      liquidity_usd: tokenMatch?.liquidity_usd ?? null,
    });
  };

  const watchlistAddresses = new Set(
    (data.e3dWatchlist || []).map(w => cleanAddress(w?.address || "")).filter(Boolean)
  );
  const momentumAddresses = new Map(
    momentumWithSignal.map(t => [t.address, t.change_30m])
  );
  // address → thesis conviction for watchlist cross-reference
  const thesisByAddress = new Map();
  for (const t of (data.e3dTheses || [])) {
    const a = cleanAddress(t?.entity_address || t?.token_address || t?.address || t?.contract_address || "");
    if (a) thesisByAddress.set(a, t?.conviction ?? null);
  }
  // address → E3D candidate convergence_score for watchlist cross-reference
  const candidateByAddress = new Map();
  for (const c of (data.e3dCandidates || [])) {
    const a = cleanAddress(c?.entity_address || c?.token_address || c?.address || c?.contract_address || "");
    if (a) candidateByAddress.set(a, c?.convergence_score ?? null);
  }

  const formatWatchlistItem = (w) => {
    const addr = cleanAddress(w?.address || "");
    const tokenMatch = addr ? tokenByAddr.get(addr) : null;
    const momentumChange30m = momentumAddresses.get(addr) ?? null;
    const thesisConviction = thesisByAddress.get(addr) ?? null;
    const candidateScore = candidateByAddress.get(addr) ?? null;
    const vol = tokenMatch?.volume_24h_usd ?? null;
    const mcap = tokenMatch?.market_cap_usd ?? null;
    return JSON.stringify({
      address: addr,
      label: w?.label || null,
      chain: w?.chain || null,
      added_at: w?.added_at || null,
      in_token_universe: !!tokenMatch,
      price_usd: tokenMatch?.price_usd ?? null,
      volume_24h_usd: vol,
      liquidity_usd: tokenMatch?.liquidity_usd ?? null,
      market_cap_usd: mcap,
      change_24h: tokenMatch?.change_24h ?? null,
      change_30m: momentumChange30m,
      in_top_momentum: momentumChange30m !== null,
      flow_signal: tokenMatch?.flow_signal ?? null,
      buy_sell_ratio_1h: tokenMatch?.buy_sell_ratio_1h ?? null,
      story_count_1h: tokenMatch?.story_count_1h ?? null,
      is_e3d_candidate: candidateScore !== null,
      e3d_convergence_score: candidateScore,
      thesis_conviction: thesisConviction,
      is_disqualified: disqualifiedAddresses.has(addr),
    });
  };

  const formatMomentumToken = (t) => {
    const coveringTypes = buySignalStories
      .filter(([, items]) => items.some(s => cleanAddress(s?.meta?.primary?.address || s?.meta?.token_address || s?.meta?.token?.address || s?.primary_token || "") === t.address))
      .map(([type]) => type);
    if ((data.thesisSignalStories || []).some(s => cleanAddress(s?.meta?.primary?.address || s?.meta?.token_address || s?.meta?.token?.address || s?.primary_token || "") === t.address))
      coveringTypes.push("THESIS");
    const candidateScore = candidateByAddress.get(t.address) ?? null;
    const vol = t.volume_24h_usd ?? null;
    const mcap = t.market_cap_usd ?? null;
    return JSON.stringify({
      address: t.address, symbol: t.symbol,
      change_30m: t.change_30m, change_24h: t.change_24h,
      price_usd: t.price_usd, liquidity_usd: t.liquidity_usd,
      volume_24h_usd: vol, market_cap_usd: mcap,
      vol_mcap_ratio: vol && mcap ? Math.round((vol / mcap) * 1000) / 1000 : null,
      flow_signal: t.flow_signal ?? null,
      buy_sell_ratio_1h: t.buy_sell_ratio_1h ?? null,
      story_count_1h: t.story_count_1h ?? null,
      signal_types: coveringTypes,
      is_e3d_candidate: candidateScore !== null,
      e3d_convergence_score: candidateScore,
      in_watchlist: watchlistAddresses.has(t.address),
    });
  };

  const formatThesis = (t) => {
    const addr = cleanAddress(t?.entity_address || t?.token_address || t?.address || t?.contract_address || "");
    const tokenMatch = addr ? tokenByAddr.get(addr) : null;
    const cg = addr ? data.cgDetailMap?.get(addr) : null;
    return JSON.stringify({
      address: addr,
      symbol: tokenMatch?.symbol || cg?.symbol || t?.entity_symbol || t?.symbol || null,
      direction: t?.direction || null,
      conviction: t?.conviction ?? null,
      thesis_text: (t?.thesis || t?.thesis_text || t?.summary || "").slice(0, 200),
      target_1: t?.target_1 ?? null,
      target_2: t?.target_2 ?? null,
      invalidation_price: t?.invalidation_price ?? null,
      fraud_risk: t?.fraud_risk ?? null,
      liquidity_quality: t?.liquidity_quality ?? null,
      in_token_universe: !!tokenMatch || (cg != null),
      price_usd: tokenMatch?.price_usd ?? cg?.price_usd ?? null,
      // CoinGecko enrichment
      cg_rank: cg?.market_cap_rank ?? null,
      cg_change_7d_pct: cg?.change_7d_pct ?? null,
      cg_ath_change_pct: cg?.ath_change_pct ?? null,
      cg_sentiment_up_pct: cg?.sentiment_up_pct ?? null,
      cg_categories: cg?.categories ?? null,
      cg_description: cg?.description?.slice(0, 200) ?? null,
      cg_scores: cg ? { overall: cg.coingecko_score, developer: cg.developer_score, liquidity: cg.liquidity_score } : null,
    });
  };

  // Build macro regime block from quant context
  const quantMacro = _cycleQuantContext?.macro ?? null;
  const macroLines = quantMacro ? [
    `\n--- MACRO REGIME (live quant data) ---`,
    `regime=${quantMacro.regime}  new_positions_ok=${quantMacro.new_positions_ok}  tighten_stops=${quantMacro.tighten_stops}`,
    quantMacro.btc ? `BTC: $${quantMacro.btc.price.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${quantMacro.btc.change_24h_pct > 0 ? "+" : ""}${quantMacro.btc.change_24h_pct}% 24h)` : "",
    quantMacro.fear_greed ? `Fear&Greed: ${quantMacro.fear_greed.value}/100 — ${quantMacro.fear_greed.label}` : "",
    !quantMacro.new_positions_ok ? "⚠ MACRO GATE: new_positions_ok=false — only propose TIER 1 setups with conviction >= 0.75" : "",
    quantMacro.tighten_stops ? "⚠ TIGHTEN STOPS: high greed or BTC pullback — size down, tighten invalidation levels" : "",
  ].filter(Boolean) : [];
  const policyLines = _cycleRegimePolicy ? [
    `\n--- REGIME SENTINEL POLICY ---`,
    `regime=${_cycleRegimePolicy.regime} allow_new_buys=${_cycleRegimePolicy.allow_new_buys} max_buys_per_cycle=${_cycleRegimePolicy.max_buys_per_cycle} allow_rotations=${_cycleRegimePolicy.allow_rotations} allocation_multiplier=${_cycleRegimePolicy.allocation_multiplier}`,
    `reason_codes=${(_cycleRegimePolicy.reason_codes || []).join(", ")}`,
    !_cycleRegimePolicy.allow_new_buys
      ? "Policy blocks speculative new buys unless a deterministic later gate explicitly allows them."
      : _cycleRegimePolicy.reason_codes?.includes("new_buys_throttled_by_recent_losses")
        ? "Policy is in loss-throttle mode: propose at most one high-conviction, fully evidenced probe-sized buy."
        : ""
  ].filter(Boolean) : [];

  // Build funding rate warning for Scout (overcrowded longs to avoid)
  const overcrowdedSymbols = Object.entries(_cycleQuantContext?.funding_rates || {})
    .filter(([, f]) => f.signal === "overcrowded_long")
    .map(([sym]) => sym);
  const fundingLines = overcrowdedSymbols.length ? [
    `\n--- FUNDING RATE WARNINGS ---`,
    `Overcrowded longs (avoid new entries): ${overcrowdedSymbols.join(", ")}`,
  ] : [];
  const signalLines = _cycleSignalSnapshot?.signals?.length ? [
    `\n--- SIGNAL CURATOR SNAPSHOT ---`,
    JSON.stringify(_cycleSignalSnapshot.signals.slice(0, 8).map((item) => ({
      symbol: item.symbol,
      contract_address: item.contract_address,
      signals: item.signals,
      positive_reasons: item.positive_reasons,
      negative_reasons: item.negative_reasons,
      missing_sources: item.missing_sources
    })))
  ] : [];
  const arbitrageLines = _cycleArbitrageSignals?.length ? [
    `\n--- ARBITRAGE WATCHER (watch-only, never execute directly) ---`,
    JSON.stringify(_cycleArbitrageSignals.slice(0, 8))
  ] : [];

  // Split user message into fixed before/after the candidates section so we can
  // batch candidates across multiple LLM calls without OOMing the GPU.
  const partsBefore = [
    `Scout task — ${createdAt} [token universe sorted by: ${data.sortLabel}]`,
    `Portfolio: cash=$${portfolio?.cash_usd ?? 100000} positions=${Object.keys(portfolio?.positions || {}).length}`,
    ...macroLines,
    ...policyLines,
    ...fundingLines,
    ...signalLines,
    ...arbitrageLines,
    `Token universe: ${data.tokenUniverse.length} tradeable tokens (stablecoins/wrapped assets excluded), ${data.tokenUniverse.filter(t => (t.liquidity_usd||0) > 100000).length} with liq>$100k, ${data.tokenUniverse.filter(t => (t.market_cap_usd||0) > 2000000).length} with mcap>$2M`,
    `Story types in data (you must report all of these in stories_checked): ${allStoryTypes.join(", ")}`,
    `\n--- E3D AGENT CANDIDATES (primary signal — multi-story convergence, use these first) ---`,
  ];

  const partsAfter = [
    `\n--- E3D THESES (structured investment theses — direction + conviction + price targets) ---`,
    data.e3dTheses.filter(t => /^long$/i.test(t?.direction || "")).length
      ? data.e3dTheses.filter(t => /^long$/i.test(t?.direction || "")).slice(0, 8).map(formatThesis).join("\n")
      : "none currently",
    `\n--- USER WATCHLIST (tokens the user is personally monitoring — if signals support entry, propose with source_agent:"user_watchlist") ---`,
    data.e3dWatchlist.length ? data.e3dWatchlist.map(formatWatchlistItem).join("\n") : "none currently",
    ...(data.cgDetailMap?.size ? [
      `\n--- COINGECKO RESEARCH (independent market data for thesis + top flow tokens) ---`,
      ...[...data.cgDetailMap.entries()].map(([addr, cg]) => JSON.stringify({
        address: addr, symbol: cg.symbol, rank: cg.market_cap_rank,
        change_7d_pct: cg.change_7d_pct, change_30d_pct: cg.change_30d_pct,
        ath_change_pct: cg.ath_change_pct, sentiment_up_pct: cg.sentiment_up_pct,
        categories: cg.categories, description: cg.description?.slice(0, 200),
        scores: { overall: cg.coingecko_score, developer: cg.developer_score, community: cg.community_score, liquidity: cg.liquidity_score },
      })),
    ] : []),
    `\n--- DISQUALIFIERS (exclude these addresses) ---`,
    ...disqualifierStories.map(([type, items]) => {
      const addrs = items.map((s) => cleanAddress(s?.meta?.token?.address || s?.primary_token || "")).filter(Boolean);
      return `${type}: ${addrs.slice(0, 5).join(", ") || "none"}`;
    }),
    disqualifierStories.length === 0 ? "none" : "",
    `\n--- TOP MOMENTUM TOKENS (all gainers with change_30m > 3%, sorted by 30m gain — use signal_types and is_e3d_candidate to weight conviction) ---`,
    `All tokens here are moving. signal_types lists any pre-existing buy-signal stories; is_e3d_candidate flags E3D coverage. signal_types populated = on-chain signal pre-existed the move → BREAKOUT-phase, higher conviction. signal_types empty = price-only move, no story backing → lower conviction, apply stricter quality gates. Apply normal quality gates to all.`,
    momentumWithSignal.length ? momentumWithSignal.map(formatMomentumToken).join("\n") : "none currently",
    `\n--- THESIS STORIES (fallback signal layer) ---`,
    data.thesisSignalStories.length ? data.thesisSignalStories.slice(0, 5).map(formatStory).join("\n") : "none currently",
    `\n--- ON-CHAIN SIGNALS (stories — check in_token_universe before using as candidate) ---`,
    ...buySignalStories.map(([type, items]) => {
      return `${type} (${items.length}):\n${items.slice(0, 5).map(formatStory).join("\n")}`;
    }),
    ...secondaryStories.map(([type, items]) => {
      return `${type} (${items.length}):\n${items.slice(0, 3).map(formatStory).join("\n")}`;
    }),
    buySignalStories.length + secondaryStories.length === 0 ? "none currently" : "",
    `\n--- LATE SIGNALS — POST-PUMP (move already happened — DO NOT use as new entry trigger) ---`,
    `These tokens have already moved. A MOVER/SURGE story means the crowd has arrived. Only relevant if you already hold the token (then it confirms momentum) or if combined with a fresh PRE-PUMP signal on the same token.`,
    ...lateSignalStories.map(([type, items]) => {
      return `${type} (${items.length}):\n${items.slice(0, 5).map(formatStory).join("\n")}`;
    }),
    lateSignalStories.length === 0 ? "none currently" : "",
    `\n--- TOKEN UNIVERSE (${data.tokenUniverse.length} tradeable tokens after filtering stablecoins/wrapped assets, sorted by ${data.sortLabel}) ---`,
    (() => {
      const withFlow = data.tokenUniverse.filter(t => t.flow_signal);
      const accum = withFlow.filter(t => t.flow_signal === "strong_accumulation" || t.flow_signal === "accumulation");
      const distrib = withFlow.filter(t => t.flow_signal === "strong_distribution" || t.flow_signal === "distribution");
      const qualifiedFlow = accum.filter(t => (t.buy_sell_ratio_1h||0) >= 3.5 && (t.liquidity_usd||0) > 150000 && (t.volume_24h_usd||0) > 75000 && (t.market_cap_usd||0) > 5000000);
      return `Flow coverage: ${withFlow.length}/${data.tokenUniverse.length} tokens have DexScreener data. Accumulation signals: ${accum.length} tokens. Distribution signals: ${distrib.length} tokens.` +
        (accum.length ? `\nAccumulation tokens (buy_sell_ratio_1h): ${accum.slice(0, 8).map(t => `${t.symbol}(${t.flow_signal},ratio=${t.buy_sell_ratio_1h},liq=$${(t.liquidity_usd||0).toFixed(0)},mcap=$${((t.market_cap_usd||0)/1e6).toFixed(1)}M,vol24=$${((t.volume_24h_usd||0)/1e3).toFixed(0)}k)`).join(", ")}` : "") +
        `\nFLOW-ONLY eligible (ratio>=3.5, liq>$150k, vol24>$75k, mcap>$5M): ${qualifiedFlow.length} tokens${qualifiedFlow.length ? " — " + qualifiedFlow.map(t => t.symbol).join(", ") : ""}. Use ONLY when E3D candidates AND theses are both empty. Max ${SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT} pick${SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT === 1 ? "" : "s"}.`;
    })(),
    JSON.stringify(data.tokenUniverse.slice(0, 100)),
  ];

  // Candidates sorted best-first; split into chunks that fit inside the GPU-safe char budget.
  const SAFE_PROMPT_CHARS = 50000;
  const beforeStr = partsBefore.join("\n");
  const afterStr = partsAfter.join("\n");
  const fixedChars = systemPrompt.length + beforeStr.length + afterStr.length;
  const availableForCandidates = Math.max(SAFE_PROMPT_CHARS - fixedChars, 3000);

  const sortedCandidates = [...data.e3dCandidates]
    .sort((a, b) => (b.convergence_score ?? 0) - (a.convergence_score ?? 0));
  const formattedCandidates = sortedCandidates.length ? sortedCandidates.map(formatCandidate) : ["none currently"];

  const batches = [];
  let batch = [], batchChars = 0;
  for (const fc of formattedCandidates) {
    if (batchChars + fc.length + 1 > availableForCandidates && batch.length > 0) {
      batches.push(batch);
      batch = [];
      batchChars = 0;
    }
    batch.push(fc);
    batchChars += fc.length + 1;
  }
  if (batch.length > 0) batches.push(batch);

  log("scout_batches", { total_candidates: data.e3dCandidates.length, batches: batches.length, fixed_chars: fixedChars, available_for_candidates: availableForCandidates });

  const allScoutCandidates = [];
  const seenCandidateAddresses = new Set();
  let mergedStoriesChecked = null;
  const scoutLlmBatches = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batchStr = batches[bi].join("\n");
    const batchLabel = batches.length > 1 ? `[batch ${bi + 1}/${batches.length} — sorted by convergence_score desc]\n` : "";
    const userMessage = [beforeStr, batchLabel + batchStr, afterStr].join("\n");
    const promptChars = systemPrompt.length + userMessage.length;

    let batchRaw;
    try {
      batchRaw = callLLMDirect(systemPrompt, userMessage, { agent: "scout" });
      const batchMeta = getLastLLMMeta("scout") || {};
      scoutLlmBatches.push({
        prompt_chars: promptChars,
        prompt_tokens: batchMeta.prompt_tokens,
        completion_tokens: batchMeta.completion_tokens,
        total_tokens: batchMeta.total_tokens,
        duration_ms: batchMeta.duration_ms
      });
    } catch (batchErr) {
      const batchMeta = getLastLLMMeta("scout") || {};
      scoutLlmBatches.push({
        prompt_chars: promptChars,
        prompt_tokens: batchMeta.prompt_tokens,
        completion_tokens: batchMeta.completion_tokens,
        total_tokens: batchMeta.total_tokens,
        duration_ms: batchMeta.duration_ms
      });
      log("scout_batch_error", { batch: bi + 1, error: String(batchErr).slice(0, 200) });
      continue;
    }

    let batchResult;
    try {
      batchResult = parseScoutJSON(batchRaw);
    } catch (parseErr) {
      log("scout_batch_parse_error", { batch: bi + 1, error: String(parseErr).slice(0, 200) });
      continue;
    }

    const batchCandidates = batchResult.candidates || [];
    log("scout_batch", { batch: bi + 1, total_batches: batches.length, candidates_returned: batchCandidates.length });

    for (const c of batchCandidates) {
      const addr = cleanAddress(c?.token?.contract_address || "");
      if (addr && seenCandidateAddresses.has(addr)) continue;
      if (addr) seenCandidateAddresses.add(addr);
      allScoutCandidates.push(c);
    }
    if (!mergedStoriesChecked && batchResult.stories_checked?.length) {
      mergedStoriesChecked = batchResult.stories_checked;
    }
  }

  // Best candidates across all batches, capped by settings.scout_max_candidates
  allScoutCandidates.sort((a, b) => (b.conviction_score ?? 0) - (a.conviction_score ?? 0));

  let result = {
    scan_timestamp: new Date().toISOString(),
    candidates: allScoutCandidates.slice(0, scoutMaxCandidates),
    holdings_updates: [],
    stories_checked: mergedStoriesChecked || [],
  };

  // Post-process: enrich candidates with real market data fetched per-address.
  // The 14B model often leaves numeric fields as empty strings.
  const now = new Date().toISOString();
  for (const candidate of result.candidates || []) {
    const addr = cleanAddress(candidate?.token?.contract_address || "");
    if (!addr) continue;

    // Fetch per-token price data from E3D
    let tokenRow = null;
    try {
      const rows = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
        dataSource: 1, search: addr, limit: 1
      }));
      tokenRow = rows.find((r) => cleanAddress(r.address || "") === addr) || rows[0] || null;
    } catch (_) {}

    // Fall back to story-embedded price data if price DB returns nothing
    const storyPrice = storyPriceMap.get(addr);
    if (!tokenRow && !storyPrice) continue;

    // Enrich token name if missing
    if (!candidate.token.name && tokenRow?.name) candidate.token.name = tokenRow.name;
    if (!candidate.token.name && storyPrice?.symbol) candidate.token.name = storyPrice.symbol;

    const price = tokenRow?.priceUSD ?? tokenRow?.price_usd ?? storyPrice?.price ?? 0;
    const liq = tokenRow?.effectiveLiquidityUSD || tokenRow?.liquidityUSD || tokenRow?.liquidity_usd || storyPrice?.liq || 0;
    const mcap = tokenRow?.marketCapUSD ?? tokenRow?.market_cap_usd ?? storyPrice?.mcap ?? 0;
    const vol24 = tokenRow?.volume24hUSD ?? tokenRow?.volume_24h_usd ?? 0;
    const chg30m = tokenRow?.changes?.["30M"]?.percent ?? 0;
    const chg24h = tokenRow?.changes?.["24H"]?.percent ?? 0;

    candidate.market_data = {
      current_price: price,
      change_24h_pct: chg24h,
      change_30m_pct: chg30m,
      price_timestamp: now,
      price_source: "e3d",
      volume_24h_usd: vol24,
      market_cap_usd: mcap
    };

    candidate.liquidity_data = {
      liquidity_usd: liq,
      liquidity_timestamp: now,
      liquidity_source: "e3d"
    };

    const slippageBps = liq > 100000 ? 50 : liq > 20000 ? 150 : liq > 5000 ? 300 : 999;
    candidate.execution_data = {
      estimated_slippage_bps: slippageBps,
      quote_source: "e3d"
    };

    if (tokenRow.fragilityScore != null) candidate._fragility_score = tokenRow.fragilityScore;

    // Enrich with live DexScreener order flow + Binance funding rate.
    // enrichCandidateQuant does a live DexScreener lookup if addr not already in token_flow cache.
    if (_cycleQuantContext) {
      const { flow, funding } = enrichCandidateQuant(addr, candidate?.token?.symbol, _cycleQuantContext);
      if (flow) {
        candidate._dex_flow = {
          flow_signal:          flow.flow_signal,
          buy_sell_ratio_1h:    flow.buy_sell_ratio_1h,
          buy_sell_ratio_24h:   flow.buy_sell_ratio_24h,
          volume_1h_usd:        flow.volume_1h_usd,
          price_change_1h_pct:  flow.price_change_1h_pct,
          price_change_24h_pct: flow.price_change_24h_pct,
        };
        // Prefer DexScreener price for market_data when e3d has nothing
        if ((flow.price_usd ?? 0) > 0 && !(candidate.market_data?.current_price > 0)) {
          if (!candidate.market_data) candidate.market_data = {};
          candidate.market_data.current_price = flow.price_usd;
          candidate.market_data.price_source = "dexscreener";
        }
      }
      if (funding) {
        candidate._funding_rate = {
          rate_per_8h:      funding.rate_per_8h,
          signal:           funding.signal,
          avoid_new_longs:  funding.avoid_new_longs,
        };
      }
    }

    // CoinGecko deep research — fetch full detail for this candidate (use cached detail if available).
    if (COINGECKO_API_KEY) {
      const cgDetail = data.cgDetailMap?.get(addr) || fetchCoinGeckoDetail(addr);
      if (cgDetail) {
        data.cgDetailMap?.set(addr, cgDetail);
        candidate._coingecko = {
          market_cap_rank: cgDetail.market_cap_rank,
          ath_change_pct: cgDetail.ath_change_pct,
          change_7d_pct: cgDetail.change_7d_pct,
          change_30d_pct: cgDetail.change_30d_pct,
          sentiment_up_pct: cgDetail.sentiment_up_pct,
          categories: cgDetail.categories,
          description: cgDetail.description,
          scores: {
            overall: cgDetail.coingecko_score,
            developer: cgDetail.developer_score,
            community: cgDetail.community_score,
            liquidity: cgDetail.liquidity_score,
          },
        };
        log("scout_coingecko_detail", {
          symbol: candidate?.token?.symbol,
          rank: cgDetail.market_cap_rank,
          ath_change_pct: cgDetail.ath_change_pct,
          change_7d_pct: cgDetail.change_7d_pct,
          sentiment_up_pct: cgDetail.sentiment_up_pct,
        });
      }
    }
  }

  // Ensure stories_checked covers every type the model was shown.
  // If the model omitted the field entirely, reconstruct it from the actual data.
  // If the model returned a partial list, fill in the missing types so coverage
  // scoring isn't penalised for types the model simply forgot to list.
  if (!Array.isArray(result.stories_checked)) result.stories_checked = [];
  const reportedTypes = new Set(result.stories_checked.map((s) => String(s?.type || "").toUpperCase()));
  for (const [type, items] of Object.entries(data.stories)) {
    if (reportedTypes.has(type.toUpperCase())) continue;
    result.stories_checked.push({
      type,
      found: Array.isArray(items) && items.length > 0,
      tokens: Array.isArray(items)
        ? items.slice(0, 5).map((s) => s.token_address || s.address || "").filter(Boolean)
        : [],
    });
  }

  // Hard pump filter: discard any candidate whose 7d gain exceeds 300% — it already pumped.
  // This is a code-level safety net; the prompt instruction alone is not reliable enough.
  const prePumpFilter = result.candidates || [];
  result.candidates = prePumpFilter.filter(c => {
    const change7d = c._coingecko?.change_7d_pct;
    if (change7d != null && change7d > 300) {
      log("scout_pump_filter", { symbol: c.token?.symbol, change_7d_pct: change7d });
      return false;
    }
    return true;
  });

  // Refresh held position prices from the universe fetched this cycle so Harvest
  // sees real unrealized P&L instead of $0 entry-price deltas.
  refreshPositionPrices(portfolio, data.tokenUniverse);
  // DexScreener prices are more real-time — overlay them for held positions that have flow data.
  if (_cycleQuantContext?.token_flow) {
    for (const pos of Object.values(portfolio.positions)) {
      const addr = cleanAddress(pos.contract_address || "");
      const flow = addr ? _cycleQuantContext.token_flow[addr] : null;
      if ((flow?.price_usd ?? 0) > 0 && flow.price_usd !== pos.current_price) {
        applyPositionMark(pos, flow.price_usd, "dexscreener_flow", markDeviationLimit(portfolio));
      }
    }
  }

  // Attach compact token universe so the dashboard can show what Scout was shown.
  result.token_universe = data.tokenUniverse.map(t => ({
    symbol:         t.symbol || null,
    address:        t.address || null,
    price_usd:      t.price_usd ?? null,
    volume_24h_usd: t.volume_24h_usd ?? null,
    liquidity_usd:  t.liquidity_usd ?? null,
    market_cap_usd: t.market_cap_usd ?? null,
    change_24h:     t.change_24h ?? null,
    flow_signal:    t.flow_signal ?? null,
  }));

  result.evidence_diagnostics = buildScoutEvidenceDiagnostics({
    input_candidate_count: data.e3dCandidates.length,
    llm_batches: scoutLlmBatches,
    address_repairs_in_cycle: 0,
    candidates: result.candidates,
    stories_checked: result.stories_checked,
    coverage: null
  });

  return result;
}

function fetchPositionExitSignal(tokenAddress) {
  if (!tokenAddress) return null;
  try {
    const result = fetchJson("/actions", {
      tokenAddress: cleanAddress(tokenAddress),
      status: "open",
      limit: 5
    });
    const actions = endpointArray(result);
    const priority = ["avoid", "confirm_risk", "reduce_exposure_signal"];
    for (const type of priority) {
      const match = actions.find(a => a.action_type === type);
      if (match) return match;
    }
  } catch (_) {}
  return null;
}

function buildFastPathExitDecision(entry, signal, createdAt, expiresAt) {
  const reason = `Decision Layer fast-path exit: ${signal.action_type} (risk_score=${signal.risk_score.toFixed(2)})`;
  return {
    source_agent: "harvest_fast_path",
    created_at: createdAt,
    expires_at: expiresAt,
    evidence_packet_id: entry.packet?.evidence_packet_id || null,
    token: entry.harvest_input?.token || { symbol: entry.symbol, contract_address: entry.address },
    position: entry.harvest_input?.position || {},
    action: "exit",
    fast_path: true,
    thesis_state: "invalid",
    thesis_summary: `Decision Layer ${signal.action_type}: ${(signal.trigger_reason || "").slice(0, 160)}`,
    what_changed: `E3D Decision Layer issued ${signal.action_type} with risk_score=${signal.risk_score.toFixed(2)}`,
    why_now: reason,
    confidence: 90,
    conviction_score: 10,
    opportunity_score: 5,
    review_priority: 5,
    summary: reason,
    evidence: [],
    risks: [`${signal.action_type} (risk_score=${signal.risk_score.toFixed(2)}): ${(signal.trigger_reason || "").slice(0, 100)}`],
    what_would_change_my_mind: ["Wait for Decision Layer action to expire or close"],
    next_best_alternative: "Exit position, await Decision Layer signal to clear",
    current_regime: "decision_layer_exit",
    market_data: entry.harvest_input?.market_data || {},
    liquidity_data: entry.harvest_input?.liquidity_data || {},
    narrative_data: { story_strength: 0, thesis_health: 0, flow_direction: "bearish" },
    portfolio_data: { current_token_exposure_pct: 0, current_category_exposure_pct: 0, current_total_exposure_pct: 0, portfolio_timestamp: createdAt, portfolio_source: "system" },
    decision_layer_action_id:   signal.action_id,
    decision_layer_action_type: signal.action_type,
    decision_layer_risk_score:  signal.risk_score,
    decision_layer_trigger:     signal.trigger_reason,
  };
}

function applyHarvestFastPathExits(result, reviewContext, exitSignals, createdAt, expiresAt) {
  if (!exitSignals.size) return result;
  for (const entry of reviewContext.entries) {
    const signal = exitSignals.get(entry.address);
    if (!signal) continue;
    if (
      (signal.action_type === "avoid" || signal.action_type === "confirm_risk") &&
      signal.risk_score > E3D_AVOID_RISK_FAST_PATH_FLOOR
    ) {
      log("harvest_fast_path_exit", {
        address: entry.address,
        symbol: entry.symbol,
        action_type: signal.action_type,
        action_id: signal.action_id,
        risk_score: signal.risk_score
      });
      const fastPathDecision = buildFastPathExitDecision(entry, signal, createdAt, expiresAt);
      const reviewIdx = result.position_reviews.findIndex(r =>
        cleanAddress(r.token?.contract_address || "") === entry.address
      );
      if (reviewIdx >= 0) {
        result.position_reviews[reviewIdx] = {
          ...result.position_reviews[reviewIdx],
          action: "exit",
          fast_path: true,
          why_now: fastPathDecision.why_now,
          thesis_state: "invalid",
          decision_layer_action_id:   signal.action_id,
          decision_layer_action_type: signal.action_type,
          decision_layer_risk_score:  signal.risk_score,
        };
      } else {
        result.position_reviews.push(fastPathDecision);
      }
      const alreadyExit = result.exit_candidates.some(c =>
        cleanAddress(c.token?.contract_address || "") === entry.address
      );
      if (!alreadyExit) {
        result.exit_candidates.push({
          ...fastPathDecision,
          setup_type: "decision_layer_fast_path",
          edge_source: "e3d_decision_layer",
          suggested_exit_fraction: 1.0,
          target_exit_price: entry.harvest_input?.position?.current_price ?? 0,
          decision_price:    entry.harvest_input?.position?.current_price ?? 0,
          exit_priority: 5
        });
      }
      recordOperatorAction({
        action_type: "harvest_fast_path_exit",
        actor: "harvest",
        role: "operator",
        reason: fastPathDecision.why_now,
        resource: "position",
        new_state: { action: "exit", fast_path: true, decision_layer_action_id: signal.action_id },
        metadata: { address: entry.address, symbol: entry.symbol }
      });
    }
  }
  return result;
}

// Used when the harvest LLM call/parse fails outright, so the cycle can still
// run rotations/buys and persist whatever hard-sells already happened instead
// of discarding the whole cycle (see HARVEST_REPLY_NOT_JSON handling in runCycle).
function buildHarvestFailureFallback(portfolio, createdAt) {
  const emptyResult = {
    scan_timestamp: createdAt,
    portfolio_summary: {
      market_regime: portfolio?.stats?.market_regime || "unknown",
      cash_usd: portfolio.cash_usd || 0,
      equity_usd: portfolio.equity_usd || 0,
      position_count: 0,
      tracked_positions: 0,
      average_thesis_strength: 0,
      average_thesis_freshness: 0,
      average_narrative_decay: 0,
      average_opportunity_score: 0
    },
    position_reviews: [],
    exit_candidates: [],
    stories_checked: []
  };
  emptyResult.evidence_diagnostics = buildHarvestEvidenceDiagnostics({
    input_candidate_count: 0,
    llm_batches: [],
    positions_reviewed: 0,
    position_reviews: [],
    exit_candidates: [],
    stories_checked: [],
    coverage: null
  });
  return emptyResult;
}

function runHarvestDirect(portfolio, portfolioIntelligence = null) {
  if (TOOL_USE_ENABLED) return runHarvestWithTools(portfolio, portfolioIntelligence);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const reviewContext = buildHarvestEvidenceReviewContext(portfolio, portfolioIntelligence, { createdAt });
  const dossier = reviewContext.dossier;
  const positions = reviewContext.positions;

  // No positions — nothing to harvest
  if (positions.length === 0) {
    const emptyResult = {
      scan_timestamp: createdAt,
      portfolio_summary: {
        market_regime: dossier.market_regime || "unknown",
        cash_usd: portfolio.cash_usd || 0,
        equity_usd: portfolio.equity_usd || 0,
        position_count: 0,
        tracked_positions: 0,
        average_thesis_strength: 0,
        average_thesis_freshness: 0,
        average_narrative_decay: 0,
        average_opportunity_score: 0
      },
      position_reviews: [],
      exit_candidates: [],
      stories_checked: []
    };
    emptyResult.evidence_diagnostics = buildHarvestEvidenceDiagnostics({
      input_candidate_count: 0,
      llm_batches: [],
      positions_reviewed: 0,
      position_reviews: [],
      exit_candidates: [],
      stories_checked: [],
      coverage: null
    });
    return emptyResult;
  }
  // Pre-fetch Decision Layer exit signals for all held positions and inject into packet summaries.
  const _positionExitSignals = new Map();
  for (const entry of reviewContext.entries) {
    const exitSignal = fetchPositionExitSignal(entry.address);
    if (exitSignal) {
      _positionExitSignals.set(entry.address, exitSignal);
      log("harvest_decision_layer_exit_signal", {
        address: entry.address,
        symbol: entry.symbol,
        action_type: exitSignal.action_type,
        risk_score: exitSignal.risk_score,
        action_score: exitSignal.action_score,
        trigger_reason: exitSignal.trigger_reason
      });
      entry.packet_summary.decision_layer_signal = {
        action_type:    exitSignal.action_type,
        risk_score:     exitSignal.risk_score,
        confidence:     exitSignal.confidence,
        trigger_reason: exitSignal.trigger_reason,
        action_id:      exitSignal.action_id,
      };
    }
  }

  const entryByAddress = new Map(reviewContext.entries.map((entry) => [entry.address, entry]));
  const harvestPackets = reviewContext.entries.map((entry, index) => ({
    rank: index + 1,
    ...entry.packet_summary
  }));

  const systemPrompt = [
    "You are Harvest, a crypto portfolio exit-scan agent.",
    "You have been given compact per-position evidence packets built deterministically before this call.",
    "Return STRICT JSON only — one object, no markdown.",
    "Use only the supplied packets, token fields, evidence_packet_id values, and evidence_id values. Do not invent evidence or cite evidence from a different packet.",
    `Classify every held position as hold, monitor, trim, or exit based on ALL available evidence. position_reviews[] MUST contain exactly one entry per held position (${positions.length} total) — never skip a position.`,
    "Only add a position to exit_candidates if action is trim or exit.",
    "EVIDENCE RULE: Every trim/exit review and every exit_candidate MUST include at least 2 evidence_id strings in evidence[] copied exactly from that same packet. If you do not have 2 valid evidence refs, use action='monitor' instead.",
    "MASS EXIT RULE: Do not propose trim or exit for more than half the portfolio in a single cycle unless you have direct exit-risk story matches (LIQUIDITY_DRAIN, RUG_LIQUIDITY_PULL, TREASURY_DISTRIBUTION, SECURITY_RISK) for those positions. When evidence is weak or absent, use monitor, not exit.",
    "",
    "SIGNAL TIMING — know whether you're in the setup, the move, or the dump:",
    "- PRE-PUMP HOLD CONFIRMS (bullish for holding): STAGING, CLUSTER, FUNNEL, ACCUMULATION, SMART_MONEY, SMART_MONEY_LEADER, FLOW — fresh accumulation means the thesis is intact. SMART_MONEY_LEADER with late_crowding=false is a strong hold signal.",
    "- EXIT TRIGGERS: TREASURY_DISTRIBUTION means a team/foundation wallet is moving tokens to an exchange — this is sell pressure, lean toward exit or trim immediately. SECURITY_RISK with is_honeypot=true means the token cannot be sold — flag as critical, seek liquidity exit at any price.",
    "- PUMP EXHAUSTION (exit signal): MOVER or SURGE story on a position that is declining = the pump narrative is over, you are now in the dump phase. EXIT unless a fresh ACCUMULATION/SMART_MONEY story ALSO exists for this token.",
    "- If a position has _coingecko.change_7d_pct > 200% AND is now down from entry: the pump happened before entry. Exit — there is no thesis, only a late buy into a pump.",
    "",
    "QUANT EXIT SIGNALS — apply these to every position:",
    "- flow_signal=strong_distribution or distribution: bearish order flow — lean toward trim or exit unless strong hold-confirm story exists",
    "- flow_signal=strong_accumulation or accumulation: bullish order flow — lean toward hold; only exit if story evidence is strong",
    "- funding_signal=overcrowded_long: longs are crowded — reduce exposure on rally; set tighter stop",
    "- funding_signal=squeeze_potential: shorts crowded — hold/buy the dip; squeeze may lift price",
    "- tighten_stops=true (macro): take partial profits on all positions > 15% gain; tighten stops to -5%",
    "- regime=extreme_fear: only exit confirmed deteriorating positions; avoid panic-selling healthy ones",
    "- unrealized_pnl_pct > 25%: consider partial profit-taking unless Tier 1 conviction",
    "- unrealized_pnl_pct < -8%: flag for stop review; exit if thesis invalid and no recovery signal",
    "- decision_layer_signal (if present in packet): high-weight structural signal from the E3D OTA pipeline. avoid or confirm_risk with risk_score > 0.65 is a strong exit indicator; reduce_exposure_signal means trim exposure.",
    "",
    `Output shape: {scan_timestamp, portfolio_summary, position_reviews[], exit_candidates[], stories_checked[]}`,
    `Each position_review: {source_agent:"harvest", created_at:"${createdAt}", expires_at:"${expiresAt}", evidence_packet_id, token:{symbol,name,chain:"ethereum",contract_address,category}, position:{quantity,avg_entry_price,current_price,market_value_usd,cost_basis_usd,unrealized_pnl_usd,unrealized_pnl_pct}, action:"hold"|"monitor"|"trim"|"exit", thesis_state, thesis_summary, what_changed, why_now, confidence:integer(0-100), conviction_score:integer(0-100), opportunity_score:integer(0-100), review_priority, summary, evidence:["evi_..."], risks[], what_would_change_my_mind[], next_best_alternative, current_regime, market_data:{current_price,change_24h_pct,price_source}, liquidity_data:{liquidity_usd,liquidity_source}, narrative_data:{story_strength,thesis_health,flow_direction}, portfolio_data:{current_token_exposure_pct,current_category_exposure_pct,current_total_exposure_pct,portfolio_timestamp,portfolio_source:"system"}}`,
    `Each exit_candidate: same as position_review plus {setup_type, edge_source, suggested_exit_fraction, target_exit_price, decision_price, exit_priority}. evidence[] must contain 2 to 4 packet evidence_id strings.`,
    `stories_checked[] may be [].`
  ].join("\n");

  // Build macro context block for Harvest
  const harvestMacro = _cycleQuantContext?.macro ?? null;
  const harvestMacroLines = harvestMacro ? [
    `\n--- MACRO REGIME (live) ---`,
    `regime=${harvestMacro.regime}  tighten_stops=${harvestMacro.tighten_stops}  new_positions_ok=${harvestMacro.new_positions_ok}`,
    harvestMacro.btc    ? `BTC: $${harvestMacro.btc.price.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${harvestMacro.btc.change_24h_pct > 0 ? "+" : ""}${harvestMacro.btc.change_24h_pct}% 24h)` : "",
    harvestMacro.fear_greed ? `Fear&Greed: ${harvestMacro.fear_greed.value}/100 — ${harvestMacro.fear_greed.label}` : "",
    harvestMacro.tighten_stops ? "⚠ TIGHTEN STOPS: take partial profits on positions > 15% gain; tighten all stops" : "Stops: normal — no macro-driven tightening required",
  ].filter(Boolean) : [];
  const harvestPolicyLines = _cycleRegimePolicy ? [
    `\n--- REGIME SENTINEL POLICY ---`,
    `regime=${_cycleRegimePolicy.regime} allow_harvest_exits=${_cycleRegimePolicy.allow_harvest_exits} tighten_stops=${_cycleRegimePolicy.tighten_stops}`,
    `reason_codes=${(_cycleRegimePolicy.reason_codes || []).join(", ")}`
  ] : [];
  const harvestMapsPrecheckLines = buildHarvestMapsPrecheckBlock(reviewContext.entries);

  const userMessage = [
    `Harvest task — ${createdAt} [evidence packets]`,
    `Held positions=${reviewContext.entries.length}`,
    `Evidence packets=${harvestPackets.length}`,
    `Portfolio baseline: ${JSON.stringify({
      market_regime: dossier.market_regime || "unknown",
      portfolio: dossier.prompt_snapshot?.portfolio || null,
      thesis_snapshot: dossier.prompt_snapshot?.thesis_snapshot || null
    })}`,
    ...harvestMacroLines,
    ...harvestPolicyLines,
    ...harvestMapsPrecheckLines,
    JSON.stringify({ harvest_packets: harvestPackets, stories_checked: reviewContext.stories_checked })
  ].join("\n");

  const harvestLlmBatches = [];
  const HARVEST_JSON_RETRY_ADDENDUM = "\n\nYour previous reply could not be parsed as JSON. Return ONLY one strict JSON object matching the schema above — no markdown fences, no commentary before or after the object.";
  let lastRawText = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const attemptSystemPrompt = attempt === 1 ? systemPrompt : systemPrompt + HARVEST_JSON_RETRY_ADDENDUM;
    const rawText = callLLMDirect(attemptSystemPrompt, userMessage, { agent: "harvest" });
    lastRawText = rawText;
    const harvestMeta = getLastLLMMeta("harvest") || {};
    harvestLlmBatches.push({
      prompt_chars: attemptSystemPrompt.length + userMessage.length,
      prompt_tokens: harvestMeta.prompt_tokens,
      completion_tokens: harvestMeta.completion_tokens,
      total_tokens: harvestMeta.total_tokens,
      duration_ms: harvestMeta.duration_ms
    });

    // Extract JSON
    let jsonStr = rawText.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const firstBrace = jsonStr.indexOf("{");
    if (firstBrace !== -1) {
      let depth = 0, end = -1;
      for (let i = firstBrace; i < jsonStr.length; i++) {
        if (jsonStr[i] === "{") depth++;
        else if (jsonStr[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) jsonStr = jsonStr.slice(firstBrace, end + 1);
      else jsonStr = jsonStr.slice(firstBrace);
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return applyHarvestFastPathExits(
        finalizeHarvestLLMResult(parsed, portfolio, reviewContext, dossier, createdAt, expiresAt, harvestLlmBatches),
        reviewContext, _positionExitSignals, createdAt, expiresAt
      );
    } catch (parseErr) {
      // LLM may have hit max_tokens mid-response — try to repair truncated JSON
      try {
        const repaired = JSON.parse(repairTruncatedJson(jsonStr));
        log("harvest_json_repaired", { raw_length: rawText.length, attempt });
        return applyHarvestFastPathExits(
          finalizeHarvestLLMResult(repaired, portfolio, reviewContext, dossier, createdAt, expiresAt, harvestLlmBatches),
          reviewContext, _positionExitSignals, createdAt, expiresAt
        );
      } catch (_) {
        log("harvest_json_parse_failed", { attempt, raw_length: rawText.length });
      }
    }
  }

  throw new Error(`HARVEST_REPLY_NOT_JSON\n${lastRawText.slice(0, 500)}`);
}

function runHarvestWithTools(portfolio, portfolioIntelligence = null) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

  const positions = Object.values(portfolio?.positions || {});
  if (positions.length === 0) {
    const emptyResult = {
      scan_timestamp: createdAt,
      portfolio_summary: { market_regime: "unknown", cash_usd: portfolio.cash_usd || 0, equity_usd: portfolio.equity_usd || 0, position_count: 0, tracked_positions: 0, average_thesis_strength: 0, average_thesis_freshness: 0, average_narrative_decay: 0, average_opportunity_score: 0 },
      position_reviews: [], exit_candidates: [], stories_checked: []
    };
    emptyResult.evidence_diagnostics = buildHarvestEvidenceDiagnostics({ input_candidate_count: 0, llm_batches: [], positions_reviewed: 0, position_reviews: [], exit_candidates: [], stories_checked: [], coverage: null });
    return emptyResult;
  }

  const positionList = positions.map((p) => {
    const mapsPrecheck = buildMapsNavigatorPrecheck({
      symbol: p.symbol,
      mapsContext: _cycleMapsContext
    });
    return {
      symbol: p.symbol,
      contract_address: p.contract_address,
      category: p.category,
      quantity: p.quantity,
      avg_entry_price: p.avg_entry_price,
      current_price: p.current_price,
      market_value_usd: p.market_value_usd,
      cost_basis_usd: p.cost_basis_usd,
      unrealized_pnl_usd: toNum(p.market_value_usd, 0) - toNum(p.cost_basis_usd, 0),
      unrealized_pnl_pct: toNum(p.cost_basis_usd, 0) > 0
        ? (((toNum(p.market_value_usd, 0) - toNum(p.cost_basis_usd, 0)) / toNum(p.cost_basis_usd, 0)) * 100)
        : 0,
      opened_at: p.opened_at,
      maps_navigator_precheck: mapsPrecheck.prompt_prefix || null
    };
  });
  const toolPathMapsPrecheckLines = buildHarvestMapsPrecheckBlock(positionList.map((position) => ({
    symbol: position.symbol,
    address: position.contract_address,
    maps_precheck: {
      lines: position.maps_navigator_precheck ? position.maps_navigator_precheck.split("\n") : []
    }
  })));

  const macroContext = _cycleQuantContext?.macro;
  const macroLine = macroContext
    ? `MACRO: regime=${macroContext.regime} tighten_stops=${macroContext.tighten_stops} new_positions_ok=${macroContext.new_positions_ok}` +
      (macroContext.dxy ? ` dxy_24h=${macroContext.dxy.change_24h_pct}%` : "") +
      (macroContext.equity_index ? ` equity_24h=${macroContext.equity_index.change_24h_pct}%` : "") +
      (macroContext.regulatory ? ` regulatory=${macroContext.regulatory.stance}(${macroContext.regulatory.reason || "operator flag"})` : "")
    : "";
  const policyLine = _cycleRegimePolicy
    ? `REGIME POLICY: allow_harvest_exits=${_cycleRegimePolicy.allow_harvest_exits} reason_codes=${(_cycleRegimePolicy.reason_codes || []).join(",")}`
    : "";

  const systemPrompt = [
    "You are Harvest, a crypto portfolio exit-scan agent for a quantitative hedge fund.",
    "Use the provided tools to research each held position, then return STRICT JSON only — one object, no markdown, no commentary.",
    "",
    "RESEARCH STRATEGY:",
    "1. Call e3d_get_stories to find any stories about your held tokens (check by contract_address).",
    "2. Call e3d_get_token_info(address) for positions with large unrealized P&L or high risk.",
    "3. Call e3d_get_transactions(address) to check for whale exits or unusual activity on any concerning position.",
    "You do NOT need to call tools for every position. Prioritize positions with: large loss (pnl_pct < -8%), large gain (pnl_pct > 25%), or high category risk.",
    "You MUST classify ALL held positions — never skip one.",
    "",
    "EXIT SIGNALS (lean toward trim or exit):",
    "- TREASURY_DISTRIBUTION story: team wallet moving to exchange — immediate sell pressure.",
    "- SECURITY_RISK with is_honeypot=true: cannot be sold — emergency exit at any price.",
    "- MOVER/SURGE story on a declining position: pump is over, now in dump phase.",
    "- flow_signal=strong_distribution: bearish order flow.",
    "- unrealized_pnl_pct < -8% with thesis failing or no supporting story.",
    "- change_7d_pct > 200% AND position is now declining: entered a late pump, exit.",
    "",
    "HOLD SIGNALS:",
    "- STAGING, CLUSTER, ACCUMULATION, SMART_MONEY, FUNNEL: fresh accumulation, thesis intact.",
    "- SMART_MONEY_LEADER with late_crowding=false: strong hold signal.",
    "- flow_signal=accumulation or strong_accumulation: bullish order flow.",
    "- unrealized_pnl_pct > 25%: consider partial profit-taking (action=trim) unless Tier 1 conviction.",
    "",
    "MASS EXIT RULE: Do not propose trim/exit for more than half the portfolio in one cycle unless you have direct exit-risk story evidence (LIQUIDITY_DRAIN, RUG_LIQUIDITY_PULL, TREASURY_DISTRIBUTION, SECURITY_RISK).",
    "EVIDENCE RULE: Every trim/exit MUST have at least 2 reasons in evidence[]. If you cannot find 2 reasons, use action=monitor instead.",
    macroLine, policyLine,
    "",
    `Output shape: {scan_timestamp, portfolio_summary, position_reviews[], exit_candidates[], stories_checked[]}`,
    `Each position_review: {source_agent:"harvest", created_at:"${createdAt}", expires_at:"${expiresAt}", token:{symbol,name,chain:"ethereum",contract_address,category}, position:{quantity,avg_entry_price,current_price,market_value_usd,cost_basis_usd,unrealized_pnl_usd,unrealized_pnl_pct}, action:"hold"|"monitor"|"trim"|"exit", thesis_state, thesis_summary, what_changed, why_now, confidence:integer(0-100), conviction_score:integer(0-100), opportunity_score:integer(0-100), review_priority, summary, evidence:["string"], risks:[], what_would_change_my_mind:[], next_best_alternative, current_regime, market_data:{current_price,change_24h_pct,price_source}, liquidity_data:{liquidity_usd,liquidity_source}, narrative_data:{story_strength,thesis_health,flow_direction}, portfolio_data:{current_token_exposure_pct,current_category_exposure_pct,current_total_exposure_pct,portfolio_timestamp,portfolio_source:"system"}}`,
    `Each exit_candidate: same as position_review plus {setup_type, edge_source, suggested_exit_fraction, target_exit_price, decision_price, exit_priority}. evidence[] must contain 2-4 reason strings.`,
    `portfolio_summary: {market_regime, cash_usd, equity_usd, position_count, tracked_positions, average_thesis_strength, average_thesis_freshness, average_narrative_decay, average_opportunity_score}`,
    `stories_checked[] may be [].`
  ].filter(Boolean).join("\n");

  const userMessage = [
    `Harvest task — ${createdAt}`,
    `Held positions (${positions.length}):`,
    JSON.stringify(positionList),
    `Cash: $${toNum(portfolio.cash_usd, 0).toFixed(2)}`,
    ...toolPathMapsPrecheckLines,
    `Use your tools to research each position, then return your hold/exit decisions for all ${positions.length} positions.`
  ].join("\n");

  const harvestLlmBatches = [];
  let rawText;
  try {
    rawText = callLLMWithTools(systemPrompt, userMessage, E3D_AGENT_TOOLS, executeE3DTool, { agent: "harvest" });
    const meta = getLastLLMMeta("harvest") || {};
    harvestLlmBatches.push({
      prompt_chars: systemPrompt.length + userMessage.length,
      prompt_tokens: meta.prompt_tokens, completion_tokens: meta.completion_tokens,
      total_tokens: meta.total_tokens, duration_ms: meta.duration_ms, tool_rounds: meta.tool_rounds
    });
  } catch (err) {
    const meta = getLastLLMMeta("harvest") || {};
    harvestLlmBatches.push({
      prompt_chars: systemPrompt.length + userMessage.length,
      prompt_tokens: meta.prompt_tokens, completion_tokens: meta.completion_tokens,
      total_tokens: meta.total_tokens, duration_ms: meta.duration_ms
    });
    throw err;
  }

  // Parse JSON — same repair approach as the standard harvest path
  let jsonStr = rawText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const firstBrace = jsonStr.indexOf("{");
  if (firstBrace !== -1) {
    let depth = 0, end = -1;
    for (let i = firstBrace; i < jsonStr.length; i++) {
      if (jsonStr[i] === "{") depth++;
      else if (jsonStr[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    jsonStr = end !== -1 ? jsonStr.slice(firstBrace, end + 1) : jsonStr.slice(firstBrace);
  }

  let parsed = {};
  try { parsed = JSON.parse(jsonStr); } catch (_) {
    try { parsed = JSON.parse(repairTruncatedJson(jsonStr)); } catch (_2) {}
  }

  const positionReviews = Array.isArray(parsed?.position_reviews) ? parsed.position_reviews : [];
  const exitCandidates = Array.isArray(parsed?.exit_candidates) ? parsed.exit_candidates : [];

  // Enforce evidence rule: downgrade trim/exit with fewer than 2 evidence strings
  const normalizedReviews = positionReviews.map(r => {
    const action = String(r?.action || "monitor").toLowerCase();
    if (["trim", "exit"].includes(action)) {
      const evCount = Array.isArray(r.evidence) ? r.evidence.filter(e => typeof e === "string" && e.trim()).length : 0;
      if (evCount < 2) {
        log("harvest_tool_candidate_downgraded", { reason: "too_few_evidence_strings", symbol: r?.token?.symbol, ev_count: evCount });
        return { ...r, action: "monitor" };
      }
    }
    return r;
  });

  const result = {
    scan_timestamp: createdAt,
    portfolio_summary: parsed?.portfolio_summary ?? {
      market_regime: macroContext?.regime || "unknown",
      cash_usd: toNum(portfolio.cash_usd, 0), equity_usd: toNum(portfolio.equity_usd, 0),
      position_count: positions.length, tracked_positions: positions.length,
      average_thesis_strength: 0, average_thesis_freshness: 0,
      average_narrative_decay: 0, average_opportunity_score: 0
    },
    position_reviews: normalizedReviews,
    exit_candidates: exitCandidates.filter(ec => {
      const rev = normalizedReviews.find(r => cleanAddress(r?.token?.contract_address || "") === cleanAddress(ec?.token?.contract_address || ""));
      return !rev || ["trim", "exit"].includes(String(rev.action || "").toLowerCase());
    }),
    stories_checked: Array.isArray(parsed?.stories_checked) ? parsed.stories_checked : []
  };
  result.evidence_diagnostics = buildHarvestEvidenceDiagnostics({
    input_candidate_count: positions.length,
    llm_batches: harvestLlmBatches,
    positions_reviewed: normalizedReviews.length,
    position_reviews: normalizedReviews,
    exit_candidates: result.exit_candidates,
    stories_checked: [],
    coverage: null
  });
  return result;
}

function buildScoutPrompt(portfolio, portfolioIntelligence = null) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const dossier = portfolioIntelligence || buildPortfolioIntelligenceDossier(portfolio);

  const heldSymbols = new Set(
    Object.values(portfolio?.positions || {})
      .map((position) => String(position?.symbol || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const heldAddresses = new Set(
    Object.values(portfolio?.positions || {})
      .map((position) => cleanAddress(position?.contract_address || ""))
      .filter(Boolean)
  );

  const exclusions = {
    held_symbols: Array.from(heldSymbols).slice(0, 20),
    held_addresses: Array.from(heldAddresses).slice(0, 20)
  };

  const holdings = dossier.holdings.slice(0, 8).map((item) => ({
    symbol: item?.token?.symbol || item?.token?.name || null,
    contract_address: item?.token?.contract_address || null,
    category: item?.token?.category || "unknown",
    thesis_strength: item?.thesis?.strength || item?.prompt?.thesis_snapshot?.strength || null,
    narrative_decay: item?.thesis?.decay || item?.prompt?.thesis_snapshot?.narrative_decay || null,
    opportunity_score: item?.thesis?.opportunity_score || item?.prompt?.thesis_snapshot?.opportunity_score || null,
    market_cap_usd: item?.market_data?.market_cap_usd || null,
    liquidity_usd: item?.liquidity_data?.liquidity_usd || null
  }));
  const portfolioBaseline = {
    market_regime: dossier.market_regime,
    portfolio: dossier.prompt_snapshot.portfolio,
    thesis_snapshot: dossier.prompt_snapshot.thesis_snapshot,
    holdings: holdings,
    regime_policy: _cycleRegimePolicy || null,
    signal_snapshot: _cycleSignalSnapshot || null,
    arbitrage_watch_only: _cycleArbitrageSignals || []
  };
  const compactPortfolioBaseline = JSON.stringify(portfolioBaseline);

  const taskPrompt = [
    `Scout task — ${createdAt}. Return STRICT JSON only (one object, no markdown).`,
    `Follow the full Research Protocol in TOOLS.md: disqualifier sweep first, then buy signals, then per-candidate deep checks.`,
    `Return up to 3 buy candidates. Use real values from your research — no placeholder zeros.`,
    `Exclude held tokens: ${JSON.stringify(exclusions.held_symbols)}`,
    `Excluded addresses: ${JSON.stringify(exclusions.held_addresses)}`,
    `Output fields: scan_timestamp, candidates[], holdings_updates[], stories_checked[].`,
    `Each candidate: source_agent="scout", created_at, expires_at="${expiresAt}", token{symbol,name,chain,contract_address,category}, setup_type, action="buy", confidence, conviction_score, opportunity_score, why_now, evidence[], risks[], entry_zone{low,high}, invalidation_price, targets{target_1,target_2,target_3}, market_data, liquidity_data, execution_data, portfolio_data.`,
    `stories_checked[]: one entry per story type fetched — {type, found, tokens[]|disqualified_addresses[]}.`,
    `Portfolio context: ${compactPortfolioBaseline}`
  ].join("\n").trim();

  return taskPrompt.trim();
}

function buildHarvestPrompt(portfolio, portfolioIntelligence = null) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const reviewContext = buildHarvestEvidenceReviewContext(portfolio, portfolioIntelligence, { createdAt });
  const mapsPrecheckLines = buildHarvestMapsPrecheckBlock(reviewContext.entries);
  const baseline = {
    market_regime: reviewContext.dossier.market_regime || "unknown",
    portfolio: reviewContext.dossier.prompt_snapshot?.portfolio || null,
    thesis_snapshot: reviewContext.dossier.prompt_snapshot?.thesis_snapshot || null
  };

  return [
    "You are Harvest. Return STRICT JSON only.",
    "Use only the supplied harvest evidence packets and cite evidence_id strings copied from the matching packet.",
    `Review every held position exactly once (${reviewContext.entries.length} total).`,
    `Trim/exit requires at least 2 valid evidence refs from the same packet; otherwise use monitor.`,
    `Each position_review and each exit_candidate must include evidence_packet_id.`,
    `Portfolio baseline: ${JSON.stringify(baseline)}`,
    ...mapsPrecheckLines,
    `Harvest packets: ${JSON.stringify(reviewContext.entries.map((entry, index) => ({ rank: index + 1, ...entry.packet_summary })))}`,
    `stories_checked baseline: ${JSON.stringify(reviewContext.stories_checked)}`,
    `Output shape: {scan_timestamp, portfolio_summary, position_reviews[], exit_candidates[], stories_checked[]}`,
    `Each position_review: {source_agent:"harvest", created_at:"${createdAt}", expires_at:"${expiresAt}", evidence_packet_id, token:{symbol,name,chain:"ethereum",contract_address,category}, position:{quantity,avg_entry_price,current_price,market_value_usd,cost_basis_usd,unrealized_pnl_usd,unrealized_pnl_pct}, action:"hold"|"monitor"|"trim"|"exit", thesis_state, thesis_summary, what_changed, why_now, confidence, conviction_score, opportunity_score, review_priority, summary, evidence:["evi_..."], risks[], what_would_change_my_mind[], next_best_alternative, current_regime, market_data:{current_price,change_24h_pct,price_source}, liquidity_data:{liquidity_usd,liquidity_source}, narrative_data:{story_strength,thesis_health,flow_direction}, portfolio_data:{current_token_exposure_pct,current_category_exposure_pct,current_total_exposure_pct,portfolio_timestamp,portfolio_source:"system"}}`,
    `Each exit_candidate: same as position_review plus {setup_type, edge_source, suggested_exit_fraction, target_exit_price, decision_price, exit_priority}.`,
    "One JSON object only."
  ].join("\n");
}

function buildRiskPrompt(proposal) {
  const taskPrompt = `
Validate this trade proposal and return JSON only.

Rules:
- return JSON only
- reason_codes must be exact snake_case strings
- reject invalid contract addresses immediately
- reject if required market, liquidity, execution, or portfolio data is missing
- validate liquidity, slippage, fraud risk, and exposure constraints
- if trade_kind is exit or rotation, validate the position reduction or closure using position_snapshot, exit_plan, and portfolio data
- if trade_kind is exit and source_agent is harvest, validate the harvest exit proposal using position_snapshot, exit_plan, and portfolio data

Proposal:
${JSON.stringify(proposal)}
`.trim();

  return taskPrompt.trim();
}

function buildExecutorPrompt(proposal, portfolio) {
  const taskPrompt = `
Validate this structured proposal and return JSON only.

Paper mode is ${portfolio.settings.paper_mode ? "enabled" : "disabled"}.

Allowed decisions:
- reject
- paper_trade
- approve_live
- reduce_size
- wait_for_entry
- monitor_only

Rules:
- do not originate trades
- preserve capital first
- reject malformed, stale, illiquid, or oversized proposals
- if paper mode is enabled, prefer paper_trade over approve_live
- return exactly one JSON object
- if trade_kind is exit or rotation, validate the position reduction or closure as carefully as a buy
- if trade_kind is exit and source_agent is harvest, validate the harvest exit proposal using position_snapshot, exit_plan, and portfolio data

Proposal:
${JSON.stringify(proposal)}

Required response shape:
{
  "token": "...",
  "executor_decision": "paper_trade",
  "reason_summary": "...",
  "risk_checks": ["..."],
  "execution_checks": ["..."],
  "portfolio_checks": ["..."],
  "approved_size_pct": 0,
  "approved_exit_fraction": 0,
  "max_slippage_bps": 0,
  "entry_status": "...",
  "stop_level": 0,
  "target_plan": {},
  "paper_trade_ticket": {},
  "live_execution_allowed": false,
  "blocker_list": ["..."],
  "follow_up_action": "..."
}
`.trim();

  return taskPrompt.trim();
}

function normalizeCooldownExitReason(exitReason) {
  const text = String(exitReason || "").trim().toLowerCase();
  const root = text.split(":")[0];
  if (!root) return "unknown";
  if (/^target(?:_\d+)?$/.test(root)) return "target_hit";
  if (root === "target_hit" || root === "partial_target") return root;
  if (root.startsWith("rotation_out")) return "rotation_out";
  if (root.includes("take_profit")) return "harvest_take_profit";
  if (root === "time_stop" || root === "thesis_decay") return root;
  if (root === "stop_loss") return root;
  if (root.startsWith("fraud_risk")) return root;
  if (root === "liquidity_drain" || root === "wash_trade" || root === "momentum_breakdown") return root;
  return root;
}

function resolveCooldownHoursForExitReason(exitReason, defaultHours = SETTINGS_DEFAULTS.cooldown_hours_after_exit) {
  const reason = normalizeCooldownExitReason(exitReason);
  if (
    reason === "stop_loss"
    || reason === "liquidity_drain"
    || reason === "wash_trade"
    || reason === "momentum_breakdown"
    || reason.startsWith("fraud_risk")
  ) {
    return defaultHours;
  }
  if (
    reason === "target_hit"
    || reason === "partial_target"
    || reason === "rotation_out"
    || reason === "harvest_take_profit"
  ) {
    return defaultHours / 4;
  }
  return defaultHours / 2;
}

function normalizeCooldownEntry(entry) {
  if (typeof entry === "string") {
    return {
      until: entry,
      reason: "legacy"
    };
  }
  if (!entry || typeof entry !== "object") return null;
  const until = typeof entry.until === "string" ? entry.until : "";
  if (!until) return null;
  return {
    until,
    reason: typeof entry.reason === "string" && entry.reason.trim() ? entry.reason.trim() : "legacy"
  };
}

function normalizePortfolioCooldowns(cooldowns) {
  const normalized = {};
  for (const [symbol, entry] of Object.entries(cooldowns || {})) {
    const normalizedEntry = normalizeCooldownEntry(entry);
    if (normalizedEntry) normalized[symbol] = normalizedEntry;
  }
  return normalized;
}

function setCooldown(portfolio, symbol, exitReason) {
  portfolio.cooldowns = normalizePortfolioCooldowns(portfolio.cooldowns || {});
  const hours = resolveCooldownHoursForExitReason(exitReason, portfolio.settings.cooldown_hours_after_exit);
  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  portfolio.cooldowns[symbol] = {
    until,
    reason: normalizeCooldownExitReason(exitReason)
  };
}

function pruneCooldowns(portfolio) {
  const now = nowMs();
  for (const [symbol, entry] of Object.entries(portfolio.cooldowns || {})) {
    const normalizedEntry = normalizeCooldownEntry(entry);
    if (!normalizedEntry) {
      delete portfolio.cooldowns[symbol];
      continue;
    }
    if (new Date(normalizedEntry.until).getTime() <= now) {
      delete portfolio.cooldowns[symbol];
      continue;
    }
    portfolio.cooldowns[symbol] = normalizedEntry;
  }
}

function callDirectJson(agentRole, systemPrompt, userPrompt, errorTag) {
  const rawText = callLLMDirect(systemPrompt, userPrompt);
  let jsonStr = rawText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const firstBrace = jsonStr.indexOf("{");
  if (firstBrace !== -1) {
    let depth = 0, end = -1;
    for (let i = firstBrace; i < jsonStr.length; i++) {
      if (jsonStr[i] === "{") depth++;
      else if (jsonStr[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) jsonStr = jsonStr.slice(firstBrace, end + 1);
    else jsonStr = jsonStr.slice(firstBrace);
  }
  try { return JSON.parse(jsonStr); } catch (_) {
    throw new Error(`${errorTag}_NOT_JSON\n${rawText.slice(0, 400)}`);
  }
}

function runRiskDirect(proposal, paperMode = false) {
  const approveDecision = paperMode ? "paper_trade" : "approve_for_executor";
  const systemPrompt = [
    "You are Risk, a crypto trade risk validator.",
    "Validate the proposal and return STRICT JSON only — one object, no markdown.",
    `Paper mode: ${paperMode ? "ENABLED — use decision \"paper_trade\" (never \"approve_for_executor\")" : "disabled — use decision \"approve_for_executor\" when approved"}.`,
    `Response shape: {decision:"${approveDecision}"|"reject", reason_summary, reason_codes[], risk_score:number(0-100), checks_passed[], checks_failed[], blocker_list[]}`,
    "Decision: approve ONLY IF ALL of these pass:",
    "  1. contract_address is a valid 42-char hex address",
    "  2. market_data.current_price > 0",
    "  3. liquidity_data.liquidity_usd >= 5000",
    "  4. execution_data.estimated_slippage_bps <= 300",
    "  5. _fragility_score (if present) < 70",
    "  6. fraud_risk (if present) < 35 — high fraud risk is a hard block",
    "  7. confidence (if present) > 55 — low confidence is a hard block",
    "If any of these fail, decision = reject.",
    "reason_codes must be exact snake_case strings from this list (use all that apply): invalid_address, price_missing, liquidity_too_low, slippage_too_high, fragility_high, fraud_risk_high, confidence_too_low, missing_market_data, address_valid, price_ok, liquidity_ok, slippage_ok, fraud_risk_ok, confidence_ok. reason_codes must never be empty — always include at least one code."
  ].join("\n");
  const userPrompt = `Validate this proposal:\n${JSON.stringify(proposal)}`;
  return callDirectJson("risk", systemPrompt, userPrompt, "RISK_DIRECT");
}

function deterministicBuyGate(proposal, portfolio) {
  const blockers = [];
  const dataQuality = proposal?.market_data_quality || buildMarketDataQuality(proposal, {
    evaluated_at: proposal?.created_at || proposal?.signal_snapshot?.generated_at || nowIso()
  });
  const addr = cleanAddress(proposal?.token?.contract_address || "");
  const price = optionalNum(dataQuality?.normalized?.price_usd ?? proposal?.market_data?.current_price);
  const liquidity = optionalNum(dataQuality?.normalized?.liquidity_usd ?? proposal?.liquidity_data?.liquidity_usd);
  const marketCap = optionalNum(proposal?.market_data?.market_cap_usd);
  const volume24h = optionalNum(proposal?.market_data?.volume_24h_usd);
  const slippageBps = optionalNum(dataQuality?.normalized?.slippage_bps ?? proposal?.execution_data?.estimated_slippage_bps);
  const fragilityScore = optionalNum(proposal?._fragility_score);
  const fraudRisk = optionalNum(proposal?.fraud_risk);
  const confidence = normalizeScore(proposal?.confidence);
  const flowSignal = String(proposal?._dex_flow?.flow_signal || "").toLowerCase();
  const fundingAvoid = proposal?._funding_rate?.avoid_new_longs === true;
  const curatedNegativeReasons = Array.isArray(proposal?.signal_snapshot?.negative_reasons) ? proposal.signal_snapshot.negative_reasons : [];
  const evidenceCount = Array.isArray(proposal?.evidence) ? proposal.evidence.length : 0;
  const category = proposal?.token?.category || "unknown";
  const categoryPct = categoryExposurePct(portfolio, category);

  if (!isEvmAddress(addr)) blockers.push("invalid_contract_address");
  if (!(price > 0)) blockers.push("missing_or_invalid_price");
  if (!(liquidity >= 100000)) blockers.push("liquidity_below_100k");
  if (!(marketCap >= 2000000)) blockers.push("market_cap_below_2m");
  if (!(volume24h >= 10000)) blockers.push("volume_24h_below_10k");
  if (!(slippageBps != null && slippageBps <= 300)) blockers.push("slippage_above_300bps_or_missing");
  if (fragilityScore != null && fragilityScore >= 70) blockers.push("fragility_score_high");
  if (fraudRisk != null && fraudRisk >= toNum(portfolio?.settings?.reject_fraud_risk_gte, SETTINGS_DEFAULTS.reject_fraud_risk_gte)) blockers.push("fraud_risk_high");
  if (confidence != null && confidence <= 55) blockers.push("confidence_too_low");
  if (flowSignal === "distribution" || flowSignal === "strong_distribution") blockers.push("bearish_order_flow");
  if (fundingAvoid) blockers.push("overcrowded_long_funding");
  if (curatedNegativeReasons.includes("smart_wallet_distribution")) blockers.push("curated_signal_distribution");
  if (curatedNegativeReasons.includes("overcrowded_long_funding")) blockers.push("curated_signal_overcrowded_long");
  if (evidenceCount < 2) blockers.push("insufficient_signal_evidence");
  if (categoryPct >= toNum(portfolio?.settings?.category_cap_pct, SETTINGS_DEFAULTS.category_cap_pct)) blockers.push("category_exposure_cap_reached");
  for (const blocker of dataQuality.blockers || []) blockers.push(`market_data_${blocker}`);

  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    metrics: {
      price,
      liquidity_usd: liquidity,
      market_cap_usd: marketCap,
      volume_24h_usd: volume24h,
      slippage_bps: slippageBps,
      fragility_score: fragilityScore,
      fraud_risk: fraudRisk,
      confidence,
      flow_signal: flowSignal || null,
      funding_avoid_new_longs: fundingAvoid,
      curated_negative_reasons: curatedNegativeReasons,
      evidence_count: evidenceCount,
      category_exposure_pct: categoryPct,
      data_quality_id: dataQuality.data_quality_id,
      data_quality_confidence: dataQuality.normalized?.confidence ?? null,
      data_quality_warnings: dataQuality.warnings || []
    }
  };
}

function deterministicRiskReject(proposal, gate, paperMode) {
  return decorateRiskReviewWithEvidence({
    decision: "reject",
    reason_summary: `Rejected by deterministic buy gate: ${gate.blockers.join(", ")}`,
    reason_codes: gate.blockers,
    risk_score: 100,
    checks_passed: [],
    checks_failed: gate.blockers,
    blocker_list: gate.blockers,
    deterministic_gate: true,
    paper_mode: Boolean(paperMode),
    gate_metrics: gate.metrics
  }, proposal);
}

function runRiskForCandidates(candidates, portfolio) {
  const approved = [];
  const rejected = [];

  const paperMode = Boolean(portfolio?.settings?.paper_mode);
  for (const candidate of candidates) {
    const proposal = deepClone(candidate);
    const marketDataQuality = buildMarketDataQuality(proposal, {
      evaluated_at: proposal?.created_at || proposal?.signal_snapshot?.generated_at || nowIso()
    });
    proposal.market_data_quality = marketDataQuality;
    proposal.market_data_quality_id = marketDataQuality.data_quality_id;
    proposal.market_data_quality_ref = buildMarketDataQualityRef(marketDataQuality, { context: "candidate_risk_review" });
    proposal.signal_snapshot = buildSignalSnapshotForToken({
      symbol: proposal?.token?.symbol,
      contract_address: proposal?.token?.contract_address,
      liquidity_data: proposal?.liquidity_data,
      market_data: proposal?.market_data,
      fraud_risk: proposal?.fraud_risk
    }, portfolio);
    const gate = deterministicBuyGate(proposal, portfolio);
    const risk = gate.ok
      ? decorateRiskReviewWithEvidence(runRiskDirect(proposal, paperMode), proposal)
      : deterministicRiskReject(proposal, gate, paperMode);
    const entry = { proposal, risk };

    const decision = String(risk?.decision || "").toLowerCase();
    const paperModeHandoff = portfolio?.settings?.paper_mode && decision === "paper_trade";
    const handoffToExecutor = decision === "approve_for_executor" || paperModeHandoff;

    recordRiskDecisionEvent(proposal, risk, portfolio, getTrainingContext(), handoffToExecutor);

    if (handoffToExecutor) {
      approved.push({
        ...proposal,
        _risk: risk,
        _risk_handoff_decision: decision,
        _score: computePositionScoreLike(proposal)
      });
    } else {
      rejected.push(entry);
    }
  }

  return { approved, rejected };
}

function findHeldPositionForProposal(portfolio, proposal) {
  const token = proposal?.token || {};
  const addr = cleanAddress(token.contract_address || proposal?.contract_address || "");
  const symbol = String(token.symbol || proposal?.symbol || "").trim().toLowerCase();
  return Object.values(portfolio?.positions || {}).find((pos) => {
    const posAddr = cleanAddress(pos?.contract_address || "");
    const posSymbol = String(pos?.symbol || "").trim().toLowerCase();
    return (addr && posAddr && addr === posAddr) || (symbol && posSymbol && symbol === posSymbol);
  }) || null;
}

function validateExitProposal(proposal, portfolio) {
  const blockers = [];
  const token = proposal?.token || {};
  const addr = cleanAddress(token.contract_address || proposal?.contract_address || "");
  const held = findHeldPositionForProposal(portfolio, proposal);
  const fraction = resolveExecutorExitFraction(proposal, {});

  if (!isEvmAddress(addr)) blockers.push("invalid_contract_address");
  if (!held) blockers.push("position_not_held");
  if (!(fraction > 0 && fraction <= 1)) blockers.push("invalid_exit_fraction");
  if (held && !(toNum(held.quantity, 0) > 0)) blockers.push("position_quantity_zero");
  if (held && !(toNum(held.current_price, 0) > 0)) blockers.push("position_price_missing");

  return {
    ok: blockers.length === 0,
    blockers,
    held,
    fraction
  };
}

function runRiskForExitCandidates(candidates, portfolio) {
  const approved = [];
  const rejected = [];
  const paperMode = Boolean(portfolio?.settings?.paper_mode);
  const approveDecision = paperMode ? "paper_trade" : "approve_for_executor";

  for (const proposal of candidates) {
    const gate = validateExitProposal(proposal, portfolio);
    const risk = gate.ok
      ? decorateRiskReviewWithEvidence({
          decision: approveDecision,
          reason_summary: "Exit reduces exposure on an existing held position.",
          reason_codes: ["valid_exit_reduces_position_risk"],
          risk_score: 0,
          checks_passed: ["position_held", "valid_exit_fraction"],
          checks_failed: [],
          blocker_list: [],
          deterministic_gate: true,
          approved_exit_fraction: gate.fraction
        }, proposal)
      : decorateRiskReviewWithEvidence({
          decision: "reject",
          reason_summary: `Rejected exit: ${gate.blockers.join(", ")}`,
          reason_codes: gate.blockers,
          risk_score: 100,
          checks_passed: [],
          checks_failed: gate.blockers,
          blocker_list: gate.blockers,
          deterministic_gate: true
        }, proposal);
    const entry = { proposal, risk };
    const handoffToExecutor = gate.ok;
    recordRiskDecisionEvent(proposal, risk, portfolio, getTrainingContext(), handoffToExecutor);

    if (handoffToExecutor) {
      approved.push({
        ...proposal,
        _risk: risk,
        _risk_handoff_decision: String(risk.decision || "").toLowerCase(),
        _score: computePositionScoreLike(proposal)
      });
    } else {
      rejected.push(entry);
    }
  }

  return { approved, rejected };
}

function runExecutorDirect(proposal, portfolio) {
  const paperMode = portfolio?.settings?.paper_mode ? "enabled" : "disabled";
  const systemPrompt = [
    "You are Executor, a crypto trade final-approval agent.",
    `Paper mode is ${paperMode}.`,
    "Validate the proposal and return STRICT JSON only — one object, no markdown.",
    `Allowed executor_decision values: "reject", "paper_trade", "approve_live", "reduce_size", "wait_for_entry", "monitor_only"`,
    `Response shape: {token, executor_decision, reason_summary, risk_checks[], execution_checks[], portfolio_checks[], approved_size_pct, approved_exit_fraction, max_slippage_bps, entry_status, stop_level, target_plan, paper_trade_ticket, live_execution_allowed, blocker_list[], follow_up_action}`,
    "Rules: do not originate trades. Preserve capital first. Reject malformed, stale, illiquid, or oversized proposals.",
    "If paper mode is enabled, prefer paper_trade over approve_live."
  ].join("\n");
  const userPrompt = `Validate this proposal:\n${JSON.stringify(proposal)}`;
  return callDirectJson("executor", systemPrompt, userPrompt, "EXECUTOR_DIRECT");
}

function runExecutorForActions(actions, portfolio, tradeKind) {
  const reviewed = [];

  for (const action of actions) {
    const proposal = buildExecutorProposal(action, portfolio, tradeKind);
    const review = runExecutorDirect(proposal, portfolio);
    recordExecutorDecisionEvent({ action, proposal, review }, portfolio, getTrainingContext(), tradeKind);
    reviewed.push({ action, proposal, review, tradeKind });
  }

  return reviewed;
}

function executorDecision(review) {
  return String(review?.executor_decision ?? review?.decision ?? "").toLowerCase();
}

function executorAllowsTrade(review) {
  return ["paper_trade", "approve_live", "reduce_size"].includes(executorDecision(review));
}

function resolveExecutorAllocation(action, review, portfolio) {
  const decision = executorDecision(review);
  const equity = equityUsd(portfolio);
  let allocationUsd = toNum(action.allocation_usd, 0);

  const approvedSizePct = toNum(review?.approved_size_pct, 0);
  if (approvedSizePct > 0) {
    allocationUsd = Math.min(allocationUsd, equity * (approvedSizePct / 100));
  }

  if (decision === "reduce_size") {
    allocationUsd *= 0.5;
  }

  return allocationUsd;
}

function buildPositionSizingDecision(action, portfolio, tradeKind = "buy") {
  const settings = portfolio?.settings || SETTINGS_DEFAULTS;
  const policy = _cycleRegimePolicy || regimePolicy(portfolio?.stats?.market_regime || "neutral", settings);
  const equity = equityUsd(portfolio);
  const candidate = action?.candidate || action?.to_candidate || action || {};
  const token = candidate?.token || action?.token || {};
  const symbol = token.symbol || action?.symbol || action?.from_symbol || "unknown";
  const liquidity = toNum(candidate?.liquidity_data?.liquidity_usd ?? action?.liquidity_data?.liquidity_usd, 0);
  const fraudRisk = toNum(candidate?.fraud_risk, 0);
  const slippageBps = toNum(candidate?.execution_data?.estimated_slippage_bps, 0);
  const drawdown = toNum(portfolio?.stats?.max_drawdown_pct, 0);
  const reasonCodes = [];
  const blockers = [];

  const regimeMultiplier = policy.regime === "risk_on" ? 1.3 : policy.regime === "risk_off" ? 0.4 : 0.85;
  const liquidityMultiplier = liquidity <= 0 ? 0.75 : liquidity < 100000 ? 0.65 : 1;
  const performanceMultiplier = policy.reason_codes?.includes("negative_recent_profit_factor")
    ? computeRecentPerformanceThrottleMultiplier(policy?.recent_performance?.profit_factor)
    : 1;
  const drawdownMultiplier = drawdown > 0.05 ? 0.7 : drawdown > 0.03 ? 0.85 : 1;
  const totalMultiplier = Math.min(1, regimeMultiplier * liquidityMultiplier * performanceMultiplier * drawdownMultiplier);

  if (policy.regime === "risk_off") reasonCodes.push("risk_off_size_reduction");
  else reasonCodes.push(`${policy.regime || "neutral"}_regime`);
  if (liquidity <= 0) reasonCodes.push("missing_liquidity");
  else if (liquidity < 100000) reasonCodes.push("liquidity_thin");
  else reasonCodes.push("liquidity_sufficient");
  if (performanceMultiplier < 1) reasonCodes.push("negative_setup_expectancy_warning");
  if (drawdownMultiplier < 1) reasonCodes.push("drawdown_size_reduction");
  if (fraudRisk >= settings.reject_fraud_risk_gte) blockers.push("fraud_risk_blocker");
  if (slippageBps > 150) reasonCodes.push("slippage_size_reduction");
  if (tradeKind === "buy" && !policy.allow_buys) blockers.push("policy_blocks_new_buys");

  const approvedPct = toNum(candidate?._risk?.approved_size_pct, 0) / 100;
  const basePct = approvedPct > 0 ? approvedPct : settings.risk_per_trade_pct;
  const recommendedPct = Math.min(basePct * totalMultiplier, settings.max_position_pct);
  let maxAllocationUsd = Math.min(toNum(action?.allocation_usd, equity * recommendedPct), equity * recommendedPct, portfolio.cash_usd);

  if (tradeKind === "buy") {
    const categoryPct = categoryExposurePct(portfolio, token.category || "unknown");
    const categoryHeadroom = Math.max(0, settings.category_cap_pct - categoryPct);
    maxAllocationUsd = Math.min(maxAllocationUsd, equity * categoryHeadroom);
    if (maxAllocationUsd < settings.min_trade_usd) blockers.push("below_min_trade_usd");
  }

  const rawExitFraction = toNum(action?.suggested_exit_fraction ?? action?.fraction, toNum(action?._risk?.approved_exit_fraction, 0.5));
  const recommendedExitFraction = Math.max(0.1, Math.min(1, rawExitFraction * (policy.tighten_stops ? 1.1 : 1)));
  const decision = {
    symbol,
    contract_address: token.contract_address || action?.contract_address || null,
    action: tradeKind === "exit" ? "trim" : tradeKind,
    recommended_size_pct: Number((recommendedPct * 100).toFixed(4)),
    recommended_exit_fraction: Number(recommendedExitFraction.toFixed(4)),
    max_allocation_usd: Number(Math.max(0, maxAllocationUsd).toFixed(2)),
    sizing_reason_codes: reasonCodes,
    risk_adjustments: {
      regime_multiplier: regimeMultiplier,
      liquidity_multiplier: liquidityMultiplier,
      performance_multiplier: performanceMultiplier,
      drawdown_multiplier: drawdownMultiplier
    },
    blocker_list: blockers
  };
  recordAuxiliaryEvent("position_sizing_decision", "position_sizer", portfolio, { decision, action });
  return decision;
}

function applySizingToBuyAction(action, sizing) {
  if (sizing.blocker_list?.length) return null;
  return {
    ...action,
    allocation_usd: Math.min(toNum(action.allocation_usd, 0), toNum(sizing.max_allocation_usd, 0)),
    position_sizing: sizing
  };
}

function applySizingToExitAction(action, sizing) {
  if (sizing.blocker_list?.includes("fraud_risk_blocker")) return null;
  return {
    ...action,
    suggested_exit_fraction: toNum(sizing.recommended_exit_fraction, action.suggested_exit_fraction),
    position_sizing: sizing
  };
}

function buildPaperTradeTicket(candidate, allocationUsd, review, reason) {
  const marketDataQuality = candidate?.market_data_quality || buildMarketDataQuality(candidate, {
    evaluated_at: candidate?.created_at || nowIso()
  });
  const assumedEntry = toNum(marketDataQuality.normalized?.price_usd, toNum(candidate?.market_data?.current_price, 0));
  const ticket = {
    created_at: nowIso(),
    assumed_entry: assumedEntry,
    stop: saneStopPrice(candidate?.invalidation_price, assumedEntry),
    targets: deepClone(sanitizeTargets(candidate?.targets, assumedEntry)),
    thesis_summary: candidate?.summary ?? candidate?.thesis_summary ?? null,
    edge_source: candidate?.edge_source ?? null,
    setup_type: candidate?.setup_type ?? null,
    liquidity_usd: toNum(marketDataQuality.normalized?.liquidity_usd, 0),
    spread_bps: toNum(marketDataQuality.normalized?.spread_bps, 0),
    reason,
    allocation_usd: allocationUsd,
    executor_decision: executorDecision(review),
    approved_size_pct: toNum(review?.approved_size_pct, 0),
    position_sizing: candidate?.position_sizing || null,
    max_slippage_bps: toNum(review?.max_slippage_bps, 0),
    follow_up_action: review?.follow_up_action ?? null,
    data_quality_id: marketDataQuality.data_quality_id,
    market_data_quality_ref: candidate?.market_data_quality_ref || buildMarketDataQualityRef(marketDataQuality, { context: "paper_trade_ticket" }),
    market_data_quality: deepClone(marketDataQuality),
    token_risk_scan_id: candidate?.token_risk_scan_id || null,
    token_risk_scan_ref: candidate?.token_risk_scan_ref || null,
    token_risk_scan: candidate?.token_risk_scan ? deepClone(candidate.token_risk_scan) : null
  };
  applyEvidenceMetadata(ticket, candidate);
  return ticket;
}

function buildPaperFillExecution(trade) {
  const side = String(trade?.side || "").toLowerCase() === "sell" ? "sell" : "buy";
  const settings = trade?.settings || SETTINGS_DEFAULTS;
  const quotedPrice = toNum(trade?.quoted_price, toNum(trade?.price, 0));
  const defaultSlippageBps = side === "sell" ? 75 : 50;
  const slippageBps = Math.max(0, toNum(
    trade?.slippage_bps_applied,
    toNum(trade?.execution_data?.estimated_slippage_bps, defaultSlippageBps)
  ));
  const feeBps = Math.max(0, toNum(trade?.fee_bps_applied, toNum(settings?.fee_bps_per_side, SETTINGS_DEFAULTS.fee_bps_per_side)));
  const fillPrice = quotedPrice > 0
    ? quotedPrice * (side === "sell" ? (1 - slippageBps / 10000) : (1 + slippageBps / 10000))
    : 0;
  const requestedNotional = side === "sell"
    ? toNum(trade?.gross_proceeds_usd, toNum(trade?.proceeds_usd, toNum(trade?.quantity, 0) * quotedPrice))
    : toNum(trade?.cost_usd, toNum(trade?.paper_trade_ticket?.allocation_usd, toNum(trade?.quantity, 0) * quotedPrice));
  const requestedQuantity = toNum(trade?.quantity, quotedPrice > 0 ? requestedNotional / quotedPrice : 0);
  const quantity = side === "sell"
    ? requestedQuantity
    : toNum(trade?.quantity, fillPrice > 0 ? requestedNotional / fillPrice : 0);
  const filledNotionalUsd = side === "sell" ? quantity * fillPrice : requestedNotional;
  const feeUsd = filledNotionalUsd * feeBps / 10000;
  const slippageUsd = Math.abs(quantity * (fillPrice - quotedPrice));

  const execution = {
    model_version: PAPER_FILL_MODEL_VERSION,
    decision: "filled",
    rejection_reason: null,
    side,
    arrival_price: quotedPrice,
    decision_price: quotedPrice,
    quote_price: quotedPrice,
    simulated_fill_price: fillPrice,
    fill_price: fillPrice,
    requested_notional_usd: requestedNotional,
    requested_quantity: requestedQuantity,
    filled_notional_usd: filledNotionalUsd,
    quantity,
    fill_ratio: 1,
    rejection_ratio: 0,
    fee_bps: feeBps,
    slippage_bps: slippageBps,
    fee_usd: feeUsd,
    slippage_usd: slippageUsd,
    time_to_fill_ms: 0
  };
  const executionControl = buildLiquidityExecutionControls(trade, execution, {
    modelVersion: "paper-liquidity-execution-controls-v1"
  });
  return {
    ...execution,
    execution_control_id: executionControl.control_id,
    quote_id: executionControl.quote_id,
    liquidity_execution_control: executionControl
  };
}

function attachPaperOrderLifecycle(trade, options = {}) {
  if (!trade) return null;
  const context = getTrainingContext() || {};
  trade.strategy_version = trade.strategy_version || PAPER_ORDER_STRATEGY_VERSION;
  const execution = options.execution || trade.simulated_execution || buildPaperFillExecution(trade);
  const order = createOrderLifecycleRecord({
    mode: "paper",
    strategyVersion: trade.strategy_version,
    trade,
    execution,
    planned_at: trade.ts,
    signal_snapshot_ref: options.signal_snapshot_ref || (_cycleSignalSnapshot ? {
      event_type: "signal_snapshot",
      cycle_id: context.cycle_id || null,
      pipeline_run_id: context.pipeline_run_id || null
    } : null),
    risk_decision_ref: options.risk_decision_ref || trade.risk_decision_ref || trade.paper_trade_ticket?.risk_decision_ref || (trade.candidate_id ? {
      event_type: "risk_decision",
      candidate_id: trade.candidate_id,
      cycle_id: context.cycle_id || null
    } : null),
    sizing_decision_ref: options.sizing_decision_ref || trade.paper_trade_ticket?.position_sizing || null,
    portfolio_mutation_ref: {
      type: "portfolio_json",
      collection: trade.side === "sell" ? "closed_trades/action_history" : "action_history",
      trade_id: trade.trade_id || null,
      position_id: trade.position_id || null,
      mutation_applied: true
    },
    context: {
      pipeline_run_id: context.pipeline_run_id || null,
      cycle_id: context.cycle_id || null,
      cycle_index: context.cycle_index ?? null,
      token_risk_scan_id: trade.token_risk_scan_id || trade.paper_trade_ticket?.token_risk_scan_id || null
    },
    evidence_packet_id: trade.evidence_packet_id || trade.paper_trade_ticket?.evidence_packet_id || null,
    evidence_summary: trade.evidence_summary || trade.paper_trade_ticket?.evidence_summary || null,
    evidence_refs: trade.evidence_refs || trade.paper_trade_ticket?.evidence_refs || []
  });
  trade.order_id = order.order_id;
  trade.order_ids = [order.order_id];
  trade.order_lifecycle = order;
  trade.simulated_execution = execution;
  return order;
}

// Update held position prices using the token universe fetched this cycle.
// Prevents positions from being stuck at their entry price indefinitely —
// accurate prices are required for Harvest to make meaningful exit decisions.
// Per-portfolio mark-deviation limit (falls back to the default if unset).
function markDeviationLimit(portfolio) {
  return toNum(portfolio?.settings?.max_mark_deviation_ratio, SETTINGS_DEFAULTS.max_mark_deviation_ratio);
}

// Apply a new market price to a held position, but REJECT it if it diverges beyond `maxDev`
// from the authoritative e3d anchor (last_market_snapshot, falling back to the existing mark /
// entry price). This is the guard that prevents a divergent third-party tick (e.g. a DexScreener
// price for the same address) from silently overwriting the e3d-based mark and tripping targets.
// Returns true if the mark was applied, false if rejected.
function applyPositionMark(pos, newPrice, source, maxDev = SETTINGS_DEFAULTS.max_mark_deviation_ratio) {
  const price = toNum(newPrice, 0);
  if (!(price > 0)) return false;
  const anchor = toNum(pos?.last_market_snapshot?.market_data?.current_price,
                  toNum(pos?.current_price, toNum(pos?.avg_entry_price, 0)));
  if (anchor > 0 && maxDev > 0) {
    const ratio = price / anchor;
    if (ratio > maxDev || ratio < 1 / maxDev) {
      log("position_mark_rejected", {
        symbol: pos?.symbol, source, rejected_price: price, anchor, ratio: +ratio.toFixed(2)
      });
      return false;
    }
  }
  pos.current_price = price;
  pos.market_value_usd = pos.quantity * price;
  pos.peak_price = Math.max(pos.peak_price ?? price, price);
  pos.trough_price = Math.min(pos.trough_price ?? price, price);
  pos.last_updated_at = nowIso();
  return true;
}

// Reconcile any latched/stale mark back to the authoritative e3d snapshot so a divergent value
// cannot persist once a token drops out of the live feeds (the "freeze" failure mode). Run at the
// choke point right before sell decisions so targets/stops are always evaluated against a trusted price.
function reconcilePositionMarks(portfolio) {
  const maxDev = markDeviationLimit(portfolio);
  const resnapped = [];
  for (const pos of Object.values(portfolio?.positions || {})) {
    const anchor = toNum(pos?.last_market_snapshot?.market_data?.current_price, 0);
    const cur = toNum(pos?.current_price, 0);
    if (!(anchor > 0) || !(cur > 0) || !(maxDev > 0)) continue;
    const ratio = cur / anchor;
    if (ratio > maxDev || ratio < 1 / maxDev) {
      pos.current_price = anchor;
      pos.market_value_usd = pos.quantity * anchor;
      pos.last_updated_at = nowIso();
      resnapped.push({ symbol: pos.symbol, from: cur, to: anchor, ratio: +ratio.toFixed(2) });
    }
  }
  if (resnapped.length) log("position_mark_resnapped", { count: resnapped.length, positions: resnapped });
}

// Symbols that should track a peg (fiat, FX, or another asset) but slip past the hard
// NONTRADEABLE filter — e.g. RAI (a non-fiat-pegged stable, ~$3). For these, ANY material
// source disagreement is a bad feed rather than a trade: RAI was bought at $10.50 vs a real
// ~$3 (3.5x), which sailed under the old 5x band and stop-lossed for -$190. Hold them to a
// far tighter divergence band and refuse to trade them without independent corroboration.
// Extend this list as new soft-pegged offenders are found.
const PEG_SENSITIVE_SYMBOL_RE = /^(RAI|FLOAT|FPI|MIM|USTC|VAI|DOLA|MAI|ALUSD|DUSD|EURS|EURT|EUROC|AGEUR|XSGD|CADC|BIDR|IDRT)$/i;
function isPegSensitive(symbol, category) {
  if (/stable|peg|fiat|forex|\bfx\b/i.test(String(category || ""))) return true;
  return PEG_SENSITIVE_SYMBOL_RE.test(String(symbol || "").trim());
}

// Resolve the max allowed e3d-vs-reference divergence for a candidate. Peg-sensitive tokens
// get a far tighter band than general momentum tokens.
function sourceDivergenceLimitFor(symbol, category, portfolio) {
  const s = portfolio?.settings || {};
  if (isPegSensitive(symbol, category)) {
    return toNum(s.max_source_price_divergence_ratio_pegged,
                 SETTINGS_DEFAULTS.max_source_price_divergence_ratio_pegged);
  }
  return toNum(s.max_source_price_divergence_ratio,
               SETTINGS_DEFAULTS.max_source_price_divergence_ratio);
}

// Cross-source price validation at the candidate gate. e3d has mispriced tokens by 100-2000x — the
// SATA incident priced it at $0.00000796 vs a real ~$0.0015, and the pipeline trusted it blindly,
// "buying" a fictional 105M-token position. Before risk sees a candidate, corroborate e3d's price
// against an independent on-chain feed (DexScreener, via the same enrichment harvest already uses).
//
// Two failure modes this guards against:
//   1. Sources disagree beyond the symbol-aware band  -> drop (divergence).
//   2. No independent price exists at all             -> FAIL CLOSED for the mispricing-prone
//      population (peg-sensitive tokens + thin/unknown liquidity), where e3d misprices most often
//      and DexScreener is least likely to have a quote. The old code trusted e3d blindly here,
//      which is exactly how SATA/RAI-class entries got through. High-liquidity non-peg tokens are
//      still allowed when uncorroborated, since e3d is reliable for liquid majors and blocking them
//      all would starve the scout. Tagged on each candidate as `_price_validation`.
function validateCandidatePricesAgainstSources(candidates, portfolio) {
  if (!Array.isArray(candidates) || !candidates.length) return candidates || [];
  const liqFloor = toNum(portfolio?.settings?.require_independent_price_below_liquidity_usd,
                         SETTINGS_DEFAULTS.require_independent_price_below_liquidity_usd);
  const survivors = [];
  let droppedDivergence = 0, droppedNoCorroboration = 0, allowedUnvalidated = 0;
  for (const c of candidates) {
    const candidate = { ...c };
    const symbol = c?.token?.symbol;
    const category = c?.token?.category;
    const e3dPrice = toNum(c?.market_data?.current_price, 0);
    const liquidity = toNum(c?.liquidity_data?.liquidity_usd, toNum(c?.liquidity_usd, 0));
    const pegSensitive = isPegSensitive(symbol, category);
    const maxDiv = sourceDivergenceLimitFor(symbol, category, portfolio);
    const addr = cleanAddress(c?.token?.contract_address || c?.address || "");
    let refPrice = 0, refSource = null;
    if (addr && _cycleQuantContext) {
      try {
        const { flow } = enrichCandidateQuant(addr, symbol, _cycleQuantContext);
        if ((flow?.price_usd ?? 0) > 0) { refPrice = flow.price_usd; refSource = "dexscreener"; }
      } catch { /* tolerate — handled as missing corroboration below */ }
    }

    // Case 1: we have both prices — enforce the symbol-aware divergence band.
    if (e3dPrice > 0 && refPrice > 0 && maxDiv > 0) {
      const ratio = e3dPrice / refPrice;
      const ok = !(ratio > maxDiv || ratio < 1 / maxDiv);
      candidate._price_validation = { e3d_price: e3dPrice, ref_price: refPrice, ref_source: refSource,
                                      ratio: +ratio.toFixed(2), max_div: maxDiv, peg_sensitive: pegSensitive, ok };
      if (!ok) {
        droppedDivergence++;
        log("candidate_price_divergence_rejected", { symbol, address: addr, ...candidate._price_validation });
        continue;
      }
      survivors.push(candidate);
      continue;
    }

    // Case 2: no independent corroboration. Fail closed for the mispricing-prone population.
    const thinLiquidity = liqFloor > 0 && (!(liquidity > 0) || liquidity < liqFloor);
    const requireCorroboration = pegSensitive || thinLiquidity;
    candidate._price_validation = { e3d_price: e3dPrice, ref_price: refPrice || null, ref_source: refSource,
                                    ratio: null, max_div: maxDiv, peg_sensitive: pegSensitive,
                                    liquidity_usd: liquidity || null, note: "no_independent_price",
                                    ok: !requireCorroboration };
    if (requireCorroboration) {
      droppedNoCorroboration++;
      log("candidate_no_corroboration_rejected", {
        symbol, address: addr,
        reason: pegSensitive ? "peg_sensitive_requires_independent_price" : "thin_liquidity_requires_independent_price",
        ...candidate._price_validation
      });
      continue;
    }
    allowedUnvalidated++;
    survivors.push(candidate);
  }
  if (droppedDivergence || droppedNoCorroboration || allowedUnvalidated) {
    log("candidate_price_validation_summary", {
      input: candidates.length, kept: survivors.length,
      dropped_divergence: droppedDivergence,
      dropped_no_corroboration: droppedNoCorroboration,
      allowed_unvalidated: allowedUnvalidated
    });
  }
  return survivors;
}

function refreshPositionPrices(portfolio, tokenUniverse) {
  if (!Array.isArray(tokenUniverse) || !tokenUniverse.length) return;
  const priceMap = new Map();
  for (const t of tokenUniverse) {
    const addr = cleanAddress(t.address || "");
    if (addr && (t.price_usd ?? 0) > 0) priceMap.set(addr, t);
  }
  const refreshed = [];
  for (const pos of Object.values(portfolio.positions)) {
    const addr = cleanAddress(pos.contract_address || "");
    if (!addr) continue;
    const t = priceMap.get(addr);
    if (!t || !((t.price_usd ?? 0) > 0)) continue;
    const oldPrice = pos.current_price;
    if (!applyPositionMark(pos, t.price_usd, "token_universe", markDeviationLimit(portfolio))) continue;
    if ((t.liquidity_usd ?? 0) > 0) pos.liquidity_usd = t.liquidity_usd;
    refreshed.push({ symbol: pos.symbol, old_price: oldPrice, new_price: t.price_usd });
  }
  if (refreshed.length) log("position_prices_refreshed", { count: refreshed.length, positions: refreshed });
}

function updateHoldingsFromScout(portfolio, updates) {
  const byAddr = new Map();
  for (const u of updates) {
    if (u.contract_address) byAddr.set(u.contract_address.toLowerCase(), u);
  }

  for (const pos of Object.values(portfolio.positions)) {
    const update = byAddr.get((pos.contract_address || "").toLowerCase());
    if (!update) continue;

    pos.current_price = toNum(update?.market_data?.current_price, pos.current_price || pos.avg_entry_price);
    pos.market_value_usd = pos.quantity * pos.current_price;
    pos.last_updated_at = nowIso();
    pos.category = update.category || pos.category || "unknown";
    pos.score = computePositionScoreLike(update);
    pos.fraud_risk = toNum(update.fraud_risk, pos.fraud_risk || 0);
    pos.liquidity_usd = toNum(update?.liquidity_data?.liquidity_usd, pos.liquidity_usd || 0);
    pos.liquidity_quality = toNum(update.liquidity_quality, pos.liquidity_quality || 0);
    pos.last_market_snapshot = {
      market_data: update.market_data || {},
      liquidity_data: update.liquidity_data || {},
      execution_data: update.execution_data || {},
      opportunity_score: update.opportunity_score,
      conviction_score: update.conviction_score,
      liquidity_quality: update.liquidity_quality,
      fraud_risk: update.fraud_risk,
      why_now: update.why_now,
      risks: update.risks
    };
  }
}

// Symbols that should never be held as trading positions.
// If one ends up in the portfolio (Scout hallucinated it, rotation logic opened it, etc.)
// it gets force-exited here before any further cycle logic runs.
const FORCE_EXIT_PATTERN = NONTRADEABLE_RE;

function evaluateSellActions(portfolio) {
  const actions = [];
  const targetPct = portfolio.settings.target_partial_pct;

  // Never evaluate stops/targets against a divergent (corrupt or latched-stale) mark: snap any
  // position whose price drifted beyond the deviation limit back to the authoritative e3d anchor first.
  reconcilePositionMarks(portfolio);

  for (const pos of Object.values(portfolio.positions)) {
    const price = toNum(pos.current_price, 0);
    if (!(price > 0)) continue;

    // Force-exit stablecoins and wrapped/base assets that slipped into the portfolio.
    // These provide no trading alpha and consume position slots.
    if (FORCE_EXIT_PATTERN.test(pos.symbol || "")) {
      actions.push({ type: "sell", symbol: pos.symbol, fraction: 1.0, reason: "non_tradeable_force_exit" });
      continue;
    }

    if (price <= toNum(pos.stop_price, 0)) {
      actions.push({
        type: "sell",
        symbol: pos.symbol,
        fraction: 1.0,
        reason: "stop_loss"
      });
      continue;
    }

    if (toNum(pos.fraud_risk, 0) >= portfolio.settings.reject_fraud_risk_gte) {
      actions.push({
        type: "sell",
        symbol: pos.symbol,
        fraction: 1.0,
        reason: "fraud_risk_breach"
      });
      continue;
    }

    if (!pos.partials_taken || typeof pos.partials_taken !== "object") {
      pos.partials_taken = { target_1: false, target_2: false, target_3: false };
    }

    if (!pos.partials_taken?.target_1 && targetHit(price, pos.targets?.target_1)) {
      actions.push({
        type: "sell",
        symbol: pos.symbol,
        fraction: targetPct,
        reason: "target_1"
      });
      pos.partials_taken.target_1 = true;
    }

    if (!pos.partials_taken?.target_2 && targetHit(price, pos.targets?.target_2)) {
      actions.push({
        type: "sell",
        symbol: pos.symbol,
        fraction: targetPct,
        reason: "target_2"
      });
      pos.partials_taken.target_2 = true;
    }

    if (!pos.partials_taken?.target_3 && targetHit(price, pos.targets?.target_3)) {
      actions.push({
        type: "sell",
        symbol: pos.symbol,
        fraction: targetPct,
        reason: "target_3"
      });
      pos.partials_taken.target_3 = true;
    }
  }

  return actions;
}

function executeSell(portfolio, action) {
  const pos = portfolio.positions[action.symbol];
  if (!pos) return null;

  const positionBefore = deepClone(pos);
  const fraction = Math.max(0, Math.min(1, toNum(action.fraction, 0)));
  const qty = pos.quantity * fraction;
  if (!(qty > 0)) return null;

  const execution = buildPaperFillExecution({
    side: "sell",
    price: pos.current_price,
    quoted_price: pos.current_price,
    quantity: qty,
    execution_data: action?.execution_data || pos?.last_market_snapshot?.execution_data || null,
    settings: portfolio?.settings || SETTINGS_DEFAULTS
  });
  const grossProceeds = toNum(execution?.filled_notional_usd, qty * pos.current_price);
  const proceeds = Math.max(0, grossProceeds - toNum(execution?.fee_usd, 0));
  const costPortion = pos.cost_basis_usd * fraction;
  const pnl = proceeds - costPortion;

  portfolio.cash_usd += proceeds;
  pos.quantity -= qty;
  pos.cost_basis_usd -= costPortion;
  pos.market_value_usd = pos.quantity * pos.current_price;
  pos.last_updated_at = nowIso();

  const trade = {
    ts: nowIso(),
    side: "sell",
    symbol: pos.symbol,
    contract_address: pos.contract_address,
    category: pos.category || "unknown",
    reason: action.reason,
    quantity: qty,
    price: pos.current_price,
    quoted_price: toNum(execution?.quote_price, pos.current_price),
    fill_price: toNum(execution?.fill_price, pos.current_price),
    slippage_bps_applied: toNum(execution?.slippage_bps, 0),
    fee_bps_applied: toNum(execution?.fee_bps, 0),
    fee_usd: toNum(execution?.fee_usd, 0),
    slippage_usd: toNum(execution?.slippage_usd, 0),
    proceeds_usd: proceeds,
    gross_proceeds_usd: grossProceeds,
    net_proceeds_usd: proceeds,
    cost_portion_usd: costPortion,
    pnl_usd: pnl,
    fraction,
    trade_lifecycle: pos.quantity <= 1e-12 || pos.market_value_usd < 1 ? "close" : "partial_sell",
    opened_at: pos.opened_at || null,
    avg_entry_price: pos.avg_entry_price || null,
    candidate_id: pos.training_candidate_id || null,
    position_id: pos.training_position_id || null,
    trade_id: null
  };

  trade.trade_id = buildTradeId(trade, getTrainingContext());
  applyEvidenceMetadata(trade, action);
  const sellTokenRiskScan = buildPositionTokenRiskScan(pos, portfolio, {
    evaluated_at: trade.ts,
    side: "sell",
    trade_id: trade.trade_id,
    source_trade_id: trade.trade_id
  });
  if (sellTokenRiskScan) {
    attachTokenRiskScanMetadata(trade, sellTokenRiskScan, getTrainingContext());
    recordTokenRiskScanEvent(sellTokenRiskScan, portfolio, getTrainingContext(), {
      trade_id: trade.trade_id,
      position_id: trade.position_id,
      candidate_id: trade.candidate_id,
      trade_kind: "sell"
    });
  }
  attachPaperOrderLifecycle(trade, { execution });

  portfolio.closed_trades.push(trade);
  portfolio.action_history.push(trade);

  recordTradeEvent(trade, portfolio, getTrainingContext(), {
    trade_lifecycle: trade.trade_lifecycle,
    trade_status: "filled",
    position_closed: trade.trade_lifecycle === "close"
  });

  if (pos.quantity <= 1e-12 || pos.market_value_usd < 1) {
    recordOutcomeEvent(trade, positionBefore, portfolio, getTrainingContext());
    delete portfolio.positions[pos.symbol];
    setCooldown(portfolio, action.symbol, trade.reason || action.reason);
  }

  return trade;
}

function rankApprovedCandidates(approved, portfolio) {
  return approved
    .filter((c) => !portfolio.positions[c.token.symbol])
    .filter((c) => !isInCooldown(portfolio, c.token.symbol))
    .sort((a, b) => b._score - a._score);
}

function rankHeldPositions(portfolio) {
  return Object.values(portfolio.positions)
    .map((p) => ({
      ...p,
      _score: computePositionScore(p, portfolio.settings)
    }))
    .sort((a, b) => b._score - a._score);
}

function evaluateRotationActions(portfolio, approved) {
  const actions = [];
  const settings = portfolio.settings;
  const rankedCandidates = rankApprovedCandidates(approved, portfolio);
  const rankedHeld = rankHeldPositions(portfolio);

  if (!rankedCandidates.length || !rankedHeld.length) return actions;

  const bestCandidate = rankedCandidates[0];
  const weakestHeld = rankedHeld[rankedHeld.length - 1];
  const delta = bestCandidate._score - weakestHeld._score;

  if (delta < settings.rotation_threshold) return actions;

  actions.push({
    type: "rotate",
    from_symbol: weakestHeld.symbol,
    to_candidate: bestCandidate,
    sell_fraction: settings.rotation_sell_fraction,
    reason: "better_opportunity",
    score_delta: delta
  });

  return actions.slice(0, settings.max_rotations_per_cycle);
}

function executeRotation(portfolio, action, review = null) {
  const from = portfolio.positions[action.from_symbol];
  if (!from) return null;

  const sellTrade = executeSell(portfolio, {
    type: "sell",
    symbol: from.symbol,
    fraction: action.sell_fraction,
    reason: `rotation_out:${action.reason}`
  });

  if (!sellTrade) return null;

  const candidate = action.to_candidate;
  const equity = equityUsd(portfolio);
  const approvedPct = toNum(candidate?._risk?.approved_size_pct, 0) / 100;
  const desiredPct = approvedPct > 0 ? approvedPct : portfolio.settings.risk_per_trade_pct;
  const executorApprovedPct = toNum(review?.approved_size_pct, 0) / 100;
  const sizingPct = executorApprovedPct > 0 ? Math.min(desiredPct, executorApprovedPct) : desiredPct;
  const allocPct = Math.min(sizingPct, portfolio.settings.max_position_pct);

  let allocationUsd = Math.min(
    portfolio.cash_usd,
    equity * allocPct,
    sellTrade.proceeds_usd
  );
  if (action.position_sizing?.max_allocation_usd != null) {
    allocationUsd = Math.min(allocationUsd, toNum(action.position_sizing.max_allocation_usd, allocationUsd));
  }

  const categoryPct = categoryExposurePct(portfolio, candidate.token.category || "unknown");
  const remainingCategoryHeadroom =
    portfolio.settings.category_cap_pct - categoryPct;

  if (remainingCategoryHeadroom <= 0) return { sellTrade, buyTrade: null };

  allocationUsd = Math.min(
    allocationUsd,
    equity * remainingCategoryHeadroom
  );

  if (allocationUsd < portfolio.settings.min_trade_usd) {
    return { sellTrade, buyTrade: null };
  }

  const evaluationTs = nowIso();
  const rotationRiskDecision = evaluateRiskDecision({
    mode: "paper",
    enforcement_mode: "enforced",
    evaluated_at: evaluationTs,
    portfolio,
    intent: buildBuyRiskIntent(candidate, allocationUsd, "rotation"),
    analytics: buildPortfolioRiskAnalytics(portfolio, evaluationTs)
  });
  recordRiskEngineDecisionEvent(rotationRiskDecision, portfolio, getTrainingContext(), {
    candidate_id: candidate?.training_candidate_id || candidate?.token?.contract_address || candidate?.token?.symbol || null,
    proposed_allocation_usd: allocationUsd,
    trade_kind: "rotation"
  });
  if (rotationRiskDecision.decision === "block") return { sellTrade, buyTrade: null };

  const rotationTokenRiskScan = buildCandidateTokenRiskScan(candidate, portfolio, {
    evaluated_at: evaluationTs,
    mode: "paper",
    side: "buy",
    risk_decision_id: rotationRiskDecision.risk_decision_id,
    risk_decision_ref: buildRiskDecisionRef(rotationRiskDecision, getTrainingContext()),
    signal_snapshot_ref: candidate?.signal_snapshot || null
  });
  attachTokenRiskScanMetadata(candidate, rotationTokenRiskScan, getTrainingContext());
  recordTokenRiskScanEvent(rotationTokenRiskScan, portfolio, getTrainingContext(), {
    candidate_id: candidate?.training_candidate_id || candidate?.token?.contract_address || candidate?.token?.symbol || null,
    position_id: candidate?.training_position_id || null,
    trade_kind: "rotation"
  });

  const rotationTicket = buildPaperTradeTicket(
    { ...candidate, position_sizing: action.position_sizing || null },
    allocationUsd,
    review,
    `rotation_in:${action.reason}`
  );
  rotationTicket.rotation_from_symbol = action.from_symbol;
  rotationTicket.rotation_score_delta = toNum(action.score_delta, 0);

  const buyTrade = openPosition(portfolio, candidate, allocationUsd, `rotation_in:${action.reason}`, {
    strategyVersion: PAPER_ORDER_STRATEGY_VERSION,
    paperTradeTicket: rotationTicket,
    riskDecision: rotationRiskDecision,
    tokenRiskScan: rotationTokenRiskScan
  });
  if (buyTrade) {
    attachRiskDecisionMetadata(buyTrade, rotationRiskDecision, getTrainingContext());
    attachPaperOrderLifecycle(buyTrade, { risk_decision_ref: buyTrade.risk_decision_ref });
  }

  return { sellTrade, buyTrade };
}

function openPosition(portfolio, candidate, allocationUsd, reason = "buy", options = {}) {
  const price = toNum(candidate?.market_data?.current_price, 0);
  if (!(price > 0)) return null;
  if (allocationUsd < portfolio.settings.min_trade_usd) return null;

  const execution = buildPaperFillExecution({
    side: "buy",
    price,
    quoted_price: price,
    cost_usd: allocationUsd,
    paper_trade_ticket: options.paperTradeTicket || null,
    execution_data: candidate?.execution_data || null,
    settings: portfolio?.settings || SETTINGS_DEFAULTS
  });
  const quantity = toNum(execution?.quantity, 0);
  const grossCostUsd = toNum(execution?.filled_notional_usd, allocationUsd);
  const feeUsd = toNum(execution?.fee_usd, 0);
  const totalCashDebitUsd = grossCostUsd + feeUsd;
  if (!(quantity > 0) || !(grossCostUsd > 0)) return null;
  if (portfolio.cash_usd < totalCashDebitUsd) return null;

  const symbol = candidate.token.symbol;
  const strategyVersion = options.strategyVersion || candidate?.strategy_version || PAPER_ORDER_STRATEGY_VERSION;
  const stopPrice = saneStopPrice(candidate.invalidation_price, price);
  const targets = sanitizeTargets(candidate.targets, price);

  // Guard: don't open a new position slot when already at the limit
  if (!portfolio.positions[symbol] && Object.keys(portfolio.positions).length >= portfolio.settings.max_open_positions) {
    return null;
  }
  const context = getTrainingContext();
  const training = ensureCandidateTrainingMetadata(candidate, context);
  const tokenRiskScan = options.tokenRiskScan || options.paperTradeTicket?.token_risk_scan || candidate?.token_risk_scan || null;

  portfolio.cash_usd -= totalCashDebitUsd;

  const existing = portfolio.positions[symbol];
  if (existing) {
    const totalCost = existing.cost_basis_usd + totalCashDebitUsd;
    const totalQty = existing.quantity + quantity;

    existing.quantity = totalQty;
    existing.cost_basis_usd = totalCost;
    existing.avg_entry_price = totalCost / totalQty;
    existing.current_price = price;
    existing.market_value_usd = totalQty * price;
    existing.peak_price = Math.max(existing.peak_price ?? existing.avg_entry_price, price);
    existing.trough_price = Math.min(existing.trough_price ?? existing.avg_entry_price, price);
    existing.stop_price = stopPrice;
    existing.targets = targets;
    existing.score = candidate._score ?? computePositionScoreLike(candidate);
    existing.category = candidate.token.category || existing.category || "unknown";
    existing.strategy_version = strategyVersion;
    existing.last_updated_at = nowIso();
    existing.training_candidate_id = existing.training_candidate_id || training.candidate_id;
    existing.training_position_id = existing.training_position_id || training.position_id;
    if (tokenRiskScan?.token_risk_scan_id) {
      existing.token_risk_scan_id = tokenRiskScan.token_risk_scan_id;
      existing.token_risk_scan_ref = buildTokenRiskScanRef(tokenRiskScan, context);
      existing.token_risk_scan = deepClone(tokenRiskScan);
    }
    existing.last_market_snapshot = {
      market_data: deepClone(candidate.market_data || {}),
      liquidity_data: deepClone(candidate.liquidity_data || {}),
      execution_data: deepClone(candidate.execution_data || {})
    };
  } else {
    portfolio.positions[symbol] = {
      symbol,
      contract_address: candidate.token.contract_address,
      category: candidate.token.category || "unknown",
      quantity,
      avg_entry_price: totalCashDebitUsd / quantity,
      cost_basis_usd: totalCashDebitUsd,
      current_price: price,
      market_value_usd: quantity * price,
      peak_price: price,
      trough_price: price,
      stop_price: stopPrice,
      targets: deepClone(targets),
      partials_taken: {
        target_1: false,
        target_2: false,
        target_3: false
      },
      score: candidate._score ?? computePositionScoreLike(candidate),
      fraud_risk: toNum(candidate.fraud_risk, 0),
      liquidity_usd: toNum(candidate?.liquidity_data?.liquidity_usd, 0),
      liquidity_quality: toNum(candidate.liquidity_quality, 0),
      strategy_version: strategyVersion,
      opened_at: nowIso(),
      last_updated_at: nowIso(),
      training_candidate_id: training.candidate_id,
      training_position_id: training.position_id,
      token_risk_scan_id: tokenRiskScan?.token_risk_scan_id || null,
      token_risk_scan_ref: tokenRiskScan?.token_risk_scan_id ? buildTokenRiskScanRef(tokenRiskScan, context) : null,
      token_risk_scan: tokenRiskScan ? deepClone(tokenRiskScan) : null,
      last_market_snapshot: {
        market_data: deepClone(candidate.market_data || {}),
        liquidity_data: deepClone(candidate.liquidity_data || {}),
        execution_data: deepClone(candidate.execution_data || {})
      }
    };
  }

  const trade = {
    ts: nowIso(),
    side: "buy",
    symbol,
    contract_address: candidate.token.contract_address,
    reason,
    quantity,
    price,
    quoted_price: toNum(execution?.quote_price, price),
    fill_price: toNum(execution?.fill_price, price),
    slippage_bps_applied: toNum(execution?.slippage_bps, 0),
    fee_bps_applied: toNum(execution?.fee_bps, 0),
    fee_usd: feeUsd,
    slippage_usd: toNum(execution?.slippage_usd, 0),
    cost_usd: grossCostUsd,
    gross_notional_usd: grossCostUsd,
    cash_debit_usd: totalCashDebitUsd,
    score: candidate._score ?? computePositionScoreLike(candidate),
    trade_lifecycle: "open",
    strategy_version: strategyVersion,
    candidate_id: training.candidate_id,
    position_id: training.position_id,
    trade_id: null
  };

  trade.trade_id = buildTradeId(trade, context);
  if (options.paperTradeTicket) {
    trade.paper_trade_ticket = deepClone(options.paperTradeTicket);
  }
  applyEvidenceMetadata(trade, candidate);
  applyEvidenceMetadata(trade, trade.paper_trade_ticket || {});
  if (tokenRiskScan) {
    attachTokenRiskScanMetadata(trade, tokenRiskScan, context);
  }
  if (options.riskDecision) {
    attachRiskDecisionMetadata(trade, options.riskDecision, context);
  }
  attachPaperOrderLifecycle(trade, { execution });

  portfolio.action_history.push(trade);
  recordTradeEvent(trade, portfolio, context, {
    trade_lifecycle: trade.trade_lifecycle,
    trade_status: "filled",
    position_closed: false
  });
  return trade;
}

function evaluateBuyActions(portfolio, approved) {
  const actions = [];
  const settings = portfolio.settings;

  const ranked = rankApprovedCandidates(approved, portfolio);
  const openPositions = Object.keys(portfolio.positions).length;

  if (openPositions >= settings.max_open_positions) return actions;

  let remainingSlots = settings.max_open_positions - openPositions;
  let buysUsed = 0;

  for (const c of ranked) {
    if (buysUsed >= settings.max_buys_per_cycle) break;
    if (remainingSlots <= 0) break;

    const eq = equityUsd(portfolio);
    const approvedPct = toNum(c?._risk?.approved_size_pct, 0) / 100;
    const desiredPct = approvedPct > 0 ? approvedPct : settings.risk_per_trade_pct;
    const allocPct = Math.min(desiredPct, settings.max_position_pct);

    let allocationUsd = Math.min(portfolio.cash_usd, eq * allocPct);
    if (allocationUsd < settings.min_trade_usd) continue;

    const category = c.token.category || "unknown";
    const categoryPct = categoryExposurePct(portfolio, category);
    const remainingCategoryHeadroom = settings.category_cap_pct - categoryPct;
    if (remainingCategoryHeadroom <= 0) continue;

    allocationUsd = Math.min(allocationUsd, eq * remainingCategoryHeadroom);
    if (allocationUsd < settings.min_trade_usd) continue;

    actions.push({
      type: "buy",
      candidate: c,
      allocation_usd: allocationUsd,
      reason: "new_position"
    });

    buysUsed += 1;
    remainingSlots -= 1;
  }

  return actions;
}

function computePortfolioStats(portfolio) {
  let unrealized = 0;
  let marketValue = 0;

  for (const pos of Object.values(portfolio.positions)) {
    const mv = toNum(pos.market_value_usd, 0);
    const cb = toNum(pos.cost_basis_usd, 0);
    marketValue += mv;
    unrealized += mv - cb;
  }

  const realized = portfolio.closed_trades.reduce((sum, t) => sum + toNum(t.pnl_usd, 0), 0);
  const equity = toNum(portfolio.cash_usd, 0) + marketValue;
  const peak = Math.max(toNum(portfolio.stats.peak_equity_usd, equity), equity);
  const drawdownPct = peak > 0 ? (peak - equity) / peak : 0;
  const maxDrawdown = Math.max(toNum(portfolio.stats.max_drawdown_pct, 0), drawdownPct);

  portfolio.stats.realized_pnl_usd = realized;
  portfolio.stats.unrealized_pnl_usd = unrealized;
  portfolio.stats.equity_usd = equity;
  portfolio.stats.peak_equity_usd = peak;
  portfolio.stats.max_drawdown_pct = maxDrawdown;

  return deepClone(portfolio.stats);
}

function buildSummary(portfolio, approvedCount, rejectedCount) {
  return {
    cash_usd: portfolio.cash_usd,
    positions: Object.keys(portfolio.positions).length,
    realized_pnl_usd: portfolio.stats.realized_pnl_usd,
    unrealized_pnl_usd: portfolio.stats.unrealized_pnl_usd,
    equity_usd: portfolio.stats.equity_usd,
    approved_candidates: approvedCount,
    rejected_candidates: rejectedCount,
    market_regime: portfolio.stats.market_regime || "unknown"
  };
}

function normalizeCoveragePct(value) {
  const num = toNum(value, NaN);
  if (!Number.isFinite(num)) return null;
  return num > 1 ? num / 100 : num;
}

function gradeFromScore(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

function scoreFromFlags(flags) {
  return Math.max(0, 100 - (flags || []).reduce((total, flag) => {
    if (flag.severity === "critical") return total + 20;
    if (flag.severity === "warning") return total + 8;
    if (flag.severity === "info") return total + 2;
    return total;
  }, 0));
}

function pushManagerFlag(flags, severity, agent, code, message) {
  flags.push({ severity, agent, code, message });
}

function summarizeManagerSummary(report) {
  const criticalFlags = report.flags.filter((flag) => flag.severity === "critical").length;
  const warningFlags = report.flags.filter((flag) => flag.severity === "warning").length;
  const qualified = toNum(report?.evidence_summary?.scout?.evidence_qualified_candidates, 0);
  const blocked = toNum(report?.evidence_summary?.scout?.evidence_blocked_candidates, 0);
  const reductionPct = normalizeCoveragePct(report?.evidence_summary?.scout?.shortlist_candidate_reduction_pct);
  const harvestDowngrades = toNum(report?.evidence_summary?.harvest?.evidence_downgrade_count, 0);
  const evidenceTail = ` Evidence: qualified=${qualified}, blocked=${blocked}, scout_reduction=${reductionPct == null ? "n/a" : `${Math.round(reductionPct * 100)}%`}, harvest_downgrades=${harvestDowngrades}.`;
  if (criticalFlags > 0) {
    return `Cycle finished with ${criticalFlags} critical flag${criticalFlags === 1 ? "" : "s"} and ${warningFlags} warning${warningFlags === 1 ? "" : "s"}.${evidenceTail}`;
  }
  if (warningFlags > 0) {
    return `Cycle was mostly healthy with ${warningFlags} warning${warningFlags === 1 ? "" : "s"} and no critical issues.${evidenceTail}`;
  }
  return `Clean cycle with no critical issues detected.${evidenceTail}`;
}

function buildFrequentAddressRepairWarning(scoutEvidenceDiagnostics = null) {
  const diagnostics = scoutEvidenceDiagnostics && typeof scoutEvidenceDiagnostics === "object"
    ? scoutEvidenceDiagnostics
    : {};
  const addressRepairs = toNum(diagnostics.address_repairs_in_cycle, 0);
  const candidatesReturned = toNum(diagnostics.candidates_returned, 0);
  if (!(candidatesReturned > 0)) return null;

  const repairRate = addressRepairs / candidatesReturned;
  if (!(repairRate > 0.3)) return null;

  return {
    code: "frequent_address_repairs",
    severity: "warning",
    window: "24h",
    address_repairs_in_cycle: addressRepairs,
    candidates_returned: candidatesReturned,
    address_repair_rate: Number(repairRate.toFixed(4)),
    message: `Address repairs hit ${Math.round(repairRate * 100)}% of Scout candidates this cycle.`
  };
}

function buildPipelineWarningsForCycle({ scoutEvidenceDiagnostics = null } = {}) {
  const frequentAddressRepairWarning = buildFrequentAddressRepairWarning(scoutEvidenceDiagnostics);
  return frequentAddressRepairWarning ? [frequentAddressRepairWarning] : [];
}

function clipManagerText(value, limit = 180) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function compactEvidenceLabels(source = {}) {
  const highlights = Array.isArray(source?.evidence_summary?.highlights) ? source.evidence_summary.highlights : [];
  const labels = highlights
    .map((item) => clipManagerText(item?.label, 48))
    .filter(Boolean);
  return [...new Set(labels)].slice(0, 3);
}

function compactReasonList(values = [], limit = 4) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => clipManagerText(value, 72))
    .filter(Boolean))].slice(0, limit);
}

function candidateAddressKey(candidate = {}) {
  return cleanAddress(candidate?.token?.contract_address || candidate?.contract_address || "");
}

function buildManagerCandidateSnapshot(source = {}, extra = {}) {
  const symbol = source?.token?.symbol || source?.symbol || extra.symbol || null;
  const contractAddress = candidateAddressKey(source) || cleanAddress(extra.contract_address || "");
  return {
    symbol,
    contract_address: contractAddress || null,
    action: source?.action || extra.action || null,
    status: extra.status || null,
    decision_reason: clipManagerText(extra.decision_reason || source?.why_now || source?.summary || null, 180),
    evidence_packet_id: source?.evidence_packet_id || extra.evidence_packet_id || null,
    evidence_quality_score: source?.evidence_quality_score ?? extra.evidence_quality_score ?? source?.evidence_summary?.quality_score ?? null,
    evidence_ref_count: source?.evidence_ref_count ?? extra.evidence_ref_count ?? (Array.isArray(source?.evidence) ? source.evidence.length : 0),
    evidence_labels: compactEvidenceLabels(source),
    blockers: compactReasonList(source?.evidence_blockers || extra.blockers || source?.evidence_summary?.blockers),
    warnings: compactReasonList(source?.evidence_warnings || extra.warnings || source?.evidence_summary?.warnings)
  };
}

function writeManagerReportFile(report) {
  const cycleIdShort = String(report.cycle_id || report.report_id || "cycle").slice(0, 4);
  const reportFileName = `cycle-${formatReportTimestamp(new Date(report.generated_at || Date.now()))}-${cycleIdShort}.json`;
  const reportFilePath = path.join(REPORTS_DIR, reportFileName);
  fs.writeFileSync(reportFilePath, `${JSON.stringify({ ...report, report_file: path.join("reports", reportFileName) }, null, 2)}\n`, "utf8");
  return path.join("reports", reportFileName);
}

function recordManagerReportEvent(report, context, portfolio) {
  const record = buildTrainingEventRecord("manager_report", "manager", portfolio, context, {
    report_id: report.report_id,
    overall_grade: report.overall_grade,
    overall_score: report.overall_score,
    critical_flags: report.critical_flags,
    warning_flags: report.warning_flags,
    report_file: report.report_file
  });
  appendTrainingEvent(record);
  return record;
}

function buildManagerReport(cycleState, portfolio) {
  const reportId = crypto.randomUUID();
  const generatedAt = nowIso();
  const cycleStart = new Date(cycleState.cycle_start_ts || generatedAt).getTime();
  const cycleEnd = new Date(cycleState.cycle_end_ts || generatedAt).getTime();
  const cycleDurationSeconds = Math.max(0, Math.round((cycleEnd - cycleStart) / 1000));

  const scout = cycleState.scout_result || {};
  const harvest = cycleState.harvest_result || {};
  const scoutCoverage = normalizeCoveragePct(cycleState.scout_coverage?.coverage_pct);
  const harvestCoverage = normalizeCoveragePct(cycleState.harvest_coverage?.coverage_pct);
  const scoutMeta = cycleState.scout_llm_meta || getLastLLMMeta("scout") || {};
  const harvestMeta = cycleState.harvest_llm_meta || getLastLLMMeta("harvest") || {};
  const scoutEvidenceDiagnostics = cycleState.scout_evidence_diagnostics || scout.evidence_diagnostics || null;
  const harvestEvidenceDiagnostics = cycleState.harvest_evidence_diagnostics || harvest.evidence_diagnostics || null;
  const riskDecisions = Array.isArray(cycleState.risk_decisions) ? cycleState.risk_decisions : [];
  const executorDecisions = Array.isArray(cycleState.executor_decisions) ? cycleState.executor_decisions : [];
  const cycleTrainingEvents = Array.isArray(cycleState.cycle_training_events) ? cycleState.cycle_training_events : [];
  const sizingDecisions = cycleTrainingEvents.filter((record) => record.event_type === "position_sizing_decision");
  const buys = Array.isArray(cycleState.cycle_actions?.buys) ? cycleState.cycle_actions.buys : [];
  const sells = Array.isArray(cycleState.cycle_actions?.sells) ? cycleState.cycle_actions.sells : [];
  const rotations = Array.isArray(cycleState.cycle_actions?.rotations) ? cycleState.cycle_actions.rotations : [];
  const portfolioSnapshot = cycleState.portfolio_snapshot || {};
  const pipelineLogEntries = Array.isArray(cycleState.pipeline_log_entries) ? cycleState.pipeline_log_entries : [];
  const scoutShortlistEvent = [...pipelineLogEntries].reverse().find((entry) => entry?.stage === "scout_evidence_shortlist")?.data || {};
  const scoutShortlistBlockedEntries = pipelineLogEntries
    .filter((entry) => entry?.stage === "scout_shortlist_blocked")
    .map((entry) => entry?.data || {})
    .filter((entry) => entry && typeof entry === "object");
  const scoutDowngradedEntries = pipelineLogEntries
    .filter((entry) => entry?.stage === "scout_candidate_downgraded")
    .map((entry) => entry?.data || {})
    .filter((entry) => entry && typeof entry === "object");
  const harvestDowngradedEntries = pipelineLogEntries
    .filter((entry) => entry?.stage === "harvest_candidate_downgraded")
    .map((entry) => entry?.data || {})
    .filter((entry) => entry && typeof entry === "object");
  const pipelineWarningEntries = [
    ...(Array.isArray(cycleState.pipeline_warnings) ? cycleState.pipeline_warnings : []),
    ...pipelineLogEntries
      .filter((entry) => entry?.stage === "pipeline_warning")
      .map((entry) => entry?.data || {})
      .filter((entry) => entry && typeof entry === "object")
  ];

  const scoutFlags = [];
  const scoutCandidates = Array.isArray(scout.candidates) ? scout.candidates : [];
  const scoutCoverageField = scoutCoverage;
  const scoutCoveragePct = scoutCoverageField ?? 0;
  const scoutStoriesChecked = Array.isArray(scout.stories_checked) ? scout.stories_checked : [];
  const scoutStoryTypes = new Set([
    ...scoutStoriesChecked.map((story) => String(story?.type || story?.story_type || story || "").toUpperCase()).filter(Boolean),
    ...(cycleState.scout_coverage?.self_reported_types || []).map((t) => String(t).toUpperCase()),
    ...(cycleState.scout_coverage?.evidence_cited_types || []).map((t) => String(t).toUpperCase()),
  ]);
  const scoutCandidatesWithFullEvidence = scoutCandidates.filter((candidate) => Array.isArray(candidate?.evidence) && candidate.evidence.length >= 3).length;
  const scoutEvidenceQualifiedCandidates = toNum(scoutEvidenceDiagnostics?.evidence_qualified_candidates, scoutCandidatesWithFullEvidence);
  const scoutEvidenceBlockedCandidates = toNum(scoutEvidenceDiagnostics?.evidence_blocked_candidates, 0);
  const scoutShortlistReductionCount = toNum(scoutEvidenceDiagnostics?.shortlist_candidate_reduction, 0);
  const scoutShortlistReductionPct = normalizeCoveragePct(scoutEvidenceDiagnostics?.shortlist_candidate_reduction_pct);
  const scoutShortlistedCandidates = toNum(
    scoutShortlistEvent?.shortlist_count,
    Math.max(0, toNum(scoutEvidenceDiagnostics?.input_candidate_count, scoutCandidates.length) - scoutShortlistReductionCount)
  );

  if (!Array.isArray(scout.candidates)) {
    pushManagerFlag(scoutFlags, "critical", "scout", "SCOUT_OUTPUT_INVALID", "Scout output is missing a candidates array.");
  }
  if (scoutCoverageField == null || scoutCoverageField < 0.85) {
    pushManagerFlag(scoutFlags, "warning", "scout", "SCOUT_LOW_COVERAGE", `Scout story coverage is ${Math.round((scoutCoverageField || 0) * 100)}%.`);
  }
  const requiredDisqualifiers = ["WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN"];
  const availableDisqualifiers = cycleState.scout_coverage?.expected_types?.length
    ? requiredDisqualifiers.filter((t) => cycleState.scout_coverage.expected_types.includes(t))
    : requiredDisqualifiers;
  if (availableDisqualifiers.length > 0 && availableDisqualifiers.some((type) => !scoutStoryTypes.has(type))) {
    pushManagerFlag(scoutFlags, "critical", "scout", "SCOUT_MISSING_DISQUALIFIERS", "Scout did not sweep all required disqualifier story types.");
  }
  if (scoutCandidates.some((candidate) => toNum(candidate?.fraud_risk, 0) >= 35)) {
    pushManagerFlag(scoutFlags, "warning", "scout", "SCOUT_HIGH_FRAUD_CANDIDATE", "Scout surfaced at least one candidate with fraud risk at or above the risk gate.");
  }
  if (scoutCandidates.some((candidate) => (Array.isArray(candidate?.evidence) ? candidate.evidence.length : 0) < 3)) {
    pushManagerFlag(scoutFlags, "warning", "scout", "SCOUT_THIN_EVIDENCE", "At least one Scout candidate had fewer than three evidence items.");
  }
  if (String(scoutMeta.finish_reason || "").toLowerCase() === "length") {
    pushManagerFlag(scoutFlags, "critical", "scout", "SCOUT_LLM_TRUNCATED", "Scout LLM response was truncated.");
  }
  if (scoutMeta.error) {
    pushManagerFlag(scoutFlags, "critical", "scout", "SCOUT_LLM_ERROR", "Scout LLM call failed.");
  }
  if (toNum(scoutMeta.total_tokens, 0) >= 5800) {
    pushManagerFlag(scoutFlags, "warning", "scout", "SCOUT_LLM_TOKENS_HIGH", "Scout used an unusually large token budget.");
  }

  const harvestFlags = [];
  const harvestPositions = Array.isArray(harvest.position_reviews) ? harvest.position_reviews : [];
  const harvestCandidates = Array.isArray(harvest.exit_candidates) ? harvest.exit_candidates : [];
  const harvestStoriesChecked = Array.isArray(harvest.stories_checked) ? harvest.stories_checked : [];
  const harvestStoryTypes = new Set([
    ...harvestStoriesChecked.map((story) => String(story?.type || story?.story_type || story || "").toUpperCase()).filter(Boolean),
    ...(cycleState.harvest_coverage?.self_reported_types || []).map((t) => String(t).toUpperCase()),
    ...(cycleState.harvest_coverage?.evidence_cited_types || []).map((t) => String(t).toUpperCase()),
  ]);
  const positionsHeld = toNum(portfolioSnapshot.position_count, Object.keys(portfolio?.positions || {}).length);
  const positionsReviewed = harvestPositions.length || toNum(harvest?.portfolio_summary?.position_count, 0);
  const exitsWithEvidence = harvestCandidates.filter((candidate) => Array.isArray(candidate?.evidence) && candidate.evidence.length >= 2).length;
  const harvestEvidenceDowngradeCount = toNum(harvestEvidenceDiagnostics?.evidence_downgrade_count, 0);
  const scoutRiskDecisionByAddress = new Map(
    riskDecisions.map((record) => {
      const proposal = record?.payload?.proposal || {};
      const review = record?.payload?.risk_review || record?.payload?.risk || {};
      return [candidateAddressKey(proposal), { proposal, review }];
    }).filter(([key]) => key)
  );
  const scoutQualifiedSnapshots = scoutCandidates.map((candidate) => {
    const riskBundle = scoutRiskDecisionByAddress.get(candidateAddressKey(candidate)) || {};
    const review = riskBundle.review || {};
    return buildManagerCandidateSnapshot(candidate, {
      status: String(review?.decision || "").toLowerCase() === "approve_for_executor" ? "qualified" : "reviewed",
      decision_reason: review?.reason_summary || review?.summary || candidate?.why_now || candidate?.summary || null
    });
  });
  const scoutBlockedSnapshots = scoutShortlistBlockedEntries.slice(0, 12).map((entry) => buildManagerCandidateSnapshot({}, {
    symbol: entry?.symbol || null,
    contract_address: entry?.contract_address || null,
    status: "blocked",
    decision_reason: compactReasonList(entry?.reasons, 3).join(", ") || compactReasonList(entry?.hard_blockers, 3).join(", ") || "blocked by evidence gate",
    evidence_packet_id: entry?.evidence_packet_id || null,
    blockers: [...compactReasonList(entry?.hard_blockers, 4), ...compactReasonList(entry?.reasons, 4)].slice(0, 4)
  }));
  const scoutDowngradedSnapshots = scoutDowngradedEntries.slice(0, 12).map((entry) => buildManagerCandidateSnapshot({}, {
    symbol: entry?.symbol || null,
    contract_address: entry?.contract_address || null,
    status: "downgraded",
    decision_reason: entry?.reason || "downgraded by evidence validation",
    evidence_packet_id: entry?.evidence_packet_id || null,
    warnings: compactReasonList([entry?.reason, entry?.valid_ref_count != null ? `valid refs ${entry.valid_ref_count}` : null])
  }));
  const harvestDowngradedSnapshots = harvestDowngradedEntries.slice(0, 12).map((entry) => buildManagerCandidateSnapshot({}, {
    symbol: entry?.symbol || null,
    contract_address: entry?.contract_address || null,
    action: "monitor",
    status: "downgraded",
    decision_reason: entry?.reason || "downgraded to monitor",
    evidence_packet_id: entry?.evidence_packet_id || null,
    warnings: compactReasonList([entry?.reason, entry?.valid_ref_count != null ? `valid refs ${entry.valid_ref_count}` : null])
  }));
  const harvestExitSnapshots = harvestCandidates.map((candidate) => buildManagerCandidateSnapshot(candidate, {
    status: String(candidate?.action || "").toLowerCase() === "exit" ? "exit" : "trim",
    decision_reason: candidate?.summary || candidate?.why_now || null
  }));

  if (!Array.isArray(harvest.position_reviews)) {
    pushManagerFlag(harvestFlags, "critical", "harvest", "HARVEST_OUTPUT_INVALID", "Harvest output is missing position reviews.");
  }
  if (harvestCoverage == null || harvestCoverage < 0.85) {
    pushManagerFlag(harvestFlags, "warning", "harvest", "HARVEST_LOW_COVERAGE", `Harvest story coverage is ${Math.round((harvestCoverage || 0) * 100)}%.`);
  }
  if (positionsReviewed < positionsHeld) {
    pushManagerFlag(harvestFlags, "critical", "harvest", "HARVEST_INCOMPLETE_REVIEWS", "Not every held position was reviewed by Harvest.");
  }
  if (["LIQUIDITY_DRAIN", "RUG_LIQUIDITY_PULL", "SPREAD_WIDENING", "CONCENTRATION_SHIFT", "TREASURY_DISTRIBUTION"].some((type) => !harvestStoryTypes.has(type))) {
    pushManagerFlag(harvestFlags, "warning", "harvest", "HARVEST_MISSING_EXIT_SWEEPS", "Harvest did not sweep all required exit-risk story types.");
  }
  if (harvestCandidates.some((candidate) => (Array.isArray(candidate?.evidence) ? candidate.evidence.length : 0) < 2)) {
    pushManagerFlag(harvestFlags, "warning", "harvest", "HARVEST_THIN_EVIDENCE", "At least one Harvest exit candidate had fewer than two evidence items.");
  }
  if (harvestCandidates.some((candidate) => {
    const raw = candidate?.suggested_exit_fraction;
    if (raw == null) return false; // missing is fine — executor defaults to 0.5
    const frac = toNum(raw, null);
    return frac == null || frac <= 0 || frac > 1;
  })) {
    pushManagerFlag(harvestFlags, "critical", "harvest", "HARVEST_INVALID_EXIT_FRACTION", "Harvest proposed an invalid exit fraction.");
  }
  if (harvestCandidates.some((candidate) => {
    const raw = candidate?.suggested_exit_fraction;
    if (raw == null) return false;
    const frac = toNum(raw, 0);
    return frac > 0 && frac < 0.1;
  })) {
    pushManagerFlag(harvestFlags, "warning", "harvest", "HARVEST_WEAK_EXIT_FRACTION", "At least one Harvest exit fraction was below the preferred threshold.");
  }
  if (positionsHeld > 0 && (harvestCandidates.length / positionsHeld) > 0.5) {
    pushManagerFlag(harvestFlags, "warning", "harvest", "HARVEST_MASS_EXIT_SIGNAL", "Harvest proposed exits on more than half of the held book.");
  }
  if (String(harvestMeta.finish_reason || "").toLowerCase() === "length") {
    pushManagerFlag(harvestFlags, "critical", "harvest", "HARVEST_LLM_TRUNCATED", "Harvest LLM response was truncated.");
  }
  if (harvestMeta.error) {
    pushManagerFlag(harvestFlags, "critical", "harvest", "HARVEST_LLM_ERROR", "Harvest LLM call failed.");
  }
  if (toNum(harvestMeta.total_tokens, 0) >= 5800) {
    pushManagerFlag(harvestFlags, "warning", "harvest", "HARVEST_LLM_TOKENS_HIGH", "Harvest used an unusually large token budget.");
  }

  const riskFlags = [];
  const riskApproved = riskDecisions.filter((record) => {
    const review = record?.payload?.risk_review || record?.payload?.risk || {};
    const decision = String(review?.decision || record?.payload?.decision || "").toLowerCase();
    return decision === "approve_for_executor" || record?.payload?.handoff_to_executor === true;
  });
  const riskRejected = riskDecisions.filter((record) => !riskApproved.includes(record));
  const riskApprovalRate = riskDecisions.length ? riskApproved.length / riskDecisions.length : 0;
  const paperMode = Boolean(portfolio?.settings?.paper_mode);

  if (riskDecisions.length < scoutCandidates.length) {
    pushManagerFlag(riskFlags, "critical", "risk", "RISK_INCOMPLETE_DECISIONS", "Risk did not evaluate every Scout candidate.");
  }
  if (riskDecisions.some((record) => {
    const review = record?.payload?.risk_review || record?.payload?.risk || {};
    const reasonCodes = Array.isArray(review?.reason_codes) ? review.reason_codes : [];
    return reasonCodes.length === 0;
  })) {
    pushManagerFlag(riskFlags, "warning", "risk", "RISK_ZERO_REASON_CODES", "At least one Risk decision had no reason codes.");
  }
  if (riskDecisions.some((record) => {
    const review = record?.payload?.risk_review || record?.payload?.risk || {};
    const decision = String(review?.decision || "").toLowerCase();
    return paperMode && decision === "approve_for_executor";
  })) {
    pushManagerFlag(riskFlags, "critical", "risk", "RISK_LIVE_APPROVAL_IN_PAPER", "Risk approved a live execution path while paper mode is enabled.");
  }
  if (riskDecisions.some((record) => {
    const review = record?.payload?.risk_review || record?.payload?.risk || {};
    const proposal = record?.payload?.proposal || {};
    const approved = String(review?.decision || "").toLowerCase() === "approve_for_executor" || record?.payload?.handoff_to_executor === true;
    const fraudRisk = toNum(review?.fraud_risk ?? proposal?.fraud_risk, 0);
    const rawConf = review?.confidence ?? proposal?.confidence;
    const confidence = normalizeScore(rawConf);
    const confBreached = confidence !== null && confidence <= 55;
    return approved && (fraudRisk >= 35 || confBreached);
  })) {
    pushManagerFlag(riskFlags, "critical", "risk", "RISK_HARD_LIMIT_MISS", "Risk approved a candidate that breached a hard limit.");
  }
  if (riskApprovalRate > 0.6) {
    pushManagerFlag(riskFlags, "warning", "risk", "RISK_APPROVAL_RATE_HIGH", "Risk approval rate is above the preferred ceiling.");
  }
  if (riskApprovalRate === 0 && riskDecisions.length >= 3) {
    pushManagerFlag(riskFlags, "info", "risk", "RISK_APPROVAL_RATE_LOW", "Risk approvals were zero for this cycle.");
  }

  const executorFlags = [];
  const executorApprovedCount = executorDecisions.filter((record) => {
    const review = record?.payload?.review || {};
    const decision = String(review?.executor_decision || review?.decision || record?.payload?.decision || "").toLowerCase();
    return ["paper_trade", "approve_live", "reduce_size"].includes(decision);
  }).length;
  const executorRejected = executorDecisions.filter((record) => {
    const review = record?.payload?.review || {};
    const decision = String(review?.executor_decision || review?.decision || record?.payload?.decision || "").toLowerCase();
    return !["paper_trade", "approve_live", "reduce_size"].includes(decision);
  });

  if (executorDecisions.length < riskApproved.length) {
    pushManagerFlag(executorFlags, "critical", "executor", "EXECUTOR_INCOMPLETE_DECISIONS", "Executor did not review every Risk-approved candidate.");
  }
  if (executorRejected.some((record) => Array.isArray(record?.payload?.review?.blocker_list) && record.payload.review.blocker_list.length === 0)) {
    pushManagerFlag(executorFlags, "warning", "executor", "EXECUTOR_MISSING_BLOCKERS", "At least one Executor reject lacked blocker details.");
  }
  if (executorDecisions.some((record) => {
    const review = record?.payload?.review || {};
    return Array.isArray(review?.paper_trade_ticket)
      ? false
      : String(review?.executor_decision || review?.decision || record?.payload?.decision || "").toLowerCase() === "paper_trade" && (!review?.paper_trade_ticket && !record?.payload?.paper_trade_ticket);
  })) {
    pushManagerFlag(executorFlags, "critical", "executor", "EXECUTOR_INVALID_TICKET", "At least one Executor paper trade was missing ticket details.");
  }
  if (paperMode && executorDecisions.some((record) => String(record?.payload?.review?.live_execution_allowed ?? record?.payload?.live_execution_allowed ?? false) === "true")) {
    pushManagerFlag(executorFlags, "critical", "executor", "EXECUTOR_LIVE_TRADE_IN_PAPER", "Executor allowed live execution while paper mode is enabled.");
  }

  const sizerFlags = [];
  const sizerBlocked = sizingDecisions.filter((record) => (record?.payload?.decision?.blocker_list || []).length > 0);
  if (sizingDecisions.some((record) => toNum(record?.payload?.decision?.recommended_size_pct, 0) > toNum(portfolio?.settings?.max_position_pct, SETTINGS_DEFAULTS.max_position_pct) * 100)) {
    pushManagerFlag(sizerFlags, "critical", "sizer", "SIZER_MAX_POSITION_BREACH", "Sizer recommended a size above max_position_pct.");
  }
  if (sizingDecisions.some((record) => (record?.payload?.decision?.sizing_reason_codes || []).includes("missing_liquidity") && toNum(record?.payload?.decision?.risk_adjustments?.liquidity_multiplier, 1) >= 1)) {
    pushManagerFlag(sizerFlags, "warning", "sizer", "SIZER_MISSING_LIQUIDITY_NOT_REDUCED", "Sizer did not reduce size for missing liquidity.");
  }

  const pipelineFlags = [];
  const currentEquity = toNum(portfolioSnapshot.equity_usd, toNum(cycleState.stats?.equity_usd, 0));
  const previousCycleEnd = [...cycleTrainingEvents].reverse().find((record) => record.event_type === "cycle_end" && record.cycle_id !== cycleState.cycle_id);
  const previousEquity = toNum(previousCycleEnd?.payload?.stats?.equity_usd, toNum(previousCycleEnd?.payload?.portfolio_snapshot?.equity_usd, currentEquity));
  const equityDropPct = previousEquity > 0 ? (previousEquity - currentEquity) / previousEquity : 0;
  const apiResponses = pipelineLogEntries.filter((entry) => String(entry.stage || "").startsWith("e3d_api_")).length;
  const apiErrors = pipelineLogEntries.filter((entry) => entry.stage === "e3d_api_error").length;
  const apiErrorRate = apiResponses > 0 ? apiErrors / apiResponses : 0;
  const llmMetaValues = [scoutMeta, harvestMeta].filter(Boolean);

  if (cycleDurationSeconds > 300) {
    pushManagerFlag(pipelineFlags, "warning", "pipeline", "PIPELINE_SLOW_CYCLE", "The cycle exceeded the target duration.");
  }
  if (llmMetaValues.some((meta) => String(meta.finish_reason || "").toLowerCase() === "length")) {
    pushManagerFlag(pipelineFlags, "critical", "pipeline", "PIPELINE_LLM_ERROR", "At least one pipeline LLM call was truncated.");
  }
  if (llmMetaValues.some((meta) => meta.error)) {
    pushManagerFlag(pipelineFlags, "critical", "pipeline", "PIPELINE_LLM_ERROR", "At least one pipeline LLM call failed.");
  }
  if (apiErrorRate > 0.05) {
    pushManagerFlag(pipelineFlags, "warning", "pipeline", "PIPELINE_API_ERROR_RATE", "Pipeline API error rate is above the target ceiling.");
  }
  if (equityDropPct > 0.05) {
    pushManagerFlag(pipelineFlags, "critical", "pipeline", "PIPELINE_EQUITY_DROP", "Portfolio equity dropped by more than 5% in one cycle.");
  }
  if (cycleState.market_regime && cycleState.fear_greed_value != null) {
    const fearGreed = toNum(cycleState.fear_greed_value, null);
    if (Number.isFinite(fearGreed) && fearGreed <= 25 && cycleState.market_regime !== "risk_off") {
      pushManagerFlag(pipelineFlags, "info", "pipeline", "PIPELINE_REGIME_MISMATCH", "Fear and greed was extreme fear, but the market regime did not shift to risk_off.");
    }
  }
  const frequentAddressRepairWarning = pipelineWarningEntries.find((entry) => entry?.code === "frequent_address_repairs");
  if (frequentAddressRepairWarning) {
    const repairRatePct = Math.round(toNum(frequentAddressRepairWarning.address_repair_rate, 0) * 100);
    const repairs = toNum(frequentAddressRepairWarning.address_repairs_in_cycle, 0);
    const returned = toNum(frequentAddressRepairWarning.candidates_returned, 0);
    pushManagerFlag(
      pipelineFlags,
      "warning",
      "pipeline",
      "FREQUENT_ADDRESS_REPAIRS",
      `Scout address repairs were frequent this cycle (${repairs}/${returned}, ${repairRatePct}%).`
    );
  }

  const scoutScore = scoreFromFlags(scoutFlags);
  const harvestScore = scoreFromFlags(harvestFlags);
  const riskScore = scoreFromFlags(riskFlags);
  const executorScore = scoreFromFlags(executorFlags);
  const sizerScore = scoreFromFlags(sizerFlags);
  const pipelineScore = scoreFromFlags(pipelineFlags);
  const overallScore = Math.round(
    (scoutScore * 0.25)
    + (harvestScore * 0.25)
    + (riskScore * 0.25)
    + (executorScore * 0.12)
    + (sizerScore * 0.03)
    + (pipelineScore * 0.10)
  );

  const report = {
    report_id: reportId,
    generated_at: generatedAt,
    cycle_id: cycleState.cycle_id || null,
    pipeline_run_id: cycleState.pipeline_run_id || null,
    cycle_index: cycleState.cycle_index ?? null,
    cycle_duration_seconds: cycleDurationSeconds,
    market_regime: cycleState.market_regime || portfolio?.stats?.market_regime || "unknown",
    fear_greed_value: cycleState.fear_greed_value ?? null,
    overall_grade: gradeFromScore(overallScore),
    overall_score: overallScore,
    summary: "",
    evidence_summary: {
      scout: {
        shortlist_candidate_count: scoutShortlistedCandidates,
        evidence_qualified_candidates: scoutEvidenceQualifiedCandidates,
        evidence_blocked_candidates: scoutEvidenceBlockedCandidates,
        weak_candidate_downgrade_count: scoutDowngradedEntries.length,
        shortlist_candidate_reduction: scoutShortlistReductionCount,
        shortlist_candidate_reduction_pct: scoutShortlistReductionPct == null ? null : Number(scoutShortlistReductionPct.toFixed(2))
      },
      harvest: {
        evidence_downgrade_count: harvestEvidenceDowngradeCount,
        weak_exit_downgrade_count: harvestDowngradedEntries.length
      }
    },
    evidence_diagnostics: {
      scout: scoutEvidenceDiagnostics,
      harvest: harvestEvidenceDiagnostics
    },
    dashboard_visibility: {
      scout: {
        latest_token_usage: scoutMeta.total_tokens ?? scoutEvidenceDiagnostics?.total_tokens ?? null,
        shortlist_candidate_count: scoutShortlistedCandidates,
        shortlisted_candidate_count: scoutShortlistedCandidates,
        evidence_qualified_count: scoutEvidenceQualifiedCandidates,
        evidence_blocked_count: scoutEvidenceBlockedCandidates,
        downgraded_weak_candidates: scoutDowngradedEntries.length
      },
      harvest: {
        latest_token_usage: harvestMeta.total_tokens ?? harvestEvidenceDiagnostics?.total_tokens ?? null,
        downgraded_weak_exits: harvestDowngradedEntries.length
      }
    },
    candidate_visibility: {
      scout: {
        qualified: scoutQualifiedSnapshots,
        blocked: scoutBlockedSnapshots,
        downgraded: scoutDowngradedSnapshots
      },
      harvest: {
        exit_candidates: harvestExitSnapshots,
        downgraded: harvestDowngradedSnapshots
      }
    },
    flags: [...scoutFlags, ...harvestFlags, ...riskFlags, ...executorFlags, ...sizerFlags, ...pipelineFlags],
    agents: {
      scout: {
        grade: gradeFromScore(scoutScore),
        score: scoutScore,
        coverage_pct: scoutCoveragePct,
        candidates_proposed: scoutCandidates.length,
        shortlisted_candidates: scoutShortlistedCandidates,
        candidates_with_full_evidence: scoutCandidatesWithFullEvidence,
        evidence_qualified_candidates: scoutEvidenceQualifiedCandidates,
        evidence_blocked_candidates: scoutEvidenceBlockedCandidates,
        weak_candidate_downgrade_count: scoutDowngradedEntries.length,
        shortlist_candidate_reduction: scoutShortlistReductionCount,
        shortlist_candidate_reduction_pct: scoutShortlistReductionPct == null ? null : Number(scoutShortlistReductionPct.toFixed(2)),
        llm_finish_reason: scoutMeta.finish_reason || null,
        llm_tokens: scoutMeta.total_tokens ?? null,
        llm_duration_ms: scoutMeta.duration_ms ?? null,
        flags: scoutFlags
      },
      harvest: {
        grade: gradeFromScore(harvestScore),
        score: harvestScore,
        coverage_pct: harvestCoverage,
        positions_reviewed: positionsReviewed,
        positions_held: positionsHeld,
        exit_candidates: harvestCandidates.length,
        exits_with_evidence: exitsWithEvidence,
        evidence_downgrade_count: harvestEvidenceDowngradeCount,
        weak_exit_downgrade_count: harvestDowngradedEntries.length,
        llm_finish_reason: harvestMeta.finish_reason || null,
        llm_tokens: harvestMeta.total_tokens ?? null,
        llm_duration_ms: harvestMeta.duration_ms ?? null,
        flags: harvestFlags
      },
      risk: {
        grade: gradeFromScore(riskScore),
        score: riskScore,
        decisions_made: riskDecisions.length,
        approved: riskApproved.length,
        rejected: riskRejected.length,
        approval_rate: Number(riskApprovalRate.toFixed(2)),
        hard_limit_breaches_caught: riskFlags.filter((flag) => flag.code === "RISK_HARD_LIMIT_MISS").length,
        quant_gates_fired: riskDecisions.flatMap((record) => Array.isArray(record?.payload?.risk_review?.reason_codes) ? record.payload.risk_review.reason_codes : []).filter(Boolean),
        flags: riskFlags
      },
      executor: {
        grade: gradeFromScore(executorScore),
        score: executorScore,
        decisions_made: executorDecisions.length,
        paper_trades_recorded: buys.length + sells.length + rotations.length,
        live_execution_allowed: false,
        flags: executorFlags
      },
      sizer: {
        grade: gradeFromScore(sizerScore),
        score: sizerScore,
        decisions_made: sizingDecisions.length,
        blocked_by_guardrails: sizerBlocked.length,
        flags: sizerFlags
      },
      pipeline: {
        grade: gradeFromScore(pipelineScore),
        score: pipelineScore,
        cycle_duration_seconds: cycleDurationSeconds,
        llm_errors: llmMetaValues.filter((meta) => meta.error || String(meta.finish_reason || "").toLowerCase() === "length").length,
        api_error_rate: Number(apiErrorRate.toFixed(2)),
        equity_delta_pct: Number((equityDropPct * 100).toFixed(2)),
        rotation_executed: rotations.length > 0,
        flags: pipelineFlags
      }
    },
    portfolio_snapshot: {
      cash_usd: portfolioSnapshot.cash_usd ?? null,
      equity_usd: portfolioSnapshot.equity_usd ?? null,
      position_count: portfolioSnapshot.position_count ?? null,
      realized_pnl_usd: portfolioSnapshot.realized_pnl_usd ?? null,
      unrealized_pnl_usd: portfolioSnapshot.unrealized_pnl_usd ?? null,
      max_drawdown_pct: portfolioSnapshot.max_drawdown_pct ?? null
    },
    cycle_actions: {
      buys: buys.map((trade) => ({
        symbol: trade?.token?.symbol || trade?.symbol || trade?.candidate?.token?.symbol || null,
        size_usd: toNum(trade?.paper_trade_ticket?.allocation_usd, toNum(trade?.allocation_usd, 0)),
        decision: trade?.paper_trade_ticket?.executor_decision || trade?.executor_decision || "paper_trade",
        conviction: toNum(trade?.candidate?.conviction_score, toNum(trade?.conviction_score, null))
      })),
      sells: sells.map((trade) => ({
        symbol: trade?.symbol || trade?.token?.symbol || null,
        size_usd: toNum(trade?.paper_trade_ticket?.allocation_usd, toNum(trade?.proceeds_usd, 0)),
        decision: trade?.paper_trade_ticket?.executor_decision || trade?.side || "paper_trade"
      })),
      rotations: rotations.map((item) => ({
        from_symbol: item?.from_symbol || item?.action?.from_symbol || null,
        to_symbol: item?.to_symbol || item?.action?.to_candidate?.token?.symbol || null,
        decision: item?.executor_decision || item?.action?.decision || null
      }))
    }
  };

  report.summary = summarizeManagerSummary(report);
  report.critical_flags = report.flags.filter((flag) => flag.severity === "critical").length;
  report.warning_flags = report.flags.filter((flag) => flag.severity === "warning").length;
  report.report_file = writeManagerReportFile(report);
  return report;
}

function runManagerDirect(cycleState, portfolio) {
  const report = buildManagerReport(cycleState, portfolio);
  recordManagerReportEvent(report, {
    pipeline_run_id: cycleState.pipeline_run_id || null,
    cycle_id: cycleState.cycle_id || null,
    cycle_index: cycleState.cycle_index ?? null,
    market_regime: cycleState.market_regime || portfolio?.stats?.market_regime || "unknown"
  }, portfolio);
  log("manager_report", {
    report_id: report.report_id,
    overall_grade: report.overall_grade,
    overall_score: report.overall_score,
    critical_flags: report.critical_flags,
    warning_flags: report.warning_flags,
    report_file: report.report_file
  });
  return report;
}

function buildDebugHandoffSnapshot(portfolio, portfolioIntelligence, runContext = {}) {
  const scoutIntel = fetchScoutIntelDebug(portfolioIntelligence);
  const scoutCandidateDebug = buildScoutCandidateDebug(portfolio, scoutIntel);
  const scoutMessage = buildScoutPrompt(portfolio, portfolioIntelligence);
  const harvestMessage = buildHarvestPrompt(portfolio, portfolioIntelligence);
  const scoutIntelUrls = buildScoutIntelUrls(portfolioIntelligence);

  return {
    debug_mode: true,
    generated_at: nowIso(),
    pipeline_run_id: runContext.pipeline_run_id || null,
    cycle_id: runContext.cycle_id || null,
    cycle_index: runContext.cycle_index ?? null,
    scout: {
      agent: "scout",
      handoff_message: scoutMessage,
      handoff_length: scoutMessage.length,
      intel_urls: scoutIntelUrls,
      candidate_debug: scoutCandidateDebug
    },
    harvest: {
      agent: "harvest",
      handoff_message: harvestMessage,
      handoff_length: harvestMessage.length
    }
  };
}

async function runCycle(runContext = {}) {
  console.log(`\n🚀 Starting pipeline at ${nowIso()}\n`);
  const cycleStartTs = nowIso();

  // Reset per-cycle state
  _cycleMarketContext = null;
  _cycleQuantContext = null;
  _cycleMapsContext = null;
  _cycleRegimePolicy = null;
  _cycleSignalSnapshot = null;
  _cycleArbitrageSignals = [];
  _cycleAvailableStoryTypes = null;
  _lastCognitiveState = null;
  _cycleScoutToolCalls = [];

  const portfolio = loadPortfolio();
  pruneCooldowns(portfolio);
  const trainingContext = {
    pipeline_run_id: runContext.pipeline_run_id || crypto.randomUUID(),
    cycle_id: runContext.cycle_id || crypto.randomUUID(),
    cycle_index: runContext.cycle_index ?? null,
    market_regime: portfolio.stats.market_regime || "unknown"
  };
  recordOperatorAction({
    action_type: "pipeline_cycle_start",
    actor: runContext.actor || "pipeline",
    role: "operator",
    reason: runContext.reason || "paper pipeline cycle started",
    resource: "pipeline",
    new_state: {
      mode: "paper",
      pipeline_run_id: trainingContext.pipeline_run_id,
      cycle_id: trainingContext.cycle_id,
      cycle_index: trainingContext.cycle_index
    },
    correlation_id: trainingContext.cycle_id,
    metadata: {
      debug_mode: Boolean(runContext.debugMode),
      live_submission_enabled: false
    }
  });
  setTrainingContext(trainingContext);
  // Build quant context: DexScreener flow for held positions, macro regime, Binance funding rates.
  // Start best-effort Maps fetch before quant work so it overlaps this cycle's context assembly.
  const cycleMapsContextPromise = fetchMapsContext({ signalLimit: 5 }).catch((error) => {
    log("maps_context_error", { message: String(error?.message || error) });
    return null;
  });
  // Four external API calls total — all synchronous curl, completing in ~3s.
  _cycleQuantContext = buildCycleQuantContext(portfolio);
  _cycleMapsContext = await cycleMapsContextPromise;
  log("quant_context", {
    macro_regime: _cycleQuantContext.macro?.regime,
    new_positions_ok: _cycleQuantContext.macro?.new_positions_ok,
    tighten_stops: _cycleQuantContext.macro?.tighten_stops,
    btc_24h: _cycleQuantContext.macro?.btc?.change_24h_pct ?? null,
    fear_greed: _cycleQuantContext.macro?.fear_greed?.value ?? null,
    token_flow_count: Object.keys(_cycleQuantContext.token_flow || {}).length,
    funding_rates_count: Object.keys(_cycleQuantContext.funding_rates || {}).length,
  });
  log("maps_context", _cycleMapsContext || null);
  // Use flow_graph.created_at (a Maps-sourced timestamp) to detect a stuck Maps cycle.
  // fetched_at is always "just now" so it cannot detect stale Maps data.
  const mapsDataTimestamp = _cycleMapsContext?.flow_graph?.created_at ?? null;
  const mapsDataMs = mapsDataTimestamp ? new Date(mapsDataTimestamp).getTime() : NaN;
  const mapsDataAgeMs = Number.isFinite(mapsDataMs) ? Math.max(0, Date.now() - mapsDataMs) : NaN;
  if (Number.isFinite(mapsDataAgeMs) && mapsDataAgeMs > 15 * 60 * 1000) {
    log("maps_context_warning", {
      warning: "maps_context_stale",
      flow_graph_created_at: mapsDataTimestamp,
      age_minutes: Number((mapsDataAgeMs / 60000).toFixed(2))
    });
  }
  _cycleRegimePolicy = buildRegimeSentinelPolicy(portfolio, _cycleQuantContext);
  portfolio.stats.market_regime = _cycleRegimePolicy.regime;
  trainingContext.market_regime = _cycleRegimePolicy.regime;
  setTrainingContext(trainingContext);
  log("regime_sentinel", _cycleRegimePolicy);
  recordAuxiliaryEvent("regime_policy", "regime_sentinel", portfolio, { policy: _cycleRegimePolicy });
  _cycleSignalSnapshot = buildCycleSignalSnapshot(portfolio);
  log("signal_curator", _cycleSignalSnapshot);
  recordAuxiliaryEvent("signal_snapshot", "signal_curator", portfolio, _cycleSignalSnapshot);
  _cycleArbitrageSignals = buildArbitrageSignals(portfolio);
  log("arbitrage_watcher", _cycleArbitrageSignals);
  for (const signal of _cycleArbitrageSignals) {
    recordAuxiliaryEvent("arbitrage_signal", "arbitrage_watcher", portfolio, signal);
  }
  const portfolioIntelligence = buildPortfolioIntelligenceDossier(portfolio);
  if (runContext.debugMode) {
    const debugSnapshot = buildDebugHandoffSnapshot(portfolio, portfolioIntelligence, runContext);
    logAgentRaw({
      kind: "debug_handoff",
      agent: "scout",
      mode: "debug",
      handoff_message: debugSnapshot.scout.handoff_message
    });
    logAgentRaw({
      kind: "debug_handoff",
      agent: "harvest",
      mode: "debug",
      handoff_message: debugSnapshot.harvest.handoff_message
    });
    console.log("🧪 Pipeline debug mode: LLM execution skipped.\n");
    console.log(JSON.stringify(debugSnapshot, null, 2));
    log("debug_handoff", {
      pipeline_run_id: debugSnapshot.pipeline_run_id,
      cycle_id: debugSnapshot.cycle_id,
      cycle_index: debugSnapshot.cycle_index,
      scout_handoff_length: debugSnapshot.scout.handoff_length,
      harvest_handoff_length: debugSnapshot.harvest.handoff_length,
      scout_candidate_count: debugSnapshot.scout.candidate_debug.candidate_count,
      scout_reviewed_tokens: debugSnapshot.scout.candidate_debug.total_tokens_reviewed
    });
    setTrainingContext(null);
    return debugSnapshot;
  }

  recordCycleEvent("cycle_start", trainingContext, portfolio, {
    settings: deepClone(portfolio.settings),
    portfolio_intelligence: portfolioIntelligence.prompt_snapshot
  });

  try {
    // 1. SCOUT — pre-fetch E3D data, then call LLM directly (no tool loop needed)
    const scoutPayload = runScoutDirect(portfolio, portfolioIntelligence);
    validateScoutPayload(scoutPayload);
    scoutPayload.candidates = filterScoutCandidatesAgainstPortfolio(scoutPayload.candidates || [], portfolio);
    log("scout", scoutPayload);
    log("agent_coverage", buildAgentCoverageLog("scout", scoutPayload));
    for (const candidate of scoutPayload.candidates || []) {
      recordCandidateEvent(candidate, portfolio, trainingContext, portfolioIntelligence.prompt_snapshot);
    }

    // 2. UPDATE HELD POSITION SNAPSHOTS
    updateHoldingsFromScout(portfolio, scoutPayload.holdings_updates || []);

    // 3. HARD-SELL CHECKS FIRST
    const sellActions = evaluateSellActions(portfolio);
    const sellTrades = [];
    for (const action of sellActions) {
      const trade = executeSell(portfolio, action);
      if (trade) sellTrades.push(trade);
    }
    if (sellTrades.length) log("sell_trades", sellTrades);
    for (const trade of sellTrades) sendTradeEmail(trade);

    // 4. HARVEST EXIT SCAN
    // Isolated in its own try/catch: a bad LLM reply here should cost this
    // cycle its exits, not also the hard-sells already computed above and the
    // rotations/buys still to come below (previously any harvest failure threw
    // out of the whole runCycle try block and the cycle never got saved at all).
    let harvestPayload;
    try {
      harvestPayload = runHarvestDirect(portfolio, portfolioIntelligence);
      validateHarvestPayload(harvestPayload);
    } catch (harvestErr) {
      log("harvest_cycle_skipped", { message: String(harvestErr?.message || harvestErr).slice(0, 500) });
      harvestPayload = buildHarvestFailureFallback(portfolio, nowIso());
    }
    log("harvest", harvestPayload);
    log("agent_coverage", buildAgentCoverageLog("harvest", harvestPayload));
    for (const candidate of harvestPayload.exit_candidates || []) {
      recordHarvestDecisionEvent(candidate, candidate, portfolio, trainingContext, portfolioIntelligence.prompt_snapshot);
    }

    const { approved: harvestApproved, rejected: harvestRejected } = runRiskForExitCandidates(harvestPayload.exit_candidates || [], portfolio);
    if (harvestApproved.length) {
      log("harvest_approved", harvestApproved.map((x) => ({
        symbol: x.token.symbol,
        score: x._score,
        suggested_exit_fraction: x?.suggested_exit_fraction ?? null
      })));
    }
    if (harvestRejected.length) log("harvest_rejected", harvestRejected);

    const sizedHarvestApproved = harvestApproved
      .map((action) => applySizingToExitAction(action, buildPositionSizingDecision(action, portfolio, "exit")))
      .filter(Boolean);
    const harvestReviews = runExecutorForActions(sizedHarvestApproved, portfolio, "exit");
    if (harvestReviews.length) {
      log("executor_exit", harvestReviews.map((item) => ({
        symbol: item.action.token?.symbol || item.action.symbol,
        decision: executorDecision(item.review),
        approved_exit_fraction: item.review?.approved_exit_fraction ?? null,
        reason_summary: item.review?.reason_summary ?? null
      })));
    }
    const harvestTrades = [];
    for (const item of harvestReviews) {
      if (!executorAllowsTrade(item.review)) continue;

      const fraction = resolveExecutorExitFraction(item.action, item.review);
      if (fraction <= 0) continue;

      const symbol = item.action.symbol || item.action.token?.symbol;
      const trade = executeSell(portfolio, {
        type: "sell",
        symbol,
        fraction,
        reason: `${item.action.reason || item.action.exit_plan?.reason || "harvest_exit"}:${executorDecision(item.review) || "paper_trade"}`
      });
      if (trade) {
        trade.paper_trade_ticket = {
          created_at: nowIso(),
          reason: item.action.reason || item.action.exit_plan?.reason || "harvest_exit",
          executor_decision: executorDecision(item.review),
          approved_exit_fraction: toNum(item.review?.approved_exit_fraction, 0) || fraction,
          follow_up_action: item.review?.follow_up_action ?? null
        };
        applyEvidenceMetadata(trade.paper_trade_ticket, item.action);
        applyEvidenceMetadata(trade, item.action);
        attachPaperOrderLifecycle(trade);
        harvestTrades.push(trade);
      }
    }
    if (harvestTrades.length) log("harvest_trades", harvestTrades);
    for (const trade of harvestTrades) sendTradeEmail(trade);

    // 5. RISK ON CANDIDATES
    // Cross-source price validation first: reject any candidate whose e3d price can't be corroborated
    // by an independent feed (guards against the e3d mispricing that caused the SATA incident).
    scoutPayload.candidates = validateCandidatePricesAgainstSources(scoutPayload.candidates || [], portfolio);
    const scoutHash = sha256(scoutPayload);
    const { approved, rejected } = runRiskForCandidates(scoutPayload.candidates || [], portfolio);
    log("risk_approved", approved.map((x) => ({
      symbol: x.token.symbol,
      score: x._score,
      approved_size_pct: x?._risk?.approved_size_pct ?? null
    })));
    log("risk_rejected", rejected);

    const marketRegime = computeMarketRegime(scoutPayload, approved, portfolio);
    if (marketRegime.regime === "risk_off" && _cycleRegimePolicy?.regime !== "risk_off") {
      _cycleRegimePolicy = buildRegimeSentinelPolicy({ ...portfolio, stats: { ...portfolio.stats, market_regime: "risk_off" } }, _cycleQuantContext);
      _cycleRegimePolicy.reason_codes = [...new Set([...( _cycleRegimePolicy.reason_codes || []), "post_risk_regime_downgrade"])];
    }
    const policy = _cycleRegimePolicy || regimePolicy(marketRegime.regime, portfolio.settings);
    portfolio.stats.market_regime = policy.regime;
    trainingContext.market_regime = policy.regime;
    setTrainingContext(trainingContext);
    log("market_regime", { ...marketRegime, policy });

    // 6. ENSURE SCOUT PAYLOAD DIDN'T MUTATE
    if (sha256(scoutPayload) !== scoutHash) {
      throw new Error("SCOUT_PAYLOAD_MUTATED_IN_MEMORY");
    }

    // 7. ROTATION ENGINE
    const rotationActions = policy.allow_rotations
      ? evaluateRotationActions(portfolio, approved).slice(0, policy.max_rotations_per_cycle)
      : [];
    const sizedRotationActions = rotationActions
      .map((action) => ({ ...action, position_sizing: buildPositionSizingDecision(action, portfolio, "rotation") }));
    const rotationReviews = policy.allow_rotations
      ? runExecutorForActions(sizedRotationActions, portfolio, "rotation")
      : [];
    if (rotationReviews.length) {
      log("executor_rotation", rotationReviews.map((item) => ({
        from_symbol: item.action.from_symbol,
        to_symbol: item.action.to_candidate.token.symbol,
        decision: executorDecision(item.review),
        approved_size_pct: item.review?.approved_size_pct ?? null,
        reason_summary: item.review?.reason_summary ?? null
      })));
    }
    const rotationResults = [];
    for (const item of rotationReviews) {
      if (!executorAllowsTrade(item.review)) continue;

      const result = executeRotation(portfolio, item.action, item.review);
      if (result) rotationResults.push({
        from_symbol: item.action.from_symbol,
        to_symbol: item.action.to_candidate.token.symbol,
        score_delta: item.action.score_delta,
        executor_decision: executorDecision(item.review),
        result
      });
    }
    if (rotationResults.length) log("rotations", rotationResults);
    for (const r of rotationResults) {
      if (r.result?.sellTrade) sendTradeEmail(r.result.sellTrade);
      if (r.result?.buyTrade) sendTradeEmail(r.result.buyTrade);
    }

    // 8. NORMAL BUY ENGINE
    const rawBuyActions = policy.allow_buys
      ? evaluateBuyActions(portfolio, approved)
          .slice(0, policy.max_buys_per_cycle)
          .map((action) => ({
            ...action,
            allocation_usd: action.allocation_usd * policy.allocation_multiplier
          }))
          .filter((action) => action.allocation_usd >= portfolio.settings.min_trade_usd)
      : [];
    const buyActions = rawBuyActions
      .map((action) => applySizingToBuyAction(action, buildPositionSizingDecision(action, portfolio, "buy")))
      .filter((action) => action && action.allocation_usd >= portfolio.settings.min_trade_usd);
    const buyReviews = policy.allow_buys
      ? runExecutorForActions(buyActions, portfolio, "buy")
      : [];
    if (buyReviews.length) {
      log("executor_buy", buyReviews.map((item) => ({
        symbol: item.action.candidate.token.symbol,
        decision: executorDecision(item.review),
        approved_size_pct: item.review?.approved_size_pct ?? null,
        reason_summary: item.review?.reason_summary ?? null
      })));
    }
    const buyTrades = [];
    for (const item of buyReviews) {
      if (!executorAllowsTrade(item.review)) continue;

      const allocationUsd = resolveExecutorAllocation(item.action, item.review, portfolio);
      if (allocationUsd < portfolio.settings.min_trade_usd) continue;

      const evaluationTs = nowIso();
      const riskDecision = evaluateRiskDecision({
        mode: "paper",
        enforcement_mode: "enforced",
        evaluated_at: evaluationTs,
        portfolio,
        intent: buildBuyRiskIntent(item.action.candidate, allocationUsd, "buy"),
        analytics: buildPortfolioRiskAnalytics(portfolio, evaluationTs)
      });
      recordRiskEngineDecisionEvent(riskDecision, portfolio, getTrainingContext(), {
        candidate_id: item.action.candidate?.training_candidate_id || item.action.candidate?.token?.contract_address || item.action.candidate?.token?.symbol || null,
        proposed_allocation_usd: allocationUsd,
        trade_kind: "buy"
      });
      if (riskDecision.decision === "block") continue;

      const tokenRiskScan = buildCandidateTokenRiskScan(item.action.candidate, portfolio, {
        evaluated_at: evaluationTs,
        mode: "paper",
        side: "buy",
        risk_decision_id: riskDecision.risk_decision_id,
        risk_decision_ref: buildRiskDecisionRef(riskDecision, getTrainingContext()),
        signal_snapshot_ref: item.action.proposal?.signal_snapshot || item.action.candidate?.signal_snapshot || null
      });
      attachTokenRiskScanMetadata(item.action.candidate, tokenRiskScan, getTrainingContext());
      recordTokenRiskScanEvent(tokenRiskScan, portfolio, getTrainingContext(), {
        candidate_id: item.action.candidate?.training_candidate_id || item.action.candidate?.token?.contract_address || item.action.candidate?.token?.symbol || null,
        position_id: item.action.candidate?.training_position_id || null,
        trade_kind: "buy"
      });

      const paperTradeTicket = buildPaperTradeTicket(
        { ...item.action.candidate, position_sizing: item.action.position_sizing || null },
        allocationUsd,
        item.review,
        item.action.reason
      );

      const trade = openPosition(
        portfolio,
        item.action.candidate,
        allocationUsd,
        `${item.action.reason}:${executorDecision(item.review) || "paper_trade"}`,
        {
          strategyVersion: PAPER_ORDER_STRATEGY_VERSION,
          paperTradeTicket,
          riskDecision,
          tokenRiskScan
        }
      );
      if (trade) {
        attachRiskDecisionMetadata(trade, riskDecision, getTrainingContext());
        attachPaperOrderLifecycle(trade, { risk_decision_ref: trade.risk_decision_ref });
        buyTrades.push(trade);
      }
    }
    if (buyTrades.length) log("buy_trades", buyTrades);
    for (const trade of buyTrades) sendTradeEmail(trade);

    // 9. RECOMPUTE MARKET VALUE AFTER ACTIONS
    for (const pos of Object.values(portfolio.positions)) {
      pos.market_value_usd = pos.quantity * toNum(pos.current_price, pos.avg_entry_price);
    }

    // 10. PNL + SAVE
    const stats = computePortfolioStats(portfolio);
    log("stats", stats);

    savePortfolio(portfolio);

    const summary = buildSummary(portfolio, approved.length, rejected.length);
    console.log("✅ Pipeline complete\n");
    console.log(JSON.stringify(summary, null, 2));

    printPortfolioSummary(portfolio);
    recordCycleEvent("cycle_end", trainingContext, portfolio, {
      stats: deepClone(stats),
      summary: deepClone(summary),
      approved_count: approved.length,
      rejected_count: rejected.length,
      portfolio_intelligence: portfolioIntelligence.prompt_snapshot
    });

    const cycleEndTs = nowIso();
    try {
      const ledgerRecord = buildRunLedgerRecord({
        trainingContext, cycleStartTs, cycleEndTs,
        scoutPayload, harvestPayload, approved, rejected,
        buyTrades, sellTrades, harvestTrades, stats, portfolio,
        quantContext: _cycleQuantContext
      });
      writeRunLedgerEntry(ledgerRecord);
      log("run_ledger_written", { cycle_id: trainingContext.cycle_id });
    } catch (ledgerErr) {
      log("run_ledger_error", { message: String(ledgerErr?.message || ledgerErr) });
    }
    const cycleTrainingEvents = readJsonLines(TRAINING_EVENT_LOG, 1000).filter((record) => record.cycle_id === trainingContext.cycle_id);
    const scoutCoverageLog = buildAgentCoverageLog("scout", scoutPayload);
    const harvestCoverageLog = buildAgentCoverageLog("harvest", harvestPayload);
    const pipelineWarnings = buildPipelineWarningsForCycle({
      scoutEvidenceDiagnostics: scoutPayload.evidence_diagnostics
    });
    const scoutEvidenceDiagnostics = buildScoutEvidenceDiagnostics({
      ...(scoutPayload.evidence_diagnostics || {}),
      coverage: scoutCoverageLog,
      stories_checked: scoutPayload.stories_checked,
      candidates: scoutPayload.candidates
    });
    const harvestEvidenceDiagnostics = buildHarvestEvidenceDiagnostics({
      ...(harvestPayload.evidence_diagnostics || {}),
      coverage: harvestCoverageLog,
      stories_checked: harvestPayload.stories_checked,
      position_reviews: harvestPayload.position_reviews,
      exit_candidates: harvestPayload.exit_candidates
    });
    const evidenceDiagnosticsEvent = buildEvidenceDiagnosticsEvent({
      cycle_id: trainingContext.cycle_id,
      pipeline_run_id: trainingContext.pipeline_run_id,
      scout: scoutEvidenceDiagnostics,
      harvest: harvestEvidenceDiagnostics
    });
    log("evidence_diagnostics", evidenceDiagnosticsEvent);
    for (const warning of pipelineWarnings) {
      log("pipeline_warning", warning);
      recordAuxiliaryEvent("pipeline_warning", "pipeline", portfolio, warning);
    }
    const cyclePipelineLogEntries = [
      { stage: "quant_context", data: {
        macro_regime: _cycleQuantContext?.macro?.regime,
        new_positions_ok: _cycleQuantContext?.macro?.new_positions_ok,
        tighten_stops: _cycleQuantContext?.macro?.tighten_stops,
        dxy_change_24h_pct: _cycleQuantContext?.macro?.dxy?.change_24h_pct ?? null,
        equity_change_24h_pct: _cycleQuantContext?.macro?.equity_index?.change_24h_pct ?? null,
        regulatory_stance: _cycleQuantContext?.macro?.regulatory?.stance ?? null,
        regulatory_reason: _cycleQuantContext?.macro?.regulatory?.reason ?? null
      } },
      { stage: "maps_context", data: _cycleMapsContext || null },
      { stage: "scout", data: scoutPayload },
      { stage: "agent_coverage", data: scoutCoverageLog },
      { stage: "sell_trades", data: sellTrades },
      { stage: "harvest", data: harvestPayload },
      { stage: "agent_coverage", data: harvestCoverageLog },
      { stage: "harvest_approved", data: harvestApproved },
      { stage: "harvest_rejected", data: harvestRejected },
      { stage: "executor_exit", data: harvestReviews },
      { stage: "harvest_trades", data: harvestTrades },
      { stage: "risk_approved", data: approved },
      { stage: "risk_rejected", data: rejected },
      { stage: "market_regime", data: marketRegime },
      { stage: "executor_rotation", data: rotationReviews },
      { stage: "rotations", data: rotationResults },
      { stage: "executor_buy", data: buyReviews },
      { stage: "buy_trades", data: buyTrades },
      { stage: "stats", data: stats },
      { stage: "evidence_diagnostics", data: evidenceDiagnosticsEvent },
      ...pipelineWarnings.map((warning) => ({ stage: "pipeline_warning", data: warning }))
    ];
    const managerReport = runManagerDirect({
      ...trainingContext,
      cycle_start_ts: cycleStartTs,
      cycle_end_ts: cycleEndTs,
      scout_result: scoutPayload,
      scout_coverage: scoutCoverageLog,
      scout_llm_meta: getLastLLMMeta("scout"),
      scout_evidence_diagnostics: scoutEvidenceDiagnostics,
      harvest_result: harvestPayload,
      harvest_coverage: harvestCoverageLog,
      harvest_llm_meta: getLastLLMMeta("harvest"),
      harvest_evidence_diagnostics: harvestEvidenceDiagnostics,
      pipeline_warnings: pipelineWarnings,
      risk_decisions: cycleTrainingEvents.filter((record) => record.event_type === "risk_decision"),
      executor_decisions: cycleTrainingEvents.filter((record) => record.event_type === "executor_decision"),
      cycle_actions: {
        buys: buyTrades,
        sells: [...sellTrades, ...harvestTrades],
        rotations: rotationResults
      },
      portfolio_snapshot: {
        cash_usd: portfolio.cash_usd,
        equity_usd: stats.equity_usd,
        position_count: Object.keys(portfolio.positions || {}).length,
        realized_pnl_usd: stats.realized_pnl_usd,
        unrealized_pnl_usd: stats.unrealized_pnl_usd,
        max_drawdown_pct: stats.max_drawdown_pct
      },
      pipeline_log_entries: cyclePipelineLogEntries,
      cycle_training_events: cycleTrainingEvents,
      market_regime: trainingContext.market_regime,
      fear_greed_value: _cycleQuantContext?.macro?.fear_greed?.value ?? null
    }, portfolio);
    log("manager", {
      report_id: managerReport.report_id,
      overall_grade: managerReport.overall_grade,
      overall_score: managerReport.overall_score,
      report_file: managerReport.report_file
    });
  } finally {
    setTrainingContext(null);
    recordOperatorAction({
      action_type: "pipeline_cycle_stop",
      actor: runContext.actor || "pipeline",
      role: "operator",
      reason: "paper pipeline cycle ended",
      resource: "pipeline",
      previous_state: {
        mode: "paper",
        pipeline_run_id: trainingContext.pipeline_run_id,
        cycle_id: trainingContext.cycle_id,
        cycle_index: trainingContext.cycle_index
      },
      new_state: {
        mode: "cycle_complete",
        pipeline_run_id: trainingContext.pipeline_run_id,
        cycle_id: trainingContext.cycle_id,
        cycle_index: trainingContext.cycle_index
      },
      correlation_id: trainingContext.cycle_id
    });
  }
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const pipelineRunId = crypto.randomUUID();
  const debugMode = Boolean(cli.debug);
  recordOperatorAction({
    action_type: "pipeline_start",
    actor: "pipeline_cli",
    role: "operator",
    reason: cli.loop ? "pipeline loop process started" : "single paper pipeline run started",
    resource: "pipeline",
    new_state: {
      mode: cli.loop ? "loop" : "once",
      pipeline_run_id: pipelineRunId,
      interval_ms: cli.intervalMs,
      max_iterations: Number.isFinite(cli.maxIterations) ? cli.maxIterations : null,
      debug_mode: debugMode
    },
    correlation_id: pipelineRunId
  });

  if (!cli.loop) {
    await runCycle({ pipeline_run_id: pipelineRunId, cycle_id: crypto.randomUUID(), cycle_index: 1, debugMode });
    recordOperatorAction({
      action_type: "pipeline_stop",
      actor: "pipeline_cli",
      role: "operator",
      reason: "single paper pipeline run completed",
      resource: "pipeline",
      previous_state: { mode: "once", pipeline_run_id: pipelineRunId },
      new_state: { mode: "stopped", pipeline_run_id: pipelineRunId },
      correlation_id: pipelineRunId
    });
    return;
  }

  let stopRequested = false;
  process.on("SIGINT", () => {
    stopRequested = true;
    recordOperatorAction({
      action_type: "pipeline_stop",
      actor: "pipeline_cli",
      role: "operator",
      reason: "stop signal received; finishing current cycle before exit",
      resource: "pipeline",
      previous_state: { mode: "loop", pipeline_run_id: pipelineRunId },
      new_state: { mode: "stopping", pipeline_run_id: pipelineRunId },
      correlation_id: pipelineRunId
    });
    console.log("\n🛑 Stop requested; finishing current cycle before exit...\n");
  });

  let iteration = 0;
  while (!stopRequested && iteration < cli.maxIterations) {
    iteration += 1;
    console.log(`\n🔁 Loop iteration ${iteration}${Number.isFinite(cli.maxIterations) ? `/${cli.maxIterations}` : ""}\n`);

    try {
      await runCycle({ pipeline_run_id: pipelineRunId, cycle_id: crypto.randomUUID(), cycle_index: iteration, debugMode });
    } catch (err) {
      log("error", { message: err.message, iteration });
      console.error("\n🔥 Cycle error (loop continues):\n", err.message);
    }

    if (stopRequested || iteration >= cli.maxIterations) break;

    console.log(`\n⏳ Sleeping ${Math.round(cli.intervalMs / 1000)}s before the next cycle...\n`);
    await sleep(cli.intervalMs);
  }

  recordOperatorAction({
    action_type: "pipeline_stop",
    actor: "pipeline_cli",
    role: "operator",
    reason: stopRequested ? "pipeline loop stopped by request" : "pipeline loop completed max iterations",
    resource: "pipeline",
    previous_state: { mode: "loop", pipeline_run_id: pipelineRunId },
    new_state: { mode: "stopped", pipeline_run_id: pipelineRunId, iterations: iteration },
    correlation_id: pipelineRunId
  });
}

// path.resolve() alone doesn't dereference symlinks, but __filename (from import.meta.url) is
// realpath-resolved — invoking this file through the /Users/mini/e3d-agent-trading-floor symlink
// with an absolute path would otherwise fail this check silently. See portfolioSnapshotWriter.js,
// performanceDaily.js, e3dActionOutcomeExport.js for the same fix.
const isDirectRun = process.argv[1] && (() => {
  try {
    return fs.realpathSync(process.argv[1]) === __filename;
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    log("error", { message: err.message });
    console.error("\n🔥 Pipeline error:\n", err.message);
    process.exit(1);
  });
}

export {
  SETTINGS_DEFAULTS,
  computeRecentClosedTradeMetrics,
  computeRecentPerformanceThrottleMultiplier,
  buildRegimeSentinelPolicy,
  buildPositionSizingDecision,
  buildPaperFillExecution,
  buildFrequentAddressRepairWarning,
  buildPipelineWarningsForCycle,
  executeSell,
  resolveScoutEvidenceRefMinimum,
  resolveScoutMaxCandidates,
  normalizePortfolioCooldowns,
  openPosition,
  resolveCooldownHoursForExitReason,
  setCooldown
};
