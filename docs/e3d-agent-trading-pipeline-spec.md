# E3D Agent Trading Pipeline — Detailed Specification

## 1. Purpose

This document specifies the implemented agent trading pipeline in `pipeline.js` for the E3D Agent Trading Floor. It describes how the system consumes E3D.ai intelligence, how it combines that data with live market/quant inputs, and how the Scout, Harvest, Risk, Executor, and Manager stages interact inside a deterministic paper-trading loop.

The design principle remains:

- **AI suggests. Code decides.**
- **Paper mode first.**
- **Story-backed signals before price-only momentum.**

## 2. Pipeline Summary

A single cycle performs the following sequence:

1. Build live quant context from external market sources.
2. Build a portfolio intelligence dossier from E3D.ai and local portfolio state.
3. Optionally emit a debug handoff snapshot and stop before LLM execution.
4. Run **Scout** to discover buy candidates.
5. Refresh holdings and run hard sell checks.
6. Run **Harvest** to classify held positions.
7. Send Scout/Harvest outputs through **Risk**.
8. Run the deterministic portfolio engine for exits, rotations, and buys.
9. Persist portfolio state and write logs.
10. Run **Manager** post-cycle evaluation.

The cycle is orchestrated by `runCycle()` in `pipeline.js`.

## 3. Execution Model

### 3.1 Deterministic core

The pipeline is deterministic in the sense that:

- External data is pre-fetched before LLM calls.
- Every agent returns strict JSON.
- Returned data is validated and post-processed by code.
- Trade execution is gated by Risk and Executor decisions.
- Portfolio mutations are written only by deterministic functions.

### 3.2 Paper trading default

The portfolio starts in paper mode and remains there unless explicitly changed through configuration.

Even in paper mode:

- position sizing is real
- cooldowns are real
- PnL tracking is real
- rotations are real
- logs are real

Only live order submission is disabled.

### 3.3 Debug mode

If `PIPELINE_DEBUG_MODE` or CLI debug flags are enabled, `runCycle()` skips the LLM agents and prints a JSON handoff snapshot containing:

- pipeline run metadata
- Scout handoff payload and length
- Harvest handoff payload and length
- candidate/debug counts

This is used to inspect the exact prompt material being sent to the agents.

## 4. E3D.ai Integration Surface

The pipeline uses E3D.ai as the primary intelligence layer. The important surfaces are:

### 4.1 Global cycle data

Fetched once per cycle in `getOrFetchCycleMarketContext()`:

- `GET /fetchTokensDB`
- `GET /fetchTokenPricesWithHistoryAllRanges`
- `GET /stories`

These are cached at cycle scope so the pipeline does not repeatedly hit the stories endpoint per position.

### 4.2 Per-token and per-address enrichment

Used inside dossier building and candidate post-processing:

- `GET /addressMeta`
- `GET /token-info/:name`
- `GET /fetchTransactionsDB`
- `GET /addressCounterparties`
- `GET /tokenCounterparties`
- `GET /fetchTokenPricesWithHistoryAllRanges` by address search

### 4.3 Higher-level E3D.ai signal feeds

Scout also uses:

- `GET /candidates` — pre-computed multi-signal convergence candidates
- `GET /theses` — structured investment theses
- `GET /watchlist` — authenticated user watchlist

### 4.4 Auth

The trading floor uses `e3dAuthClient.js` as the E3D.ai auth broker.

Supported auth modes:

- **Username/password login**
  - Posts credentials to `https://e3d.ai/login`
  - Extracts the session cookie
  - Validates the session against `https://e3d.ai/auth/status`
  - Stores the cookie securely

- **API key**
  - Probes access using `GET /stories?limit=1`
  - Stores the key securely
  - Sends `x-api-key` and `x-e3d-api-key` headers

Storage preference:

- macOS Keychain first
- encrypted fallback file in `~/.e3d-agent-trading-floor/e3d-auth.enc`

Only e3d.ai requests receive auth headers.

## 5. Portfolio Intelligence Dossier

`buildPortfolioIntelligenceDossier()` compiles a compact decision layer for the portfolio and the held positions.

It includes:

- cash and equity
- current market regime
- tracked positions
- per-holding thesis strength
- thesis freshness
- narrative decay
- opportunity score
- recommended action

For each held position, the dossier is built from:

- `fetchTokensDB` market data
- `fetchTokenPricesWithHistoryAllRanges` price context
- `addressMeta` identity data
- `token-info/:name` token metadata
- `fetchTransactionsDB` transaction history
- `addressCounterparties` and `tokenCounterparties`
- cycle-level stories

The dossier is also used to generate prompt snapshots for Scout and Harvest.

## 6. E3D.ai Story Model

Stories are the central signal primitive.

### 6.1 Story fields used by the pipeline

The code reads and preserves fields such as:

- `story_type` / `type`
- `title`
- `subtitle`
- `ai_narrative`
- `ai_takeaways`
- `ai_risks`
- `source_story_id`
- `derived_count`
- `score`
- `meta.token_address`
- `meta.primary.address`
- `meta.entities.current_price_usd`
- `meta.entities.marketCapUSD`
- `meta.entities.liquidityUSD`

### 6.2 Story categories

The pipeline classifies stories into these groups:

- **Disqualifiers**
  - `WASH_TRADE`
  - `LOOP`
  - `LIQUIDITY_DRAIN`
  - `SPREAD_WIDENING`
  - `MOMENTUM_DIVERGENCE`
  - `EXCHANGE_FLOW`
  - `SECURITY_RISK`
  - `RUG_LIQUIDITY_PULL`
  - `TREASURY_DISTRIBUTION`

- **Buy / pre-pump signals**
  - `STAGING`
  - `CLUSTER`
  - `FUNNEL`
  - `NEW_WALLETS`
  - `WHALE`
  - `ACCUMULATION`
  - `SMART_MONEY`
  - `STEALTH_ACCUMULATION`
  - `DEEP_DIVE`
  - `THESIS`
  - `BREAKOUT_CONFIRMED`
  - `FLOW`
  - `HOTLINKS`
  - `DISCOVERY`
  - `DELEGATE_SURGE`
  - `SMART_MONEY_LEADER`

- **Late signals**
  - `MOVER`
  - `SURGE`

- **Secondary signals**
  - `CONCENTRATION_SHIFT`
  - `INSIDER_TIMING`
  - `TOKEN_QUALITY_SCORE`
  - `SANDWICH`
  - `MIRROR`
  - `VOLUME_PROFILE_ANOMALY`

### 6.3 Story handling rules

- Global stories are fetched once per cycle.
- Story-backed tokens are added to the universe even if they are not in the primary volume feed.
- The token universe is filtered to retain only tokens with story coverage.
- `THESIS` stories are treated as the highest-priority signal layer in prompt ordering and dossier summaries.
- The pipeline avoids repeated per-address `/stories` calls because the stories endpoint has a burst limit.

## 7. Thesis Model

Theses are the strongest structured E3D.ai signal after candidates.

### 7.1 Thesis use

Scout receives `GET /theses?status=active&limit=25` and treats these as:

- direction-aware
- conviction-scored
- price-targeted
- invalidation-aware

### 7.2 Thesis-driven entry rules

A thesis can override the normal universe gate when:

- `direction = LONG`
- `conviction >= 65`
- the thesis includes usable price data

In that case Scout may propose the token even if it is not in the token universe, and should label the reasoning as thesis-driven.

### 7.3 Thesis ranking behavior

Thesis items are surfaced ahead of generic stories in the prompt and dossier flow.

The pipeline also records thesis conviction by address for watchlist cross-reference and momentum gating.

## 8. Price, History, and Market Data

The pipeline uses E3D.ai pricing and history in several ways:

### 8.1 Token universe building

The token universe is derived from `fetchTokenPricesWithHistoryAllRanges` using:

- `storyCount` ranking
- `trendInterval = 1H`
- volume-ranked fallback data

### 8.2 Per-candidate enrichment

After Scout returns candidates, each candidate is enriched with a fresh per-address call to `fetchTokenPricesWithHistoryAllRanges` to obtain:

- current price
- 30m change
- 24h change
- volume
- market cap
- liquidity
- price source
- slippage estimate

If E3D price data is missing, story-embedded price fields are used as fallback.

### 8.3 History-aware dossier values

The dossier uses historical transaction and story data to compute:

- thesis freshness
- narrative decay
- opportunity score
- flow alignment
- fraud risk
- latest story age
- derived story count

### 8.4 CoinGecko overlays

When configured, the pipeline supplements E3D.ai data with CoinGecko detail for selected thesis and flow tokens. This is enrichment only; E3D.ai remains the primary source of trade selection.

## 9. Token Universe Rules

The universe shown to Scout is not a generic watchlist.

### 9.1 Source ordering

Primary ranking:

- story-count sorted tokens from `fetchTokenPricesWithHistoryAllRanges`

Secondary ranking:

- volume-ranked tokens

### 9.2 Filters

The pipeline excludes:

- stablecoins
- wrapped/base assets
- gold tokens
- obvious non-tradeable quote assets

### 9.3 Story enrichment

Tokens appearing in high-signal stories or active theses are fetched individually and added even if they did not rank into the base universe.

### 9.4 Final inclusion rule

A token must have at least one current-cycle story signal or story-feed confirmation to remain in Scout’s universe.

## 10. Quant Context

`buildCycleQuantContext()` provides the live non-E3D market backdrop:

- DexScreener order flow for held positions
- CoinGecko BTC/ETH macro snapshot
- Fear & Greed index
- Binance funding rates

The resulting fields are used to:

- gate new entries
- tighten stops
- identify overcrowded longs
- enrich candidate and holding prompts

## 11. Scout Stage

Scout is the discovery agent.

### 11.1 Inputs

Scout receives:

- token universe
- E3D candidates
- E3D theses
- user watchlist
- story blocks
- macro context
- funding warnings
- precomputed portfolio intelligence

### 11.2 Prioritization order

Scout works in this order:

1. E3D candidates
2. E3D theses
3. user watchlist tokens with supporting signals
4. thesis stories
5. buy-signal stories
6. flow-only setups as last resort

### 11.3 Output requirements

Scout must return strict JSON with:

- `scan_timestamp`
- `candidates[]`
- `holdings_updates[]`
- `stories_checked[]`

Each candidate includes:

- source agent
- token identity
- setup type
- confidence / conviction / opportunity scores
- evidence
- risks
- entry zone
- invalidation price
- targets
- market data
- liquidity data
- execution data
- portfolio data

### 11.4 Safety rules

Scout must not:

- propose already-held tokens
- propose disqualified addresses
- chase late-pump signals alone
- force flow-only entries without meeting all hard thresholds

## 12. Harvest Stage

Harvest is the exit-scan agent.

### 12.1 Inputs

Harvest receives:

- live holdings and live prices
- cycle macro regime
- exit-risk stories matched to held addresses
- hold-confirmation stories
- pump-exhaustion stories
- portfolio intelligence dossier
- live flow and funding overlays

### 12.2 Decision behavior

Each held position must be classified as one of:

- `hold`
- `monitor`
- `trim`
- `exit`

### 12.3 Exit discipline

Harvest only adds a position to `exit_candidates` when the action is `trim` or `exit`.

Every exit candidate must include:

- at least two evidence items
- suggested exit fraction
- decision price
- target exit price
- why-now rationale

### 12.4 Conservative bias

Harvest is not allowed to propose mass liquidations without direct exit-risk story confirmation.

## 13. Risk Stage

Risk validates candidates and exits before the portfolio engine acts.

Risk is responsible for:

- invalid address rejection
- missing field rejection
- fraud/liquidity/exposure checks
- quant gate enforcement
- paper-mode discipline

If Risk rejects a candidate, it never reaches execution.

## 14. Executor Stage

Executor is the final decision wrapper before portfolio mutation.

It records:

- paper trade tickets
- approved exit fractions
- follow-up actions
- rejection reasons

In paper mode, Executor never submits live trades.

## 15. Portfolio Engine

The deterministic engine handles:

- updates from Scout holdings snapshots
- hard sell checks
- risk-approved exits
- rotations
- buys
- PnL recomputation
- portfolio persistence

Key settings include:

- `max_open_positions`
- `max_position_pct`
- `risk_per_trade_pct`
- `min_trade_usd`
- `max_buys_per_cycle`
- `max_rotations_per_cycle`
- `rotation_threshold`
- `category_cap_pct`

## 16. Manager Stage

Manager is a post-cycle evaluator.

It runs after `cycle_end` and evaluates:

- Scout coverage and evidence depth
- Harvest completeness and exit discipline
- Risk hard-limit enforcement
- Executor decision validity
- cycle duration and pipeline health
- final portfolio delta

Manager produces a report file in `reports/` and does not alter the cycle outcome.

## 17. Logging and Persistence

The pipeline writes to:

- `logs/pipeline.jsonl`
- `logs/agent-raw.jsonl`
- `logs/training-events.jsonl`
- `portfolio.json`
- `reports/`

The log stream includes:

- quant context
- LLM request/response metadata
- Scout output
- Harvest output
- risk approvals/rejections
- executor decisions
- trades
- final stats
- manager report metadata

## 18. Rate-Limit and Cache Rules

### 18.1 Stories

- One global stories fetch per cycle
- No per-address story looping
- Story coverage grading is only measured against story types present in the fetched cycle data

### 18.2 Dossier cache

Per-token intelligence dossiers are cached for a short TTL to avoid repeated calls inside one run.

### 18.3 Candidate batching

Scout candidates are batched into prompt-sized chunks so the model prompt stays within safe limits.

## 19. Data Sources by Function

### `getOrFetchCycleMarketContext()`

- `/fetchTokensDB`
- `/fetchTokenPricesWithHistoryAllRanges`
- `/stories`

### `buildTokenIntelligenceDossier()`

- `/addressMeta`
- `/token-info/:name`
- `/fetchTransactionsDB`
- `/addressCounterparties`
- `/tokenCounterparties`
- cycle stories
- token price/history feed

### `runScoutDirect()`

- cycle token universe
- `/candidates`
- `/theses`
- `/watchlist`
- optional CoinGecko detail
- quant context

### `runHarvestDirect()`

- cycle stories
- live holdings prices
- quant context
- dossier data

## 20. Market Regime System

`computeMarketRegime()` runs after Risk approvals are known and before the buy/rotation engines fire.

### 20.1 Inputs

- average 24h momentum of all Scout candidates
- average 24h momentum of Risk-approved candidates
- average 24h momentum of held positions
- average score and fraud risk of approved candidates

### 20.2 Regime classification

| Regime | Condition |
|---|---|
| `risk_off` | No approvals + candidates in negative momentum; OR composite momentum ≤ −8%; OR average fraud risk ≥ `reject_fraud_risk_gte` |
| `risk_on` | Composite momentum ≥ 12% AND approved avg score ≥ 25 AND avg fraud risk < 20 |
| `neutral` | All other cases |

### 20.3 Regime policy

`regimePolicy()` translates the regime into engine limits:

| Policy field | `risk_on` | `neutral` | `risk_off` |
|---|---|---|---|
| `allow_buys` | true | true | false |
| `allow_rotations` | true | true | false |
| `allocation_multiplier` | 1.15 | 1.0 | 0 |
| `max_buys_per_cycle` | settings value | max(1, settings value) | 0 |
| `max_rotations_per_cycle` | settings value | settings value | 0 |

In `risk_on` mode, each buy allocation is boosted by 15% before the minimum size check.

The active regime is written to `portfolio.stats.market_regime` and included in every subsequent training event for that cycle.

## 21. Position and Candidate Scoring

### 21.1 Candidate score (`computePositionScoreLike`)

Used during rotation ranking to compare new candidates against held positions:

```
score = opportunity_score × 0.35
      + conviction_score   × 0.30
      + liquidity_quality  × 0.20
      + change_24h_pct     × 0.10
      − fraud_risk         × 0.25
      − slippage_bps / 10  × 0.05
```

### 21.2 Position score (`computePositionScore`)

Adjusts the candidate score for held positions:

```
position_score = candidate_score + pnl_pct × 0.10 − age_days × age_decay_per_day
```

`age_decay_per_day` defaults to `SETTINGS_DEFAULTS.age_decay_per_day`.

### 21.3 Score normalization

`normalizeScore()` accepts confidence/conviction values in multiple formats:
- string labels: `"high"` → 80, `"medium"` / `"moderate"` → 55, `"low"` → 30
- decimal 0–1: multiplied by 100
- integers 0–100: used directly

This normalizer is applied before every fraud and confidence gate check.

## 22. Training Event System

Every significant pipeline decision is captured as a structured training event.

### 22.1 Event schema

Each record contains:

| Field | Description |
|---|---|
| `event_id` | UUID |
| `schema_version` | Schema semver constant |
| `ts` | ISO timestamp |
| `event_type` | See §22.2 |
| `actor` | `scout`, `harvest`, `risk`, `executor`, `pipeline`, `manager` |
| `pipeline_run_id` | UUID shared across all cycles in a single `main()` invocation |
| `cycle_id` | UUID per cycle |
| `cycle_index` | Monotonically increasing integer per loop run |
| `market_regime` | `risk_on`, `neutral`, or `risk_off` |
| `candidate_id` | SHA-256 derived token/candidate identifier |
| `position_id` | SHA-256 derived position identifier |
| `trade_id` | SHA-256 of trade fields for deduplication |
| `payload` | Full event-specific detail object including portfolio snapshot |

### 22.2 Event types

| Event type | Actor | When |
|---|---|---|
| `cycle_start` | pipeline | Before Scout runs |
| `candidate` | scout | Per Scout candidate proposed |
| `harvest_decision` | harvest | Per Harvest exit candidate |
| `risk_decision` | risk | Per Risk evaluate |
| `executor_decision` | executor | Per Executor evaluate |
| `trade` | pipeline | Per executed buy or sell |
| `outcome` | pipeline | Per sell with realized PnL |
| `cycle_end` | pipeline | After portfolio save |
| `manager_report` | manager | After Manager completes |

### 22.3 Persistence

Training events are written to two sinks simultaneously:

- **File sink**: appended to `logs/training-events.jsonl` (always)
- **ClickHouse sink**: inserted into `e3d_trading.training_events` via the ClickHouse HTTP API (`INSERT INTO ... FORMAT JSONEachRow`) (when available)

The ClickHouse table uses `MergeTree` ordered by `(ts, event_type, event_id)`.

Portfolio state is also synced to MongoDB after every cycle via `syncPortfolioToMongo()`, which pipes a `mongosh` script through Docker `exec` to upsert the document at `_id: "current"` in the configured database.

### 22.4 Candidate and position IDs

`ensureCandidateTrainingMetadata()` ensures stable identifiers across events:

- `candidate_id`: contract address, or candidate `id`, or SHA-256 of `{token, context, summary}`
- `position_id`: SHA-256 of `{candidate_id, context, kind}`

`buildTradeId()` produces a SHA-256 over `{side, symbol, contract_address, reason, quantity, price, candidate_id, position_id, ts, pipeline_run_id, cycle_id, cycle_index}` for deduplication.

## 23. Payload Validation and JSON Repair

### 23.1 Scout payload validation (`validateScoutPayload`)

Drops candidates that are missing:
- a valid EVM contract address (`/^0x[a-fA-F0-9]{40}$/`)
- a token symbol string
- an entry zone object (defaults to `{low: null, high: null}` if absent)
- a targets object (defaults to `{target_1: null, target_2: null, target_3: null}` if absent)

### 23.2 Harvest payload validation (`validateHarvestPayload`)

Drops exit candidates that are missing a valid EVM contract address. Normalizes the `position` field to `{}` if absent.

### 23.3 JSON repair (`repairTruncatedJson`)

When an LLM response is truncated at `max_tokens`, the raw string is repaired before `JSON.parse`:

1. Tracks open `{` and `[` on a stack.
2. Strips any trailing `,`, `:`, or `{` that would leave invalid JSON.
3. Closes any unclosed string with `"`.
4. Closes all remaining open structures in reverse stack order.

### 23.4 Scout payload mutation guard

After Risk runs, the pipeline verifies that Scout's output was not modified in memory:

```js
if (sha256(scoutPayload) !== scoutHash) {
  throw new Error("SCOUT_PAYLOAD_MUTATED_IN_MEMORY");
}
```

## 24. Cooldowns and Category Exposure

### 24.1 Cooldowns

After a sell, `setCooldown(portfolio, symbol)` writes a cooldown expiry timestamp to `portfolio.cooldowns[symbol]`. `pruneCooldowns()` removes expired entries at cycle start. `isInCooldown()` gates new buys and rotations for that symbol.

### 24.2 Category exposure

`categoryExposurePct(portfolio, category)` computes the fraction of portfolio equity allocated to a given category. The portfolio engine uses this to enforce `category_cap_pct` and prevent over-concentration in a single story-type or sector bucket.

## 25. Trade Email Notifications

Every executed trade (buy, sell, hard-sell, harvest exit, rotation leg) triggers `sendTradeEmail()`, which:

- Builds an HTML email body with side, mode, price, amount/proceeds, PnL, reason, lifecycle tag, trade ID, and timestamp.
- Posts to `POST /email` on the E3D.ai API base URL using the same auth headers as all other E3D requests.
- Logs the result under `trade_email_sent` or `trade_email_error`.

The email subject follows the format: `[PAPER] BUY TOKEN @ $0.000123` or `[LIVE] SELL TOKEN @ $0.001`.

## 26. CLI Interface

`pipeline.js` is invoked directly with Node.js. Supported flags:

| Flag | Default | Description |
|---|---|---|
| `--loop` | off | Run continuously until stopped |
| `--once` | on | Run exactly one cycle then exit |
| `--interval-seconds N` | 300 | Sleep between loop cycles |
| `--max-iterations N` | ∞ | Stop loop after N cycles |
| `--debug` | off | Enable debug mode (emit handoff snapshot, skip LLM) |
| `--no-debug` | — | Force debug mode off |

A `SIGINT` (Ctrl-C) in loop mode sets `stopRequested = true`, which exits cleanly after the current cycle completes.

## 27. E3D API Rate Limiting

The `fetchJson()` function enforces two limits:

- **Daily budget**: `E3D_REQUEST_DAILY_BUDGET` — once exceeded, all further E3D API calls return `null` and log `e3d_api_budget_exceeded`.
- **Minimum interval**: `E3D_REQUEST_MIN_INTERVAL_MS` — if the last request was within this window, `fetchJson()` calls a synchronous `sleepSync()` before proceeding.

Both counters reset when the process restarts. Every E3D request is logged as `e3d_api_request` and every response as `e3d_api_response` or `e3d_api_error`.

## 28. Detailed Manager Flag Codes

The Manager uses a flag system with three severity levels: `critical`, `warning`, `info`.

### Scout flags

| Code | Severity | Trigger |
|---|---|---|
| `SCOUT_OUTPUT_INVALID` | critical | `candidates` array missing |
| `SCOUT_LOW_COVERAGE` | warning | story coverage < 85% |
| `SCOUT_MISSING_DISQUALIFIERS` | critical | `WASH_TRADE`, `LOOP`, or `LIQUIDITY_DRAIN` not swept |
| `SCOUT_HIGH_FRAUD_CANDIDATE` | warning | any candidate fraud_risk ≥ 35 |
| `SCOUT_THIN_EVIDENCE` | warning | any candidate with < 3 evidence items |
| `SCOUT_LLM_TRUNCATED` | critical | LLM `finish_reason === "length"` |
| `SCOUT_LLM_ERROR` | critical | LLM call failed |
| `SCOUT_LLM_TOKENS_HIGH` | warning | total_tokens ≥ 5800 |

### Harvest flags

| Code | Severity | Trigger |
|---|---|---|
| `HARVEST_OUTPUT_INVALID` | critical | `position_reviews` array missing |
| `HARVEST_LOW_COVERAGE` | warning | story coverage < 85% |
| `HARVEST_INCOMPLETE_REVIEWS` | critical | fewer positions reviewed than held |
| `HARVEST_MISSING_EXIT_SWEEPS` | warning | missing any of `LIQUIDITY_DRAIN`, `RUG_LIQUIDITY_PULL`, `SPREAD_WIDENING`, `CONCENTRATION_SHIFT`, `TREASURY_DISTRIBUTION` |
| `HARVEST_THIN_EVIDENCE` | warning | any exit candidate with < 2 evidence items |
| `HARVEST_INVALID_EXIT_FRACTION` | critical | exit fraction ≤ 0 or > 1 |
| `HARVEST_WEAK_EXIT_FRACTION` | warning | exit fraction > 0 but < 0.1 |
| `HARVEST_MASS_EXIT_SIGNAL` | warning | exits proposed on > 50% of held book |
| `HARVEST_LLM_TRUNCATED` | critical | LLM truncated |
| `HARVEST_LLM_ERROR` | critical | LLM call failed |
| `HARVEST_LLM_TOKENS_HIGH` | warning | total_tokens ≥ 5800 |

### Risk flags

| Code | Severity | Trigger |
|---|---|---|
| `RISK_INCOMPLETE_DECISIONS` | critical | Risk evaluated fewer candidates than Scout proposed |
| `RISK_ZERO_REASON_CODES` | warning | any decision with empty reason_codes |
| `RISK_LIVE_APPROVAL_IN_PAPER` | critical | Risk issued `approve_for_executor` while `paper_mode = true` |
| `RISK_HARD_LIMIT_MISS` | critical | approved candidate with fraud_risk ≥ 35 or confidence ≤ 55 |
| `RISK_APPROVAL_RATE_HIGH` | warning | approval rate > 60% |
| `RISK_APPROVAL_RATE_LOW` | info | approval rate = 0 with ≥ 3 candidates |

### Executor flags

| Code | Severity | Trigger |
|---|---|---|
| `EXECUTOR_INCOMPLETE_DECISIONS` | critical | Executor reviewed fewer than Risk-approved count |
| `EXECUTOR_MISSING_BLOCKERS` | warning | reject with empty blocker_list |
| `EXECUTOR_INVALID_TICKET` | critical | paper_trade decision but no paper_trade_ticket |
| `EXECUTOR_LIVE_TRADE_IN_PAPER` | critical | live_execution_allowed while paper_mode is true |

### Pipeline flags

| Code | Severity | Trigger |
|---|---|---|
| `PIPELINE_SLOW_CYCLE` | warning | cycle > 300 seconds |
| `PIPELINE_LLM_ERROR` | critical | any LLM truncation or error |
| `PIPELINE_API_ERROR_RATE` | warning | API error rate > 5% |
| `PIPELINE_EQUITY_DROP` | critical | equity dropped > 5% in one cycle |
| `PIPELINE_REGIME_MISMATCH` | info | Fear & Greed ≤ 25 but regime did not flip to `risk_off` |

### 28.1 Manager overall score weights

| Agent | Weight |
|---|---|
| Scout | 25% |
| Harvest | 25% |
| Risk | 25% |
| Executor | 15% |
| Pipeline | 10% |

Each flag reduces the agent score: `critical` −20, `warning` −8, `info` −2.

Grades: A (≥ 90), B (≥ 75), C (≥ 60), D (≥ 45), F (< 45).

## 29. Debug Handoff Snapshot

When `--debug` is active, `buildDebugHandoffSnapshot()` assembles and prints a complete JSON snapshot containing:

- `pipeline_run_id`, `cycle_id`, `cycle_index`
- **Scout**: full prompt message text and length, all E3D intel URLs that would be called, and a `candidate_debug` block showing every token reviewed, its signals, include/exclude reasons, and whether it would be a viable candidate
- **Harvest**: full prompt message text and length

No LLM calls are made in debug mode. The snapshot is also written to the pipeline log as `debug_handoff`.

## 30. Implementation Notes

- The pipeline expects JSON strictly from the agents and repairs truncated JSON when possible.
- `THESIS` is treated as a top-tier signal layer.
- The system is intentionally biased toward no-trade outcomes when evidence is weak.
- The pipeline is paper-first and should not be converted to live execution without a separate safety review.
- Scout's in-memory payload is hash-checked after Risk runs to guard against accidental mutation.
- All E3D requests use `curl` via `runShell()` with a 30-second timeout and the auth headers from `e3dAuthClient.js`.
- Portfolio state is persisted to disk (`portfolio.json`), ClickHouse, and MongoDB after every cycle.

## 31. Recommended Follow-ups

- Add a dashboard page that visualizes the cycle handoff snapshot.
- Add report browsing for Manager outputs.
- Add a dedicated coverage panel for story types and thesis hits.
- Keep the existing whitepaper as the high-level narrative and use this file as the implementation reference.
