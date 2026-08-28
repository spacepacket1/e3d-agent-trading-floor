# E3D Decision Layer — System Architecture & Paper Alignment

**Status:** Living architecture document
**Last updated:** 2026-05-21
**Canonical references:**
- `docs/e3d_decision_layer_paper_v1.md` (the Decision Layer paper — the loop this system implements)
- The first E3D OTA methodology paper (Transactions → Stories → Theses)

**Scope note:** This document describes the system **as it stands after** the
`agent-retraining-outcome-fidelity-feature-ticket-20260521.md` work lands.
Behaviors that depend on that ticket are marked **[post-fidelity]**. Everything
else is live today.

---

## 1. Purpose

The Decision Layer paper defines a closed-loop model of on-chain intelligence:

$$G_t \rightarrow S_t \rightarrow \Theta_t \rightarrow A_t \rightarrow O_{t+h} \rightarrow W_{t+1}$$

> Observe → Interpret → Hypothesize → Act → Measure → Learn

This document explains **which component owns each arrow**, how data flows between
them, and where the implementation faithfully follows the paper versus where it
deliberately extends or narrows it. It is the map for anyone reasoning about the
system end-to-end.

The central architectural fact: **the loop is implemented across two cooperating
systems, not one.**

- **E3D Core + E3D Decision Layer** (the `e3d.ai` platform) owns `G → S → Θ`, and
  publishes its *own* first-order Action/Outcome layer (`A`, `O` with pre-computed
  scores).
- **The E3D Agent Verdict Engine** (this repo, the "trading app") consumes that
  intelligence read-only and runs a *second-order, capital-aware* `Θ → A → O → W`
  loop, then exports its verdicts back to E3D for display.

Both are legitimate realizations of the paper's `Action` concept — the paper
explicitly admits an **"Agent Action"** type (§3): "when an autonomous or
semi-autonomous agent records a recommended decision." The trading app is that
agent.

---

## 2. System Topology

```
                          ┌──────────────────────────────────────────┐
                          │            E3D CORE  (e3d.ai)              │
                          │  mine chain → graph Gₜ → Stories Sₜ →      │
                          │  Theses Θₜ  (OTA methodology paper)        │
                          └───────────────┬──────────────────────────┘
                                          │  writes
                                          ▼
                          ┌──────────────────────────────────────────┐
                          │        E3D DECISION LAYER  (e3d.ai)        │
                          │  Action Engine → Aₜ with Q_A               │
                          │  Outcome Engine → O_{t+h} with Q_O, Φ      │
                          │  REST: /candidates /theses /actions        │
                          │        /actions/:id/outcome /*/summary      │
                          └───────────────┬──────────────────────────┘
                                          │  HTTP (read-only consumer)
                                          ▼
   ┌───────────────────────────────────────────────────────────────────────────┐
   │           E3D AGENT VERDICT ENGINE  (this repo / trading app)               │
   │                                                                             │
   │  Scout  ──► Risk ──► Executor ──► Paper Trade ──► Harvest                    │
   │  (Θ+C)     (R)       (f_A:U,H)    (simulated A)    (exit f_A)                │
   │     │                                                  │                    │
   │     │  capital-aware Action: f_A(Θ,R,C,U,H)            │                    │
   │     ▼                                                  ▼                    │
   │  logs/training-events.jsonl  ◄── recordOutcomes.js ──► logs/run-ledger.jsonl│
   │  (authoritative event log)       (Oₜ measurement, Φ correlation)            │
   └───────────┬───────────────────────────────────────────────┬───────────────┘
               │  scripts/e3dActionOutcomeExport.js              │  reads logs
               │  (one-way bridge, every 5 min)                  ▼
               ▼                                   ┌───────────────────────────────┐
   ┌───────────────────────────────┐              │  LEARNING LOOP  (/Users/mini/  │
   │  AWS ClickHouse (default db)   │              │  clawd/e3d)  — weekly cron     │
   │  E3DAgentActions               │              │  extract → LoRA → Qwen adapter │
   │  E3DAgentOutcomes              │              │  scout + harvest  (W_{t+1})    │
   │  E3DAgentCycleScorecards       │              └───────────────┬───────────────┘
   └───────────┬───────────────────┘                              │ deploys adapter
               │  /api/agent-verdicts /agent-outcomes /agent-stats │
               ▼                                                   ▼
   ┌───────────────────────────────┐              back into Scout/Harvest agents
   │  E3D UI + Newsletter           │              (closes O → W)
   │  "Agent Verdicts" page (live)  │
   └───────────────────────────────┘
```

Two data planes leave the engine:
- **Export plane** (right-to-AWS): one-way *proof / visibility*. Feeds the E3D UI.
  It does **not** participate in learning.
- **Learning plane** (down): reads `training-events.jsonl` directly and retrains
  the agents. This is the real `O → W` edge.

---

## 3. The Loop, Stage by Stage

### 3.1 `G → S` — Stories (owned by E3D Core)

The paper: `Sₜ = f_S(Gₜ, Eₜ, Mₜ)`. The trading app does **not** generate stories;
it consumes them. `buildCognitiveState` (pipeline.js) pulls `/stories` and
`/candidates`, then classifies story types into buy-signal, disqualifier, and
warning sets. `/candidates` is E3D's pre-computed multi-signal convergence — the
agent treats it as the primary signal layer, with raw story sweeps as fallback.

**Alignment:** faithful. E3D owns story generation; the app is a consumer.

### 3.2 `S → Θ` — Theses (owned by E3D Core)

The paper: `Θₜ = f_Θ({Sᵢ}, Ωₜ)`. Consumed via `/theses?status=active` —
direction (LONG/SHORT/AVOID), conviction, price targets, invalidation price,
fraud risk. The thesis conviction feeds the candidate's `thesis_signal_score`.

**Alignment:** faithful, consumer-side.

### 3.3 `Θ → A` — Actions (TWO layers)

This is the paper's `Aₜ = f_A(Θₜ, Rₜ, Cₜ, Uₜ, Hₜ)` and the action score
`Q_A = αC + βI + γK − δR − λD`.

**Layer 1 — E3D Decision Layer's own actions (first-order).**
`/actions` returns open actions with a **pre-computed `action_score` (= Q_A)**,
`confidence`, `risk_score`, `expected_direction`, `expected_horizon`,
`trigger_reason`. The trading app consumes these directly:
- `thesis_signal_score = round(action_score * 100)` for action-sourced tokens
  (computeCandidateScorecard, pipeline.js ~3094) — Q_A is used verbatim, not
  re-derived.
- Tokens with open `avoid`/`confirm_risk` actions are removed from the universe
  *before* the agent sees them (avoid set).
- Held positions are checked against `/actions?tokenAddress=`; an `avoid`/
  `confirm_risk` at `risk_score > 0.65` triggers a **fast-path exit** that bypasses
  the LLM (fetchPositionExitSignal / buildFastPathExitDecision, pipeline.js ~5994).

**Layer 2 — the Agent Verdict Engine's capital-aware action (second-order).**
This is where the app *extends* the paper. The executor's `f_A` adds inputs the
base Action Engine does not model:
- **R** — the risk engine + deterministic safety floors (liquidity ≥ $100k, mcap,
  slippage ≤ 300bps, fraud ≥ 35) and `risk_score`.
- **U** — objective, expressed through `buildRegimeSentinelPolicy` (pipeline.js
  ~1423): regime, allocation multiplier, max-buys-per-cycle, and a recent-
  performance throttle (gated on `closed_trade_count ≥ 10` to avoid noise lockout).
- **H** — expected horizon carried from the E3D action.
- Plus liquidity depth, position sizing, and portfolio constraints.

The executor emits a **verdict**: `paper_buy / paper_sell / paper_hold / reject /
wait`. A local `composite_score` (pipeline.js ~3130) acts as a Q_A proxy for tokens
*not* sourced from an E3D action.

**Alignment:** Layer 1 is a faithful, direct consumption of Q_A. Layer 2 is a
deliberate **superset** of the paper's `f_A` — it is the paper's §14.4
"`Thesis + Risk + Objective → Action`" made capital-aware. The deterministic
floors are an invariant: the Decision Layer adds signal quality *upstream* of them;
it never replaces them.

### 3.4 `A → O` — Outcomes (TWO layers)

The paper: `O_{t+h} = f_O(Aₜ, P, L, V, N, D)`, scored `Q_O = μR_P + νR_L + ξR_V +
ρR_N − σMDD − κX`, with thesis confirmation `Φ = 1 − d(Ô, O)`.

**Layer 1 — E3D's outcome.** `/actions/:id/outcome` returns `price_return`,
`liquidity_change_pct`, `outcome_score` (Q_O), `confirmation_score` (Φ),
`thesis_confirmed`. The app fetches and stores these per action it acted on.

**Layer 2 — the engine's own outcome measurement** (`scripts/recordOutcomes.js`):
- Realized PnL on closed paper trades; time-bucketed price returns
  (`price_1h/4h/24h/7d_pct`); `signal_detected_before_move`.
- **[post-fidelity]** `outcome` events also carry `return_pct`, `realized_direction`,
  `max_gain_pct`, `max_drawdown_pct` — a closer approach to the paper's multi-factor
  `f_O` (the `D`/drawdown term in particular).
- **[post-fidelity]** Rejected candidates get price follow-up and a
  `rejection_validated` flag — the paper's §7 claim that *defensive* actions are
  measurable (an Avoid is "successful if the token later declines") becomes real,
  not just aspirational.

**Alignment:** `Q_O` and `Φ` are **delegated to E3D** (authoritative) and mirrored
locally by PnL/return measurement. Pre-fidelity, the local measurement was
price-only and long-biased; post-fidelity it gains drawdown, direction, and
defensive-outcome coverage.

### 3.5 `O → W` — Learning (the weekly retrain)

The paper: `W_{t+1} = W_t + η∇𝓛(O_{t+h}, Ô_{t+h})`. The paper also notes v1 may
"begin with simple statistical tracking." The system does **both**:

**Statistical tracking** (read-only reports): `scripts/signalAttribution.js`
computes expectancy by setup / signal / regime / source-agent;
`promotionGates.js`, `retrainingReadiness.js`, `performanceDaily.js` summarize.

**The gradient edge** (`/Users/mini/clawd/e3d`, Sunday 03:00 cron
`cron_train_agents.sh`): `extract_agent_training_data.py` reads
`training-events.jsonl`, builds outcome-labeled examples, and `mlx_lm.lora` does a
LoRA gradient update on the Qwen scout and harvest adapters (cold refit, with a
test-loss regression gate before promotion). `η` is the LoRA learning rate; `𝓛` is
the LM loss against outcome-labeled targets; the updated adapter *is* `W_{t+1}`.

**[post-fidelity] What changes here:**
- **Scout** learns from **validated rejections** (a correctly-avoided dump is a
  *positive* example for the reject reasoning), and labels approvals by `return_pct`
  + `thesis_confirmed` instead of fixed-dollar PnL.
- **Harvest** becomes **outcome-conditioned** — labels are derived from what the
  position did *after* the hold/trim/exit, with separate positive/negative targets.
  (Pre-fidelity, harvest was pure behavioral cloning of its own past decisions.)
- The `e3d_thesis_confirmed` / `confirmation_score` fields that previously died in
  `run-ledger.jsonl` are bridged into `training-events.jsonl` (via
  `outcome_enrichment` events), so E3D's `Φ` reaches the gradient.
- Synthetic dilution is capped relative to real labeled volume.

**Alignment:** post-fidelity, this is a genuine, paper-faithful `O → W` edge for
**both** agents — and it *exceeds* the paper's stated v1 bar (it is a real gradient
update, not merely statistics). The locus of `W` is the **LLM policy** (scout/
harvest judgment); the deterministic scoring weights and gate floors are
intentionally **static** and are not part of `W` — a deliberate scope choice.

---

## 4. Data Architecture

### 4.1 Authoritative event log

`logs/training-events.jsonl` is the system of record. (The local ClickHouse
side-channel never received auth and fails silently — JSONL is authoritative.)
Event types include: `candidate`, `risk_decision`, `risk_engine_decision`,
`executor_decision`, `trade`, `outcome`, `harvest_decision`, `cycle_start/end`,
`manager_report`. **[post-fidelity]** adds `outcome_enrichment` and
`rejection_outcome`.

`logs/run-ledger.jsonl` is the per-cycle ledger that `recordOutcomes.js` enriches
with outcome measurements and E3D `Φ` correlation.

### 4.2 Consumed (E3D Decision Layer, read-only)

`/candidates`, `/theses`, `/actions`, `/actions/:id/outcome`, `/actions/summary`,
`/outcomes/summary`, `/stories`, token price endpoints. Base `https://e3d.ai/api`.

### 4.3 Exported (one-way, to AWS ClickHouse `default` db)

`scripts/e3dActionOutcomeExport.js` (every 5 min) maps local events to:
- `E3DAgentActions` — one row per agent verdict (executor_decision).
- `E3DAgentOutcomes` — one row per paper trade / realized outcome.
- `E3DAgentCycleScorecards` — per-cycle summary.

Deterministic SHA-256 IDs + `ReplacingMergeTree` make re-runs idempotent. The E3D
main repo serves these via `/api/agent-verdicts`, `/api/agent-outcomes`,
`/api/agent-stats` to the live **"Agent Verdicts"** page and newsletter.

### 4.4 Learning artifacts

`/Users/mini/clawd/e3d/`: `extract_agent_training_data.py`, `train_scout_adapter.sh`,
`train_harvest_adapter.sh`, `cron_train_agents.sh`, configs `train_config_*_v1.yaml`,
adapters `adapters_scout_v1` / `adapters_harvest_v1` (with timestamped backups),
`training_runs.jsonl`, `last_training_status.json`.

---

## 5. End-to-End Walkthrough (mirrors paper §15)

1. **Stories.** E3D detects wallet clustering + liquidity expansion + rising
   transfer velocity on a token. → `/candidates`, `/stories`.
2. **Thesis.** E3D forms an accumulation thesis (LONG, conviction, targets). →
   `/theses`. The Decision Layer publishes an `accumulate_signal` **action** with
   `Q_A` and a 48h horizon. → `/actions`.
3. **Action (agent verdict).** Scout picks up the token (Q_A → thesis_signal_score),
   the risk engine clears the safety floors, the regime sentinel allows the buy at a
   throttled allocation, the executor emits `paper_buy`. A simulated entry is
   recorded. → `executor_decision` + `trade` events.
4. **Outcome.** 48h later `recordOutcomes.js` measures realized return, direction,
   drawdown, and fetches E3D's `Φ`/`Q_O`. → `outcome` + **[post-fidelity]**
   `outcome_enrichment` events; exported to `E3DAgentOutcomes`; shown on the Agent
   Verdicts page as validated/invalidated with PnL.
5. **Learning.** Sunday, the extractor labels this candidate `positive` (return and
   `thesis_confirmed` agreed), the scout LoRA adapter is updated, and next week's
   scout is marginally more inclined toward this story-pattern combination — exactly
   the paper's §15 Step 5. **[post-fidelity]** if the same engine had *rejected* a
   token that later dumped, that rejection is now also a `positive` lesson.

---

## 6. Boundaries & Invariants

These are load-bearing architectural rules; violating them breaks the model.

1. **Read-only consumer of E3D.** The trading app never writes to E3D's
   `E3DActions`/`E3DOutcomes`. (Paper §11.2 — the Action Engine stays separate.)
2. **One-way export.** No write path from the E3D UI / AWS back into the trading app
   or its state. The export plane is proof, not control.
3. **Deterministic safety floors are never relaxed by signal quality.** The Decision
   Layer raises signal quality upstream of the floors; the floors (liquidity, mcap,
   slippage, fraud) always run.
4. **Paper-mode only.** No live trading, no custody, no order execution. (Paper §14.3.)
5. **`W` = LLM policy, not deterministic weights.** Retraining updates scout/harvest
   adapters; the scorecard weights and gate floors are fixed by design.
6. **`training-events.jsonl` is authoritative**; the learning plane reads it directly
   and is independent of the export plane.

---

## 7. Where We Follow vs. Extend the Paper

| Paper construct | Implementation | Relationship |
|---|---|---|
| `Sₜ`, `Θₜ` | E3D `/stories`, `/candidates`, `/theses` | Faithful (consumer) |
| `Aₜ = f_A(Θ,R,C,U,H)` | E3D `/actions` (Q_A) **+** capital-aware executor verdict | **Extends** — adds liquidity/sizing/regime/portfolio |
| `Q_A` | `action_score` consumed verbatim; local `composite_score` proxy otherwise | Faithful + proxy |
| `O_{t+h} = f_O(P,L,V,N,D)` | E3D `/outcome` **+** local PnL/return/drawdown/direction **[post-fidelity]** | Faithful + partial local `f_O` |
| `Q_O`, `Φ` | Delegated to E3D; mirrored locally by PnL/confirmation correlation | Faithful (delegated) |
| Defensive outcomes (§7) | **[post-fidelity]** validated-rejection tracking | Now realized |
| `W_{t+1} = W + η∇𝓛` | Weekly LoRA retrain of scout + harvest **[post-fidelity: both outcome-conditioned]** | Faithful, **exceeds v1 bar** |
| Statistical tracking (§9) | `signalAttribution.js`, promotion/performance reports | Faithful |
| UI / Thesis scorecard (§13) | Export bridge → "Agent Verdicts" page + newsletter | Faithful |
| `E3DLearningSignals` (§12.3) | Not materialized as a table; attribution reports are the analog | **Gap** (acceptable per paper) |
| `Δ_E3D` benchmark (§16.5) | Derivable from attribution groupings; not yet a first-class metric | **Gap / opportunity** |

---

## 8. Open Items (beyond the fidelity ticket)

- **Materialize `E3DLearningSignals`** (paper §12.3) from attribution output, for a
  structured record of feature-weight adjustments.
- **First-class `Δ_E3D`** — expectancy of E3D-action-sourced trades vs. baseline,
  the paper's headline long-term validation metric (§16.5).
- **Horizon-aware outcome windows** — grade at the action's declared
  `expected_horizon` rather than fixed 1h/4h/24h/7d buckets.
- **Multi-factor local `Q_O`** — populate liquidity/volume/holder deltas (the export
  schema already has the columns) to fully realize `f_O` locally.

---

## 9. Math Symbol → Implementation Map

| Symbol | Meaning | Where it lives |
|---|---|---|
| `Gₜ` | on-chain graph | E3D Core (not in this repo) |
| `Sₜ` | Story | `/stories`, `/candidates` |
| `Θₜ` | Thesis | `/theses` |
| `Aₜ` | Action | E3D `/actions` (Q_A) + executor verdict |
| `Rₜ` | risk | risk engine + safety floors + `risk_score` |
| `Cₜ` | confidence | thesis conviction / action `confidence` |
| `Uₜ` | objective | `buildRegimeSentinelPolicy` + portfolio constraints |
| `Hₜ` | horizon | `expected_horizon` on the action |
| `Q_A` | action score | `action_score` (E3D) / `composite_score` (local proxy) |
| `O_{t+h}` | outcome | `recordOutcomes.js` + E3D `/outcome` |
| `Q_O` | outcome score | E3D `outcome_score` |
| `Φ` | confirmation | E3D `confirmation_score` / `thesis_confirmed` |
| `Wₜ` | weights | Qwen scout + harvest LoRA adapters |
| `η∇𝓛` | update | `mlx_lm.lora` gradient step on outcome-labeled data |

---

*E3D Decision Layer — System Architecture & Paper Alignment — 2026-05-21*
