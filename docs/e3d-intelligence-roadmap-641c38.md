# E3D Intelligence Integration Roadmap

This plan upgrades Scout and Harvest from price-led heuristics into a story-, thesis-, and flow-aware decision system, then exposes that intelligence clearly to managers in the dashboard.
It assumes the E3D.ai capability extension spec will provide richer upstream APIs for opportunity stories, thesis lifecycle tracking, wallet cohorts, evidence bundles, alerts, and manager briefs.

## Analysis summary

> **Status as of April 2026** — Phase 1 and Phase 2 are substantially complete. Phase 3 (Harvest decay) is partially implemented. Phases 4–5 are in progress.

- **Scout is story-driven.** The token universe is now filtered to story-backed tokens only — tokens with no story activity are excluded entirely. The primary universe fetch sorts by `storyCount` descending over the last 1 hour (`trendInterval=1H`), so the freshest on-chain signal tokens surface first.
- **Story enrichment is uncapped.** All tokens mentioned in any pre-pump or buy-signal story type are enriched into the universe regardless of their volume ranking. Story types covered: THESIS, ACCUMULATION, SMART_MONEY, STEALTH_ACCUMULATION, BREAKOUT_CONFIRMED, STAGING, CLUSTER, FUNNEL, DISCOVERY, HOTLINKS, NEW_WALLETS, DEEP_DIVE, SMART_STAGING, WHALE.
- **Thesis and candidate endpoints are live.** `/candidates` and `/theses` are both consumed by Scout each cycle. Thesis tokens are enriched into the universe even when absent from the volume feed, and a conviction ≥ 65 LONG thesis can override the `in_token_universe` gate.
- **E3D intelligence surfaces consumed today:**
  - `/api/stories` — cycle-level story feed (all types, limit 200)
  - `/api/candidates` — pre-computed multi-signal convergence candidates
  - `/api/theses` — structured investment theses with direction, conviction, price targets
  - `/api/addressMeta`
  - `/api/tokenCounterparties`
  - `/api/addressCounterparties`
  - `/fetchTokensDB`
  - `/fetchTokenPricesWithHistoryAllRanges` — with `sortBy=storyCount&trendInterval=1H`
  - `/token-info/:name`
- **Story records already carry AI fields.** `meta_json` can include `ai_narrative`, `ai_takeaways`, `ai_risks`, `source_story_id`, and derived-story counts.

## What is missing for effective trading

> Items marked ✓ are implemented. Items marked ○ remain open.

- ✓ **Story-driven token universe.** Universe is now filtered to story-backed tokens only, sorted by 1H story count.
- ✓ **Pre-pump signal enrichment.** STAGING, CLUSTER, FUNNEL, DISCOVERY, HOTLINKS, NEW_WALLETS, DEEP_DIVE, SMART_STAGING, WHALE all enrich the universe.
- ✓ **Thesis and candidate endpoints.** `/candidates` and `/theses` consumed each cycle; thesis tokens enriched into universe.
- ✓ **A unified token dossier.** `buildPortfolioIntelligenceDossier()` merges token metadata, price context, story feeds, counterparty flow, and position history into a single object per held position.
- ✓ **Decision explainability.** Manager Agent runs post-cycle and scores each agent's output with flag codes, grades, and a plain-English summary. Dashboard Reports page surfaces these.
- ○ **Thesis freshness and decay scoring.** The system detects story presence/absence but does not yet score thesis decay rate across cycles. Harvest uses story presence as a hold-confirm signal but has no explicit decay metric.
- ○ **Opportunity-cost ranking.** Scout compares candidates against each other and current holdings but has no formal cross-portfolio opportunity score.
- ○ **Training labels tied to story outcomes.** Training pipeline infrastructure exists (`extract_agent_training_data.py` spec). Story types at decision time are logged. Automated labeling from pipeline outcomes is not yet running.

## Proposed implementation plan

### Phase 1: Build an E3D intelligence dossier layer
- Create a single dossier shape for tokens and held positions that can ingest both legacy surfaces and the new capability APIs.
- Pull and normalize:
  - token metadata from `addressMeta`
  - legacy story feeds from `stories`, `stories/derived`, and `stories/watchlist`
  - new opportunity and risk stories from the capability layer
  - thesis objects and thesis lifecycle data from the capability layer
  - evidence bundles and wallet cohorts from the capability layer
  - flow evidence from `tokenCounterparties` and `addressCounterparties`
  - category momentum from `categoryTokensLastHour`
  - broad market discovery from `fetchTokensDB`
- Derive or consume a small set of stable scores:
  - `thesis_strength`
  - `thesis_freshness`
  - `narrative_decay`
  - `flow_alignment`
  - `liquidity_quality`
  - `fraud_risk`
  - `opportunity_score`
- Add a short evidence bundle for each token:
  - top story or stories
  - why the story matters
  - what weakens the thesis
  - what confirms it
  - whether the token is better framed as a buy, hold, trim, exit, or watch

### Phase 2: Upgrade Scout into a thesis-aware opportunity engine ✓ Complete

- Scout is responsible for **discovering** new names, not trading them.
- The token universe is filtered to story-backed tokens only, sorted by 1H story count. Tokens with no story activity are excluded.
- Signal priority (hardcoded in prompt): E3D candidates → E3D theses → thesis stories → buy-signal stories → flow-only (last resort).
- Pre-pump story types (STAGING, CLUSTER, FUNNEL, DISCOVERY, HOTLINKS, NEW_WALLETS, DEEP_DIVE, SMART_STAGING, WHALE, ACCUMULATION, SMART_MONEY, STEALTH_ACCUMULATION) enrich the universe and are `in_token_universe=true`.
- Post-pump types (MOVER, SURGE) are shown as LATE SIGNALS — Scout is instructed not to buy these as new entries.
- Scout output includes `evidence[]`, `why_now`, `risks[]`, `conviction_score`, `confidence`, entry zone, invalidation price, and targets.
- Returns 0–3 candidates. Returning 0 is correct when nothing meets the bar.

### Phase 3: Upgrade Harvest into a thesis-decay and trim engine
- Keep Harvest responsible for **protecting capital** and **harvesting gains**.
- Change Harvest to evaluate:
  - whether the original story still applies
  - whether derived stories are multiplying or fading
  - whether the thesis lifecycle is strengthening, stalling, or breaking
  - whether wallet flow is confirming distribution or accumulation
  - whether a win is mature enough to trim even if the chart still looks healthy
- Add explicit exit/trim reasoning for:
  - profit stretch
  - thesis decay
  - liquidity deterioration
  - distribution pressure
  - opportunity-cost rotation
- Make Harvest emit structured outcomes for:
  - `hold`
  - `monitor`
  - `trim`
  - `exit`

### Phase 4: Add manager-grade visibility in the app
- Add a dashboard view that shows the intelligence layer, not just price and positions.
- Surface:
  - top active opportunity stories per held token
  - top active risk stories per held token
  - thesis freshness, decay, and lifecycle state
  - counterparty / flow confirmation
  - best new opportunities vs weakest current positions
  - evidence bundles and wallet cohorts
  - what changed since the last cycle
- Add concise “desk note” style summaries for hedge fund operators:
  - why this is in the book
  - why it should stay in the book
  - why it should come out of the book

### Phase 5: Improve the training loop
- Extend pipeline logging so every decision keeps its evidence chain.
- Add labels for:
  - story-driven entries
  - opportunity-story entries
  - thesis-driven exits
  - trims from stretched winners
  - false positives
  - missed opportunities
  - story / thesis decay events
- Keep paper-trade-first behavior, but make the logs rich enough to evaluate whether the new intelligence layer improves decisions over time.

## Recommended order of work
1. Build the dossier layer and scoring helpers that can consume the new E3D capability APIs.
2. Map Scout to opportunity stories, theses, and flow evidence.
3. Map Harvest to thesis decay, risk stories, and trim/exit logic.
4. Add the dashboard intelligence views.
5. Add logging and evaluation labels.

## Discussion questions
- Should the dossier live in `server.js`, `pipeline.js`, or a shared helper module?
- Should `thesis_freshness` be a hard gate or a soft score?
- Should Harvest be allowed to force a trim when thesis decay is high even if price remains strong?
- Which signals should be mandatory before Scout can emit a buy candidate?
- Do we want a dedicated “watchlist” for story-rich tokens that are not yet buys?
- Which of the new E3D capability APIs should be consumed directly in the first implementation pass versus derived from legacy story data?
