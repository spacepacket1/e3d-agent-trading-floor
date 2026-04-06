# TOOLS.md — Scout

Use WebFetch for all E3D data. Never execute transactions or mutate state.

## Base URL: https://e3d.ai/api

### Market Discovery (start here)
- 30m gainers:  `https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?dataSource=1&sortBy=change_30m_pct&sortDir=desc&limit=50`
- 30m losers:   `https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?dataSource=1&sortBy=change_30m_pct&sortDir=asc&limit=50`
- 24h gainers:  `https://e3d.ai/api/fetchTokenPricesWithHistoryAllRanges?dataSource=1&sortBy=change_24H&sortDir=desc&limit=50`
- Token universe: `https://e3d.ai/api/fetchTokensDB?dataSource=1&limit=50&offset=0`
- Recent txns:  `https://e3d.ai/api/fetchTransactionsDB?dataSource=1&limit=25`

### Per-Token Analysis ({address} = lowercase 0x contract address)
- Identity:           `https://e3d.ai/api/addressMeta?address={address}`
- Token detail:       `https://e3d.ai/api/token-info/{address}`
- Evidence bundle:    `https://e3d.ai/api/evidence/token/{address}`
- Opportunity stories: `https://e3d.ai/api/opportunity-stories?token_address={address}&chain=ethereum&limit=4`
- Risk stories:       `https://e3d.ai/api/risk-stories?token_address={address}&chain=ethereum&limit=4`
- Theses:             `https://e3d.ai/api/theses?token_address={address}&limit=3`
- Wallet cohort:      `https://e3d.ai/api/wallet-cohorts/{address}`
- Flow summary:       `https://e3d.ai/api/flow/summary?token_address={address}`
- Counterparties:     `https://e3d.ai/api/tokenCounterparties?token={address}&limit=5`
- Transactions:       `https://e3d.ai/api/fetchTransactionsDB?dataSource=1&search={address}&limit=25`

### Token Search ({symbol} = ticker)
- By symbol: `https://e3d.ai/api/fetchTokensDB?dataSource=1&search={symbol}&limit=10&offset=0`
- Stories:   `https://e3d.ai/api/stories?q={symbol}&scope=any&limit=4`

## Research Protocol
1. Fetch 30m gainers — filter against exclusion list in context
2. For top 5–8 candidates: fetch identity + opportunity-stories + risk-stories + flow/summary
3. Score each from evidence quality, liquidity, and flow signal
4. Return the best 3 (fewer is fine if quality threshold not met)
5. Verify invalidation and liquidity before including any candidate
