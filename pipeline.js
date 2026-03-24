import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, "logs");
const PORTFOLIO_FILE = path.join(__dirname, "portfolio.json");
const PIPELINE_LOG = path.join(LOG_DIR, "pipeline.jsonl");
const TRAINING_EVENT_LOG = path.join(LOG_DIR, "training-events.jsonl");
const TRAINING_EVENT_SCHEMA_VERSION = "1.0";
const MONGO_CONTAINER_NAME = process.env.E3D_MONGO_CONTAINER || "e3d-mongo";
const MONGO_DATABASE_NAME = process.env.E3D_MONGO_DATABASE || "e3d";
const CLICKHOUSE_HTTP_URL = process.env.E3D_CLICKHOUSE_HTTP_URL || "http://127.0.0.1:8123";
const CLICKHOUSE_DATABASE_NAME = process.env.E3D_CLICKHOUSE_DATABASE || "e3d";
const CLICKHOUSE_TABLE_NAME = process.env.E3D_CLICKHOUSE_TABLE || "training_events";
const AGENT_WORKSPACES = {
  scout: path.join(__dirname, "scout"),
  harvest: path.join(__dirname, "harvest"),
  risk: path.join(__dirname, "risk"),
  executor: path.join(__dirname, "executor")
};
const AGENT_CONTEXT_FILES = [
  "AGENTS.md",
  "IDENTITY.md",
  "MEMORY.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md"
];
const AGENT_CONTEXT_CACHE = new Map();
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
  return new Date().toISOString();
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

  payload.exit_candidates.forEach((proposal) => {
    if (!proposal || typeof proposal !== "object") {
      throw new Error("INVALID_HARVEST_PROPOSAL");
    }

    const addr = cleanAddress(proposal?.token?.contract_address);
    proposal.token.contract_address = addr;

    if (!isEvmAddress(addr)) {
      throw new Error(`INVALID_HARVEST_ADDRESS:${addr}`);
    }

    if (!proposal.position || typeof proposal.position !== "object") {
      proposal.position = {};
    }
  });
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
    const mongoScript = `
      const dbName = process.env.MONGO_DATABASE_NAME || ${JSON.stringify(MONGO_DATABASE_NAME)};
      const payload = ${JSON.stringify(portfolio)};
      const dbRef = db.getSiblingDB(dbName);
      dbRef.portfolio_state.updateOne(
        { _id: "current" },
        { $set: { ...payload, _id: "current", updated_at: new Date().toISOString() } },
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

function recordHarvestDecisionEvent(proposal, harvest, portfolio, context = {}) {
  const token = proposal?.token || {};
  const record = buildTrainingEventRecord("harvest_decision", "harvest", portfolio, context, {
    candidate_id: token?.contract_address || token?.symbol || null,
    decision: harvest?.decision ?? proposal?.action ?? null,
    harvest_review: harvest || null,
    proposal: proposal || null
  });
  appendTrainingEvent(record);
  return record;
}

function recordCandidateEvent(candidate, portfolio, context = {}) {
  const token = candidate?.token || {};
  const record = buildTrainingEventRecord("candidate", "scout", portfolio, context, {
    candidate_id: candidate?.candidate_id || candidate?.id || token.contract_address || token.symbol || null,
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
    maxIterations: Infinity
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

function loadAgentContext(agentId) {
  if (AGENT_CONTEXT_CACHE.has(agentId)) {
    return AGENT_CONTEXT_CACHE.get(agentId);
  }

  const workspace = AGENT_WORKSPACES[agentId];
  if (!workspace || !fs.existsSync(workspace)) {
    AGENT_CONTEXT_CACHE.set(agentId, "");
    return "";
  }

  const blocks = [];
  for (const fileName of AGENT_CONTEXT_FILES) {
    const filePath = path.join(workspace, fileName);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) continue;

    blocks.push(`### ${agentId.toUpperCase()} / ${fileName}\n\n${content}`);
  }

  const context = blocks.join("\n\n");
  AGENT_CONTEXT_CACHE.set(agentId, context);
  return context;
}

function withAgentContext(agentId, taskPrompt) {
  const context = loadAgentContext(agentId);
  return [context, taskPrompt].filter(Boolean).join("\n\n").trim();
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

function parseAgentWrapper(stdout, agentId) {
  let wrapper;
  try {
    wrapper = JSON.parse(stdout);
  } catch {
    throw new Error(`${agentId.toUpperCase()}_WRAPPER_NOT_JSON\n${stdout}`);
  }

  const reply =
    wrapper?.reply ??
    wrapper?.message ??
    wrapper?.text ??
    wrapper?.output ??
    wrapper?.content ??
    wrapper?.result?.payloads?.[0]?.text;

  if (typeof reply !== "string") {
    throw new Error(`${agentId.toUpperCase()}_MISSING_REPLY_TEXT\n${stdout}`);
  }

  try {
    return JSON.parse(reply);
  } catch {
    throw new Error(`${agentId.toUpperCase()}_REPLY_NOT_JSON\n${reply}`);
  }
}

function callAgent(agentId, message) {
  const stdout = execFileSync(
    "openclaw",
    ["agent", "--agent", agentId, "--message", message, "--json"],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    }
  );

  return parseAgentWrapper(stdout, agentId);
}

function buildScoutPrompt(portfolio) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  const holdings = Object.values(portfolio.positions).map((p) => ({
    symbol: p.symbol,
    contract_address: p.contract_address,
    category: p.category || "unknown"
  }));

  const taskPrompt = `
You are Scout.

Your job:
1. Fetch the top momentum tokens from E3D
2. Select the BEST 3 candidate buys
3. Refresh market snapshots for all currently held tokens
4. Return STRICT JSON only

DO NOT:
- ask questions
- explain anything
- return markdown
- return partial data

PRIMARY TOP-TOKEN ENDPOINT:
Use only variations of this family for the token discovery list:
https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?sortBy=change_24H&sortDir=desc&limit=20&offset=0&hideNoCirc=1

Allowed variations:
- limit: use as needed for N
- offset: pagination offset
- sortBy: change_1H, change_12H, change_24H, marketCap, price, likes, circulatingSupply
- sortDir: asc or desc
- hideNoCirc: 1 for cleaner lists
- search: name/symbol/address
- category: comma-separated categories
- dataSource: optional, defaults to ETH main list in this codebase

SUPPORTING ANALYSIS FEEDS:
- Cross-token opportunity feed: GET /api/agent/candidates?status=new,promoted&limit=50
- Whale accumulation stories: GET /api/stories/whale?direction=IN&limit=50&offset=0
- Hydrate story IDs when needed with POST /api/stories/byIds or GET /api/stories/byId?storyId=...

Use the top-token endpoint to discover candidates, then use the candidate and whale-story feeds to understand signal convergence, token behavior, and thesis quality.

Selection rules for candidates:
- filter out invalid or missing contract addresses
- do not include any token already held in the portfolio in the candidate list
- filter out low liquidity tokens
- avoid obvious scams
- prioritize strong 24H momentum, decent market cap, and acceptable fragility
- return EXACTLY 3 candidate proposals if possible; otherwise return as many valid ones as available

Current holdings to refresh:
${JSON.stringify(holdings)}

CRITICAL RULES:
- all contract_address values must be 0x + 40 hex chars
- remove any whitespace from addresses before output
- emit contract_address values in lowercase only
- never include spaces, tabs, zero-width characters, or other separators in addresses
- output must be valid JSON
- no broken keys
- no comments

Return EXACTLY this shape:

{
  "scan_timestamp": "${createdAt}",
  "candidates": [
    {
      "proposal_version": "1.0",
      "source_agent": "scout",
      "created_at": "${createdAt}",
      "expires_at": "${expiresAt}",
      "token": {
        "symbol": "...",
        "name": "...",
        "chain": "ethereum",
        "contract_address": "...",
        "category": "..."
      },
      "setup_type": "swing",
      "edge_source": "momentum_leader",
      "action": "buy",
      "confidence": 0,
      "conviction_score": 0,
      "opportunity_score": 0,
      "time_horizon": "days",
      "decision_price": 0,
      "entry_zone": { "min": 0, "max": 0 },
      "invalidation_price": 0,
      "targets": {
        "target_1": 0,
        "target_2": 0,
        "target_3": 0
      },
      "suggested_position_size_pct": 1.5,
      "max_position_size_pct": 2.0,
      "fraud_risk": 0,
      "liquidity_quality": 0,
      "summary": "...",
      "why_now": "...",
      "evidence": ["..."],
      "risks": ["..."],
      "what_would_change_my_mind": ["..."],
      "next_best_alternative": "...",
      "max_slippage_bps": 75,
      "min_liquidity_usd": 250000,
      "max_decision_drift_pct": 2.0,
      "market_data": {
        "current_price": 0,
        "change_24h_pct": 0,
        "price_timestamp": "${createdAt}",
        "price_source": "e3d",
        "volume_24h_usd": 0,
        "market_cap_usd": 0
      },
      "liquidity_data": {
        "liquidity_usd": 0,
        "liquidity_timestamp": "${createdAt}",
        "liquidity_source": "e3d"
      },
      "execution_data": {
        "estimated_slippage_bps": 0,
        "quote_timestamp": "${createdAt}",
        "quote_source": "e3d"
      },
      "portfolio_data": {
        "current_token_exposure_pct": 0.0,
        "current_category_exposure_pct": 0.0,
        "current_total_exposure_pct": 0.0,
        "single_position_cap_pct": 5.0,
        "category_cap_pct": 10.0,
        "total_exposure_cap_pct": 50.0,
        "portfolio_timestamp": "${createdAt}",
        "portfolio_source": "system"
      }
    }
  ],
  "holdings_updates": [
    {
      "symbol": "...",
      "contract_address": "...",
      "category": "...",
      "market_data": {
        "current_price": 0,
        "price_timestamp": "${createdAt}",
        "price_source": "e3d",
        "volume_24h_usd": 0,
        "market_cap_usd": 0
      },
      "liquidity_data": {
        "liquidity_usd": 0,
        "liquidity_timestamp": "${createdAt}",
        "liquidity_source": "e3d"
      },
      "execution_data": {
        "estimated_slippage_bps": 0,
        "quote_timestamp": "${createdAt}",
        "quote_source": "e3d"
      },
      "opportunity_score": 0,
      "conviction_score": 0,
      "liquidity_quality": 0,
      "fraud_risk": 0,
      "why_now": "...",
      "risks": ["..."]
    }
  ]
}

FINAL CHECK BEFORE OUTPUT:
- JSON parses
- all contract addresses valid and without spaces
- candidates length <= 3
- only one JSON object returned
`.trim();

  return withAgentContext("scout", taskPrompt);
}

function buildHarvestPrompt(portfolio) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

  const positions = Object.values(portfolio.positions || {}).map((p) => ({
    symbol: p.symbol,
    contract_address: p.contract_address,
    category: p.category || "unknown",
    quantity: p.quantity,
    avg_entry_price: p.avg_entry_price,
    current_price: p.current_price,
    market_value_usd: p.market_value_usd,
    cost_basis_usd: p.cost_basis_usd,
    unrealized_pnl_usd: toNum(p.market_value_usd, 0) - toNum(p.cost_basis_usd, 0),
    stop_price: p.stop_price || null,
    targets: p.targets || null,
    opened_at: p.opened_at || null
  }));

  const taskPrompt = `
You are Harvest.

Your job:
1. Review every held token for profit-taking, thesis decay, liquidity deterioration, or narrative exhaustion
2. Use the E3D.ai token APIs to research each held position before suggesting an exit or trim
3. Return STRICT JSON only

DO NOT:
- ask questions
- return markdown
- return partial data
- originate buy ideas

PRIMARY RESEARCH FEEDS:
- Use GET /api/token/:address for each held position
- For market context, compare against:
  - https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?sortBy=change_24H&sortDir=desc&limit=50&offset=0&hideNoCirc=1
  - https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?sortBy=change_24H&sortDir=asc&limit=50&offset=0&hideNoCirc=1

EXIT DECISION GOALS:
- harvest gains when momentum is stretched
- trim when liquidity weakens or thesis quality fades
- exit when downside risk dominates
- hold when the position is still healthy

Current held positions to review:
${JSON.stringify(positions)}

Return EXACTLY this shape:

{
  "scan_timestamp": "${createdAt}",
  "exit_candidates": [
    {
      "proposal_version": "1.0",
      "source_agent": "harvest",
      "created_at": "${createdAt}",
      "expires_at": "${expiresAt}",
      "token": {
        "symbol": "...",
        "name": "...",
        "chain": "ethereum",
        "contract_address": "...",
        "category": "..."
      },
      "position": {
        "quantity": 0,
        "avg_entry_price": 0,
        "current_price": 0,
        "market_value_usd": 0,
        "cost_basis_usd": 0,
        "unrealized_pnl_usd": 0
      },
      "setup_type": "profit_take",
      "edge_source": "distribution_warning",
      "action": "exit",
      "confidence": 0,
      "conviction_score": 0,
      "opportunity_score": 0,
      "exit_priority": 0,
      "suggested_exit_fraction": 0.5,
      "target_exit_price": 0,
      "decision_price": 0,
      "summary": "...",
      "why_now": "...",
      "evidence": ["..."],
      "risks": ["..."],
      "what_would_change_my_mind": ["..."],
      "next_best_alternative": "...",
      "current_regime": "neutral",
      "market_data": {
        "current_price": 0,
        "change_24h_pct": 0,
        "price_timestamp": "${createdAt}",
        "price_source": "e3d",
        "volume_24h_usd": 0,
        "market_cap_usd": 0
      },
      "liquidity_data": {
        "liquidity_usd": 0,
        "liquidity_timestamp": "${createdAt}",
        "liquidity_source": "e3d"
      },
      "narrative_data": {
        "story_strength": 0,
        "thesis_health": 0,
        "flow_direction": "neutral"
      },
      "portfolio_data": {
        "current_token_exposure_pct": 0.0,
        "current_category_exposure_pct": 0.0,
        "current_total_exposure_pct": 0.0,
        "portfolio_timestamp": "${createdAt}",
        "portfolio_source": "system"
      }
    }
  ]
}

FINAL CHECK BEFORE OUTPUT:
- JSON parses
- all contract addresses valid and without spaces
- exit_candidates length <= 5
- only one JSON object returned
`.trim();

  return withAgentContext("harvest", taskPrompt);
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

  return withAgentContext("risk", taskPrompt);
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

  return withAgentContext("executor", taskPrompt);
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

function runRiskForCandidates(candidates, portfolio) {
  const approved = [];
  const rejected = [];

  for (const proposal of candidates) {
    const risk = callAgent("risk", buildRiskPrompt(proposal));
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

function runExecutorForActions(actions, portfolio, tradeKind) {
  const reviewed = [];

  for (const action of actions) {
    const proposal = buildExecutorProposal(action, portfolio, tradeKind);
    const review = callAgent("executor", buildExecutorPrompt(proposal, portfolio));
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

async function runCycle(runContext = {}) {
  console.log(`\n🚀 Starting pipeline at ${nowIso()}\n`);

  const portfolio = loadPortfolio();
  pruneCooldowns(portfolio);
  const trainingContext = {
    pipeline_run_id: runContext.pipeline_run_id || crypto.randomUUID(),
    cycle_id: runContext.cycle_id || crypto.randomUUID(),
    cycle_index: runContext.cycle_index ?? null,
    market_regime: portfolio.stats.market_regime || "unknown"
  };
  setTrainingContext(trainingContext);
  recordCycleEvent("cycle_start", trainingContext, portfolio, {
    settings: deepClone(portfolio.settings)
  });

  try {
    // 1. SCOUT
    const scoutPayload = callAgent("scout", buildScoutPrompt(portfolio));
    validateScoutPayload(scoutPayload);
    scoutPayload.candidates = filterScoutCandidatesAgainstPortfolio(scoutPayload.candidates || [], portfolio);
    log("scout", scoutPayload);
    for (const candidate of scoutPayload.candidates || []) {
      recordCandidateEvent(candidate, portfolio, trainingContext);
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
    const harvestPayload = callAgent("harvest", buildHarvestPrompt(portfolio));
    validateHarvestPayload(harvestPayload);
    log("harvest", harvestPayload);
    for (const candidate of harvestPayload.exit_candidates || []) {
      recordHarvestDecisionEvent(candidate, candidate, portfolio, trainingContext);
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
      rejected_count: rejected.length
    });
  } finally {
    setTrainingContext(null);
  }
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const pipelineRunId = crypto.randomUUID();

  if (!cli.loop) {
    await runCycle({ pipeline_run_id: pipelineRunId, cycle_id: crypto.randomUUID(), cycle_index: 1 });
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
    await runCycle({ pipeline_run_id: pipelineRunId, cycle_id: crypto.randomUUID(), cycle_index: iteration });

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