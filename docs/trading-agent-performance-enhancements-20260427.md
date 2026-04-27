# Trading Agent Performance Enhancements — Feature Ticket

## 1. Summary

Add a performance improvement layer around the existing E3D Agent Trading Floor so the agents can learn from completed trades, tighten risk behavior, improve signal quality, and avoid overfitting to short-term noise.

The goal is not simply to retrain more often. The goal is to create a closed-loop trading improvement system:

- review every completed trade
- label which agent made the best or worst decision
- measure setup-level expectancy
- adjust sizing and risk gates from realized outcomes
- add higher-quality signals before expanding strategy scope
- only retrain when the data supports it

This feature adds four major capabilities:

1. Daily performance evaluation and weekly retraining readiness.
2. A new Trade Reviewer / Coach agent.
3. A new Position Sizing agent.
4. A new Regime Sentinel agent plus expanded signal ingestion.

Arbitrage should be added initially as a signal source only, not as live execution logic.

## 2. Background

Recent paper trading behavior shows early signs of improvement:

- More profitable partial exits.
- Better short-term win rate.
- AAVE and Unicorn Meat produced positive partial exits.
- Harvest is beginning to take gains instead of only reacting to stop losses.

However, aggregate PnL is still not consistently positive:

- Recent winning trade count improved, but realized PnL remained negative over the latest window.
- Some losses from KIBSHI, XCN, and residual Unicorn Meat exposure offset partial winners.
- The latest cycle moved market regime to `risk_off`.

This means the system is improving in behavior, but has not yet proven a durable turnaround. The next feature work should improve the quality of the feedback loop rather than blindly increasing retraining frequency.

## 3. Goals

### 3.1 Product goals

- Make the dashboard able to answer: "Are the agents getting better?"
- Show realized performance by agent, setup type, token category, and market regime.
- Turn trade outcomes into structured review data.
- Make retraining decisions evidence-based.
- Reduce avoidable losses through better sizing and regime control.

### 3.2 Trading goals

- Increase realized expectancy per trade.
- Increase profit factor, not only win rate.
- Reduce large stop-loss drag.
- Improve exit timing for winners and losers.
- Avoid repeated entries into setups with negative recent expectancy.
- Preserve upside from profitable partial exits while reducing tail losses.

### 3.3 Engineering goals

- Keep the existing deterministic pipeline principle: AI suggests, code decides.
- Add new agents as narrow, auditable decision layers.
- Preserve existing paper-trading defaults.
- Make all new decisions observable in `pipeline.jsonl`, `training-events.jsonl`, manager reports, and the dashboard.

## 4. Non-Goals

- Do not enable live trading as part of this feature.
- Do not execute arbitrage trades in this phase.
- Do not retrain models every day by default.
- Do not replace Risk or Executor with fully discretionary LLM behavior.
- Do not remove existing hard gates for liquidity, fraud risk, slippage, and non-tradeable assets.

## 5. Proposed Architecture

Current core agents:

- Scout: proposes buy candidates.
- Harvest: reviews held positions.
- Risk: approves or rejects proposals.
- Executor: validates execution plans.
- Manager: reports post-cycle health.

New agents:

- Trade Reviewer: labels completed trades and assigns decision credit/blame.
- Position Sizer: adjusts allocation, trim, and exit sizing.
- Regime Sentinel: controls risk posture and allowed actions.
- Signal Curator: normalizes additional external signals into Scout/Risk features.
- Arbitrage Watcher: detects price dislocations and produces non-executing confidence signals.

The revised cycle should eventually look like:

1. Build market and portfolio context.
2. Run Regime Sentinel.
3. Build enriched signal context.
4. Run Scout.
5. Filter Scout candidates against portfolio and setup expectancy.
6. Run Harvest.
7. Run Risk.
8. Run Position Sizer.
9. Run Executor.
10. Mutate paper portfolio deterministically.
11. Run Manager.
12. Run Trade Reviewer for newly closed or partially closed trades.
13. Update daily performance scorecards.
14. Emit retraining readiness signals.

## 6. Feature A — Daily Performance Evaluation

### 6.1 Description

Add a daily performance job that produces a structured scorecard from `portfolio.json`, `pipeline.jsonl`, and `training-events.jsonl`.

This job should measure whether agent behavior is improving before any retraining decision is made.

### 6.2 Metrics

Compute metrics for rolling windows:

- 6 hours
- 24 hours
- 48 hours
- 7 days
- all-time since reset

For each window:

- closed trade count
- winning trade count
- losing trade count
- win rate
- realized PnL
- gross profit
- gross loss
- profit factor
- average win
- average loss
- average win / average loss ratio
- maximum closed-trade loss
- median hold time
- average hold time
- target-hit count
- stop-loss count
- harvest-exit count
- rotation-out count
- non-tradeable force-exit count

### 6.3 Breakdowns

Break metrics down by:

- token symbol
- contract address
- category
- setup type
- story type
- source agent
- exit reason
- market regime
- risk decision reason codes
- executor decision
- paper trade lifecycle: open, partial sell, close

### 6.4 Output

Write daily reports to:

```text
reports/performance-daily-YYYYMMDD.json
reports/performance-daily-YYYYMMDD.md
```

Append a compact event to `training-events.jsonl`:

```json
{
  "event_type": "performance_scorecard",
  "actor": "manager",
  "payload": {
    "window_hours": 24,
    "trade_count": 13,
    "win_rate": 69.2,
    "realized_pnl_usd": -94.89,
    "profit_factor": 0.72,
    "top_positive_setups": [],
    "top_negative_setups": [],
    "retraining_recommendation": "hold"
  }
}
```

### 6.5 Acceptance Criteria

- A daily scorecard can be generated from existing logs without running the pipeline.
- The scorecard distinguishes high win rate from positive expectancy.
- The dashboard can show at least win rate, realized PnL, profit factor, and top loss reasons.
- The scorecard never recommends retraining solely because a day elapsed.

## 7. Feature B — Trade Reviewer / Coach Agent

### 7.1 Description

Add a new agent that reviews every completed trade and every meaningful partial exit. It should label the quality of the entry, exit, sizing, and agent decisions.

This agent is a coach. It should not execute trades.

### 7.2 Inputs

For each closed or partial trade:

- trade record
- original Scout proposal
- Risk review
- Executor decision
- Harvest decision, if any
- market regime at entry and exit
- stories active at entry and exit
- price path between entry and exit
- liquidity and slippage context
- final PnL
- hold time

### 7.3 Output Schema

```json
{
  "trade_id": "...",
  "position_id": "...",
  "symbol": "...",
  "contract_address": "...",
  "reviewed_at": "...",
  "entry_quality": "excellent|good|acceptable|poor|invalid",
  "exit_quality": "excellent|good|acceptable|early|late|poor",
  "sizing_quality": "too_small|appropriate|too_large",
  "primary_error_agent": "none|scout|harvest|risk|executor|sizer|regime",
  "primary_success_agent": "scout|harvest|risk|executor|sizer|regime",
  "avoidable_loss": true,
  "avoidable_loss_reason": "...",
  "setup_label": "...",
  "story_signal_labels": ["..."],
  "market_regime_label": "risk_on|neutral|risk_off",
  "lessons": ["..."],
  "training_label": "positive|negative|neutral",
  "recommended_rule_changes": ["..."]
}
```

### 7.4 Review Rules

The reviewer should classify:

- profitable target exits as positive exit examples
- profitable partial exits followed by larger residual losses as mixed examples
- full stop losses after failed catalysts as negative Harvest or Risk examples
- repeated rejected candidates as negative Scout examples
- low-liquidity wins as low-confidence positives, not automatically good examples
- non-tradeable forced exits as Risk/Scout guardrail failures

### 7.5 Storage

Append reviews to:

```text
logs/trade-reviews.jsonl
```

Also append a training event:

```json
{
  "event_type": "trade_review",
  "actor": "trade_reviewer",
  "trade_id": "...",
  "position_id": "...",
  "payload": {
    "training_label": "positive",
    "primary_success_agent": "harvest",
    "entry_quality": "acceptable",
    "exit_quality": "good"
  }
}
```

### 7.6 Acceptance Criteria

- Every new `closed_trades` item receives exactly one review.
- Re-running the reviewer is idempotent by `trade_id`.
- Reviews include enough structured fields to generate training examples.
- Reviews are visible in the dashboard trade history detail view.

## 8. Feature C — Evidence-Based Retraining Cadence

### 8.1 Recommendation

Do not retrain daily by default.

Instead:

- run daily evaluation
- accumulate labeled reviews
- retrain weekly when minimum data thresholds are met
- allow emergency retraining only for repeated, clearly labeled failure modes

### 8.2 Retraining Readiness Rules

A retraining run is eligible when at least one condition is true:

- at least 100 new reviewed trade examples since the last training run
- at least 40 new negative examples for a single failure class
- at least 40 new positive examples for a single setup class
- a regression is detected for 3 consecutive daily scorecards
- Scout repeated the same rejected candidate pattern at least 5 times
- Harvest missed at least 3 large avoidable exits in the same setup class

### 8.3 Retraining Should Be Blocked When

- fewer than 30 reviewed examples exist
- labels are mostly neutral
- one token dominates more than 30% of examples
- one day dominates more than 50% of examples
- realized PnL improved but review labels show no consistent causal pattern
- market regime changed and examples are not regime-balanced

### 8.4 Output

Add a retraining readiness file:

```text
reports/retraining-readiness.json
```

Suggested schema:

```json
{
  "generated_at": "...",
  "eligible": false,
  "recommendation": "hold|train_scout|train_harvest|train_risk|train_executor",
  "reason": "not_enough_reviewed_examples",
  "new_review_count": 28,
  "positive_examples": 10,
  "negative_examples": 12,
  "neutral_examples": 6,
  "dominant_failure_modes": [],
  "dominant_success_modes": []
}
```

### 8.5 Acceptance Criteria

- The pipeline can say "do not retrain yet" with a structured reason.
- Weekly retraining is recommended only when labeled examples are sufficient.
- Daily reports and retraining readiness are separate concepts.

## 9. Feature D — Position Sizing Agent

### 9.1 Description

Add a narrow Position Sizer agent that recommends allocation and trim size after Risk approval and before Executor.

The sizer should not approve rejected trades. It only sizes already-approved actions.

### 9.2 Inputs

- Risk-approved candidate or exit action.
- Current portfolio.
- Market regime.
- token liquidity
- volatility
- fraud risk
- slippage estimate
- recent setup expectancy
- recent agent performance
- category exposure
- current drawdown
- open position count

### 9.3 Output Schema

```json
{
  "symbol": "...",
  "contract_address": "...",
  "action": "buy|trim|exit|rotation",
  "recommended_size_pct": 1.25,
  "recommended_exit_fraction": 0.5,
  "max_allocation_usd": 1200,
  "sizing_reason_codes": [
    "neutral_regime",
    "positive_setup_expectancy",
    "liquidity_sufficient"
  ],
  "risk_adjustments": {
    "regime_multiplier": 0.75,
    "liquidity_multiplier": 1.0,
    "performance_multiplier": 0.8,
    "drawdown_multiplier": 0.7
  },
  "blocker_list": []
}
```

### 9.4 Deterministic Guardrails

Code must clamp the sizer output:

- never exceed `max_position_pct`
- never exceed category cap
- never exceed cash
- never allocate below `min_trade_usd`
- never size buys in `risk_off` unless policy explicitly allows them
- never increase size for assets with missing liquidity
- never increase size after a negative setup expectancy warning

### 9.5 Acceptance Criteria

- Sizing decisions are logged as `position_sizing_decision`.
- Executor receives the clamped size, not raw LLM size.
- Manager report includes sizing quality flags.
- Dashboard shows "why this size" for new buys and trims.

## 10. Feature E — Regime Sentinel Agent

### 10.1 Description

Add a dedicated agent that determines current risk posture before Scout and Harvest run.

The Regime Sentinel should convert macro and market context into an explicit policy object that all later stages use.

### 10.2 Inputs

- BTC 24h and 7d movement
- ETH 24h and 7d movement
- fear and greed index
- funding rates
- broad token universe momentum
- liquidity trend
- recent strategy PnL
- drawdown
- recent stop-loss count
- recent profit factor

### 10.3 Output Schema

```json
{
  "regime": "risk_on|neutral|risk_off",
  "confidence": 0.82,
  "allow_new_buys": false,
  "allow_rotations": true,
  "allow_harvest_exits": true,
  "max_buys_per_cycle": 0,
  "max_rotations_per_cycle": 1,
  "allocation_multiplier": 0.4,
  "tighten_stops": true,
  "reason_codes": [
    "negative_recent_profit_factor",
    "btc_downtrend",
    "stop_loss_cluster"
  ]
}
```

### 10.4 Policy Rules

Minimum deterministic rules:

- If recent profit factor is below 0.7 and realized PnL is negative, reduce allocation.
- If stop-loss count exceeds target in a 24h window, block new speculative buys.
- If market regime is `risk_off`, permit harvest exits and defensive rotations only.
- If win rate is high but net PnL is negative, reduce size instead of increasing trade count.

### 10.5 Acceptance Criteria

- Regime policy is generated before Scout.
- Scout prompt receives the policy.
- Risk and Sizer enforce the policy.
- Manager report compares actual actions to allowed policy.

## 11. Feature F — Expanded Signal Sources

### 11.1 Description

Add a Signal Curator layer that gathers external signals and normalizes them into compact, auditable features.

The curated signals should augment Scout and Risk. They should not bypass Risk.

### 11.2 Candidate Sources

Priority sources:

- E3D stories, candidates, theses, and watchlist.
- DEX liquidity changes.
- holder concentration changes.
- smart wallet accumulation and distribution.
- token counterparty concentration.
- CEX listing or delisting news.
- social velocity from X, Farcaster, Discord, or Telegram if available.
- contract safety, tax, honeypot, and blacklist checks.
- Uniswap or aggregator quote depth.
- slippage simulation.
- BTC/ETH funding and open interest.

### 11.3 Normalized Signal Schema

```json
{
  "symbol": "...",
  "contract_address": "...",
  "generated_at": "...",
  "signals": {
    "story_momentum": 0.72,
    "smart_wallet_accumulation": 0.64,
    "liquidity_trend": 0.51,
    "holder_concentration_risk": 0.22,
    "social_velocity": 0.38,
    "contract_risk": 0.0,
    "quote_depth_quality": 0.81
  },
  "positive_reasons": ["..."],
  "negative_reasons": ["..."],
  "missing_sources": ["..."]
}
```

### 11.4 Acceptance Criteria

- Missing external sources degrade gracefully.
- Each signal has source metadata and timestamp.
- Scout can cite signal names in candidates.
- Risk can reject based on curated signal blockers.
- Manager report can identify which signal classes contributed to wins and losses.

## 12. Feature G — Arbitrage Watcher

### 12.1 Description

Add an Arbitrage Watcher as a non-executing signal agent.

This phase should detect price dislocations and quote gaps, but should not place arbitrage trades.

### 12.2 Rationale

Arbitrage is execution-sensitive. Real execution requires:

- reliable live quotes
- gas modeling
- slippage modeling
- routing
- failure handling
- speed
- MEV and sandwich risk controls
- wallet and order management

Those should not be added until the system has deterministic quote validation.

### 12.3 Initial Scope

The watcher should produce:

- token
- venue A price
- venue B price
- spread percentage
- estimated fee/gas/slippage
- net theoretical edge
- confidence
- execution feasibility label

### 12.4 Output Schema

```json
{
  "symbol": "...",
  "contract_address": "...",
  "observed_at": "...",
  "venue_a": "uniswap_v3",
  "venue_b": "aggregator_quote",
  "gross_spread_pct": 1.4,
  "estimated_cost_pct": 0.9,
  "net_edge_pct": 0.5,
  "feasibility": "watch_only|paper_only|not_viable",
  "reason_codes": ["spread_positive_after_costs"],
  "execution_allowed": false
}
```

### 12.5 Acceptance Criteria

- Arbitrage signals are visible in Scout context.
- Arbitrage does not execute trades.
- Risk treats arbitrage as one confidence input, not as an automatic buy.
- No live order routing is introduced.

## 13. Dashboard Enhancements

Add dashboard sections for:

- Performance scorecard.
- Trade reviews.
- Agent attribution.
- Setup expectancy.
- Regime policy.
- Sizing explanation.
- Signal contribution.
- Retraining readiness.

### 13.1 Required UI Concepts

Performance:

- realized PnL by window
- win rate by window
- profit factor by window
- average win/loss
- largest loss
- stop-loss count

Agent attribution:

- Scout positive/negative examples
- Harvest positive/negative examples
- Risk false positives and false negatives
- Executor execution-quality labels

Setup table:

- setup type
- trades
- win rate
- realized PnL
- profit factor
- average hold time
- recommended action: keep, shrink, block, train

Retraining readiness:

- eligible / not eligible
- recommendation
- blocking reasons
- number of new labeled examples

## 14. Data Model Changes

### 14.1 New files

```text
logs/trade-reviews.jsonl
reports/performance-daily-YYYYMMDD.json
reports/performance-daily-YYYYMMDD.md
reports/retraining-readiness.json
```

### 14.2 New training event types

- `trade_review`
- `performance_scorecard`
- `retraining_readiness`
- `position_sizing_decision`
- `regime_policy`
- `signal_snapshot`
- `arbitrage_signal`

### 14.3 New pipeline stages

- `trade_review`
- `daily_performance`
- `position_sizing`
- `regime_sentinel`
- `signal_curator`
- `arbitrage_watcher`

## 15. Implementation Plan

### Phase 1 — Measurement

Build daily performance reports and dashboard scorecards.

Deliverables:

- scorecard generator
- report JSON and markdown output
- dashboard performance panel
- setup-level aggregation

Exit criteria:

- The system can distinguish high win rate from positive expectancy.
- Reports can be generated repeatedly without mutating portfolio state.

### Phase 2 — Trade Reviewer

Add the Trade Reviewer agent and structured review log.

Deliverables:

- review prompt and schema
- idempotent review runner
- `logs/trade-reviews.jsonl`
- dashboard trade review display

Exit criteria:

- Every new closed trade has a review.
- Reviews are usable as training labels.

### Phase 3 — Retraining Readiness

Add rules that recommend when to train and when to wait.

Deliverables:

- readiness report
- minimum data thresholds
- failure-mode clustering
- training recommendation event

Exit criteria:

- System does not recommend daily retraining without sufficient labeled data.

### Phase 4 — Regime Sentinel and Position Sizer

Add pre-cycle policy and post-Risk sizing.

Deliverables:

- regime policy schema
- sizing schema
- deterministic clamps
- dashboard explanations

Exit criteria:

- `risk_off` reduces new buys and sizing.
- Sizer never violates hard portfolio constraints.

### Phase 5 — Signal Curator

Add normalized signal ingestion.

Deliverables:

- normalized signal snapshot
- signal source timestamps
- Scout/Risk prompt integration
- signal contribution metrics

Exit criteria:

- Missing signals do not break the cycle.
- Winning and losing trades can be analyzed by signal class.

### Phase 6 — Arbitrage Watcher

Add watch-only arbitrage signals.

Deliverables:

- spread detection
- cost estimate
- no-execution output schema
- dashboard arbitrage signal panel

Exit criteria:

- Arbitrage signals are produced but never executed.

## 16. Testing Plan

### 16.1 Unit tests

- Scorecard aggregation.
- Trade review idempotency.
- Retraining readiness thresholds.
- Sizing clamp logic.
- Regime policy enforcement.
- Signal normalization.

### 16.2 Fixture tests

Use fixed portfolio and log fixtures to validate:

- positive partial exits are classified correctly
- partial winners followed by residual stop losses are classified as mixed
- high win rate with negative PnL does not become a positive training recommendation
- duplicate token names in trade history do not imply duplicate open positions

### 16.3 Integration tests

- Run a full paper cycle with the new stages enabled.
- Verify portfolio mutation still only happens in deterministic execution functions.
- Verify all new logs are emitted.
- Verify dashboard summary loads with new fields missing and present.

## 17. Safety and Risk Controls

- New agents cannot directly mutate `portfolio.json`.
- New agents cannot submit live orders.
- Position Sizer recommendations must be clamped by code.
- Regime Sentinel may reduce permissions but cannot increase above configured max settings.
- Arbitrage Watcher is watch-only.
- Retraining readiness is advisory until explicitly wired into training scripts.

## 18. Open Questions

- Should Trade Reviewer run inline after every cycle or as a separate daily job?
- Should scorecards be computed from `portfolio.json` only, or from training events as the source of truth?
- Which social and smart-wallet sources are available without adding fragile dependencies?
- Should Regime Sentinel be LLM-based, deterministic, or hybrid?
- What minimum profit factor should unlock increased sizing?
- Should setup expectancy decay by time, number of trades, or market regime change?

## 19. Success Metrics

This feature is successful when:

- the dashboard shows whether agents are improving
- every closed trade has a structured review
- retraining recommendations are evidence-based
- sizing responds to recent performance and regime
- stop-loss drag decreases
- profit factor improves over a 7-day rolling window
- profitable partial exits are preserved while residual losses shrink

Target operating metrics after rollout:

- 7-day profit factor above 1.2
- 7-day average loss less than 1.2x average win
- stop-loss count down 25%
- avoidable-loss review labels down 30%
- no more than 1 repeated Risk rejection pattern per day
- no live arbitrage execution

