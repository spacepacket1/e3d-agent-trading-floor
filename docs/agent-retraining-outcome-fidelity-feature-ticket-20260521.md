# Agent Retraining Outcome-Fidelity — Feature Ticket (2026-05-21)

> **Status addendum (2026-08-07):** Most of this ticket was implemented the
> same day it was written, ahead of a formal review — this doc's §2–§5
> narrative describes the *pre-fix* state and is now stale. As of this
> addendum:
> - **Phase A** (outcome data fidelity) — done. `pipeline.js`'s
>   `recordOutcomeEvent` already emits `return_pct`/`holding_hours`/
>   `realized_direction`; `scripts/recordOutcomes.js` (commit `647242e`)
>   already emits `outcome_enrichment` and `rejection_outcome` events to
>   `training-events.jsonl`. The one true remaining gap, `max_gain_pct`/
>   `max_drawdown_pct`, was hardcoded `null` and has now been closed by
>   adding position peak/trough price tracking in `pipeline.js`.
>   **Caveat:** `scripts/recordOutcomes.js` has no installed cron/launchd
>   schedule and appears to have never actually run against production
>   logs — `logs/training-events.jsonl` has zero `outcome_enrichment` or
>   `rejection_outcome` events despite the code existing. Scout's
>   validated-rejection labeling (Phase B) is therefore dead code in
>   practice until this script is scheduled. Not fixed as part of this
>   pass — needs an explicit decision on cadence before scheduling it.
> - **Phase B** (scout validated-rejection labeling) — implemented in the
>   authoritative extractor at `/Users/mini/clawd/e3d/extract_agent_training_data.py`
>   (return-%-based thresholds, `rejection_validated` labeling). Not yet
>   exercised in practice per the caveat above.
> - **Phase C** (harvest outcome-conditioned labeling) — implemented, but
>   with a real bug found and fixed on 2026-08-07: `_harvest_outcome_label()`'s
>   `exit`/`trim` branch had no code path that could return `"negative"` —
>   every exit/trim decision was labeled positive regardless of outcome.
>   This produced a ~1660-positive/2-negative label split every training
>   run (see `training_runs.jsonl`), a near-single-class dataset with no
>   real learning signal — plausibly the direct cause of harvest's repeated
>   eval-loss regressions since late July. Fixed; a dry-run extraction
>   after the fix produced a balanced 1164-negative/531-positive split.
> - **Phase D1** (adaptive synthetic-count cap) — implemented
>   (`_adaptive_synth_count`, `--synth-ratio-cap`).
> - **Note on file location:** the copy of `extract_agent_training_data.py`
>   in this repo's `training/` directory is stale and orphaned — the live
>   training pipeline only runs the copy at
>   `/Users/mini/clawd/e3d/extract_agent_training_data.py`, which has
>   diverged significantly. Any future changes to extraction/labeling logic
>   belong there, not in `training/`.
>

## 1. Summary

The weekly LoRA retraining loop is the system's real `O → W` (Outcome → Learning) edge — it closes the E3D Decision Layer loop described in `docs/e3d_decision_layer_paper_v1.md` §9. But an audit of the retraining stack found that the gradient is being fed a **low-fidelity, long-biased, and partly outcome-blind** training signal. This ticket specifies the changes needed to make the retraining learn from what actually happened, including from decisions that were *not* trades.

Three problems, in priority order:

1. **The scout cannot learn from validated rejections.** Rejected candidates are labeled `"negative"` purely because they were rejected — never checked against whether the rejection was *right* (token later dumped). A correctly-avoided rug trains as a mistake.
2. **Harvest does not learn from outcomes at all.** Its training label is its own past decision verbatim (behavioral cloning), so profitable and unprofitable exits/holds are reinforced equally.
3. **The richest outcome signals never reach the trainer.** `e3d_thesis_confirmed`, `confirmation_score`, and time-bucketed price returns are written to `logs/run-ledger.jsonl` by `scripts/recordOutcomes.js`, but the extractor only reads `outcome` events from `logs/training-events.jsonl`. The two data planes never join.

**This ticket spans two repos** (like the export ticket): the trading-floor producer side (`pipeline.js`, `scripts/recordOutcomes.js`) and the training side (`/Users/mini/clawd/e3d/extract_agent_training_data.py`).

---

## 2. Background

### 2.1 What retraining does today

- **Cron:** `0 3 * * 0 /Users/mini/clawd/e3d/cron_train_agents.sh` → `train_scout_adapter.sh` + `train_harvest_adapter.sh`.
- Each runs `extract_agent_training_data.py --agent <scout|harvest> --output data --synthetic-count 300`, then `mlx_lm.lora` (cold refit of the Qwen adapter, with a test-loss regression check before promotion).
- The extractor reads **only** `/Users/mini/e3d-agent-trading-floor/logs/training-events.jsonl` (`build_index`, lines ~112-148), indexing `outcome` events by `candidate_id` (`lookup_latest_outcome`, ~164-172).

### 2.2 Scout labeling today (`extract_agent_training_data.py` ~L337-403)

```
risk_decision == "reject"                         → label "negative"
approved & no outcome event yet                   → skip (position open)
approved & pnl_usd > 50                            → "positive"
approved & pnl_usd < -50                           → "negative"
approved & |pnl| < 0.01 & outcome_label=="profit"  → "positive" (conf 0.5)
approved & pnl < 0                                  → "negative" (conf 0.7)
approved & else                                     → "positive" (conf 0.6)
```

Genuinely outcome-conditioned for *approved* candidates — but rejections are labeled by decision alone, thresholds are fixed-dollar, and the label ignores direction, horizon, and thesis confirmation.

### 2.3 Harvest labeling today (`extract_agent_training_data.py` ~L536-575)

```python
# Assign label (simplified — no future outcome lookup for harvest)
label = decision  # "exit", "hold", "monitor", "trim"
```

Pure imitation. The code comment already flags this as a known TODO.

### 2.4 The data-plane split

- `pipeline.js:936 recordOutcomeEvent(...)` writes `outcome` events to `training-events.jsonl` on position close, carrying `pnl_usd` + `outcome_label`.
- `scripts/recordOutcomes.js` enriches `run-ledger.jsonl` (NOT `training-events.jsonl`) with `price_1h/4h/24h/7d_pct`, `signal_detected_before_move`, and (Phase-C) `e3d_thesis_confirmed`, `e3d_confirmation_score`, `e3d_outcome_score`, `e3d_price_return`.
- Rejected candidates produce `candidate` + `risk_decision` events but **no** `outcome` event and **no** price follow-up anywhere.

Net effect: the extractor sees `pnl_usd`/`outcome_label` for closed longs only, and nothing for rejections.

---

## 3. Goals

1. Let the scout learn from **validated rejections** — reward rejections that avoided losses, penalize rejections that missed winners.
2. Make **harvest** outcome-conditioned: label hold/trim/exit by the realized result of the position, not by the decision itself.
3. Plumb the **rich outcome fields** (`thesis_confirmed`, `confirmation_score`, time-bucketed return, realized direction) into the data the extractor reads.
4. Replace **fixed-dollar PnL thresholds** with return-% and (where available) risk-adjusted labels.
5. Reduce **synthetic dilution** of the real outcome signal as real labeled volume grows.

## 4. Non-Goals

- No change to the deterministic buy-gate safety floors (liquidity, mcap, slippage, fraud) or to `computeCandidateScorecard`'s static scoring weights — this ticket trains the **LLM policy**, not the deterministic gate.
- No move off the weekly cold-refit cadence to online/continuous learning.
- No new model architecture; stay on `mlx_lm.lora` + Qwen adapters.
- No live trading. Outcome tracking remains paper-mode.
- No two-way sync with AWS E3D ClickHouse; retraining continues to read local logs only.

---

## 5. Changes Required

### 5.1 Phase A — Outcome data fidelity (producer side)

**Files:** `pipeline.js`, `scripts/recordOutcomes.js`

**A1. Carry rich outcome fields into the `outcome` training event.**
`recordOutcomeEvent` (pipeline.js:936) currently emits `pnl_usd` + `outcome_label`. Add to its payload, when available on the closing position:
- `return_pct` (realized return, not just USD)
- `holding_hours`
- `max_gain_pct`, `max_drawdown_pct` (from the position's tracked high/low while held)
- `realized_direction` (`up` | `down` | `flat`)

**A2. Bridge the run-ledger enrichment back into training-events.**
`scripts/recordOutcomes.js` already computes `price_1h/4h/24h/7d_pct`, `e3d_thesis_confirmed`, `e3d_confirmation_score`, `e3d_outcome_score`. Today these only land in `run-ledger.jsonl`. Add a step that, once an entry's outcome is finalized, **appends an enriched `outcome_enrichment` event to `training-events.jsonl`** keyed by `candidate_id` (and `trade_id` when present) with these fields. Do not mutate existing `outcome` events; append a correlatable companion event so the extractor can join on `candidate_id`.

Rationale: the extractor reads `training-events.jsonl`; this is the lowest-risk way to expose ledger-only enrichment to it without making the extractor parse a second file format.

**A3. Track outcomes for rejected candidates.**
In `recordOutcomes.js`, the per-entry candidate price loop already fetches current price for any candidate with `market_at_signal.price_usd`. Extend it to also process **rejected** candidates (from the ledger's `rejected[]` / candidates with `risk_decision == "reject"`) and emit a `rejection_outcome` event to `training-events.jsonl` with:
- `candidate_id`, `reject_reason` / `reason_codes`
- `price_change_pct` over the evaluation window (e.g. 24h)
- `rejection_validated`: `true` if the price fell beyond a threshold (rejection avoided a loss) or stayed flat below the entry edge; `false` if it rose past a "missed winner" threshold (e.g. `+15%`)

### 5.2 Phase B — Scout: direction-aware & validated-rejection labeling

**File:** `extract_agent_training_data.py` (scout block ~L337-403, index ~L112-148)

**B1.** Extend `build_index` to also index the new `outcome_enrichment` and `rejection_outcome` events by `candidate_id`.

**B2.** Replace the rejection branch (`risk_decision == "reject" → "negative"`). New logic:
```
reject & rejection_validated == true   → "positive"   # good call: avoided a loss
reject & rejection_validated == false  → "negative"   # bad call: missed a winner
reject & no rejection_outcome yet      → skip          # not yet evaluable
```
This makes a correctly-avoided rug a **positive** training example for the scout's "reject" reasoning — directly fixing the headline gap.

**B3.** Replace fixed-dollar thresholds for approved candidates with **return-% based** labels, and fold in thesis confirmation when present:
```
positive if return_pct >= +T_win  (e.g. +10%)  OR  e3d_thesis_confirmed == true
negative if return_pct <= -T_loss (e.g.  -8%)  OR  (e3d_thesis_confirmed == false & return_pct < 0)
else low-confidence label scaled by |return_pct| and confirmation_score
```
Keep the existing paper-trading "prices didn't update" artifact guard (currently L359-362).

**B4.** Carry `confidence`, `return_pct`, `e3d_confirmation_score`, and `realized_direction` into each example's `_meta` so downstream weighting/curriculum can use them.

### 5.3 Phase C — Harvest: outcome-conditioned labeling

**File:** `extract_agent_training_data.py` (harvest block ~L536-575)

Replace `label = decision` with a label derived from what the position did **after** the harvest decision. Join each `harvest_decision` to the position's subsequent outcome (close PnL, or interim mark if still open at horizon):
```
exit/trim  → "positive" if the position fell after the decision (exit avoided loss)
           → "negative" if it rose materially after exit (premature exit)
hold/monitor → "positive" if the position rose or held
             → "negative" if it fell materially while held
no evaluable outcome yet → skip
```
Build separate positive/negative assistant targets for harvest (mirroring `_build_scout_positive_output` / `_build_scout_negative_output`) so a "negative" example does not teach the model to repeat the losing decision. Remove the "no future outcome lookup for harvest" shortcut.

### 5.4 Phase D — Label quality & synthetic balance

**Files:** `extract_agent_training_data.py`, `train_config_scout_v1.yaml`, `train_config_harvest_v1.yaml`, `train_scout_adapter.sh`, `train_harvest_adapter.sh`

**D1.** Make `--synthetic-count` **adaptive**: cap synthetic examples at a fraction (e.g. ≤ 40%) of the real labeled count, so real outcomes dominate the gradient once enough have accumulated. Log the realized real:synthetic ratio.

**D2.** Weight examples by `confidence` (already on each example) in the loss, or oversample high-confidence real examples — so noisy near-zero-PnL labels contribute less than clean wins/losses and validated rejections.

**D3.** Emit a per-run **label distribution** report (the extractor already has `_label_distribution`, ~L619) into `training_runs.jsonl`, including positive/negative split, validated-rejection count, and real:synthetic ratio, so label drift is observable run-over-run.

---

## 6. New / Changed Event Fields

`training-events.jsonl` additions:

| Event | New field | Source |
|---|---|---|
| `outcome` | `return_pct`, `holding_hours`, `max_gain_pct`, `max_drawdown_pct`, `realized_direction` | `recordOutcomeEvent` (pipeline.js) |
| `outcome_enrichment` (new) | `candidate_id`, `trade_id`, `price_1h/4h/24h/7d_pct`, `e3d_thesis_confirmed`, `e3d_confirmation_score`, `e3d_outcome_score` | `recordOutcomes.js` |
| `rejection_outcome` (new) | `candidate_id`, `reject_reason`, `reason_codes`, `price_change_pct`, `rejection_validated` | `recordOutcomes.js` |

All new events must carry `pipeline_run_id`, `cycle_id`, `ts`, and `candidate_id` for correlation, consistent with `buildTrainingEventRecord`.

---

## 7. Success Criteria

### Phase A
- [ ] `outcome` events include `return_pct` and `realized_direction`.
- [ ] An `outcome_enrichment` event is appended to `training-events.jsonl` for every finalized ledger outcome that has E3D correlation fields.
- [ ] A `rejection_outcome` event with `rejection_validated` is emitted for rejected candidates after the evaluation window.

### Phase B
- [ ] Scout examples with `risk_decision == "reject"` and `rejection_validated == true` are labeled `"positive"`.
- [ ] Approved-candidate labels are computed from `return_pct` / `e3d_thesis_confirmed`, not fixed `$50`.
- [ ] Label distribution report shows a non-zero validated-rejection positive count.

### Phase C
- [ ] Harvest labels differ from the raw decision in at least some examples (verifiable: `label != _meta.decision` occurs).
- [ ] Harvest negative examples use the negative assistant target, not the original (losing) decision output.

### Phase D
- [ ] Real:synthetic ratio is logged per run and synthetic share is ≤ the configured cap when real volume is sufficient.
- [ ] `training_runs.jsonl` includes the per-run label distribution.

### Regression safety
- [ ] The existing test-loss regression check still gates adapter promotion; a retrain that worsens test loss does not replace the live adapter (current behavior in `train_*_adapter.sh` Step 5 is preserved).
- [ ] Adapter backup-before-retrain is preserved.

---

## 8. Risks & Mitigations

- **Label-flip instability.** Reversing rejection labels changes the dominant class. Mitigation: ship Phase A (data) and the label-distribution report first; review the new distribution on a dry-run extract before the first retrain that uses it.
- **Sparse rejection outcomes.** Many rejected tokens may lack reliable post-window prices. Mitigation: `skip` when no `rejection_outcome` exists rather than defaulting a label.
- **Look-ahead / leakage.** Outcome fields must reflect data strictly *after* the decision `ts`. Mitigation: `recordOutcomes.js` already gates on `ageSec` thresholds; reuse the same horizon gating for rejection and harvest outcomes.
- **Horizon mismatch.** Use a consistent evaluation window per agent and record which window produced the label in `_meta`.

---

## 9. Implementation Order

| Phase | Effort | Dependency |
|---|---|---|
| A — Outcome data fidelity | Medium | none (producer-side, additive events) |
| B — Scout validated-rejection labeling | Medium | A1, A3 |
| C — Harvest outcome labeling | Medium | A1, A2 |
| D — Label quality & synthetic balance | Small | B or C producing real labels |

Phase A is the foundation: without the new events the trainer has nothing new to learn from. B and C are independent once A lands. D is a tuning pass after real labeled volume exists.

---

*Agent Retraining Outcome-Fidelity Feature Ticket — E3D Agent Trading Floor — 2026-05-21*
