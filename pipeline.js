import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { buildCurlAuthArgs } from "./e3dAuthClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, "logs");
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
// Tiers: free=50/day @5000ms, premium=500/day @1000ms, enterprise=1000/day @10ms
// Default to premium-safe: 1100ms between requests, max 450 per run (leaves 50 buffer).
const E3D_REQUEST_MIN_INTERVAL_MS = Number(process.env.E3D_REQUEST_MIN_INTERVAL_MS || 1100);
const E3D_REQUEST_DAILY_BUDGET = Number(process.env.E3D_REQUEST_DAILY_BUDGET || 450);
let _e3dRequestCount = 0;
let _e3dLastRequestAt = 0;
const E3D_DOSSIER_CACHE = new Map();
const E3D_API_DEBUG = process.env.E3D_API_DEBUG === "1" || process.env.E3D_DEBUG === "1";
let ACTIVE_TRAINING_CONTEXT = null;
let DATABASE_SCHEMA_READY = false;

fs.mkdirSync(LOG_DIR, { recursive: true });

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

function nowMs() {
  return Date.now();
}

function log(stage, data) {
  fs.appendFileSync(
    PIPELINE_LOG,
    JSON.stringify({ ts: nowIso(), stage, data }) + "\n"
  );
}

function runShell(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
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

  payload.candidates.forEach((proposal) => {
    if (!proposal || typeof proposal !== "object") {
      throw new Error("INVALID_SCOUT_PROPOSAL");
    }

    if (!proposal.token || typeof proposal.token !== "object") {
      throw new Error("SCOUT_TOKEN_MISSING");
    }

    const addr = cleanAddress(proposal.token.contract_address);
    proposal.token.contract_address = addr;

    if (!proposal.token.symbol || typeof proposal.token.symbol !== "string") {
      throw new Error("SCOUT_TOKEN_SYMBOL_MISSING");
    }

    if (!isEvmAddress(addr)) {
      throw new Error(`INVALID_SCOUT_ADDRESS:${addr}`);
    }

    if (!proposal.entry_zone || typeof proposal.entry_zone !== "object") {
      throw new Error("SCOUT_ENTRY_ZONE_MISSING");
    }

    if (!proposal.targets || typeof proposal.targets !== "object") {
      throw new Error("SCOUT_TARGETS_MISSING");
    }
  });

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
      urls.push(`${E3D_API_BASE_URL}/evidence/token/${encodeURIComponent(address)}`);
      urls.push(`${E3D_API_BASE_URL}/stories?q=${encodeURIComponent(address)}&scope=primary&limit=${E3D_DOSSIER_MAX_STORIES}`);
      urls.push(`${E3D_API_BASE_URL}/stories?q=${encodeURIComponent(address)}&scope=primary&type=THESIS&limit=3`);
      urls.push(`${E3D_API_BASE_URL}/wallet-cohorts/${encodeURIComponent(address)}`);
      urls.push(`${E3D_API_BASE_URL}/flow/summary?token_address=${encodeURIComponent(address)}`);
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
      evidence: fetchJson(`/evidence/token/${encodeURIComponent(address)}`),
      stories_primary: fetchJson("/stories", { q: address, scope: "primary", limit: E3D_DOSSIER_MAX_STORIES }),
      theses: fetchJson("/stories", { q: address, scope: "primary", type: "THESIS", limit: 3 }),
      wallet_cohort: fetchJson(`/wallet-cohorts/${encodeURIComponent(address)}`),
      flow_summary: fetchJson("/flow/summary", { token_address: address }),
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

    runShell("docker", [
      "exec",
      "-i",
      MONGO_CONTAINER_NAME,
      "mongosh",
      "--quiet",
      "--eval",
      mongoScript
    ]);
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
    const stdout = runShell("curl", ["-s", "--max-time", "12", "-L", "-o", "-", "-w", `${marker}%{http_code}`, ...buildCurlAuthArgs(url), url]);
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
  for (const key of ["stories", "items", "data", "results", "theses", "opportunities", "wallets", "rows"]) {
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
    .sort((a, b) => toNum(b.score, 0) - toNum(a.score, 0) || new Date(b.ts_created || 0).getTime() - new Date(a.ts_created || 0).getTime())
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

function computeDossierScores({ position, stories, opportunityStories, riskStories, counterparties, tokenCounterparties, marketData, flowSummary, walletCohort }) {
  const allStories = endpointArray(stories);
  const opportunityList = endpointArray(opportunityStories);
  const riskList = endpointArray(riskStories);
  const latestStoryDates = allStories
    .map((story) => daysSince(story?.ts_created || story?.created_at || story?.timestamp))
    .filter((value) => Number.isFinite(value));
  const latestStoryAgeDays = latestStoryDates.length ? Math.min(...latestStoryDates) : NaN;
  const derivedStoryCount = allStories.reduce((sum, story) => sum + toNum(story?.derived_count || story?.meta?.derived_count, 0), 0);
  const positiveStoryCount = allStories.filter((story) => classifyStoryTone(story) === "opportunity").length + opportunityList.length;
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
    100 - (Number.isFinite(latestStoryAgeDays) ? latestStoryAgeDays * 12 : 35) + Math.min(10, positiveStoryCount * 2)
  );
  const thesisStrength = clampScore(
    20 + positiveStoryCount * 14 + derivedStoryCount * 3 + (counterpartyCount > 0 ? 8 : 0) + (marketChange > 0 ? Math.min(12, marketChange) : 0) - negativeStoryCount * 9 - conflictCount * 4
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

function getOrFetchCycleMarketContext() {
  if (_cycleMarketContext) return _cycleMarketContext;
  const tokenUniverse = endpointArray(fetchJson("/fetchTokensDB", { dataSource: E3D_TOKENS_DATA_SOURCE, limit: 50, offset: 0 }));
  const trendingGainers = summarizeTrendingTokens(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    dataSource: E3D_TOKENS_DATA_SOURCE, sortBy: "change_30m_pct", sortDir: "desc", limit: 50
  }), "gainers", 10);
  const trendingLosers = summarizeTrendingTokens(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    dataSource: E3D_TOKENS_DATA_SOURCE, sortBy: "change_30m_pct", sortDir: "asc", limit: 50
  }), "losers", 8);
  _cycleMarketContext = { tokenUniverse, trendingGainers, trendingLosers };
  return _cycleMarketContext;
}

function buildTokenIntelligenceDossier(position, portfolio, options = {}) {
  const address = cleanAddress(position?.contract_address || position?.address || "");
  const symbol = String(position?.symbol || position?.token?.symbol || options?.symbol || "").trim();
  const category = String(position?.category || options?.category || "unknown").trim() || "unknown";
  const cacheKey = `${address || symbol || category}`;
  const cached = getCachedDossier(cacheKey);
  if (cached) return cached;

  // Use shared cycle-level market data — 3 calls instead of 3 × N positions
  const { tokenUniverse, trendingGainers, trendingLosers } = getOrFetchCycleMarketContext();
  const marketFeed = mergeUniqueTokens(trendingGainers, trendingLosers, tokenUniverse);

  const identity = address ? fetchJson("/addressMeta", { address }) : null;
  const tokenInfo = address ? fetchJson(`/token-info/${encodeURIComponent(address)}`) : null;
  const recentTransactions = endpointArray(fetchJson("/fetchTransactionsDB", {
    dataSource: E3D_TRANSACTIONS_DATA_SOURCE,
    search: address || symbol || undefined,
    limit: 25
  }));
  const capabilityEvidence = address ? fetchJson(`/evidence/token/${encodeURIComponent(address)}`) : null;
  // Fetch primary stories only — merging scope=any and symbol-based calls added 2 extra calls
  // per position for data that largely overlaps with scope=primary.
  const tokenStories = address ? endpointArray(fetchJson("/stories", { q: address, scope: "primary", limit: E3D_DOSSIER_MAX_STORIES })) : [];
  const thesisRows = address ? endpointArray(fetchJson("/stories", { q: address, scope: "primary", type: "THESIS", limit: 3 })) : [];
  const walletCohort = address ? fetchJson(`/wallet-cohorts/${encodeURIComponent(address)}`) : null;
  const flowSummary = address ? fetchJson("/flow/summary", { token_address: address }) : null;
  const counterparties = address ? summarizeCounterparties(fetchJson("/addressCounterparties", { address, limit: E3D_DOSSIER_MAX_COUNTERPARTIES })) : [];
  const tokenCounterparties = address ? summarizeCounterparties(fetchJson("/tokenCounterparties", { token: address, limit: E3D_DOSSIER_MAX_COUNTERPARTIES })) : [];
  const capabilityStories = mergeUniqueStories(
    endpointArray(capabilityEvidence?.stories),
    endpointArray(capabilityEvidence?.storys),
    tokenStories,
    thesisRows
  );
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
    riskStories: thesisRows,
    counterparties,
    tokenCounterparties,
    marketData,
    flowSummary,
    walletCohort
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
      wallet_cohort: walletCohort || null,
      flow_summary: flowSummary || null,
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
        wallet_cohort_label: walletCohort?.cohort_label || walletCohort?.label || null,
        flow_direction: flowSummary?.direction || flowSummary?.flow_direction || walletCohort?.flow_direction || "neutral"
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
  scout: [
    "WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN", "SPREAD_WIDENING", "MOMENTUM_DIVERGENCE", "EXCHANGE_FLOW",
    "ACCUMULATION", "SMART_MONEY", "STEALTH_ACCUMULATION", "BREAKOUT_CONFIRMED", "MOVER", "SURGE",
    "CONCENTRATION_SHIFT", "INSIDER_TIMING", "TOKEN_QUALITY_SCORE", "SANDWICH",
  ],
  harvest: [
    "LIQUIDITY_DRAIN", "RUG_LIQUIDITY_PULL", "SPREAD_WIDENING", "EXCHANGE_FLOW",
    "MOMENTUM_DIVERGENCE", "WASH_TRADE", "LOOP", "CONCENTRATION_SHIFT", "WHALE",
    "VOLUME_PROFILE_ANOMALY", "MIRROR", "ACCUMULATION", "SMART_MONEY",
  ],
};

function buildAgentCoverageLog(agentId, payload) {
  const expected = EXPECTED_STORY_TYPES[agentId] || [];

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

function callLLMDirect(systemPrompt, userMessage, { maxRetries = 2 } = {}) {
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
          "--max-time", "600",
          "-d", `@${tmpFile}`
        ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 620000 });
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
      return text.trim();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) sleepSync(5000);
    }
  }
  throw lastErr;
}

// Rotate token universe fetch criteria across cycles to avoid always seeing the same tokens.
const SCOUT_SORT_ROTATION = [
  { sortBy: "change_30m_pct", sortDir: "desc" },
  { sortBy: "change_1h_pct",  sortDir: "desc" },
  { sortBy: "change_24h_pct", sortDir: "desc" },
  { sortBy: "volume_24h_usd", sortDir: "desc" },
  { sortBy: "change_30m_pct", sortDir: "asc"  },  // losers/reversal candidates
  { sortBy: "change_1h_pct",  sortDir: "asc"  },
];
let _scoutCycleIndex = 0;

function fetchScoutData() {
  // Story type categorisation — used to label whatever the API returns
  const disqualifierTypes = new Set(["WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN", "SPREAD_WIDENING",
    "MOMENTUM_DIVERGENCE", "EXCHANGE_FLOW", "SECURITY_RISK", "RUG_LIQUIDITY_PULL", "AIRDROP"]);
  const buySignalTypes = new Set(["ACCUMULATION", "SMART_MONEY", "STEALTH_ACCUMULATION",
    "BREAKOUT_CONFIRMED", "MOVER", "SURGE", "DISCOVERY", "FLOW", "CLUSTER", "THESIS",
    "DELEGATE_SURGE", "NEW_WALLETS", "HOTLINKS", "STAGING", "DEEP_DIVE"]);
  const secondaryTypes = new Set(["CONCENTRATION_SHIFT", "INSIDER_TIMING", "TOKEN_QUALITY_SCORE",
    "SANDWICH", "MIRROR", "VOLUME_PROFILE_ANOMALY", "FUNNEL", "WHALE"]);

  // Fetch all available stories in one call (no type/chain filter — combining them kills results).
  // The API returns one story per active story_type; bucket them locally.
  const allStories = endpointArray(fetchJson("/stories", { limit: 100, chain: "ETH" }));
  const stories = {};
  for (const s of allStories) {
    const t = String(s?.story_type || s?.type || "").toUpperCase();
    if (!t) continue;
    if (!stories[t]) stories[t] = [];
    stories[t].push(s);
  }

  // Rotate sort criteria so each cycle surfaces different tokens
  const sortParams = SCOUT_SORT_ROTATION[_scoutCycleIndex % SCOUT_SORT_ROTATION.length];
  _scoutCycleIndex++;

  const mapToken = (t) => ({
    symbol: t.symbol,
    name: t.name || "",
    address: cleanAddress(t.address || t.contract_address || ""),
    price_usd: t.priceUSD ?? t.price_usd ?? t.priceUsd ?? null,
    change_30m: t.changes?.["30M"]?.percent ?? t.change_30m_pct ?? null,
    change_1h: t.changes?.["1H"]?.percent ?? t.change_1h_pct ?? null,
    change_24h: t.changes?.["24H"]?.percent ?? t.change_24h_pct ?? null,
    market_cap_usd: t.marketCapUSD ?? t.market_cap_usd ?? null,
    liquidity_usd: t.liquidityUSD ?? t.effectiveLiquidityUSD ?? t.liquidity_usd ?? null,
    volume_24h_usd: t.volume24hUSD ?? t.volume_24h_usd ?? null,
    fragility_score: t.fragilityScore ?? null
  });

  // Primary sort: rotated criteria
  const gainers = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    dataSource: 1, ...sortParams, limit: 50
  })).map(mapToken);

  // Always also pull top 30m gainers as a second lens (deduplicated below)
  const topGainers = endpointArray(fetchJson("/fetchTokenPricesWithHistoryAllRanges", {
    dataSource: 1, sortBy: "change_30m_pct", sortDir: "desc", limit: 30
  })).map(mapToken);

  // Merge and deduplicate by address; primary sort list takes precedence
  const seen = new Set();
  const tokenUniverse = [];
  for (const t of [...gainers, ...topGainers]) {
    const addr = t.address;
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    tokenUniverse.push(t);
  }

  return { stories, tokenUniverse, disqualifierTypes, buySignalTypes, secondaryTypes, sortLabel: `${sortParams.sortBy} ${sortParams.sortDir}` };
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
  const secondaryStories = Object.entries(data.stories).filter(([t]) => data.secondaryTypes.has(t) || (!data.disqualifierTypes.has(t) && !data.buySignalTypes.has(t)));

  const formatStory = (s) => {
    const addr = cleanAddress(s?.meta?.token_address || s?.meta?.token?.address || s?.primary_token || s?.token_address || s?.address || "");
    const sym = s?.meta?.token_symbol || s?.meta?.token?.symbol || s?.meta?.entities?.symbol || s?.symbol || s?.title || "";
    const hint = s?.ai_narrative?.slice(0, 150) || s?.meta?.narrative_hint || s?.meta?.ai_narrative?.slice(0, 120) || s?.subtitle || "";
    const score = s?.score ?? null;
    return JSON.stringify({ address: addr, symbol: sym, score, hint });
  };

  const systemPrompt = [
    "You are Scout, a crypto trading research agent.",
    "You have been given pre-fetched E3D market intelligence data. Analyze it and return STRICT JSON only — one object, no markdown, no commentary.",
    "Disqualify any token whose address appears in the DISQUALIFIERS section.",
    "Score candidates from the BUY SIGNALS section using real evidence values from the data.",
    "Return up to 3 buy candidates. Only return candidates:[] if zero tokens survived disqualification with any positive signal.",
    `Exclude: symbols=${JSON.stringify([...heldSymbols])} addresses=${JSON.stringify([...heldAddresses])}`,
    `Output shape: {scan_timestamp, candidates[], holdings_updates[], stories_checked[]}`,
    `Each candidate: {source_agent:"scout", created_at:"${createdAt}", expires_at:"${expiresAt}", token:{symbol,name,chain:"ethereum",contract_address,category}, setup_type, action:"buy", confidence, conviction_score, opportunity_score, why_now, evidence[], risks[], entry_zone:{low,high}, invalidation_price, targets:{target_1,target_2,target_3}, market_data:{current_price,change_24h_pct,change_30m_pct,price_source:"e3d",market_cap_usd}, liquidity_data:{liquidity_usd,liquidity_source:"e3d"}, execution_data:{estimated_slippage_bps,quote_source:"e3d"}, portfolio_data:{current_token_exposure_pct:0,current_category_exposure_pct:0,current_total_exposure_pct:0}}`,
    `stories_checked[]: one entry per story type — {type, found, tokens[]}`
  ].join("\n");

  const userMessage = [
    `Scout task — ${createdAt} [token universe sorted by: ${data.sortLabel}]`,
    `Portfolio: cash=$${portfolio?.cash_usd ?? 100000} positions=${Object.keys(portfolio?.positions || {}).length}`,
    `\n--- DISQUALIFIERS (addresses to exclude) ---`,
    ...disqualifierStories.map(([type, items]) => {
      const addrs = items.map((s) => cleanAddress(s?.meta?.token_address || s?.primary_token || s?.token_address || "")).filter(Boolean);
      return `${type} (${items.length} stories): ${addrs.slice(0, 5).join(", ") || "none"}`;
    }),
    disqualifierStories.length === 0 ? "none" : "",
    `\n--- BUY SIGNALS ---`,
    ...buySignalStories.map(([type, items]) => {
      return `${type} (${items.length} found):\n${items.slice(0, 5).map(formatStory).join("\n")}`;
    }),
    buySignalStories.length === 0 ? "none currently" : "",
    `\n--- SECONDARY SIGNALS ---`,
    ...secondaryStories.map(([type, items]) => {
      const addrs = items.slice(0, 3).map((s) => cleanAddress(s?.meta?.token_address || s?.primary_token || s?.token_address || "")).filter(Boolean);
      return `${type} (${items.length}): ${addrs.join(", ") || "none"}`;
    }),
    `\n--- TOKEN UNIVERSE (${data.tokenUniverse.length} tokens, sorted by ${data.sortLabel}) ---`,
    JSON.stringify(data.tokenUniverse.slice(0, 20))
  ].join("\n");

  const rawText = callLLMDirect(systemPrompt, userMessage);

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
    const preview = rawText.slice(0, 500);
    throw new Error(`SCOUT_REPLY_NOT_JSON\n${preview}`);
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

  // Pre-fetch exit-risk stories for held addresses — fetch all at once, bucket locally
  // (type+chain filter combination returns 0 results from the API)
  const heldAddresses = positions.map((p) => cleanAddress(p?.contract_address || "")).filter(Boolean);
  const exitRiskTypes = ["LIQUIDITY_DRAIN", "WASH_TRADE", "SPREAD_WIDENING", "MOMENTUM_DIVERGENCE", "EXCHANGE_FLOW", "LOOP",
    "SECURITY_RISK", "RUG_LIQUIDITY_PULL"];
  const holdConfirmTypes = ["ACCUMULATION", "SMART_MONEY", "MOVER", "SURGE", "FLOW", "CLUSTER"];

  const allHarvestStories = endpointArray(e3dFetch(`${E3D_API_BASE_URL}/stories?limit=100&chain=ETH`));
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

  const positionData = dossier.holdings.slice(0, 8).map((item) => ({
    symbol: item?.token?.symbol || null,
    contract_address: item?.token?.contract_address || null,
    category: item?.token?.category || "unknown",
    quantity: toNum(item?.position?.quantity, 0),
    avg_entry_price: toNum(item?.position?.avg_entry_price, 0),
    current_price: toNum(item?.market_data?.current_price, 0),
    market_value_usd: toNum(item?.position?.market_value_usd, 0),
    cost_basis_usd: toNum(item?.position?.cost_basis_usd, 0),
    unrealized_pnl_usd: toNum(item?.position?.market_value_usd, 0) - toNum(item?.position?.cost_basis_usd, 0),
    thesis_strength: item?.thesis?.strength ?? null,
    thesis_freshness: item?.thesis?.freshness ?? null,
    narrative_decay: item?.thesis?.decay ?? null,
    opportunity_score: item?.thesis?.opportunity_score ?? null,
    fraud_risk: item?.thesis?.fraud_risk ?? null
  }));

  const systemPrompt = [
    "You are Harvest, a crypto portfolio exit-scan agent.",
    "You have been given pre-fetched E3D exit-risk story data for held positions. Analyze it and return STRICT JSON only — one object, no markdown.",
    "Classify every held position as hold, monitor, trim, or exit based on the evidence.",
    "Only add a position to exit_candidates if action is trim or exit.",
    `Output shape: {scan_timestamp, portfolio_summary, position_reviews[], exit_candidates[], stories_checked[]}`,
    `Each position_review: {source_agent:"harvest", created_at:"${createdAt}", expires_at:"${expiresAt}", token:{symbol,name,chain:"ethereum",contract_address,category}, position:{quantity,avg_entry_price,current_price,market_value_usd,cost_basis_usd,unrealized_pnl_usd}, action:"hold"|"monitor"|"trim"|"exit", thesis_state, thesis_summary, what_changed, why_now, confidence, conviction_score, opportunity_score, review_priority, summary, evidence[], risks[], what_would_change_my_mind[], next_best_alternative, current_regime, market_data:{current_price,change_24h_pct,price_source:"e3d"}, narrative_data:{story_strength,thesis_health,flow_direction}}`,
    `Each exit_candidate: same as position_review plus {setup_type, edge_source, suggested_exit_fraction, target_exit_price, decision_price, exit_priority}`
  ].join("\n");

  const userMessage = [
    `Harvest task — ${createdAt}`,
    `Held positions (${positionData.length}):`,
    JSON.stringify(positionData),
    `\n--- EXIT RISK STORIES (matched to held addresses) ---`,
    ...exitRiskTypes.map((type) => {
      const matches = storyMatches[type] || [];
      return `${type}: ${matches.length} matches — ${JSON.stringify(matches.slice(0, 3))}`;
    }),
    `\n--- HOLD CONFIRM SIGNALS ---`,
    ...holdConfirmTypes.map((type) => {
      const matches = storyMatches[type] || [];
      return `${type}: ${matches.length} matches — ${JSON.stringify(matches.slice(0, 3))}`;
    })
  ].join("\n");

  const rawText = callLLMDirect(systemPrompt, userMessage);

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
    throw new Error(`HARVEST_REPLY_NOT_JSON\n${rawText.slice(0, 500)}`);
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
4. For each held position: fetch /stories?q={address}&scope=primary&limit=10, flow/summary, wallet-cohort.
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
  ]
}

RULES: position_reviews covers every held position — exit_candidates only for trim/exit — valid lowercase addresses — one object only.
Include a top-level "stories_checked" array listing every story type you fetched, with "found" count and any "flagged_addresses" that influenced your decision. This is required for audit.
Example: [{"type":"LIQUIDITY_DRAIN","found":2,"flagged_addresses":["0x..."]},{"type":"ACCUMULATION","found":0,"flagged_addresses":[]}]
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

function evaluateSellActions(portfolio) {
  const actions = [];
  const targetPct = portfolio.settings.target_partial_pct;

  for (const pos of Object.values(portfolio.positions)) {
    const price = toNum(pos.current_price, 0);
    if (!(price > 0)) continue;

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

  // Reset per-cycle state
  _cycleMarketContext = null;

  const portfolio = loadPortfolio();
  pruneCooldowns(portfolio);
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