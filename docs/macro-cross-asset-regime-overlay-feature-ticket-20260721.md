# Macro Cross-Asset Regime Overlay — Feature Ticket

## Overview

The pipeline already blends BTC 24h momentum and the Fear & Greed index into a single
`macro.regime` signal each cycle (see `docs/quant-data-integration-spec.md`), which gates
new buys, rotations, and allocation sizing via the Regime Sentinel (`buildRegimeSentinelPolicy`,
`pipeline.js:1556`). That blend is crypto-only — it has no visibility into the broader
risk-asset environment (equities) or dollar strength (DXY), both of which are well-established
cross-asset risk-on/risk-off signals. BTC's correlation with tech-heavy equity indices has been
well-documented since 2020, and DXY strength inversely correlates with risk-asset appetite
broadly, crypto included.

This ticket adds two more free, keyless data pulls (DXY and a broad equity/tech index) and
folds them into the *existing* regime-blend pattern — this is additive to a proven mechanism,
not a new subsystem. See `docs/token-selection-signal-expansion-proposal-20260720.md` §3.4 for
the full rationale and evidence assessment behind this addition.

**Run this spec from the `e3d-agent-trading-floor` root:**

```bash
codex-spec-runner docs/macro-cross-asset-regime-overlay-feature-ticket-20260721.md all --provider claude
```

**Or phase-by-phase:**

```bash
codex-spec-runner docs/macro-cross-asset-regime-overlay-feature-ticket-20260721.md 1 --provider claude
```

---

## Background

### What exists today (`marketData.js`)

`buildCycleQuantContext()` (`marketData.js:220`) makes two macro calls per cycle —
`fetchFearAndGreed()` and `fetchCryptoMacro()` — and blends them into a single regime:

```js
const fgValue = fearGreed?.value   ?? 50;
const btc24h  = macro?.btc_24h_pct ?? 0;
const regime =
  (fgValue >= 80 || btc24h >  10) ? "extreme_greed" :
  (fgValue >= 60 || btc24h >   4) ? "greed"         :
  (fgValue <= 20 || btc24h <  -8) ? "extreme_fear"  :
  (fgValue <= 35 || btc24h <  -4) ? "fear"          :
                                    "neutral";

const newPositionsOk = fgValue < 75 && btc24h > -4;
const tightenStops   = fgValue > 75 || btc24h < -5;
```

The result is stored on `_cycleQuantContext.macro` (module-scope in `pipeline.js`, reset each
cycle) and consumed in two places:

1. **Regime Sentinel** (`buildRegimeSentinelPolicy`, `pipeline.js:1556`) — takes
   `regimePolicy(macro.regime)` as its baseline (`allow_buys`, `allow_rotations`,
   `allocation_multiplier`, `max_buys_per_cycle`), then layers real-time performance
   throttling on top. **This is what actually gates trading** — `regime` alone is not a
   per-token score, it's a cycle-wide multiplier.
2. **LLM system prompts** — both Scout (`pipeline.js:5067`) and Harvest (`pipeline.js:6656`)
   inject a one-line `MACRO: regime=... new_positions_ok=... tighten_stops=...` string built
   from `macroContext = _cycleQuantContext?.macro`.

### What this ticket adds

Two more fields on the same `macro` object — `dxy` and `equity_index` — sourced from free,
keyless endpoints, folded into the *same* threshold-blend pattern shown above (not a parallel
system). No new agent, no new gating mechanism — this widens an existing one.

### Constraints

- No paid data provider. Use free/keyless endpoints only (Yahoo Finance's unofficial quote
  endpoint and stooq.com's CSV endpoints are the two realistic options — see Appendix).
- Equity markets close nights/weekends/holidays; crypto does not. Do not treat a stale
  "flat" reading from a closed market as a genuine neutral signal — see Phase 1.
- Maps fetch failures must be non-fatal, matching the existing pattern for every other
  quant data source in `marketData.js` (`fetchFearAndGreed`/`fetchCryptoMacro` both return
  `null` on error, never throw) — DXY/equity fetchers must follow the same contract.
- Do not modify the deterministic buy-gate safety floors, risk engine, or promotion gates.
- Do not change `regimePolicy()`'s existing risk_on/risk_off/neutral tiers — only change what
  feeds `regime` and add observability (reason codes), per Phase 2/3 below.

---

## Phase 1 — DXY and Equity Index Data Client

Add two fetchers to `marketData.js`, following the exact pattern of `fetchFearAndGreed()`
and `fetchCryptoMacro()` (`marketData.js:124-165`) — same `curlJson()` helper, same
never-throw/return-null-on-error contract.

### What to build

```js
// ── Cross-asset macro (DXY + equity index) ──────────────────────────────────

// Primary: Yahoo Finance unofficial quote endpoint (free, keyless, occasionally rate-limited).
// Fallback: stooq.com CSV endpoint (free, keyless, more stable but lower-frequency).
const YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const STOOQ_CSV_URL = "https://stooq.com/q/d/l";

// Returns { value, change_24h_pct, as_of, source, market_open } or null on total failure.
// `as_of` is the timestamp of the underlying quote (may lag "now" when the market is closed).
// `market_open` is a best-effort bool so callers can decide whether to trust a flat reading.
function fetchYahooQuote(ticker) { ... }

// CSV fallback — parses stooq's last two daily closes to compute change_pct when Yahoo fails.
function fetchStooqDailyChange(stooqSymbol) { ... }

// DXY proxy. Yahoo ticker: "DX-Y.NYB". Stooq fallback symbol: "dx.f" (US Dollar Index futures).
export function fetchDollarIndex() {
  // Try fetchYahooQuote("DX-Y.NYB") first; on failure/null, try fetchStooqDailyChange("dx.f").
  // Return null if both fail — never throw.
}

// Broad equity/tech index. Yahoo ticker: "^NDX" (Nasdaq-100). Stooq fallback: "^ndx".
export function fetchEquityIndex() {
  // Same try/fallback pattern as fetchDollarIndex, using the Nasdaq-100 ticker.
}
```

### Market-hours handling

Equity markets are closed nights/weekends/US holidays. A naive "latest close vs previous
close" is fine even when the market is currently closed (it just reflects the last completed
session), but do **not** compute "24h change" as "value now vs value 24h ago" the way the
crypto fetchers do — during a weekend, that would compare Friday's close to itself and report
a false `0%` (misread as "neutral") rather than "no new data." Use the underlying
close-to-close change from the last two available daily bars, and set `market_open: false`
when the most recent quote timestamp is more than ~90 minutes old during what would be a
weekday session — callers use this to decide whether to trust the reading (Phase 2).

### Verification

Add `scripts/verifyMacroCrossAssetClient.js`, matching `scripts/verifyMapsClient.js`'s
pattern:
1. Call `fetchDollarIndex()` and `fetchEquityIndex()`.
2. Log a result summary: value, change_24h_pct, source (yahoo/stooq), market_open, for each.
3. Exit 0 on success even if both return `null` (that's an acceptable degraded state — print
   `WARN: cross-asset macro data unavailable` in that case), exit 1 only if either function
   throws (it shouldn't).

Add to `package.json`'s `check` script:
```
node --check scripts/verifyMacroCrossAssetClient.js
```
and an npm script:
```
"macro:verify": "node scripts/verifyMacroCrossAssetClient.js"
```

---

## Phase 2 — Blend Into the Unified Macro Regime

Wire the two new fetchers into `buildCycleQuantContext()` and widen the regime-blend logic.

### What to build (`marketData.js`)

In `buildCycleQuantContext()`, alongside the existing `fetchFearAndGreed()`/`fetchCryptoMacro()`
calls:

```js
const dxy         = fetchDollarIndex();
const equityIndex = fetchEquityIndex();
```

Extend the regime blend. Only apply DXY/equity conditions when the reading is fresh
(`market_open` true, or the reading is a valid last-session close — i.e., not `null`):

```js
const dxySpike     = dxy?.change_24h_pct != null && dxy.change_24h_pct > 0.5;   // strong dollar day
const equitySelloff = equityIndex?.change_24h_pct != null && equityIndex.change_24h_pct < -2;
const equityRally   = equityIndex?.change_24h_pct != null && equityIndex.change_24h_pct > 2;

const regime =
  (fgValue >= 80 || btc24h >  10 || equityRally)                  ? "extreme_greed" :
  (fgValue >= 60 || btc24h >   4)                                 ? "greed"         :
  (fgValue <= 20 || btc24h <  -8 || equitySelloff)                ? "extreme_fear"  :
  (fgValue <= 35 || btc24h <  -4 || dxySpike)                     ? "fear"          :
                                                                     "neutral";

const newPositionsOk = fgValue < 75 && btc24h > -4 && !equitySelloff;
const tightenStops   = fgValue > 75 || btc24h < -5 || dxySpike || equitySelloff;
```

Add `dxy` and `equity_index` to the returned `macro` object:
```js
macro: {
  fear_greed: fearGreed,
  btc: macro ? { price: macro.btc_price, change_24h_pct: macro.btc_24h_pct } : null,
  eth: macro ? { ... } : null,
  dxy: dxy ? { value: dxy.value, change_24h_pct: dxy.change_24h_pct, source: dxy.source } : null,
  equity_index: equityIndex ? { value: equityIndex.value, change_24h_pct: equityIndex.change_24h_pct, source: equityIndex.source } : null,
  regime,
  new_positions_ok: newPositionsOk,
  tighten_stops: tightenStops,
},
```

### Regime Sentinel reason codes (`pipeline.js`)

In `buildRegimeSentinelPolicy` (`pipeline.js:1556`), alongside the existing informational
reason-code line:
```js
if (macro?.btc && toNum(macro.btc.change_24h_pct, 0) < -3) reasonCodes.push("btc_downtrend");
```
add two parallel annotations (informational, matching the existing `btc_downtrend` pattern —
the actual gating already happened via `regime` in Phase 2, these are for observability):
```js
if (macro?.equity_index && toNum(macro.equity_index.change_24h_pct, 0) < -2) reasonCodes.push("equity_selloff_correlated");
if (macro?.dxy && toNum(macro.dxy.change_24h_pct, 0) > 0.5) reasonCodes.push("dollar_strength_headwind");
```

### Verification

1. `npm run check` passes.
2. Run `node scripts/verifyMacroCrossAssetClient.js` — confirms the client works standalone.
3. Run `node pipeline.js --once` with `PIPELINE_DEBUG_MODE=1`. Confirm `logs/pipeline.jsonl`'s
   `quant_context` stage (or the raw `_cycleQuantContext` dump) includes non-null `dxy`/
   `equity_index` fields when the underlying fetch succeeds.
4. Confirm a simulated fetch failure (e.g., temporarily point `YAHOO_QUOTE_URL` at an invalid
   host) does not throw — the cycle should complete normally with `dxy`/`equity_index` as
   `null` and the regime blend falling back to the existing BTC/Fear&Greed-only logic.

---

## Phase 3 — Prompt Injection and Log Enrichment

### System prompt (`pipeline.js`)

At both existing `MACRO: regime=...` injection points (`pipeline.js:5067` in Scout,
`pipeline.js:6656` in Harvest), extend the line when the new fields are present:

```js
macroContext ? `MACRO: regime=${macroContext.regime} new_positions_ok=${macroContext.new_positions_ok} tighten_stops=${macroContext.tighten_stops}` +
  (macroContext.dxy ? ` dxy_24h=${macroContext.dxy.change_24h_pct}%` : "") +
  (macroContext.equity_index ? ` equity_24h=${macroContext.equity_index.change_24h_pct}%` : "")
  : "",
```

### PIPELINE_LOG enrichment (`pipeline.js:9443`)

The cycle-summary `quant_context` stage currently logs:
```js
{ stage: "quant_context", data: { macro_regime: _cycleQuantContext?.macro?.regime, new_positions_ok: ..., tighten_stops: ... } }
```
Add the two new fields so retrospective analysis (and the existing signal-attribution tool)
can see what cross-asset macro looked like at decision time:
```js
{ stage: "quant_context", data: {
  macro_regime: _cycleQuantContext?.macro?.regime,
  new_positions_ok: _cycleQuantContext?.macro?.new_positions_ok,
  tighten_stops: _cycleQuantContext?.macro?.tighten_stops,
  dxy_change_24h_pct: _cycleQuantContext?.macro?.dxy?.change_24h_pct ?? null,
  equity_change_24h_pct: _cycleQuantContext?.macro?.equity_index?.change_24h_pct ?? null
} }
```

### Verification

1. `npm run check` passes.
2. With `PIPELINE_DEBUG_MODE=1`, run a cycle and confirm the `dxy_24h=`/`equity_24h=`
   suffixes appear in the logged Scout and Harvest system prompts in `logs/agent-raw.jsonl`
   when data is available, and are cleanly omitted (not `undefined`/`NaN`) when it isn't.
3. Confirm the new `dxy_change_24h_pct`/`equity_change_24h_pct` fields appear in the
   `quant_context` stage entry in `logs/pipeline.jsonl` for the cycle just run.

---

## Phase 4 — Manual Validation Against Historical Risk-Off Days

This phase is a manual/analytical check, not a code change — confirm the new signal would
have added value on a day it should have mattered, per the standing guardrail (any new
signal should be evidence-checked, not trusted on theoretical grounds alone — see
`docs/token-selection-signal-expansion-proposal-20260720.md` §5).

### What to do

1. Pull historical DXY and Nasdaq-100 daily closes for 2026-07-12 through 2026-07-16 (the
   losing streak documented in prior analysis — see conversation history / daily performance
   reports `reports/performance-daily-202607{13,14}.md`, both deeply negative days).
2. Compute what `dxySpike`/`equitySelloff`/`equityRally` would have evaluated to on those
   dates using the Phase 2 thresholds.
3. Document the finding directly in this file (append a `### Result` subsection below) —
   either:
   - The new signal would have flagged one or both bad days as `fear`/`extreme_fear` or
     triggered `tighten_stops` — supporting evidence this overlay adds real value, or
   - The bad days were crypto-idiosyncratic (no corresponding equity/DXY stress) — meaning
     this overlay wouldn't have helped *that specific episode*, which is fine and worth
     recording honestly rather than overselling the feature.
4. Do **not** tune the Phase 2 thresholds retroactively to make this one historical episode
   look better in hindsight — that's overfitting to n=1. If the thresholds need adjustment,
   that should come from a broader sample via the signal-attribution tool after this has been
   live for a few weeks, not from this single backward-looking check.

### Verification

No automated check for this phase — completion criteria is the `### Result` subsection being
appended to this document with the actual historical values and conclusion.

### Result (completed 2026-07-21)

Pulled actual Yahoo Finance daily closes for DXY and Nasdaq-100 covering 2026-07-08 through
2026-07-17:

| Session date | NDX close | NDX chg vs. prior session | DXY close | DXY chg vs. prior session |
|---|---|---|---|---|
| 07-10 | 29825.11 | — | 100.97 | +0.03% |
| 07-13 | 29264.10 | **-1.88%** | 101.28 | +0.31% |
| 07-14 | 29586.29 | +1.10% | 100.94 | -0.34% |
| 07-15 | 29502.60 | -0.28% | 100.50 | -0.44% |
| 07-16 | 29025.77 | **-1.62%** | 100.73 | +0.23% |
| 07-17 | 28592.66 | -1.49% | 100.75 | +0.02% |

Mapped against the daily performance-report windows (each spans prior-day 06:30 → same-day
06:30 PST, so e.g. the "07-14" report window runs 07-13 06:30 → 07-14 06:30 PST and overlaps
almost entirely with the July 13 equity session):

- **The worst trading day in the sample (07-14 report window: 34 trades, 0% win rate,
  -$56.73)** overlaps with the July 13 NDX session, which fell **-1.88%** while DXY rose
  **+0.31%** — directionally exactly the risk-off pattern this overlay targets, but **both
  readings fall short of the Phase 2 thresholds** (`equitySelloff` requires < -2%, `dxySpike`
  requires > +0.5%). This overlay would **not** have flagged that day.
- **Another deeply negative day (07-17 report window: 19 trades, 0% win rate, -$171.74)**
  overlaps with the July 16 NDX session, -1.62% with DXY +0.23% — same story: right direction,
  under threshold.
- No session in this window crossed either threshold in the risk-off direction. July 12's
  window (07-13 report: -$103.60, 8% win rate) mostly falls over a weekend with no fresh
  equity/DXY data at all (07-11/07-12 had no trading sessions) — this overlay would have had
  nothing new to say about that day regardless of thresholds.

**Conclusion: this overlay would not have caught the July 13-17 losing streak.** That's
consistent with the earlier root-cause finding for that specific episode (harvest's
50%-fraction-trim execution bug, fixed 2026-07-19) rather than a missing macro signal — the
equity moves that week were real but moderate, the kind of day-to-day volatility a portfolio
should absorb without a special override, not a genuine risk-off event. Per the instruction
above, **thresholds were not adjusted** to make this episode look like a catch — a -1.6% to
-1.9% NDX day being just under a -2% threshold is not evidence the threshold is wrong, it's
one data point. Revisit threshold calibration only after this has run live for a few weeks and
`signalAttribution.js` has a real sample to evaluate against.

This overlay remains a reasonable addition on its own merits (real, if moderate, deterministic
effect on harvest exit sizing via `tighten_stops`, well-evidenced cross-asset correlation) —
it just wasn't the fix for this particular past episode, and shouldn't be sold as one.

---

## Appendix: Free Data Source Notes

**Yahoo Finance unofficial quote endpoint** (`query1.finance.yahoo.com/v8/finance/chart/{ticker}`):
free, no API key, returns OHLC + meta including `regularMarketPrice`, `previousClose`,
`regularMarketTime`. Undocumented and occasionally rate-limited or restructured without
notice — this is the known tradeoff versus the crypto-native sources already in the pipeline
(CoinGecko/alternative.me/Binance), which are more stable at this free tier.

**stooq.com CSV endpoint** (`stooq.com/q/d/l/?s={symbol}&i=d`): free, no API key, returns
daily OHLC as CSV. Generally more stable than scraping Yahoo but lower-frequency (end-of-day
granularity) and less battle-tested in this codebase — use as the fallback path, not primary.

**Relevant tickers:**
| Instrument | Yahoo ticker | Stooq symbol |
|---|---|---|
| US Dollar Index (DXY) | `DX-Y.NYB` | `dx.f` |
| Nasdaq-100 | `^NDX` | `^ndx` |
| S&P 500 (alternative broad-equity option) | `^GSPC` | `^spx` |

If Yahoo's endpoint proves too unreliable in practice, Nasdaq-100 futures (`NQ=F` / stooq
`nq.f`) trade near-24/7 on CME Globex and would sidestep the market-hours handling in Phase 1
entirely — worth switching to if Phase 4's validation surfaces stale-data problems.
