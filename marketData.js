// marketData.js — Quant-grade market data from free external APIs
// Sources: DexScreener (order flow), CoinGecko (BTC/ETH macro),
//          Alternative.me Fear & Greed Index, Binance (funding rates)
// All calls are synchronous curl, matching the pipeline.js pattern.

import { execFileSync } from "child_process";

const DEXSCREENER_BASE   = "https://api.dexscreener.com/latest/dex";
const COINGECKO_URL      = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true";
const FEAR_GREED_URL     = "https://api.alternative.me/fng/?limit=1";
const BINANCE_PREMIUM_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";

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

  // 2. Macro — two small calls (Fear&Greed + CoinGecko)
  const fearGreed = fetchFearAndGreed();
  const macro     = fetchCryptoMacro();

  // 3. Binance funding — one call for all perps, then filter to held symbols
  const allFunding   = fetchAllBinanceFunding();
  const fundingRates = lookupFundingRates(heldSymbols, allFunding);

  // 4. Unified regime combining fear/greed + BTC momentum
  const fgValue = fearGreed?.value   ?? 50;
  const btc24h  = macro?.btc_24h_pct ?? 0;
  const regime =
    (fgValue >= 80 || btc24h >  10) ? "extreme_greed" :
    (fgValue >= 60 || btc24h >   4) ? "greed"         :
    (fgValue <= 20 || btc24h <  -8) ? "extreme_fear"  :
    (fgValue <= 35 || btc24h <  -4) ? "fear"          :
                                      "neutral";

  const newPositionsOk = fgValue < 75 && btc24h > -4;
  const tightenStops   = fgValue > 75 || btc24h < -5;

  return {
    fetched_at: new Date().toISOString(),
    macro: {
      fear_greed:       fearGreed,
      btc:              macro ? { price: macro.btc_price, change_24h_pct: macro.btc_24h_pct } : null,
      eth:              macro ? { price: macro.eth_price, change_24h_pct: macro.eth_24h_pct, outperforming_btc: macro.eth_outperforming_btc } : null,
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
