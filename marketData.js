// marketData.js — Quant-grade market data from free external APIs
// Sources: DexScreener (order flow), CoinGecko (BTC/ETH macro),
//          Alternative.me Fear & Greed Index, Binance (funding rates)
// All calls are synchronous curl, matching the pipeline.js pattern.

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DEXSCREENER_BASE   = "https://api.dexscreener.com/latest/dex";
const COINGECKO_URL      = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true";
const FEAR_GREED_URL     = "https://api.alternative.me/fng/?limit=1";
const BINANCE_PREMIUM_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";
const REGULATORY_FLAG_PATH = path.join(__dirname, "state", "regulatory-flag.json");

// Tokens known to trade as Binance USDT perpetuals.
// ETH-wrapped variants map to the ETH perp since they track it closely.
const BINANCE_PERP_MAP = new Map([
  ["BTC",     "BTCUSDT"],  ["ETH",    "ETHUSDT"],  ["BNB",    "BNBUSDT"],
  ["SOL",     "SOLUSDT"],  ["ADA",    "ADAUSDT"],  ["XRP",    "XRPUSDT"],
  ["DOGE",    "DOGEUSDT"], ["LINK",   "LINKUSDT"], ["UNI",    "UNIUSDT"],
  ["AAVE",    "AAVEUSDT"], ["CRV",    "CRVUSDT"],  ["SNX",    "SNXUSDT"],
  ["COMP",    "COMPUSDT"], ["BAL",    "BALUSDT"],  ["MATIC",  "MATICUSDT"],
  ["POL",     "POLUSDT"],  ["ARB",    "ARBUSDT"],  ["OP",     "OPUSDT"],
  ["INJ",     "INJUSDT"],  ["SEI",    "SEIUSDT"],  ["FET",    "FETUSDT"],
  ["GRT",     "GRTUSDT"],  ["ENJ",    "ENJUSDT"],  ["MANA",   "MANAUSDT"],
  ["SAND",    "SANDUSDT"], ["CHZ",    "CHZUSDT"],  ["AXS",    "AXSUSDT"],
  ["APE",     "APEUSDT"],  ["LOOKS",  "LOOKSUSDT"],["BLUR",   "BLURUSDT"],
  ["GMT",     "GMTUSDT"],  ["NEAR",   "NEARUSDT"], ["AVAX",   "AVAXUSDT"],
  ["FTM",     "FTMUSDT"],  ["ATOM",   "ATOMUSDT"], ["TIA",    "TIAUSDT"],
  ["TON",     "TONUSDT"],  ["ONDO",   "ONDOUSDT"], ["WLD",    "WLDUSDT"],
  ["PENDLE",  "PENDLEUSDT"],["JTO",   "JTOUSDT"],  ["PYTH",   "PYTHUSDT"],
  ["ENA",     "ENAUSDT"],  ["DYDX",   "DYDXUSDT"], ["GMX",    "GMXUSDT"],
  ["STG",     "STGUSDT"],  ["WOO",    "WOOUSDT"],  ["COW",    "COWUSDT"],
  // ETH-wrapped tokens map to the ETH perp
  ["WETH",    "ETHUSDT"],  ["WSTETH", "ETHUSDT"],  ["CBETH",  "ETHUSDT"],
  ["RETH",    "ETHUSDT"],  ["STETH",  "ETHUSDT"],
]);

// ── Shared fetch helper ───────────────────────────────────────────────────────

function curlJson(url, timeoutSec = 12) {
  try {
    const text = execFileSync("curl", [
      "-sf", "--max-time", String(timeoutSec), "-L",
      "-H", "Accept: application/json",
      "-A", "e3d-trading-floor/1.0",
      url
    ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return text ? JSON.parse(text.trim()) : null;
  } catch {
    return null;
  }
}

// ── DexScreener ───────────────────────────────────────────────────────────────

// Fetch up to 30 token addresses per call (DexScreener batch limit).
// Returns { lowercaseAddress: rawPair } for the most-liquid ETH pair per token.
function fetchDexScreenerBatch(addresses) {
  if (!addresses.length) return {};
  const allPairs = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30).join(",");
    const data = curlJson(`${DEXSCREENER_BASE}/tokens/${chunk}`);
    if (data?.pairs) allPairs.push(...data.pairs);
  }

  // Pick the most liquid Ethereum pair for each base token
  const byAddr = {};
  for (const pair of allPairs) {
    if (pair.chainId !== "ethereum") continue;
    const addr = (pair.baseToken?.address || "").toLowerCase();
    if (!addr) continue;
    const liq = pair.liquidity?.usd ?? 0;
    if (!byAddr[addr] || liq > (byAddr[addr].liquidity?.usd ?? 0)) {
      byAddr[addr] = pair;
    }
  }
  return byAddr;
}

function summarizePair(pair) {
  if (!pair) return null;
  const buys1h   = pair.txns?.h1?.buys   ?? 0;
  const sells1h  = pair.txns?.h1?.sells  ?? 0;
  const buys24h  = pair.txns?.h24?.buys  ?? 0;
  const sells24h = pair.txns?.h24?.sells ?? 0;

  const ratio1h  = sells1h  > 0 ? +(buys1h  / sells1h ).toFixed(2) : (buys1h  > 0 ? 9.99 : 1.0);
  const ratio24h = sells24h > 0 ? +(buys24h / sells24h).toFixed(2) : (buys24h > 0 ? 9.99 : 1.0);
  const priceUsd = parseFloat(pair.priceUsd ?? 0) || 0;

  // Order flow signal based on 1h buy/sell ratio
  const flowSignal =
    ratio1h >= 2.0 ? "strong_accumulation" :
    ratio1h >= 1.4 ? "accumulation"        :
    ratio1h >= 0.8 ? "neutral"             :
    ratio1h >= 0.5 ? "distribution"        :
                     "strong_distribution";

  return {
    price_usd:            priceUsd,
    price_change_5m_pct:  pair.priceChange?.m5  ?? null,
    price_change_1h_pct:  pair.priceChange?.h1  ?? null,
    price_change_6h_pct:  pair.priceChange?.h6  ?? null,
    price_change_24h_pct: pair.priceChange?.h24 ?? null,
    buys_1h:              buys1h,
    sells_1h:             sells1h,
    buy_sell_ratio_1h:    ratio1h,
    buys_24h:             buys24h,
    sells_24h:            sells24h,
    buy_sell_ratio_24h:   ratio24h,
    volume_1h_usd:        pair.volume?.h1  ?? null,
    volume_24h_usd:       pair.volume?.h24 ?? null,
    liquidity_usd:        pair.liquidity?.usd ?? null,
    market_cap_usd:       pair.marketCap ?? null,
    fdv_usd:              pair.fdv       ?? null,
    dex_id:               pair.dexId     ?? null,
    pair_address:         pair.pairAddress ?? null,
    flow_signal:          flowSignal,
  };
}

// ── Macro ─────────────────────────────────────────────────────────────────────

function fetchFearAndGreed() {
  const data  = curlJson(FEAR_GREED_URL, 8);
  const entry = data?.data?.[0];
  if (!entry) return null;
  const value = parseInt(entry.value ?? 50, 10);
  const regime =
    value >= 80 ? "extreme_greed" :
    value >= 60 ? "greed"         :
    value >= 40 ? "neutral"       :
    value >= 20 ? "fear"          :
                  "extreme_fear";
  return { value, label: entry.value_classification ?? "Unknown", regime };
}

function fetchCryptoMacro() {
  const data = curlJson(COINGECKO_URL, 10);
  if (!data) return null;
  const btc24h   = data.bitcoin?.usd_24h_change  ?? 0;
  const eth24h   = data.ethereum?.usd_24h_change ?? 0;
  const btcPrice = data.bitcoin?.usd  ?? 0;
  const ethPrice = data.ethereum?.usd ?? 0;

  const btcRegime =
    btc24h < -8 ? "crash"        :
    btc24h < -4 ? "risk_off"     :
    btc24h < -2 ? "cautious"     :
    btc24h >  8 ? "euphoria"     :
    btc24h >  4 ? "risk_on"      :
    btc24h >  2 ? "mild_risk_on" :
                  "neutral";

  return {
    btc_price:            btcPrice,
    btc_24h_pct:          +btc24h.toFixed(2),
    eth_price:            ethPrice,
    eth_24h_pct:          +eth24h.toFixed(2),
    eth_outperforming_btc: eth24h > btc24h,
    btc_regime:           btcRegime,
    new_positions_ok:     btc24h > -4,
    tighten_stops:        btc24h < -5 || btc24h > 10,
  };
}

function summarizeTrendFromPrices(prices) {
  const pts = (Array.isArray(prices) ? prices : [])
    .map((row) => Number(Array.isArray(row) ? row[1] : row))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (pts.length < 10) return null;
  const window = pts.slice(-21);
  const first = window[0];
  const last = window[window.length - 1];
  const sma = window.reduce((sum, n) => sum + n, 0) / window.length;
  const return20dPct = ((last / first) - 1) * 100;
  const absRets = [];
  for (let i = 1; i < window.length; i += 1) {
    absRets.push(Math.abs(window[i] / window[i - 1] - 1));
  }
  const atrPct = absRets.length ? (absRets.reduce((sum, n) => sum + n, 0) / absRets.length) * 100 : 0;
  const signal = return20dPct > 0 && last >= sma ? "long" : "flat";
  return {
    price: last,
    sma20: Number(sma.toFixed(2)),
    return_20d_pct: Number(return20dPct.toFixed(3)),
    atr_pct: Number(atrPct.toFixed(3)),
    signal,
    samples: window.length
  };
}

export function fetchAssetTrend(coinId) {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=21&interval=daily`;
  const data = curlJson(url, 12);
  return summarizeTrendFromPrices(data?.prices);
}

export function buildBookRegimeFromTrends(btcTrend, ethTrend, fallback24hPct = 0) {
  if (btcTrend?.signal === "long") return "risk_on";
  if (btcTrend && Number(btcTrend.return_20d_pct) < -5) return "risk_off";
  if (!btcTrend && fallback24hPct < -4) return "risk_off";
  if (!btcTrend && fallback24hPct > 4) return "risk_on";
  return "neutral";
}

// ── Cross-asset macro (DXY + equity index) ──────────────────────────────────
// Adds dollar-strength and broad-equity readings alongside the crypto-native macro
// above. Same never-throw/null-on-failure contract as fetchFearAndGreed/fetchCryptoMacro.

const YAHOO_QUOTE_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

// Yahoo's unofficial quote endpoint. Free, no key, but undocumented and occasionally
// rate-limited/restructured — treated as primary with a stooq fallback below.
function fetchYahooQuote(ticker) {
  const url = `${YAHOO_QUOTE_BASE}/${encodeURIComponent(ticker)}`;
  const data = curlJson(url, 10);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") return null;

  const prevClose = typeof meta.previousClose === "number" ? meta.previousClose : meta.chartPreviousClose;
  if (typeof prevClose !== "number" || prevClose === 0) return null;

  // Yahoo reports the current regular-session window in currentTradingPeriod — use it
  // directly rather than a fuzzy staleness heuristic to determine whether the instrument
  // is trading right now (equities close nights/weekends/holidays; crypto never does).
  const nowSec = Math.floor(Date.now() / 1000);
  const regular = meta.currentTradingPeriod?.regular;
  const marketOpen = !!(regular && nowSec >= regular.start && nowSec <= regular.end);

  return {
    value: meta.regularMarketPrice,
    change_24h_pct: +(((meta.regularMarketPrice - prevClose) / prevClose) * 100).toFixed(3),
    as_of: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    market_open: marketOpen,
    source: "yahoo",
  };
}

// Fallback: stooq's free daily CSV ("Date,Open,High,Low,Close,Volume"). EOD granularity
// only — known to be intermittently blocked by a bot-verification challenge, so this is
// best-effort; a failure here just means the caller falls back to null, same as any other
// quant data source in this file.
function fetchStooqDailyChange(stooqSymbol) {
  try {
    const text = execFileSync("curl", [
      "-sf", "--max-time", "10", "-L", "-A", "e3d-trading-floor/1.0",
      `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`,
    ], { encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const lines = (text || "").trim().split("\n").filter(Boolean);
    if (lines.length < 3) return null; // header + at least 2 data rows needed
    const rows = lines.slice(1).map((l) => l.split(","));
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const lastClose = parseFloat(last[4]);
    const prevClose = parseFloat(prev[4]);
    if (!Number.isFinite(lastClose) || !Number.isFinite(prevClose) || prevClose === 0) return null;
    return {
      value: lastClose,
      change_24h_pct: +(((lastClose - prevClose) / prevClose) * 100).toFixed(3),
      as_of: last[0] ? new Date(last[0]).toISOString() : null,
      market_open: false, // stooq is EOD-only — never treated as a live session read
      source: "stooq",
    };
  } catch {
    return null;
  }
}

// DXY proxy (US Dollar Index). Yahoo ticker DX-Y.NYB, stooq fallback symbol dx.f.
export function fetchDollarIndex() {
  return fetchYahooQuote("DX-Y.NYB") || fetchStooqDailyChange("dx.f");
}

// Broad equity/tech index (Nasdaq-100). Yahoo ticker ^NDX, stooq fallback symbol ^ndx.
export function fetchEquityIndex() {
  return fetchYahooQuote("^NDX") || fetchStooqDailyChange("^ndx");
}

// ── Manual regulatory/political-event flag ──────────────────────────────────
// A coarse, operator-set override for event-driven regulatory/political catalysts
// (legislation progress, SEC actions, ETF approvals, etc.) that the pipeline has no
// automated visibility into — deliberately NOT automated (no news feed, no keyword
// scanning). Set/cleared only via `scripts/setRegulatoryFlag.js`, run by a human; never
// written by the pipeline or any LLM agent. Expires on its own so a flag set for one
// event can't silently keep biasing the system days later if nobody clears it.
const VALID_REGULATORY_STANCES = new Set(["risk_on", "risk_off"]);

export function readRegulatoryFlag() {
  try {
    const text = fs.readFileSync(REGULATORY_FLAG_PATH, "utf8");
    const flag = JSON.parse(text);
    if (!flag || !VALID_REGULATORY_STANCES.has(flag.stance)) return null;
    if (!flag.expires_at || new Date(flag.expires_at).getTime() <= Date.now()) return null;
    return {
      stance: flag.stance,
      reason: typeof flag.reason === "string" ? flag.reason.slice(0, 200) : null,
      set_at: flag.set_at || null,
      expires_at: flag.expires_at,
    };
  } catch {
    return null; // missing file, bad/malformed JSON, expired, or any other error
  }
}

// ── Binance funding rates ─────────────────────────────────────────────────────

// Fetches ALL perpetual mark prices + funding rates in one call.
function fetchAllBinanceFunding() {
  const data = curlJson(BINANCE_PREMIUM_URL, 10);
  if (!Array.isArray(data)) return {};
  const out = {};
  for (const item of data) {
    const sym  = String(item.symbol || "");
    const rate = parseFloat(item.lastFundingRate ?? 0);
    const signal =
      rate >  0.001  ? "overcrowded_long"  :
      rate >  0.0005 ? "mild_long_bias"    :
      rate < -0.0003 ? "squeeze_potential" :
                       "neutral";
    out[sym] = { symbol: sym, rate_per_8h: +rate.toFixed(6), signal, avoid_new_longs: rate > 0.001 };
  }
  return out;
}

function lookupFundingRates(symbols, allFunding) {
  const result = {};
  for (const sym of symbols) {
    const clean     = (sym || "").toUpperCase().replace(/USD[TC]?$/, "");
    const binanceSym = BINANCE_PERP_MAP.get(clean);
    if (binanceSym && allFunding[binanceSym]) result[sym] = allFunding[binanceSym];
  }
  return result;
}

// ── Scout universe enrichment ─────────────────────────────────────────────────

// Batch-fetch DexScreener order-flow for an array of token objects (each needs .address).
// Skips addresses already present in existingFlowMap (keyed by lowercase address).
// Returns an updated flow map — call site can merge into _cycleQuantContext.token_flow.
export function batchEnrichTokenFlow(tokens, existingFlowMap = {}) {
  const toFetch = [];
  for (const t of tokens) {
    const addr = (t.address || "").toLowerCase().trim();
    if (addr && !existingFlowMap[addr]) toFetch.push(addr);
  }
  if (!toFetch.length) return existingFlowMap;
  const newPairs = fetchDexScreenerBatch(toFetch.slice(0, 60));
  const result = { ...existingFlowMap };
  for (const [addr, pair] of Object.entries(newPairs)) {
    const s = summarizePair(pair);
    if (s) result[addr] = s;
  }
  return result;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function buildCycleQuantContext(portfolio) {
  const positions   = Object.values(portfolio?.positions || {});
  const heldAddrs   = positions.map(p => (p.contract_address || "").toLowerCase()).filter(Boolean);
  const heldSymbols = positions.map(p => p.symbol).filter(Boolean);

  // 1. DexScreener — one batched call for all held addresses
  const dexPairs  = fetchDexScreenerBatch(heldAddrs);
  const tokenFlow = {};
  for (const [addr, pair] of Object.entries(dexPairs)) {
    const s = summarizePair(pair);
    if (s) tokenFlow[addr] = s;
  }

  // 2. Macro — two small calls (Fear&Greed + CoinGecko), plus cross-asset (DXY + Nasdaq-100)
  const fearGreed   = fetchFearAndGreed();
  const macro       = fetchCryptoMacro();
  const btcTrend    = fetchAssetTrend("bitcoin");
  const ethTrend    = fetchAssetTrend("ethereum");
  const dxy         = fetchDollarIndex();
  const equityIndex = fetchEquityIndex();
  const regulatory  = readRegulatoryFlag();
  const bookRegime  = buildBookRegimeFromTrends(btcTrend, ethTrend, macro?.btc_24h_pct);

  // 3. Binance funding — one call for all perps, then filter to held symbols
  const allFunding   = fetchAllBinanceFunding();
  const fundingRates = lookupFundingRates(heldSymbols, allFunding);

  // 4. Unified regime combining fear/greed + BTC momentum + cross-asset (DXY/equity) +
  // the manual regulatory flag. Cross-asset conditions only fire when change_24h_pct is
  // present — a failed fetch (null) is excluded from the blend rather than treated as
  // "0% change" (neutral), which would silently mask a data outage as a calm market. A
  // closed-market reading (e.g. a Friday equity close carried through the weekend) is
  // still a valid, intentional signal here — it's the last real session move, not a stale
  // value — so market_open does not gate this blend; it's surfaced separately (prompt/log)
  // for observability only.
  const fgValue      = fearGreed?.value   ?? 50;
  const btc24h       = macro?.btc_24h_pct ?? 0;
  const dxySpike      = dxy?.change_24h_pct != null && dxy.change_24h_pct > 0.5;      // strong dollar day
  const equitySelloff = equityIndex?.change_24h_pct != null && equityIndex.change_24h_pct < -2;
  const equityRally   = equityIndex?.change_24h_pct != null && equityIndex.change_24h_pct > 2;
  const regulatoryRiskOn  = regulatory?.stance === "risk_on";
  const regulatoryRiskOff = regulatory?.stance === "risk_off";

  const regime =
    (fgValue >= 80 || btc24h >  10 || equityRally || regulatoryRiskOn)    ? "extreme_greed" :
    (fgValue >= 60 || btc24h >   4)                                      ? "greed"         :
    (fgValue <= 20 || btc24h <  -8 || equitySelloff || regulatoryRiskOff) ? "extreme_fear"  :
    (fgValue <= 35 || btc24h <  -4 || dxySpike)                          ? "fear"          :
                                                                            "neutral";

  const newPositionsOk = bookRegime !== "risk_off" && fgValue < 80 && btc24h > -5 && !equitySelloff && !regulatoryRiskOff;
  const tightenStops   = bookRegime === "risk_off" || fgValue > 80 || btc24h < -8 || dxySpike || equitySelloff || regulatoryRiskOff;

  return {
    fetched_at: new Date().toISOString(),
    macro: {
      fear_greed:       fearGreed,
      btc:              macro ? { price: macro.btc_price, change_24h_pct: macro.btc_24h_pct } : null,
      eth:              macro ? { price: macro.eth_price, change_24h_pct: macro.eth_24h_pct, outperforming_btc: macro.eth_outperforming_btc } : null,
      btc_trend:        btcTrend,
      eth_trend:        ethTrend,
      book_regime:      bookRegime,
      dxy:              dxy ? { value: dxy.value, change_24h_pct: dxy.change_24h_pct, source: dxy.source } : null,
      equity_index:     equityIndex ? { value: equityIndex.value, change_24h_pct: equityIndex.change_24h_pct, source: equityIndex.source } : null,
      regulatory:       regulatory ? { stance: regulatory.stance, reason: regulatory.reason, expires_at: regulatory.expires_at } : null,
      regime,
      new_positions_ok: newPositionsOk,
      tighten_stops:    tightenStops,
    },
    token_flow:    tokenFlow,    // keyed by lowercase contract_address
    funding_rates: fundingRates, // keyed by portfolio symbol
    _all_funding:  allFunding,   // full Binance table for Scout candidate lookup
  };
}

// Enrich a newly-proposed candidate with DexScreener flow + funding rate.
// Called inside runScoutDirect after the LLM returns candidates, before Risk sees them.
export function enrichCandidateQuant(address, symbol, quantContext) {
  if (!quantContext) return { flow: null, funding: null };
  const addr = (address || "").toLowerCase();

  // Try cache first
  let flow = quantContext.token_flow?.[addr] ?? null;

  // Live lookup if not cached (story-enriched tokens won't be in the initial batch)
  if (!flow && addr) {
    try {
      const pairs = fetchDexScreenerBatch([addr]);
      if (pairs[addr]) {
        flow = summarizePair(pairs[addr]);
        if (flow && quantContext.token_flow) quantContext.token_flow[addr] = flow;
      }
    } catch { /* tolerate */ }
  }

  const clean      = (symbol || "").toUpperCase().replace(/USD[TC]?$/, "");
  const binanceSym = BINANCE_PERP_MAP.get(clean);
  const funding    = binanceSym ? (quantContext._all_funding?.[binanceSym] ?? null) : null;

  return { flow, funding };
}
