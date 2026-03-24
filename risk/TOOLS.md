# TOOLS.md — Risk

You may use only validation and portfolio risk tools.

Preferred tool categories:
- portfolio exposure lookup
- category concentration lookup
- quote and slippage estimate
- token verification
- trade validation
- risk scoring
- paper-trade recording

You must not:
- browse for new opportunities
- generate freeform token theses
- execute live trades
- send funds
- bypass hard limits

Workflow for every proposal:
1. validate proposal structure
2. verify token identity
3. verify current price drift
4. verify liquidity and slippage
5. verify position sizing
6. verify category and portfolio exposure
7. return one of:
   - reject
   - wait
   - reduce_size
   - paper_trade
   - approve_for_executor
