# E3D Agent Trading Floor — Meta-Agent & Strategy Agent Specification

## Overview

This document defines the architecture, data contracts, and implementation plan for introducing:

- Strategy Evaluator Agents
- Meta-Agent (Capital Allocator)
- Structured Opportunity Flow

The goal is to evolve the system from a single-agent decision model into a multi-agent, portfolio-style decision engine.

---

## System Architecture

Market Data + E3D + News
        ↓
     SCOUT
        ↓
 Opportunity Packet (JSON)
        ↓
 Momentum Eval | Value Eval | OnChain Eval
        ↓
   Evaluation Bundle
        ↓
     META-AGENT
        ↓
     RISK ENGINE
        ↓
   EXECUTION (Sim → Real)

---

## 1. Scout Agent

### Responsibility
- Detect market opportunities
- Aggregate signals (price, on-chain, news)
- Emit structured Opportunity Packet

---

## 2. Opportunity Packet Schema

{
  "id": "uuid",
  "timestamp": "ISO8601",
  "symbol": "ETH",
  "asset_type": "crypto",
  "direction": "long | short | neutral",
  "timeframe": "short | medium | long",
  "signals": {},
  "summary": "Natural language explanation",
  "confidence": 0.0
}

---

## 3. Strategy Evaluator Agents

Each evaluator:
- Receives the same packet
- Applies its own strategy
- Outputs structured evaluation

Agents:
- Momentum
- Value / Mean Reversion
- On-Chain (E3D)

---

## 4. Evaluation Bundle

{
  "symbol": "ETH",
  "evaluations": [
    { "agent": "momentum", "score": 0.75 },
    { "agent": "value", "score": 0.30 },
    { "agent": "onchain", "score": 0.68 }
  ]
}

---

## 5. Meta-Agent

### Responsibility
- Allocate capital
- Resolve disagreements
- Adjust risk
- Approve/reject trades

### Output

{
  "approved": true,
  "final_direction": "long",
  "confidence": 0.0,
  "capital_allocation": {},
  "position_size": 0.0,
  "risk_multiplier": 0.0
}

---

## 6. Risk Engine

Hard constraints:
- Max position size
- Max daily loss
- Stop loss / take profit

---

## 7. Execution Layer

Phase 1: Simulation  
Phase 2: Live trading (CEX/DEX)

---

## 8. Performance Tracking

Track per-agent:
- Win rate
- Avg return
- Drawdown

---

## 9. Implementation Plan

1. Add Opportunity Packet
2. Add evaluators
3. Add rule-based meta-agent
4. Add performance tracking
5. Upgrade meta-agent to LLM
6. Add paper trading

---

## Summary

Transforms system into:
Multi-agent, capital-allocating trading engine with E3D integration.
