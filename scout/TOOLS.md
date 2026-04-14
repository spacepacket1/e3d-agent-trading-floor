# TOOLS.md — Scout

Use WebFetch for all E3D data. Never execute transactions or mutate state.

## Base URL: https://e3d.ai/api

---

## Research Protocol

Run these steps in order. Stop early if disqualifiers fire.

### Step 1 — Disqualifier sweep (run first, costs nothing to skip bad tokens early)

Fetch these market-wide risk stories and build a disqualified-address set before evaluating any candidate:

```
https://e3d.ai/api/stories?type=WASH_TRADE&chain=ETH&limit=20
https://e3d.ai/api/stories?type=LOOP&chain=ETH&limit=10
https://e3d.ai/api/stories?type=LIQUIDITY_DRAIN&chain=ETH&limit=20
https://e3d.ai/api/stories?type=SPREAD_WIDENING&chain=ETH&limit=15
https://e3d.ai/api/stories?type=MOMENTUM_DIVERGENCE&chain=ETH&limit=15
https://e3d.ai/api/stories?type=EXCHANGE_FLOW&chain=ETH&limit=20
```

**Disqualify any token whose address appears in:**
- `WASH_TRADE` — volume is manufactured; not investable
- `LOOP` — recycled circular flows; manipulation fingerprint
- `LIQUIDITY_DRAIN` — pool TVL is collapsing; execution risk
- `SPREAD_WIDENING` — slippage worsening faster than activity justifies; skip or note as high risk
- `MOMENTUM_DIVERGENCE` — price rising while on-chain fundamentals fall; late-move warning, avoid
- `EXCHANGE_FLOW` where `meta.direction = "deposits"` — net deposits to exchange = sell pressure incoming

### Step 2 — Buy signal discovery (run in parallel after disqualifier sweep)

These are the highest-value buy signals. Fetch all of them:

```
https://e3d.ai/api/stories?type=ACCUMULATION&chain=ETH&limit=10
https://e3d.ai/api/stories?type=SMART_MONEY&chain=ETH&limit=10
https://e3d.ai/api/stories?type=STEALTH_ACCUMULATION&chain=ETH&limit=10
https://e3d.ai/api/stories?type=BREAKOUT_CONFIRMED&chain=ETH&limit=5
https://e3d.ai/api/stories?type=MOVER&chain=ETH&limit=15
https://e3d.ai/api/stories?type=SURGE&chain=ETH&limit=10
```

**Signal interpretation:**
- `ACCUMULATION` — single whale net-buying at scale. Strong directional buy signal. Check `meta.net_flow.usd_net` for size and `meta.whale.historical_exit_count` for track record. Prefer whales with history over unknown wallets.
- `SMART_MONEY` — historically profitable wallets converging on the same token. 3+ wallets in 24h = high-priority. Check `meta.buyer_count` and `meta.avg_win_rate`.
- `STEALTH_ACCUMULATION` — many small buys summing to a large coordinated position. Whale hiding size. Check `meta.aggregate_usd` and `meta.buyer_count`.
- `BREAKOUT_CONFIRMED` — MOVER + SURGE both fired on the same token. Higher conviction than either alone. Check `meta.confirmation_quality`: prefer "broad participation" over "mixed".
- `MOVER` — multi-timeframe price breakout. Check `meta.score` (higher = stronger) and `meta.narrative_hint` for the price change magnitude.
- `SURGE` — price spike + on-chain activity. ONLY useful if `meta.participation_type = "broad participation"`. Ignore "thin-liquidity spike" — it's noise.

### Step 3 — Opportunity discovery (secondary signals)

```
https://e3d.ai/api/stories?type=CONCENTRATION_SHIFT&chain=ETH&limit=10
https://e3d.ai/api/stories?type=INSIDER_TIMING&chain=ETH&limit=10
https://e3d.ai/api/stories?type=HOTLINKS&chain=ETH&limit=15
https://e3d.ai/api/stories?type=TOKEN_QUALITY_SCORE&chain=ETH&limit=10
https://e3d.ai/api/stories?type=FUNNEL&chain=ETH&limit=10
https://e3d.ai/api/stories?type=WHALE&chain=ETH&limit=10
https://e3d.ai/api/stories?type=ECOSYSTEM_SHIFT&chain=ETH&limit=5
https://e3d.ai/api/stories?type=CATEGORY&chain=ETH&limit=5
```

**Signal interpretation:**
- `CONCENTRATION_SHIFT` — check `meta.direction`: "increasing" = whale building control (watch); "decreasing" = distribution (disqualify)
- `INSIDER_TIMING` — wallets bought before a major event. Strong watchlist trigger. Check `meta.pre_event_buyer_count`.
- `HOTLINKS` — unusual tx activity burst. "something is happening here" signal. Needs per-token story check to confirm intent.
- `TOKEN_QUALITY_SCORE` — composite first-pass score for new/unfamiliar tokens. Use to rank unknowns before spending research time.
- `FUNNEL` — check subtitle: "staging" = smart money pre-positioning (bullish); "infra" = infrastructure/routing (neutral/ignore)
- `WHALE` — check `meta.net_flow.direction`: "IN" + non-stablecoin token = accumulation signal; "OUT" = distribution (disqualify)
- `ECOSYSTEM_SHIFT` — macro chain-level rotation. Use for sector context, not single-token decisions.
- `CATEGORY` — sector momentum. If a category is rotating in, find the leaders.

### Step 0 — E3D agent candidates and theses (check before running story sweeps)

These are pre-computed by the E3D agent system and represent the strongest multi-signal convergence:

```
https://e3d.ai/api/candidates?status=new,promoted&limit=25
https://e3d.ai/api/theses?status=active&limit=25
```

- `candidates` — tokens where multiple story types have converged across time. Fields: `convergence_score`, `signal_count`, `story_types`, `direction_hint`, `signal_summary`, `thesis_conviction`, `fraud_risk`, `liquidity_quality`. Use as your **primary** candidate source.
- `theses` — structured investment theses with `direction` (LONG/SHORT/AVOID), `conviction`, `target_1/2/3`, `invalidation_price`, `fraud_risk`. A LONG thesis with conviction ≥ 60 is a strong buy signal.

If E3D candidates map to tokens in your universe, prioritise them before running the full story sweep below.

### Step 4 — Per-token deep research

For each surviving candidate (not disqualified), fetch:

```
https://e3d.ai/api/stories?q={address}&scope=opportunity&limit=10
https://e3d.ai/api/token-info/{address}
https://e3d.ai/api/tokenCounterparties?token={address}&limit=5
```

Also verify the token is not in the SANDWICH feed (execution risk at this venue):
```
https://e3d.ai/api/stories?type=SANDWICH&chain=ETH&limit=20
```
Note in the candidate's `risks[]` if it appears there — executor will handle routing.

### Step 5 — Market context

```
https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?dataSource=1&sortBy=change_30m_pct&sortDir=desc&limit=50
https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?dataSource=1&sortBy=change_24H&sortDir=desc&limit=50
```

Price API returns `changes["30M"].percent` and `changes["24H"].percent` in nested format.

---

## Quant Signal Integration

Each cycle the pipeline injects live quant data into your context. Use it to rank and gate candidates:

### Order Flow Signals (DexScreener — injected as `flow_signal` on tokens)

| flow_signal | buy_sell_ratio_1h | Meaning | Action |
|---|---|---|---|
| strong_accumulation | ≥ 2.0 | Heavy buying pressure | Confirms buy thesis — TIER 1 eligible |
| accumulation | ≥ 1.4 | Net buying | Supports buy thesis — TIER 2 eligible |
| neutral | 0.8 – 1.4 | Balanced flow | Neutral — use other signals to decide |
| distribution | 0.5 – 0.8 | Net selling | Contradicts buy thesis — skip unless overwhelming story |
| strong_distribution | < 0.5 | Heavy selling | Hard skip — wait for flow reversal |

### Funding Rate Signals (Binance perpetuals — injected as `_funding_rate`)

| signal | rate_per_8h | Meaning | Action |
|---|---|---|---|
| overcrowded_long | > 0.1% | Too many longs — crowded trade | Skip new entries; late to the trade |
| mild_long_bias | 0.05–0.1% | Slight long tilt | Proceed with normal sizing |
| neutral | -0.03 – 0.05% | Balanced positioning | Full size OK |
| squeeze_potential | < -0.03% | Shorts crowded | Positive signal — squeeze may lift price |

### Macro Regime Gate (injected as `new_positions_ok`, `regime`, `tighten_stops`)

- `new_positions_ok=false` (regime=fear/extreme_fear or BTC down > 4%): **only propose TIER 1 setups with conviction ≥ 0.75**
- `tighten_stops=true` (extreme greed or BTC up > 10%): **size down 30%, note in risks[]**
- Normal regime: proceed with standard sizing

### Entry Tier Ranking

| Tier | Criteria | Size |
|---|---|---|
| TIER 1 | E3D candidate/thesis + flow=accumulation/strong_accumulation + funding=neutral/squeeze | Full (1× risk_per_trade) |
| TIER 2 | Story signal (ACCUMULATION/SMART_MONEY/THESIS) + flow=neutral or better | Standard (0.75×) |
| TIER 3 | Story signal only, flow unknown | Small (0.5×) |
| SKIP | flow=distribution/strong_distribution without overwhelming story evidence OR funding=overcrowded_long | Do not propose |

## High-Conviction Combo Signals

These multi-story + quant combinations are the strongest buy signals:

| Combo | Interpretation |
|---|---|
| ACCUMULATION + BREAKOUT_CONFIRMED + flow=strong_accumulation | Structural buy + price + order flow triple confirmation |
| SMART_MONEY (3+) + STEALTH_ACCUMULATION + funding=squeeze_potential | Smart wallets + hidden size + short-squeeze fuel |
| E3D candidate (convergence_score > 0.7) + flow=accumulation | E3D multi-signal + live order flow confirmation |
| MOVER + SURGE (broad) + flow=accumulation | Price + activity + sustained buying pressure |
| TOKEN_QUALITY_SCORE high + SMART_MONEY + funding=neutral | Quality new token + smart wallets + not crowded |
| INSIDER_TIMING + FUNNEL (staging) | Pre-event buying + capital staging = high-conviction setup |

---

## Token Search

```
https://e3d.ai/api/fetchTokensDB?dataSource=1&search={symbol}&limit=10&offset=0
https://e3d.ai/api/addressMeta?address={address}
https://e3d.ai/api/fetchTransactionsDB?dataSource=1&search={address}&limit=25
https://e3d.ai/api/tokenCounterparties?token={address}&limit=5
```

---

## Output Requirements

For every candidate, set real values from your research:
- `entry_zone.low` / `entry_zone.high` — bracket around current price
- `invalidation_price` — key support level or current_price × 0.92
- `targets.target_1` — +15% from entry; `target_2` — +30%; `target_3` — +50% (adjust to evidence)
- `evidence[]` — cite which story types fired and what they showed
- `risks[]` — cite any SANDWICH, SPREAD_WIDENING, or token-specific risks found
- `confidence` / `conviction_score` / `opportunity_score` — use real story signal counts and quality, not placeholder zeros

Return candidates with any positive signal stack — Risk filters; your job is discovery.
Only return `candidates: []` if zero tokens survived the disqualifier sweep with any buy signal.
