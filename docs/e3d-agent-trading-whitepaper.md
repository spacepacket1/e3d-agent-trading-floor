# E3D Agent Trading Floor — Whitepaper

**April 2026**

---

## Abstract

The E3D Agent Trading Floor is a multi-agent, AI-assisted portfolio management system built on on-chain intelligence from E3D.ai. It operates a continuous cycle of discovery, evaluation, risk validation, and execution — entirely in paper mode until explicitly enabled for live trading. Five specialized LLM agents collaborate inside a deterministic pipeline: Scout discovers opportunities, Harvest manages exits, Risk enforces hard constraints, Executor records trades, and Manager evaluates the cycle after the fact. No agent can unilaterally move capital. Every decision passes through deterministic code before any action is taken.

The system's core thesis is that on-chain story signals — patterns detected in wallet behavior, token flows, and market microstructure — fire *before* price moves. By anchoring the token universe entirely to story-backed tokens and sorting by freshness of signal activity, the pipeline concentrates attention on the pre-pump window rather than reacting to moves already in progress.

---

## 1. Design Philosophy

**AI suggests. Code decides.**

LLM agents produce structured JSON proposals. Deterministic pipeline code validates every field, enforces hard limits, and executes or rejects. The LLM never writes directly to the portfolio. This separation ensures that hallucinations, prompt injection, or model degradation cannot cause unauthorized trades.

**Story-first, not price-first.**

The token universe presented to Scout is filtered to tokens with active story coverage only. Tokens with no on-chain story activity are excluded regardless of their volume or price momentum. This prevents the agents from chasing already-moved assets and forces attention toward tokens where on-chain evidence of pre-pump activity exists.

**Evidence chains, not guesses.**

Every Scout candidate must include `evidence[]`, `why_now`, `risks[]`, `conviction_score`, entry zone, invalidation price, and price targets. Every Harvest exit must include evidence items and a suggested exit fraction. Undocumented decisions are invalid.

**Fail safely.**

Paper mode is the default. All trade tickets are recorded as paper trades. Live execution requires an explicit configuration change. Within paper mode, all portfolio state mutations are real — the P&L tracking, position sizing, cooldowns, and rotation logic all function as they would in live trading. The only thing missing is actual order submission.

---

## 2. System Architecture

```
E3D.ai API            External Quant Sources
(stories, candidates,  (DexScreener, CoinGecko,
 theses, token prices)  Fear&Greed, Binance Funding)
         │                        │
         └──────────┬─────────────┘
                    │
              CYCLE START
              (macro context fetched)
                    │
                 SCOUT
              (token universe + story signals → 0–3 candidates)
                    │
            UPDATE HOLDINGS
              (price refresh, holdings sync)
                    │
            HARD SELL CHECKS
              (stop-loss, fraud breach, target hits)
                    │
                 HARVEST
              (held positions → hold / monitor / trim / exit)
                    │
                  RISK
              (hard-limit validation, quant gates)
                    │
          PORTFOLIO ENGINE
              (deterministic: ranking, rotation, allocation)
                    │
               EXECUTOR
              (paper trade ticket or live order)
                    │
              CYCLE END
              (stats, training event logged)
                    │
                MANAGER
              (post-cycle evaluation, grade, flags, report)
```

The pipeline runs on a configurable interval (default: every few minutes). Each cycle is identified by a UUID and logged append-only to `pipeline.jsonl` and optionally to ClickHouse for training data retention.

---

## 3. Token Universe

### 3.1 Story-First Filtering

The token universe presented to Scout each cycle is not a static list of high-volume tokens. It is dynamically assembled from on-chain story activity and filtered to contain only tokens with at least one active story.

**Primary fetch:** `/fetchTokenPricesWithHistoryAllRanges` sorted by `storyCount descending, trendInterval=1H`. Tokens with the most story activity in the last hour rank first. This surfaces the freshest signals — the pre-pump window — before volume rankings reflect the move.

**Story enrichment:** Any token mentioned in a buy-signal or pre-pump story type that is not already in the volume feed is fetched individually and added to the universe. There is no cap on the number of story-enriched tokens. Story types that trigger enrichment:

| Category | Types |
|---|---|
| Pre-pump (alpha window) | STAGING, CLUSTER, FUNNEL, NEW_WALLETS, ACCUMULATION, SMART_MONEY, STEALTH_ACCUMULATION, DEEP_DIVE, SMART_STAGING, WHALE, DISCOVERY, HOTLINKS |
| Breakout | BREAKOUT_CONFIRMED, FLOW |
| Thesis-driven | THESIS |

**Story-address filter:** After enrichment, the universe is filtered to retain only tokens whose contract address appears in at least one story from the current cycle. Tokens with no story coverage are excluded.

**Result:** Scout is shown a universe of tokens ranked by freshness of on-chain signal activity, where every token has at least one piece of on-chain evidence behind it.

### 3.2 Token Fields

Each token in the universe carries:

- `symbol`, `address`, `price_usd`, `change_24h`, `market_cap_usd`
- `liquidity_usd` (effective DEX depth)
- `volume_24h_usd`
- `story_count_1h` — number of stories fired on this token in the last hour
- `flow_signal` — derived from DexScreener order flow (see §6.1)
- `buy_sell_ratio_1h` — raw ratio from DexScreener

### 3.3 E3D Candidates and Theses

In addition to the story-filtered universe, Scout receives two higher-signal feeds each cycle:

- **`/candidates`** — pre-computed multi-signal convergence candidates from the E3D agent system. These are tokens where multiple story types have converged. Highest priority.
- **`/theses`** — structured investment theses with direction, conviction score, and price targets. A LONG thesis with conviction ≥ 65 can override the `in_token_universe` gate — Scout may propose it even if the token is absent from the volume feed.

---

## 4. The Five Agents

### 4.1 Scout

**Role:** Discovery. Scout identifies 0–3 buy candidates per cycle from the assembled token universe and story signals.

**Signal priority (hardcoded in prompt):**

1. E3D agent candidates (multi-story convergence — strongest signal)
2. E3D theses (LONG, conviction ≥ 65)
3. THESIS-type stories with `in_token_universe=true`
4. Buy-signal stories (ACCUMULATION, SMART_MONEY, BREAKOUT_CONFIRMED, etc.) with `in_token_universe=true`
5. Flow-only (absolute last resort — only when all above are empty, and buy/sell ratio ≥ 3.5, liquidity > $150k, volume > $75k, mcap > $5M)

**Signal timing classification:**

- **PRE-PUMP** (buy here): STAGING, CLUSTER, FUNNEL, NEW_WALLETS, ACCUMULATION, SMART_MONEY, STEALTH_ACCUMULATION, DEEP_DIVE, THESIS. Fire before price moves.
- **BREAKOUT** (early-mid, still valid): BREAKOUT_CONFIRMED, FLOW. Price moving but momentum fresh.
- **POST-PUMP** (do not buy): MOVER, SURGE. Move already happened. Shown to Scout as LATE SIGNALS only.
- **DISQUALIFIERS** (exclude token): WASH_TRADE, LOOP, LIQUIDITY_DRAIN, SPREAD_WIDENING, RUG_LIQUIDITY_PULL.

**Entry tiers:**

| Tier | Criteria | Allocation |
|---|---|---|
| TIER 1 | E3D candidate or thesis (conviction ≥ 0.75) + liquidity > $500k + volume > $100k | Full (1× risk_per_trade) |
| TIER 2 | Story signal + in_token_universe=true + liquidity > $200k + volume > $50k | Standard (0.75×) |
| FLOW-ONLY | No E3D signal — buy/sell ratio ≥ 3.5, liq > $150k, vol > $75k, mcap > $5M — max 1 pick | Small (0.5×) |

**Output shape:**
```json
{
  "scan_timestamp": "ISO8601",
  "candidates": [
    {
      "token": { "symbol": "...", "contract_address": "0x...", "chain": "ETH" },
      "setup_type": "pre_pump_accumulation",
      "action": "buy",
      "confidence": 0.78,
      "conviction_score": 0.72,
      "why_now": "...",
      "evidence": ["..."],
      "risks": ["..."],
      "entry_zone": { "low": 0.042, "high": 0.047 },
      "invalidation_price": 0.038,
      "targets": { "target_1": 0.065, "target_2": 0.085, "target_3": 0.12 }
    }
  ],
  "holdings_updates": [],
  "stories_checked": [{ "type": "ACCUMULATION", "found": 2, "tokens": ["0x..."] }]
}
```

Returning 0 candidates is correct when nothing meets the bar. The pipeline survives skipped cycles without degradation.

---

### 4.2 Harvest

**Role:** Capital protection. Harvest reviews every held position each cycle and decides whether to hold, monitor, trim, or exit.

**What Harvest evaluates per position:**

- Current unrealized P&L (refreshed from live DexScreener prices)
- Whether the original story is still active (story age and freshness)
- Whether new stories confirm or contradict the thesis
- Order flow signal (accumulation vs distribution)
- Binance funding rate on perpetuals (overcrowded longs → trim into strength)
- Time held vs score decay (positions accumulate a decay penalty per day held)

**Exit triggers:**

| Trigger | Action |
|---|---|
| MOVER or SURGE story + declining price | Exit — pump exhaustion |
| `flow_signal = strong_distribution` without hold-confirm story | Trim or exit |
| `funding_signal = overcrowded_long` on held position | Trim on next 5–10% rally |
| `unrealized_pnl_pct > 25%` | Partial profit-take unless TIER 1 thesis active |
| `unrealized_pnl_pct < -8%` + thesis invalid | Stop loss exit |
| `tighten_stops = true` (macro gate) | Take 25% partials on all positions > 15% gain |
| Story expired, no new signal for 3+ cycles | Monitor → exit if no catalyst emerges |

**Hold-confirm signals** (Harvest should not exit when these are present):

ACCUMULATION, SMART_MONEY, STAGING, CLUSTER — these indicate the original setup is still in play.

---

### 4.3 Risk

**Role:** Hard-limit enforcement. Risk validates every Scout candidate against deterministic rules before any capital is committed.

Risk runs independently of both the LLM and portfolio state. Its decisions are logged as training events regardless of outcome.

**Hard limits (always enforced):**

- `fraud_risk ≥ 35` → reject
- `confidence ≤ 55` → reject
- Token already held → reject
- Token in cooldown (12h after exit) → reject
- Category exposure at cap (30%) → reject
- Max open positions (8) reached → reject

**Quant gates:**

- **Macro gate:** Reject if `new_positions_ok = false` (BTC down > 4% or Fear & Greed > 75) unless conviction ≥ 0.75 and E3D-grade signal
- **Funding rate gate:** Reject `overcrowded_long` candidates
- **Order flow gate:** Reject `distribution` or `strong_distribution` flow without conviction ≥ 0.80 + confirming ACCUMULATION or SMART_MONEY story

**Output:** Each candidate receives a `risk_decision` event — `approve`, `reject`, or `approve_for_executor`. In paper mode, `approve_for_executor` is never emitted.

---

### 4.4 Executor

**Role:** Trade recording. Executor receives Risk-approved candidates and records paper trade tickets or, when enabled, submits live orders.

**Paper mode behavior:**

Every approved candidate produces a `paper_trade_ticket` with symbol, size, price, and timestamp. The ticket is logged as a training event. `live_execution_allowed` is always false in paper mode — the flag is checked in code, not just in the prompt.

**Output shape per decision:**
```json
{
  "symbol": "TOKEN",
  "decision": "paper_trade",
  "paper_trade_ticket": {
    "symbol": "TOKEN",
    "size_usd": 1500,
    "price": 0.044,
    "timestamp": "ISO8601"
  },
  "follow_up_action": "monitor_for_entry_confirmation",
  "live_execution_allowed": false,
  "blocker_list": []
}
```

---

### 4.5 Manager

**Role:** Post-cycle evaluation. Manager runs after `cycle_end` and produces a structured report grading each agent's performance. It does not trade, propose candidates, or influence live decisions. Its job is to observe and report.

**What Manager evaluates:**

| Agent | Key dimensions |
|---|---|
| Scout | Story coverage %, candidate evidence depth, disqualifier sweep completeness, LLM health |
| Harvest | Position review completeness, exit rationale quality, conservative bias |
| Risk | Decision completeness, hard limit enforcement rate, approval rate health |
| Executor | Decision completeness, paper ticket validity |
| Pipeline | Cycle duration, LLM errors, API error rate, equity delta |

**Scoring:**

Each agent starts at 100. Deductions: critical flag = −20, warning = −8, info = −2.

Overall cycle score: `scout×0.25 + harvest×0.25 + risk×0.25 + executor×0.15 + pipeline×0.10`

**Grade scale:** A (90–100), B (75–89), C (60–74), D (45–59), F (<45)

**Report output:** JSON written to `reports/cycle-YYYYMMDD-HHMMSS-{cycle_id_short}.json`. Available via REST API and displayed on the dashboard Reports page.

---

## 5. Portfolio Engine

The Portfolio Engine is deterministic — no LLM involved. It runs after Risk approval and manages all capital allocation.

**Position sizing:**

```
allocation_usd = equity_usd × risk_per_trade_pct   (default: 1.5%)
allocation_usd = min(allocation_usd, equity_usd × max_position_pct)   (cap: 10%)
allocation_usd = max(allocation_usd, min_trade_usd)   (floor: $250)
```

TIER 1 candidates receive 1× allocation. TIER 2 receives 0.75×. Flow-only receives 0.5×.

**Rotation logic:**

If `best_candidate_score − weakest_position_score ≥ rotation_threshold (10)`, the engine rotates: sell 50% of the weakest position and apply proceeds to the new candidate. Max one rotation per cycle.

**Score formula:**

```
score = opportunity_score
      + conviction_score × 0.5
      + liquidity_quality × 0.3
      − fraud_risk × 0.7
      − age_decay_per_day × days_held
```

Age decay (default: 0.75/day) ensures positions don't sit indefinitely on stale theses. A position held 5 days loses 3.75 score points regardless of market conditions.

**Hard sell triggers (deterministic, no LLM):**

- Stop loss: position drops below `invalidation_price` set at entry
- Fraud risk breach: `fraud_risk ≥ 35` after entry
- Target hit: price reaches `target_1`, `target_2`, or `target_3`
- Category cap breach: category exposure exceeds 30%

---

## 6. External Data Sources

Four external sources are fetched once per cycle at cycle start and injected into all agent prompts.

### 6.1 DexScreener — Order Flow

Real-time DEX transaction data. Buy and sell counts over 1h are used to compute `buy_sell_ratio_1h`.

| Signal | Ratio | Meaning |
|---|---|---|
| strong_accumulation | ≥ 2.0 | Heavy net buying |
| accumulation | ≥ 1.4 | Net buying — confirms bullish thesis |
| neutral | 0.8–1.4 | Balanced flow |
| distribution | 0.5–0.8 | Net selling — weakening |
| strong_distribution | < 0.5 | Heavy net selling — contradicts long thesis |

Transaction *count* (not volume) is used because single large trades can distort volume while count reflects the number of independent participants.

### 6.2 Alternative.me Fear & Greed Index

Daily composite sentiment index (0–100). Combined with BTC momentum to produce the unified macro regime.

- `new_positions_ok = false` when Fear & Greed > 75 or BTC 24h < −4%
- `tighten_stops = true` when Fear & Greed > 75 or BTC 24h < −5%

The most useful case is divergence: rising prices during fear signals a "wall of worry" rally (strong). Rising prices during extreme greed signals late-cycle crowding (weak).

### 6.3 CoinGecko — BTC/ETH Macro

BTC and ETH spot price and 24h change. BTC is the macro tide for all ETH tokens. A BTC crash (`btc24h < −8%`) blocks all new entries regardless of on-chain signals. ETH outperforming BTC is a positive signal for the ecosystem.

### 6.4 Binance Perpetual Funding Rates

Per-8h funding rates for ~300 USDT perpetual contracts, fetched in a single call.

| Signal | Rate/8h | Meaning |
|---|---|---|
| overcrowded_long | > 0.1% | Too many longs — late entry, crowded |
| mild_long_bias | 0.05–0.1% | Normal bull market lean |
| neutral | −0.03–0.05% | Balanced positioning |
| squeeze_potential | < −0.03% | Short squeeze setup |

`overcrowded_long` blocks new entries and triggers trim-on-rally for held positions.

### 6.5 Unified Macro Regime

The four sources combine into a single `regime` label injected into all prompts:

| Condition | Regime |
|---|---|
| Fear & Greed ≥ 80 or BTC 24h > 10% | extreme_greed |
| Fear & Greed ≥ 60 or BTC 24h > 4% | greed |
| otherwise | neutral |
| Fear & Greed ≤ 35 or BTC 24h < −4% | fear |
| Fear & Greed ≤ 20 or BTC 24h < −8% | extreme_fear |

---

## 7. Training Pipeline

The system includes a continuous learning infrastructure designed to internalize trading rules into fine-tuned LoRA adapters, reducing prompt length and improving decision consistency.

### 7.1 Motivation

Scout's system prompt currently runs ~5,000 tokens of rules. Harvest adds ~3,000. These rules are re-read from scratch every cycle. A fine-tuned model that has internalized the rules needs only a short task prompt and live market data — rules become implicit.

Combined savings: ~6,700 tokens/cycle. At 288 cycles/day, this recovers ~80 seconds of cycle time per iteration and significantly reduces inference cost.

### 7.2 Two Adapters

| | Scout | Harvest |
|---|---|---|
| Task | Entry decision making | Exit decision making |
| Adapter | `adapters_scout_v1` | `adapters_harvest_v1` |
| LoRA rank | 8 | 8 |
| Sequence length | 2048 | 2048 |
| Training data | Synthetic rules + pipeline outcomes + risk rejections | Synthetic rules + position trajectory outcomes + pump exhaustion examples |

### 7.3 Training Data Sources

**Source A — Synthetic rule examples:** Hand-crafted examples encoding the decision rules in isolation. ~300–500 examples per agent. Include story_count_1h signals, the story-only universe filter behavior, all pre-pump story type combinations, and FLOW-ONLY threshold logic. Regenerated when rules change.

**Source B — Pipeline cycle outcomes:** Real cycle data from `pipeline.jsonl`. Scout examples are labeled by whether the proposal was risk-approved and whether the position was profitable at close. Harvest examples are labeled by whether the hold/exit decision was validated by subsequent price movement.

**Source C — High-signal failure examples:** Risk rejections (Scout) and pump exhaustion holds (Harvest) are extracted as additional negative examples. These represent the highest-priority failure modes to avoid.

### 7.4 Training Schedule

Weekly retraining, Sunday 3AM. Each run: extract data → validate count → back up current adapter → train → evaluate on held-out test set → deploy if loss improved, restore backup if not.

---

## 8. Observability

### 8.1 Pipeline Log

Every event is appended to `logs/pipeline.jsonl` as a structured JSON record with timestamp, stage, and data. Key stages: `cycle_start`, `scout`, `harvest`, `risk_approved`, `risk_rejected`, `executor_decision`, `buy_trades`, `sell_trades`, `stats`, `cycle_end`, `manager_report`.

### 8.2 Training Events

High-value decision events are written to a separate `training-events.jsonl` and optionally to ClickHouse for analytics. Schema version is stamped on every record.

### 8.3 Dashboard

A real-time web dashboard at `http://localhost:3000` provides:

- **Portfolio** — positions, P&L, allocation, price display with subscript notation for micro-cap tokens
- **Activity** — cycle cards showing story signals, candidates considered, candidates proposed, harvest actions, and the full token universe shown to Scout
- **Reports** — Manager Agent cycle grades, flag codes, per-agent scores, portfolio snapshot
- **Settings** — pipeline control, paper mode toggle, interval configuration

### 8.4 Manager Reports

After each cycle, the Manager Agent produces a graded report with:

- Overall cycle score and grade (A–F)
- Per-agent scores and flags (critical / warning / info)
- Pipeline health metrics (cycle duration, LLM errors, API error rate)
- Portfolio snapshot (equity, cash, positions, realized/unrealized P&L)
- Actions taken (buys, sells, rotations)

---

## 9. Safety Model

| Layer | Mechanism |
|---|---|
| LLM isolation | Agents produce JSON proposals only. No direct access to portfolio state or trade execution. |
| Hard limits | Fraud risk, confidence, position size, category cap — enforced in deterministic code, not prompt. |
| Paper mode | Default. `live_execution_allowed = false` is a code-level flag, not a prompt instruction. |
| Cooldowns | 12-hour cooldown after exiting a position. Prevents re-entry into a token that just failed. |
| Age decay | Score penalty accumulates per day held. Forces active re-evaluation of stale positions. |
| Pump filter | Hard filter in code: any candidate with 7-day CoinGecko gain > 300% is discarded before Risk sees it. |
| Manager audit | Post-cycle evaluation catches enforcement failures (e.g. Risk approving a fraud-risk candidate). |
| Adapter regression check | New LoRA adapters must improve eval loss over the previous adapter before deployment. |

---

## 10. Current Status

The system is running in paper mode with a portfolio of $100,000 initial capital. All five agents are operational. The token universe is story-filtered and sorted by 1-hour story count. The Manager Agent grades each cycle. The training pipeline infrastructure is specified and ready; automated retraining begins once sufficient labeled cycle outcomes accumulate (estimated 4–6 weeks of runtime).

Live trading requires: adapter training completion, a multi-cycle paper mode validation period showing consistent positive P&L, and an explicit configuration change to enable execution.
