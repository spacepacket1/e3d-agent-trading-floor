# Manager Agent — Specification

## Purpose

The Manager Agent is a post-cycle evaluator. It runs once per pipeline cycle after all four agents (Scout, Harvest, Risk, Executor) have completed, reads their outputs from the training event log and cycle state, and writes a structured report to the `reports/` folder. The dashboard gains a new Reports page to display those reports as collapsible summaries.

The Manager Agent does not trade, propose candidates, or influence live decisions. Its sole job is to observe, score, and report.

---

## Position in the Pipeline

Current cycle sequence (simplified):

```
Scout → Harvest → Risk → Executor → Portfolio Engine → cycle_end
```

Manager runs as step 17, after `cycle_end` is logged:

```
Scout → Harvest → Risk → Executor → Portfolio Engine → cycle_end → Manager
```

Manager receives a frozen snapshot of the completed cycle. It cannot alter any outcome of that cycle.

---

## What the Manager Evaluates

### 1. Scout

| Dimension | Source | What Good Looks Like |
|---|---|---|
| Story coverage | `stories_checked[]` vs. required story types | coverage_pct ≥ 0.85 |
| Candidate quality | `conviction_score`, `opportunity_score`, `fraud_risk` per candidate | conviction ≥ 0.65, fraud_risk < 35 |
| Evidence depth | `evidence[]` length per candidate | ≥ 3 evidence items |
| Disqualifier discipline | Presence of WASH_TRADE / LOOP / LIQUIDITY_DRAIN checks | All three sweep types present |
| Output validity | JSON parses, required fields present | No missing fields |
| LLM health | `finish_reason`, `total_tokens`, `duration_ms` | finish_reason = "stop", tokens < 5800 |

Required story-type sweeps for Scout (must appear in `stories_checked`):
- Disqualifiers: `WASH_TRADE`, `LOOP`, `LIQUIDITY_DRAIN`, `SPREAD_WIDENING`
- Buy signals: `ACCUMULATION`, `SMART_MONEY`, `BREAKOUT_CONFIRMED`, `MOVER`, `SURGE`

### 2. Harvest

| Dimension | Source | What Good Looks Like |
|---|---|---|
| Story coverage | `stories_checked[]` vs. required types | coverage_pct ≥ 0.85 |
| Position review completeness | Every held position has a `position_review` entry | review_count = position_count |
| Exit rationale quality | `evidence[]` present on every exit_candidate | ≥ 2 items per exit candidate |
| Exit fraction discipline | `suggested_exit_fraction` between 0.1 and 1.0 | No zero or negative fractions |
| Conservative bias | Exits proposed vs. positions held ratio | ≤ 0.5 (Harvest should not propose mass exits) |
| LLM health | Same as Scout | finish_reason = "stop" |

Required story-type sweeps for Harvest (must appear in `stories_checked`):
- Exit risk: `LIQUIDITY_DRAIN`, `RUG_LIQUIDITY_PULL`, `SPREAD_WIDENING`, `CONCENTRATION_SHIFT`
- Hold confirmation: `ACCUMULATION`, `SMART_MONEY`

### 3. Risk

| Dimension | Source | What Good Looks Like |
|---|---|---|
| Decision completeness | Every candidate has a risk_decision event | decisions = candidates submitted |
| Reason codes present | `reason_codes[]` non-empty on every decision | ≥ 1 reason code per decision |
| Hard limit enforcement | reject when fraud_risk ≥ 35 or confidence ≤ 55 | 100% enforcement rate |
| Quant gate firing | Funding rate / regime / order flow gates triggered when conditions met | Logged in `reason_codes` |
| Approval rate health | approvals / total decisions | 10%–60% range is healthy; outside is a signal |
| Paper mode discipline | No `approve_for_executor` decisions while `paper_mode = true` | Zero live approvals in paper mode |

### 4. Executor

| Dimension | Source | What Good Looks Like |
|---|---|---|
| Decision completeness | Every Risk-approved candidate has an executor_decision | decisions = risk-approved count |
| Blocker list quality | `blocker_list[]` present on every reject | ≥ 1 blocker on rejects |
| Paper trade ticket validity | `paper_trade_ticket` has symbol, size, price, timestamp | All fields non-null |
| Live execution gate | `live_execution_allowed = false` in paper mode | Always false in paper mode |
| Follow-up action set | `follow_up_action` non-null | Present on every decision |

### 5. Pipeline-Level

| Dimension | Source | What Good Looks Like |
|---|---|---|
| Cycle duration | `cycle_end.ts` - `cycle_start.ts` | < 300 seconds |
| LLM truncations | Any `finish_reason = "length"` in pipeline log | Zero truncations |
| LLM errors | `llm_error` events | Zero errors |
| API error rate | `api_error` events vs. total API calls | < 5% |
| Portfolio delta | equity_usd change cycle over cycle | No single-cycle drop > 5% |
| Market regime applied | `regimePolicy` gate fired on buy engine | Consistent with fear_greed_value |
| Rotation executed | Rotation engine outcome | Logged with rotation reason if triggered |

---

## Report Structure

Each cycle produces one report file.

### File path

```
reports/cycle-YYYYMMDD-HHMMSS-{cycle_id_short}.json
```

Example: `reports/cycle-20260414-143022-a3f2.json`

The `cycle_id_short` is the first 4 characters of the `cycle_id` UUID from the training event. This keeps filenames unique and traceable.

### JSON schema

```json
{
  "report_id": "uuid-v4",
  "generated_at": "ISO8601",
  "cycle_id": "full cycle UUID",
  "pipeline_run_id": "full run UUID",
  "cycle_index": 42,
  "cycle_duration_seconds": 187,
  "market_regime": "risk_on | neutral | risk_off",
  "fear_greed_value": 62,
  "overall_grade": "A | B | C | D | F",
  "overall_score": 88,
  "summary": "One or two sentence plain-English summary of this cycle.",
  "flags": [
    {
      "severity": "critical | warning | info",
      "agent": "scout | harvest | risk | executor | pipeline",
      "code": "SHORT_SNAKE_CASE_CODE",
      "message": "Human-readable explanation."
    }
  ],
  "agents": {
    "scout": {
      "grade": "A | B | C | D | F",
      "score": 91,
      "coverage_pct": 0.90,
      "candidates_proposed": 2,
      "candidates_with_full_evidence": 2,
      "llm_finish_reason": "stop",
      "llm_tokens": 4821,
      "llm_duration_ms": 12400,
      "flags": []
    },
    "harvest": {
      "grade": "B",
      "score": 78,
      "coverage_pct": 0.80,
      "positions_reviewed": 4,
      "positions_held": 4,
      "exit_candidates": 1,
      "exits_with_evidence": 1,
      "llm_finish_reason": "stop",
      "llm_tokens": 3910,
      "llm_duration_ms": 9800,
      "flags": []
    },
    "risk": {
      "grade": "A",
      "score": 95,
      "decisions_made": 3,
      "approved": 1,
      "rejected": 2,
      "approval_rate": 0.33,
      "hard_limit_breaches_caught": 1,
      "quant_gates_fired": ["funding_rate_gate"],
      "flags": []
    },
    "executor": {
      "grade": "A",
      "score": 92,
      "decisions_made": 1,
      "paper_trades_recorded": 1,
      "live_execution_allowed": false,
      "flags": []
    }
  },
  "portfolio_snapshot": {
    "cash_usd": 94200,
    "equity_usd": 108500,
    "position_count": 4,
    "realized_pnl_usd": 1200,
    "unrealized_pnl_usd": 7100,
    "max_drawdown_pct": 3.2
  },
  "cycle_actions": {
    "buys": [
      { "symbol": "TOKEN", "size_usd": 1500, "decision": "paper_trade", "conviction": 0.71 }
    ],
    "sells": [],
    "rotations": []
  }
}
```

### Grade scale

| Score | Grade | Meaning |
|---|---|---|
| 90–100 | A | Clean cycle, all agents performed well |
| 75–89 | B | Minor issues, no critical flags |
| 60–74 | C | Degraded performance, at least one warning |
| 45–59 | D | Significant problems, critical flag present |
| < 45 | F | Severe failure, manual review required |

### Flag codes

| Code | Severity | Agent | Trigger |
|---|---|---|---|
| `SCOUT_LOW_COVERAGE` | warning | scout | coverage_pct < 0.85 |
| `SCOUT_MISSING_DISQUALIFIERS` | critical | scout | WASH_TRADE, LOOP, or LIQUIDITY_DRAIN absent from stories_checked |
| `SCOUT_LLM_TRUNCATED` | critical | scout | finish_reason = "length" |
| `SCOUT_LLM_ERROR` | critical | scout | llm_error event present for scout call |
| `SCOUT_THIN_EVIDENCE` | warning | scout | any candidate has < 3 evidence items |
| `SCOUT_HIGH_FRAUD_CANDIDATE` | warning | scout | any candidate with fraud_risk ≥ 35 proposed (Risk should catch this) |
| `HARVEST_LOW_COVERAGE` | warning | harvest | coverage_pct < 0.85 |
| `HARVEST_INCOMPLETE_REVIEWS` | critical | harvest | positions_reviewed < positions_held |
| `HARVEST_LLM_TRUNCATED` | critical | harvest | finish_reason = "length" |
| `HARVEST_MASS_EXIT_SIGNAL` | warning | harvest | exit_candidates / positions_held > 0.5 |
| `RISK_INCOMPLETE_DECISIONS` | critical | risk | decisions_made < candidates_submitted |
| `RISK_HARD_LIMIT_MISS` | critical | risk | approved candidate with fraud_risk ≥ 35 or confidence ≤ 55 |
| `RISK_LIVE_APPROVAL_IN_PAPER` | critical | risk | approve_for_executor decision when paper_mode = true |
| `RISK_ZERO_REASON_CODES` | warning | risk | any decision with empty reason_codes |
| `RISK_APPROVAL_RATE_HIGH` | warning | risk | approval_rate > 0.60 |
| `RISK_APPROVAL_RATE_LOW` | info | risk | approval_rate = 0 for 3+ consecutive cycles |
| `EXECUTOR_INCOMPLETE_DECISIONS` | critical | executor | decisions_made < risk_approved_count |
| `EXECUTOR_MISSING_BLOCKERS` | warning | executor | any reject with empty blocker_list |
| `EXECUTOR_LIVE_TRADE_IN_PAPER` | critical | executor | live_execution_allowed = true when paper_mode = true |
| `EXECUTOR_INVALID_TICKET` | critical | executor | paper_trade_ticket with null symbol, price, or size |
| `PIPELINE_SLOW_CYCLE` | warning | pipeline | cycle_duration_seconds > 300 |
| `PIPELINE_LLM_ERROR` | critical | pipeline | any llm_error in pipeline log |
| `PIPELINE_API_ERROR_RATE` | warning | pipeline | api error rate > 5% |
| `PIPELINE_EQUITY_DROP` | critical | pipeline | equity_usd dropped > 5% in one cycle |

---

## Scoring Formula

Each agent score (0–100):

```
agent_score = base_score - sum(deductions)
```

Deductions per flag:
- critical: -20 points
- warning: -8 points
- info: -2 points

Base score: 100. Score floor: 0.

Overall cycle score:

```
overall_score = (scout_score * 0.25)
              + (harvest_score * 0.25)
              + (risk_score * 0.25)
              + (executor_score * 0.15)
              + (pipeline_score * 0.10)
```

`pipeline_score` is computed the same way (100 - deductions for pipeline-scoped flags).

---

## Manager Agent Workspace

The manager follows the same workspace conventions as the other four agents.

```
manager/
├── AGENTS.md      # Role description and coordination note
├── SOUL.md        # Core principles: observe, don't interfere
├── TOOLS.md       # Evaluation protocol (mirrors the scoring logic above)
├── IDENTITY.md    # Agent identity
├── MEMORY.md      # Persistent memory (pattern tracking across cycles)
├── HEARTBEAT.md   # Last known status
└── USER.md        # Notes from the operator
```

Unlike Scout, Harvest, Risk, and Executor, the Manager Agent does **not** need to call the LLM to produce a report. The manager evaluation is deterministic: it reads training events, applies the scoring formula above, and writes JSON. An LLM pass is optional and additive — the `summary` field in the report can be generated by an LLM call to produce a human-readable one-sentence narrative, but the report is complete and valid without it.

If an LLM summary is generated, it is appended after the deterministic evaluation completes and uses a short prompt (~500 tokens):

```
You are the Manager Agent for the E3D trading floor.
Below is a completed cycle report in JSON. Write a single plain-English sentence (max 30 words)
summarizing the overall quality of this cycle. Be direct and specific. No emojis.

{report_json}
```

---

## Implementation Plan

### 1. `reports/` directory

Create `reports/` at the repo root. Add a `.gitkeep` so the directory is tracked. Each report file is JSON, named by timestamp + cycle_id_short.

### 2. `runManagerDirect(cycleState)` in `pipeline.js`

New function called at step 17 after `cycle_end` is logged. Takes a `cycleState` object:

```js
{
  cycle_id,
  pipeline_run_id,
  cycle_index,
  cycle_start_ts,
  cycle_end_ts,
  market_regime,
  fear_greed_value,
  scout_result,          // raw output from runScoutDirect
  scout_coverage,        // output from buildAgentCoverageLog for scout
  scout_llm_meta,        // { finish_reason, total_tokens, duration_ms }
  harvest_result,        // raw output from runHarvestDirect
  harvest_coverage,      // output from buildAgentCoverageLog for harvest
  harvest_llm_meta,
  risk_decisions,        // array of risk_decision training events for this cycle
  executor_decisions,    // array of executor_decision training events
  cycle_actions,         // { buys[], sells[], rotations[] }
  portfolio_snapshot,    // from cycle_end training event
  pipeline_log_entries,  // llm_request/llm_response/api_call entries for this cycle
}
```

`runManagerDirect` is synchronous and does not call the LLM by default. It returns the completed report object and writes it to `reports/`.

### 3. Training event for manager

Log a new `manager_report` training event at the end of the manager run:

```json
{
  "event_type": "manager_report",
  "actor": "manager",
  "payload": {
    "report_id": "...",
    "overall_grade": "B",
    "overall_score": 82,
    "critical_flags": 0,
    "warning_flags": 2,
    "report_file": "reports/cycle-20260414-143022-a3f2.json"
  }
}
```

### 4. Server endpoint

Add to `server.js`:

```
GET /api/reports              → list of report files (newest first, max 50)
GET /api/reports/:report_id   → full report JSON
```

The list response is an array of lightweight summaries:

```json
[
  {
    "report_id": "uuid",
    "generated_at": "ISO8601",
    "cycle_index": 42,
    "overall_grade": "B",
    "overall_score": 82,
    "critical_flags": 0,
    "warning_flags": 2,
    "market_regime": "neutral",
    "cycle_duration_seconds": 187,
    "report_file": "reports/cycle-20260414-143022-a3f2.json"
  }
]
```

### 5. Dashboard — Reports page

New hash route: `#reports`

Add "Reports" to the nav bar between "Activity" and "Settings".

#### Reports page layout

The page has two zones: a **summary list** on the left (or top on narrow screens) and a **detail panel** on the right (or expanded below on click).

**Summary list** — one row per report, newest first:

```
[Grade badge]  Cycle #42  |  Apr 14 14:30  |  neutral  |  ⚠ 2 warnings  |  187s  [▶ expand]
```

Clicking a row or the expand arrow opens the detail panel inline (accordion style — the row expands downward, pushing subsequent rows down).

**Detail panel** (expanded view for one report):

```
─────────────────────────────────────────────────────
  Cycle #42 — Apr 14, 2026 14:30:22   Grade: B (82)
  "Clean cycle. Risk correctly applied funding rate gate."
─────────────────────────────────────────────────────
  Flags
  ⚠ SCOUT_THIN_EVIDENCE — TOKEN had only 2 evidence items.
  ℹ RISK_APPROVAL_RATE_LOW — No approvals for 3 consecutive cycles.
─────────────────────────────────────────────────────
  Agents          Score   Grade   Notes
  Scout             88      B     coverage 90%, 2 candidates
  Harvest           91      A     4/4 positions reviewed
  Risk              95      A     1 approved / 2 rejected
  Executor          92      A     1 paper trade recorded
  Pipeline          85      B     cycle 187s, no LLM errors
─────────────────────────────────────────────────────
  Portfolio Snapshot
  Equity $108,500  |  Cash $94,200  |  4 positions
  Unrealized PnL +$7,100  |  Max Drawdown 3.2%
─────────────────────────────────────────────────────
  Actions This Cycle
  Buys:  TOKEN @ $1,500 (paper_trade, conviction 0.71)
  Sells: none   Rotations: none
─────────────────────────────────────────────────────
```

**Grade badge colors** (consistent with existing `MetricCard` tone system):
- A → green (`#4ade80` / `tone-positive`)
- B → blue-gray (`tone-neutral`)
- C → amber (`tone-caution`)
- D → orange (`tone-warning`)
- F → red (`tone-critical`)

**Flag icons**:
- critical → red circle with `!`
- warning → amber triangle with `⚠`
- info → blue circle with `i`

#### Data flow

```
App component polls GET /api/reports on mount of Reports page (and on "Refresh").
Reports list is stored in component state: reports[].
Expanded row index tracked in: expandedReportId state.
Full report JSON fetched lazily on first expand of a given row: GET /api/reports/:report_id.
```

No WebSocket subscription needed — reports are immutable once written.

---

## Open Questions / Future Work

1. **Trend view**: Once 10+ reports exist, add a sparkline on the Reports page showing overall_score over time and per-agent score trends.

2. **LLM summary toggle**: The `summary` field can be populated by an optional LLM call. A settings toggle could enable/disable this ("Manager LLM summaries") without affecting the deterministic scoring.

3. **Alert threshold config**: The flag thresholds (coverage_pct cutoffs, approval_rate bounds, cycle duration limit) are currently hardcoded in the scoring logic. A future `manager/MEMORY.md` section could store operator-adjusted thresholds that the manager reads at runtime.

4. **Cross-cycle pattern memory**: The manager could track rolling metrics across the last N cycles (e.g., "Scout coverage has been below 0.85 for 5 consecutive cycles") and surface persistent patterns as a separate `patterns[]` array in the report.

5. **Slack / webhook notifications**: For `critical` flags, a post-cycle webhook call to a configured URL would allow operator alerting without polling the dashboard.
