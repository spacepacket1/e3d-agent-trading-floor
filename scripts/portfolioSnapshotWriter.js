#!/usr/bin/env node
// Writes one row to AgentPortfolioSnapshots per invocation.
// Designed to run every 5 minutes via cron.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// cron invokes this script through the /Users/mini/e3d-agent-trading-floor symlink using its
// absolute path. __filename is realpath-resolved by the module loader, so a naive string compare
// against process.argv[1] (the symlinked path) never matches and main() silently never runs.
function isDirectlyInvoked() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === __filename;
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

// Load .env before reading any process.env values (same pattern as e3dActionOutcomeExport.js)
function loadDotEnv(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, ".env"), "utf8");
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
loadDotEnv(ROOT);

const PORTFOLIO_ID = "default";
const INITIAL_CASH_USD = 100000;
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd";

const CH_BASE_URL = process.env.AWS_E3D_CLICKHOUSE_HTTP_URL || process.env.LOCAL_CLICKHOUSE_HTTP_URL || "";
const CH_DATABASE = process.env.AWS_E3D_CLICKHOUSE_DATABASE || process.env.LOCAL_CLICKHOUSE_DATABASE || "e3d";
const CH_USER = process.env.AWS_E3D_CLICKHOUSE_USER || process.env.LOCAL_CLICKHOUSE_USER || "default";
const CH_PASSWORD = process.env.AWS_E3D_CLICKHOUSE_PASSWORD || process.env.LOCAL_CLICKHOUSE_PASSWORD || "";

const STATE_FILE = path.join(ROOT, "state", "portfolio-snapshot-writer-state.json");
const LOG_FILE = path.join(ROOT, "logs", "portfolio-snapshot-writer.log");

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${CH_DATABASE}.AgentPortfolioSnapshots
(
  portfolioId String,
  mode LowCardinality(String),
  snapshotTime DateTime64(3, 'UTC'),
  equityUsd Float64,
  cashUsd Float64,
  unrealizedPnlUsd Float64,
  realizedPnlUsd Float64,
  totalPnlUsd Float64,
  benchmarkEthValueUsd Float64,
  benchmarkBtcValueUsd Float64,
  benchmarkCustomValueUsd Float64,
  openPositionsCount UInt32,
  blockedActionsCount UInt32,
  createdAt DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
ORDER BY (portfolioId, snapshotTime)
`.trim();

function chQuery({ query, input = "", timeoutMs = 30000 }) {
  if (!CH_BASE_URL) throw new Error("ClickHouse URL not configured. Set AWS_E3D_CLICKHOUSE_HTTP_URL.");
  const url = new URL(CH_BASE_URL);
  url.searchParams.set("database", CH_DATABASE);
  const body = `${query}${input ? `\n${input}` : ""}`;
  const args = [
    "-sS", "--fail-with-body",
    "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    "-u", `${CH_USER}:${CH_PASSWORD}`,
    url.toString(),
    "--data-binary", "@-",
  ];
  try {
    return execFileSync("curl", args, { encoding: "utf8", timeout: timeoutMs, input: body });
  } catch (err) {
    const detail = err?.stdout || err?.stderr || "";
    throw new Error(`${err?.message || String(err)}${detail ? `\n${detail.slice(0, 2000)}` : ""}`);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadPortfolio() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "portfolio.json"), "utf8"));
}

function fetchMacroPrices() {
  try {
    const raw = execFileSync("curl", ["-sS", "--max-time", "10", COINGECKO_URL], {
      encoding: "utf8",
      timeout: 12000,
    });
    const data = JSON.parse(raw);
    return {
      ethPrice: data.ethereum?.usd ?? 0,
      btcPrice: data.bitcoin?.usd ?? 0,
    };
  } catch {
    return { ethPrice: 0, btcPrice: 0 };
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

export function buildSnapshotRow(portfolio, { ethPrice, btcPrice }, state, nowIso) {
  const stats = portfolio.stats || {};
  const positions = portfolio.positions || {};
  const settings = portfolio.settings || {};

  const mode = settings.paper_mode !== false ? "PAPER" : "LIVE";
  const cashUsd = typeof portfolio.cash_usd === "number" ? portfolio.cash_usd : 0;
  const unrealizedPnlUsd =
    typeof stats.unrealized_pnl_usd === "number" ? stats.unrealized_pnl_usd : 0;
  const realizedPnlUsd =
    typeof stats.realized_pnl_usd === "number" ? stats.realized_pnl_usd : 0;

  let equityUsd = typeof stats.equity_usd === "number" ? stats.equity_usd : NaN;
  if (!Number.isFinite(equityUsd)) {
    const marketValue = Object.values(positions).reduce(
      (sum, p) => sum + (typeof p.market_value_usd === "number" ? p.market_value_usd : 0),
      0
    );
    equityUsd = cashUsd + marketValue;
  }

  const totalPnlUsd = equityUsd - INITIAL_CASH_USD;
  const openPositionsCount = Object.keys(positions).length;
  // Cooldowns represent tokens the pipeline is currently blocking new entries on
  const blockedActionsCount = Object.keys(portfolio.cooldowns || {}).length;

  // Benchmark: $INITIAL_CASH_USD worth of ETH/BTC bought at the first snapshot's price
  const initialEthPrice = state.initialEthPrice || 0;
  const initialBtcPrice = state.initialBtcPrice || 0;
  const benchmarkEthValueUsd =
    initialEthPrice > 0 && ethPrice > 0
      ? (INITIAL_CASH_USD / initialEthPrice) * ethPrice
      : 0;
  const benchmarkBtcValueUsd =
    initialBtcPrice > 0 && btcPrice > 0
      ? (INITIAL_CASH_USD / initialBtcPrice) * btcPrice
      : 0;

  // ClickHouse DateTime64 expects 'YYYY-MM-DD HH:MM:SS.mmm' in UTC
  const snapshotTime = nowIso.replace("T", " ").replace("Z", "");

  return {
    portfolioId: PORTFOLIO_ID,
    mode,
    snapshotTime,
    equityUsd: +equityUsd.toFixed(6),
    cashUsd: +cashUsd.toFixed(6),
    unrealizedPnlUsd: +unrealizedPnlUsd.toFixed(6),
    realizedPnlUsd: +realizedPnlUsd.toFixed(6),
    totalPnlUsd: +totalPnlUsd.toFixed(6),
    benchmarkEthValueUsd: +benchmarkEthValueUsd.toFixed(6),
    benchmarkBtcValueUsd: +benchmarkBtcValueUsd.toFixed(6),
    benchmarkCustomValueUsd: 0,
    openPositionsCount,
    blockedActionsCount,
    createdAt: snapshotTime,
  };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const createTablesOnly = process.argv.includes("--create-tables-only");
  const verbose = process.argv.includes("--verbose");

  if (!dryRun) {
    log("ensuring AgentPortfolioSnapshots table exists");
    chQuery({ query: TABLE_DDL });
  }

  if (createTablesOnly) {
    log("table created/verified (--create-tables-only)");
    return;
  }

  const portfolio = loadPortfolio();
  if (verbose) log(`portfolio loaded: cash=$${portfolio.cash_usd?.toFixed(2)}`);

  const { ethPrice, btcPrice } = fetchMacroPrices();
  if (verbose) log(`macro prices: ETH=$${ethPrice} BTC=$${btcPrice}`);

  const state = loadState();
  let stateChanged = false;

  if (!state.initialEthPrice && ethPrice > 0) {
    state.initialEthPrice = ethPrice;
    state.initializedAt = new Date().toISOString();
    stateChanged = true;
    log(`benchmark baseline set: ETH=$${ethPrice.toFixed(2)}`);
  }
  if (!state.initialBtcPrice && btcPrice > 0) {
    state.initialBtcPrice = btcPrice;
    stateChanged = true;
    log(`benchmark baseline set: BTC=$${btcPrice.toFixed(2)}`);
  }
  if (stateChanged) saveState(state);

  const nowIso = new Date().toISOString();
  const row = buildSnapshotRow(portfolio, { ethPrice, btcPrice }, state, nowIso);

  log(
    `snapshot: equity=$${row.equityUsd.toFixed(2)} cash=$${row.cashUsd.toFixed(2)} ` +
    `realized=${row.realizedPnlUsd.toFixed(2)} unrealized=${row.unrealizedPnlUsd.toFixed(2)} ` +
    `positions=${row.openPositionsCount} cooldowns=${row.blockedActionsCount} ` +
    `ethBenchmark=$${row.benchmarkEthValueUsd.toFixed(2)}`
  );

  if (dryRun) {
    log("dry-run: row not inserted");
    if (verbose) log(JSON.stringify(row, null, 2));
    return;
  }

  chQuery({
    query: `INSERT INTO ${CH_DATABASE}.AgentPortfolioSnapshots FORMAT JSONEachRow`,
    input: JSON.stringify(row),
  });

  log("snapshot inserted");
}

if (isDirectlyInvoked()) {
  try {
    main();
  } catch (err) {
    const msg = `FATAL: ${err.message}`;
    log(msg);
    process.exit(1);
  }
}
