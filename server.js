import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DASHBOARD_DIR = path.join(ROOT, "dashboard");
const LOG_DIR = path.join(ROOT, "logs");
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

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
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

function runShell(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
}

function getPipelineStatus() {
  return {
    ...pipelineState,
    running: Boolean(pipelineProcess) && pipelineState.running,
    pid: pipelineProcess?.pid ?? pipelineState.pid ?? null
  };
}

function setPipelineState(nextState) {
  pipelineState = {
    ...pipelineState,
    ...nextState
  };
}

function stopPipelineProcess(signal = "SIGINT") {
  if (!pipelineProcess) {
    setPipelineState({ running: false, mode: "stopped", pid: null });
    return false;
  }

  try {
    pipelineState.stop_requested_at = new Date().toISOString();
    pipelineProcess.kill(signal);
  } catch (err) {
    setPipelineState({
      running: false,
      mode: "stopped",
      pid: null,
      last_error: err.message
    });
    pipelineProcess = null;
    return false;
  }

  return true;
}

function startPipelineProcess(intervalSeconds = 300) {
  if (pipelineProcess) {
    stopPipelineProcess("SIGINT");
  }

  const safeIntervalSeconds = Math.max(1, Number(intervalSeconds) || 300);
  const child = spawn(process.execPath, [PIPELINE_ENTRYPOINT, "--loop", "--interval-seconds", String(safeIntervalSeconds)], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  pipelineProcess = child;
  setPipelineState({
    running: true,
    pid: child.pid,
    mode: "loop",
    interval_seconds: safeIntervalSeconds,
    started_at: new Date().toISOString(),
    stop_requested_at: null,
    exit_code: null,
    signal: null,
    last_error: null
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  child.on("exit", (code, signal) => {
    const wasCurrent = pipelineProcess === child;
    if (wasCurrent) {
      pipelineProcess = null;
    }

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
    if (pipelineProcess === child) {
      pipelineProcess = null;
    }
    setPipelineState({
      running: false,
      pid: null,
      mode: "stopped",
      last_error: err.message
    });
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
  return {
    contract_address: String(candidate.contract_address || candidate.address || address || "").toLowerCase(),
    symbol: candidate.symbol || candidate.ticker || null,
    name: candidate.name || candidate.token_name || candidate.display_name || candidate.title || null,
    icon_url: candidate.icon_url || candidate.icon || candidate.logo_url || candidate.image_url || candidate.token_icon_url || null,
    image_url: candidate.image_url || candidate.icon || candidate.logo_url || candidate.icon_url || candidate.token_image_url || null
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
    `https://e3d.ai/api/token/${encodeURIComponent(cleanAddress)}`,
    `https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?search=${encodeURIComponent(cleanAddress)}&limit=1&offset=0&hideNoCirc=1`
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) continue;
      const payload = await readJsonResponse(response);
      const normalized = normalizeTokenMetadata(payload, cleanAddress);
      if (normalized) {
        TOKEN_METADATA_CACHE.set(cleanAddress, { fetched_at: Date.now(), value: normalized });
        return normalized;
      }
    } catch {
      // Ignore and continue to the next endpoint.
    }
  }

  TOKEN_METADATA_CACHE.set(cleanAddress, { fetched_at: Date.now(), value: null });
  return null;
}

async function enrichPortfolioPosition(pos) {
  const quantity = asNumber(pos.quantity, 0);
  const currentPrice = asNumber(pos.current_price, 0);
  const avgEntryPrice = asNumber(pos.avg_entry_price, 0);
  const currentValueUsd = asNumber(pos.market_value_usd, currentPrice * quantity);
  const costUsd = avgEntryPrice * quantity;
  const tokenMeta = await fetchTokenMetadata(pos.contract_address);
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
      "--quiet",
      "--eval",
      script
    ], {
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
  return readJsonFile(PORTFOLIO_FILE, {
    cash_usd: 0,
    positions: {},
    closed_trades: [],
    action_history: [],
    cooldowns: {},
    stats: {}
  });
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
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
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
      pipeline: getPipelineStatus()
    });
    return;
  }

  if (url.pathname === "/api/pipeline/status") {
    sendJson(res, 200, getPipelineStatus());
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
    const stopped = stopPipelineProcess("SIGINT");
    sendJson(res, 200, {
      ok: stopped,
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

  if (url.pathname === "/api/summary") {
    const [portfolio, activity] = await Promise.all([loadPortfolioState(), loadActivity()]);
    const positions = Object.values(portfolio.positions || {});
    const historyTrades = Array.isArray(portfolio.closed_trades) ? [...portfolio.closed_trades].reverse() : [];
    const enrichedPositions = await Promise.all(positions.map((pos) => enrichPortfolioPosition(pos)));
    const enrichedHistory = await Promise.all(historyTrades.map((trade) => enrichSoldTrade(trade)));
    sendJson(res, 200, {
      portfolio: {
        cash_usd: portfolio.cash_usd || 0,
        equity_usd: portfolio.stats?.equity_usd || portfolio.cash_usd || 0,
        realized_pnl_usd: portfolio.stats?.realized_pnl_usd || 0,
        unrealized_pnl_usd: portfolio.stats?.unrealized_pnl_usd || 0,
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

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard server running at http://${HOST}:${PORT}`);
});
