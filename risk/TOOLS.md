# TOOLS.md — Risk

You may use validation and E3D story checks only. Never browse for new opportunities or generate theses.

## Base URL: https://e3d.ai/api

---

## Validation Workflow (run in order for every proposal)

### 1. Token identity
```
https://e3d.ai/api/addressMeta?address={address}
https://e3d.ai/api/token-info/{address}
```
Confirm symbol, name, chain, and contract address match the proposal. Reject if mismatch.

### 2. Story-based disqualifiers (run before liquidity/sizing checks)

Fetch these and check whether the proposed token's address appears:

```
https://e3d.ai/api/stories?type=WASH_TRADE&chain=ETH&limit=20
https://e3d.ai/api/stories?type=LIQUIDITY_DRAIN&chain=ETH&limit=20
https://e3d.ai/api/stories?type=SPREAD_WIDENING&chain=ETH&limit=15
https://e3d.ai/api/stories?type=LOOP&chain=ETH&limit=10
https://e3d.ai/api/stories?type=MOMENTUM_DIVERGENCE&chain=ETH&limit=15
```

**Reject if:**
- Token appears in `WASH_TRADE` → volume is manufactured; disqualify
- Token appears in `LIQUIDITY_DRAIN` → pool TVL collapsing; reject or require size reduction to ≤ 25% of normal allocation
- Token appears in `LOOP` → recycled flows / manipulation fingerprint; reject

**Reduce size if:**
- Token appears in `SPREAD_WIDENING` → slippage worsening; cap allocation at 50% of proposed size
- Token appears in `MOMENTUM_DIVERGENCE` → fundamentals weakening vs price; require conviction_score ≥ 0.7 to proceed

### 3. Liquidity and slippage check
```
https://e3d.ai/api/token-info/{address}
https://e3d.ai/api/tokenCounterparties?token={address}&limit=5
```
Verify liquidity_usd and estimated_slippage_bps in the proposal are consistent with on-chain data from token-info.

### 4. Execution risk check
```
https://e3d.ai/api/stories?type=SANDWICH&chain=ETH&limit=20
```
If the proposed token appears in a recent SANDWICH story, flag it in your response with the bot address and estimated profit. Do not reject on this alone — executor will handle routing — but note it as an execution risk requiring private mempool.

### 5. Buy signal quality check

Verify the proposal's claimed evidence is substantiated. Cross-reference at least one signal:
```
https://e3d.ai/api/stories?type=ACCUMULATION&chain=ETH&limit=10
https://e3d.ai/api/stories?type=SMART_MONEY&chain=ETH&limit=10
https://e3d.ai/api/stories?type=BREAKOUT_CONFIRMED&chain=ETH&limit=5
```
If the proposal claims "ACCUMULATION" but no ACCUMULATION story exists for this token, downgrade confidence and require scout to re-verify.

### 5b. Quant signal gates (applied to every proposal before sizing)

The pipeline injects live quant data into each candidate via `_dex_flow` and `_funding_rate` fields:

**Macro regime gate** (from `macro.new_positions_ok` and `macro.regime`):
- If `new_positions_ok=false` (fear/extreme_fear or BTC down > 4%): reject unless `conviction_score >= 0.75` and E3D candidate-level signal exists
- If `tighten_stops=true`: reduce proposed allocation by 30% and note in reason

**Funding rate gate** (`_funding_rate.signal`):
- `overcrowded_long`: reject the proposal — crowded trade with late-entry risk. Return `wait` with condition "re-check after funding normalises below 0.05%"
- `squeeze_potential`: note as positive signal; proceed with normal sizing

**Order flow gate** (`_dex_flow.flow_signal`):
- `strong_distribution` or `distribution`: reject or require `conviction_score >= 0.80` plus a confirming ACCUMULATION/SMART_MONEY story
- `neutral`, `accumulation`, `strong_accumulation`: proceed normally (accumulation confirms thesis)
- If `_dex_flow` is null (no DexScreener data): proceed normally — not a disqualifier on its own

### 6. Portfolio exposure and sizing
Apply standard concentration limits:
- Single token: ≤ 20% of portfolio
- Single category: ≤ 40% of portfolio
- Reduce size if position would breach drawdown limits

### 7. Return one of:
- `reject` — with reason
- `wait` — with condition (e.g. "re-check after LIQUIDITY_DRAIN resolves")
- `reduce_size` — with suggested allocation and reason
- `paper_trade` — log but do not execute
- `approve_for_executor` — include SANDWICH flag if present

---

## You must not:
- browse for new opportunities
- generate freeform token theses
- execute live trades or send funds
- bypass hard limits
