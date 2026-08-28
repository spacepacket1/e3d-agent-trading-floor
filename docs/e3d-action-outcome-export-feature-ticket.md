# Feature Ticket: E3D Action/Outcome Export Bridge

**Project:** E3D Agent Trading Floor → E3D Production Platform  
**Feature:** Export agent verdicts, paper actions, trades, and outcomes from local trading ClickHouse into AWS E3D ClickHouse  
**Target repos:**

1. `e3d-agent-trading-floor` — producer/exporter side
2. E3D main repo — consumer/UI/newsletter side, if needed in a follow-up ticket

**Primary new file:**

```text
scripts/e3dActionOutcomeExport.js
```

**Status:** Ready for implementation  
**Priority:** High  
**Goal:** Turn the trading app into the E3D Action/Outcome Engine without requiring automatic live trading.

---

## 1. Executive Summary

The E3D trading app already runs agentic reasoning over E3D-derived intelligence. It contains scout, harvest, risk, executor, portfolio, sizing, liquidity, market-regime, and paper-trade logic. It also already records rich local telemetry into `logs/training-events.jsonl` on every cycle.

The next feature is to add a **one-way exporter** that maps those local trading-app records into clean, product-facing E3D Action/Outcome records in the AWS E3D ClickHouse database.

The objective is **not** to rebuild the trading app. The objective is to expose its most valuable output:

```text
E3D intelligence → agent verdict → simulated capital action → outcome → proof
```

This exporter becomes the bridge between:

```text
Local trading app / private lab
        ↓
Normalized action/outcome export
        ↓
AWS E3D production database
        ↓
E3D UI + newsletter + future scorecards
```

---

## 2. Strategic Context

E3D already has a Decision Layer Action Page supported by story scripts. That layer answers:

> What did E3D detect, and what should be watched or considered?

The trading app adds the higher-level agentic decision layer. It answers:

> Given risk, liquidity, portfolio constraints, slippage, position sizing, market regime, and agent reasoning, what would a disciplined agent actually do?

Therefore, the trading app should be reframed from a “trading app” into the **E3D Action/Outcome Engine** or **E3D Agent Verdict Engine**.

The first production step is to export normalized records from local ClickHouse into the E3D AWS database, so the E3D UI and newsletter can display:

- Agent verdicts
- Paper buys/sells/holds/rejections
- Risk-approved and risk-rejected decisions
- Simulated trade outcomes
- Profit/loss outcomes
- Action scorecards
- Validated and invalidated theses
- “Rejected risk” receipts

---

## 3. Existing Trading App Evidence Stream

The current `pipeline.js` already defines local persistence behavior.

Default local ClickHouse configuration:

```js
const CLICKHOUSE_HTTP_URL = process.env.E3D_CLICKHOUSE_HTTP_URL || "http://127.0.0.1:8123";
const CLICKHOUSE_DATABASE_NAME = process.env.E3D_CLICKHOUSE_DATABASE || "e3d";
const CLICKHOUSE_TABLE_NAME = process.env.E3D_CLICKHOUSE_TABLE || "training_events";
```

Current `training_events` schema is created in `ensurePersistentStores()`:

```sql
CREATE TABLE IF NOT EXISTS e3d.training_events (
  event_id String,
  schema_version String,
  ts String,
  event_type String,
  actor String,
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime String,
  candidate_id String,
  position_id String,
  trade_id String,
  payload String
)
ENGINE = MergeTree
ORDER BY (ts, event_type, event_id)
```

Relevant existing event writers:

- `recordCandidateEvent(...)`
- `recordRiskDecisionEvent(...)`
- `recordRiskEngineDecisionEvent(...)`
- `recordExecutorDecisionEvent(...)`
- `recordTradeEvent(...)`
- `recordOutcomeEvent(...)`
- `recordAuxiliaryEvent(...)`
- `recordCycleEvent(...)`

The exporter should reuse these existing events rather than modifying core trading logic.

---

## 4. Core Requirement

Create `scripts/e3dActionOutcomeExport.js` in the `e3d-agent-trading-floor` repo.

The script must:

1. Read local trading app records from `logs/training-events.jsonl`.
2. Select relevant event records by `event_type`.
3. Parse each event’s `payload` JSON.
4. Map internal event records into stable E3D-facing schemas.
5. Insert mapped records into AWS E3D ClickHouse tables.
6. Avoid duplicate logical records.
7. Maintain a local export watermark.
8. Support dry-run mode.
9. Be safe to run repeatedly by cron/systemd.
10. Log useful summaries and errors.

---

## 5. Non-Goals

Do **not** implement automatic live trading in this ticket.

Do **not** rewrite scout, harvest, risk, executor, portfolio, or paper-trade logic.

Do **not** force the E3D production UI to consume raw `training_events` directly.

Do **not** create user-specific custom agents.

Do **not** create two-way sync between AWS E3D and the local trading app.

Do **not** mutate local trading-app state based on AWS data.

This feature is a **one-way export bridge**:

```text
logs/training-events.jsonl → AWS E3D ClickHouse
```

---

## 6. Architecture

### 6.1 Data Flow

```text
pipeline.js
  ↓
logs/training-events.jsonl              ← primary source (always written)
  OR
local ClickHouse: e3d.training_events   ← optional source (--source-clickhouse flag)
  ↓
scripts/e3dActionOutcomeExport.js
  ↓
AWS ClickHouse:
  - E3DAgentActions
  - E3DAgentOutcomes
  - E3DAgentCycleScorecards
  - optional E3DAgentExportAudit
  ↓
E3D UI / newsletter / future APIs
```

### 6.2 Local Source

**Primary source: `logs/training-events.jsonl`**

`pipeline.js` always appends to `logs/training-events.jsonl` via
`fs.appendFileSync` before attempting ClickHouse. The ClickHouse write is a
best-effort side-channel that has never reliably succeeded: the pipeline's
`clickHouseQuery` sends no auth headers, ClickHouse requires a password, and
all insert attempts fail silently with a logged `clickhouse_sync_error`. As a
result, `logs/training-events.jsonl` is the authoritative record of all
training events (18,000+ rows as of 2026-05-20).

The exporter **reads from the JSONL file by default**.

Allow override via environment variables:

```bash
TRAINING_EVENT_LOG=logs/training-events.jsonl   # default; override if log path changes
```

**ClickHouse source (opt-in):** Pass `--source-clickhouse` to read from local
ClickHouse instead. This is only useful if the pipeline is later reconfigured to
supply credentials. The JSONL filters (`--since-hours`, `--from-ts`, `--to-ts`)
apply identically against the `ts` field whether source is JSONL or ClickHouse.

If `--source-clickhouse` is set, read credentials from:

```bash
LOCAL_CLICKHOUSE_HTTP_URL=http://127.0.0.1:8123
LOCAL_CLICKHOUSE_DATABASE=e3d
LOCAL_CLICKHOUSE_USER=default
LOCAL_CLICKHOUSE_PASSWORD=
LOCAL_TRAINING_EVENTS_TABLE=training_events
```

On ClickHouse auth error (HTTP 516) or connection failure, exit non-zero with a
clear message recommending the default JSONL mode.

### 6.3 AWS Destination

Use separate env vars so we do not confuse local and production destinations:

```bash
AWS_E3D_CLICKHOUSE_HTTP_URL=https://your-aws-clickhouse-host:8123
AWS_E3D_CLICKHOUSE_DATABASE=e3d
AWS_E3D_CLICKHOUSE_USER=default
AWS_E3D_CLICKHOUSE_PASSWORD=...
AWS_E3D_CLICKHOUSE_SECURE=true
```

If the existing E3D app uses a different env naming convention, adapt to match that repo’s standards, but keep source/destination names clearly separate.

---

## 7. Recommended Runtime Model

### 7.1 Development

Run manually first:

```bash
node scripts/e3dActionOutcomeExport.js --since-hours=24 --dry-run
node scripts/e3dActionOutcomeExport.js --since-hours=24
```

### 7.2 Initial Production

Run every 5 minutes via cron on the machine running the trading app:

```cron
*/5 * * * * cd /Users/mini/e3d-agent-trading-floor && /usr/local/bin/node scripts/e3dActionOutcomeExport.js >> logs/e3d-action-outcome-export.log 2>&1
```

### 7.3 Later Production

After stable operation, either:

- keep cron every 5 minutes, or
- move to `systemd` timer on Linux, or
- run every 1 minute if near-real-time E3D UI updates are needed.

Do not implement a long-running daemon in this ticket unless explicitly requested later.

---

## 8. Dedupe and Watermark Strategy

Use **two layers of duplicate protection**:

1. Local export watermark with overlap window
2. Deterministic IDs in destination tables

### 8.1 Local State File

Create:

```text
state/e3d-action-outcome-export-state.json
```

Example:

```json
{
  "schema_version": "1.0",
  "last_watermark_ts": "2026-05-19T20:15:00-07:00",
  "last_event_id": "event-id",
  "last_run_started_at": "2026-05-19T20:20:00-07:00",
  "last_run_completed_at": "2026-05-19T20:20:12-07:00",
  "last_success_count": 248,
  "last_error": null
}
```

### 8.2 Lock File

Create:

```text
state/e3d-action-outcome-export.lock
```

Behavior:

- If lock exists and is recent, exit with a clear log message.
- If lock exists but is stale, remove it and continue.
- Default stale threshold: 30 minutes.

### 8.3 Overlap Window

Each export should query slightly before the last watermark to avoid missing late or out-of-order records.

Default:

```text
EXPORT_OVERLAP_MINUTES=10
```

Filter concept (applied while streaming `logs/training-events.jsonl`):

```js
const cutoff = new Date(lastWatermarkTs).getTime() - overlapMinutes * 60 * 1000;
const allowed = new Set(["executor_decision", "trade", "outcome"]);

for (const row of readJsonlLines(TRAINING_EVENT_LOG)) {
  if (new Date(row.ts).getTime() < cutoff) continue;
  if (!allowed.has(row.event_type)) continue;
  yield row;
  if (++count >= limit) break;
}
```

On first run, compute `cutoff` from `--since-hours` (default 24h from now).

### 8.4 Deterministic IDs

Generate stable IDs so rerunning the exporter does not create duplicate logical records.

#### Action ID

```js
action_id = sha256([
  pipeline_run_id,
  cycle_id,
  candidate_id,
  trade_id,
  event_type,
  actor,
  normalizedDecision,
  normalizedTokenAddress
].join("|"));
```

#### Outcome ID

```js
outcome_id = sha256([
  action_id,
  trade_id,
  position_id,
  outcome_window,
  measured_at,
  event_type
].join("|"));
```

#### Cycle Scorecard ID

```js
scorecard_id = sha256([
  pipeline_run_id,
  cycle_id,
  cycle_index
].join("|"));
```

### 8.5 ClickHouse Deduping

Use `ReplacingMergeTree(updated_at)` for AWS destination tables.

This allows repeat inserts of the same deterministic ID while keeping the latest version queryable.

---

## 9. Event Types to Export

### 9.1 Minimum Set (implement first)

Export these first:

```text
executor_decision
trade
outcome
```

### 9.2 Expansion Set (future ticket)

Add:

```text
candidate
risk_decision
risk_engine_decision
cycle_start
cycle_end
manager_report
regime_policy
signal_snapshot
token_risk_scan
market_data_quality
```

### 9.3 Mapping Concept

```text
executor_decision → E3DAgentActions
trade             → E3DAgentOutcomes or E3DAgentExecutions
outcome           → E3DAgentOutcomes
cycle_*           → E3DAgentCycleScorecards
risk_*            → enrich actions with risk verdicts
candidate         → enrich actions with scout candidate context
```

For this ticket, create core tables and map the minimum set. Leave obvious extension points for the rest.

---

## 10. Destination Schema

### 10.1 `E3DAgentActions`

Purpose: one row per agent verdict/action candidate.

```sql
CREATE TABLE IF NOT EXISTS e3d.E3DAgentActions
(
  action_id String,
  updated_at DateTime64(3),
  created_at DateTime64(3),

  source_app LowCardinality(String),
  source_schema_version String,
  source_event_id String,
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime LowCardinality(String),

  token_address String,
  symbol String,
  chain LowCardinality(String),

  agent_stage LowCardinality(String),
  actor LowCardinality(String),
  event_type LowCardinality(String),
  trade_kind LowCardinality(String),

  agent_decision LowCardinality(String),
  action_type LowCardinality(String),
  simulated_side LowCardinality(String),

  candidate_id String,
  position_id String,
  trade_id String,

  entry_price Float64,
  allocation_usd Float64,
  confidence_score Float64,
  risk_score Float64,
  liquidity_usd Float64,
  slippage_bps Float64,
  fee_bps Float64,

  thesis_summary String,
  reason_summary String,
  reject_reason String,

  source_story_ids Array(String),
  source_signal_types Array(String),
  evidence_packet_id String,
  risk_decision_id String,

  payload_json String
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (action_id);
```

Notes:

- `agent_decision` examples: `approve`, `reject`, `buy`, `sell`, `hold`, `wait`, `exit`, `unknown`
- `action_type` examples: `PAPER_BUY`, `PAPER_SELL`, `PAPER_HOLD`, `PAPER_EXIT`, `REJECT`, `WAIT`, `RISK_ALERT`, `WATCH`
- `simulated_side` examples: `buy`, `sell`, `hold`, `none`

### 10.2 `E3DAgentOutcomes`

Purpose: one row per simulated trade or outcome observation.

```sql
CREATE TABLE IF NOT EXISTS e3d.E3DAgentOutcomes
(
  outcome_id String,
  action_id String,
  updated_at DateTime64(3),
  measured_at DateTime64(3),

  source_app LowCardinality(String),
  source_schema_version String,
  source_event_id String,
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime LowCardinality(String),

  token_address String,
  symbol String,
  chain LowCardinality(String),

  candidate_id String,
  position_id String,
  trade_id String,

  outcome_type LowCardinality(String),
  outcome_window LowCardinality(String),
  outcome_label LowCardinality(String),
  verdict LowCardinality(String),

  entry_price Float64,
  exit_price Float64,
  current_price Float64,
  price_delta_pct Float64,
  pnl_usd Float64,
  pnl_pct Float64,
  max_gain_pct Float64,
  max_drawdown_pct Float64,
  holding_days Float64,

  liquidity_delta_pct Float64,
  volume_delta_pct Float64,
  holder_delta_pct Float64,

  payload_json String
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (outcome_id);
```

Notes:

- In phase 1, many delta fields may be `0` or `NULL-equivalent`. That is acceptable.
- `outcome_window` may initially be `realized`, `trade`, or `unknown`.
- Later, add scheduled 1h/4h/24h/7d snapshot outcomes.

### 10.3 `E3DAgentCycleScorecards`

Purpose: one row per pipeline cycle or run-level summary.

```sql
CREATE TABLE IF NOT EXISTS e3d.E3DAgentCycleScorecards
(
  scorecard_id String,
  updated_at DateTime64(3),
  created_at DateTime64(3),

  source_app LowCardinality(String),
  pipeline_run_id String,
  cycle_id String,
  cycle_index Int32,
  market_regime LowCardinality(String),

  scout_candidates Int32,
  risk_approved Int32,
  risk_rejected Int32,
  executor_decisions Int32,
  paper_buys Int32,
  paper_sells Int32,
  paper_holds Int32,
  paper_rejections Int32,

  cash_usd Float64,
  equity_usd Float64,
  realized_pnl_usd Float64,
  unrealized_pnl_usd Float64,
  open_positions Int32,

  warning_count Int32,
  critical_count Int32,
  score Float64,
  grade LowCardinality(String),

  payload_json String
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (scorecard_id);
```

This table can be sparse in phase 1. Implement if easy; otherwise leave as phase 2 with table creation included.

### 10.4 Optional `E3DAgentExportAudit`

Purpose: track exporter runs.

```sql
CREATE TABLE IF NOT EXISTS e3d.E3DAgentExportAudit
(
  export_run_id String,
  started_at DateTime64(3),
  completed_at DateTime64(3),
  status LowCardinality(String),
  source_min_ts String,
  source_max_ts String,
  source_events_read Int32,
  actions_written Int32,
  outcomes_written Int32,
  scorecards_written Int32,
  error_message String,
  payload_json String
)
ENGINE = MergeTree
ORDER BY (started_at, export_run_id);
```

---

## 11. Mapping Rules

### 11.1 Common Helpers

Implement helpers:

```js
function cleanAddress(value) { ... }
function toNum(value, fallback = 0) { ... }
function optionalNum(value) { ... }
function parsePayload(row) { ... }
function sha256String(value) { ... }
function normalizeTimestamp(value) { ... }
function safeJson(value) { ... }
```

Reuse logic from `pipeline.js` where appropriate, but avoid importing the full pipeline if that causes side effects.

### 11.2 Extract Token Identity

The token address location varies by `event_type` and `trade_kind`. Try these
locations in order (first non-empty match wins):

```js
// executor_decision — branches by trade_kind
if (trade_kind === "buy")      payload.action?.candidate?.token?.contract_address
if (trade_kind === "exit")     payload.action?.token?.contract_address
if (trade_kind === "rotation") payload.proposal?.action?.to_candidate?.token?.contract_address
// trade and outcome events
payload.trade?.contract_address
payload.position_before?.contract_address
// universal fallback — candidate_id is always an EVM address
row.candidate_id   // always an EVM address; safe final fallback
```

Symbol locations (same branching pattern):

```js
if (trade_kind === "buy")      payload.action?.candidate?.token?.symbol
if (trade_kind === "exit")     payload.action?.token?.symbol
if (trade_kind === "rotation") payload.proposal?.action?.to_candidate?.token?.symbol
payload.trade?.symbol
payload.position_before?.symbol
payload.review?.token?.symbol  // review.token may be a string or object; check typeof
```

Chain:

```js
if (trade_kind === "buy")      payload.action?.candidate?.token?.chain
if (trade_kind === "exit")     payload.action?.token?.chain
if (trade_kind === "rotation") payload.proposal?.action?.to_candidate?.token?.chain
// default
"ethereum"
```

### 11.3 Map `executor_decision` → `E3DAgentActions`

**Verified payload structure** (from real training_events data):

The top-level payload keys are:
`candidate_id`, `trade_kind`, `decision`, `proposal`, `review`, `action`, `portfolio_snapshot`

`payload.trade_kind` is one of `"buy"`, `"exit"`, `"rotation"`. The structure of
`payload.action` and `payload.proposal` differ by `trade_kind`.

**`payload.review`** always present; its relevant fields:
```js
payload.review.executor_decision  // "paper_trade", "reject", etc.
payload.review.reason_summary     // human-readable pass/fail reason
payload.review.blocker_list       // Array<string> — rejection reasons (may be empty)
payload.review.approved_size_pct  // portfolio allocation percentage (not USD)
payload.review.max_slippage_bps   // approved slippage cap
```

Note: `payload.review.token` may be a string (symbol only) or an object with
`.contract_address`. Always check `typeof` before reading sub-fields.

**`payload.action`** structure by `trade_kind`:

```
buy:
  payload.action.type === "buy"
  payload.action.candidate.token.{contract_address, symbol, chain}
  payload.action.candidate.confidence
  payload.action.candidate.conviction_score
  payload.action.candidate.why_now
  payload.action.candidate.liquidity_data.liquidity_usd
  payload.action.candidate.execution_data.estimated_slippage_bps
  payload.action.candidate.market_data.current_price
  payload.action.candidate.evidence_packet_id

exit:
  payload.action.source_agent === "harvest"
  payload.action.token.{contract_address, symbol, chain}
  payload.action.confidence
  payload.action.conviction_score
  payload.action.thesis_summary
  payload.action.why_now
  payload.action.fraud_risk
  payload.action.liquidity_data.liquidity_usd
  payload.action.execution_data.estimated_slippage_bps
  payload.action.market_data.current_price
  payload.action.evidence_packet_id

rotation:
  payload.proposal.action.to_candidate.token.{contract_address, symbol, chain}
  payload.proposal.action.to_candidate.confidence
  payload.proposal.action.to_candidate.conviction_score
  payload.proposal.action.to_candidate.why_now
  payload.proposal.action.to_candidate.liquidity_data.liquidity_usd
  payload.proposal.action.to_candidate.execution_data.estimated_slippage_bps
  payload.proposal.action.to_candidate.market_data.current_price
  payload.proposal.action.to_candidate.evidence_packet_id
  payload.proposal.action.from_symbol  // token being sold in the rotation
```

**NOTE:** `payload.action.paper_trade_ticket` is a plain string
(`"generated_paper_trade_id"`), not an object. Do not attempt to read sub-fields
from it.

**NOTE:** `source_story_ids` and `source_signal_types` do not exist in
`executor_decision` payloads. Set both to `[]`. They may be enriched later from
`candidate` events.

**NOTE:** `risk_decision_id` is present in the payload string but is always
`null` in executor_decision events. Set to `""`. The real risk_decision_id lives
in `risk_engine_decision` events and can be joined via `candidate_id` in a
future enrichment phase.

**NOTE:** `allocation_usd` is not stored directly. Derive it as:
```js
allocation_usd = (payload.review?.approved_size_pct / 100)
               * (payload.portfolio_snapshot?.cash_usd || 0)
```
If `portfolio_snapshot` is missing, set `allocation_usd = 0`.

**`risk_score`:** Not available in `executor_decision`. The risk score lives in
`risk_decision` events (`payload.risk_review.risk_score`). For phase 1, set
`risk_score = 0` in `E3DAgentActions` and note it can be back-filled by joining
on `candidate_id + cycle_id` from `risk_decision` events.

---

**Mapping:**

```js
// Helper: resolve the per-trade_kind candidate object
function getCandidateObj(payload) {
  const tk = payload.trade_kind;
  if (tk === "buy")      return payload.action?.candidate;
  if (tk === "exit")     return payload.action;          // action IS the harvest proposal
  if (tk === "rotation") return payload.proposal?.action?.to_candidate;
  return null;
}

// Map fields
const cand = getCandidateObj(payload);

agent_stage      = "executor"
agent_decision   = payload.review?.executor_decision || payload.decision || "unknown"
action_type      = inferActionType(agent_decision, payload.trade_kind)
simulated_side   = inferSide(payload.trade_kind, agent_decision)
entry_price      = cand?.market_data?.current_price || 0
allocation_usd   = ((payload.review?.approved_size_pct || 0) / 100)
                   * (payload.portfolio_snapshot?.cash_usd || 0)
confidence_score = cand?.conviction_score || cand?.confidence || 0
risk_score       = 0   // not in executor_decision; see note above
liquidity_usd    = cand?.liquidity_data?.liquidity_usd || 0
slippage_bps     = cand?.execution_data?.estimated_slippage_bps
                   || payload.review?.max_slippage_bps || 0
thesis_summary   = cand?.thesis_summary || cand?.why_now || ""
reason_summary   = payload.review?.reason_summary || ""
reject_reason    = (payload.review?.blocker_list || []).join("; ")
source_story_ids    = []    // not in executor_decision
source_signal_types = []    // not in executor_decision
evidence_packet_id  = cand?.evidence_packet_id || ""
risk_decision_id    = ""    // always null in executor_decision; enrich later
payload_json        = JSON.stringify(payload)
```

**`inferActionType(agent_decision, trade_kind)`** examples:
```js
"paper_trade" + "buy"      → "PAPER_BUY"
"paper_trade" + "exit"     → "PAPER_SELL"
"paper_trade" + "rotation" → "PAPER_BUY"   // the incoming leg
"reject"                   → "REJECT"
"wait"                     → "WAIT"
```

**`inferSide(trade_kind, agent_decision)`** examples:
```js
"buy"      → "buy"
"rotation" → "buy"
"exit"     → "sell"
"reject"   → "none"
"wait"     → "none"
```

### 11.4 Map `trade` → `E3DAgentOutcomes`

**Verified payload structure** (from real training_events data):

```js
payload.trade_id                   // String — unique trade ID
payload.position_id                // String — position ID
payload.candidate_id               // String — EVM address
payload.quoted_price               // Float — pre-slippage price
payload.fill_price                 // Float — actual fill (quoted * slippage applied)
payload.slippage_bps_applied       // Float — e.g. 100
payload.fee_bps_applied            // Float — e.g. 12.5
payload.fee_usd                    // Float
payload.slippage_usd               // Float
payload.trade.ts                   // ISO timestamp
payload.trade.side                 // "buy" or "sell"
payload.trade.symbol               // String
payload.trade.contract_address     // EVM address
payload.trade.avg_entry_price      // Float — position avg entry at time of trade
payload.trade.pnl_usd              // Float — realized P&L (non-zero on sell)
payload.trade.proceeds_usd         // Float (sells)
payload.trade.cost_portion_usd     // Float (sells — cost basis of the sold fraction)
payload.trade.fraction             // Float — portion of position traded (e.g. 0.5)
payload.trade.trade_lifecycle      // "open" | "close" | "partial"
```

Map:

```js
outcome_type   = "paper_trade"
outcome_window = "trade"
entry_price    = payload.trade?.avg_entry_price || payload.quoted_price || 0
current_price  = payload.fill_price || 0
exit_price     = payload.trade?.side === "sell" ? payload.fill_price : 0
pnl_usd        = payload.trade?.pnl_usd || 0
pnl_pct        = (entry_price > 0 && exit_price > 0)
                 ? ((exit_price - entry_price) / entry_price) * 100
                 : 0
outcome_label  = payload.trade?.side || "trade"
verdict        = "recorded"
payload_json   = JSON.stringify(payload)
```

Token identity: use `payload.trade.contract_address` and `payload.trade.symbol`.

### 11.5 Map `outcome` → `E3DAgentOutcomes`

**Verified payload structure** (from real training_events data):

```js
payload.trade_id                       // String
payload.position_id                    // String
payload.candidate_id                   // EVM address
payload.outcome_label                  // "profit" | "loss"
payload.pnl_usd                        // Float — realized P&L
payload.exit_price                     // Float — fill price at close
payload.entry_price                    // Float — position avg entry price
payload.holding_days                   // Float — e.g. 0.458
payload.position_before.contract_address  // EVM address
payload.position_before.symbol            // String
payload.position_before.avg_entry_price   // Float
payload.position_before.quantity          // Float
payload.position_before.market_value_usd  // Float
```

Map:

```js
outcome_type   = "realized_outcome"
outcome_window = "realized"
entry_price    = payload.entry_price || payload.position_before?.avg_entry_price || 0
exit_price     = payload.exit_price || 0
current_price  = exit_price
pnl_usd        = payload.pnl_usd || 0
pnl_pct        = (entry_price > 0 && exit_price > 0)
                 ? ((exit_price - entry_price) / entry_price) * 100
                 : 0
holding_days   = payload.holding_days || 0
outcome_label  = payload.outcome_label || (pnl_usd >= 0 ? "profit" : "loss")
verdict        = pnl_usd >= 0 ? "validated" : "invalidated"
payload_json   = JSON.stringify(payload)
```

Token identity: use `payload.position_before.contract_address` and
`payload.position_before.symbol`.

### 11.6 Map Rejections

Do not ignore rejections. Rejections are valuable.

If `executor_decision`, `risk_decision`, or `risk_engine_decision` indicates rejection:

```text
action_type = REJECT
simulated_side = none
```

Reason examples:

- high fraud risk
- thin liquidity
- slippage too high
- risk-off regime
- already held
- missing market data
- token risk scan blockers

Rejected candidates should appear in E3D as:

> Agent rejected this candidate and later outcome tracking can show whether the rejection was validated.

Outcome tracking for rejected candidates can be phase 2.

---

## 12. CLI Requirements

Support:

```bash
node scripts/e3dActionOutcomeExport.js
node scripts/e3dActionOutcomeExport.js --dry-run
node scripts/e3dActionOutcomeExport.js --since-hours=24
node scripts/e3dActionOutcomeExport.js --limit=5000
node scripts/e3dActionOutcomeExport.js --no-state
node scripts/e3dActionOutcomeExport.js --from-ts="2026-05-19T00:00:00-07:00"
node scripts/e3dActionOutcomeExport.js --to-ts="2026-05-20T00:00:00-07:00"
node scripts/e3dActionOutcomeExport.js --create-tables-only
node scripts/e3dActionOutcomeExport.js --source-clickhouse   # opt-in; default is JSONL
node scripts/e3dActionOutcomeExport.js --verbose
```

Defaults:

```text
limit = 5000
dry_run = false
since_hours on first run = 24
overlap_minutes = 10
lock_stale_minutes = 30
source = jsonl   (JSONL is default; --source-clickhouse switches to ClickHouse)
```

---

## 13. Logging Requirements

Append JSONL logs to:

```text
logs/e3d-action-outcome-export.jsonl
```

Each run logs:

```json
{
  "ts": "...",
  "stage": "export_summary",
  "export_run_id": "...",
  "source_events_read": 120,
  "actions_mapped": 40,
  "outcomes_mapped": 12,
  "scorecards_mapped": 0,
  "actions_inserted": 40,
  "outcomes_inserted": 12,
  "dry_run": false,
  "source_min_ts": "...",
  "source_max_ts": "...",
  "duration_ms": 1234
}
```

On error:

```json
{
  "ts": "...",
  "stage": "export_error",
  "export_run_id": "...",
  "message": "...",
  "stack": "..."
}
```

---

## 14. ClickHouse HTTP Implementation

This section covers the **AWS destination only**. The local source is read from
`logs/training-events.jsonl` (plain file I/O, no HTTP required).

Implement an AWS ClickHouse HTTP helper using `curl` via Node
`child_process.execFileSync`, consistent with existing `pipeline.js`, or use
native `fetch` if the Node version supports it and repo standards allow it.

Recommended helper interface:

```js
function clickHouseQuery({ baseUrl, database, user, password, query, input = "" }) { ... }
```

For inserts:

```sql
INSERT INTO e3d.E3DAgentActions FORMAT JSONEachRow
```

Body:

```text
{"action_id":"...", ...}
{"action_id":"...", ...}
```

Use batches:

```text
max rows per insert = 1000
```

---

## 15. Security Requirements

- Do not hardcode AWS credentials.
- Read AWS ClickHouse password from env only.
- Do not log passwords or full connection URLs with credentials.
- Allow `.env` loading only if the repo already uses `dotenv`; otherwise document required env vars.
- If `.env` is added, ensure it is gitignored.

---

## 16. Failure Behavior

The exporter should be conservative.

### If `logs/training-events.jsonl` is missing or unreadable

- Log error.
- Exit non-zero.
- Do not modify state watermark.

### If `--source-clickhouse` is set and local ClickHouse is unavailable

- Log error with suggestion to omit `--source-clickhouse`.
- Exit non-zero.
- Do not modify state watermark.

### If AWS ClickHouse is unavailable

- Log error.
- Exit non-zero.
- Do not modify state watermark.

### If some events fail to parse

- Log parse failures.
- Skip invalid events.
- Continue exporting valid events.
- Include `parse_error_count` in summary.

### If insert partially fails

- Treat run as failed.
- Do not advance watermark.
- Rerun should be safe due to deterministic IDs.

---

## 17. Acceptance Criteria

### 17.1 Table Creation

- Running with `--create-tables-only` creates destination AWS tables if missing.
- Running table creation repeatedly is safe.

### 17.2 Dry Run

- `--dry-run` reads local events and prints/logs mapped action/outcome counts.
- `--dry-run` does not insert into AWS.
- `--dry-run` does not update state watermark.
- `--dry-run` works without any ClickHouse connection (JSONL is the default source).

### 17.3 Export

- Running without `--dry-run` inserts mapped rows into AWS tables.
- `executor_decision` records appear in `E3DAgentActions`.
- `trade` and `outcome` records appear in `E3DAgentOutcomes`.
- Payload JSON is preserved in `payload_json`.

### 17.4 Idempotency

- Running the exporter twice over the same time range does not create duplicate logical records.
- Duplicate source events produce the same deterministic `action_id` or `outcome_id`.
- ClickHouse latest-by-ID query returns one logical row per action/outcome.

### 17.5 Watermark

- Successful export advances `last_watermark_ts`.
- Failed export does not advance watermark.
- Export uses overlap window when querying after a previous watermark.

### 17.6 Locking

- If a lock file exists from a current run, a second process exits without running.
- Stale locks are cleaned up after the configured stale threshold.

### 17.7 Logging

- Each run appends a summary to `logs/e3d-action-outcome-export.jsonl`.
- Errors are logged with stage and message.

---

## 18. Suggested Implementation Phases

### Phase 1: Exporter Skeleton

- Add CLI parser.
- Add env config.
- Add local/AWS ClickHouse helpers.
- Add lock file.
- Add state file.
- Add JSONL logging.

### Phase 2: Destination Tables

- Add `createDestinationTables()`.
- Support `--create-tables-only`.

### Phase 3: Read Local Events

- Read from `logs/training-events.jsonl` by default (stream line-by-line, parse JSON).
- If `--source-clickhouse` is set, query local `training_events` via ClickHouse HTTP instead.
- Support `--since-hours`, `--from-ts`, `--to-ts`, `--limit` filters on the `ts` field.
- Apply event type filter (`executor_decision`, `trade`, `outcome` for phase 1).
- On ClickHouse connection failure or auth error (HTTP 516), exit non-zero with
  a clear message: "ClickHouse unavailable — run without --source-clickhouse to
  use the default JSONL source."

### Phase 4: Mapping

- Map `executor_decision` to `E3DAgentActions`.
- Map `trade` to `E3DAgentOutcomes`.
- Map `outcome` to `E3DAgentOutcomes`.
- Preserve full payload JSON.

### Phase 5: Insert and Dedupe

- Batch insert JSONEachRow.
- Use deterministic IDs.
- Use ReplacingMergeTree destination tables.

### Phase 6: Manual Validation

Run:

```bash
# Step 1: dry-run from JSONL — verifies mapping logic, no connections needed
node scripts/e3dActionOutcomeExport.js --since-hours=24 --dry-run --verbose

# Step 2: create destination tables in AWS
node scripts/e3dActionOutcomeExport.js --create-tables-only

# Step 3: first real export from JSONL into AWS
node scripts/e3dActionOutcomeExport.js --since-hours=24
```

Validate in AWS ClickHouse:

```sql
SELECT count() FROM e3d.E3DAgentActions;
SELECT count() FROM e3d.E3DAgentOutcomes;
SELECT * FROM e3d.E3DAgentActions ORDER BY created_at DESC LIMIT 10;
SELECT * FROM e3d.E3DAgentOutcomes ORDER BY measured_at DESC LIMIT 10;
```

### Phase 7: Cron

Install cron every 5 minutes after manual validation.

Suggested repo commands:

```bash
# Print the exact cron line without changing crontab
npm run export:e3d:cron:print

# Install only after Phase 6 manual validation has passed
npm run export:e3d:cron:install

# Remove the exporter cron entry if needed
npm run export:e3d:cron:remove
```

---

## 19. Example E3D UI Queries

### Latest Agent Actions

```sql
SELECT
  created_at,
  symbol,
  token_address,
  action_type,
  agent_decision,
  simulated_side,
  confidence_score,
  risk_score,
  entry_price,
  allocation_usd,
  thesis_summary,
  reason_summary
FROM e3d.E3DAgentActions
ORDER BY created_at DESC
LIMIT 100;
```

### Latest Outcomes

```sql
SELECT
  measured_at,
  symbol,
  token_address,
  outcome_type,
  outcome_label,
  verdict,
  entry_price,
  exit_price,
  pnl_usd,
  pnl_pct,
  holding_days
FROM e3d.E3DAgentOutcomes
ORDER BY measured_at DESC
LIMIT 100;
```

### Actions With Outcomes

```sql
SELECT
  a.created_at,
  a.symbol,
  a.action_type,
  a.agent_decision,
  a.entry_price,
  o.measured_at,
  o.outcome_label,
  o.verdict,
  o.pnl_usd,
  o.pnl_pct
FROM e3d.E3DAgentActions a
LEFT JOIN e3d.E3DAgentOutcomes o
  ON a.trade_id = o.trade_id OR a.action_id = o.action_id
ORDER BY a.created_at DESC
LIMIT 100;
```

---

## 20. Future Follow-Up Ticket: E3D UI Integration

After this exporter is working, create a second feature ticket for the E3D main repo:

### UI surfaces

- Add `Agent Verdicts` tab to the existing Decision Layer Action Page.
- Add token-level `Agent Verdict / Outcome` panel.
- Add dashboard summary:
  - actions reviewed
  - paper buys
  - rejections
  - realized outcomes
  - win rate
  - validated rejections
  - top positive outcomes
  - worst false positives

### Newsletter

Add a section:

```text
E3D Agent Verdicts & Outcomes
```

Include:

- top validated agent action
- best rejected risk
- worst invalidated action
- what the engine learned

---

## 21. Product Language

Use this language in comments, UI, and docs:

```text
E3D does not just explain the chain. It tests its own explanations against what happens next.
```

```text
E3D finds interesting structure. The Agent Verdict Engine tests whether that structure survives capital-aware reasoning.
```

Avoid leading with:

```text
trading bot
buy/sell recommendations
automatic trading
```

Prefer:

```text
agent verdicts
simulated actions
paper execution
outcome tracking
signal validation
thesis validation
capital-aware reasoning
```

---

## 22. Definition of Done

This ticket is complete when:

1. `scripts/e3dActionOutcomeExport.js` exists.
2. It can create destination AWS ClickHouse tables.
3. It can dry-run map local events.
4. It can export `executor_decision`, `trade`, and `outcome` records.
5. Exported actions are visible in AWS `E3DAgentActions`.
6. Exported outcomes are visible in AWS `E3DAgentOutcomes`.
7. Re-running the exporter is idempotent.
8. State/watermark and lock files work.
9. Logs provide useful summaries.
10. A cron command is documented and tested manually.

---

## 23. Implementation Notes for AI Agent

When implementing, inspect the existing repo before editing.

Important existing file:

```text
pipeline.js
```

Important existing concepts/functions:

```text
CLICKHOUSE_HTTP_URL
CLICKHOUSE_DATABASE_NAME
CLICKHOUSE_TABLE_NAME
training_events
appendTrainingEvent
syncTrainingEventToClickHouse
recordExecutorDecisionEvent
recordTradeEvent
recordOutcomeEvent
buildTrainingEventRecord
```

Do not import or execute `pipeline.js` from the exporter if doing so triggers
pipeline side effects. Prefer copying tiny pure helper functions into the
exporter or creating a new shared utility module only if safe.

**Verified payload facts (do not deviate):**

1. `executor_decision` payload top-level keys:
   `candidate_id`, `trade_kind`, `decision`, `proposal`, `review`, `action`, `portfolio_snapshot`

2. `payload.review` keys that actually exist:
   `executor_decision`, `reason_summary`, `blocker_list` (Array), `approved_size_pct`,
   `max_slippage_bps`, `risk_checks` (Array), `entry_status`, `live_execution_allowed`
   — **NOT** `decision`, `reason`, `reject_reason`, `risk_score`

3. `payload.action.paper_trade_ticket` is a **plain string**, not an object.
   Do not read sub-fields from it.

4. `source_story_ids` and `source_signal_types` do **not** exist in
   `executor_decision` events. Set both to `[]`.

5. `risk_decision_id` is always `null` in `executor_decision`. Set to `""`.

6. `allocation_usd` must be derived:
   `(review.approved_size_pct / 100) * portfolio_snapshot.cash_usd`

7. `trade` events have a top-level `fee_bps_applied` and `fee_usd` — these are
   real values, not zero.

8. **ClickHouse has never received pipeline data.** `pipeline.js` sends no auth
   headers in `clickHouseQuery`. The local ClickHouse requires a password (HTTP
   516). Every insert attempt has failed and been swallowed silently as
   `clickhouse_sync_error` in `pipeline.jsonl` (802 such errors logged). The
   `training_events` table is effectively empty. **`logs/training-events.jsonl`
   is the only authoritative data source.** The exporter reads JSONL by default.
   `--source-clickhouse` is an opt-in flag for future use.

9. `logs/training-events.jsonl` contains 18,000+ rows with these event type
   counts (as of 2026-05-20):
   `executor_decision: 1291`, `trade: 1090`, `outcome: 222`,
   `risk_decision: 2973`, `risk_engine_decision: 228`, `candidate: 2111`,
   `cycle_start: 3478`, `cycle_end: 2723`, `manager_report: 1993`

Keep the first version boring and reliable.

The exporter is infrastructure. It should be easy to understand, easy to rerun,
and safe to schedule.
