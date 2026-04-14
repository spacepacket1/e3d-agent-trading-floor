# TOOLS.md — Harvest

Use WebFetch for all E3D data. Never execute transactions, place orders, or originate buy ideas.

## Base URL: https://e3d.ai/api

---

## Research Protocol

For each held position, run these steps in order. Exit triggers always take priority over hold signals.

### Step 1 — Immediate-exit sweep (check all held tokens against these first)

Fetch these market-wide risk stories and match against every held token address:

```
https://e3d.ai/api/stories?type=LIQUIDITY_DRAIN&chain=ETH&limit=20
https://e3d.ai/api/stories?type=RUG_LIQUIDITY_PULL&chain=ETH&limit=20
https://e3d.ai/api/stories?type=SPREAD_WIDENING&chain=ETH&limit=15
https://e3d.ai/api/stories?type=EXCHANGE_FLOW&chain=ETH&limit=20
https://e3d.ai/api/stories?type=MOMENTUM_DIVERGENCE&chain=ETH&limit=15
https://e3d.ai/api/stories?type=WASH_TRADE&chain=ETH&limit=20
https://e3d.ai/api/stories?type=LOOP&chain=ETH&limit=10
```

**Exit trigger interpretation:**
- `LIQUIDITY_DRAIN` on held token → **immediate exit candidate**: pool TVL is falling faster than price. Execution will worsen; exit before the pair becomes untradeable.
- `RUG_LIQUIDITY_PULL` on held token → **immediate exit**: LP being removed; rug-pull precursor.
- `SPREAD_WIDENING` on held token → **size down or exit**: slippage worsening while market still looks active; market-maker leaving.
- `EXCHANGE_FLOW` where `meta.direction = "deposits"` → **tighten risk**: net exchange deposits = sell pressure incoming. Treat as overlay on any long.
- `MOMENTUM_DIVERGENCE` on held token → **trim or monitor**: price up but on-chain fundamentals (user count, volume, TVL) are down. Classic late-move warning.
- `WASH_TRADE` on held token → **review and likely exit**: volume is manufactured; real liquidity is lower than it appears.
- `LOOP` on held token → **exit**: recycled circular flows detected; manipulation or fraud risk.

### Step 2 — Positioning risk sweep

```
https://e3d.ai/api/stories?type=CONCENTRATION_SHIFT&chain=ETH&limit=15
https://e3d.ai/api/stories?type=WHALE&chain=ETH&limit=10
https://e3d.ai/api/stories?type=VOLUME_PROFILE_ANOMALY&chain=ETH&limit=10
https://e3d.ai/api/stories?type=MIRROR&chain=ETH&limit=10
```

**Signal interpretation:**
- `CONCENTRATION_SHIFT` on held token where `meta.direction = "decreasing"` → insider/whale distribution; thesis is deteriorating
- `WHALE` on held token where `meta.net_flow.direction = "OUT"` → large holder distributing; exit pressure building
- `VOLUME_PROFILE_ANOMALY` on held token → unusual trading hours or size patterns; possible OTC distribution or new seller cohort
- `MIRROR` on held token → coordinated group activity; may signal bot-driven manipulation against the position

### Step 3 — Hold confirmation signals

These are reasons to hold or add confidence to a thesis:

```
https://e3d.ai/api/stories?type=ACCUMULATION&chain=ETH&limit=10
https://e3d.ai/api/stories?type=SMART_MONEY&chain=ETH&limit=10
https://e3d.ai/api/stories?type=EXCHANGE_FLOW&chain=ETH&limit=20
https://e3d.ai/api/stories?type=CONCENTRATION_SHIFT&chain=ETH&limit=15
```

**Hold signal interpretation:**
- `ACCUMULATION` on held token → whale still buying; thesis intact
- `SMART_MONEY` on held token → profitable wallets still accumulating; strong hold signal
- `EXCHANGE_FLOW` where `meta.direction = "withdrawals"` → net withdrawals from exchange = accumulation or self-custody; bullish
- `CONCENTRATION_SHIFT` where `meta.direction = "increasing"` → whale building more control; thesis strengthening

### Step 4 — Per-position deep research

For each held position, fetch live signals:

```
https://e3d.ai/api/stories?q={address}&scope=opportunity&limit=10
https://e3d.ai/api/stories?q={address}&scope=risk&limit=10
https://e3d.ai/api/tokenCounterparties?token={address}&limit=5
https://e3d.ai/api/addressCounterparties?address={address}&limit=5
```

Compare what you find against the pre-computed thesis scores in the context dossier. If live signals contradict the baseline, trust the live signals.

### Step 5 — Opportunity cost check

If recommending an exit, verify there is a better place for the capital:

```
https://e3d.ai/api/stories?type=BREAKOUT_CONFIRMED&chain=ETH&limit=5
https://e3d.ai/api/stories?type=ACCUMULATION&chain=ETH&limit=5
https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?dataSource=1&sortBy=change_30m_pct&sortDir=desc&limit=50
```

---

## Quant Exit Signals

Each cycle the pipeline injects live quant data into your context (`flow_signal`, `funding_signal`, macro regime). Use these alongside story signals:

### Order Flow Exit Signals (DexScreener `flow_signal` + `buy_sell_ratio_1h`)

| flow_signal | Meaning | Action |
|---|---|---|
| strong_distribution (ratio < 0.5) | Heavy selling — position bleeding | Trim or exit unless hold-confirm story overrides |
| distribution (ratio 0.5–0.8) | Net selling | Flag for monitor; trim if combined with weak thesis |
| neutral (ratio 0.8–1.4) | Balanced | Hold unless story signals say exit |
| accumulation (ratio 1.4–2.0) | Net buying into position | Hold; flow confirms thesis |
| strong_accumulation (ratio ≥ 2.0) | Heavy demand | Hold; ignore minor story noise |

### Funding Rate Exit Signals (Binance perpetuals `funding_signal`)

| signal | Meaning | Action |
|---|---|---|
| overcrowded_long | Too many longs open — crowded trade | Trim on next 5–10% rally; tighten stop |
| mild_long_bias | Slight long tilt | Normal; monitor |
| neutral | Balanced positioning | Hold or exit based on story |
| squeeze_potential | Shorts crowded — squeeze risk | Hold or add; squeeze can gap price up |

### Macro Regime Context (`regime`, `tighten_stops`)

| Condition | Action |
|---|---|
| tighten_stops=true | Take partial profits on positions > 15% gain; tighten all stops to –5% |
| regime=extreme_greed | Scale back on crowded longs; lock in gains selectively |
| regime=fear or extreme_fear | Only exit confirmed deteriorating positions; do not panic-sell healthy thesis |
| regime=neutral | Standard exit criteria apply |

### P&L Thresholds (positions report real `unrealized_pnl_pct` this cycle)

| P&L | Action |
|---|---|
| > +25% gain | Consider 25–50% partial profit-take unless Tier 1 thesis and strong accumulation flow |
| > +15% gain + tighten_stops=true | Take 25% partial profits |
| < –8% loss | Review stop; exit if thesis is invalid and no recovery signal present |
| < –15% loss | Exit unless extraordinary recovery evidence |

## Decision Framework

| Signals on held token | Recommended action |
|---|---|
| LIQUIDITY_DRAIN or RUG_LIQUIDITY_PULL | exit (immediate) |
| LOOP or WASH_TRADE | exit |
| SPREAD_WIDENING + flow=distribution | exit |
| SPREAD_WIDENING alone | trim |
| EXCHANGE_FLOW net deposits + MOMENTUM_DIVERGENCE | trim |
| flow=strong_distribution + no hold-confirm story | trim |
| funding=overcrowded_long + pnl > +15% | trim on rally |
| CONCENTRATION_SHIFT decreasing + WHALE OUT | trim / monitor |
| VOLUME_PROFILE_ANOMALY or MIRROR | monitor (increase scrutiny) |
| flow=distribution + pnl < –5% | monitor; tighten stop |
| ACCUMULATION + SMART_MONEY + flow=accumulation | hold strong |
| ACCUMULATION + SMART_MONEY continuing | hold |
| funding=squeeze_potential | hold; do not exit into short squeeze |
| EXCHANGE_FLOW withdrawals | hold |
| flow=strong_accumulation + no exit story | hold |
| No negative signals, thesis metrics stable | hold |

---

## Market Context

```
https://e3d.ai/api/stories?type=ECOSYSTEM_SHIFT&chain=ETH&limit=5
https://e3d.ai/api/stories?type=CATEGORY&chain=ETH&limit=5
https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?dataSource=1&sortBy=change_30m_pct&sortDir=asc&limit=50
```

Use ECOSYSTEM_SHIFT and CATEGORY for macro context when the whole portfolio needs repositioning.

---

## Token Lookup

```
https://e3d.ai/api/addressMeta?address={address}
https://e3d.ai/api/token-info/{address}
https://e3d.ai/api/fetchTokensDB?dataSource=1&search={symbol}&limit=10&offset=0
https://e3d.ai/api/fetchTransactionsDB?dataSource=1&search={address}&limit=25
https://e3d.ai/api/tokenCounterparties?token={address}&limit=5
```
