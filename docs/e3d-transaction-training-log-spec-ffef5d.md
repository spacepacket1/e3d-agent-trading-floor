---
description: Training-ready transaction logging spec for the E3D pipeline
---
# E3D Transaction Logging Spec

Define an append-only, decision-linked logging format that captures Scout, Risk, Executor, and trade outcome data as training examples with both decision context and eventual win/loss labels, while keeping live portfolio state in MongoDB and event history in ClickHouse.

## Goal
Create a durable log design that lets the current paper-trading pipeline produce replayable examples for supervised fine-tuning and post-trade outcome labeling without changing the deterministic trading logic.

## Scope
- Log every candidate proposal with a stable `candidate_id`, `cycle_id`, and `pipeline_run_id`.
- Persist the full decision chain: Scout snapshot, Risk decision, Executor decision, and the resulting trade action or rejection.
- Attach outcome labels when a position closes, including realized PnL, duration, max adverse excursion, max favorable excursion, and win/loss classification.
- Keep the format compatible with the existing paper-trade-first workflow and `portfolio.json` state model.
- Assume local Docker Compose for both databases during development and paper-trade runs.

## Recommended record types
1. **Candidate event**
   - Scout prompt context, token snapshot, market regime, portfolio snapshot, and candidate JSON.
2. **Decision event**
   - Risk or Executor response, decision reason codes, sizing, blockers, and policy metadata.
3. **Trade event**
   - Open, add, rotate, partial sell, full exit, and forced-stop records with execution price and allocation.
4. **Outcome event**
   - Final close label with profit/loss, return %, holding time, and a binary win/loss flag.

## Core schema requirements
- Stable IDs: `pipeline_run_id`, `cycle_id`, `candidate_id`, `trade_id`, `position_id`, `event_id`.
- Timestamps in ISO-8601 UTC.
- Deterministic snapshots of inputs used for the decision: market data, liquidity data, portfolio state, regime, and agent outputs.
- Versioned schema fields so future model-training exports can evolve without breaking old records.

## Labeling rules
- **Win**: closed trade with positive realized PnL after fees/slippage assumptions.
- **Loss**: closed trade with negative realized PnL.
- **Breakeven / neutral**: near-zero PnL within a configurable tolerance.
- Record extra labels for exit cause: stop, target, rotation, cooldown, regime gate, manual stop, or rejection.

## Dataset assembly
- Build training rows from the linked chain: Scout context → Risk decision → Executor decision → trade outcome.
- Preserve rejected candidates as negative examples.
- Preserve paper-trade approvals that never opened a position as “decision-only” examples.
- Export examples in JSONL so they can be replayed, filtered, and joined by ID.

## Storage and logging approach
- Keep `logs/pipeline.jsonl` as the human-readable operational/debug trail.
- Store live portfolio state in MongoDB: cash, positions, cooldowns, stats, and active trade references.
- Store normalized append-only training/event records in ClickHouse: candidate snapshots, decisions, executions, and closure labels.
- Ensure trade outcome records are written when a position closes, not only at entry time.

## Validation and rollout
- Verify every executed trade has a complete decision chain and an eventual outcome record.
- Verify every rejected candidate still has enough context to train negative examples.
- Add a schema validation pass before writing records.
- Run a few controlled paper cycles and confirm MongoDB state and ClickHouse events stay in sync deterministically.

## Open decisions
- Whether “win” should be defined by raw realized PnL, risk-adjusted return, or a thresholded return bucket.
- Whether to include prompt text verbatim or a normalized prompt summary for training export.
