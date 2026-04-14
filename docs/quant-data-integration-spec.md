# Quant Data Integration Spec
## What Was Built and Why — For Platform Migration

This document describes the non-e3d.ai data sources, signals, and integration patterns added to
the agent trading floor pipeline. The goal is to capture enough detail that this functionality
can be replicated natively inside the e3d.ai platform when the time comes.

---

## Background

The pipeline was exclusively dependent on e3d.ai as its data source. Three problems emerged:

1. **Anonymous rate limits** — without credentials, the e3d.ai API returns severely limited data.
   Candidates, theses, and story endpoints all return empty or truncated results.
2. **Single data source** — the agents had no independent way to confirm or contradict e3d.ai
   signals with live market data.
3. **No macro context** — agents were making position decisions with no awareness of BTC momentum,
   market sentiment, or derivatives positioning — the three things a quant desk checks first.

The fix was to add four free external data sources that work regardless of e3d.ai auth status,
and wire their signals into Scout (entry decisions) and Harvest (exit decisions).

---

## External Data Sources

### 1. DexScreener
**URL:** `https://api.dexscreener.com/latest/dex/tokens/{addr1,addr2,...}`  
**Auth:** None required  
**Rate limits:** No documented limit; batch up to 30 addresses per call  
**Latency:** ~300–600ms per batch call

**What it provides:**
- Buy and sell transaction counts for 5m / 1h / 6h / 24h windows
- Price and price change percentages (5m / 1h / 6h / 24h)
- Volume (1h, 24h) in USD
- Liquidity in USD
- Market cap and FDV
- DEX identifier and pair address

**Derived signal: Order Flow (`flow_signal`)**

The buy/sell transaction count ratio over the last 1 hour is the primary signal. Transaction
count (not volume) is used because large single trades can distort volume while count reflects
the number of independent participants.

| flow_signal | buy_sell_ratio_1h | Meaning |
|---|---|---|
| strong_accumulation | ≥ 2.0 | Heavy net buying — multiple participants accumulating |
| accumulation | ≥ 1.4 | Net buying — confirms bullish thesis |
| neutral | 0.8 – 1.4 | Balanced flow — no directional signal |
| distribution | 0.5 – 0.8 | Net selling — weakening / exits underway |
| strong_distribution | < 0.5 | Heavy net selling — contradicts any long thesis |

**How it's used:**

*Entry (Scout):* Each newly-proposed candidate gets a live DexScreener lookup via
`enrichCandidateQuant()`. The `_dex_flow` object is attached to the candidate JSON so Risk
can apply the order flow gate (reject or require higher conviction when `flow_signal=distribution`).

*Exit (Harvest):* Held position addresses are batch-fetched at cycle start in
`buildCycleQuantContext()`. The `flow_signal` and `buy_sell_ratio_1h` appear directly in
the Harvest positionData payload, giving the LLM a real-time selling pressure indicator for
each held token.

*Price refresh:* DexScreener prices (when available) are used to overlay e3d.ai prices for
held positions, since DexScreener reflects real-time DEX state.

**Implementation notes:**
- Only Ethereum (`chainId: "ethereum"`) pairs are used
- When multiple pools exist for the same token, the most liquid is selected
- Capped at 5 story-enriched tokens fetched per cycle for Scout (beyond the held position batch)

---

### 2. Alternative.me Fear & Greed Index
**URL:** `https://api.alternative.me/fng/?limit=1`  
**Auth:** None required  
**Rate limits:** None documented; lightweight endpoint  
**Latency:** ~200ms

**What it provides:**
- A composite sentiment index value (0–100) updated daily
- A label: Extreme Fear / Fear / Neutral / Greed / Extreme Greed
- Based on: volatility, market momentum/volume, social media, surveys, dominance, trends

**Derived signal: Sentiment Regime**

| value | regime |
|---|---|
| 80–100 | extreme_greed |
| 60–79 | greed |
| 40–59 | neutral |
| 20–39 | fear |
| 0–19 | extreme_fear |

**How it's used:**

Combined with BTC 24h momentum to produce a unified `regime` label for the cycle. Fear &
Greed captures sentiment that price momentum alone misses — the most useful case is the
divergence: price rising while Fear & Greed is low signals a "wall of worry" rally (strong),
while price rising with extreme greed signals late-cycle / crowded (weak).

The `fear_greed.value` contributes to:
- `new_positions_ok` gate: `fgValue < 75 && btc24h > -4`
- `tighten_stops` signal: `fgValue > 75 || btc24h < -5`
- Unified regime calculation

---

### 3. CoinGecko Simple Price
**URL:** `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true`  
**Auth:** None required (anonymous tier)  
**Rate limits:** ~30 calls/minute on free tier  
**Latency:** ~400–800ms

**What it provides:**
- BTC and ETH spot price in USD
- 24-hour percentage change for both

**Derived signal: BTC Regime**

| btc_24h_pct | btc_regime |
|---|---|
| > +8% | euphoria |
| +4 to +8% | risk_on |
| +2 to +4% | mild_risk_on |
| –2 to +2% | neutral |
| –4 to –2% | cautious |
| –8 to –4% | risk_off |
| < –8% | crash |

Additional derived fields:
- `eth_outperforming_btc` — ETH 24h > BTC 24h (sector rotation signal)
- `new_positions_ok` — `btc24h > -4`
- `tighten_stops` — `btc24h < -5 || btc24h > 10`

**How it's used:**

BTC is the macro tide for all ETH tokens. A BTC crash (`btc24h < -8`) means almost no ETH
token will hold bids regardless of on-chain signals. `new_positions_ok=false` blocks new
entries. ETH outperforming BTC is a positive signal for the ecosystem (rotation into ETH).

---

### 4. Binance Perpetual Funding Rates
**URL:** `https://fapi.binance.com/fapi/v1/premiumIndex`  
**Auth:** None required  
**Rate limits:** Public endpoint; no practical limit for read  
**Latency:** ~300–500ms

**What it provides:**
- Mark price, index price, and current funding rate for every USDT perpetual contract
- One call returns ALL contracts (~300+ symbols) simultaneously

**Derived signal: Funding Rate Signal**

The funding rate (per 8h) reflects the balance of long vs short positioning in perpetual
futures. Longs pay shorts when positive; shorts pay longs when negative.

| signal | rate_per_8h | Meaning |
|---|---|---|
| overcrowded_long | > 0.1% | Longs paying heavy premium — too many longs, late entry |
| mild_long_bias | 0.05 – 0.1% | Slight long lean — normal in bull market |
| neutral | –0.03 – 0.05% | Balanced positioning |
| squeeze_potential | < –0.03% | Shorts crowded — short squeeze setup possible |

`avoid_new_longs: true` is set when `rate > 0.1%`.

**How it's used:**

*Entry (Scout):* Funding rate for a candidate token appears as `_funding_rate` on each
candidate. `overcrowded_long` triggers a SKIP rule — the trade is already crowded and late.
`squeeze_potential` is a positive signal (shorts may be forced to cover).

*Exit (Harvest):* `overcrowded_long` on a held position triggers a trim-on-rally
recommendation — reduce into strength before the crowd unwinds.

**Symbol mapping:**

A static `BINANCE_PERP_MAP` maps ~55 token symbols to their Binance USDT perp equivalents.
ETH-wrapped variants (WETH, wstETH, cbETH, rETH, stETH) are all mapped to ETHUSDT since
they track ETH pricing. The map covers major DeFi tokens (UNI, AAVE, CRV, SNX, COMP, etc.)
and L1/L2 tokens (SOL, AVAX, ARB, OP, INJ, etc.).

---

## Unified Macro Regime

The four sources are combined once per cycle into a single `macro` object:

```
regime = f(fear_greed.value, btc_24h_pct)
```

| Condition | regime |
|---|---|
| fear_greed ≥ 80 OR btc24h > 10% | extreme_greed |
| fear_greed ≥ 60 OR btc24h > 4% | greed |
| fear_greed ≤ 20 OR btc24h < –8% | extreme_fear |
| fear_greed ≤ 35 OR btc24h < –4% | fear |
| otherwise | neutral |

`new_positions_ok = fgValue < 75 && btc24h > -4`  
`tighten_stops = fgValue > 75 || btc24h < -5`

The regime is logged at cycle start and injected into both Scout and Harvest prompts.

---

## Agent Decision Framework Changes

### Scout (entry decisions)

**Entry Tier Ranking** (new):

| Tier | Criteria | Size |
|---|---|---|
| TIER 1 | E3D candidate/thesis + flow=accumulation or strong_accumulation + funding=neutral or squeeze | Full (1× risk_per_trade) |
| TIER 2 | Story signal (ACCUMULATION/SMART_MONEY/THESIS) + flow=neutral or better | Standard (0.75×) |
| TIER 3 | Story signal only, flow unknown | Small (0.5×) |
| SKIP | flow=distribution/strong_distribution without overwhelming story evidence OR funding=overcrowded_long | Reject |

**Macro gate:** When `new_positions_ok=false`, only TIER 1 setups with conviction ≥ 0.75 are
proposed.

### Harvest (exit decisions)

**New exit triggers from quant data:**
- `flow_signal=strong_distribution` on held position: lean toward trim unless hold-confirm story
- `funding_signal=overcrowded_long` on held position: trim on next 5–10% rally
- `unrealized_pnl_pct > 25%`: partial profit-take unless Tier 1 thesis and accumulation flow
- `unrealized_pnl_pct < -8%`: stop review; exit if thesis invalid
- `tighten_stops=true` (macro): take 25% partials on all positions > 15% gain

**Price data fix:** Harvest now receives live portfolio prices (refreshed by Scout's
DexScreener overlay) rather than the stale dossier prices. `unrealized_pnl_pct` is computed
from actual current price, not entry price.

### Risk (validation)

**New gates:**
- **Macro Gate:** Reject if `new_positions_ok=false` unless conviction ≥ 0.75 and E3D-grade signal
- **Funding Rate Gate:** Reject `overcrowded_long` candidates; return `wait` until funding normalises
- **Order Flow Gate:** Reject `distribution`/`strong_distribution` without conviction ≥ 0.80 + confirming ACCUMULATION/SMART_MONEY story

---

## API Call Budget per Cycle

| Source | Calls | Timing |
|---|---|---|
| DexScreener (held positions) | 1 batch call (up to 30 addrs) | Cycle start |
| Fear & Greed | 1 | Cycle start |
| CoinGecko | 1 | Cycle start |
| Binance premiumIndex | 1 | Cycle start |
| DexScreener (per Scout candidate) | 1 per candidate (≤ 3) | After Scout LLM returns |
| **Total** | **5–7 calls/cycle** | |

All calls are synchronous curl (matching the existing pipeline pattern). Total external quant
data fetch time is approximately 2–4 seconds per cycle.

---

## Implementation Files

| File | Role |
|---|---|
| `marketData.js` | New module — all external API calls and signal derivation |
| `pipeline.js` | Wiring: import, `_cycleQuantContext`, Scout/Harvest prompt injection, price refresh |
| `scout/TOOLS.md` | Agent instructions: tier ranking, flow/funding/macro signal tables |
| `harvest/TOOLS.md` | Agent instructions: exit signal tables, P&L thresholds, macro regime actions |
| `risk/TOOLS.md` | Agent instructions: macro gate, funding rate gate, order flow gate |

---

## What e3d.ai Could Provide Natively

If these signals were available directly from the e3d.ai API, the external dependencies could
be removed entirely. The most valuable additions would be:

### High priority

**Order flow endpoint**
```
GET /api/token-flow/{address}
```
Returns: `buy_tx_count_1h`, `sell_tx_count_1h`, `buy_sell_ratio_1h`, `flow_signal`, same for
5m, 6h, 24h windows. This is the highest-value signal — it's what DexScreener provides but
scoped to the tokens e3d.ai tracks.

**Per-position flow in portfolio context**
When the pipeline calls any portfolio or pricing endpoint, include the current `flow_signal`
and `buy_sell_ratio_1h` for each token in the response. This would eliminate the separate
DexScreener batch call.

### Medium priority

**Market regime endpoint**
```
GET /api/market-regime
```
Returns: `btc_price`, `btc_24h_pct`, `eth_24h_pct`, `fear_greed_value`, `regime`,
`new_positions_ok`, `tighten_stops`. Combines CoinGecko + Fear & Greed into a single
authoritative signal. e3d.ai already processes macro context for its stories — exposing it as
a dedicated endpoint would let agents query it without depending on two external providers.

**Funding rates in candidate/thesis objects**
Add `funding_rate_per_8h` and `funding_signal` fields to the `/candidates` and `/theses`
response objects for tokens that have Binance perp coverage. Risk agents currently have to
do a separate lookup; if it were pre-joined, the overcrowded_long gate could be applied without
any external call.

### Lower priority

**Batch order flow for universe**
```
GET /api/token-flow?addresses={addr1,addr2,...}
```
Same as the per-token endpoint but batched. Needed to enrich the full Scout token universe
(not just held positions) so that flow signals appear on all candidates, not just those the
pipeline happens to hold.
