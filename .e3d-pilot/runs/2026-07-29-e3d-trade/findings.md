---
head_sha: e5a4203b40d6cb831786dc74a6918e85e330f49d
---

# Findings

## Local State

Repo head sha: e5a4203b40d6cb831786dc74a6918e85e330f49d

Research topics: paper-trading strategy/execution logic

Analogy domains to consider: game progression and reward loops; social feed and notification mechanics; marketplace liquidity and two-sided matching; developer-tool CLI ergonomics; fintech trust and verification UX

## Git history
range: last 20 commits
```text
e5a4203 Enable Claude Code auto-permissions and prompt suggestions
eb62296 Add Claude Code auto-permissions (allow all tools)
fd5c975 Document product payment boundary
cdb523b Add Maps navigation integration (Phases 1-4) with bug fixes
461d6b7 Switch scout and harvest agents from Qwen 14B to 7B
7f86db8 Fix ClickHouse connection: wrong env var prefix, missing auth, silent HTTP errors
b197d6e Add one-shot backfill: AgentPortfolioSnapshots from E3DAgentActions payload_json
de0b2ca Fix snapshot writer: load .env before reading CH env vars
fed9455 Add AgentPortfolioSnapshots periodic writer (every 5 min cron)
ea923b2 Auto-start pipeline on server boot + suppress mongo stderr noise
b0ef5cd Harden cross-source price divergence guard (peg-aware, fail-closed)
32d4aae Increase risk_on regime aggressiveness ahead of CLARITY Act catalyst
50e5935 Lower rejection miss threshold to 9% ahead of CLARITY Act
647242e Fix rejected_candidates missing from run ledger and add return_pct to outcomes
12f9f08 Implement Decision Layer API integration (Phases A–D)
6c46ba6 add e3d-action-outcome-export-feature-ticket.md spec
4ed5d25 Add Decision Layer API integration feature ticket
3a14adb Fix scout candidate starvation and wasted LLM cycles
7ba756c Add installer/uninstaller and pipeline auto-restart
4d43d05 Add Qwen setup, training, and integration docs
```

## Branches
```text
* main                e5a4203 Enable Claude Code auto-permissions and prompt suggestions
  remotes/origin/HEAD -> origin/main
  remotes/origin/main e5a4203 Enable Claude Code auto-permissions and prompt suggestions
```

## GH issues and PRs
### gh issue list
- none found
### gh pr list
- none found

## Repo docs
### README.md
```text
# E3D Agent Trading Floor — Whitepaper

**April 2026**

---

## Abstract

The E3D Agent Trading Floor is a multi-agent, AI-assisted portfolio management system built on on-chain intelligence from E3D.ai. It operates a continuous cycle of discovery, evaluation, risk validation, and execution — entirely in paper mode until explicitly enabled for live trading. Five specialized LLM agents collaborate inside a deterministic pipeline: Scout discovers opportunities, Harvest manages exits, Risk enforces hard constraints, Executor records trades, and Manager evaluates the cycle after the fact. No agent can unilaterally move capital. Every decision passes through deterministic code before any action is taken.

The system's core thesis is that on-chain story signals — patterns detected in wallet behavior, token flows, and market microstructure — fire *before* price moves. By anchoring the token universe entirely to story-backed tokens and sorting by freshness of signal activity, the pipeline concentrates attention on the pre-pump window rather than reacting to moves already in progress.

---

## Product Payments Note

The trading floor currently does not implement E3D product credit purchase or x402 payment handling. Its Maps client uses session-authenticated `e3dRequest(...)` calls against `E3D_MAPS_BASE_URL` or the default `E3D_API_BASE_URL`, so the Phase 7 payments migration does not require runtime logic changes here.

If a future product such as `e3d-x` or `e3d-y` needs prepaid product access:

1. Register the product in the main `e3d` repo at `server/productRegistry.js`.
2. Purchase credits through `POST /api/payments/credits/purchase` with the new `product` value.
3. Pass the returned product bearer key for that product's routes, following the Maps pattern (`Authorization: Bearer e3d_maps_pay_...` for `product=maps`).

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
          buildCognitiveState()          ← Node.js perception layer
          3 targeted API calls:              (candidates + stories + active tokens)
          rank + fuse + disqualify           compact ranked candidate list
                    │
                 SCOUT
          reads cognitive state              Qwen acts as strategist
          optionally drills down (≤3 calls)  on pre-ranked intelligence
          → 0–3 buy candidates
                    │
            UPDATE HOLDINGS
              (price refresh, holdings sync)
                    │
            HARD SELL CHECKS
              (stop-loss, fraud breach, target hits)
                    │
                 HARVEST
          reads held positions + tool calls   targeted drill-down per position
          → hold / monitor / trim / exit
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

The pipeline runs on a configurable interval (default: every 5 minutes). Each cycle is identified by a UUID and logged append-only to `pipeline.jsonl` and optionally to ClickHouse for training data retention.

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

**Role:** Discovery. Scout identifies 0–3 buy candidates per cycle from the pre-ranked cognitive state, with optional targeted drill-down into the E3D API for additional evidence.

**Operating mode:** Scout runs in hybrid perception mode (see §7). Node.js pre-fetches a compact cognitive state (3 API calls) containing the top 10 pre-ranked candidates. Scout reasons on this state and may make up to 3 targeted tool calls for deeper evidence before returning its final answer. Total LLM rounds: 1 (no drill-down needed) to 4 (3 drill-down calls + final answer).

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

## 7. Hybrid Agent Perception Architecture

### 7.1 Design Rationale

The original pipeline pre-fetched all available E3D data (token universe, all story types, candidates, trending tokens) and dumped it into a single large LLM prompt — often 30,000–80,000 characters. This worked but had two problems: the model received a firehose of data it couldn't prioritise, and every cycle burned the same API budget regardless of what was actually useful.

A pure "agentic tool-calling" approach (LLM decides what to fetch, calling APIs across 4–10 sequential rounds) solved the first problem but created new ones: the conversation history grows with each round (every previous result must be replayed in full), RAM usage scales with context length, and a 14B model doing 5–10 inference passes per cycle is slow.

The hybrid architecture resolves both:

- **Node.js is fast at HTTP.** Three targeted API calls take ~2 seconds.
- **Qwen is good at reasoning.** It should reason on curated intelligence, not decide what to fetch.
- **Live perception is preserved.** Agents can still call E3D APIs directly for targeted drill-down when the pre-ranked state isn't sufficient.

### 7.2 The Three Modes

| Mode | When | LLM Rounds | Description |
|---|---|---|---|
| **Cognitive state** (default) | Every cycle | 1 | Node fetches compact state, Qwen reasons and answers in one pass |
| **Drill-down** (hybrid) | When state lacks detail | 2–4 | Qwen calls 1–3 targeted tools on specific candidates, then answers |
| **Full recursive** | Research / deep investigation | Up to 15 | Qwen drives all fetching across many rounds — for slow analysis, not live trading |

The active mode is set by `LLM_TOOL_USE` environment variable. Drill-down is the default when tool use is enabled.

### 7.3 `buildCognitiveState()` — The Perception Layer

`buildCognitiveState()` is the Node.js function that acts as the system's "visual cortex" — it converts raw E3D API data into structured intelligence before Qwen ever sees it.

**Three API calls:**
1. `/candidates` — E3D pre-computed multi-signal candidates (highest priority)
2. `/stories?limit=100&chain=ETH` — all story types in one call, categorised locally
3. `/fetchTokenPricesWithHistoryAllRanges?sortBy=storyCount` — tokens ranked by 1-hour signal activity

**Processing:**
- Build disqualified address set from WASH_TRADE, LIQUIDITY_DRAIN, TREASURY_DISTRIBUTION, and other exit-risk stories
- Build a signal map: `address → { signal_types, conviction, summaries }`
- Fuse E3D candidates + story signals + market data into a unified candidate pool
- Rank by: `source_weight + conviction + signal_count × 5` (E3D candidates score 100, multi-signal 50, single-signal 10)
- Apply soft quality filters, deduplicate, return top 10

**Output (compact, ~2,000–3,000 chars):**
```json
{
  "generated_at": "ISO8601",
  "candidates": [
    {
      "rank": 1,
      "symbol": "TOKEN",
      "address": "0x...",
      "source": "e3d_candidate",
      "signal_types": ["E3D_CANDIDATE", "ACCUMULATION"],
      "conviction": 78,
      "why_now": "Smart money accumulation, conviction 78",
      "market": { "price_usd": 0.0042, "liquidity_usd": 320000, "volume_24h_usd": 850000, "market_cap_usd": 4200000 },
      "drill_down": ["token_info", "transactions"]
    }
  ],
  "meta": { "e3d_candidates": 3, "story_signals": 12, "api_calls": 3 }
}
```

The `drill_down` field tells Scout which tools would add value for that specific candidate — it doesn't have to guess.

### 7.4 Agent Tool Definitions

When `LLM_TOOL_USE=1`, agents have access to seven tools for targeted drill-down:

| Tool | Endpoint | Use case |
|---|---|---|
| `e3d_get_candidates` | `/candidates` | Get E3D pre-computed candidates |
| `e3d_get_stories` | `/stories` | Fetch a specific story type |
| `e3d_get_token_universe` | `/fetchTokensDB` | Verify quality gates for a token |
| `e3d_get_trending` | `/fetchTokenPricesWithHistoryAllRanges` | Spot momentum or capitulation |
| `e3d_get_token_info` | `/token-info/:address` | Deep-dive price/market data for one token |
| `e3d_get_transactions` | `/fetchTransactionsDB` | Check whale moves or unusual activity |
| `e3d_get_address_meta` | `/addressMeta` | Look up token identity/metadata |

All tool calls are authenticated using the stored E3D API key — the LLM never sees or handles credentials. Tool results are truncated to 6,000 characters before entering the conversation to keep KV cache usage manageable on constrained hardware.

### 7.5 RAM Budget

Running Qwen2.5-14B-Instruct-4bit via MLX on a Mac Mini with 25GB RAM:

- Model weights: ~8GB
- KV cache (typical cycle, ~8K tokens): ~1.5GB
- OS + Node.js + other processes: ~4GB
- **Total typical: ~13.5GB** — well within budget

Worst case (15 tool rounds × 6,000 char results ≈ 30K tokens): ~8 + 6 + 4 = ~18GB. Still safe. The 6,000-char truncation limit and `MAX_TOOL_ROUNDS = 15` cap are the primary RAM safety mechanisms.

---

## 8. Training Pipeline


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

The system is running in paper mode with a portfolio of $100,000 initial capital. All five agents are operational. The hybrid perception architecture (`LLM_TOOL_USE=1`) is active — Scout and Harvest use `buildCognitiveState()` as their primary data layer, with targeted E3D API drill-down available per cycle. The Manager Agent grades each cycle. The training pipeline infrastructure is specified and ready; automated retraining begins once sufficient labeled cycle outcomes accumulate (estimated 4–6 weeks of runtime).

**Recent architectural changes (May 2026):**
- Replaced bulk data pre-fetching with `buildCognitiveState()` — 3 targeted API calls producing a compact ranked candidate list
- Implemented OpenAI-compatible tool calling for both Scout and Harvest agents
- Hybrid mode: Node.js handles perception bandwidth, Qwen handles strategy; agents can drill down on specific candidates with up to 3 targeted API calls per cycle
- All tool results truncated to 6,000 chars before entering the conversation — keeps KV cache and RAM usage predictable on 25GB hardware
- Stale Colima disk lock recovery: removed `/Users/mini/.colima/_lima/_disks/colima/in_use_by` symlink after VM crash

**Live trading requires:** adapter training completion, a multi-cycle paper mode validation period showing consistent positive P&L, and an explicit configuration change to enable execution.

```

## TODO/FIXME matches
- none found

## External Context

## External Context

- **Multi-agent LLM pipelines for finance** are maturing rapidly: FinAgent (2024), TradingGPT, and similar systems confirm the Scout→Risk→Executor separation as the emerging standard, but most published work omits the deterministic hard-limit layer this repo enforces — making the "AI suggests, code decides" split relatively differentiated.

- **On-chain alpha decay is fast.** Academic and practitioner work (e.g. Nansen, Glassnode research) consistently shows wallet-clustering signals lose edge within hours of becoming legible. The story-freshness sort (`storyCount desc, trendInterval=1H`) directly addresses this, but sets a high bar on latency for the full pipeline round-trip.

- **Local inference via MLX** (Apple Silicon) is production-viable for 7B–14B quantized models as of mid-2025. The recent switch from 14B to 7B for Scout/Harvest aligns with practitioner findings: 7B instruction-tuned models match 14B on structured JSON tasks when the prompt is compact and well-constrained, with ~2× throughput gain.

- **LoRA fine-tuning for specialized JSON generation** is well-validated; the planned adapters follow the established pattern. Key risk: training data volume (~300–500 synthetic examples) is at the lower bound — most successful domain adapters use 2K–5K examples before generalization improves meaningfully over base model.

- **Paper-to-live gating** remains an open problem in systematic trading. The regime of "paper mode as default, explicit flag to go live" is correct but insufficient alone — published failure modes cluster around regime-shift invalidation (strategy trained in one vol regime, deployed in another) rather than individual trade errors.

---

### Analogous Patterns

**1. Game progression and reward loops → live-trading unlock gating**
*Source domain: game design (XP/level gating)*
*Mechanic borrowed: unlock conditions based on sustained cumulative performance, not single events*
The Manager's A–F cycle scoring already generates a natural "XP" stream; rather than using a static elapsed-time gate for live trading, the system could require a rolling minimum grade (e.g., B or above across 50 consecutive cycles) before `live_execution_allowed` flips — making the paper→live transition a provable performance threshold rather than a config change.

**2. Marketplace liquidity and two-sided matching → portfolio rotation as a matching market**
*Source domain: two-sided marketplace design (Gale-Shapley, ride-share dispatch)*
*Mechanic borrowed: stable matching under capacity constraints with ranked preferences on both sides*
The current rotation logic (swap weakest position for best candidate if score gap ≥ 10) is a greedy heuristic; framing rotation as a stable-matching problem — where positions express "preference" to stay based on hold-confirm signals, and candidates express "preference" to enter based on signal tier — could prevent the greedy rule from churning a position that has a fresh ACCUMULATION story purely because a marginally higher-scored candidate appears.

**3. Fintech trust and verification UX → progressive disclosure of agent autonomy**
*Source domain: fintech KYC/tiered account access (Robinhood options tiers, Wise limits)*
*Mechanic borrowed: capability unlocks tied to verified behavioral history rather than a single approval event*
Instead of a binary paper/live flag, the system could gate capability tiers (e.g., FLOW-ONLY entries live → TIER 2 live → TIER 1 live → rotation-triggered live) each requiring a separate track record window — making live deployment incremental and observable rather than an all-or-nothing switch.

