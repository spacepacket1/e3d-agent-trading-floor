# E3D Intelligence Integration Roadmap

This plan upgrades Scout and Harvest from price-led heuristics into a story-, thesis-, and flow-aware decision system, then exposes that intelligence clearly to managers in the dashboard.
It assumes the E3D.ai capability extension spec will provide richer upstream APIs for opportunity stories, thesis lifecycle tracking, wallet cohorts, evidence bundles, alerts, and manager briefs.

## Analysis summary
- **Scout is underpowered today.** It already has some E3D references, but the active prompt is still mostly momentum-driven.
- **Harvest is partially thesis-aware.** It looks at price extension and liquidity, but it does not yet consume a rich narrative decay model.
- **E3D has useful intelligence surfaces already.** The most relevant routes we found today are:
  - `/api/stories`
  - `/api/stories/derived`
  - `/api/stories/watchlist`
  - `/api/addressMeta`
  - `/api/tokenCounterparties`
  - `/api/addressCounterparties`
  - `/api/categoryTokensLastHour`
  - `/fetchTokensDB`
  - `/token-info/:name`
- **The capability extension spec should add new upstream intelligence APIs.** The roadmap should expect surfaces such as opportunity stories, risk stories, theses, evidence bundles, wallet cohorts, opportunity ranking, briefs, alerts, and simulations.
- **There is no dedicated thesis endpoint in `spacepacket.js` today.** Until the extension lands, the thesis layer must be derived from story metadata and linked evidence.
- **Story records already carry AI fields.** `meta_json` can include `ai_narrative`, `ai_takeaways`, `ai_risks`, `source_story_id`, and derived-story counts, so the roadmap should treat these as the bridge into the new capability layer.

## What is missing for effective trading
- **A unified token dossier.** Scout and Harvest need one normalized evidence object that merges:
  - token identity and metadata
  - price and liquidity context
  - story and thesis freshness
  - derived-story relationships
  - wallet flow / counterparty evidence
  - concentration and integrity risk
- **A direct opportunity/risk story layer.** The app should not have to infer bullish setups only from price and generic stories; it should consume explicit opportunity stories and explicit risk stories from E3D.ai.
- **Thesis freshness and decay scoring.** The system needs a repeatable way to answer:
  - is the original story still alive?
  - is the story getting broader or fading?
  - are wallets confirming or contradicting the narrative?
- **Opportunity-cost ranking.** Managers need to know whether a candidate is good in isolation or merely the least-bad option compared with current holdings and better alternatives.
- **Decision explainability.** The current UI shows positions and activity, but not the chain of evidence behind buy/hold/trim/exit decisions.
- **Training labels tied to story outcomes.** The logs should capture which story/thesis signals were present at the time of the decision and whether they worked out.

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

### Phase 2: Upgrade Scout into a thesis-aware opportunity engine
- Keep Scout responsible for **discovering** new names, not trading them.
- Change the Scout prompt so it must:
  - rank candidates by evidence, not raw momentum
  - cite opportunity stories, story-derived support, and thesis lifecycle evidence
  - include counterparty / flow confirmation
  - explain invalidation clearly
  - compare each candidate against current portfolio opportunities
- Add Scout output requirements for managers:
  - `thesis_summary`
  - `evidence`
  - `what_changed`
  - `why_now`
  - `next_best_alternative`
  - `action` and `confidence`
- Make Scout return a smaller set of higher-conviction names, not a larger list of generic momentum tokens.

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
