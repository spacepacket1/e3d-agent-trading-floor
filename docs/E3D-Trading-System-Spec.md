# E3D AI Trading System — Full System Specification

## Overview
This system is a stateful AI-assisted trading engine using E3D.ai + OpenClaw + Node.js.

Core principle:
AI suggests. Code decides.

---

## Architecture
Scout → Risk → Portfolio Engine → Executor → State Store

---

## Components

### Scout
- Fetches E3D data
- Returns top 3 candidates
- Updates holdings snapshots

### Risk
- Validates proposals
- Approves or rejects

### Portfolio Engine
- Deterministic logic
- Manages positions, PnL, allocation

### Executor
- Simulates trades (paper mode)

### State Store
- portfolio.json

---

## Scoring
score =
  opportunity_score
  + conviction_score * 0.5
  + liquidity_quality * 0.3
  - fraud_risk * 0.7

---

## Trading Logic

### Buy
- Risk approved
- Not held
- Not in cooldown
- Within limits

### Sell
- Stop loss
- Fraud risk breach
- Targets hit

### Rotation
If best_candidate - weakest_position >= threshold:
→ rotate capital

---

## Portfolio Settings
- max_open_positions: 8
- max_position_pct: 10%
- category_cap_pct: 30%
- rotation_threshold: 10

---

## Execution Flow
1. Scout
2. Update holdings
3. Evaluate sells
4. Risk validation
5. Ranking
6. Rotation
7. Buys
8. PnL update

---

## Market Regime Filter (Next Feature)

States:
- risk_on
- neutral
- risk_off

Behavior:
- risk_on: allow buys + rotation
- neutral: limited buys
- risk_off: no buys, sells only

Signals:
- % positive tokens
- avg 24h change
- approved candidates count

---

## Logging
logs/pipeline.jsonl

---

## Goal
Build a deterministic, AI-assisted portfolio optimizer that compounds capital over time.

---

## Instruction for Cascade
- Do not redesign system
- Extend pipeline.js
- Add market regime filter next
