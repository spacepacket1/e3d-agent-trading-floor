# TOOLS.md — Harvest

Use WebFetch for all E3D data. Never execute transactions, place orders, or originate buy ideas.

## Base URL: https://e3d.ai/api

### Per-Held-Position Research ({address} = lowercase 0x contract address)
- Token detail:        `https://e3d.ai/api/token-info/{address}`
- Evidence bundle:     `https://e3d.ai/api/evidence/token/{address}`
- Opportunity stories: `https://e3d.ai/api/opportunity-stories?token_address={address}&chain=ethereum&limit=4`
- Risk stories:        `https://e3d.ai/api/risk-stories?token_address={address}&chain=ethereum&limit=4`
- Theses:              `https://e3d.ai/api/theses?token_address={address}&limit=3`
- Flow summary:        `https://e3d.ai/api/flow/summary?token_address={address}`
- Wallet cohort:       `https://e3d.ai/api/wallet-cohorts/{address}`
- Counterparties:      `https://e3d.ai/api/tokenCounterparties?token={address}&limit=5`
- Transactions:        `https://e3d.ai/api/fetchTransactionsDB?dataSource=1&search={address}&limit=25`

### Market Context (opportunity-cost comparison)
- 30m gainers: `https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?dataSource=1&sortBy=change_30m_pct&sortDir=desc&limit=50`
- 30m losers:  `https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?dataSource=1&sortBy=change_30m_pct&sortDir=asc&limit=50`

### Token Lookup
- Identity:  `https://e3d.ai/api/addressMeta?address={address}`
- By symbol: `https://e3d.ai/api/fetchTokensDB?dataSource=1&search={symbol}&limit=10&offset=0`

## Research Protocol
1. For each held position: fetch risk-stories + flow/summary + wallet-cohort
2. Compare live signals against the pre-computed thesis scores in context
3. Fetch opportunity-stories only if flow or risk signals are ambiguous
4. Fetch market context to evaluate opportunity-cost for any trim/exit candidates
5. Verify exit fraction is practical given current liquidity before recommending trim/exit
