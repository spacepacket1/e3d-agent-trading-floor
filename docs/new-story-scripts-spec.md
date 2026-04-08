# E3D New Story Scripts — Implementation Spec

**For:** Cascade GPT implementation  
**Context:** `/Users/mini/e3d/buildDB/` — the E3D on-chain analytics platform story pipeline  
**Status:** Four scripts to build (3 new, 1 upgrade to existing)

---

## Background and Conventions

All story scripts share the same runtime contract. Read these reference files before implementing anything:

- **`storyCommon.js`** — shared DB client, `makeStory()`, `insertStories()`, `chRows()`, `getEthName()`, `normAddr()`, `escapeCH()`, `formatAddress()`, `pickLabel()`
- **`storyWhaleBehaviorShift.js`** — canonical pattern for env-config, ClickHouse queries, dedupe, scoring, and insertion
- **`storySurge.js`** — canonical pattern for activity confirmation and participation classification
- **`run_stories.sh`** — orchestration script; new scripts get a `run_step` entry here

### makeStory() shape
```javascript
makeStory({
  story_type,        // String — e.g. 'ACCUMULATION'
  chain,             // String — e.g. 'ETH'
  primary_token,     // String — lowercase 0x contract address
  title,             // String — human-readable headline
  subtitle,          // String — one-line summary
  score,             // Number — Float64, higher = more significant
  meta,              // Object — arbitrary JSON, always include dedupe_key and detected_at
  is_breaking,       // 0|1
  needs_enrichment,  // 0|1 — set 1 to trigger storyEnrichAI.js processing
})
```

### chRows() pattern
```javascript
const rows = await chRows(`
  SELECT ...
  FROM EthTokenTransfers
  WHERE ...
`);
```

### Dedupe pattern (from storyWhaleBehaviorShift.js)
```javascript
async function alreadyHaveDedupeKey(dedupeKey) {
  const escaped = escapeCH(dedupeKey);
  const rows = await chRows(`
    SELECT id FROM Stories
    WHERE position(meta_json, '${escaped}') > 0
      AND ts_created >= now() - INTERVAL 24 HOUR
    LIMIT 1
  `);
  return rows.length > 0;
}
```

### Score formula conventions
- Use `Math.log1p(x)` to compress large values
- Clamp inputs: `Math.min(Math.max(x, 0), cap)`
- `is_breaking = 1` when score crosses the top ~10% threshold for that story type
- `needs_enrichment = 1` for all new story types (lets storyEnrichAI.js add ai_narrative, ai_risks, ai_takeaways)

### Key ClickHouse tables
- **`EthTokenTransfers`** — token transfer events: `(ts, chain, token, from_addr, to_addr, amount, usd_amount, tx_hash)`
- **`EthPrices`** — price snapshots: `(timestamp, chain, address, priceUSD)`
- **`EthNames`** — address labels: `(address, chain, symbol, name, icon)`
- **`EthTransactions`** — raw txns: `(ts, chain, from_addr, to_addr, tx_hash, gas_used)`
- **`Stories`** — output table: `(id, ts_created, story_type, chain, primary_token, title, subtitle, score, meta_json, is_breaking, needs_enrichment, ts_detected)`
- **`RabbitFindings`** — ML graph findings: `(ts_created, window_start, window_end, chain, finding_type, seed_id, score, entities_json, evidence_json, narrative_hint)`

### Address normalization
Always `lower(toString(address))` in SQL. In JS: use `normAddr(addr)` from storyCommon.

### Known stablecoin addresses to exclude (ETH mainnet)
```javascript
const STABLECOIN_ADDRESSES = new Set([
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0x0000000000085d4780b73119b644ae5ecd22b376', // TUSD
  '0x4fabb145d64652a948d72533023f6e7a623c7c53', // BUSD
  '0x853d955acef822db058eb8505911ed77f175b99e', // FRAX
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f', // USDS
  '0x83f20f44975d03b1b09e64809b757c47f942beea', // sDAI
  '0x5f98805a4e8be255a32880fdec7f6728c6568ba0', // LUSD
]);
```

---

## Script 1: `storyAccumulation.js` (NEW)

### Purpose
Detect non-obvious accumulation: a single whale address net-buying a non-stablecoin, non-bridge token at scale over the last hour. This is a potential buy signal for the trading pipeline — the E3D equivalent of watching smart money move before price reflects it.

Differs from `storyWhaleBehaviorShift.js` in that:
- WHALE stories track *anomalies vs baseline* (whale behavior change)
- ACCUMULATION stories track *absolute size of net inflows into a non-stablecoin token*
- ACCUMULATION scores whale track record and excludes known noise (stablecoins, bridges, WETH, wrapped BTC)

### Story type
`ACCUMULATION`

### File location
`/Users/mini/e3d/buildDB/storyAccumulation.js`

### Environment variables
```
ACCUM_WINDOW_SEC=3600            # look-back window for detecting current activity
ACCUM_MIN_USD=5000000            # minimum net USD inflow to trigger ($5M default)
ACCUM_MAX_STORIES=10             # max stories to emit per run
ACCUM_DEDUPE_HOURS=6             # dedupe window (don't re-emit same whale+token within N hours)
ACCUM_BUCKET_MINUTES=10          # time bucket granularity (align with WHALE script)
ACCUM_MIN_TX=5                   # minimum tx count to qualify (filter single-tx artifacts)
ACCUM_MIN_MCAP_USD=1000000       # minimum token market cap to include ($1M)
ACCUM_DEBUG=0                    # 1 to print candidate rows without inserting
```

### Step-by-step logic

**Step 1 — Query net inflows for the last window**

```sql
WITH
  now() AS t_now,
  (t_now - {ACCUM_WINDOW_SEC}) AS t_from,
  toStartOfInterval(t_now, INTERVAL {ACCUM_BUCKET_MINUTES} MINUTE) AS bucket_utc
SELECT
  lower(toString(t.token))           AS token_address,
  lower(toString(t.to_addr))         AS whale,
  sum(t.usd_amount)                  AS usd_in,
  count()                            AS tx_count,
  uniqExact(t.from_addr)             AS uniq_counterparties
FROM EthTokenTransfers t
WHERE
  t.chain = 'ETH'
  AND t.ts >= t_from
  AND t.ts < t_now
  AND t.usd_amount >= 10000
GROUP BY token_address, whale
HAVING usd_in >= {ACCUM_MIN_USD}
  AND tx_count >= {ACCUM_MIN_TX}
ORDER BY usd_in DESC
LIMIT {ACCUM_MAX_STORIES * 5}
```

This gives us whale addresses that received large inflows. Net accumulation requires outflows to also be tracked:

**Step 2 — Compute net (in - out) for each (whale, token) pair**

For each candidate `(token_address, whale)` returned above, compute the outflow in the same window:

```sql
SELECT
  lower(toString(t.token))           AS token_address,
  lower(toString(t.from_addr))       AS whale,
  sum(t.usd_amount)                  AS usd_out
FROM EthTokenTransfers t
WHERE
  t.chain = 'ETH'
  AND t.ts >= {t_from}
  AND t.ts < {t_now}
  AND lower(toString(t.from_addr)) IN ({whale_list})
  AND lower(toString(t.token)) IN ({token_list})
GROUP BY token_address, whale
```

Merge in JS: `net_usd = usd_in - usd_out`. Only keep candidates where `net_usd >= ACCUM_MIN_USD`.

**Step 3 — Enrich with token price and market cap**

For each surviving token address, join with latest price:
```sql
SELECT
  lower(toString(address)) AS token_address,
  anyLast(priceUSD) AS price_usd,
  anyLast(marketCapUSD) AS market_cap_usd
FROM EthPrices
WHERE chain = 'ETH'
  AND lower(toString(address)) IN ({token_list})
  AND timestamp >= now() - INTERVAL 3 HOUR
GROUP BY token_address
```

**Step 4 — Filter exclusions**

Exclude the following (in JS, after fetching):
1. Token address is in `STABLECOIN_ADDRESSES` set
2. Token `name` or `symbol` (from `getEthName()`) contains case-insensitive: `"wrapped"`, `"bridge"`, `"wbtc"`, `"weth"`, `"cbbtc"`, `"tbtc"`, `"lbtc"` — these are wrappers, not tradeable alpha
3. Token `market_cap_usd < ACCUM_MIN_MCAP_USD`
4. Whale address is a known DEX router or bridge contract (check `getEthName(whale)` — if name contains `"router"`, `"bridge"`, `"aggregator"`, `"1inch"`, `"0x Protocol"`, skip)

**Step 5 — Whale track record (optional enrichment, best-effort)**

Query the whale's historical token exits to compute a rough "win rate":
```sql
SELECT
  lower(toString(token))   AS token_address,
  sum(usd_amount)          AS usd_out_historical
FROM EthTokenTransfers
WHERE
  chain = 'ETH'
  AND lower(toString(from_addr)) = '{whale}'
  AND ts >= now() - INTERVAL 30 DAY
  AND ts < (now() - INTERVAL {ACCUM_WINDOW_SEC})
GROUP BY token_address
HAVING usd_out_historical > 100000
LIMIT 20
```

Count how many historical exits the whale made. If available, include `historical_exit_count` in meta for context. Do not block on this query — wrap in try/catch and fall back to null if it fails.

**Step 6 — Dedupe check**

For each candidate:
```javascript
const dedupeKey = `ACCUMULATION|ETH|${whale}|${tokenAddress}`;
if (await alreadyHaveDedupeKey(dedupeKey, ACCUM_DEDUPE_HOURS)) continue;
```

Where `alreadyHaveDedupeKey` checks within `ACCUM_DEDUPE_HOURS` (not hardcoded 24h).

**Step 7 — Score**

```javascript
const score = 2.0 * Math.log1p(netUsd / 1e6)
            + 0.5 * Math.log1p(txCount)
            + (historicalExitCount > 5 ? 0.8 : 0)   // whale has track record
            + (historicalExitCount > 20 ? 0.8 : 0);  // bonus for prolific whale
```

**Step 8 — Build meta**

```javascript
meta = {
  type: 'ACCUMULATION',
  chain: 'ETH',
  whale: {
    address: whaleAddr,
    address_short: formatAddress(whaleAddr),
    symbol: whaleName.symbol || null,
    name: whaleName.name || null,
    icon: whaleName.icon || null,
    historical_exit_count: historicalExitCount ?? null,
  },
  token: {
    address: tokenAddr,
    address_short: formatAddress(tokenAddr),
    symbol: tokenName.symbol,
    name: tokenName.name,
    icon: tokenName.icon || null,
  },
  net_flow: {
    direction: 'IN',
    usd_in: usdIn,
    usd_out: usdOut,
    usd_net: netUsd,
    tx_count: txCount,
    uniq_counterparties: uniqCounterparties,
  },
  price: {
    token_price_usd: priceUsd,
    market_cap_usd: marketCapUsd,
  },
  window_sec: ACCUM_WINDOW_SEC,
  dedupe_key: dedupeKey,
  detected_at: new Date().toISOString(),
  view: 'whale_accumulation',
}
```

**Step 9 — Build story**

```javascript
makeStory({
  story_type: 'ACCUMULATION',
  chain: 'ETH',
  primary_token: tokenAddr,
  title: `${tokenSymbol}: whale ${formatAddress(whaleAddr)} net bought ~$${formatUsd(netUsd)}`,
  subtitle: `Net inflow $${formatUsd(netUsd)} over ${ACCUM_WINDOW_SEC / 3600}h • ${txCount} txns from ${uniqCounterparties} counterparties`,
  score,
  meta,
  is_breaking: netUsd >= 20_000_000 ? 1 : 0,
  needs_enrichment: 1,
})
```

**Step 10 — Sort and insert**

Sort by `score DESC`, take top `ACCUM_MAX_STORIES`, call `insertStories()`.

### run_stories.sh entry
Insert immediately after `storyWhaleBehaviorShift.js`:
```bash
echo "[$TIMESTAMP] Running storyAccumulation.js"
run_step "storyAccumulation.js" "$LOG_DIR/storyAccumulation.log" node storyAccumulation.js --chain ETH
```

---

## Script 2: `storyBreakoutConfirmed.js` (NEW)

### Purpose
Emit a composite signal when a token appears in **both** a MOVER story (multi-timeframe price breakout) **and** a SURGE story (activity-confirmed price spike) within a 2-hour window. Single-story breakouts are noisy; double confirmation is a strong buy signal.

This script reads from the `Stories` table (cross-referencing existing MOVER and SURGE stories), so it must run **after** both `storyTokenMover.js` and `storySurge.js` in the pipeline.

### Story type
`BREAKOUT_CONFIRMED`

### File location
`/Users/mini/e3d/buildDB/storyBreakoutConfirmed.js`

### Environment variables
```
BREAKOUT_WINDOW_HOURS=2          # max time between MOVER and SURGE to count as confirmed
BREAKOUT_MAX_STORIES=5           # max stories to emit per run
BREAKOUT_MIN_MOVER_SCORE=5.0     # minimum MOVER story score to qualify
BREAKOUT_MIN_SURGE_SCORE=4.0     # minimum SURGE story score to qualify
BREAKOUT_DEDUPE_HOURS=4          # dedupe window
BREAKOUT_DEBUG=0
```

### Step-by-step logic

**Step 1 — Fetch recent MOVER stories**

```sql
SELECT
  primary_token,
  score AS mover_score,
  ts_created AS mover_ts,
  meta_json AS mover_meta
FROM Stories
WHERE story_type = 'MOVER'
  AND chain = 'ETH'
  AND ts_created >= now() - INTERVAL {BREAKOUT_WINDOW_HOURS * 2} HOUR
  AND score >= {BREAKOUT_MIN_MOVER_SCORE}
ORDER BY ts_created DESC
LIMIT 100
```

**Step 2 — Fetch recent SURGE stories**

```sql
SELECT
  primary_token,
  score AS surge_score,
  ts_created AS surge_ts,
  meta_json AS surge_meta
FROM Stories
WHERE story_type = 'SURGE'
  AND chain = 'ETH'
  AND ts_created >= now() - INTERVAL {BREAKOUT_WINDOW_HOURS * 2} HOUR
  AND score >= {BREAKOUT_MIN_SURGE_SCORE}
ORDER BY ts_created DESC
LIMIT 100
```

**Step 3 — Cross-reference in JS**

Build a Map keyed by `primary_token` for each result set. For each token that appears in **both**:
- Check that `|mover_ts - surge_ts| <= BREAKOUT_WINDOW_HOURS * 3600 * 1000` (milliseconds)
- Parse both `meta_json` fields with `JSON.parse()`
- Extract `change_pct` from MOVER meta and `change_pct` from SURGE meta

MOVER meta structure (from RabbitFindings via storyRabbitPublish):
```javascript
// meta.narrative_hint contains the human description
// meta.evidence contains percent change: meta.evidence.change_pct (or parse from subtitle "24H move up X%")
```

SURGE meta structure:
```javascript
// meta.change_pct — direct percent field
// meta.activity.uniq_from_1h — unique senders
// meta.label — 'thin-liquidity spike' | 'broad participation' | 'mixed participation'
```

**Step 4 — Quality check**

Only confirm if the SURGE story label is NOT `'thin-liquidity spike'`. A thin spike + mover is still weak. The combination must have at least mixed participation.

If all SURGE stories for this token are thin-liquidity, still emit but set `is_breaking = 0` and note in subtitle.

**Step 5 — Dedupe**

```javascript
const dedupeKey = `BREAKOUT_CONFIRMED|ETH|${tokenAddr}`;
```

**Step 6 — Enrich token identity**

Call `getEthName(tokenAddr, 'ETH')` for symbol/name/icon.

Exclude stablecoin addresses (check `STABLECOIN_ADDRESSES`).

**Step 7 — Score**

```javascript
const participationBonus = surgeLabel === 'broad participation' ? 1.5
                         : surgeLabel === 'mixed participation' ? 0.7
                         : 0.2;
const score = moverScore * 0.5
            + surgeScore * 0.5
            + participationBonus
            + (timeDeltaHours < 1 ? 1.0 : 0.3);  // tighter window = stronger signal
```

**Step 8 — Build meta**

```javascript
meta = {
  type: 'BREAKOUT_CONFIRMED',
  chain: 'ETH',
  token: {
    address: tokenAddr,
    address_short: formatAddress(tokenAddr),
    symbol: tokenName.symbol,
    name: tokenName.name,
    icon: tokenName.icon || null,
  },
  mover: {
    story_ts: moverTs.toISOString(),
    score: moverScore,
    narrative_hint: moverMeta.narrative_hint || null,
    change_pct: moverChangePct,
    window_start: moverMeta.window_start || null,
    window_end: moverMeta.window_end || null,
  },
  surge: {
    story_ts: surgeTs.toISOString(),
    score: surgeScore,
    change_pct: surgeChangePct,
    label: surgeLabel,
    activity: surgeMeta.activity || null,
  },
  time_delta_hours: timeDeltaHours,
  confirmation_quality: surgeLabel,  // 'broad' | 'mixed' | 'thin'
  dedupe_key: dedupeKey,
  detected_at: new Date().toISOString(),
  view: 'breakout_confirmed',
}
```

**Step 9 — Build story**

```javascript
makeStory({
  story_type: 'BREAKOUT_CONFIRMED',
  chain: 'ETH',
  primary_token: tokenAddr,
  title: `${symbol}: breakout confirmed by on-chain activity (~${timeDeltaHours.toFixed(1)}h window)`,
  subtitle: `MOVER score ${moverScore.toFixed(1)} + SURGE score ${surgeScore.toFixed(1)} • ${surgeLabel}`,
  score,
  meta,
  is_breaking: (surgeLabel === 'broad participation' && score >= 8) ? 1 : 0,
  needs_enrichment: 1,
})
```

**Step 10 — Sort and insert**

Sort by `score DESC`, take top `BREAKOUT_MAX_STORIES`, call `insertStories()`.

### run_stories.sh entry
Must run after both storyTokenMover.js and storySurge.js. Insert after the `storyRabbitPublish.js (TOKEN_MOVER windows)` block:
```bash
echo "[$TIMESTAMP] Running storyBreakoutConfirmed.js"
run_step "storyBreakoutConfirmed.js" "$LOG_DIR/storyBreakoutConfirmed.log" node storyBreakoutConfirmed.js --chain ETH
```

---

## Script 3: `storySmartMoneyStaging.js` (NEW)

### Purpose
Detect when a FUNNEL "staging" pattern points to a sink address with a historical track record of profitable exits. Standard FUNNEL stories don't differentiate between generic staging and staging by historically-correct smart money. This script adds that layer.

"Smart money" here is defined operationally: a wallet that (a) received staged inflows in the past, (b) then transferred those tokens out later at a higher price (measured by EthPrices at transfer time vs entry time).

This script reads from `RabbitFindings` (or `Stories` where `story_type IN ('FUNNEL', 'STAGING')`) and enriches the sink address with historical win-rate data.

### Story type
`SMART_STAGING`

### File location
`/Users/mini/e3d/buildDB/storySmartMoneyStaging.js`

### Environment variables
```
SMART_STAGING_WINDOW_HOURS=2         # how far back to look for FUNNEL/STAGING findings
SMART_STAGING_MAX_STORIES=5          # max stories to emit per run
SMART_STAGING_MIN_SINK_EXITS=3       # min historical exits to qualify as "smart money"
SMART_STAGING_MIN_WIN_RATE=0.5       # min fraction of exits that were profitable
SMART_STAGING_LOOKBACK_DAYS=30       # days of history to analyze for win rate
SMART_STAGING_DEDUPE_HOURS=12        # dedupe window (longer — these are rarer)
SMART_STAGING_MIN_FUNNEL_SCORE=50    # min RabbitFindings score to consider
SMART_STAGING_DEBUG=0
```

### Step-by-step logic

**Step 1 — Fetch recent non-infra FUNNEL findings**

Query RabbitFindings directly (before they're published to Stories, but also check Stories as fallback):

```sql
SELECT
  lower(toString(seed_id))    AS sink_address,
  score,
  entities_json,
  evidence_json,
  narrative_hint,
  window_start,
  window_end,
  ts_created
FROM RabbitFindings
WHERE finding_type = 'funnel'
  AND chain = 'ETH'
  AND ts_created >= now() - INTERVAL {SMART_STAGING_WINDOW_HOURS} HOUR
  AND score >= {SMART_STAGING_MIN_FUNNEL_SCORE}
ORDER BY score DESC
LIMIT 50
```

Parse `entities_json` (JSON string) for each row. Filter: skip if `entities_json` contains `"infra"` — these are infrastructure/router patterns, not staging. The FUNNEL classification embeds the type in `evidence_json.classification` or in the `narrative_hint` field (which contains "infra" or "staging").

**Step 2 — Extract sink address and token**

From `entities_json`, extract:
- `sink` or `seed_id` — the destination wallet receiving staged funds
- `core_nodes` — intermediate wallets

The associated token is often not explicit in FUNNEL findings (they track address-level flows, not token-specific). Enrich by querying recent transfers to the sink:

```sql
SELECT
  lower(toString(token))   AS token_address,
  sum(usd_amount)          AS usd_received,
  count()                  AS tx_count
FROM EthTokenTransfers
WHERE
  chain = 'ETH'
  AND lower(toString(to_addr)) = '{sink_address}'
  AND ts >= '{window_start}'
  AND ts <= '{window_end}'
  AND usd_amount >= 1000
GROUP BY token_address
ORDER BY usd_received DESC
LIMIT 5
```

Take the top token by `usd_received`. If it's a stablecoin or WETH, skip or take the next one (the staging might be accumulating stables to buy something — still interesting, note it in meta but don't exclude).

**Step 3 — Compute historical win rate for the sink address**

This is the core differentiator. For each sink, check its historical buy→sell cycles over the past `SMART_STAGING_LOOKBACK_DAYS`:

**3a — Historical receives (potential entries):**
```sql
SELECT
  lower(toString(token))  AS token_address,
  min(ts)                 AS first_receive_ts,
  sum(usd_amount)         AS total_received_usd,
  anyLast(priceUSD)       AS entry_price_usd
FROM EthTokenTransfers t
LEFT JOIN EthPrices p ON (
  lower(toString(p.address)) = lower(toString(t.token))
  AND p.chain = 'ETH'
  AND p.timestamp BETWEEN (toUnixTimestamp(t.ts) - 3600) AND (toUnixTimestamp(t.ts) + 3600)
)
WHERE
  t.chain = 'ETH'
  AND lower(toString(t.to_addr)) = '{sink_address}'
  AND t.ts >= now() - INTERVAL {SMART_STAGING_LOOKBACK_DAYS} DAY
  AND t.ts < now() - INTERVAL {SMART_STAGING_WINDOW_HOURS} HOUR
  AND t.usd_amount >= 10000
GROUP BY token_address
HAVING total_received_usd >= 50000
ORDER BY first_receive_ts DESC
LIMIT 20
```

**3b — Historical exits for those same tokens:**
```sql
SELECT
  lower(toString(token))  AS token_address,
  max(ts)                 AS last_exit_ts,
  sum(usd_amount)         AS total_exited_usd,
  anyLast(priceUSD)       AS exit_price_usd
FROM EthTokenTransfers t
LEFT JOIN EthPrices p ON (
  lower(toString(p.address)) = lower(toString(t.token))
  AND p.chain = 'ETH'
  AND p.timestamp BETWEEN (toUnixTimestamp(t.ts) - 3600) AND (toUnixTimestamp(t.ts) + 3600)
)
WHERE
  t.chain = 'ETH'
  AND lower(toString(t.from_addr)) = '{sink_address}'
  AND lower(toString(t.token)) IN ({token_list_from_3a})
  AND t.ts >= now() - INTERVAL {SMART_STAGING_LOOKBACK_DAYS} DAY
  AND t.usd_amount >= 10000
GROUP BY token_address
HAVING total_exited_usd >= 10000
```

**3c — Compute win rate in JS:**
```javascript
let wins = 0, total = 0;
for (const entry of historicalEntries) {
  const exit = historicalExits.get(entry.token_address);
  if (!exit) continue;            // no exit yet — skip
  if (exit.last_exit_ts < entry.first_receive_ts) continue;  // exit before entry = bad data
  total++;
  const pnl = exit.exit_price_usd - entry.entry_price_usd;
  if (pnl > 0) wins++;
}
const winRate = total > 0 ? wins / total : null;
```

**Step 4 — Filter**

Only proceed if:
- `total >= SMART_STAGING_MIN_SINK_EXITS` (enough history)
- `winRate >= SMART_STAGING_MIN_WIN_RATE` (actually profitable)

If `winRate` is null (no historical exits yet for this sink), still emit but with lower score and `is_breaking = 0`.

**Step 5 — Dedupe**

```javascript
const dedupeKey = `SMART_STAGING|ETH|${sinkAddress}|${topTokenAddress}`;
```

**Step 6 — Score**

```javascript
const trackRecordBonus = winRate != null
  ? 2.0 * winRate + Math.log1p(total)
  : 0;
const score = Math.log1p(funnelScore / 10)
            + trackRecordBonus
            + (usdReceived >= 1_000_000 ? 1.0 : 0);
```

**Step 7 — Enrich identities**

Call `getEthName(sinkAddress, 'ETH')` for the sink.  
Call `getEthName(topTokenAddress, 'ETH')` for the token.

**Step 8 — Build meta**

```javascript
meta = {
  type: 'SMART_STAGING',
  chain: 'ETH',
  sink: {
    address: sinkAddress,
    address_short: formatAddress(sinkAddress),
    name: sinkName.name || null,
    symbol: sinkName.symbol || null,
  },
  token: {
    address: topTokenAddress,
    address_short: formatAddress(topTokenAddress),
    symbol: tokenName.symbol,
    name: tokenName.name,
    icon: tokenName.icon || null,
    usd_received_in_window: usdReceived,
    tx_count: txCount,
  },
  funnel: {
    score: funnelScore,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    narrative_hint: narrativeHint,
    core_node_count: coreNodes.length,
  },
  track_record: {
    lookback_days: SMART_STAGING_LOOKBACK_DAYS,
    historical_cycles: total,
    wins: wins,
    win_rate: winRate,
    is_known_smart_money: winRate != null && winRate >= SMART_STAGING_MIN_WIN_RATE,
  },
  dedupe_key: dedupeKey,
  detected_at: new Date().toISOString(),
  view: 'smart_staging',
}
```

**Step 9 — Build story**

```javascript
const winRateStr = winRate != null ? `${(winRate * 100).toFixed(0)}% win rate` : 'unproven wallet';
makeStory({
  story_type: 'SMART_STAGING',
  chain: 'ETH',
  primary_token: topTokenAddress,
  title: `${tokenSymbol}: smart money staging detected (${winRateStr}, ${total} prior cycles)`,
  subtitle: `Sink ${formatAddress(sinkAddress)} received $${formatUsd(usdReceived)} via ${funnelCoreNodeCount}-node funnel • FUNNEL score ${funnelScore.toFixed(0)}`,
  score,
  meta,
  is_breaking: (winRate != null && winRate >= 0.7 && total >= 10) ? 1 : 0,
  needs_enrichment: 1,
})
```

### run_stories.sh entry
Must run after `storyRabbitFunnel.js` and `storyRabbitPublish.js`:
```bash
echo "[$TIMESTAMP] Running storySmartMoneyStaging.js"
run_step "storySmartMoneyStaging.js" "$LOG_DIR/storySmartMoneyStaging.log" node storySmartMoneyStaging.js --chain ETH
```

---

## Script 4: `storySurge.js` — Upgrade to Existing Script

### Purpose
The current script already classifies surges as `thin-liquidity spike`, `broad participation`, or `mixed participation` — but in practice all recent examples are thin-liquidity spikes. The problem: the thresholds are too easy to pass, and the scoring doesn't penalize thin spikes enough to suppress them from the trading pipeline.

This is a **targeted upgrade** to the existing `/Users/mini/e3d/buildDB/storySurge.js`. Do not rewrite the whole file — only modify the participation classification thresholds, the scoring formula, and add one new field.

### Changes required

**Change 1 — Tighten participation classification thresholds**

Find the existing classification block (approximate current logic):
```javascript
// CURRENT (too permissive):
const broadParticipation = (txNow >= 10 && uniqNow >= 6) || (txPrev > 0 && txNow / txPrev >= 2);
const thinLiquiditySpike = !broadParticipation && txNow < 6;
```

Replace with:
```javascript
// UPGRADED (higher bar for broad):
const broadParticipation = uniqNow >= 25 && txNow >= 20 && (txPrev === 0 || txNow / txPrev >= 3);
const mixedParticipation = !broadParticipation && (uniqNow >= 10 && txNow >= 8);
const thinLiquiditySpike = !broadParticipation && !mixedParticipation;
const label = thinLiquiditySpike ? 'thin-liquidity spike'
            : mixedParticipation ? 'mixed participation'
            : 'broad participation';
```

**Rationale:** 6 unique senders is easily faked by a single actor with multiple wallets. 25 unique senders with 20 transactions is a real distributed event.

**Change 2 — Update scoring to penalize thin spikes**

Find the existing score formula and replace with:
```javascript
const participationScore = broadParticipation ? 2.5
                         : mixedParticipation ? 1.0
                         : 0.1;  // thin spike: nearly no score contribution
const score = Math.log1p(Math.abs(changePct))
            + 0.7 * Math.log1p(Math.min(Math.abs(txChangePct), 500))
            + 0.4 * Math.log1p(Math.min(Math.abs(uniqChangePct), 500))
            + participationScore;
```

**Change 3 — Add `participation_type` field to meta**

In the meta object construction, add:
```javascript
meta.participation_type = label;           // 'thin-liquidity spike' | 'mixed participation' | 'broad participation'
meta.activity.sender_threshold_met = uniqNow >= 25;
meta.activity.uniq_from_1h = uniqNow;     // this likely already exists; ensure it's present
```

**Change 4 — Update is_breaking threshold**

Find the existing `is_breaking` assignment and replace:
```javascript
// CURRENT (triggers on price magnitude alone):
const is_breaking = Math.abs(changePct) >= 200 ? 1 : 0;

// UPGRADED (requires broad participation OR very large move):
const is_breaking = (broadParticipation && Math.abs(changePct) >= 40)
                 || Math.abs(changePct) >= 500
                 ? 1 : 0;
```

**Change 5 — Minimum score filter**

After building all candidate stories, filter out thin-liquidity spikes scoring below 4.0 before insertion. Keep mixed participation stories only if score >= 3.0. Broad participation stories always pass.

```javascript
const qualified = candidates.filter(c => {
  if (c.label === 'broad participation') return true;
  if (c.label === 'mixed participation') return c.score >= 3.0;
  return c.score >= 4.5;  // thin spikes need a large magnitude to survive
});
```

**No other changes.** The existing dedupe, title, subtitle, and insertion logic stays the same. Do not change CLI arg parsing or env vars.

---

## Testing Each Script

After implementing each script, test with:
```bash
cd /Users/mini/e3d/buildDB
ACCUM_DEBUG=1 node storyAccumulation.js 2>&1 | head -50
BREAKOUT_DEBUG=1 node storyBreakoutConfirmed.js 2>&1 | head -50
SMART_STAGING_DEBUG=1 node storySmartMoneyStaging.js 2>&1 | head -50
```

In debug mode each script should:
- Print the config it loaded from env vars
- Print the number of candidates found at each filtering step
- Print the top 3 candidates with their scores
- NOT insert any rows into the Stories table

For the `storySurge.js` upgrade, test by running it and verifying the `participation_type` field appears in the most recent SURGE story's `meta_json`.

---

## Integration with Trading Pipeline

Once these story types exist, the E3D trading pipeline at `/Users/mini/e3d-agent-trading-floor/` will pick them up automatically via the `/api/stories` endpoint. Scout agent will see:

- **ACCUMULATION** stories → buy signal (whale accumulating a token)
- **BREAKOUT_CONFIRMED** stories → momentum buy signal (price + activity double confirmation)
- **SMART_STAGING** stories → smart money buy signal (historically correct wallet pre-positioning)
- **SURGE (broad participation)** → momentum signal with much higher quality bar than before

The agent TOOLS.md already lists these story types to fetch:
```
https://e3d.ai/api/stories?type=ACCUMULATION&chain=ethereum&limit=10
https://e3d.ai/api/stories?type=BREAKOUT_CONFIRMED&chain=ethereum&limit=5
https://e3d.ai/api/stories?type=SMART_STAGING&chain=ethereum&limit=5
```

Add `run_step` entries to `run_stories.sh` in the order shown in each script's section above.
