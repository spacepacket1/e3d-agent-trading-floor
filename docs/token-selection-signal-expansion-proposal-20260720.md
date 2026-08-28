# Token-Selection Signal Expansion — Proposal

## 0. Why this document exists

Lifetime paper-trading performance is still deeply negative: -$9,059 realized PnL over 1,304 trades, profit factor 0.26 (per the latest signal-attribution report, `reports/attribution/signal-attribution-20260720-132621.md`). Of that deficit, **~53% ($4,776) is fee/slippage drag, not bad picks** — a separate execution-reliability issue that was partially addressed on 2026-07-19 (harvest JSON-retry + cycle-isolation fixes; see `logs/pipeline.jsonl` around that date).

The user asked for three things: (1) review the current token-picking algorithm, (2) survey other well-known methods for picking winners — specifically floating social media, stock-market correlation, politics, macro-economics, and astrology — and (3) figure out how to weave the promising ones in. This document is the "review + survey" deliverable; **no code has been changed as part of this document** — the user asked for a ranked proposal first, to pick from before anything gets built.

Two existing docs are directly relevant and this proposal builds on them rather than repeating them:
- `docs/quant-data-integration-spec.md` — documents four external signal sources *already implemented*: DexScreener order flow, Fear & Greed index, CoinGecko BTC/ETH momentum, Binance perp funding rates. Anything below that overlaps with these is called out explicitly.
- `docs/trading-agent-performance-enhancements-20260427.md` — a broader feature ticket that already proposed a "Signal Curator" agent and expanded signal ingestion as part of a bigger architecture (Trade Reviewer, Position Sizer, Regime Sentinel). This document's recommendations are scoped to fit inside that existing plan, not compete with it.

---

## 1. Current algorithm — how a token gets picked today

**Sourcing.** Two Scout implementations exist in `pipeline.js`; only one is active (`runScoutWithTools` / "cognitive state" path, gated by `TOOL_USE_ENABLED`). It pulls from three E3D API calls per cycle (`/candidates`, `/stories`, token-price universe) and merges them into a raw candidate pool. A second, dormant implementation (`runScoutDirect`, the older "evidence packet" path) has richer sourcing — theses, watchlist, an avoid-set — but is currently switched off. This is worth knowing: some of what feels "missing" below is actually already built, just not wired into the live path.

**Deterministic scoring (pre-LLM).** `computeCandidateScorecard` (`pipeline.js:3251-3341`) already blends: liquidity (hard floor $100k), momentum (rejects >300% 7-day pumps as "already pumped"), fraud/fragility gates, ~25 typed on-chain/narrative "story" signals (ACCUMULATION, SMART_MONEY, WHALE, TREASURY_DISTRIBUTION, etc. — an internal narrative-detection system), a proprietary "Decision Layer" (OTA) action score, DexScreener order flow (buy/sell ratio → accumulation/distribution), Binance perp funding (crowding/squeeze), and a BTC/ETH + Fear&Greed macro regime. This is a genuinely broad feature set — the picture of "the algorithm barely uses any signals" is not accurate.

**The LLM's role.** Scout is a filter + prioritizer + narrative generator over a pre-scored shortlist — it does not discover candidates or do final ranking. A deterministic formula (`computePositionScoreLike`, `pipeline.js:1170-1188`) reorders everything before execution, and a second deterministic gate (`deterministicBuyGate`, `pipeline.js:7058-7118`) re-checks hard thresholds after the LLM call, before Risk even runs. The LLM's own self-reported `confidence`/`conviction_score`/`opportunity_score` do meaningfully drive final ranking, though — they aren't independently verified before being used as ranking inputs.

**A real, fixable bug found during this review.** The final buy-ranking formula (`computePositionScoreLike`) is:

```
opportunity_score*0.35 + conviction_score*0.30 + liquidity_quality*0.20 + change_24h*0.10 − fraud_risk*0.25 − slippage_bps/10*0.05
```

For *fresh buy candidates*, `liquidity_quality` and `fraud_risk` are **never populated** — Scout's output schema doesn't request them, and nothing else fills them in before ranking (they're only ever set on existing *positions*, via the harvest-side `updateHoldingsFromScout`, `pipeline.js:7732/7734`). So roughly **45% of this formula's weight is silently dead** on every new-position ranking decision — it's effectively just `opportunity_score*0.35 + conviction_score*0.30 + change_24h*0.10`, driven almost entirely by the LLM's own unverified self-assessment. This should be fixed before anything else in this document — it's cheap, high-confidence, and doesn't need any new data source (the same E3D risk metadata already used in `deterministicBuyGate` can populate these fields for new candidates too).

---

## 2. What's actually absent

Confirmed by direct code search — genuinely zero presence of:
- Any social-media signal (Twitter/X, Reddit, Telegram, Discord). The only "social-ish" field is CoinGecko's `sentiment_up_pct`, a site vote ratio, not platform activity.
- Any cross-asset/equity-market correlation beyond BTC/ETH (no S&P/Nasdaq/DXY logic).
- Any macro indicator beyond Fear & Greed (no rates, CPI, DXY, FOMC calendar).
- Any political/regulatory event tracking.
- Astrology/lunar-cycle signals (confirmed absent, zero matches).

---

## 3. Ranked catalogue of candidate signal families

Each rated on **Evidence** (does this credibly predict price, per established quant/crypto practice — and is that distinguishable from "widely believed but never actually shown to work"), **Effort** (fits the existing architecture vs. needs new infrastructure), and **Data availability** (free/cheap, since there's no existing paid data-provider access).

### 3.1 Social media / sentiment volume — the user's top suggestion, and the biggest real gap

**Evidence: mixed.** This is the one worth being most honest about. Social mention-volume spikes are well-documented as a *coincident-to-lagging* indicator more often than a *leading* one — buzz tends to peak near local tops (the "everyone's talking about it" moment is often distribution, not accumulation). The credible framing from quant/crypto-sentiment research is "sentiment as a confirmation or contrarian filter," not "high mentions → buy." Naively wiring in "more tweets = buy signal" would likely just add noise or, worse, systematically buy tops.

**Free-tier data options:**
| Source | Signal | Free tier | Verdict |
|---|---|---|---|
| Reddit API | Subreddit mention/comment velocity per token | Free, generous enough for hourly polling | Best cost/effort ratio |
| X/Twitter API | Mention volume, engagement | Free tier is heavily rate-limited (small monthly post cap) | Likely too thin for hourly-cycle trading |
| Google Trends (unofficial) | Search interest | Free | Weekly resolution — too coarse for an hourly pipeline |
| CoinGecko `sentiment_up_pct` | Site vote ratio | Already partially wired in | Not a real social-platform signal, but zero incremental cost to lean on harder |

**Recommendation if greenlit:** pilot Reddit mention-velocity as a new story-signal-like input, explicitly framed as a *confirmation/contrarian* layer alongside existing ACCUMULATION/SMART_MONEY story types — not a standalone buy trigger. Evaluate its actual expectancy contribution via the existing signal-attribution tool (`scripts/signalAttribution.js`) before giving it real scoring weight, the same way any other setup type gets judged.

### 3.2 On-chain whale / exchange-flow depth

**Evidence: reasonably well-established.** Large net inflow to centralized exchanges preceding sell pressure is a widely-replicated on-chain heuristic. This *extends* rather than duplicates what's already present (WHALE/SMART_MONEY story types, DexScreener buy/sell ratio) by adding real exchange-netflow depth.

**Effort/availability: moderate-to-hard.** The good version of this data (Glassnode/Nansen/Arkham-tier) is paid. Free alternatives exist but are thinner and harder to keep current. **Roadmap item, not a near-term pilot**, given the no-paid-API constraint.

### 3.3 Developer activity (GitHub commit/contributor velocity)

**Evidence: real, but slow-moving.** This is a *project-quality/survival* filter, not a short-term price predictor — it correlates with multi-month project health, not next-cycle price action. In a pipeline trading on hourly cycles, this is better used as a coarse category filter (e.g., down-weight or avoid tokens with dead repos) than as a scored ranking factor.

**Effort/availability: easy, free** — GitHub's API is free and simple to poll for commit/contributor counts. Low priority given the mismatch between this signal's time horizon and the pipeline's trading cadence, but cheap enough to be worth doing eventually as a hygiene filter.

### 3.4 Macro / cross-asset beyond Fear & Greed — the user's "stock market" and "macro-economics" suggestions

**Evidence: real and well-established.** BTC's correlation with tech-heavy equity indices (Nasdaq) has been well-documented since 2020 — crypto increasingly trades as a high-beta risk asset alongside growth stocks, not in isolation. DXY (dollar strength) inverse-correlation with risk assets broadly, including crypto, is a standard macro-desk heuristic.

**Effort: low.** This is architecturally identical to the BTC/Fear&Greed regime blend already built and documented in `quant-data-integration-spec.md` — it's a **regime-level overlay** (feeds `regimePolicy`/allocation multiplier), not a per-token score. Adding 1-2 more free data pulls (a DXY proxy and a Nasdaq/equity index, both available via free-tier market-data APIs like the same CoinGecko-adjacent or a free stock-index endpoint) slots directly into the existing `_cycleQuantContext` pattern.

**Recommendation if greenlit:** highest-value item after the bug fix — cheap, reuses a proven pattern, addresses a real and current gap (crypto-equity correlation has only gotten stronger since this pipeline's macro logic was built).

### 3.5 Political / regulatory events — the user's "politics" suggestion

**Evidence: real impact, but event-driven, not continuous.** SEC enforcement actions, ETF approvals, and election-driven policy shifts have moved crypto markets materially and abruptly. But this is fundamentally a discrete-event signal, not something that fits the same continuous 0-100 scorecard treatment as liquidity or momentum.

**Recommendation:** don't try to build a per-token political-risk score — the effort/reward is poor and the false-precision risk is high. Instead, treat it the way `tighten_stops` already works: a coarse, cycle-level "regulatory risk-off" flag that an operator (or a cheap headline-keyword scan over a free crypto-news RSS feed) can set to temporarily tighten `regimePolicy`. Low priority, small scope if ever built.

### 3.6 Astrology / lunar cycles — addressed directly since the user raised it

**No causal mechanism, no evidence base that survives basic backtesting scrutiny.** Including it wouldn't add signal — it would add a free parameter for an already-noisy system to overfit to, which is a real cost, not a neutral one. Recommendation: exclude. Stated plainly, not belabored further.

### 3.7 Historical market cycles — raised as a follow-on to the macro overlay, backlogged

Two distinct ideas hide under "historical cycles," worth keeping separate:

- **Macro business-cycle stage** (rate-hike/cut cycle, yield curve, recession/expansion). **Evidence: real**, and this is a genuinely different signal than the DXY/equity overlay in `docs/macro-cross-asset-regime-overlay-feature-ticket-20260721.md` — that overlay is a fast, reactive daily read; a Fed-cycle-stage indicator would be a slow-moving prior (weeks-to-months) that modulates risk appetite/sizing rather than gating individual cycles. Same signal family (macro), different timescale layer. Worth a follow-on ticket once the DXY/equity overlay has proven itself via its own Phase 4 validation.
- **Crypto's "4-year halving cycle."** **Evidence: thin.** Popular in crypto circles, but we've only lived through 3-4 of them — treating it as more than a very soft prior risks overfitting to a handful of data points dressed up as a pattern. Not recommended beyond that.

**Status: backlogged**, not scheduled. Revisit after the DXY/equity overlay (item 2 below) has run long enough to validate via `signalAttribution.js`, per the guardrail in Section 5 — don't stack another macro layer on top before the first one's proven out.

---

## 4. Suggested build order, if any of this gets greenlit

Ordered by (confidence × effort), highest value first:

1. **Fix the dead `fraud_risk`/`liquidity_quality` fields** in `computePositionScoreLike` (Section 1). No new data source, high confidence, should happen regardless of anything else below.
2. **Macro/cross-asset regime overlay** — DXY + equity-index correlation, extending the existing `_cycleQuantContext` pattern from `quant-data-integration-spec.md`. Cheap, well-evidenced, addresses a real current gap.
3. **Reddit-based social mention-velocity pilot** — framed as a confirmation/contrarian signal, not a standalone trigger, and run through `signalAttribution.js` before being trusted with real scoring weight.
4. **Roadmap, not near-term:** on-chain exchange-flow depth (needs paid data for the good version), developer-activity hygiene filter (right evidence, wrong time horizon for this pipeline), coarse political/regulatory flag (real but low ROI to automate), macro business-cycle stage / Fed-cycle prior (Section 3.7 — backlogged until the DXY/equity overlay validates).
5. **Excluded:** astrology, crypto halving-cycle pattern-matching (Section 3.7).

---

## 5. Guardrail

Any new signal — however well-evidenced in general — should go through the same evidence-gated discipline already built into this system before being trusted with real weight: the signal-attribution report's expectancy-by-group breakdown, and the training-promotion gate's regression check. This document deliberately does not oversell "more signals" as *the* fix — half of the current deficit is fee/slippage execution drag, not signal quality, and no amount of new data sources fixes that.
