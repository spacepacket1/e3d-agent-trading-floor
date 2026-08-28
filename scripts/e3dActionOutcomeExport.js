#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

export const EXPORTER_SCHEMA_VERSION = "1.0";
export const EXPORTER_PHASE = "phase_6_manual_validation";
export const DEFAULT_LIMIT = 5000;
export const DEFAULT_SINCE_HOURS = 24;
export const DEFAULT_OVERLAP_MINUTES = 10;
export const DEFAULT_LOCK_STALE_MINUTES = 30;
export const DEFAULT_INSERT_BATCH_SIZE = 1000;
export const DEFAULT_CORP_TIMEOUT_MS = 5000;
export const DEFAULT_CORP_MAX_ATTEMPTS = 3;
export const PHASE_1_EVENT_TYPES = ["executor_decision", "trade", "outcome"];
export const SOURCE_APP = "e3d-agent-trading-floor";
export const DESTINATION_TABLE_NAMES = [
  "E3DAgentActions",
  "E3DAgentOutcomes",
  "E3DAgentCycleScorecards",
  "E3DAgentExportAudit"
];

export const DESTINATION_TABLE_DDLS = {
  E3DAgentActions: `CREATE TABLE IF NOT EXISTS {database}.E3DAgentActions
(
  action_id String,
  updated_at DateTime64(3),
  created_at DateTime64(3),

  source_app LowCardinality(String),
  source_schema_version String,
  source_event_id String,
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime LowCardinality(String),

  token_address String,
  symbol String,
  chain LowCardinality(String),

  agent_stage LowCardinality(String),
  actor LowCardinality(String),
  event_type LowCardinality(String),
  trade_kind LowCardinality(String),

  agent_decision LowCardinality(String),
  action_type LowCardinality(String),
  simulated_side LowCardinality(String),

  candidate_id String,
  position_id String,
  trade_id String,

  entry_price Float64,
  allocation_usd Float64,
  confidence_score Float64,
  risk_score Float64,
  liquidity_usd Float64,
  slippage_bps Float64,
  fee_bps Float64,

  thesis_summary String,
  reason_summary String,
  reject_reason String,

  source_story_ids Array(String),
  source_signal_types Array(String),
  evidence_packet_id String,
  risk_decision_id String,

  expires_at DateTime64(3),
  thesis_state LowCardinality(String),
  thesis_freshness Float64,
  narrative_decay Float64,
  story_strength Float64,
  flow_direction LowCardinality(String),
  action_tilt LowCardinality(String),
  price_freshness LowCardinality(String),
  liquidity_freshness LowCardinality(String),

  payload_json String
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (action_id);`,
  E3DAgentOutcomes: `CREATE TABLE IF NOT EXISTS {database}.E3DAgentOutcomes
(
  outcome_id String,
  action_id String,
  updated_at DateTime64(3),
  measured_at DateTime64(3),

  source_app LowCardinality(String),
  source_schema_version String,
  source_event_id String,
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime LowCardinality(String),

  token_address String,
  symbol String,
  chain LowCardinality(String),

  candidate_id String,
  position_id String,
  trade_id String,

  outcome_type LowCardinality(String),
  outcome_window LowCardinality(String),
  outcome_label LowCardinality(String),
  verdict LowCardinality(String),

  entry_price Float64,
  exit_price Float64,
  current_price Float64,
  price_delta_pct Float64,
  pnl_usd Float64,
  pnl_pct Float64,
  max_gain_pct Float64,
  max_drawdown_pct Float64,
  holding_days Float64,

  liquidity_delta_pct Float64,
  volume_delta_pct Float64,
  holder_delta_pct Float64,

  payload_json String
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (outcome_id);`,
  E3DAgentCycleScorecards: `CREATE TABLE IF NOT EXISTS {database}.E3DAgentCycleScorecards
(
  scorecard_id String,
  updated_at DateTime64(3),
  created_at DateTime64(3),

  source_app LowCardinality(String),
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime LowCardinality(String),

  scout_candidates Int32,
  risk_approved Int32,
  risk_rejected Int32,
  executor_decisions Int32,
  paper_buys Int32,
  paper_sells Int32,
  paper_holds Int32,
  paper_rejections Int32,

  cash_usd Float64,
  equity_usd Float64,
  realized_pnl_usd Float64,
  unrealized_pnl_usd Float64,
  open_positions Int32,

  warning_count Int32,
  critical_count Int32,
  score Float64,
  grade LowCardinality(String),

  payload_json String
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (scorecard_id);`,
  E3DAgentExportAudit: `CREATE TABLE IF NOT EXISTS {database}.E3DAgentExportAudit
(
  export_run_id String,
  started_at DateTime64(3),
  completed_at DateTime64(3),
  status LowCardinality(String),
  source_min_ts String,
  source_max_ts String,
  source_events_read Int32,
  actions_written Int32,
  outcomes_written Int32,
  scorecards_written Int32,
  error_message String,
  payload_json String
)
ENGINE = MergeTree
ORDER BY (started_at, export_run_id);`
};

function nowIso(date = new Date()) {
  return date.toISOString();
}

function normalizeText(value, fallback = "") {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseBooleanEnv(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function safeIso(value, flagName) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const ms = new Date(text).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ${flagName} timestamp: ${text}`);
  }
  return new Date(ms).toISOString();
}

function parseNumberOption(value, flagName, { min = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${flagName} value: ${value}`);
  if (min != null && n < min) throw new Error(`${flagName} must be >= ${min}`);
  return n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function consumeValue(argv, index, inlineValue, flagName) {
  if (inlineValue != null) return inlineValue;
  const next = argv[index + 1];
  if (next == null || String(next).startsWith("--")) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return next;
}

export function parseArgs(argv = []) {
  const options = {
    dryRun: false,
    sinceHours: null,
    limit: DEFAULT_LIMIT,
    noState: false,
    fromTs: null,
    toTs: null,
    createTablesOnly: false,
    sourceClickHouse: false,
    verbose: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!String(arg).startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [flagName, inlineValue] = String(arg).split("=", 2);

    switch (flagName) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-state":
        options.noState = true;
        break;
      case "--create-tables-only":
        options.createTablesOnly = true;
        break;
      case "--source-clickhouse":
        options.sourceClickHouse = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--since-hours":
        options.sinceHours = parseNumberOption(consumeValue(argv, index, inlineValue, flagName), flagName, { min: 0 });
        if (inlineValue == null) index += 1;
        break;
      case "--limit":
        options.limit = parseNumberOption(consumeValue(argv, index, inlineValue, flagName), flagName, { min: 1 });
        if (inlineValue == null) index += 1;
        break;
      case "--from-ts":
        options.fromTs = safeIso(consumeValue(argv, index, inlineValue, flagName), flagName);
        if (inlineValue == null) index += 1;
        break;
      case "--to-ts":
        options.toTs = safeIso(consumeValue(argv, index, inlineValue, flagName), flagName);
        if (inlineValue == null) index += 1;
        break;
      default:
        throw new Error(`Unknown flag: ${flagName}`);
    }
  }

  if (options.fromTs && options.toTs && options.fromTs > options.toTs) {
    throw new Error("--from-ts must be <= --to-ts");
  }
  if (options.sinceHours == null) {
    options.sinceHours = DEFAULT_SINCE_HOURS;
  }

  return options;
}

function resolvePath(root, value, fallbackRelativePath) {
  const raw = value || fallbackRelativePath;
  return path.isAbsolute(raw) ? raw : path.join(root, raw);
}

function sanitizeUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function requireConfiguredClickHouse(client, purpose) {
  if (!client?.config?.baseUrl) {
    throw new Error(`AWS ClickHouse baseUrl is required for ${purpose}. Set AWS_E3D_CLICKHOUSE_HTTP_URL.`);
  }
}

function optionalMs(value) {
  if (value == null || value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanAddress(value) {
  const text = normalizeText(value);
  if (!text) return "";
  return text.startsWith("0x") ? text.toLowerCase() : text;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function ratioPct(numerator, denominator) {
  if (!(denominator > 0) || numerator == null) return 0;
  return (numerator / denominator) * 100;
}

function jsonString(value) {
  return JSON.stringify(value ?? {});
}

function toDateTime64Ms(value) {
  if (value == null || value === "") return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function buildActionId(record, agentDecision, tokenAddress) {
  return sha256Text([
    normalizeText(record?.pipeline_run_id),
    normalizeText(record?.cycle_id),
    normalizeText(record?.candidate_id),
    normalizeText(record?.trade_id),
    normalizeText(record?.event_type),
    normalizeText(record?.actor),
    normalizeText(agentDecision),
    cleanAddress(tokenAddress)
  ].join("|"));
}

function buildOutcomeId({ actionId = "", record, outcomeWindow, measuredAt }) {
  return sha256Text([
    normalizeText(actionId),
    normalizeText(record?.trade_id),
    normalizeText(record?.position_id),
    normalizeText(outcomeWindow),
    normalizeText(measuredAt),
    normalizeText(record?.event_type)
  ].join("|"));
}

function parsePayloadValue(payload, contextLabel) {
  if (payload == null) return {};
  if (typeof payload === "object") return payload;
  if (typeof payload !== "string") {
    throw new Error(`Invalid payload for ${contextLabel}`);
  }
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error(`Invalid payload JSON for ${contextLabel}`);
  }
}

function normalizeTrainingEvent(record, contextLabel) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`Invalid event row for ${contextLabel}`);
  }
  return {
    ...record,
    payload: parsePayloadValue(record.payload, contextLabel)
  };
}

function buildTimeWindow(options, now = new Date()) {
  const upperMs = options.toTs ? optionalMs(options.toTs) : null;
  const lowerMs = options.fromTs
    ? optionalMs(options.fromTs)
    : ((options.sinceHours != null) ? now.getTime() - (options.sinceHours * 60 * 60 * 1000) : null);
  return {
    fromTs: lowerMs == null ? null : new Date(lowerMs).toISOString(),
    toTs: upperMs == null ? null : new Date(upperMs).toISOString(),
    fromMs: lowerMs,
    toMs: upperMs
  };
}

function shouldIncludeEvent(record, filters) {
  if (!PHASE_1_EVENT_TYPES.includes(record?.event_type)) return false;
  const tsMs = optionalMs(record?.ts);
  if (tsMs == null) return false;
  if (filters.fromMs != null && tsMs < filters.fromMs) return false;
  if (filters.toMs != null && tsMs > filters.toMs) return false;
  return true;
}

function readLinesSync(filePath, onLine) {
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let remainder = "";

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      remainder += buffer.toString("utf8", 0, bytesRead);
      const lines = remainder.split("\n");
      remainder = lines.pop() || "";
      for (const line of lines) {
        onLine(line);
      }
    }
    if (remainder) {
      onLine(remainder);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function buildClickHouseUnavailableError() {
  return new Error("ClickHouse unavailable — run without --source-clickhouse to use the default JSONL source.");
}

function isClickHouseUnavailableError(error) {
  const text = [
    error?.message,
    error?.stdout,
    error?.stderr
  ].filter(Boolean).join("\n");
  return /HTTP 516/i.test(text)
    || /Failed to connect/i.test(text)
    || /Connection refused/i.test(text)
    || /Could not resolve host/i.test(text)
    || /timed out/i.test(text)
    || /ECONNREFUSED/i.test(text)
    || /ECONNRESET/i.test(text);
}

function escapeClickHouseString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function buildClickHouseSourceQuery({ tableName, filters, limit }) {
  const parsedTs = "parseDateTime64BestEffortOrNull(ts)";
  const where = [
    `event_type IN (${PHASE_1_EVENT_TYPES.map((value) => `'${value}'`).join(", ")})`,
    `${parsedTs} IS NOT NULL`
  ];
  if (filters.fromTs) {
    where.push(`${parsedTs} >= parseDateTime64BestEffort('${escapeClickHouseString(filters.fromTs)}')`);
  }
  if (filters.toTs) {
    where.push(`${parsedTs} <= parseDateTime64BestEffort('${escapeClickHouseString(filters.toTs)}')`);
  }

  return [
    "SELECT",
    "  event_id,",
    "  schema_version,",
    "  ts,",
    "  event_type,",
    "  actor,",
    "  pipeline_run_id,",
    "  cycle_id,",
    "  cycle_index,",
    "  market_regime,",
    "  candidate_id,",
    "  position_id,",
    "  trade_id,",
    "  payload",
    `FROM ${tableName}`,
    `WHERE ${where.join(" AND ")}`,
    `ORDER BY ${parsedTs}, event_id`,
    `LIMIT ${Math.trunc(limit)}`,
    "FORMAT JSONEachRow"
  ].join("\n");
}

export function defaultState() {
  return {
    schema_version: EXPORTER_SCHEMA_VERSION,
    last_watermark_ts: null,
    last_event_id: null,
    last_run_started_at: null,
    last_run_completed_at: null,
    last_success_count: 0,
    last_error: null
  };
}

export function readState(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      schema_version: EXPORTER_SCHEMA_VERSION
    };
  } catch {
    return defaultState();
  }
}

export function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export function appendJsonlLog(logFile, record) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8");
}

function readLock(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

export function acquireLock({ lockFile, staleMs, now = new Date(), pid = process.pid, exportRunId = null }) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const nowMs = now.getTime();
  const current = readLock(lockFile);
  if (current?.created_at) {
    const createdMs = new Date(current.created_at).getTime();
    const ageMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : Number.MAX_SAFE_INTEGER;
    if (ageMs < staleMs) {
      return {
        acquired: false,
        staleRemoved: false,
        record: current
      };
    }
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // Another process may have already cleaned it up.
    }
  }

  const record = {
    schema_version: EXPORTER_SCHEMA_VERSION,
    pid,
    host: os.hostname(),
    export_run_id: exportRunId,
    created_at: nowIso(now)
  };

  try {
    fs.writeFileSync(lockFile, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return {
      acquired: true,
      staleRemoved: Boolean(current),
      record
    };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return {
        acquired: false,
        staleRemoved: false,
        record: readLock(lockFile)
      };
    }
    throw error;
  }
}

export function releaseLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function clickHouseQuery({
  baseUrl,
  database,
  user,
  password,
  query,
  input = "",
  timeoutMs = 30000
}) {
  if (!baseUrl) throw new Error("ClickHouse baseUrl is required");
  if (!query) throw new Error("ClickHouse query is required");

  const url = new URL(baseUrl);
  if (database) url.searchParams.set("database", database);

  const body = `${query}${input ? `\n${input}` : ""}`;

  const args = [
    "-sS",
    "--fail-with-body",
    "--max-time",
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    "-u",
    `${user || "default"}:${password || ""}`,
    url.toString(),
    "--data-binary",
    "@-"
  ];

  try {
    return execFileSync("curl", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      input: body
    });
  } catch (error) {
    const detail = error?.stdout || error?.stderr || "";
    throw new Error(`${error?.message || String(error)}${detail ? `\n${detail.slice(0, 2000)}` : ""}`);
  }
}

export function buildClickHouseClient(config, label) {
  return {
    label,
    config,
    describe() {
      return {
        label,
        baseUrl: sanitizeUrl(config.baseUrl),
        database: config.database,
        user: config.user || "default",
        secure: Boolean(config.secure)
      };
    },
    query({ query, input = "", timeoutMs } = {}) {
      return clickHouseQuery({
        baseUrl: config.baseUrl,
        database: config.database,
        user: config.user,
        password: config.password,
        query,
        input,
        timeoutMs
      });
    },
    ping() {
      return this.query({ query: "SELECT 1" }).trim();
    }
  };
}

export function resolveConfig({ env = process.env, root = ROOT } = {}) {
  return {
    root,
    paths: {
      trainingEventLog: resolvePath(root, env.TRAINING_EVENT_LOG, path.join("logs", "training-events.jsonl")),
      exportLog: resolvePath(root, env.E3D_ACTION_OUTCOME_EXPORT_LOG, path.join("logs", "e3d-action-outcome-export.jsonl")),
      stateFile: resolvePath(root, env.E3D_ACTION_OUTCOME_EXPORT_STATE_FILE, path.join("state", "e3d-action-outcome-export-state.json")),
      lockFile: resolvePath(root, env.E3D_ACTION_OUTCOME_EXPORT_LOCK_FILE, path.join("state", "e3d-action-outcome-export.lock"))
    },
    runtime: {
      overlapMinutes: toInt(env.EXPORT_OVERLAP_MINUTES, DEFAULT_OVERLAP_MINUTES),
      lockStaleMinutes: toInt(env.EXPORT_LOCK_STALE_MINUTES, DEFAULT_LOCK_STALE_MINUTES)
    },
    localClickHouse: buildClickHouseClient({
      baseUrl: env.LOCAL_CLICKHOUSE_HTTP_URL || "http://127.0.0.1:8123",
      database: env.LOCAL_CLICKHOUSE_DATABASE || "e3d",
      user: env.LOCAL_CLICKHOUSE_USER || "default",
      password: env.LOCAL_CLICKHOUSE_PASSWORD || "",
      secure: parseBooleanEnv(env.LOCAL_CLICKHOUSE_SECURE, false),
      table: env.LOCAL_TRAINING_EVENTS_TABLE || "training_events"
    }, "local"),
    awsClickHouse: buildClickHouseClient({
      baseUrl: env.AWS_E3D_CLICKHOUSE_HTTP_URL || "",
      database: env.AWS_E3D_CLICKHOUSE_DATABASE || "e3d",
      user: env.AWS_E3D_CLICKHOUSE_USER || "default",
      password: env.AWS_E3D_CLICKHOUSE_PASSWORD || "",
      secure: parseBooleanEnv(env.AWS_E3D_CLICKHOUSE_SECURE, true)
    }, "aws"),
    e3dCorp: {
      baseUrl: normalizeText(env.E3D_CORP_BASE_URL),
      outcomePath: normalizeText(env.E3D_CORP_OUTCOME_PATH, "/webhooks/e3d-trade-outcomes"),
      apiKey: normalizeText(env.E3D_CORP_API_KEY),
      sessionCookie: normalizeText(env.E3D_CORP_SESSION_COOKIE),
      timeoutMs: toInt(env.E3D_CORP_TIMEOUT_MS, DEFAULT_CORP_TIMEOUT_MS),
      maxAttempts: toInt(env.E3D_CORP_MAX_ATTEMPTS, DEFAULT_CORP_MAX_ATTEMPTS)
    }
  };
}

function mandateTraceForRecord(record) {
  const payload = record?.payload || {};
  const trade = payload.trade || {};
  const positionBefore = payload.position_before || {};
  const trace = payload.mandate_trace
    || payload.capital_mandate
    || trade.mandate_trace
    || positionBefore.mandate_trace
    || null;
  const mandateId = normalizeText(record?.mandate_id || payload?.mandate_id || trade?.mandate_id || trace?.mandate_id);
  const correlationId = normalizeText(record?.correlation_id || payload?.correlation_id || trade?.correlation_id || trace?.correlation_id);
  if (!mandateId || !correlationId) return null;
  return {
    mandate_id: mandateId,
    correlation_id: correlationId,
    proposal_id: normalizeText(trace?.proposal_id || payload?.proposal_id),
    decision_id: normalizeText(trace?.decision_id || payload?.decision_id),
    owner: normalizeText(trace?.owner || payload?.owner)
  };
}

function buildCorpPortfolioSnapshot(record) {
  const snapshot = record?.payload?.portfolio_snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return {
    cash_usd: toNum(snapshot.cash_usd, 0),
    equity_usd: toNum(snapshot.equity_usd, 0),
    open_positions: Math.max(0, Math.trunc(toNum(snapshot.open_positions, 0))),
    market_regime: normalizeText(snapshot.market_regime || record?.market_regime) || null
  };
}

export function mapCorpTradeOutcome(record) {
  const trace = mandateTraceForRecord(record);
  if (!trace || record?.event_type !== "trade") return null;
  const payload = record?.payload || {};
  const trade = payload?.trade || {};
  const tokenInfo = getTokenInfo(null, payload, record);
  const measuredAt = normalizeText(trade?.ts || record?.ts);
  const entryPrice = toNum(trade?.avg_entry_price, toNum(payload?.quoted_price, 0));
  const currentPrice = toNum(payload?.fill_price, 0);
  const exitPrice = normalizeText(trade?.side).toLowerCase() === "sell" ? currentPrice : null;
  const pnlUsd = toNum(trade?.pnl_usd, 0);
  return {
    outcome_id: buildOutcomeId({ actionId: "", record, outcomeWindow: "trade", measuredAt }),
    mandate_id: trace.mandate_id,
    correlation_id: trace.correlation_id,
    type: "trade.executed",
    occurred_at: measuredAt,
    source_event_id: normalizeText(record?.event_id),
    pipeline_run_id: normalizeText(record?.pipeline_run_id),
    cycle_id: normalizeText(record?.cycle_id),
    cycle_index: Math.trunc(toNum(record?.cycle_index, 0)),
    market_regime: normalizeText(record?.market_regime),
    symbol: tokenInfo.symbol,
    token_address: tokenInfo.tokenAddress,
    chain: tokenInfo.chain,
    trade_id: normalizeText(record?.trade_id || payload?.trade_id),
    position_id: normalizeText(record?.position_id || payload?.position_id),
    candidate_id: normalizeText(record?.candidate_id || payload?.candidate_id),
    side: normalizeText(trade?.side).toLowerCase() || null,
    trade_lifecycle: normalizeText(trade?.trade_lifecycle || payload?.trade_lifecycle),
    trade_status: normalizeText(payload?.trade_status),
    entry_price: entryPrice,
    current_price: currentPrice,
    exit_price: exitPrice,
    pnl_usd: pnlUsd,
    pnl_pct: exitPrice && entryPrice > 0 ? ratioPct(exitPrice - entryPrice, entryPrice) : 0,
    price_delta_pct: ratioPct(currentPrice - entryPrice, entryPrice),
    portfolio_snapshot: buildCorpPortfolioSnapshot(record)
  };
}

export function mapCorpRealizedOutcome(record) {
  const trace = mandateTraceForRecord(record);
  if (!trace || record?.event_type !== "outcome") return null;
  const payload = record?.payload || {};
  const positionBefore = payload?.position_before || {};
  const tokenInfo = getTokenInfo(null, payload, record);
  const entryPrice = toNum(payload?.entry_price, toNum(positionBefore?.avg_entry_price, 0));
  const exitPrice = toNum(payload?.exit_price, 0);
  const pnlUsd = toNum(payload?.pnl_usd, 0);
  const occurredAt = normalizeText(record?.ts);
  return {
    outcome_id: buildOutcomeId({ actionId: "", record, outcomeWindow: "realized", measuredAt: occurredAt }),
    mandate_id: trace.mandate_id,
    correlation_id: trace.correlation_id,
    type: "trade.realized",
    occurred_at: occurredAt,
    source_event_id: normalizeText(record?.event_id),
    pipeline_run_id: normalizeText(record?.pipeline_run_id),
    cycle_id: normalizeText(record?.cycle_id),
    cycle_index: Math.trunc(toNum(record?.cycle_index, 0)),
    market_regime: normalizeText(record?.market_regime),
    symbol: tokenInfo.symbol,
    token_address: tokenInfo.tokenAddress,
    chain: tokenInfo.chain,
    trade_id: normalizeText(record?.trade_id || payload?.trade_id),
    position_id: normalizeText(record?.position_id || payload?.position_id),
    candidate_id: normalizeText(record?.candidate_id || payload?.candidate_id),
    outcome_label: normalizeText(payload?.outcome_label || (pnlUsd >= 0 ? "profit" : "loss")).toLowerCase(),
    verdict: pnlUsd >= 0 ? "validated" : "invalidated",
    entry_price: entryPrice,
    exit_price: exitPrice,
    pnl_usd: pnlUsd,
    pnl_pct: entryPrice > 0 && exitPrice > 0 ? ratioPct(exitPrice - entryPrice, entryPrice) : 0,
    max_gain_pct: toNum(payload?.max_gain_pct, 0),
    max_drawdown_pct: toNum(payload?.max_drawdown_pct, 0),
    holding_days: toNum(payload?.holding_days, 0),
    portfolio_snapshot: buildCorpPortfolioSnapshot(record)
  };
}

export function mapCorpOutcomeCallbacks(events = []) {
  const callbacks = [];
  for (const event of events) {
    const mapped = event?.event_type === "trade"
      ? mapCorpTradeOutcome(event)
      : event?.event_type === "outcome"
        ? mapCorpRealizedOutcome(event)
        : null;
    if (mapped) callbacks.push(mapped);
  }
  return callbacks;
}

function isConfiguredCorpCallback(config) {
  return Boolean(config?.baseUrl && (config.apiKey || config.sessionCookie));
}

function buildCorpOutcomeUrl(config) {
  const path = config.outcomePath || "/webhooks/e3d-trade-outcomes";
  return new URL(path, `${config.baseUrl.replace(/\/+$/, "")}/`).toString();
}

function isRetryableStatus(status) {
  return status >= 500 && status < 600;
}

export async function deliverCorpOutcomeCallbacks({ callbacks = [], corpConfig, fetchImpl = fetch, logger = null } = {}) {
  if (!isConfiguredCorpCallback(corpConfig) || callbacks.length === 0) {
    return {
      enabled: false,
      delivered: 0,
      callbacks: callbacks.length
    };
  }

  const url = buildCorpOutcomeUrl(corpConfig);
  let delivered = 0;

  for (const callback of callbacks) {
    const body = JSON.stringify(callback);
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, corpConfig.maxAttempts || DEFAULT_CORP_MAX_ATTEMPTS); attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: corpConfig.apiKey ? `Bearer ${corpConfig.apiKey}` : undefined,
            Cookie: corpConfig.sessionCookie || undefined,
            "Idempotency-Key": callback.outcome_id
          },
          body,
          signal: AbortSignal.timeout(Math.max(1, corpConfig.timeoutMs || DEFAULT_CORP_TIMEOUT_MS))
        });
        if (!response.ok) {
          const message = await response.text().catch(() => "");
          if (isRetryableStatus(response.status)) {
            throw new Error(`e3d-corp outcome webhook ${response.status}: ${message || "temporary error"}`);
          }
          throw new Error(`e3d-corp outcome webhook rejected ${callback.outcome_id}: ${response.status} ${message}`.trim());
        }
        delivered += 1;
        logger?.({
          stage: "corp_outcome_delivered",
          outcome_id: callback.outcome_id,
          mandate_id: callback.mandate_id,
          correlation_id: callback.correlation_id
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const retryable = error?.name === "TimeoutError" || error?.name === "AbortError" || /temporary error|5\d\d/.test(String(error?.message || error));
        if (!retryable || attempt >= Math.max(1, corpConfig.maxAttempts || DEFAULT_CORP_MAX_ATTEMPTS)) {
          throw lastError;
        }
        await sleep(Math.min(250 * attempt, 1000));
      }
    }
  }

  return {
    enabled: true,
    delivered,
    callbacks: callbacks.length
  };
}

export function createDestinationTables({
  client,
  dryRun = false,
  logger = null
} = {}) {
  requireConfiguredClickHouse(client, "destination table creation");

  const database = client.config.database || "e3d";
  const operations = DESTINATION_TABLE_NAMES.map((tableName) => ({
    tableName,
    query: DESTINATION_TABLE_DDLS[tableName].replaceAll("{database}", database)
  }));

  if (dryRun) {
    logger?.({
      stage: "destination_tables_planned",
      database,
      table_count: operations.length,
      tables: operations.map((operation) => operation.tableName)
    });
    return {
      ok: true,
      dryRun: true,
      database,
      tableCount: operations.length,
      tables: operations.map((operation) => operation.tableName)
    };
  }

  for (const operation of operations) {
    client.query({ query: operation.query });
    logger?.({
      stage: "destination_table_created",
      database,
      table_name: operation.tableName
    });
  }

  // Apply in-place column additions for pre-existing tables.
  // ALTER ... ADD COLUMN IF NOT EXISTS is idempotent: no-op if already present.
  let migrationsApplied = 0;
  for (const [tableName, statements] of Object.entries(DESTINATION_TABLE_MIGRATIONS)) {
    for (const stmt of statements) {
      const query = stmt.replaceAll("{database}", database);
      try {
        client.query({ query });
        migrationsApplied += 1;
      } catch (err) {
        logger?.({
          stage: "destination_migration_error",
          database,
          table_name: tableName,
          query,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    }
    logger?.({
      stage: "destination_migrations_applied",
      database,
      table_name: tableName,
      statement_count: statements.length
    });
  }

  return {
    ok: true,
    dryRun: false,
    database,
    tableCount: operations.length,
    tables: operations.map((operation) => operation.tableName),
    migrationsApplied
  };
}

function chunkRows(rows, batchSize) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    chunks.push(rows.slice(index, index + batchSize));
  }
  return chunks;
}

export function insertJsonEachRow({
  client,
  tableName,
  rows,
  dryRun = false,
  batchSize = DEFAULT_INSERT_BATCH_SIZE,
  logger = null
} = {}) {
  requireConfiguredClickHouse(client, `insert into ${tableName}`);

  const safeBatchSize = Math.max(1, Math.trunc(toNum(batchSize, DEFAULT_INSERT_BATCH_SIZE)));
  const database = client.config.database || "e3d";
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const batches = chunkRows(normalizedRows, safeBatchSize);
  // input_format_skip_unknown_fields: lets us roll out mapper additions without
  // a hard outage when the destination schema hasn't been migrated yet. Once the
  // operator runs --create-tables-only, the new columns get captured.
  const query = `INSERT INTO ${database}.${tableName} SETTINGS input_format_skip_unknown_fields = 1 FORMAT JSONEachRow`;

  if (dryRun) {
    logger?.({
      stage: "insert_planned",
      table_name: tableName,
      database,
      row_count: normalizedRows.length,
      batch_count: batches.length,
      batch_size: safeBatchSize
    });
    return {
      ok: true,
      dryRun: true,
      database,
      tableName,
      rowCount: normalizedRows.length,
      batchCount: batches.length,
      batchSize: safeBatchSize
    };
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const input = batch.map((row) => JSON.stringify(row)).join("\n");
    try {
      client.query({ query, input });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to insert ${tableName} batch ${batchIndex + 1}/${batches.length}: ${message}`);
    }
    logger?.({
      stage: "insert_completed",
      table_name: tableName,
      database,
      batch_index: batchIndex + 1,
      batch_count: batches.length,
      row_count: batch.length
    });
  }

  return {
    ok: true,
    dryRun: false,
    database,
    tableName,
    rowCount: normalizedRows.length,
    batchCount: batches.length,
    batchSize: safeBatchSize
  };
}

export function insertMappedRecords({
  client,
  mapped,
  dryRun = false,
  batchSize = DEFAULT_INSERT_BATCH_SIZE,
  logger = null
} = {}) {
  const actions = Array.isArray(mapped?.actions) ? mapped.actions : [];
  const outcomes = Array.isArray(mapped?.outcomes) ? mapped.outcomes : [];
  const scorecards = Array.isArray(mapped?.scorecards) ? mapped.scorecards : [];

  const actionResult = insertJsonEachRow({
    client,
    tableName: "E3DAgentActions",
    rows: actions,
    dryRun,
    batchSize,
    logger
  });
  const outcomeResult = insertJsonEachRow({
    client,
    tableName: "E3DAgentOutcomes",
    rows: outcomes,
    dryRun,
    batchSize,
    logger
  });

  return {
    ok: true,
    dryRun,
    actionResult,
    outcomeResult,
    scorecardResult: {
      ok: true,
      dryRun,
      database: client.config.database || "e3d",
      tableName: "E3DAgentCycleScorecards",
      rowCount: scorecards.length,
      batchCount: 0,
      batchSize
    },
    insertedRows: actionResult.rowCount + outcomeResult.rowCount,
    actionsInserted: actionResult.rowCount,
    outcomesInserted: outcomeResult.rowCount,
    scorecardsInserted: scorecards.length
  };
}

export function readJsonlTrainingEvents({ logPath, filters, limit }) {
  if (!fs.existsSync(logPath)) {
    throw new Error(`Training event log not found: ${logPath}`);
  }

  const events = [];
  let linesRead = 0;

  readLinesSync(logPath, (rawLine) => {
    const line = rawLine.trim();
    if (!line || events.length >= limit) return;
    linesRead += 1;
    const parsed = JSON.parse(line);
    const event = normalizeTrainingEvent(parsed, `JSONL line ${linesRead}`);
    if (!shouldIncludeEvent(event, filters)) return;
    events.push(event);
  });

  return {
    source: "jsonl",
    events,
    sourceEventsRead: linesRead
  };
}

export function readClickHouseTrainingEvents({ client, filters, limit }) {
  try {
    const tableName = `${client.config.database || "e3d"}.${client.config.table || "training_events"}`;
    const query = buildClickHouseSourceQuery({
      tableName,
      filters,
      limit
    });
    const response = client.query({ query });
    const lines = String(response || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const events = lines.map((line, index) => normalizeTrainingEvent(JSON.parse(line), `ClickHouse row ${index + 1}`));
    return {
      source: "clickhouse",
      events,
      sourceEventsRead: events.length
    };
  } catch (error) {
    if (isClickHouseUnavailableError(error)) {
      throw buildClickHouseUnavailableError();
    }
    throw error;
  }
}

export function readSourceEvents({ options, config, now = new Date() }) {
  const filters = buildTimeWindow(options, now);
  const result = options.sourceClickHouse
    ? readClickHouseTrainingEvents({
        client: config.localClickHouse,
        filters,
        limit: options.limit
      })
    : readJsonlTrainingEvents({
        logPath: config.paths.trainingEventLog,
        filters,
        limit: options.limit
      });

  const eventTypeCounts = Object.fromEntries(PHASE_1_EVENT_TYPES.map((type) => [type, 0]));
  let minTs = null;
  let maxTs = null;
  for (const event of result.events) {
    eventTypeCounts[event.event_type] = (eventTypeCounts[event.event_type] || 0) + 1;
    if (!minTs || event.ts < minTs) minTs = event.ts;
    if (!maxTs || event.ts > maxTs) maxTs = event.ts;
  }

  return {
    ...result,
    filters,
    eventTypeCounts,
    sourceMinTs: minTs,
    sourceMaxTs: maxTs
  };
}

function getExecutorCandidate(payload) {
  const tradeKind = normalizeText(payload?.trade_kind).toLowerCase();
  if (tradeKind === "buy") return payload?.action?.candidate || null;
  if (tradeKind === "exit") return payload?.action || null;
  if (tradeKind === "rotation") return payload?.proposal?.action?.to_candidate || null;
  return null;
}

// ALTER TABLE migrations for in-place upgrades when CREATE TABLE IF NOT EXISTS
// can't add columns to a pre-existing table. Run via --create-tables-only.
// All columns are nullable-tolerant (default 0 / "") so existing rows backfill cleanly.
export const DESTINATION_TABLE_MIGRATIONS = Object.freeze({
  E3DAgentActions: [
    "ALTER TABLE {database}.E3DAgentActions ADD COLUMN IF NOT EXISTS expires_at DateTime64(3) DEFAULT toDateTime64(0, 3)",
    "ALTER TABLE {database}.E3DAgentActions ADD COLUMN IF NOT EXISTS thesis_state LowCardinality(String) DEFAULT ''",
    "ALTER TABLE {database}.E3DAgentActions ADD COLUMN IF NOT EXISTS thesis_freshness Float64 DEFAULT 0",
    "ALTER TABLE {database}.E3DAgentActions ADD COLUMN IF NOT EXISTS narrative_decay Float64 DEFAULT 0",
    "ALTER TABLE {database}.E3DAgentActions ADD COLUMN IF NOT EXISTS story_strength Float64 DEFAULT 0",
    "ALTER TABLE {database}.E3DAgentActions ADD COLUMN IF NOT EXISTS flow_direction LowCardinality(String) DEFAULT ''",
    "ALTER TABLE {database}.E3DAgentActions ADD COLUMN IF NOT EXISTS action_tilt LowCardinality(String) DEFAULT ''",
    "ALTER TABLE {database}.E3DAgentActions ADD COLUMN IF NOT EXISTS price_freshness LowCardinality(String) DEFAULT ''",
    "ALTER TABLE {database}.E3DAgentActions ADD COLUMN IF NOT EXISTS liquidity_freshness LowCardinality(String) DEFAULT ''"
  ]
});

export const STORY_TYPE_VOCAB = Object.freeze([
  // exit-risk / disqualifiers
  "WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN", "RUG_LIQUIDITY_PULL", "SPREAD_WIDENING",
  "MOMENTUM_DIVERGENCE", "EXCHANGE_FLOW", "TREASURY_DISTRIBUTION", "SECURITY_RISK",
  // buy / momentum signals
  "ACCUMULATION", "STEALTH_ACCUMULATION", "SMART_MONEY", "SMART_MONEY_LEADER",
  "BREAKOUT_CONFIRMED", "MOVER", "SURGE", "STAGING", "CLUSTER", "THESIS", "FLOW",
  "HOTLINKS", "FUNNEL", "WHALE", "DELEGATE_SURGE", "NEW_WALLETS", "MIRROR",
  "VOLUME_PROFILE_ANOMALY", "ECOSYSTEM_SHIFT", "DEEP_DIVE", "E3D_CANDIDATE",
  // structural
  "CONCENTRATION_SHIFT", "INSIDER_TIMING", "TOKEN_QUALITY_SCORE", "SANDWICH"
]);

export function extractSignalTypes(candidate) {
  if (!candidate || typeof candidate !== "object") return [];
  const found = new Set();
  const setup = String(candidate.setup_type || "").toUpperCase();
  if (STORY_TYPE_VOCAB.includes(setup)) found.add(setup);
  const texts = [];
  if (typeof candidate.why_now === "string") texts.push(candidate.why_now);
  for (const e of asArray(candidate.evidence)) {
    if (typeof e === "string") texts.push(e);
    else if (e && typeof e === "object") {
      // Scout's structured evidence uses {signal: "..."}; v1 used {type: ...} / {story_type: ...}.
      const t = String(e.signal || e.type || e.story_type || "").toUpperCase();
      if (STORY_TYPE_VOCAB.includes(t)) found.add(t);
    }
  }
  for (const r of asArray(candidate.risks)) {
    if (typeof r === "string") texts.push(r);
    else if (r && typeof r === "object") {
      const t = String(r.signal || r.type || r.story_type || "").toUpperCase();
      if (STORY_TYPE_VOCAB.includes(t)) found.add(t);
    }
  }
  for (const text of texts) {
    for (const t of STORY_TYPE_VOCAB) {
      // Case-sensitive: scout writes canonical signal tags in ALL-CAPS
      // ("STAGING + ACCUMULATION") but uses lowercase in prose
      // ("accumulation flow detected"). Matching only the ALL-CAPS form keeps
      // attribution labels clean — avoids false-positive hits on common English
      // words like flow / mover / surge / whale. \b treats _ as a word char.
      if (new RegExp(`\\b${t}\\b`).test(text)) found.add(t);
    }
  }
  return [...found].sort();
}

export function extractStoryIds(candidate) {
  if (!candidate || typeof candidate !== "object") return [];
  const ids = new Set();
  for (const id of asArray(candidate.story_ids)) {
    const v = normalizeText(id);
    if (v) ids.add(v);
  }
  for (const e of asArray(candidate.evidence)) {
    if (typeof e === "string" && e.startsWith("evi_")) {
      ids.add(e);
    } else if (e && typeof e === "object") {
      const v = normalizeText(e.evidence_id || e.story_id || "");
      if (v) ids.add(v);
    }
  }
  return [...ids].sort();
}

function getTokenInfo(candidate, payload = {}, fallback = {}) {
  const token = candidate?.token || payload?.trade?.token || payload?.position_before?.token || {};
  const contractAddress = token?.contract_address
    || payload?.trade?.contract_address
    || payload?.position_before?.contract_address
    || fallback.contract_address
    || fallback.token_address
    || fallback.candidate_id
    || "";
  const symbol = token?.symbol
    || payload?.trade?.symbol
    || payload?.position_before?.symbol
    || fallback.symbol
    || "";
  const chain = token?.chain
    || payload?.trade?.chain
    || payload?.position_before?.chain
    || fallback.chain
    || "";

  return {
    tokenAddress: cleanAddress(contractAddress),
    symbol: normalizeText(symbol),
    chain: normalizeText(chain)
  };
}

export function inferActionType(agentDecision, tradeKind) {
  const decision = normalizeText(agentDecision).toLowerCase();
  const normalizedTradeKind = normalizeText(tradeKind).toLowerCase();

  if (decision === "reject") return "REJECT";
  if (decision === "wait" || decision === "wait_for_entry") return "WAIT";
  if (decision === "monitor_only") return "WATCH";
  if (decision === "hold") return "PAPER_HOLD";

  if (decision === "paper_trade" || decision === "approve_live" || decision === "reduce_size") {
    if (normalizedTradeKind === "exit") return "PAPER_SELL";
    if (normalizedTradeKind === "rotation" || normalizedTradeKind === "buy") return "PAPER_BUY";
  }

  return "WATCH";
}

export function inferSimulatedSide(tradeKind, agentDecision) {
  const decision = normalizeText(agentDecision).toLowerCase();
  if (["reject", "wait", "wait_for_entry", "monitor_only"].includes(decision)) return "none";

  const normalizedTradeKind = normalizeText(tradeKind).toLowerCase();
  if (normalizedTradeKind === "exit") return "sell";
  if (normalizedTradeKind === "buy" || normalizedTradeKind === "rotation") return "buy";
  if (decision === "hold") return "hold";
  return "none";
}

export function mapExecutorDecisionEvent(record) {
  const payload = record?.payload || {};
  const candidate = getExecutorCandidate(payload);
  const tokenInfo = getTokenInfo(candidate, payload, record);
  const tradeKind = normalizeText(payload?.trade_kind).toLowerCase();
  const agentDecision = normalizeText(payload?.review?.executor_decision || payload?.decision || "unknown").toLowerCase();
  const approvedSizePct = toNum(payload?.review?.approved_size_pct, 0);
  const cashUsd = toNum(payload?.portfolio_snapshot?.cash_usd, 0);
  const blockerList = asArray(payload?.review?.blocker_list).map((item) => normalizeText(item)).filter(Boolean);
  const actionId = buildActionId(record, agentDecision, tokenInfo.tokenAddress);

  return {
    action_id: actionId,
    updated_at: toDateTime64Ms(record?.ts),
    created_at: toDateTime64Ms(record?.ts),

    source_app: SOURCE_APP,
    source_schema_version: normalizeText(record?.schema_version),
    source_event_id: normalizeText(record?.event_id),
    pipeline_run_id: normalizeText(record?.pipeline_run_id),
    cycle_id: normalizeText(record?.cycle_id),
    cycle_index: Math.trunc(toNum(record?.cycle_index, 0)),
    market_regime: normalizeText(record?.market_regime),

    token_address: tokenInfo.tokenAddress,
    symbol: tokenInfo.symbol,
    chain: tokenInfo.chain,

    agent_stage: "executor",
    actor: normalizeText(record?.actor),
    event_type: normalizeText(record?.event_type),
    trade_kind: tradeKind,

    agent_decision: agentDecision || "unknown",
    action_type: inferActionType(agentDecision, tradeKind),
    simulated_side: inferSimulatedSide(tradeKind, agentDecision),

    candidate_id: normalizeText(record?.candidate_id || payload?.candidate_id),
    position_id: normalizeText(record?.position_id),
    trade_id: normalizeText(record?.trade_id),

    entry_price: toNum(candidate?.market_data?.current_price, 0),
    allocation_usd: (approvedSizePct / 100) * cashUsd,
    confidence_score: toNum(candidate?.conviction_score, toNum(candidate?.confidence, 0)),
    risk_score: 0,
    liquidity_usd: toNum(candidate?.liquidity_data?.liquidity_usd, 0),
    slippage_bps: toNum(candidate?.execution_data?.estimated_slippage_bps, toNum(payload?.review?.max_slippage_bps, 0)),
    fee_bps: 0,

    thesis_summary: normalizeText(candidate?.thesis_summary || candidate?.why_now),
    reason_summary: normalizeText(payload?.review?.reason_summary),
    reject_reason: blockerList.join("; "),

    source_story_ids: extractStoryIds(candidate),
    source_signal_types: extractSignalTypes(candidate),
    evidence_packet_id: normalizeText(candidate?.evidence_packet_id),
    risk_decision_id: "",

    expires_at: toDateTime64Ms(candidate?.expires_at || record?.ts),
    thesis_state: normalizeText(candidate?.thesis_state),
    thesis_freshness: toNum(candidate?.narrative_data?.thesis_health, 0),
    narrative_decay: toNum(candidate?.narrative_data?.narrative_decay, 0),
    story_strength: toNum(candidate?.narrative_data?.story_strength, 0),
    flow_direction: normalizeText(candidate?.narrative_data?.flow_direction),
    // scout candidates carry `action: "buy"`; harvest reviews carry hold|monitor|trim|exit.
    // Either one is the agent's current verdict given decay — the "action tilt" of the cycle.
    action_tilt: normalizeText(candidate?.action),
    price_freshness: normalizeText(candidate?.market_data_quality?.normalized?.price_freshness),
    liquidity_freshness: normalizeText(candidate?.market_data_quality?.normalized?.liquidity_freshness),

    payload_json: jsonString(payload)
  };
}

export function mapTradeOutcomeEvent(record) {
  const payload = record?.payload || {};
  const trade = payload?.trade || {};
  const tokenInfo = getTokenInfo(null, payload, record);
  const measuredAt = normalizeText(trade?.ts || record?.ts);
  const entryPrice = toNum(trade?.avg_entry_price, toNum(payload?.quoted_price, 0));
  const currentPrice = toNum(payload?.fill_price, 0);
  const exitPrice = normalizeText(trade?.side).toLowerCase() === "sell" ? currentPrice : 0;
  const pnlUsd = toNum(trade?.pnl_usd, 0);

  return {
    outcome_id: buildOutcomeId({
      actionId: "",
      record,
      outcomeWindow: "trade",
      measuredAt
    }),
    action_id: "",
    updated_at: toDateTime64Ms(record?.ts),
    measured_at: toDateTime64Ms(measuredAt),

    source_app: SOURCE_APP,
    source_schema_version: normalizeText(record?.schema_version),
    source_event_id: normalizeText(record?.event_id),
    pipeline_run_id: normalizeText(record?.pipeline_run_id),
    cycle_id: normalizeText(record?.cycle_id),
    cycle_index: Math.trunc(toNum(record?.cycle_index, 0)),
    market_regime: normalizeText(record?.market_regime),

    token_address: tokenInfo.tokenAddress,
    symbol: tokenInfo.symbol,
    chain: tokenInfo.chain,

    candidate_id: normalizeText(record?.candidate_id || payload?.candidate_id),
    position_id: normalizeText(record?.position_id || payload?.position_id),
    trade_id: normalizeText(record?.trade_id || payload?.trade_id),

    outcome_type: "paper_trade",
    outcome_window: "trade",
    outcome_label: normalizeText(trade?.side || "trade").toLowerCase(),
    verdict: "recorded",

    entry_price: entryPrice,
    exit_price: exitPrice,
    current_price: currentPrice,
    price_delta_pct: ratioPct(currentPrice - entryPrice, entryPrice),
    pnl_usd: pnlUsd,
    pnl_pct: (entryPrice > 0 && exitPrice > 0) ? ratioPct(exitPrice - entryPrice, entryPrice) : 0,
    max_gain_pct: 0,
    max_drawdown_pct: 0,
    holding_days: 0,

    liquidity_delta_pct: 0,
    volume_delta_pct: 0,
    holder_delta_pct: 0,

    payload_json: jsonString(payload)
  };
}

export function mapOutcomeObservationEvent(record) {
  const payload = record?.payload || {};
  const positionBefore = payload?.position_before || {};
  const tokenInfo = getTokenInfo(null, payload, record);
  const entryPrice = toNum(payload?.entry_price, toNum(positionBefore?.avg_entry_price, 0));
  const exitPrice = toNum(payload?.exit_price, 0);
  const pnlUsd = toNum(payload?.pnl_usd, 0);
  const outcomeLabel = normalizeText(payload?.outcome_label || (pnlUsd >= 0 ? "profit" : "loss")).toLowerCase();

  return {
    outcome_id: buildOutcomeId({
      actionId: "",
      record,
      outcomeWindow: "realized",
      measuredAt: normalizeText(record?.ts)
    }),
    action_id: "",
    updated_at: toDateTime64Ms(record?.ts),
    measured_at: toDateTime64Ms(record?.ts),

    source_app: SOURCE_APP,
    source_schema_version: normalizeText(record?.schema_version),
    source_event_id: normalizeText(record?.event_id),
    pipeline_run_id: normalizeText(record?.pipeline_run_id),
    cycle_id: normalizeText(record?.cycle_id),
    cycle_index: Math.trunc(toNum(record?.cycle_index, 0)),
    market_regime: normalizeText(record?.market_regime),

    token_address: tokenInfo.tokenAddress,
    symbol: tokenInfo.symbol,
    chain: tokenInfo.chain,

    candidate_id: normalizeText(record?.candidate_id || payload?.candidate_id),
    position_id: normalizeText(record?.position_id || payload?.position_id),
    trade_id: normalizeText(record?.trade_id || payload?.trade_id),

    outcome_type: "realized_outcome",
    outcome_window: "realized",
    outcome_label: outcomeLabel,
    verdict: pnlUsd >= 0 ? "validated" : "invalidated",

    entry_price: entryPrice,
    exit_price: exitPrice,
    current_price: exitPrice,
    price_delta_pct: (entryPrice > 0 && exitPrice > 0) ? ratioPct(exitPrice - entryPrice, entryPrice) : 0,
    pnl_usd: pnlUsd,
    pnl_pct: (entryPrice > 0 && exitPrice > 0) ? ratioPct(exitPrice - entryPrice, entryPrice) : 0,
    max_gain_pct: 0,
    max_drawdown_pct: 0,
    holding_days: toNum(payload?.holding_days, 0),

    liquidity_delta_pct: 0,
    volume_delta_pct: 0,
    holder_delta_pct: 0,

    payload_json: jsonString(payload)
  };
}

export function mapSourceEvents(events = []) {
  const actions = [];
  const outcomes = [];

  for (const event of events) {
    if (event?.event_type === "executor_decision") {
      actions.push(mapExecutorDecisionEvent(event));
      continue;
    }
    if (event?.event_type === "trade") {
      outcomes.push(mapTradeOutcomeEvent(event));
      continue;
    }
    if (event?.event_type === "outcome") {
      outcomes.push(mapOutcomeObservationEvent(event));
    }
  }

  return {
    actions,
    outcomes
  };
}

function buildRunId(now, options) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      ts: nowIso(now),
      pid: process.pid,
      dryRun: options.dryRun,
      sourceClickHouse: options.sourceClickHouse
    }))
    .digest("hex")
    .slice(0, 16);
}

function updateStateForCompletion(state, { startedAt, completedAt, successCount, errorMessage, watermarkTs }) {
  return {
    ...state,
    schema_version: EXPORTER_SCHEMA_VERSION,
    last_watermark_ts: watermarkTs !== undefined ? (watermarkTs || state.last_watermark_ts) : state.last_watermark_ts,
    last_run_started_at: startedAt,
    last_run_completed_at: completedAt,
    last_success_count: successCount,
    last_error: errorMessage || null
  };
}

function buildSummaryRecord({ exportRunId, startedAt, completedAt, options, config, lockStatus, stateEnabled, status, issues = [], sourceSummary = null }) {
  return {
    ts: completedAt,
    stage: "export_summary",
    export_run_id: exportRunId,
    phase: EXPORTER_PHASE,
    status,
    dry_run: options.dryRun,
    source: options.sourceClickHouse ? "clickhouse" : "jsonl",
    create_tables_only: options.createTablesOnly,
    no_state: options.noState,
    state_enabled: stateEnabled,
    limit: options.limit,
    since_hours: options.sinceHours,
    from_ts: options.fromTs,
    to_ts: options.toTs,
    overlap_minutes: config.runtime.overlapMinutes,
    lock_stale_minutes: config.runtime.lockStaleMinutes,
    started_at: startedAt,
    completed_at: completedAt,
    counts: {
      events_scanned: sourceSummary?.sourceEventsRead || 0,
      events_selected: sourceSummary?.events?.length || 0,
      actions_mapped: 0,
      outcomes_mapped: 0,
      corp_outcomes_mapped: 0,
      scorecards_mapped: 0,
      actions_inserted: 0,
      outcomes_inserted: 0,
      corp_outcomes_delivered: 0,
      scorecards_inserted: 0,
      inserted_rows: 0
    },
    source_min_ts: sourceSummary?.sourceMinTs || null,
    source_max_ts: sourceSummary?.sourceMaxTs || null,
    event_type_counts: sourceSummary?.eventTypeCounts || Object.fromEntries(PHASE_1_EVENT_TYPES.map((type) => [type, 0])),
    destination_tables: [],
    lock: {
      acquired: Boolean(lockStatus?.acquired),
      stale_removed: Boolean(lockStatus?.staleRemoved)
    },
    issues
  };
}

export async function runExporter({ argv = process.argv.slice(2), env = process.env, root = ROOT, now = new Date(), config: explicitConfig = null, fetchImpl = fetch } = {}) {
  const options = parseArgs(argv);
  const config = explicitConfig || resolveConfig({ env, root });
  const exportRunId = buildRunId(now, options);
  const startedAt = nowIso(now);
  const stateEnabled = !options.noState;
  const lockStatus = acquireLock({
    lockFile: config.paths.lockFile,
    staleMs: config.runtime.lockStaleMinutes * 60 * 1000,
    now,
    exportRunId
  });

  if (!lockStatus.acquired) {
    const message = "Another export process is already running. Remove the lock only if it is stale.";
    appendJsonlLog(config.paths.exportLog, {
      ts: startedAt,
      stage: "export_error",
      export_run_id: exportRunId,
      phase: EXPORTER_PHASE,
      message
    });
    return {
      ok: false,
      code: 1,
      message,
      exportRunId
    };
  }

  const priorState = stateEnabled ? readState(config.paths.stateFile) : defaultState();

  // Apply watermark: when a previous successful run recorded sourceMaxTs, start from
  // (watermark - overlap) instead of re-scanning the full since_hours window.
  // Skipped if --from-ts was explicitly passed or --no-state is set.
  const effectiveOptions = { ...options };
  if (stateEnabled && priorState.last_watermark_ts && !options.fromTs) {
    const watermarkMs = new Date(priorState.last_watermark_ts).getTime()
      - config.runtime.overlapMinutes * 60 * 1000;
    effectiveOptions.fromTs = new Date(watermarkMs).toISOString();
    effectiveOptions.sinceHours = null;
  }

  if (stateEnabled) {
    writeState(config.paths.stateFile, updateStateForCompletion(priorState, {
      startedAt,
      completedAt: priorState.last_run_completed_at,
      successCount: priorState.last_success_count,
      errorMessage: priorState.last_error
    }));
  }

  try {
    const completedAt = nowIso(new Date(now.getTime() + 1));
    let tableSetup = null;
    let sourceSummary = null;
    let status = "source_events_ready";
    let insertResult = null;
    let corpDeliveryResult = null;

    if (options.createTablesOnly) {
      tableSetup = createDestinationTables({
        client: config.awsClickHouse,
        dryRun: options.dryRun
      });
      status = options.dryRun ? "destination_tables_planned" : "destination_tables_ready";
    } else {
      sourceSummary = readSourceEvents({ options: effectiveOptions, config, now });
      const mapped = mapSourceEvents(sourceSummary.events);
      const corpCallbacks = mapCorpOutcomeCallbacks(sourceSummary.events);
      sourceSummary.mapped = mapped;
      sourceSummary.corpCallbacks = corpCallbacks;
      if (options.dryRun) {
        status = "mapped_records_ready";
      } else {
        insertResult = insertMappedRecords({
          client: config.awsClickHouse,
          mapped
        });
        corpDeliveryResult = await deliverCorpOutcomeCallbacks({
          callbacks: corpCallbacks,
          corpConfig: config.e3dCorp,
          fetchImpl
        });
        status = "records_inserted";
      }
    }

    const summary = {
      ...buildSummaryRecord({
        exportRunId,
        startedAt,
        completedAt,
        options: effectiveOptions,
        config,
        lockStatus,
        stateEnabled,
        status,
        sourceSummary
      }),
      destination_tables: tableSetup?.tables || []
    };
    if (sourceSummary?.mapped) {
      summary.counts.actions_mapped = sourceSummary.mapped.actions.length;
      summary.counts.outcomes_mapped = sourceSummary.mapped.outcomes.length;
      summary.counts.corp_outcomes_mapped = sourceSummary.corpCallbacks?.length || 0;
    }
    if (insertResult) {
      summary.counts.actions_inserted = insertResult.actionsInserted;
      summary.counts.outcomes_inserted = insertResult.outcomesInserted;
      summary.counts.scorecards_inserted = insertResult.scorecardsInserted;
      summary.counts.inserted_rows = insertResult.insertedRows;
      summary.counts.corp_outcomes_delivered = corpDeliveryResult?.delivered || 0;
      summary.destination_tables = [
        insertResult.actionResult.tableName,
        insertResult.outcomeResult.tableName
      ];
    }

    appendJsonlLog(config.paths.exportLog, summary);
    if (stateEnabled) {
      const newWatermark = !options.dryRun && !options.createTablesOnly
        ? (sourceSummary?.sourceMaxTs || null)
        : undefined;
      const successCount = insertResult?.insertedRows ?? 0;
      writeState(config.paths.stateFile, updateStateForCompletion(priorState, {
        startedAt,
        completedAt,
        successCount,
        errorMessage: null,
        watermarkTs: newWatermark
      }));
    }

    return {
      ok: true,
      code: 0,
      exportRunId,
      summary,
      configSummary: {
        paths: config.paths,
        localClickHouse: config.localClickHouse.describe(),
        awsClickHouse: config.awsClickHouse.describe(),
        e3dCorp: {
          baseUrl: sanitizeUrl(config.e3dCorp.baseUrl),
          outcomePath: config.e3dCorp.outcomePath,
          authMode: config.e3dCorp.apiKey ? "bearer" : config.e3dCorp.sessionCookie ? "session_cookie" : "none",
          timeoutMs: config.e3dCorp.timeoutMs,
          maxAttempts: config.e3dCorp.maxAttempts
        }
      }
    };
  } catch (error) {
    const completedAt = nowIso(new Date(now.getTime() + 1));
    const message = error instanceof Error ? error.message : String(error);
    appendJsonlLog(config.paths.exportLog, {
      ts: completedAt,
      stage: "export_error",
      export_run_id: exportRunId,
      phase: EXPORTER_PHASE,
      message
    });
    if (stateEnabled) {
      writeState(config.paths.stateFile, updateStateForCompletion(priorState, {
        startedAt,
        completedAt,
        successCount: 0,
        errorMessage: message
      }));
    }
    return {
      ok: false,
      code: 1,
      message,
      exportRunId
    };
  } finally {
    releaseLock(config.paths.lockFile);
  }
}

export function formatCliSummary(result, { verbose = false } = {}) {
  if (!result?.ok || !result?.summary) return [];

  const { summary } = result;
  const lines = [
    `e3dActionOutcomeExport: ${EXPORTER_PHASE} ${summary.status} (run_id=${result.exportRunId}, dry_run=${summary.dry_run}, source=${summary.source})`
  ];

  if (summary.create_tables_only) {
    lines.push(`e3dActionOutcomeExport: table_count=${summary.destination_tables.length} destination_tables=${summary.destination_tables.join(",")}`);
  } else {
    lines.push(
      "e3dActionOutcomeExport: "
      + `events_scanned=${summary.counts.events_scanned} `
      + `events_selected=${summary.counts.events_selected} `
      + `actions_mapped=${summary.counts.actions_mapped} `
      + `outcomes_mapped=${summary.counts.outcomes_mapped} `
      + `corp_outcomes_mapped=${summary.counts.corp_outcomes_mapped}`
      + (summary.dry_run
        ? ""
        : ` actions_inserted=${summary.counts.actions_inserted} outcomes_inserted=${summary.counts.outcomes_inserted} corp_outcomes_delivered=${summary.counts.corp_outcomes_delivered} inserted_rows=${summary.counts.inserted_rows}`)
    );
    if (summary.source_min_ts || summary.source_max_ts) {
      lines.push(`e3dActionOutcomeExport: source_window min_ts=${summary.source_min_ts || "n/a"} max_ts=${summary.source_max_ts || "n/a"}`);
    }
    if (summary.destination_tables.length) {
      lines.push(`e3dActionOutcomeExport: destination_tables=${summary.destination_tables.join(",")}`);
    }
  }

  if (summary.issues.length) {
    lines.push(`e3dActionOutcomeExport: issues=${summary.issues.join(",")}`);
  }
  if (verbose && result.configSummary) {
    lines.push(JSON.stringify(result.configSummary, null, 2));
  }

  return lines;
}

function loadDotEnv(root) {
  const envFile = path.join(root, ".env");
  let raw;
  try {
    raw = fs.readFileSync(envFile, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || key.includes(" ") || process.env[key] != null) continue;
    let value = trimmed.slice(eqIndex + 1).split("#")[0].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// cron invokes this script through the /Users/mini/e3d-agent-trading-floor symlink using its
// absolute path. __filename is realpath-resolved by the module loader, so path.resolve() alone
// (which does not dereference symlinks) never matches process.argv[1] and export silently no-ops.
const isDirectRun = process.argv[1] && (() => {
  try {
    return fs.realpathSync(process.argv[1]) === __filename;
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
})();

if (isDirectRun) {
  loadDotEnv(ROOT);
  try {
    const result = await runExporter();
    if (result.ok) {
      const verbose = parseArgs(process.argv.slice(2)).verbose;
      for (const line of formatCliSummary(result, { verbose })) {
        console.log(line);
      }
      process.exit(0);
    }
    console.error(`e3dActionOutcomeExport: ${result.message}`);
    process.exit(result.code || 1);
  } catch (error) {
    console.error(`e3dActionOutcomeExport: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
