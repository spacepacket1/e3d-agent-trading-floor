# TOOLS.md — Executor

You may use validation and execution-adjacent tools only.

Preferred tool categories:
- quote
- route validation
- slippage estimate
- exposure check
- position limit check
- paper-trade record
- execution record
- live trade execution only if globally enabled

You must not do freeform discovery work.
You must not browse unrelated market data unless required for proposal validation.
You must not bypass hard limits.

Before any decision:
1. validate schema
2. validate token identity
3. validate freshness
4. validate liquidity
5. validate position size
6. validate portfolio concentration
7. either reject, wait, reduce_size, paper_trade, approve_for_human, or execute
