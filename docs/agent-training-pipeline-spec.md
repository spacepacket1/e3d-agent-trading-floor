# Agent Continuous Training Pipeline — Specification
## Scout + Harvest

---

## 1. Why We're Doing This

### The Core Problem

The scout agent's system prompt currently exceeds 11,000 tokens per cycle. The harvest agent's prompt is similarly bloated. Most of that is rules — signal timing, quality gates, tier definitions, FLOW-ONLY thresholds, pump detection logic, exit criteria, hold-confirm conditions, pump exhaustion patterns. These rules are re-read from scratch every 5 minutes, every cycle. The model doesn't "remember" them between calls; it processes them fresh each time.

This has two practical costs:
- **Reliability**: A language model reading 5,000 tokens of rules is less consistent than one that has internalized them through training. Rules in the prompt can be misread, deprioritized, or contradicted by other instructions.
- **Context waste**: The rules crowd out space for market data — the part that actually changes and carries signal.

Profits require two things working correctly: **buying before the pump** (scout) and **selling before the dump** (harvest). A fine-tuned scout that identifies pre-pump entries is worthless if harvest holds through the dump. Both agents need to internalize their respective decision logic.

### What We're Doing Instead

We use the same LoRA fine-tuning infrastructure that taught the model to write on-chain story narratives, but with a new training objective: teach each model to make correct *decisions* rather than generate descriptions.

Fine-tuned models that have internalized the rules need only a short task prompt + live market data. The rules become implicit — "muscle memory" rather than instructions read fresh each call.

### Additional Benefits

- **Compounding improvement**: Training data includes real cycle outcomes. As the pipeline runs and generates labeled wins and losses, each retraining run incorporates what actually worked. The model gets smarter over time from its own trading history.
- **Faster inference**: Fewer input tokens = faster generation. At ~23 tokens/sec on the M-series Mac, every 1,000 tokens saved is ~40 seconds of cycle time recovered.
- **Consistency**: Fine-tuned behavior is more stable than prompted behavior. Scout won't occasionally "forget" that MOVER means post-pump. Harvest won't hold through exhaustion signals when it has been trained to recognize them.
- **Combined profit metric**: Entry precision (scout) × exit timing accuracy (harvest) = overall trade profitability. Fine-tuning both agents closes the loop.

---

## 2. Two Agents, Two Adapters, One Pipeline

| | Scout | Harvest |
|---|---|---|
| **Decision** | Propose buy candidates (or skip) | Hold / monitor / trim / exit |
| **Failure mode** | Buys after the pump (MOVER), or buys junk | Holds through the dump, sells too early |
| **Key rules to internalize** | Signal timing, quality gates, FLOW-ONLY thresholds, pump disqualifier | Hold-confirm signals, pump exhaustion patterns, exit thresholds, P&L cutoffs |
| **Adapter** | `adapters_scout_v1` | `adapters_harvest_v1` |
| **Training data source** | Pipeline cycle outcomes + synthetic rules + risk rejections | Position trajectory outcomes + synthetic rules |

Both adapters are trained independently. The MLX server loads whichever adapter is appropriate for the agent role being served.

---

## 3. Scout Training Data Sources

Training data comes from three sources, blended together.

### Source A — Synthetic Rule Examples (static, hand-crafted)

**What it teaches**: The core scout rules in isolation.

**Examples**:
- MOVER story + 581k% 7d gain → `candidates: []`, reason: post-pump disqualified
- STAGING story + price flat + liq $500k + mcap $8M → TIER 2 candidate
- CLUSTER + ACCUMULATION on same token + change_24h < 5% → TIER 1 multi-signal convergence
- Thesis conviction 72, LONG, in universe → propose despite no flow signal
- FLOW-ONLY trigger with ratio 2.1 (below 3.5 threshold) → skip, threshold not met
- liquidity $45k, mcap $800k → quality gate failure, skip
- WASH_TRADE disqualifier on candidate → skip regardless of other signals

**Volume**: ~300–500 examples. Regenerated only when prompt rules change.

**Script**: `generate_synthetic_training_data.py --agent scout`

---

### Source B — Pipeline Cycle Outcomes (live, accumulates)

**What it teaches**: What actually worked — real conditions, real signal combinations, real P&L.

**Raw data**: `pipeline.jsonl` — the append-only cycle log.

**How a training example is constructed**: Each example chains four pipeline events into one labeled record:

```
scout event        → the input context (compressed) + decision made
risk_approved/     → whether the risk agent agreed
  risk_rejected
position outcome   → P&L when position closed (win/loss/neutral)
```

**Labeling logic**:
- `risk_rejected` → negative example: scout proposed something it shouldn't have
- `risk_approved` + `realized_pnl_pct >= +5%` at close → positive: correct proposal, profitable outcome
- `risk_approved` + `realized_pnl_pct <= -8%` at close → negative: scout proposed, it lost
- `risk_approved` + position still open or flat → neutral, excluded

**Compression**: Full scout user message is ~11K tokens. Extract compresses to decision-relevant features: story signals found, flow data for candidate, theses present, CoinGecko data, what scout decided and why. Target: 600–800 tokens per example.

---

### Source C — Risk Rejection Reasons (live, accumulates)

**What it teaches**: Specific patterns the risk agent consistently rejects — repeated proposals of the same token, insufficient liquidity, crowded longs.

**Raw data**: `risk_rejected` events in `pipeline.jsonl`.

**How extracted**: Pair the scout's compressed input with the rejection label. The assistant output is a `candidates: []` response with the rejection reason as the reasoning.

**Volume**: Already substantial — overnight logs show REQ rejected 7+ consecutive times. High-signal negative examples.

---

## 4. Harvest Training Data Sources

### Source A — Synthetic Rule Examples (static, hand-crafted)

**What it teaches**: The core harvest decision rules in isolation.

**Examples**:
- Position +15%, MOVER story firing, no pre-pump signals → `action: exit`, reason: pump exhaustion signal
- Position +8%, CLUSTER + ACCUMULATION stories, no MOVER/SURGE → `action: hold`, reason: hold-confirm signals active
- Position -12%, no new signals in 4 cycles → `action: exit`, reason: stop-loss threshold, thesis invalidated
- Position +3%, SURGE story firing + change_7d > 400% → `action: trim`, reason: peak proximity, take partial profit
- SMART_MONEY accumulation still active → `action: hold`, reason: smart money still building
- STAGING story on held token still firing → `action: hold`, reason: pre-pump signal means setup not resolved
- Position flat 48h, story expired, no new signal → `action: monitor`, reason: no actionable catalyst yet

**Volume**: ~200–400 examples. Regenerated only when harvest logic changes.

**Script**: `generate_synthetic_training_data.py --agent harvest`

---

### Source B — Position Trajectory Outcomes (live, accumulates)

**What it teaches**: Whether a hold-or-exit decision at a given moment was correct, validated by what the price actually did afterward.

**Raw data**: `harvest_decision` events in `pipeline.jsonl`, cross-referenced with subsequent price data.

**How a training example is constructed**:

```
harvest_decision event → compressed position context + decision made
price at decision      → price at the moment harvest ran
price N hours later    → actual price trajectory after the decision
outcome label          → was the decision correct?
```

**Labeling logic**:

| Decision | Outcome | Label |
|---|---|---|
| `exit` | price fell ≥ 5% within 4h after exit | positive: correctly sold before the drop |
| `exit` | price rose ≥ 10% within 4h after exit | negative: sold too early, left gains |
| `hold` | price rose ≥ 5% within 4h | positive: correctly held into gains |
| `hold` | price fell ≥ 8% within 4h | negative: should have exited |
| `monitor` | either direction ≥ 5% within 4h | label based on direction (positive if up, negative if down) |
| Any decision | price flat within 4h | neutral, excluded |

**Compression**: Harvest user message contains full position history. Extract compresses to: token symbol, entry price, current price, unrealized P&L %, time held, story signals present at decision time (types, ages), flow state, CoinGecko data (change_7d, ath_change). Target: 400–600 tokens per example.

**Key labeling principle**: The correctness of a harvest decision is judged by what happened *after* the decision, not by P&L at the moment. A hold that was down 5% but then recovered 20% was correct. An exit that was up 10% but then would have gone up 30% more was premature.

**Volume**: Grows with pipeline runtime. Each 5-min cycle produces one harvest event per held position. At 2 positions average × 288 cycles/day × 30 days = ~17,000 raw events. After filtering for clear 4h outcomes: ~3,000–5,000 labeled examples per month.

---

### Source C — Pump Exhaustion Examples (live, high-signal subset)

**What it teaches**: The specific pattern of holding through a pump dump — the ASTEROID failure mode.

**How extracted**: Identify positions where:
1. Harvest chose `hold` or `monitor`
2. A MOVER or SURGE story was firing on that token at the time
3. Price subsequently dropped ≥ 10% within 8 hours

These are labeled as negative examples with the assistant output being `action: exit`, reasoning: pump exhaustion signal was present.

**Why separate**: This is the highest-priority failure mode to avoid. Extra weight on this pattern justifies a dedicated extraction pass.

---

## 5. Training Data Format

Identical to the existing story-narrative training format — OpenAI chat JSONL, one JSON object per line.

### Scout Format

```jsonl
{"messages": [
  {"role": "system", "content": "You are Scout, an elite crypto trading research agent. Return STRICT JSON only."},
  {"role": "user", "content": "<compressed cycle context>"},
  {"role": "assistant", "content": "{\"scan_timestamp\": \"...\", \"candidates\": [...], \"stories_checked\": [...]}"}
]}
```

### Harvest Format

```jsonl
{"messages": [
  {"role": "system", "content": "You are Harvest, an elite crypto portfolio manager. Return STRICT JSON only."},
  {"role": "user", "content": "<compressed position context>"},
  {"role": "assistant", "content": "{\"positions\": [{\"token\": \"...\", \"action\": \"exit\", \"reasoning\": \"...\"}]}"}
]}
```

**System prompt in training examples**: A shorter version of the production system prompt — role description only, no rules. The rules are encoded in the assistant responses across the training corpus, not restated in the system prompt.

**User message in training examples**: Compressed context including only decision-relevant features (details by agent in sections 3–4 above).

---

## 6. Training Configuration

Uses the existing MLX LoRA infrastructure.

| Parameter | Story adapter (v2) | Scout adapter (v1) | Harvest adapter (v1) |
|---|---|---|---|
| Adapter path | `./adapters_v2` | `./adapters_scout_v1` | `./adapters_harvest_v1` |
| Config | `train_config_v2.yaml` | `train_config_scout_v1.yaml` | `train_config_harvest_v1.yaml` |
| max_seq_length | 1024 | 2048 | 2048 |
| iters | 200 | 400 | 400 |
| lora rank | 4 | 8 | 8 |
| learning_rate | 1e-5 | 5e-6 | 5e-6 |
| Training objective | Narrative generation | Entry decision making | Exit decision making |

**Why separate adapters**: Scout teaches entry logic; harvest teaches exit logic. They are different tasks, different input contexts, different output schemas. Mixing them in one adapter would dilute both. The server loads whichever adapter is appropriate for its role via `LLM_ADAPTER_PATH`.

**Why higher rank (8 vs 4)**: Decision-making requires more complex conditional logic than narrative generation. Rank 8 gives more capacity for this.

**Why longer sequences (2048 vs 1024)**: Compressed cycle contexts run 600–800 tokens; with system prompt and assistant output the full example can reach 1,500 tokens.

---

## 7. The Extraction Script — `extract_agent_training_data.py`

Located at: `/Users/mini/clawd/e3d/extract_agent_training_data.py`

**Inputs**:
- `pipeline.jsonl` path (default: `/Users/mini/e3d-agent-trading-floor/logs/pipeline.jsonl`)
- `--agent scout|harvest|all` — which agent's training data to generate (default: all)
- `--since` date (ISO format) — only extract cycles after this date
- `--min-outcome-hours 4` — for harvest; only label outcomes after N hours have elapsed
- `--scout-min-outcome-hours 24` — for scout; only label scout outcomes after N hours
- `--output-dir` path for JSONL output (default: `/Users/mini/clawd/e3d/data/`)
- `--source A,B,C` — which sources to include (default: all)
- `--synthetic-count 300` — how many synthetic rule examples to include per agent

**Processing pipeline**:

1. Parse all pipeline events from JSONL
2. **Scout extraction**:
   a. Group events by `cycle_id`
   b. For each cycle: extract scout event, risk event(s), matching position close events
   c. Compress scout context to decision-relevant features (600–800 tokens)
   d. Label each example: positive/negative per section 3 labeling logic
   e. Extract Source C (risk rejection reasons) as additional negative examples
3. **Harvest extraction**:
   a. Group `harvest_decision` events by token + timestamp
   b. For each decision: find the price 4 hours later (from `price_update` events or CoinGecko historical)
   c. Compress position context to decision-relevant features (400–600 tokens)
   d. Label each example per section 4 labeling logic
   e. Run pump exhaustion pass (Source C) as additional negative examples
4. For Source A of each agent: run `generate_synthetic_training_data.py --agent <agent>`
5. Merge all sources per agent, shuffle, split 90/5/5 train/valid/test
6. Write to:
   - `data/scout_train.jsonl`, `data/scout_valid.jsonl`, `data/scout_test.jsonl`
   - `data/harvest_train.jsonl`, `data/harvest_valid.jsonl`, `data/harvest_test.jsonl`

**Quality filters**:
- Exclude cycles where outcome is still open (no label yet)
- Exclude examples where context is incomplete (missing stories or universe data)
- Exclude duplicates (same token + decision in consecutive cycles with identical outcome)
- Minimum 50 examples required per agent; abort if below threshold

---

## 8. The Training Scripts

### `train_scout_adapter.sh`

Located at: `/Users/mini/clawd/e3d/train_scout_adapter.sh`

1. Activate the venv
2. Run `extract_agent_training_data.py --agent scout` to regenerate training data
3. Validate: check example count, check for malformed JSONL
4. Back up current adapter: copy `adapters_scout_v1/` → `adapters_scout_v1_backup_YYYYMMDD/`
5. Run `mlx_lm.lora` with `train_config_scout_v1.yaml`
6. Run eval pass on `data/scout_test.jsonl` — compute loss
7. If eval loss is worse than previous adapter: restore backup, abort, log warning
8. If eval loss improves: keep new adapter, log result
9. Signal `mlx_server.py` to reload the scout adapter
10. Write training run metadata to `training_runs.jsonl` (date, agent, example count, eval loss, adapter version)

### `train_harvest_adapter.sh`

Located at: `/Users/mini/clawd/e3d/train_harvest_adapter.sh`

Same structure as scout, with harvest-specific paths:
- `adapters_harvest_v1/` for backup
- `train_config_harvest_v1.yaml`
- `data/harvest_test.jsonl` for eval
- Signal to reload harvest adapter

**Safety**: The backup + regression check means a bad training run can't silently degrade the model. The pipeline keeps running on the previous adapter if training fails.

---

## 9. The Cron Job — `cron_train_agents.sh`

Located at: `/Users/mini/clawd/e3d/cron_train_agents.sh`

**Schedule**: Weekly, Sunday 3 AM local time (pipeline traffic is lowest, no active trading session).

```cron
0 3 * * 0 /Users/mini/clawd/e3d/cron_train_agents.sh >> /Users/mini/clawd/e3d/logs/cron_train.log 2>&1
```

**What it does**:
1. Check that `mlx_server.py` is running; if not, abort (don't train if model is down)
2. Check available disk space: need at least 10GB for two sets of adapter backups + new weights
3. Run `train_scout_adapter.sh`
4. If scout training succeeds: run `train_harvest_adapter.sh`
5. If either fails: log error, write to a status file the dashboard can read; continue with the other agent rather than aborting both
6. On completion: log "Training complete. Scout adapter v{N} (eval loss: {X}, {Y} examples). Harvest adapter v{N} (eval loss: {X}, {Y} examples)."

**First run**: Source B and C will have limited real outcome data. Training will be dominated by synthetic rule examples (Source A). This is correct — the model learns the rules first. As weeks pass, real outcome data grows and starts to dominate, shifting the model toward market-validated behavior.

---

## 10. Deployment — Server Adapter Swap

The `mlx_server.py` loads the adapter at startup via `LLM_ADAPTER_PATH`. To deploy a new adapter:

**Option A — Restart (simple, brief downtime)**:
`stop_gunicorn.sh` → copy new adapter → `start_gunicorn.sh`

**Option B — In-process reload (no downtime)**:
Add a `/reload` endpoint to `mlx_server.py` that calls `mlx_lm.load()` again with the new adapter path. The training script POSTs to this endpoint after writing new weights.

The spec recommends Option A initially. Option B is an enhancement once the training pipeline is proven.

**Note**: If scout and harvest are served by the same gunicorn instance (same adapter), they share weights. For full independence, run two gunicorn instances on different ports — one for scout (adapter: `adapters_scout_v1`), one for harvest (adapter: `adapters_harvest_v1`). The pipeline routes LLM calls to the correct port based on which agent is running.

---

## 11. How the Prompts Shrink

### Scout

**Before (current)**: ~5,000 tokens of rules — signal timing, tier definitions, quality gates, FLOW-ONLY thresholds, pump filter instructions, thesis exception logic.

**After**: ~800 tokens — role description, output schema, current exclusions (held positions), and a one-line reminder of the 3–5 most critical rules as a safety net.

### Harvest

**Before (current)**: ~3,000 tokens of rules — hold-confirm signal list, pump exhaustion patterns, exit thresholds, stop-loss logic, trim criteria.

**After**: ~500 tokens — role description, output schema, held positions with entry data.

### Net saving per cycle

~4,200 tokens saved from scout + ~2,500 tokens saved from harvest = ~6,700 tokens/cycle. At 288 cycles/day: ~1.9M tokens/day. At ~23 tokens/sec, this recovers roughly 80 seconds of cycle time per iteration — meaningful at continuous operation.

---

## 12. Evaluation and Iteration

After each training run, the system logs:
- Eval loss on held-out test set (per agent)
- Number of examples by source (A/B/C)
- Number of positive vs negative examples
- Adapter version number

**Dashboard metrics to watch over time**:

| Metric | What it measures |
|---|---|
| Scout proposal precision | % of proposals that are risk-approved AND profitable at close |
| Harvest exit timing accuracy | % of exits where price fell ≥ 5% within 4h (correct early exits) |
| Harvest hold accuracy | % of holds where price rose ≥ 5% within 4h (correct holds) |
| Overall trade profitability | Net P&L across all closed positions — the combined metric |

A well-trained scout converges toward fewer proposals, more of them profitable. A well-trained harvest converges toward exiting at peak more often and holding through genuine continuations.

The cron job runs weekly. After 4–6 weeks of pipeline data (1,000+ labeled outcomes per agent), the training corpus will have enough real market examples to move meaningfully beyond the rule-based synthetic data.

---

## 13. Implementation Order

1. Write `generate_synthetic_training_data.py --agent scout|harvest` — rule examples for both agents, no pipeline data needed, can run immediately
2. Write `extract_agent_training_data.py` — pipeline outcome extraction for both agents
3. Write `train_config_scout_v1.yaml` and `train_config_harvest_v1.yaml` — LoRA configs
4. Write `train_scout_adapter.sh` and `train_harvest_adapter.sh` — orchestration scripts
5. Write `cron_train_agents.sh` — combined cron wrapper
6. First training run (manual) — validates the pipeline end-to-end for both agents
7. Install cron job
8. After 2 successful automated runs — refactor scout and harvest system prompts to remove internalized rules
