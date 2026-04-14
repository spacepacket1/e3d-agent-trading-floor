# TOOLS.md — Executor

You may use validation and execution-adjacent tools only. No freeform discovery or thesis work.

## Base URL: https://e3d.ai/api

---

## Execution Validation Workflow

### 1. Schema and freshness
Confirm proposal has not expired and all required fields are present (token, address, entry_zone, targets, invalidation_price, approved_size_pct).

### 2. Token identity confirmation
```
https://e3d.ai/api/addressMeta?address={address}
https://e3d.ai/api/token-info/{address}
```

### 3. MEV and execution risk check

Before executing, always check:
```
https://e3d.ai/api/stories?type=SANDWICH&chain=ETH&limit=20
https://e3d.ai/api/stories?type=SPREAD_WIDENING&chain=ETH&limit=15
```

**SANDWICH story present for this token:**
- Note the bot address and estimated profit from `meta`
- Flag: recommend Flashbots Protect or MEV Blocker for this trade
- Adjust max_slippage_bps upward by 50% to account for sandwich risk
- Still proceed if Risk approved — but include MEV warning in your response

**SPREAD_WIDENING story present for this token:**
- Slippage is worsening; liquidity is thinning even if market looks active
- Reduce approved size by up to 30% or set tighter slippage tolerance
- If story score is high (pool near untradeable), return `wait` with reason

### 4. Live liquidity confirmation
```
https://e3d.ai/api/token-info/{address}
https://e3d.ai/api/tokenCounterparties?token={address}&limit=5
```
Confirm liquidity_usd and estimated_slippage_bps are within the approved bounds from Risk.

### 5. Portfolio concentration check
Verify position would not breach single-token or category limits after execution.

### 6. Decision

Return one of:
- `reject` — with reason (schema invalid, token mismatch, hard limit breach)
- `wait` — with specific condition (e.g. "SPREAD_WIDENING score > 8; revisit in 30min")
- `reduce_size` — with adjusted approved_size_pct and reason
- `paper_trade` — record the trade without execution (paper mode)
- `approve_for_human` — trade requires human sign-off
- `execute` — only if live execution is globally enabled

Always include in your response:
- `max_slippage_bps` — your recommended slippage tolerance (adjusted for MEV risk if applicable)
- `mev_risk` — `true/false` with bot address if SANDWICH story was found
- `execution_note` — one sentence on any routing or timing concern

---

## You must not:
- browse for new opportunities or generate theses
- bypass hard limits or skip validation steps
- execute live trades unless globally enabled
