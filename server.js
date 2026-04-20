import fs from "fs";
import http from "http";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { execFileSync, spawn } from "child_process";
import {
  clearStoredAuth,
  connectWithApiKey,
  connectWithLogin,
  e3dRequest,
  getAuthStatus
} from "./e3dAuthClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const PORTFOLIO_FILE = path.join(ROOT, "portfolio.json");
const PIPELINE_LOG = path.join(LOG_DIR, "pipeline.jsonl");
const TRAINING_EVENT_LOG = path.join(LOG_DIR, "training-events.jsonl");
const MONGO_CONTAINER_NAME = process.env.E3D_MONGO_CONTAINER || "e3d-mongo";
const MONGO_DATABASE_NAME = process.env.E3D_MONGO_DATABASE || "e3d";
const CLICKHOUSE_HTTP_URL = process.env.E3D_CLICKHOUSE_HTTP_URL || "http://127.0.0.1:8123";
const CLICKHOUSE_DATABASE_NAME = process.env.E3D_CLICKHOUSE_DATABASE || "e3d";
const CLICKHOUSE_TABLE_NAME = process.env.E3D_CLICKHOUSE_TABLE || "training_events";
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
      .sort((a, b) => String(b.report.generated_at || "").localeCompare(String(a.report.generated_at || "")));
  } catch {
    return [];
  }
}

function summarizeReport(report, filePath) {
  const criticalFlags = Number(report?.critical_flags ?? (Array.isArray(report?.flags) ? report.flags.filter((flag) => flag.severity === "critical").length : 0));
  const warningFlags = Number(report?.warning_flags ?? (Array.isArray(report?.flags) ? report.flags.filter((flag) => flag.severity === "warning").length : 0));
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
    const response = fetch(`${CLICKHOUSE_HTTP_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE_NAME)}&query=${encodeURIComponent(query)}`, {
      method: "POST"
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

function stopPipelineProcess(signal = "SIGTERM") {
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

    setPipelineState({
      running: false,
      pid: null,
      mode: "stopped",
      exit_code: code,
      signal,
      last_error: code && code !== 0 ? `Pipeline exited with code ${code}` : null
    });
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

async function enrichSoldTrade(trade) {
  const quantity = asNumber(trade.quantity, 0);
  const salePrice = asNumber(trade.price, 0);
  const proceedsUsd = asNumber(trade.proceeds_usd, salePrice * quantity);
  const costUsd = asNumber(trade.cost_portion_usd, 0);
  const avgEntryPrice = quantity > 0 ? costUsd / quantity : asNumber(trade.avg_entry_price, 0);
  const tokenMeta = await fetchTokenMetadata(trade.contract_address);

  return {
    contract_address: trade.contract_address,
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
    current_price: salePrice
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

    const response = fetch(`${CLICKHOUSE_HTTP_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE_NAME)}&query=${encodeURIComponent(query)}`, {
      method: "POST"
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
      symbol: parsed?.token?.symbol || parsed?.symbol || null,
      side: parsed.side || null,
      trade_lifecycle: parsed.trade_lifecycle || null,
      pnl_usd: parsed.pnl_usd ?? null,
      reason_summary: parsed.reason_summary || parsed.short_summary || null
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
    const response = await fetch(`${CLICKHOUSE_HTTP_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE_NAME)}&query=${encodeURIComponent(query)}`, {
      method: "POST"
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

  if (url.pathname === "/api/pipeline/start" && req.method === "POST") {
    const body = await readRequestJson();
    const intervalSeconds = body.interval_seconds ?? body.intervalSeconds ?? 300;
    const status = startPipelineProcess(intervalSeconds);
    sendJson(res, 200, status);
    return;
  }

  if (url.pathname === "/api/pipeline/stop" && req.method === "POST") {
    const stopped = stopPipelineProcess();
    sendJson(res, 200, {
      ok: stopped,
      pipeline: getPipelineStatus()
    });
    return;
  }

  if (url.pathname === "/api/reset-all" && req.method === "POST") {
    const result = clearSystemState();
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

  if (url.pathname.startsWith("/api/reports/") && req.method === "GET") {
    const reportId = decodeURIComponent(url.pathname.slice("/api/reports/".length)).trim();
    const match = listReportFiles().find(({ report }) => report?.report_id === reportId);
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
    // Sequential enrichment — concurrent Promise.all causes a request burst that
    // exhausts the API rate limit and causes 429s in the pipeline stories call.
    const enrichedPositions = [];
    for (const pos of positions) enrichedPositions.push(await enrichPortfolioPosition(pos));
    const enrichedHistory = [];
    for (const trade of historyTrades.slice(0, 20)) enrichedHistory.push(await enrichSoldTrade(trade));
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

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  });
});

server.on("upgrade", wsHandleUpgrade);

// Reattach to any pipeline that survived a previous server restart
recoverPipelineIfRunning();

server.listen(PORT, HOST, () => {
  console.log(`Dashboard server running at http://${HOST}:${PORT}`);
});
