import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { buildCurlAuthArgs } from "./e3dAuthClient.js";
import { buildCycleQuantContext, enrichCandidateQuant, batchEnrichTokenFlow } from "./marketData.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, "logs");
const REPORTS_DIR = path.join(__dirname, "reports");
const PORTFOLIO_FILE = path.join(__dirname, "portfolio.json");
const PIPELINE_LOG = path.join(LOG_DIR, "pipeline.jsonl");
const AGENT_RAW_LOG = path.join(LOG_DIR, "agent-raw.jsonl");
const TRAINING_EVENT_LOG = path.join(LOG_DIR, "training-events.jsonl");
const TRAINING_EVENT_SCHEMA_VERSION = "1.0";
const MONGO_CONTAINER_NAME = process.env.E3D_MONGO_CONTAINER || "e3d-mongo";
const MONGO_DATABASE_NAME = process.env.E3D_MONGO_DATABASE || "e3d";
const CLICKHOUSE_HTTP_URL = process.env.E3D_CLICKHOUSE_HTTP_URL || "http://127.0.0.1:8123";
const CLICKHOUSE_DATABASE_NAME = process.env.E3D_CLICKHOUSE_DATABASE || "e3d";
const CLICKHOUSE_TABLE_NAME = process.env.E3D_CLICKHOUSE_TABLE || "training_events";
const E3D_API_BASE_URL = process.env.E3D_API_BASE_URL || "https://e3d.ai/api";
const E3D_TOKENS_DATA_SOURCE = Number(process.env.E3D_TOKENS_DATA_SOURCE || 1);
const E3D_TRANSACTIONS_DATA_SOURCE = Number(process.env.E3D_TRANSACTIONS_DATA_SOURCE || 1);
const PIPELINE_DEBUG_MODE = ["1", "true", "yes", "on"].includes(String(process.env.PIPELINE_DEBUG_MODE || "").trim().toLowerCase());
const E3D_DOSSIER_CACHE_TTL_MS = 10 * 60 * 1000;
const E3D_DOSSIER_MAX_POSITIONS = 5;
const E3D_DOSSIER_MAX_STORIES = 4;
const E3D_DOSSIER_MAX_COUNTERPARTIES = 5;

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
let ACTIVE_TRAINING_CONTEXT = null;
const LAST_LLM_META = new Map();
let DATABASE_SCHEMA_READY = false;

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
  age_decay_per_day: 0.75              // score penalty per day held
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
  return runShell("curl", ["-sS", "-X", "POST", url, "--data-binary", "@-"], {
    input
  });
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

    // Pipe script via stdin to avoid ARG_MAX when the portfolio JSON is large
    runShell("docker", [
      "exec",
      "-i",
      MONGO_CONTAINER_NAME,
      "mongosh",
      "--quiet"
    ], { input: mongoScript });
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
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const tail = maxLines > 0 ? lines.slice(-maxLines) : lines;
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
    trade: trade || null,
    ...details
  });
  appendTrainingEvent(record);
  return record;
}

function recordOutcomeEvent(trade, positionBefore, portfolio, context = {}) {
  const pnlUsd = toNum(trade?.pnl_usd, 0);
  const record = buildTrainingEventRecord("outcome", "pipeline", portfolio, context, {
    trade_id: trade?.trade_id || null,
    position_id: trade?.position_id || null,
    candidate_id: trade?.candidate_id || null,
    outcome_label: pnlUsd >= 0 ? "profit" : "loss",
    pnl_usd: pnlUsd,
    exit_price: trade?.price ?? null,
    entry_price: positionBefore?.avg_entry_price ?? null,
    holding_days: positionBefore?.opened_at && trade?.ts ? Math.max(0, (new Date(trade.ts).getTime() - new Date(positionBefore.opened_at).getTime()) / 86400000) : null,
    position_before: positionBefore || null,
    trade: trade || null
  });
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
      allocation_multiplier: 1.15,
      max_buys_per_cycle: settings.max_buys_per_cycle,
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

function isInCooldown(portfolio, symbol) {
  if (!portfolio || !symbol) return false;
  const until = portfolio.cooldowns?.[symbol];
  if (!until) return false;
  return new Date(until).getTime() > Date.now();
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
    proposed_exit_fraction: toNum(action?.sell_fraction, 0),
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
  log("portfolio_summary", summary);
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
  for (const key of ["stories", "items", "data", "results", "theses", "opportunities", "wallets", "rows", "transactions", "txs"] ) {
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
  loaded.cooldowns = loaded.cooldowns || {};
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

  // Evidence-cited: extract story type mentions from candidate evidence[] and risks[]
  const evidenceCited = new Set();
  const allItems = [
    ...(payload?.candidates || []),
    ...(payload?.exit_candidates || []),
    ...(payload?.holdings_updates || []),
  ];
  for (const item of allItems) {
    for (const e of item?.evidence || []) {
      const t = String(e?.type || e?.story_type || "").toUpperCase();
      if (t) evidenceCited.add(t);
    }
    for (const r of item?.risks || []) {
      const t = String(r?.type || r?.story_type || "").toUpperCase();
      if (t) evidenceCited.add(t);
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

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.writeFileSync(tmpFile, bodyJson);
      let stdout;
      try {
        stdout = execFileSync("curl", [
          "-s", "-X", "POST",
          `${LLM_BASE_URL}/v1/chat/completions`,
          "-H", "Content-Type: application/json",
          "-H", `X-Request-Id: ${reqId}`,
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

// Rotate token universe fetch criteria across cycles to avoid always seeing the same tokens.
// Sort rotation. Only three fields have reliable non-zero data across the DB:
//   volume24hUSD       — ~54 tokens with real on-chain DEX volume (highest signal)
//   effectiveLiquidityUSD — ~50+ tokens with measured pool depth
//   change_24h_pct     — price change available for most tokens
// change_30m_pct and volume are 0 for the majority of the 7,500-token DB.
const SCOUT_SORT_ROTATION = [
  { sortBy: "volume24hUSD",          sortDir: "desc" },  // on-chain activity
  { sortBy: "effectiveLiquidityUSD", sortDir: "desc" },  // deepest pools
  { sortBy: "change_24h_pct",        sortDir: "desc" },  // daily winners
  { sortBy: "volume24hUSD",          sortDir: "desc" },
  { sortBy: "change_24h_pct",        sortDir: "asc"  },  // oversold / reversal
  { sortBy: "effectiveLiquidityUSD", sortDir: "desc" },
];
let _scoutCycleIndex = 0;

function fetchScoutData() {
  // Story type categorisation — used to label whatever the API returns
  const disqualifierTypes = new Set(["WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN", "SPREAD_WIDENING",
    "MOMENTUM_DIVERGENCE", "EXCHANGE_FLOW", "SECURITY_RISK", "RUG_LIQUIDITY_PULL", "AIRDROP"]);
  // PRE-PUMP early signals — fire before price moves, this is the alpha window
  const buySignalTypes = new Set(["STAGING", "CLUSTER", "FUNNEL", "NEW_WALLETS", "WHALE",
    "ACCUMULATION", "SMART_MONEY", "STEALTH_ACCUMULATION", "DEEP_DIVE", "THESIS",
    "BREAKOUT_CONFIRMED", "FLOW", "HOTLINKS", "DISCOVERY", "DELEGATE_SURGE"]);
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

  // Rotate sort criteria each cycle
  const sortParams = SCOUT_SORT_ROTATION[_scoutCycleIndex % SCOUT_SORT_ROTATION.length];
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
    fragility_score: t.fragilityScore ?? null
  });

  // Primary list: rotated sort criterion, limit 50
  const primary = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    dataSource: 1, ...sortParams, limit: 50
  })).map(mapToken);

  // Secondary lens: always include the top volume tokens regardless of primary sort,
  // since those ~54 are the ones with real on-chain activity in E3D's coverage.
  const byVolume = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    dataSource: 1, sortBy: "volume24hUSD", sortDir: "desc", limit: 200
  })).map(mapToken);

  // Merge, deduplicate, then surface tokens with real activity first
  const seen = new Set();
  const raw = [];
  for (const t of [...primary, ...byVolume]) {
    if (!t.address || seen.has(t.address)) continue;
    seen.add(t.address);
    raw.push(t);
  }

  // Sort merged universe: tokens with on-chain volume first (highest signal),
  // then by effective liquidity, then by 24h change as tiebreaker.
  const tokenUniverseAll = raw.sort((a, b) => {
    const volDiff = (b.volume_24h_usd || 0) - (a.volume_24h_usd || 0);
    if (volDiff !== 0) return volDiff;
    const liqDiff = (b.liquidity_usd || 0) - (a.liquidity_usd || 0);
    if (liqDiff !== 0) return liqDiff;
    return (b.change_24h || 0) - (a.change_24h || 0);
  });

  // Strip stablecoins, gold tokens, and base/wrapped assets — these are not momentum-trading
  // candidates and dominate the volume ranking, causing the LLM to propose them when
  // there are no stories to guide it toward real opportunities.
  const nonTradeablePattern = /^(USDC?|USDT|DAI|USDS|BUSD|TUSD|FRAX|LUSD|SUSD|GUSD|PYUSD|FDUSD|USDE|SUSDE|USDY|USDP|HUSD|MUSD|CRVUSD|GHO|PYUSD|XAUt|PAXG|CACHE|XAUT|WETH|WBTC|cbBTC|rETH|stETH|wstETH|cbETH|ankrETH|BETH|sETH2|ETH2x|STETH)$/i;
  const tokenUniverse = tokenUniverseAll.filter(t => !nonTradeablePattern.test(t.symbol || ""));

  // Enrich universe with story-mentioned tokens not in the top-volume list.
  // Stories (ACCUMULATION, SMART_MONEY, THESIS, etc.) often fire on tokens accumulating
  // before they show up in volume rankings — that's the alpha window. Fetch price data
  // for up to 5 high-signal story addresses and add them so Scout can propose them.
  const highSignalStoryTypes = new Set(["THESIS", "ACCUMULATION", "SMART_MONEY", "STEALTH_ACCUMULATION", "BREAKOUT_CONFIRMED"]);
  const enrichQueue = [];
  for (const [type, items] of Object.entries(stories)) {
    if (!highSignalStoryTypes.has(type)) continue;
    for (const s of items) {
      const addr = cleanAddress(s?.meta?.token_address || s?.primary_token || s?.address || "");
      if (addr && !seen.has(addr)) enrichQueue.push({ addr, score: s?.score ?? 0, type });
    }
  }
  enrichQueue.sort((a, b) => b.score - a.score);
  for (const { addr } of enrichQueue.slice(0, 5)) {
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

  const thesisSignalStories = thesisStories.length ? thesisStories : endpointArray(stories.THESIS);

  // No per-token supplemental stories calls here — the global limit=200 call above is the
  // stories budget for the cycle. The dossier phase already consumed per-position calls,
  // and the /stories endpoint rate-limits at ~5-6 calls per window; adding more here
  // causes 429s that knock out the global call entirely.

  const storyTypeDist = Object.fromEntries(Object.entries(stories).map(([k, v]) => [k, v.length]));
  log("scout_story_types", { types: Object.keys(storyTypeDist).length, dist: storyTypeDist });

  // Fetch pre-computed multi-signal convergence candidates from the E3D agent system.
  // These are tokens where multiple story types have converged — much stronger signal
  // than any single story type alone. Joined with thesis data when one exists.
  const e3dCandidates = endpointArray(fetchJson("/candidates", { status: "new,promoted", limit: 25 }));
  log("scout_e3d_candidates", { count: e3dCandidates.length });

  // Fetch structured investment theses — direction, conviction, price targets, invalidation.
  // Higher signal quality than THESIS-type stories since these are the agent's finalised views.
  const e3dTheses = endpointArray(fetchJson("/theses", { status: "active", limit: 25 }));
  log("scout_e3d_theses", { count: e3dTheses.length });

  // Enrich universe with thesis tokens not already present. Theses cover tokens that have
  // high-conviction signals but may not surface in the standard volume/liquidity rankings.
  let thesisEnrichAdded = 0;
  for (const thesis of e3dTheses.slice(0, 8)) {
    const addr = cleanAddress(thesis?.token_address || thesis?.address || thesis?.contract_address || "");
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

  // CoinGecko enrichment — batch price lookup for thesis tokens + top flow accumulation tokens,
  // then detailed lookup for any thesis token that passes the quality gate.
  const cgDetailMap = new Map(); // address -> full CoinGecko detail
  if (COINGECKO_API_KEY) {
    const thesisAddrs = e3dTheses
      .map(t => cleanAddress(t?.token_address || t?.address || t?.contract_address || ""))
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

  return { stories, thesisSignalStories, tokenUniverse, disqualifierTypes, buySignalTypes, lateSignalTypes, secondaryTypes, sortLabel: `${sortParams.sortBy} ${sortParams.sortDir}`, e3dCandidates, e3dTheses, cgDetailMap };
}

function runScoutDirect(portfolio, portfolioIntelligence = null) {
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

  const systemPrompt = [
    "You are Scout, an elite crypto trading research agent for a quantitative hedge fund.",
    "You have been given pre-fetched E3D market intelligence data. Return STRICT JSON only — one object, no markdown, no commentary.",
    "",
    "SIGNAL PRIORITY — work down this list and stop when you find qualified candidates:",
    "1. E3D AGENT CANDIDATES — pre-computed multi-story convergence. The E3D system has already correlated signals across time. These are the highest-quality setups; always prioritize them.",
    "2. E3D THESES — structured investment theses with direction, conviction, and price targets. A LONG thesis with conviction >= 65 is a strong buy signal. If in_token_universe=false but conviction >= 65, STILL propose it — use the thesis price data and note 'thesis-driven entry' in why_now. Set price_source to 'thesis'.",
    "3. THESIS STORIES — THESIS-type on-chain stories with in_token_universe=true.",
    "4. BUY SIGNAL STORIES — ACCUMULATION, SMART_MONEY, BREAKOUT_CONFIRMED stories with in_token_universe=true.",
    "5. FLOW-ONLY — absolute last resort only when ALL above are empty. See FLOW-ONLY ENTRY rules. Prefer 0 candidates over a weak flow pick.",
    "",
    "SIGNAL TIMING — this is how you catch moves early instead of late:",
    "- PRE-PUMP (your alpha window — buy here): STAGING, CLUSTER, FUNNEL, NEW_WALLETS, ACCUMULATION, SMART_MONEY, STEALTH_ACCUMULATION, DEEP_DIVE, THESIS. These fire BEFORE price moves. A STAGING or CLUSTER story with flat price is your best entry.",
    "- BREAKOUT (early-mid entry, still valid): BREAKOUT_CONFIRMED, FLOW, HOTLINKS — price is moving but momentum is fresh.",
    "- POST-PUMP (already happened — do NOT buy as a new entry): MOVER, SURGE — the move is over. These appear in LATE SIGNALS section. Buying a MOVER story is buying after the crowd arrived. The CoinGecko change_7d_pct confirms this: if > 100%, you are late.",
    "- PUMP EXHAUSTION (exit signal when you already hold): If you held a token and now see MOVER + declining price, that is the dump phase. Harvest should exit, not hold.",
    "",
    "WHERE ALPHA COMES FROM:",
    "- THESIS-BACKED ENTRY: An E3D thesis with conviction >= 65 has already done multi-source research — trust it, build an entry plan.",
    "- EARLY ACCUMULATION: STAGING/CLUSTER/FUNNEL/NEW_WALLETS on a token where change_24h < 10% and price is flat. This is the setup before the move.",
    "- MULTI-SIGNAL CONVERGENCE: Token in 2+ early story types simultaneously (e.g. STAGING + ACCUMULATION, or CLUSTER + FUNNEL). Strongest possible entry.",
    "- DISQUALIFY post-pump entries: change_7d_pct > 300% = already pumped. Do NOT propose. change_7d_pct > 100% on a MOVER story = late entry, skip.",
    "- WARNING: A MOVER or SURGE story alone is NEVER a buy signal. It may be useful to confirm a thesis-backed position you already hold is working, but it is not an entry trigger.",
    "",
    "QUANT SIGNAL TIERS:",
    "TIER 1 (full size, highest conviction): E3D candidate or thesis (conviction >= 65) + flow_signal=accumulation or strong_accumulation + funding=neutral or squeeze_potential.",
    "TIER 2 (standard size): Story signal (ACCUMULATION/SMART_MONEY/THESIS/BREAKOUT_CONFIRMED) with in_token_universe=true + liquidity_usd > 200000 + volume_24h_usd > 50000.",
    "TIER 3 (small size, max 1 per cycle): Signal-backed setup (story or thesis) with good conviction but below TIER 2 liquidity/volume thresholds. NEVER use TIER 3 for pure flow-only entries.",
    "FLOW-ONLY ENTRY (only when E3D AGENT CANDIDATES shows 'none currently' AND E3D THESES shows 'none currently' AND zero buy-signal stories have in_token_universe=true): require ALL of — buy_sell_ratio_1h >= 3.5, liquidity_usd > 150000, volume_24h_usd > 75000, market_cap_usd > 5000000. Maximum 1 candidate. If any threshold is not met, return 0 candidates — do NOT force an entry.",
    "SKIP: flow_signal=distribution or strong_distribution. funding_signal=overcrowded_long. market_cap_usd < 2000000 (cannot size or exit safely). price_usd = 0 or volume_24h_usd = 0.",
    "MACRO GATE: If new_positions_ok=false, only propose TIER 1 setups with conviction >= 80.",
    "",
    "CRITICAL RULES:",
    "1. Quality gate — required for ALL proposals: price_usd > 0, liquidity_usd > 100000, market_cap_usd > 2000000, volume_24h_usd > 10000. No exceptions. Low-liquidity micro-caps cannot be sized or exited safely.",
    "2. NEVER propose stablecoins, gold tokens, or wrapped/base assets (already filtered from TOKEN UNIVERSE).",
    "3. Stories show ON-CHAIN SIGNALS. A story's subject may be a wallet, LP, or contract — only use as a candidate if in_token_universe=true AND quality gate is met.",
    "4. THESIS EXCEPTION: If a thesis has direction=LONG and conviction >= 65, propose it even when in_token_universe=false, provided the thesis includes a price. Quality gate still applies to whatever market data is available.",
    "5. Return up to 3 candidates. 1 strong candidate is better than 3 weak ones. Returning 0 candidates is correct when nothing genuinely meets the bar — the pipeline will survive a skipped cycle; a bad entry will not.",
    "6. Exclude addresses in DISQUALIFIERS and already-held: " + `symbols=${JSON.stringify([...heldSymbols])} addresses=${JSON.stringify([...heldAddresses])}`,
    "",
    `Output shape: {scan_timestamp, candidates[], holdings_updates[], stories_checked[]}`,
    `Each candidate: {source_agent:"scout", created_at:"${createdAt}", expires_at:"${expiresAt}", token:{symbol,name,chain:"ethereum",contract_address,category}, setup_type, action:"buy", confidence, conviction_score, opportunity_score, why_now, evidence[], risks[], entry_zone:{low,high}, invalidation_price, targets:{target_1,target_2,target_3}, market_data:{current_price,change_24h_pct,change_30m_pct,price_source:"e3d",market_cap_usd}, liquidity_data:{liquidity_usd,liquidity_source:"e3d"}, execution_data:{estimated_slippage_bps,quote_source:"e3d"}, portfolio_data:{current_token_exposure_pct:0,current_category_exposure_pct:0,current_total_exposure_pct:0}}`,
    `stories_checked[]: one entry per EVERY story type present in the ON-CHAIN SIGNALS section — {type, found, tokens[]}. List ALL types, even ones with in_token_universe=false (set found=false, tokens=[]). Do NOT invent story types not in the data.`
  ].join("\n");

  const allStoryTypes = Object.keys(data.stories);

  const formatCandidate = (c) => {
    const addr = cleanAddress(c?.token_address || c?.address || c?.contract_address || "");
    const tokenMatch = addr ? tokenByAddr.get(addr) : null;
    return JSON.stringify({
      address: addr,
      symbol: tokenMatch?.symbol || c?.symbol || null,
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

  const formatThesis = (t) => {
    const addr = cleanAddress(t?.token_address || t?.address || t?.contract_address || "");
    const tokenMatch = addr ? tokenByAddr.get(addr) : null;
    const cg = addr ? data.cgDetailMap?.get(addr) : null;
    return JSON.stringify({
      address: addr,
      symbol: tokenMatch?.symbol || cg?.symbol || t?.symbol || null,
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

  // Build funding rate warning for Scout (overcrowded longs to avoid)
  const overcrowdedSymbols = Object.entries(_cycleQuantContext?.funding_rates || {})
    .filter(([, f]) => f.signal === "overcrowded_long")
    .map(([sym]) => sym);
  const fundingLines = overcrowdedSymbols.length ? [
    `\n--- FUNDING RATE WARNINGS ---`,
    `Overcrowded longs (avoid new entries): ${overcrowdedSymbols.join(", ")}`,
  ] : [];

  const userMessage = [
    `Scout task — ${createdAt} [token universe sorted by: ${data.sortLabel}]`,
    `Portfolio: cash=$${portfolio?.cash_usd ?? 100000} positions=${Object.keys(portfolio?.positions || {}).length}`,
    ...macroLines,
    ...fundingLines,
    `Token universe: ${data.tokenUniverse.length} tradeable tokens (stablecoins/wrapped assets excluded), ${data.tokenUniverse.filter(t => (t.liquidity_usd||0) > 100000).length} with liq>$100k, ${data.tokenUniverse.filter(t => (t.market_cap_usd||0) > 2000000).length} with mcap>$2M`,
    `Story types in data (you must report all of these in stories_checked): ${allStoryTypes.join(", ")}`,
    `\n--- E3D AGENT CANDIDATES (primary signal — multi-story convergence, use these first) ---`,
    data.e3dCandidates.length ? data.e3dCandidates.map(formatCandidate).join("\n") : "none currently",
    `\n--- E3D THESES (structured investment theses — direction + conviction + price targets) ---`,
    data.e3dTheses.filter(t => /^long$/i.test(t?.direction || "")).length
      ? data.e3dTheses.filter(t => /^long$/i.test(t?.direction || "")).slice(0, 8).map(formatThesis).join("\n")
      : "none currently",
    // CoinGecko deep context — shown for any thesis or flow token that has CG detail
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
        `\nFLOW-ONLY eligible (ratio>=3.5, liq>$150k, vol24>$75k, mcap>$5M): ${qualifiedFlow.length} tokens${qualifiedFlow.length ? " — " + qualifiedFlow.map(t => t.symbol).join(", ") : ""}. Use ONLY when E3D candidates AND theses are both empty. Max 1 pick.`;
    })(),
    JSON.stringify(data.tokenUniverse.slice(0, 100))
  ].join("\n");

  const rawText = callLLMDirect(systemPrompt, userMessage, { agent: "scout" });

  // Extract JSON — try multiple strategies
  let jsonStr = rawText.trim();

  // Strip markdown fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  // Find the outermost JSON object: from first { to its matching }
  const firstBrace = jsonStr.indexOf("{");
  if (firstBrace !== -1) {
    let depth = 0, end = -1;
    for (let i = firstBrace; i < jsonStr.length; i++) {
      if (jsonStr[i] === "{") depth++;
      else if (jsonStr[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) jsonStr = jsonStr.slice(firstBrace, end + 1);
    else jsonStr = jsonStr.slice(firstBrace); // truncated — take what we have
  }

  let result;
  try {
    result = JSON.parse(jsonStr);
  } catch (parseErr) {
    // LLM may have hit max_tokens mid-response — try to repair truncated JSON
    try {
      result = JSON.parse(repairTruncatedJson(jsonStr));
      log("scout_json_repaired", { raw_length: rawText.length });
    } catch (_) {
      const preview = rawText.slice(0, 500);
      throw new Error(`SCOUT_REPLY_NOT_JSON\n${preview}`);
    }
  }

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
    const liq = tokenRow?.liquidityUSD ?? tokenRow?.effectiveLiquidityUSD ?? tokenRow?.liquidity_usd ?? storyPrice?.liq ?? 0;
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
        pos.current_price    = flow.price_usd;
        pos.market_value_usd = pos.quantity * flow.price_usd;
        pos.last_updated_at  = nowIso();
      }
    }
  }

  return result;
}

function runHarvestDirect(portfolio, portfolioIntelligence = null) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const dossier = portfolioIntelligence || buildPortfolioIntelligenceDossier(portfolio);

  const positions = Object.values(portfolio?.positions || {});

  // No positions — nothing to harvest
  if (positions.length === 0) {
    return {
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
  }

  // Use cycle-level cached stories — already fetched once by getOrFetchCycleMarketContext().
  const heldAddresses = positions.map((p) => cleanAddress(p?.contract_address || "")).filter(Boolean);
  const exitRiskTypes = ["LIQUIDITY_DRAIN", "WASH_TRADE", "SPREAD_WIDENING", "MOMENTUM_DIVERGENCE", "EXCHANGE_FLOW", "LOOP",
    "SECURITY_RISK", "RUG_LIQUIDITY_PULL"];
  const holdConfirmTypes = ["ACCUMULATION", "SMART_MONEY", "FLOW", "CLUSTER", "STAGING", "FUNNEL"];
  const pumpExhaustionTypes = ["MOVER", "SURGE"];

  const { allStories: cycleHarvestStories } = getOrFetchCycleMarketContext();
  const allHarvestStories = cycleHarvestStories || [];
  const exitStories = {};
  for (const s of allHarvestStories) {
    const t = String(s?.story_type || s?.type || "").toUpperCase();
    if (!t) continue;
    if (!exitStories[t]) exitStories[t] = [];
    exitStories[t].push(s);
  }

  // Build per-position story matches
  const addrSet = new Set(heldAddresses);
  const storyMatches = {};
  for (const [type, items] of Object.entries(exitStories)) {
    storyMatches[type] = items.filter((s) => {
      const addr = cleanAddress(s?.meta?.token_address || s?.primary_token || s?.token_address || s?.address || "");
      return addrSet.has(addr);
    }).map((s) => ({
      address: cleanAddress(s?.meta?.token_address || s?.token_address || s?.address || ""),
      symbol: s?.meta?.token_symbol || s?.symbol || "",
      score: s?.score,
      hint: s?.meta?.narrative_hint || ""
    }));
  }

  // Build positionData using live portfolio prices (refreshed by runScoutDirect) rather than
  // the stale dossier prices, and augment with DexScreener flow + funding rate signals.
  const positionData = dossier.holdings.slice(0, 8).map((item) => {
    const sym  = item?.token?.symbol || null;
    const addr = cleanAddress(item?.token?.contract_address || "");
    // Prefer live portfolio position price over dossier (dossier is built before price refresh)
    const livePos    = sym && portfolio.positions[sym] ? portfolio.positions[sym] : null;
    const livePrice  = livePos?.current_price ?? toNum(item?.market_data?.current_price, 0);
    const costBasis  = toNum(item?.position?.cost_basis_usd, 0);
    const qty        = livePos?.quantity ?? toNum(item?.position?.quantity, 0);
    const marketVal  = qty * livePrice;
    const pnlUsd     = marketVal - costBasis;
    const pnlPct     = costBasis > 0 ? +(pnlUsd / costBasis * 100).toFixed(2) : 0;
    const flowData   = addr ? (_cycleQuantContext?.token_flow?.[addr] ?? null) : null;
    const funding    = sym  ? (_cycleQuantContext?.funding_rates?.[sym] ?? null) : null;
    return {
      symbol:              sym,
      contract_address:    addr || null,
      category:            item?.token?.category || "unknown",
      quantity:            qty,
      avg_entry_price:     toNum(item?.position?.avg_entry_price, 0),
      current_price:       livePrice,
      market_value_usd:    +marketVal.toFixed(2),
      cost_basis_usd:      costBasis,
      unrealized_pnl_usd:  +pnlUsd.toFixed(2),
      unrealized_pnl_pct:  pnlPct,
      thesis_strength:     item?.thesis?.strength ?? null,
      thesis_freshness:    item?.thesis?.freshness ?? null,
      narrative_decay:     item?.thesis?.decay ?? null,
      opportunity_score:   item?.thesis?.opportunity_score ?? null,
      fraud_risk:          item?.thesis?.fraud_risk ?? null,
      ...(flowData ? {
        flow_signal:          flowData.flow_signal,
        buy_sell_ratio_1h:    flowData.buy_sell_ratio_1h,
        price_change_1h_pct:  flowData.price_change_1h_pct,
      } : {}),
      ...(funding ? {
        funding_signal:       funding.signal,
        funding_rate_per_8h:  funding.rate_per_8h,
      } : {}),
    };
  });

  const systemPrompt = [
    "You are Harvest, a crypto portfolio exit-scan agent.",
    "You have been given pre-fetched E3D exit-risk story data for held positions, live quant signals, and macro context. Analyze all of it and return STRICT JSON only — one object, no markdown.",
    "Classify every held position as hold, monitor, trim, or exit based on ALL available evidence.",
    "Only add a position to exit_candidates if action is trim or exit.",
    "",
    "SIGNAL TIMING — know whether you're in the setup, the move, or the dump:",
    "- PRE-PUMP HOLD CONFIRMS (bullish for holding): STAGING, CLUSTER, FUNNEL, ACCUMULATION, SMART_MONEY, FLOW — fresh accumulation means the thesis is intact.",
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
    "",
    `Output shape: {scan_timestamp, portfolio_summary, position_reviews[], exit_candidates[], stories_checked[]}`,
    `Each position_review: {source_agent:"harvest", created_at:"${createdAt}", expires_at:"${expiresAt}", token:{symbol,name,chain:"ethereum",contract_address,category}, position:{quantity,avg_entry_price,current_price,market_value_usd,cost_basis_usd,unrealized_pnl_usd,unrealized_pnl_pct}, action:"hold"|"monitor"|"trim"|"exit", thesis_state, thesis_summary, what_changed, why_now, confidence, conviction_score, opportunity_score, review_priority, summary, evidence[], risks[], what_would_change_my_mind[], next_best_alternative, current_regime, market_data:{current_price,change_24h_pct,price_source:"e3d"}, narrative_data:{story_strength,thesis_health,flow_direction}}`,
    `Each exit_candidate: same as position_review plus {setup_type, edge_source, suggested_exit_fraction, target_exit_price, decision_price, exit_priority}`
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

  const userMessage = [
    `Harvest task — ${createdAt}`,
    `Held positions (${positionData.length}) — prices are live (refreshed this cycle), pnl_pct is real:`,
    JSON.stringify(positionData),
    ...harvestMacroLines,
    `\n--- EXIT RISK STORIES (matched to held addresses) ---`,
    ...exitRiskTypes.map((type) => {
      const matches = storyMatches[type] || [];
      return `${type}: ${matches.length} matches — ${JSON.stringify(matches.slice(0, 3))}`;
    }),
    `\n--- HOLD CONFIRM SIGNALS (fresh accumulation = thesis intact) ---`,
    ...holdConfirmTypes.map((type) => {
      const matches = storyMatches[type] || [];
      return `${type}: ${matches.length} matches — ${JSON.stringify(matches.slice(0, 3))}`;
    }),
    `\n--- PUMP EXHAUSTION SIGNALS (MOVER/SURGE on a declining position = dump phase, consider exit) ---`,
    ...pumpExhaustionTypes.map((type) => {
      const matches = storyMatches[type] || [];
      return `${type}: ${matches.length} matches — ${JSON.stringify(matches.slice(0, 3))}`;
    })
  ].join("\n");

  const rawText = callLLMDirect(systemPrompt, userMessage, { agent: "harvest" });

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
    return JSON.parse(jsonStr);
  } catch (parseErr) {
    // LLM may have hit max_tokens mid-response — try to repair truncated JSON
    try {
      const repaired = JSON.parse(repairTruncatedJson(jsonStr));
      log("harvest_json_repaired", { raw_length: rawText.length });
      return repaired;
    } catch (_) {
      throw new Error(`HARVEST_REPLY_NOT_JSON\n${rawText.slice(0, 500)}`);
    }
  }
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
    holdings: holdings
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
  const dossier = portfolioIntelligence || buildPortfolioIntelligenceDossier(portfolio);

  const positions = dossier.holdings.map((item) => ({
    symbol: item?.token?.symbol || null,
    contract_address: item?.token?.contract_address || null,
    category: item?.token?.category || "unknown",
    quantity: toNum(item?.position?.quantity, 0),
    avg_entry_price: toNum(item?.position?.avg_entry_price, 0),
    current_price: toNum(item?.market_data?.current_price, 0),
    market_value_usd: toNum(item?.position?.market_value_usd, 0),
    cost_basis_usd: toNum(item?.position?.cost_basis_usd, 0),
    unrealized_pnl_usd: toNum(item?.position?.market_value_usd, 0) - toNum(item?.position?.cost_basis_usd, 0),
    stop_price: item?.position?.stop_price || null,
    targets: item?.position?.targets || null,
    opened_at: item?.position?.opened_at || null,
    thesis: item?.thesis || null,
    recommendation: item?.recommendation || null
  }));
  const compactHoldings = dossier.holdings.slice(0, 8).map((item) => ({
    symbol: item?.token?.symbol || null,
    contract_address: item?.token?.contract_address || null,
    category: item?.token?.category || "unknown",
    thesis_strength: item?.thesis?.strength ?? null,
    thesis_freshness: item?.thesis?.freshness ?? null,
    narrative_decay: item?.thesis?.decay ?? null,
    opportunity_score: item?.thesis?.opportunity_score ?? null,
    flow_alignment: item?.thesis?.flow_alignment ?? null,
    fraud_risk: item?.thesis?.fraud_risk ?? null,
    liquidity_quality: item?.thesis?.liquidity_quality ?? null,
    recommendation_action: item?.recommendation?.action || null,
    why_now: item?.recommendation?.why_now || null
  }));
  const portfolioBaseline = {
    market_regime: dossier.market_regime,
    portfolio: dossier.prompt_snapshot.portfolio,
    thesis_snapshot: dossier.prompt_snapshot.thesis_snapshot,
    holdings: compactHoldings
  };

  const taskPrompt = `
You are Harvest. Return STRICT JSON only.

Your job:
1. Use the pre-computed thesis scores in the dossier as the baseline for every held position
2. Fetch live risk stories, flow, and wallet signals via WebFetch (endpoints in TOOLS.md) for each position
3. Classify every position as hold, monitor, trim, or exit using live evidence vs the baseline scores
4. Return STRICT JSON only — no markdown, no questions, no buy ideas

REQUIRED RESEARCH — follow the full Research Protocol in TOOLS.md before classifying:
1. Run the immediate-exit sweep (LIQUIDITY_DRAIN, RUG_LIQUIDITY_PULL, SPREAD_WIDENING, EXCHANGE_FLOW, MOMENTUM_DIVERGENCE, WASH_TRADE, LOOP) — match against every held address.
2. Run the positioning-risk sweep (CONCENTRATION_SHIFT, WHALE net OUT, VOLUME_PROFILE_ANOMALY, MIRROR).
3. Check hold-confirmation signals (ACCUMULATION, SMART_MONEY, EXCHANGE_FLOW net withdrawals).
4. For each held position: fetch /stories?q={address}&scope=opportunity&limit=10 and /stories?q={address}&scope=risk&limit=10.
5. Compare live signals against pre-computed thesis scores in context. Live signals take priority.

PORTFOLIO INTELLIGENCE DOSSIER (pre-computed baseline scores):
${JSON.stringify(portfolioBaseline)}

DECISION PRINCIPLES:
- hold when thesis strength, freshness, and flow remain intact
- monitor when the position is intact but the thesis is aging or mixed
- trim when thesis decay, distribution pressure, or opportunity cost starts to dominate
- exit when fraud risk, liquidity deterioration, or thesis break clearly overwhelms the setup
- use momentum as a secondary input, never the sole reason to sell

POSITION REVIEW RULES:
- emit a position review for every held position
- only include entries in exit_candidates when the action is trim or exit
- if the best action is hold or monitor, include the position in position_reviews with that action and a concise reason
- compare each position against the weakest holding and the strongest alternative when deciding whether to trim or exit
- surface the single strongest invalidation condition for each position

Current held positions (use these for position fields in your output):
${JSON.stringify(positions)}

CRITICAL: You MUST produce exactly ${positions.length} entries in position_reviews — one for every position listed above. Do not stop or close the JSON until all ${positions.length} positions have been reviewed.

Return EXACTLY this shape — one JSON object, no markdown:
{
  "scan_timestamp": "${createdAt}",
  "portfolio_summary": { "market_regime": string, "cash_usd": number, "equity_usd": number, "position_count": number, "tracked_positions": number, "average_thesis_strength": number, "average_thesis_freshness": number, "average_narrative_decay": number, "average_opportunity_score": number },
  "position_reviews": [
    {
      "proposal_version": "1.0", "source_agent": "harvest", "created_at": "${createdAt}", "expires_at": "${expiresAt}",
      "token": { "symbol": string, "name": string, "chain": "ethereum", "contract_address": string, "category": string },
      "position": { "quantity": number, "avg_entry_price": number, "current_price": number, "market_value_usd": number, "cost_basis_usd": number, "unrealized_pnl_usd": number },
      "action": "hold"|"monitor"|"trim"|"exit",
      "thesis_state": "confirmed"|"watch"|"weak"|"decaying",
      "thesis_summary": string, "what_changed": string, "why_now": string,
      "confidence": number(0-100), "conviction_score": number(0-100), "opportunity_score": number(0-100), "review_priority": number(1-5),
      "summary": string, "evidence": string[], "risks": string[], "what_would_change_my_mind": string[], "next_best_alternative": string,
      "current_regime": string,
      "market_data": { "current_price": number, "change_24h_pct": number, "price_timestamp": string, "price_source": string, "volume_24h_usd": number, "market_cap_usd": number },
      "liquidity_data": { "liquidity_usd": number, "liquidity_timestamp": string, "liquidity_source": string },
      "narrative_data": { "story_strength": number(0-100), "thesis_health": number(0-100), "flow_direction": string },
      "portfolio_data": { "current_token_exposure_pct": number, "current_category_exposure_pct": number, "current_total_exposure_pct": number, "portfolio_timestamp": string, "portfolio_source": "system" }
    }
  ],
  "exit_candidates": [
    {
      "proposal_version": "1.0", "source_agent": "harvest", "created_at": "${createdAt}", "expires_at": "${expiresAt}",
      "token": { "symbol": string, "name": string, "chain": "ethereum", "contract_address": string, "category": string },
      "position": { "quantity": number, "avg_entry_price": number, "current_price": number, "market_value_usd": number, "cost_basis_usd": number, "unrealized_pnl_usd": number },
      "setup_type": string, "edge_source": string, "action": "trim"|"exit",
      "confidence": number(0-100), "conviction_score": number(0-100), "opportunity_score": number(0-100), "exit_priority": number(1-5),
      "suggested_exit_fraction": number(0-1), "target_exit_price": number, "decision_price": number,
      "summary": string, "why_now": string, "evidence": string[], "risks": string[], "what_would_change_my_mind": string[], "next_best_alternative": string,
      "current_regime": string,
      "market_data": { "current_price": number, "change_24h_pct": number, "price_timestamp": string, "price_source": string, "volume_24h_usd": number, "market_cap_usd": number },
      "liquidity_data": { "liquidity_usd": number, "liquidity_timestamp": string, "liquidity_source": string },
      "narrative_data": { "story_strength": number(0-100), "thesis_health": number(0-100), "flow_direction": string },
      "portfolio_data": { "current_token_exposure_pct": number, "current_category_exposure_pct": number, "current_total_exposure_pct": number, "portfolio_timestamp": string, "portfolio_source": "system" }
    }
  ],
  "stories_checked": [
    { "type": string, "found": number, "flagged_addresses": string[] }
  ]
}

RULES: position_reviews covers every held position — exit_candidates only for trim/exit — valid lowercase addresses — one object only.
stories_checked must include one entry per story type endpoint you fetched (all of them), with "found" = count of stories returned and "flagged_addresses" = addresses that matched a held position.
`.trim();

  return taskPrompt.trim();
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

function setCooldown(portfolio, symbol) {
  const hours = portfolio.settings.cooldown_hours_after_exit;
  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  portfolio.cooldowns[symbol] = until;
}

function pruneCooldowns(portfolio) {
  const now = nowMs();
  for (const [symbol, until] of Object.entries(portfolio.cooldowns || {})) {
    if (new Date(until).getTime() <= now) {
      delete portfolio.cooldowns[symbol];
    }
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

function runRiskDirect(proposal) {
  const systemPrompt = [
    "You are Risk, a crypto trade risk validator.",
    "Validate the proposal and return STRICT JSON only — one object, no markdown.",
    `Response shape: {decision:"approve_for_executor"|"reject", reason_summary, reason_codes[], risk_score:number(0-100), checks_passed[], checks_failed[], blocker_list[]}`,
    "Decision: approve_for_executor ONLY IF ALL of these pass:",
    "  1. contract_address is a valid 42-char hex address",
    "  2. market_data.current_price > 0",
    "  3. liquidity_data.liquidity_usd >= 5000",
    "  4. execution_data.estimated_slippage_bps <= 300",
    "  5. _fragility_score (if present) < 70",
    "If any of these fail, decision = reject.",
    "Ignore missing optional fields like confidence, entry_zone, targets, why_now — they are informational only.",
    "reason_codes must be exact snake_case strings."
  ].join("\n");
  const userPrompt = `Validate this proposal:\n${JSON.stringify(proposal)}`;
  return callDirectJson("risk", systemPrompt, userPrompt, "RISK_DIRECT");
}

function runRiskForCandidates(candidates, portfolio) {
  const approved = [];
  const rejected = [];

  for (const proposal of candidates) {
    const risk = runRiskDirect(proposal);
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

function buildPaperTradeTicket(candidate, allocationUsd, review, reason) {
  return {
    created_at: nowIso(),
    assumed_entry: toNum(candidate?.market_data?.current_price, 0),
    stop: toNum(candidate?.invalidation_price, 0),
    targets: deepClone(candidate?.targets || {}),
    thesis_summary: candidate?.summary ?? candidate?.thesis_summary ?? null,
    edge_source: candidate?.edge_source ?? null,
    reason,
    allocation_usd: allocationUsd,
    executor_decision: executorDecision(review),
    approved_size_pct: toNum(review?.approved_size_pct, 0),
    max_slippage_bps: toNum(review?.max_slippage_bps, 0),
    follow_up_action: review?.follow_up_action ?? null
  };
}

// Update held position prices using the token universe fetched this cycle.
// Prevents positions from being stuck at their entry price indefinitely —
// accurate prices are required for Harvest to make meaningful exit decisions.
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
    pos.current_price = t.price_usd;
    pos.market_value_usd = pos.quantity * t.price_usd;
    if ((t.liquidity_usd ?? 0) > 0) pos.liquidity_usd = t.liquidity_usd;
    pos.last_updated_at = nowIso();
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
const FORCE_EXIT_PATTERN = /^(USDC?|USDT|DAI|USDS|BUSD|TUSD|FRAX|LUSD|SUSD|GUSD|PYUSD|FDUSD|USDE|SUSDE|USDY|USDP|HUSD|MUSD|CRVUSD|GHO|RLUSD|USDX|USDK|USDM|XAUt|PAXG|CACHE|XAUT|WETH|WBTC|cbBTC|rETH|stETH|wstETH|cbETH|ankrETH|BETH|sETH2|ETH2x|STETH)$/i;

function evaluateSellActions(portfolio) {
  const actions = [];
  const targetPct = portfolio.settings.target_partial_pct;

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

    if (!pos.partials_taken?.target_1 && price >= toNum(pos.targets?.target_1, Infinity)) {
      actions.push({
        type: "sell",
        symbol: pos.symbol,
        fraction: targetPct,
        reason: "target_1"
      });
      pos.partials_taken.target_1 = true;
    }

    if (!pos.partials_taken?.target_2 && price >= toNum(pos.targets?.target_2, Infinity)) {
      actions.push({
        type: "sell",
        symbol: pos.symbol,
        fraction: targetPct,
        reason: "target_2"
      });
      pos.partials_taken.target_2 = true;
    }

    if (!pos.partials_taken?.target_3 && price >= toNum(pos.targets?.target_3, Infinity)) {
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

  const proceeds = qty * pos.current_price;
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
    proceeds_usd: proceeds,
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
    setCooldown(portfolio, action.symbol);
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

  const buyTrade = openPosition(portfolio, candidate, allocationUsd, `rotation_in:${action.reason}`);
  if (buyTrade) {
    buyTrade.paper_trade_ticket = buildPaperTradeTicket(
      candidate,
      allocationUsd,
      review,
      `rotation_in:${action.reason}`
    );
    buyTrade.paper_trade_ticket.rotation_from_symbol = action.from_symbol;
    buyTrade.paper_trade_ticket.rotation_score_delta = toNum(action.score_delta, 0);
  }

  return { sellTrade, buyTrade };
}

function openPosition(portfolio, candidate, allocationUsd, reason = "buy") {
  const price = toNum(candidate?.market_data?.current_price, 0);
  if (!(price > 0)) return null;
  if (allocationUsd < portfolio.settings.min_trade_usd) return null;
  if (portfolio.cash_usd < allocationUsd) return null;

  const symbol = candidate.token.symbol;

  // Guard: don't open a new position slot when already at the limit
  if (!portfolio.positions[symbol] && Object.keys(portfolio.positions).length >= portfolio.settings.max_open_positions) {
    return null;
  }
  const quantity = allocationUsd / price;
  const context = getTrainingContext();
  const training = ensureCandidateTrainingMetadata(candidate, context);

  portfolio.cash_usd -= allocationUsd;

  const existing = portfolio.positions[symbol];
  if (existing) {
    const totalCost = existing.cost_basis_usd + allocationUsd;
    const totalQty = existing.quantity + quantity;

    existing.quantity = totalQty;
    existing.cost_basis_usd = totalCost;
    existing.avg_entry_price = totalCost / totalQty;
    existing.current_price = price;
    existing.market_value_usd = totalQty * price;
    existing.stop_price = candidate.invalidation_price;
    existing.targets = candidate.targets;
    existing.score = candidate._score ?? computePositionScoreLike(candidate);
    existing.category = candidate.token.category || existing.category || "unknown";
    existing.last_updated_at = nowIso();
    existing.training_candidate_id = existing.training_candidate_id || training.candidate_id;
    existing.training_position_id = existing.training_position_id || training.position_id;
  } else {
    portfolio.positions[symbol] = {
      symbol,
      contract_address: candidate.token.contract_address,
      category: candidate.token.category || "unknown",
      quantity,
      avg_entry_price: price,
      cost_basis_usd: allocationUsd,
      current_price: price,
      market_value_usd: allocationUsd,
      stop_price: toNum(candidate.invalidation_price, price * 0.9),
      targets: deepClone(candidate.targets || {}),
      partials_taken: {
        target_1: false,
        target_2: false,
        target_3: false
      },
      score: candidate._score ?? computePositionScoreLike(candidate),
      fraud_risk: toNum(candidate.fraud_risk, 0),
      liquidity_usd: toNum(candidate?.liquidity_data?.liquidity_usd, 0),
      liquidity_quality: toNum(candidate.liquidity_quality, 0),
      opened_at: nowIso(),
      last_updated_at: nowIso(),
      training_candidate_id: training.candidate_id,
      training_position_id: training.position_id,
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
    cost_usd: allocationUsd,
    score: candidate._score ?? computePositionScoreLike(candidate),
    trade_lifecycle: "open",
    candidate_id: training.candidate_id,
    position_id: training.position_id,
    trade_id: null
  };

  trade.trade_id = buildTradeId(trade, context);

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
  if (criticalFlags > 0) {
    return `Cycle finished with ${criticalFlags} critical flag${criticalFlags === 1 ? "" : "s"} and ${warningFlags} warning${warningFlags === 1 ? "" : "s"}.`;
  }
  if (warningFlags > 0) {
    return `Cycle was mostly healthy with ${warningFlags} warning${warningFlags === 1 ? "" : "s"} and no critical issues.`;
  }
  return "Clean cycle with no critical issues detected.";
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
  const riskDecisions = Array.isArray(cycleState.risk_decisions) ? cycleState.risk_decisions : [];
  const executorDecisions = Array.isArray(cycleState.executor_decisions) ? cycleState.executor_decisions : [];
  const buys = Array.isArray(cycleState.cycle_actions?.buys) ? cycleState.cycle_actions.buys : [];
  const sells = Array.isArray(cycleState.cycle_actions?.sells) ? cycleState.cycle_actions.sells : [];
  const rotations = Array.isArray(cycleState.cycle_actions?.rotations) ? cycleState.cycle_actions.rotations : [];
  const portfolioSnapshot = cycleState.portfolio_snapshot || {};
  const pipelineLogEntries = Array.isArray(cycleState.pipeline_log_entries) ? cycleState.pipeline_log_entries : [];
  const cycleTrainingEvents = Array.isArray(cycleState.cycle_training_events) ? cycleState.cycle_training_events : [];

  const scoutFlags = [];
  const scoutCandidates = Array.isArray(scout.candidates) ? scout.candidates : [];
  const scoutCoverageField = scoutCoverage;
  const scoutCoveragePct = scoutCoverageField ?? 0;
  const scoutStoriesChecked = Array.isArray(scout.stories_checked) ? scout.stories_checked : [];
  const scoutStoryTypes = new Set(scoutStoriesChecked.map((story) => String(story?.type || story?.story_type || story || "").toUpperCase()).filter(Boolean));
  const scoutCandidatesWithFullEvidence = scoutCandidates.filter((candidate) => Array.isArray(candidate?.evidence) && candidate.evidence.length >= 3).length;

  if (!Array.isArray(scout.candidates)) {
    pushManagerFlag(scoutFlags, "critical", "scout", "SCOUT_OUTPUT_INVALID", "Scout output is missing a candidates array.");
  }
  if (scoutCoverageField == null || scoutCoverageField < 0.85) {
    pushManagerFlag(scoutFlags, "warning", "scout", "SCOUT_LOW_COVERAGE", `Scout story coverage is ${Math.round((scoutCoverageField || 0) * 100)}%.`);
  }
  if (["WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN"].some((type) => !scoutStoryTypes.has(type))) {
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
  const harvestStoryTypes = new Set(harvestStoriesChecked.map((story) => String(story?.type || story?.story_type || story || "").toUpperCase()).filter(Boolean));
  const positionsHeld = toNum(portfolioSnapshot.position_count, Object.keys(portfolio?.positions || {}).length);
  const positionsReviewed = harvestPositions.length || toNum(harvest?.portfolio_summary?.position_count, 0);
  const exitsWithEvidence = harvestCandidates.filter((candidate) => Array.isArray(candidate?.evidence) && candidate.evidence.length >= 2).length;

  if (!Array.isArray(harvest.position_reviews)) {
    pushManagerFlag(harvestFlags, "critical", "harvest", "HARVEST_OUTPUT_INVALID", "Harvest output is missing position reviews.");
  }
  if (harvestCoverage == null || harvestCoverage < 0.85) {
    pushManagerFlag(harvestFlags, "warning", "harvest", "HARVEST_LOW_COVERAGE", `Harvest story coverage is ${Math.round((harvestCoverage || 0) * 100)}%.`);
  }
  if (positionsReviewed < positionsHeld) {
    pushManagerFlag(harvestFlags, "critical", "harvest", "HARVEST_INCOMPLETE_REVIEWS", "Not every held position was reviewed by Harvest.");
  }
  if (["LIQUIDITY_DRAIN", "RUG_LIQUIDITY_PULL", "SPREAD_WIDENING", "CONCENTRATION_SHIFT"].some((type) => !harvestStoryTypes.has(type))) {
    pushManagerFlag(harvestFlags, "warning", "harvest", "HARVEST_MISSING_EXIT_SWEEPS", "Harvest did not sweep all required exit-risk story types.");
  }
  if (harvestCandidates.some((candidate) => (Array.isArray(candidate?.evidence) ? candidate.evidence.length : 0) < 2)) {
    pushManagerFlag(harvestFlags, "warning", "harvest", "HARVEST_THIN_EVIDENCE", "At least one Harvest exit candidate had fewer than two evidence items.");
  }
  if (harvestCandidates.some((candidate) => {
    const frac = toNum(candidate?.suggested_exit_fraction, 0);
    return frac <= 0 || frac > 1;
  })) {
    pushManagerFlag(harvestFlags, "critical", "harvest", "HARVEST_INVALID_EXIT_FRACTION", "Harvest proposed an invalid exit fraction.");
  }
  if (harvestCandidates.some((candidate) => {
    const frac = toNum(candidate?.suggested_exit_fraction, 0);
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
    return approved && (toNum(review?.fraud_risk, toNum(proposal?.fraud_risk, 0)) >= 35 || toNum(review?.confidence, toNum(proposal?.confidence, 0)) <= 55);
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

  const scoutScore = scoreFromFlags(scoutFlags);
  const harvestScore = scoreFromFlags(harvestFlags);
  const riskScore = scoreFromFlags(riskFlags);
  const executorScore = scoreFromFlags(executorFlags);
  const pipelineScore = scoreFromFlags(pipelineFlags);
  const overallScore = Math.round(
    (scoutScore * 0.25)
    + (harvestScore * 0.25)
    + (riskScore * 0.25)
    + (executorScore * 0.15)
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
    flags: [...scoutFlags, ...harvestFlags, ...riskFlags, ...executorFlags, ...pipelineFlags],
    agents: {
      scout: {
        grade: gradeFromScore(scoutScore),
        score: scoutScore,
        coverage_pct: scoutCoveragePct,
        candidates_proposed: scoutCandidates.length,
        candidates_with_full_evidence: scoutCandidatesWithFullEvidence,
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
  _cycleAvailableStoryTypes = null;

  const portfolio = loadPortfolio();
  pruneCooldowns(portfolio);
  // Build quant context: DexScreener flow for held positions, macro regime, Binance funding rates.
  // Four external API calls total — all synchronous curl, completing in ~3s.
  _cycleQuantContext = buildCycleQuantContext(portfolio);
  log("quant_context", {
    macro_regime: _cycleQuantContext.macro?.regime,
    new_positions_ok: _cycleQuantContext.macro?.new_positions_ok,
    tighten_stops: _cycleQuantContext.macro?.tighten_stops,
    btc_24h: _cycleQuantContext.macro?.btc?.change_24h_pct ?? null,
    fear_greed: _cycleQuantContext.macro?.fear_greed?.value ?? null,
    token_flow_count: Object.keys(_cycleQuantContext.token_flow || {}).length,
    funding_rates_count: Object.keys(_cycleQuantContext.funding_rates || {}).length,
  });
  const portfolioIntelligence = buildPortfolioIntelligenceDossier(portfolio);
  if (runContext.debugMode) {
    const debugSnapshot = buildDebugHandoffSnapshot(portfolio, portfolioIntelligence, runContext);
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
    return debugSnapshot;
  }

  const trainingContext = {
    pipeline_run_id: runContext.pipeline_run_id || crypto.randomUUID(),
    cycle_id: runContext.cycle_id || crypto.randomUUID(),
    cycle_index: runContext.cycle_index ?? null,
    market_regime: portfolio.stats.market_regime || "unknown"
  };
  setTrainingContext(trainingContext);
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

    const scoutHash = sha256(scoutPayload);

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

    // 4. HARVEST EXIT SCAN
    const harvestPayload = runHarvestDirect(portfolio, portfolioIntelligence);
    validateHarvestPayload(harvestPayload);
    log("harvest", harvestPayload);
    log("agent_coverage", buildAgentCoverageLog("harvest", harvestPayload));
    for (const candidate of harvestPayload.exit_candidates || []) {
      recordHarvestDecisionEvent(candidate, candidate, portfolio, trainingContext, portfolioIntelligence.prompt_snapshot);
    }

    const { approved: harvestApproved, rejected: harvestRejected } = runRiskForCandidates(harvestPayload.exit_candidates || [], portfolio);
    if (harvestApproved.length) {
      log("harvest_approved", harvestApproved.map((x) => ({
        symbol: x.token.symbol,
        score: x._score,
        suggested_exit_fraction: x?.suggested_exit_fraction ?? null
      })));
    }
    if (harvestRejected.length) log("harvest_rejected", harvestRejected);

    const harvestReviews = runExecutorForActions(harvestApproved, portfolio, "exit");
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
        harvestTrades.push(trade);
      }
    }
    if (harvestTrades.length) log("harvest_trades", harvestTrades);

    // 5. RISK ON CANDIDATES
    const { approved, rejected } = runRiskForCandidates(scoutPayload.candidates || [], portfolio);
    log("risk_approved", approved.map((x) => ({
      symbol: x.token.symbol,
      score: x._score,
      approved_size_pct: x?._risk?.approved_size_pct ?? null
    })));
    log("risk_rejected", rejected);

    const marketRegime = computeMarketRegime(scoutPayload, approved, portfolio);
    const policy = regimePolicy(marketRegime.regime, portfolio.settings);
    portfolio.stats.market_regime = marketRegime.regime;
    trainingContext.market_regime = marketRegime.regime;
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
    const rotationReviews = policy.allow_rotations
      ? runExecutorForActions(rotationActions, portfolio, "rotation")
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

    // 8. NORMAL BUY ENGINE
    const buyActions = policy.allow_buys
      ? evaluateBuyActions(portfolio, approved)
          .slice(0, policy.max_buys_per_cycle)
          .map((action) => ({
            ...action,
            allocation_usd: action.allocation_usd * policy.allocation_multiplier
          }))
          .filter((action) => action.allocation_usd >= portfolio.settings.min_trade_usd)
      : [];
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

      const trade = openPosition(
        portfolio,
        item.action.candidate,
        allocationUsd,
        `${item.action.reason}:${executorDecision(item.review) || "paper_trade"}`
      );
      if (trade) {
        trade.paper_trade_ticket = buildPaperTradeTicket(
          item.action.candidate,
          allocationUsd,
          item.review,
          item.action.reason
        );
        buyTrades.push(trade);
      }
    }
    if (buyTrades.length) log("buy_trades", buyTrades);

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
    const cycleTrainingEvents = readJsonLines(TRAINING_EVENT_LOG, 1000).filter((record) => record.cycle_id === trainingContext.cycle_id);
    const cyclePipelineLogEntries = [
      { stage: "quant_context", data: { macro_regime: _cycleQuantContext?.macro?.regime, new_positions_ok: _cycleQuantContext?.macro?.new_positions_ok, tighten_stops: _cycleQuantContext?.macro?.tighten_stops } },
      { stage: "scout", data: scoutPayload },
      { stage: "agent_coverage", data: buildAgentCoverageLog("scout", scoutPayload) },
      { stage: "sell_trades", data: sellTrades },
      { stage: "harvest", data: harvestPayload },
      { stage: "agent_coverage", data: buildAgentCoverageLog("harvest", harvestPayload) },
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
      { stage: "stats", data: stats }
    ];
    const managerReport = runManagerDirect({
      ...trainingContext,
      cycle_start_ts: cycleStartTs,
      cycle_end_ts: cycleEndTs,
      scout_result: scoutPayload,
      scout_coverage: buildAgentCoverageLog("scout", scoutPayload),
      scout_llm_meta: getLastLLMMeta("scout"),
      harvest_result: harvestPayload,
      harvest_coverage: buildAgentCoverageLog("harvest", harvestPayload),
      harvest_llm_meta: getLastLLMMeta("harvest"),
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
  }
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const pipelineRunId = crypto.randomUUID();
  const debugMode = Boolean(cli.debug);

  if (!cli.loop) {
    await runCycle({ pipeline_run_id: pipelineRunId, cycle_id: crypto.randomUUID(), cycle_index: 1, debugMode });
    return;
  }

  let stopRequested = false;
  process.on("SIGINT", () => {
    stopRequested = true;
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
}

main().catch((err) => {
  log("error", { message: err.message });
  console.error("\n🔥 Pipeline error:\n", err.message);
  process.exit(1);
});