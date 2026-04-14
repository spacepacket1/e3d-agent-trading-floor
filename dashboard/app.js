import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";

const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtNum = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function cls(...parts) {
  return parts.filter(Boolean).join(" ");
}

function tokenLink(address, symbol, className = "candidate-symbol") {
  const addr = String(address || "").trim();
  const label = String(symbol || addr.slice(0, 8) || "?").toUpperCase();
  if (!addr || addr.length < 10) return React.createElement("span", { className }, label);
  return React.createElement(
    "a",
    { href: `https://e3d.ai/token/${addr}`, target: "_blank", rel: "noopener noreferrer", className: `${className} token-link` },
    label
  );
}

function badgeForRegime(regime) {
  if (regime === "risk_on") return "badge badge-green";
  if (regime === "neutral") return "badge badge-amber";
  if (regime === "risk_off") return "badge badge-red";
  return "badge";
}

function badgeForPipelineStatus(status) {
  if (!status) return "badge";
  if (status.running) return "badge badge-green";
  if (status.last_error) return "badge badge-red";
  return "badge badge-amber";
}

function formatPipelineStatus(status) {
  if (!status) return "Unknown";
  if (status.running) {
    const interval = Number(status.interval_seconds || 0);
    return interval ? `Running every ${interval}s` : "Running";
  }
  if (status.last_error) return `Stopped · ${status.last_error}`;
  return "Stopped";
}

function prettyTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
}

function prettyDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeZoneName: "short"
  });
}

function prettyAgo(value) {
  if (!value) return "—";
  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "—";
  const mins = Math.max(1, Math.round(diffMs / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

function normalizeDecision(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "unknown";
  if (text.includes("approve") || text.includes("paper")) return "approved";
  if (text.includes("reject") || text.includes("block") || text.includes("deny")) return "blocked";
  if (text.includes("close") || text.includes("sell") || text.includes("exit")) return "exit";
  if (text.includes("rotation")) return "rotation";
  return text.replace(/_/g, " ");
}

function summarizeActivity(events) {
  const list = Array.isArray(events) ? events : [];
  const latestByType = new Map();
  for (const event of list) {
    if (!latestByType.has(event.type)) latestByType.set(event.type, event);
  }

  const scoutCandidates = list.filter((event) => event.type === "candidate").length;
  const riskDecisions = list.filter((event) => event.type === "risk_decision");
  const harvestDecisions = list.filter((event) => event.type === "harvest_decision");
  const executorDecisions = list.filter((event) => event.type === "executor_decision");
  const trades = list.filter((event) => event.type === "trade");
  const outcomes = list.filter((event) => event.type === "outcome");
  const sellSignals = trades.filter((event) => {
    const lifecycle = String(event.summary?.trade_lifecycle || event.raw?.payload?.trade_lifecycle || "").toLowerCase();
    const side = String(event.raw?.payload?.side || event.raw?.side || "").toLowerCase();
    return lifecycle.includes("close") || lifecycle.includes("partial_sell") || side === "sell";
  }).length;

  const riskApproved = riskDecisions.filter((event) => normalizeDecision(event.summary?.decision).includes("approved") || String(event.raw?.payload?.handoff_to_executor) === "true").length;
  const riskBlocked = riskDecisions.length - riskApproved;
  const harvestApproved = harvestDecisions.filter((event) => normalizeDecision(event.summary?.decision).includes("exit") || normalizeDecision(event.summary?.decision).includes("trim") || normalizeDecision(event.summary?.decision).includes("reduce") || normalizeDecision(event.summary?.decision).includes("approved")).length;
  const harvestBlocked = harvestDecisions.length - harvestApproved;
  const executorApproved = executorDecisions.filter((event) => normalizeDecision(event.summary?.decision).includes("approved") || normalizeDecision(event.summary?.decision).includes("paper") || normalizeDecision(event.summary?.decision).includes("reduce")) .length;
  const executorBlocked = executorDecisions.length - executorApproved;

  const latestCycle = latestByType.get("cycle_end") || latestByType.get("cycle_start") || list[0] || null;
  const latestRegime = latestByType.get("market_regime") || latestCycle;

  return {
    flow: [
      {
        key: "scout",
        label: "Scout",
        status: scoutCandidates ? "signal found" : "waiting",
        detail: `${scoutCandidates} candidates surfaced`,
        accent: "accent-blue"
      },
      {
        key: "risk",
        label: "Risk",
        status: riskDecisions.length ? `${riskApproved} approved / ${riskBlocked} blocked` : "waiting",
        detail: `${riskDecisions.length} decisions reviewed`,
        accent: "accent-amber"
      },
      {
        key: "harvest",
        label: "Harvest",
        status: harvestDecisions.length ? `${harvestApproved} exits / ${harvestBlocked} held` : "waiting",
        detail: `${harvestDecisions.length} holdings reviewed`,
        accent: "accent-orange"
      },
      {
        key: "executor",
        label: "Executor",
        status: executorDecisions.length ? `${executorApproved} executed / ${executorBlocked} held` : "waiting",
        detail: `${trades.length} trade actions`,
        accent: "accent-green"
      }
    ],
    meters: [
      { label: "Scout", value: scoutCandidates, tone: "tone-blue", sublabel: latestByType.get("candidate") ? `Last signal ${prettyAgo(latestByType.get("candidate").ts)}` : "No signals yet" },
      { label: "Harvest", value: harvestDecisions.length, tone: "tone-orange", sublabel: harvestDecisions.length ? `${harvestApproved} exit-ready` : "No holdings reviews yet" },
      { label: "Risk approvals", value: riskApproved, tone: "tone-amber", sublabel: riskDecisions.length ? `${riskBlocked} blocked` : "No reviews yet" },
      { label: "Executor actions", value: executorApproved, tone: "tone-green", sublabel: executorDecisions.length ? `${executorBlocked} deferred` : "No executions yet" },
      { label: "Trades", value: trades.length, tone: "tone-purple", sublabel: outcomes.length ? `${outcomes.length} closed outcomes` : "No closures yet" },
      { label: "Exits", value: sellSignals, tone: "tone-amber", sublabel: sellSignals ? "Sell / exit pressure" : "No exits yet" },
      { label: "Regime", value: (latestRegime?.market_regime || latestCycle?.market_regime || "unknown").replace(/_/g, " "), tone: "tone-neutral", sublabel: latestRegime ? `Updated ${prettyAgo(latestRegime.ts)}` : "No regime yet" },
      { label: "Cycle freshness", value: prettyAgo(latestCycle?.ts), tone: "tone-neutral", sublabel: latestCycle ? `Last cycle at ${prettyTime(latestCycle.ts)}` : "No cycles yet" }
    ],
    milestones: list.filter((event) => ["candidate", "harvest_decision", "risk_decision", "executor_decision", "trade", "outcome", "market_regime"].includes(event.type)).slice(0, 8).map((event) => {
      const decision = normalizeDecision(event.summary?.decision || event.summary?.outcome_label || event.summary?.trade_lifecycle || event.raw?.payload?.decision);
      const symbol = event.summary?.symbol || event.raw?.payload?.token?.symbol || event.raw?.payload?.symbol || event.raw?.symbol || "";
      const label = {
        candidate: "Candidate surfaced",
        harvest_decision: decision.includes("exit") ? "Harvest exit flagged" : decision.includes("trim") ? "Harvest trim flagged" : "Harvest reviewed",
        risk_decision: decision.includes("approved") ? "Risk approved" : decision.includes("blocked") ? "Risk blocked" : "Risk reviewed",
        executor_decision: decision.includes("approved") || decision.includes("paper") ? "Executor green-lit" : decision.includes("block") ? "Executor blocked" : "Executor reviewed",
        trade: `Trade ${event.summary?.trade_lifecycle || event.raw?.payload?.trade_lifecycle || "recorded"}`,
        outcome: event.summary?.outcome_label === "profit" ? "Winning close" : event.summary?.outcome_label === "loss" ? "Losing close" : "Outcome labeled",
        market_regime: `Regime ${event.market_regime || event.raw?.market_regime || "updated"}`
      }[event.type] || event.type;

      return {
        id: event.id,
        ts: event.ts,
        label,
        symbol,
        decision,
        source: event.source || "pipeline"
      }
    }),
    counts: {
      scoutCandidates,
      harvestDecisions: harvestDecisions.length,
      harvestApproved,
      harvestBlocked,
      riskDecisions: riskDecisions.length,
      riskApproved,
      riskBlocked,
      executorDecisions: executorDecisions.length,
      executorApproved,
      executorBlocked,
      trades: trades.length,
      outcomes: outcomes.length,
      sellSignals
    },
    latest: {
      candidate: latestByType.get("candidate") || null,
      harvest: latestByType.get("harvest_decision") || null,
      risk: latestByType.get("risk_decision") || null,
      executor: latestByType.get("executor_decision") || null,
      trade: latestByType.get("trade") || null,
      outcome: latestByType.get("outcome") || null,
      regime: latestByType.get("market_regime") || null,
      cycle: latestCycle
    },
    sellSignals,
    latestCycle
  };
}

function MetricCard({ label, value, sublabel, tone = "" }) {
  return React.createElement(
    "div",
    { className: cls("card metric-card", tone) },
    React.createElement("div", { className: "metric-label" }, label),
    React.createElement("div", { className: "metric-value" }, value),
    sublabel ? React.createElement("div", { className: "metric-sublabel" }, sublabel) : null
  );
}

function summarizePortfolioIntelligence(events) {
  const list = Array.isArray(events) ? events : [];
  const carriers = list
    .filter((event) => ["cycle_end", "cycle_start", "harvest_decision", "candidate"].includes(event?.type) && event?.raw?.payload?.portfolio_intelligence)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .map((event) => ({
      ts: event.ts,
      type: event.type,
      snapshot: event.raw.payload.portfolio_intelligence
    }));

  const currentCarrier = carriers[0] || null;
  const previousCarrier = carriers[1] || null;
  const current = currentCarrier?.snapshot || null;
  const previous = previousCarrier?.snapshot || null;

  const holdings = Array.isArray(current?.holdings)
    ? current.holdings.map((item) => ({
        prompt: item?.prompt || item || {},
        token: item?.prompt?.token || item?.token || {},
        thesis: item?.prompt?.thesis || item?.thesis || {},
        recommendation: item?.prompt?.recommendation || item?.recommendation || {},
        flow: item?.prompt?.flow || item?.flow || {},
        market_data: item?.prompt?.market_data || item?.market_data || {},
        story_snapshot: item?.prompt?.story_snapshot || item?.story_snapshot || {},
        summary: item?.prompt?.summary || item?.summary || null
      }))
    : [];

  const byOpportunity = [...holdings].sort((a, b) => Number(b?.thesis?.opportunity_score || 0) - Number(a?.thesis?.opportunity_score || 0));
  const byDecay = [...holdings].sort((a, b) => Number(b?.thesis?.decay || 0) - Number(a?.thesis?.decay || 0));
  const topOpportunities = byOpportunity.slice(0, 3);
  const weakPositions = byDecay.slice(0, 3);

  return {
    current,
    previous,
    currentCarrier,
    previousCarrier,
    holdings,
    topOpportunities,
    weakPositions,
    changeNote: buildIntelligenceChangeNote(current, previous, topOpportunities, weakPositions)
  };
}

function buildIntelligenceChangeNote(current, previous, topOpportunities, weakPositions) {
  if (!current) return "No intelligence snapshot yet.";
  if (!previous) {
    return `Fresh intelligence snapshot generated at ${prettyDateTime(current.generated_at || null)}.`;
  }

  const currentSnapshot = current.thesis_snapshot || {};
  const previousSnapshot = previous.thesis_snapshot || {};
  const strengthDelta = Number(currentSnapshot.average_thesis_strength || 0) - Number(previousSnapshot.average_thesis_strength || 0);
  const freshnessDelta = Number(currentSnapshot.average_thesis_freshness || 0) - Number(previousSnapshot.average_thesis_freshness || 0);
  const decayDelta = Number(currentSnapshot.average_narrative_decay || 0) - Number(previousSnapshot.average_narrative_decay || 0);
  const topSymbol = topOpportunities[0]?.token?.symbol || "—";
  const weakSymbol = weakPositions[0]?.token?.symbol || "—";
  const sign = (value) => `${value >= 0 ? "+" : ""}${fmtNum.format(value)}`;

  return `Since the last cycle: thesis strength ${sign(strengthDelta)}, freshness ${sign(freshnessDelta)}, narrative decay ${sign(decayDelta)}. Best new focus: ${topSymbol}. Weakest current watch: ${weakSymbol}.`;
}

function IntelligenceTokenCard({ item, rank, variant = "positive" }) {
  const prompt = item?.prompt || {};
  const token = prompt.token || item?.token || {};
  const thesis = prompt.thesis || item?.thesis || {};
  const recommendation = prompt.recommendation || item?.recommendation || {};
  const flow = prompt.flow || item?.flow || {};
  const marketData = prompt.market_data || item?.market_data || {};
  const storySnapshot = prompt.story_snapshot || item?.story_snapshot || {};
  const topStories = Array.isArray(storySnapshot.top_stories) ? storySnapshot.top_stories : [];
  const storyRows = variant === "risk"
    ? topStories.filter((story) => /risk|warning|exit|decay|distribution/i.test(`${story?.story_type || ""} ${story?.title || ""} ${story?.subtitle || ""}`)).slice(0, 2)
    : topStories.slice(0, 2);

  return React.createElement(
    "div",
    { className: cls("intelligence-card", `intelligence-card-${variant}`) },
    React.createElement(
      "div",
      { className: "intelligence-card-head" },
      React.createElement(
        "div",
        null,
        React.createElement("div", { className: "intelligence-card-rank" }, `#${rank}`),
        React.createElement("div", { className: "intelligence-card-title" }, tokenLink(token.contract_address, token.symbol || token.name || "—"), React.createElement("span", null, ` · ${token.name || "Unnamed"}`)),
        React.createElement("div", { className: "intelligence-card-meta" }, `${token.category || "unknown"} · ${recommendation.action || "watch"}`)
      ),
      React.createElement("div", { className: cls("intelligence-action-pill", variant === "risk" ? "is-risk" : "is-positive") }, recommendation.action || "watch")
    ),
    React.createElement(
      "div",
      { className: "intelligence-card-stats" },
      React.createElement("div", { className: "intelligence-stat" }, React.createElement("span", null, "Thesis"), React.createElement("strong", null, fmtNum.format(Number(thesis.strength || 0)))),
      React.createElement("div", { className: "intelligence-stat" }, React.createElement("span", null, "Freshness"), React.createElement("strong", null, fmtNum.format(Number(thesis.freshness || 0)))),
      React.createElement("div", { className: "intelligence-stat" }, React.createElement("span", null, "Decay"), React.createElement("strong", null, fmtNum.format(Number(thesis.decay || 0)))),
      React.createElement("div", { className: "intelligence-stat" }, React.createElement("span", null, "Flow"), React.createElement("strong", null, fmtNum.format(Number(thesis.flow_alignment || 0))))
    ),
    React.createElement(
      "div",
      { className: "intelligence-card-body" },
      React.createElement("div", { className: "intelligence-card-line" }, React.createElement("span", null, "Why now"), React.createElement("strong", null, recommendation.why_now || prompt.why_now || "—")),
      React.createElement("div", { className: "intelligence-card-line" }, React.createElement("span", null, "Invalidation"), React.createElement("strong", null, recommendation.invalidation || prompt.invalidation || "—")),
      React.createElement("div", { className: "intelligence-card-line" }, React.createElement("span", null, "Cohort"), React.createElement("strong", null, flow.wallet_cohort?.cohort_label || flow.wallet_cohort?.label || prompt.flow?.wallet_cohort_label || "—")),
      React.createElement("div", { className: "intelligence-card-line" }, React.createElement("span", null, "Flow"), React.createElement("strong", null, flow.flow_summary?.direction || prompt.flow?.flow_direction || "neutral"))
    ),
    React.createElement(
      "div",
      { className: "intelligence-card-section" },
      React.createElement("div", { className: "intelligence-card-section-title" }, variant === "risk" ? "Top risk stories" : "Top opportunity stories"),
      storyRows.length
        ? React.createElement(
            "div",
            { className: "intelligence-story-list" },
            storyRows.map((story, index) => React.createElement(
              "div",
              { className: "intelligence-story-item", key: story?.id || `${token.contract_address || token.symbol}-${index}` },
              React.createElement("div", { className: "intelligence-story-title" }, story?.title || story?.story_type || "Story"),
              React.createElement("div", { className: "intelligence-story-copy" }, story?.subtitle || story?.evidence || ""),
              story?.source_story_id ? React.createElement("div", { className: "intelligence-story-meta" }, `Source ${story.source_story_id}`) : null
            ))
          )
        : React.createElement("div", { className: "intelligence-empty" }, "No supporting stories surfaced yet.")
    ),
    React.createElement(
      "div",
      { className: "intelligence-card-footer" },
      React.createElement("div", { className: "intelligence-footer-item" }, React.createElement("span", null, "Market"), React.createElement("strong", null, `${fmtUsd.format(Number(marketData.current_price || 0))} · ${fmtNum.format(Number(marketData.change_24h_pct || 0))}%`)),
      React.createElement("div", { className: "intelligence-footer-item" }, React.createElement("span", null, "Confidence"), React.createElement("strong", null, fmtNum.format(Number(recommendation.confidence || thesis.opportunity_score || 0)))),
      React.createElement("div", { className: "intelligence-footer-item" }, React.createElement("span", null, "Action"), React.createElement("strong", null, recommendation.action || "watch"))
    )
  );
}

function IntelligencePanel({ intelligence, floorState }) {
  const current = intelligence?.current || null;
  const holdings = Array.isArray(intelligence?.holdings) ? intelligence.holdings : [];
  const topOpportunities = Array.isArray(intelligence?.topOpportunities) ? intelligence.topOpportunities : [];
  const weakPositions = Array.isArray(intelligence?.weakPositions) ? intelligence.weakPositions : [];

  if (!current) {
    return React.createElement(
      "div",
      { className: "card panel intelligence-panel" },
      React.createElement(
        "div",
        { className: "panel-head" },
        React.createElement("h2", null, "Intelligence"),
        React.createElement("span", { className: "panel-note" }, "Waiting for the first dossier snapshot")
      ),
      React.createElement("div", { className: "empty-state" }, "Run the E3D Trading Agents to populate opportunity stories, thesis state, and wallet cohorts.")
    );
  }

  const summary = current.portfolio || current.prompt_snapshot?.portfolio || {};
  const thesisSnapshot = current.thesis_snapshot || current.prompt_snapshot?.thesis_snapshot || {};
  const currentGeneratedAt = current.generated_at || current.prompt_snapshot?.generated_at || null;

  return React.createElement(
    "section",
    { className: "card panel intelligence-panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "Manager Intelligence"),
      React.createElement("span", { className: "panel-note" }, currentGeneratedAt ? `Refreshed ${prettyAgo(currentGeneratedAt)}` : "Live dossier snapshot")
    ),
    React.createElement(
      "div",
      { className: "intelligence-summary" },
      React.createElement("div", { className: "intelligence-summary-copy" }, current.changeNote || ""),
      React.createElement(
        "div",
        { className: "intelligence-summary-notes" },
        React.createElement("div", { className: "intelligence-summary-note" }, React.createElement("span", null, "Why in the book"), React.createElement("strong", null, topOpportunities[0]?.token?.symbol || "—")),
        React.createElement("div", { className: "intelligence-summary-note" }, React.createElement("span", null, "Why should stay"), React.createElement("strong", null, topOpportunities[0]?.recommendation?.why_now || topOpportunities[0]?.prompt?.recommendation?.why_now || "—")),
        React.createElement("div", { className: "intelligence-summary-note" }, React.createElement("span", null, "Why should come out"), React.createElement("strong", null, weakPositions[0]?.recommendation?.invalidation || weakPositions[0]?.prompt?.recommendation?.invalidation || "—"))
      )
    ),
    React.createElement(
      "div",
      { className: "intelligence-metrics" },
      React.createElement(MetricCard, { label: "Avg thesis strength", value: fmtNum.format(Number(thesisSnapshot.average_thesis_strength || 0)), sublabel: "Book-wide conviction" }),
      React.createElement(MetricCard, { label: "Avg freshness", value: fmtNum.format(Number(thesisSnapshot.average_thesis_freshness || 0)), sublabel: "How alive the story is" }),
      React.createElement(MetricCard, { label: "Avg decay", value: fmtNum.format(Number(thesisSnapshot.average_narrative_decay || 0)), sublabel: "Narrative deterioration" }),
      React.createElement(MetricCard, { label: "Avg opportunity", value: fmtNum.format(Number(thesisSnapshot.average_opportunity_score || 0)), sublabel: "Decision attractiveness" }),
      React.createElement(MetricCard, { label: "Tracked holdings", value: String(holdings.length), sublabel: "Dossier-covered positions" }),
      React.createElement(MetricCard, { label: "Cash / equity", value: `${fmtUsd.format(Number(summary.cash_usd || 0))} / ${fmtUsd.format(Number(summary.equity_usd || 0))}`, sublabel: String(current.market_regime || "unknown").replace(/_/g, " ") })
    ),
    React.createElement(
      "div",
      { className: "intelligence-columns" },
      React.createElement(
        "div",
        { className: "intelligence-column" },
        React.createElement("div", { className: "intelligence-column-head" }, "Best opportunities"),
        topOpportunities.length
          ? React.createElement("div", { className: "intelligence-card-list" }, topOpportunities.map((item, index) => React.createElement(IntelligenceTokenCard, { key: item?.token?.contract_address || item?.token?.symbol || index, item, rank: index + 1, variant: "positive" })))
          : React.createElement("div", { className: "intelligence-empty" }, "No high-conviction opportunity surfaced yet.")
      ),
      React.createElement(
        "div",
        { className: "intelligence-column" },
        React.createElement("div", { className: "intelligence-column-head" }, "Weakest current positions"),
        weakPositions.length
          ? React.createElement("div", { className: "intelligence-card-list" }, weakPositions.map((item, index) => React.createElement(IntelligenceTokenCard, { key: item?.token?.contract_address || item?.token?.symbol || index, item, rank: index + 1, variant: "risk" })))
          : React.createElement("div", { className: "intelligence-empty" }, "No weak positions flagged yet.")
      )
    ),
    React.createElement(
      "div",
      { className: "intelligence-footnotes" },
      React.createElement(
        "div",
        { className: "intelligence-footnote" },
        React.createElement("span", null, "Desk note"),
        React.createElement("strong", null, floorState?.latestCycle ? `Why now: ${prettyAgo(floorState.latestCycle.ts)}.` : "Why now: waiting for the next cycle.")
      ),
      React.createElement(
        "div",
        { className: "intelligence-footnote" },
        React.createElement("span", null, "Evidence bundle"),
        React.createElement("strong", null, topOpportunities[0]?.prompt?.story_snapshot?.top_stories?.[0]?.subtitle || topOpportunities[0]?.prompt?.story_snapshot?.top_stories?.[0]?.title || "Top dossier evidence not yet surfaced")
      ),
      React.createElement(
        "div",
        { className: "intelligence-footnote" },
        React.createElement("span", null, "Wallet cohort"),
        React.createElement("strong", null, topOpportunities[0]?.flow?.wallet_cohort?.cohort_label || topOpportunities[0]?.flow?.wallet_cohort?.label || current?.holdings?.[0]?.prompt?.flow?.wallet_cohort_label || "unknown")
      )
    )
  );
}

function LaneConnector({ active = false, reverse = false }) {
  return React.createElement(
    "div",
    { className: cls("lane-connector", active && "is-active", reverse && "is-reverse") },
    React.createElement("span", { className: "lane-dot lane-dot-1" }),
    React.createElement("span", { className: "lane-dot lane-dot-2" }),
    React.createElement("span", { className: "lane-dot lane-dot-3" })
  );
}

function LaneNode({ lane, className }) {
  return React.createElement(
    "div",
    { className: cls("lane-node", lane.tone, lane.active && "is-busy", className) },
    React.createElement(
      "div",
      { className: "lane-icon-wrap" },
      React.createElement("div", { className: "lane-icon" }, lane.icon),
      lane.active ? React.createElement("span", { className: "lane-pulse" }) : null
    ),
    React.createElement(
      "div",
      { className: "lane-copy" },
      React.createElement(
        "div",
        { className: "lane-top" },
        React.createElement("span", { className: "lane-label" }, lane.label),
        React.createElement("span", { className: "lane-badge" }, lane.badge)
      ),
      React.createElement("div", { className: "lane-meta" }, lane.meta),
      lane.submeta ? React.createElement("div", { className: "lane-submeta" }, lane.submeta) : null
    )
  );
}

const BUY_SIGNAL_TYPES = new Set(["MOVER", "SURGE", "ACCUMULATION", "SMART_MONEY", "STEALTH_ACCUMULATION", "BREAKOUT_CONFIRMED"]);
const ALL_SIGNAL_LABELS = {
  MOVER: "Mover", SURGE: "Surge", ACCUMULATION: "Accumulation", SMART_MONEY: "Smart Money",
  STEALTH_ACCUMULATION: "Stealth Accum.", BREAKOUT_CONFIRMED: "Breakout",
  WASH_TRADE: "Wash Trade", LOOP: "Loop", LIQUIDITY_DRAIN: "Liq. Drain",
  SPREAD_WIDENING: "Spread", MOMENTUM_DIVERGENCE: "Mom. Div.", EXCHANGE_FLOW: "Exch. Flow",
  RUG_LIQUIDITY_PULL: "Rug Pull", CONCENTRATION_SHIFT: "Conc. Shift", WHALE: "Whale",
  VOLUME_PROFILE_ANOMALY: "Vol. Anomaly", MIRROR: "Mirror", FUNNEL: "Funnel",
  HOTLINKS: "Hotlinks", INSIDER_TIMING: "Insider", TOKEN_QUALITY_SCORE: "Quality",
  SANDWICH: "Sandwich", CATEGORY: "Category", ECOSYSTEM_SHIFT: "Ecosystem"
};

function SignalPill({ type, found }) {
  const label = ALL_SIGNAL_LABELS[type] || type;
  const isBuy = BUY_SIGNAL_TYPES.has(type);
  const cls2 = found > 0
    ? (isBuy ? "signal-pill signal-pill-buy" : "signal-pill signal-pill-danger")
    : "signal-pill signal-pill-inactive";
  return React.createElement("span", { className: cls2 }, found > 0 ? `${label} ×${found}` : label);
}

function CycleCard({ cycle }) {
  const scout = cycle.scout || {};
  const harvest = cycle.harvest || {};
  const approved = Array.isArray(cycle.risk_approved) ? cycle.risk_approved : [];
  const rejected = Array.isArray(cycle.risk_rejected) ? cycle.risk_rejected : [];
  const regime = cycle.market_regime || {};
  const stats = cycle.stats || {};

  const storiesChecked = Array.isArray(scout.stories_checked) ? scout.stories_checked : [];
  const buySignals = storiesChecked.filter((s) => BUY_SIGNAL_TYPES.has(s.type));
  const disqualifiers = storiesChecked.filter((s) => !BUY_SIGNAL_TYPES.has(s.type) && s.found > 0);
  const foundBuyCount = buySignals.reduce((n, s) => n + (s.found || 0), 0);

  const candidates = Array.isArray(scout.candidates) ? scout.candidates : [];
  const exitCandidates = Array.isArray(harvest.exit_candidates) ? harvest.exit_candidates : [];

  // Build a lookup of which candidates got approved/rejected
  const approvedAddresses = new Set(approved.map((c) => String(c?.token?.contract_address || c?.contract_address || "").toLowerCase()).filter(Boolean));
  const rejectedAddresses = new Set(rejected.map((c) => String(c?.token?.contract_address || c?.contract_address || "").toLowerCase()).filter(Boolean));

  const regimeBadge = regime.regime === "risk_on" ? "badge badge-green" : regime.regime === "risk_off" ? "badge badge-red" : "badge badge-amber";
  const summary = candidates.length
    ? `${candidates.length} token${candidates.length !== 1 ? "s" : ""} considered · ${approved.length} approved · ${rejected.length} rejected`
    : storiesChecked.length
    ? `${storiesChecked.length} story types scanned · ${foundBuyCount} buy signal${foundBuyCount !== 1 ? "s" : ""} found`
    : "Scanning…";

  return React.createElement(
    "section",
    { className: "card cycle-card" },
    // Header
    React.createElement(
      "div",
      { className: "cycle-header" },
      React.createElement(
        "div",
        null,
        React.createElement("div", { className: "cycle-title" }, prettyDateTime(cycle.ts)),
        React.createElement("div", { className: "cycle-summary" }, summary)
      ),
      React.createElement(
        "div",
        { className: "cycle-header-right" },
        regime.regime ? React.createElement("span", { className: regimeBadge }, regime.regime.replace(/_/g, " ")) : null,
        stats.equity_usd ? React.createElement("span", { className: "cycle-equity" }, fmtUsd.format(stats.equity_usd)) : null
      )
    ),
    // Story signals
    storiesChecked.length > 0 ? React.createElement(
      "div",
      { className: "cycle-section" },
      React.createElement("div", { className: "cycle-section-title" }, "Story signals"),
      React.createElement(
        "div",
        { className: "cycle-signals" },
        // Buy signals row
        React.createElement(
          "div",
          { className: "cycle-signals-group" },
          React.createElement("span", { className: "cycle-signals-label" }, "Buy"),
          React.createElement(
            "div",
            { className: "signal-pills" },
            buySignals.map((s) => React.createElement(SignalPill, { key: s.type, type: s.type, found: s.found }))
          )
        ),
        // Disqualifiers row (only if any fired)
        disqualifiers.length > 0 ? React.createElement(
          "div",
          { className: "cycle-signals-group" },
          React.createElement("span", { className: "cycle-signals-label" }, "Risk"),
          React.createElement(
            "div",
            { className: "signal-pills" },
            disqualifiers.map((s) => React.createElement(SignalPill, { key: s.type, type: s.type, found: s.found }))
          )
        ) : null
      )
    ) : null,
    // Candidates
    candidates.length > 0 ? React.createElement(
      "div",
      { className: "cycle-section" },
      React.createElement("div", { className: "cycle-section-title" }, "Tokens considered"),
      candidates.map((c) => {
        const addr = String(c?.token?.contract_address || c?.contract_address || "").toLowerCase();
        const isApproved = approvedAddresses.has(addr);
        const isRejected = rejectedAddresses.has(addr);
        const symbol = c?.token?.symbol || c?.symbol || "?";
        const name = c?.token?.name || c?.name || "";
        const whyNow = c?.why_now || "";
        // evidence may be strings or objects {signal, value, quality} — normalise to strings
        const evidence = (Array.isArray(c?.evidence) ? c.evidence : [])
          .map((ev) => typeof ev === "string" ? ev : (ev?.signal ? `${ev.signal}${ev.value != null ? ` (${Number(ev.value).toFixed(1)})` : ""}` : JSON.stringify(ev)));
        const risks = Array.isArray(c?.risks) ? c.risks.slice(0, 2).map((r) => typeof r === "string" ? r : JSON.stringify(r)) : [];
        const confidence = Number(c?.confidence || 0);
        const conviction = Number(c?.conviction_score || 0);

        // risk_rejected items are {proposal, risk} wrappers; approved items are plain candidates
        const riskEntry = [...approved, ...rejected].find((r) => {
          const candidate = r?.proposal || r;
          const ra = String(candidate?.token?.contract_address || candidate?.contract_address || "").toLowerCase();
          return ra === addr;
        });
        const riskObj = riskEntry?.risk || riskEntry;
        const riskReason = riskObj?.reason_summary || riskObj?.risk_summary || riskObj?.summary || null;

        return React.createElement(
          "div",
          { className: "candidate-row", key: addr || symbol },
          React.createElement(
            "div",
            { className: "candidate-head" },
            React.createElement(
              "div",
              { className: "candidate-identity" },
              tokenLink(addr, symbol),
              name ? React.createElement("span", { className: "candidate-name" }, name) : null
            ),
            React.createElement(
              "div",
              { className: "candidate-verdict" },
              isApproved ? React.createElement("span", { className: "verdict-approved" }, "✓ Approved") :
              isRejected ? React.createElement("span", { className: "verdict-rejected" }, "✗ Rejected") :
              React.createElement("span", { className: "verdict-pending" }, "Pending")
            )
          ),
          whyNow ? React.createElement("div", { className: "candidate-why" }, whyNow) : null,
          evidence.length > 0 ? React.createElement(
            "div",
            { className: "candidate-evidence" },
            evidence.slice(0, 4).map((ev, i) => React.createElement("span", { className: "candidate-evidence-tag", key: i }, ev))
          ) : null,
          risks.length > 0 ? React.createElement(
            "div",
            { className: "candidate-risks" },
            risks.map((r, i) => React.createElement("span", { className: "candidate-risk-tag", key: i }, r))
          ) : null,
          React.createElement(
            "div",
            { className: "candidate-scores" },
            React.createElement("span", null, `Conf ${confidence}`),
            React.createElement("span", null, `Conviction ${conviction}`),
            riskReason ? React.createElement("span", { className: isRejected ? "verdict-rejected" : "verdict-approved" }, riskReason) : null
          )
        );
      })
    ) : null,
    // Harvest exits
    exitCandidates.length > 0 ? React.createElement(
      "div",
      { className: "cycle-section" },
      React.createElement("div", { className: "cycle-section-title" }, "Harvest actions"),
      exitCandidates.map((c, i) => {
        const symbol = c?.token?.symbol || c?.symbol || "?";
        const exitAddr = String(c?.token?.contract_address || c?.contract_address || "").toLowerCase();
        const action = c?.action || "exit";
        const whyNow = c?.why_now || c?.summary || "";
        return React.createElement(
          "div",
          { className: "harvest-row", key: i },
          React.createElement(
            "div",
            { className: "harvest-head" },
            tokenLink(exitAddr, symbol),
            React.createElement("span", { className: "harvest-action" }, action.toUpperCase())
          ),
          whyNow ? React.createElement("div", { className: "candidate-why" }, whyNow) : null
        );
      })
    ) : null,
    // Empty state when no candidates and no signals found
    candidates.length === 0 && foundBuyCount === 0 && storiesChecked.length > 0 ? React.createElement(
      "div",
      { className: "cycle-empty" },
      "No buy signals in this cycle — all story types returned empty."
    ) : null
  );
}

function AgentActivityPage() {
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [wsStatus, setWsStatus] = useState("connecting"); // "connecting" | "live" | "reconnecting"
  const [reconnectKey, setReconnectKey] = useState(0);

  useEffect(() => {
    setWsStatus("connecting");
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);

    ws.onopen = () => setWsStatus("live");

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "cycles") {
          setCycles(Array.isArray(data.cycles) ? data.cycles : []);
          setLoading(false);
        }
      } catch {}
    };

    ws.onerror = () => setWsStatus("reconnecting");

    ws.onclose = () => {
      setWsStatus("reconnecting");
      setTimeout(() => setReconnectKey((k) => k + 1), 3000);
    };

    return () => ws.close();
  }, [reconnectKey]);

  const statusDot = wsStatus === "live"
    ? React.createElement("span", { className: "ws-dot ws-dot-live" })
    : React.createElement("span", { className: "ws-dot ws-dot-dim" });

  const statusLabel = wsStatus === "live" ? "Live" : wsStatus === "reconnecting" ? "Reconnecting…" : "Connecting…";

  const header = React.createElement(
    "div",
    { className: "cycle-ws-status" },
    statusDot,
    React.createElement("span", null, statusLabel)
  );

  if (loading) return React.createElement(
    React.Fragment,
    null,
    header,
    React.createElement("div", { className: "card loading" }, "Waiting for the first E3D Trading Agents cycle…")
  );

  if (!cycles.length) return React.createElement(
    React.Fragment,
    null,
    header,
    React.createElement("div", { className: "card" }, React.createElement("div", { className: "cycle-empty" }, "No cycle data yet. Start the E3D Trading Agents to see agent activity."))
  );

  return React.createElement(
    React.Fragment,
    null,
    header,
    cycles.map((cycle, i) => React.createElement(CycleCard, { key: cycle.ts + i, cycle }))
  );
}

// ── Network Debug Feed ────────────────────────────────────────────────────────
// Renders pipeline log entries as single-line expandable rows like a browser
// network / debugger tab. Shows API calls (url + status + timing) and LLM calls.

function fmtBytes(n) {
  if (!n || n < 0) return "";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}
function fmtMs(n) {
  if (!n || n < 0) return "";
  if (n >= 60000) return (n / 60000).toFixed(1) + " min";
  if (n >= 1000) return (n / 1000).toFixed(1) + "s";
  return n + "ms";
}
function shortTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return String(ts).slice(11, 19);
  return d.toTimeString().slice(0, 8);
}
function shortPath(url) {
  try {
    const u = new URL(url);
    let p = u.pathname;
    if (u.search) p += u.search.slice(0, 60) + (u.search.length > 60 ? "…" : "");
    return p;
  } catch { return String(url || "").slice(0, 80); }
}

function NetRow({ entry, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const { stage, ts, data } = entry;

  // ── Classify entry type ──────────────────────────────────────────────────
  let rowClass = "net-row";
  let badge = "";
  let badgeClass = "net-badge";
  let label = "";
  let meta = "";
  let statusEl = null;

  if (stage === "e3d_api_response") {
    badge = "API";
    badgeClass += " net-badge-api";
    label = shortPath(data.url || "");
    const ok = data.status >= 200 && data.status < 300;
    statusEl = React.createElement("span", { className: ok ? "net-status-ok" : "net-status-err" }, data.status);
    meta = [fmtMs(data.duration_ms), fmtBytes(data.bytes)].filter(Boolean).join("  ");
  } else if (stage === "e3d_api_error") {
    badge = "API";
    badgeClass += " net-badge-api net-badge-err";
    label = shortPath(data.url || "");
    statusEl = React.createElement("span", { className: "net-status-err" }, "ERR");
    meta = data.message ? data.message.slice(0, 60) : "";
  } else if (stage === "e3d_api_budget_exceeded") {
    badge = "API";
    badgeClass += " net-badge-warn";
    label = "rate limit / budget exceeded";
    statusEl = React.createElement("span", { className: "net-status-warn" }, "429");
  } else if (stage === "llm_request") {
    badge = "LLM ▶";
    badgeClass += " net-badge-llm";
    label = (data.agent || "").toUpperCase();
    meta = `${(data.prompt_chars / 1000).toFixed(1)}K chars`;
  } else if (stage === "llm_response") {
    badge = "LLM ✓";
    badgeClass += " net-badge-llm net-badge-llm-ok";
    label = (data.agent || "").toUpperCase();
    statusEl = React.createElement("span", { className: "net-status-ok" }, "200");
    const toks = data.total_tokens ? `${data.total_tokens} tok` : `${(data.output_chars / 1000).toFixed(1)}K chars`;
    meta = [fmtMs(data.duration_ms), toks, data.finish_reason === "length" ? "⚠ TRUNCATED" : ""].filter(Boolean).join("  ");
  } else if (stage === "llm_error") {
    badge = "LLM ✗";
    badgeClass += " net-badge-llm net-badge-err";
    label = (data.agent || "").toUpperCase();
    statusEl = React.createElement("span", { className: "net-status-err" }, "ERR");
    meta = fmtMs(data.duration_ms);
  } else if (stage === "scout") {
    badge = "SCOUT";
    badgeClass += " net-badge-agent";
    const cands = Array.isArray(data.candidates) ? data.candidates : [];
    label = cands.length
      ? `${cands.length} candidate${cands.length !== 1 ? "s" : ""}: ${cands.map(c => c?.token?.symbol || "?").join(", ")}`
      : "0 candidates";
    statusEl = React.createElement("span", { className: cands.length ? "net-status-ok" : "net-status-warn" }, cands.length ? "✓" : "–");
  } else if (stage === "harvest") {
    badge = "HARVEST";
    badgeClass += " net-badge-agent";
    const ps = data.portfolio_summary || {};
    const exits = (data.exit_candidates || []).map(x => x?.token?.symbol || "?").filter(Boolean);
    label = `hold=${ps.hold_count || 0} monitor=${ps.monitor_count || 0} trim=${ps.trim_count || 0} exit=${ps.exit_count || 0}` +
      (exits.length ? `  →exit: ${exits.join(", ")}` : "");
    statusEl = React.createElement("span", { className: "net-status-ok" }, "✓");
  } else if (stage === "executor_buy" || stage === "buy_trades") {
    badge = "BUY";
    badgeClass += " net-badge-buy";
    const items = Array.isArray(data) ? data : [data];
    label = items.map(i => `${i.symbol || i.token?.symbol || "?"} $${(i.allocation_usd || i.amount_usd || 0).toFixed(0)}`).join(", ");
    statusEl = React.createElement("span", { className: "net-status-ok" }, "✓");
  } else if (stage === "executor_exit" || stage === "sell_trades") {
    badge = "EXIT";
    badgeClass += " net-badge-exit";
    const items = Array.isArray(data) ? data : [data];
    label = items.map(i => `${i.symbol || "?"} ${i.decision || i.reason || ""}`).join(", ");
    statusEl = React.createElement("span", { className: "net-status-warn" }, "↩");
  } else if (stage === "quant_context") {
    badge = "QUANT";
    badgeClass += " net-badge-quant";
    label = `regime=${data.macro_regime || "?"}  BTC ${data.btc_24h >= 0 ? "+" : ""}${data.btc_24h ?? "?"}%  FG=${data.fear_greed ?? "?"}  flow=${data.token_flow_count ?? 0} tokens`;
  } else if (stage === "scout_flow_enrichment") {
    badge = "FLOW";
    badgeClass += " net-badge-quant";
    label = `DexScreener enrichment — ${data.flow_tokens_total ?? 0} tokens with flow data`;
  } else if (stage === "scout_candidate_dropped") {
    badge = "DROP";
    badgeClass += " net-badge-err";
    label = `${data.reason || "?"} — ${data.addr || ""}`;
    statusEl = React.createElement("span", { className: "net-status-err" }, "✗");
  } else {
    badge = stage.toUpperCase().slice(0, 8);
    label = JSON.stringify(data).slice(0, 80);
  }

  const expandedContent = open
    ? React.createElement("pre", { className: "net-expanded" }, JSON.stringify(data, null, 2))
    : null;

  return React.createElement(
    "div",
    { className: rowClass },
    React.createElement(
      "div",
      { className: "net-row-line", onClick: () => setOpen(o => !o) },
      React.createElement("span", { className: "net-chevron" }, open ? "▼" : "▶"),
      React.createElement("span", { className: badgeClass }, badge),
      React.createElement("span", { className: "net-label" }, label),
      React.createElement("span", { className: "net-spacer" }),
      statusEl,
      meta ? React.createElement("span", { className: "net-meta" }, meta) : null,
      React.createElement("span", { className: "net-time" }, shortTs(ts))
    ),
    expandedContent
  );
}

function NetworkDebugFeed() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all"); // "all" | "api" | "llm" | "agent"

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/pipeline-log");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { entries: raw } = await res.json();
        if (!cancelled) setEntries([...raw].reverse()); // newest first
      } catch {}
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    const id = setInterval(load, 15000); // refresh every 15s
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const API_STAGES = new Set(["e3d_api_response", "e3d_api_error", "e3d_api_budget_exceeded"]);
  const LLM_STAGES = new Set(["llm_request", "llm_response", "llm_error"]);
  const AGENT_STAGES = new Set(["scout", "harvest", "executor_buy", "executor_exit", "sell_trades", "buy_trades", "scout_candidate_dropped"]);

  const visible = entries.filter(e => {
    if (filter === "api") return API_STAGES.has(e.stage);
    if (filter === "llm") return LLM_STAGES.has(e.stage);
    if (filter === "agent") return AGENT_STAGES.has(e.stage);
    return true;
  });

  const filterBar = React.createElement(
    "div",
    { className: "net-filter-bar" },
    ["all", "api", "llm", "agent"].map(f =>
      React.createElement("button", {
        key: f,
        className: "net-filter-btn" + (filter === f ? " net-filter-active" : ""),
        onClick: () => setFilter(f)
      }, f.toUpperCase())
    )
  );

  return React.createElement(
    "div",
    { className: "card panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "Agent Network Activity"),
      React.createElement("span", { className: "panel-note" }, loading ? "Loading…" : `${visible.length} entries`)
    ),
    filterBar,
    loading
      ? React.createElement("div", { className: "net-empty" }, "Loading pipeline log…")
      : visible.length === 0
        ? React.createElement("div", { className: "net-empty" }, "No entries yet — start the pipeline.")
        : React.createElement(
            "div",
            { className: "net-list" },
            visible.slice(0, 200).map((e, i) =>
              React.createElement(NetRow, { key: `${e.ts}-${e.stage}-${i}`, entry: e })
            )
          )
  );
}

function getPageFromHash() {
  if (typeof window === "undefined") return "portfolio";
  const hash = String(window.location.hash || "").replace(/^#/, "").toLowerCase();
  if (hash === "opportunities" || hash === "opportunity") return "opportunities";
  if (hash === "history") return "history";
  if (hash === "settings" || hash === "auth") return "settings";
  if (hash === "orbit") return "orbit";
  if (hash === "activity") return "activity";
  return "portfolio";
}

function resolveTokenName(position) {
  return String(position?.name || position?.token?.name || "Full name unavailable");
}

function resolveTokenIcon(position) {
  return position?.icon_url || position?.image_url || position?.token?.icon_url || position?.token?.image_url || null;
}

function resolveTokenGlyph(position) {
  const symbol = String(position?.symbol || position?.name || "?").trim();
  if (!symbol) return "?";
  const compact = symbol.replace(/[^a-z0-9]/gi, "");
  if (!compact) return symbol.slice(0, 1).toUpperCase();
  return compact.slice(0, 2).toUpperCase();
}

function resolveDelta(position) {
  const quantity = Number(position?.quantity || 0);
  const purchasedPrice = Number(position?.avg_entry_price || 0);
  const storedCurrentPrice = Number(position?.current_price || 0);
  const storedCurrentValueUsd = Number(
    position?.current_value_usd != null
      ? position.current_value_usd
      : position?.market_value_usd != null
        ? position.market_value_usd
        : 0
  );
  const fallbackPrice = quantity > 0
    ? (storedCurrentValueUsd > 0 ? storedCurrentValueUsd / quantity : purchasedPrice)
    : purchasedPrice;
  const currentPrice = storedCurrentPrice > 0 ? storedCurrentPrice : fallbackPrice;
  const avgEntryUsd = purchasedPrice * quantity;
  const currentPriceUsd = currentPrice * quantity;
  const costUsd = Number(position?.cost_usd != null ? position.cost_usd : avgEntryUsd) || 0;
  const currentValueUsd = Number(
    position?.current_value_usd != null
      ? position.current_value_usd
      : position?.market_value_usd != null
        ? position.market_value_usd
        : currentPriceUsd
  ) || (currentPriceUsd > 0 ? currentPriceUsd : costUsd);
  const deltaUsd = currentValueUsd - costUsd;
  const deltaPct = costUsd > 0 ? (deltaUsd / costUsd) * 100 : 0;
  return { quantity, purchasedPrice, currentPrice, costUsd, currentValueUsd, deltaUsd, deltaPct };
}

function PortfolioRow({ position }) {
  const name = resolveTokenName(position);
  const iconUrl = resolveTokenIcon(position);
  const glyph = resolveTokenGlyph(position);
  const { purchasedPrice, currentPrice, costUsd, currentValueUsd, deltaUsd, deltaPct } = resolveDelta(position);
  const deltaTone = deltaUsd > 0 ? "is-positive" : deltaUsd < 0 ? "is-negative" : "is-flat";
  const symbol = String(position?.symbol || position?.token?.symbol || "").toUpperCase();
  const purchasedAt = prettyDateTime(position?.opened_at || position?.purchased_at || position?.bought_at || position?.created_at);
  const soldAt = prettyDateTime(position?.sold_at);
  const timestampText = soldAt !== "—"
    ? `Purchased ${purchasedAt} · Sold ${soldAt}`
    : `Purchased ${purchasedAt}`;

  return React.createElement(
    "div",
    { className: cls("portfolio-row", deltaTone) },
    React.createElement(
      "div",
      { className: "portfolio-token" },
      React.createElement(
        "div",
        { className: "portfolio-token-icon" },
        iconUrl
          ? React.createElement("img", { src: iconUrl, alt: `${name} icon`, className: "portfolio-token-image" })
          : React.createElement("span", { className: "portfolio-token-glyph" }, glyph)
      ),
      React.createElement(
        "div",
        { className: "portfolio-token-copy" },
        tokenLink(position?.contract_address || position?.token?.contract_address, symbol || "—", "portfolio-token-symbol"),
        React.createElement("div", { className: "portfolio-token-name" }, name),
        React.createElement("div", { className: "portfolio-token-meta" }, position.category || "unknown"),
        React.createElement("div", { className: "portfolio-token-address" }, position.contract_address || position?.token?.contract_address || "—"),
        React.createElement("div", { className: "portfolio-token-purchased" }, timestampText)
      )
    ),
    React.createElement(
      "div",
      { className: "portfolio-stats" },
      React.createElement(
        "div",
        { className: "portfolio-stat" },
        React.createElement("span", { className: "portfolio-stat-label" }, "Purchased price"),
        React.createElement("strong", null, fmtUsd.format(purchasedPrice))
      ),
      React.createElement(
        "div",
        { className: "portfolio-stat" },
        React.createElement("span", { className: "portfolio-stat-label" }, "Current price"),
        React.createElement("strong", null, fmtUsd.format(currentPrice))
      ),
      React.createElement(
        "div",
        { className: "portfolio-stat" },
        React.createElement("span", { className: "portfolio-stat-label" }, "Cost"),
        React.createElement("strong", null, fmtUsd.format(costUsd))
      ),
      React.createElement(
        "div",
        { className: "portfolio-stat" },
        React.createElement("span", { className: "portfolio-stat-label" }, "Current value"),
        React.createElement("strong", null, fmtUsd.format(currentValueUsd))
      ),
      React.createElement(
        "div",
        { className: cls("portfolio-stat", deltaTone) },
        React.createElement("span", { className: "portfolio-stat-label" }, "Delta"),
        React.createElement("strong", null, `${deltaUsd >= 0 ? "+" : ""}${fmtUsd.format(deltaUsd)}`),
        React.createElement("span", { className: "portfolio-stat-sub" }, `${deltaPct >= 0 ? "+" : ""}${fmtNum.format(deltaPct)}%`)
      )
    )
  );
}

function buildTradingLanes(state, portfolio) {
  const counts = state?.counts || {};
  const latest = state?.latest || {};

  return [
    {
      key: "scout",
      label: "Scout",
      icon: "🔭",
      badge: latest.candidate ? prettyAgo(latest.candidate.ts) : "idle",
      meta: latest.candidate ? `${counts.scoutCandidates || 0} candidates · ${prettyTime(latest.candidate.ts)}` : `${counts.scoutCandidates || 0} candidates`,
      active: (counts.scoutCandidates || 0) > 0,
      tone: "lane-scout"
    },
    {
      key: "harvest",
      label: "Harvest",
      icon: "🧺",
      badge: latest.harvest ? prettyAgo(latest.harvest.ts) : "idle",
      meta: latest.harvest ? `${counts.harvestDecisions || 0} exit reviews · ${prettyTime(latest.harvest.ts)}` : `${counts.harvestDecisions || 0} holdings reviewed`,
      submeta: counts.harvestApproved ? `${counts.harvestApproved} exit-ready` : "Watching for profit harvests",
      active: (counts.harvestDecisions || 0) > 0,
      tone: "lane-harvest"
    },
    {
      key: "risk",
      label: "Risk",
      icon: "🛡️",
      badge: `${counts.riskApproved || 0} green`,
      meta: `${counts.riskApproved || 0} approved · ${counts.riskBlocked || 0} blocked`,
      active: (counts.riskDecisions || 0) > 0,
      tone: "lane-risk"
    },
    {
      key: "executor",
      label: "Executor",
      icon: "🤖",
      badge: counts.sellSignals ? `${counts.sellSignals} exits` : `${counts.executorApproved || 0} live`,
      meta: `${counts.executorApproved || 0} executed · ${counts.executorBlocked || 0} held`,
      active: (counts.executorDecisions || 0) > 0 || (counts.sellSignals || 0) > 0,
      tone: "lane-executor"
    },
    {
      key: "wallet",
      label: "Wallet",
      icon: "💼",
      badge: portfolio?.open_positions ? `${portfolio.open_positions} open` : "cash",
      meta: `${fmtUsd.format(portfolio?.cash_usd || 0)} cash`,
      submeta: counts.sellSignals ? `${counts.sellSignals} exit watch` : `${counts.outcomes || 0} closed`,
      active: (counts.trades || 0) > 0 || (counts.outcomes || 0) > 0 || (counts.sellSignals || 0) > 0,
      tone: "lane-wallet"
    }
  ];
}

function TradingLane({ state, portfolio }) {
  const counts = state?.counts || {};
  const lanes = buildTradingLanes(state, portfolio);

  const orbitNodes = [
    { lane: lanes[0], className: "orbit-node orbit-scout", title: "Scout" },
    { lane: lanes[2], className: "orbit-node orbit-risk", title: "Risk" },
    { lane: lanes[3], className: "orbit-node orbit-executor", title: "Executor" },
    { lane: lanes[1], className: "orbit-node orbit-harvest", title: "Harvest" }
  ];
  const latestCycleAt = state?.latestCycle?.ts ? new Date(state.latestCycle.ts).getTime() : 0;
  const isPipelineLive = Number.isFinite(latestCycleAt) && latestCycleAt > 0 && (Date.now() - latestCycleAt) <= 3 * 60 * 1000;
  const hasOrbitActivity = isPipelineLive && (orbitNodes.some(({ lane }) => lane.active) || lanes[4].active);

  return React.createElement(
    "div",
    { className: "book-lane book-lane-orbit" },
    React.createElement(
      "div",
      { className: "book-lane-head" },
      React.createElement("span", { className: "book-lane-title" }, "Agent orbit + wallet"),
      React.createElement("span", { className: "book-lane-note" }, "Scout → Risk → Executor → Harvest around the portfolio core")
    ),
    React.createElement(
      "div",
      { className: "orbit-stage" },
      React.createElement(
        "svg",
        { className: cls("orbit-lines", hasOrbitActivity && "has-activity"), viewBox: "0 0 1000 760", preserveAspectRatio: "none", "aria-hidden": "true" },
        React.createElement("circle", { className: cls("orbit-ring", hasOrbitActivity && "is-active"), cx: "500", cy: "380", r: "250" }),
        React.createElement("line", { className: cls("orbit-spoke orbit-spoke-scout", lanes[0].active && "is-active"), x1: "240", y1: "160", x2: "500", y2: "380" }),
        React.createElement("line", { className: cls("orbit-spoke orbit-spoke-risk", lanes[2].active && "is-active"), x1: "760", y1: "160", x2: "500", y2: "380" }),
        React.createElement("line", { className: cls("orbit-spoke orbit-spoke-executor", lanes[3].active && "is-active"), x1: "760", y1: "560", x2: "500", y2: "380" }),
        React.createElement("line", { className: cls("orbit-spoke orbit-spoke-harvest", lanes[1].active && "is-active"), x1: "240", y1: "560", x2: "500", y2: "380" })
      ),
      React.createElement(LaneNode, { lane: lanes[4], className: "orbit-node orbit-wallet" }),
      orbitNodes.map(({ lane, className }) => React.createElement(LaneNode, { key: lane.key, lane, className }))
    ),
    null
  );
}

function PositionRow({ position }) {
  const { currentValueUsd } = resolveDelta(position);
  const value = currentValueUsd;
  return React.createElement(
    "div",
    { className: "position-row" },
    React.createElement(
      "div",
      { className: "position-main" },
      React.createElement("div", { className: "position-symbol" }, position.symbol),
      React.createElement("div", { className: "position-meta" }, `${position.category || "unknown"} · score ${fmtNum.format(position.score || 0)}`)
    ),
    React.createElement(
      "div",
      { className: "position-stats" },
      React.createElement("span", null, fmtUsd.format(value)),
      React.createElement("span", null, `${fmtNum.format(position.quantity || 0)} units`),
      React.createElement("span", null, `entry ${fmtUsd.format(position.avg_entry_price || 0)}`)
    )
  );
}

function FlowStage({ stage }) {
  return React.createElement(
    "div",
    { className: cls("flow-stage", stage.accent) },
    React.createElement("div", { className: "flow-stage-top" },
      React.createElement("span", { className: "flow-stage-label" }, stage.label),
      React.createElement("span", { className: "flow-stage-status" }, stage.status)
    ),
    React.createElement("div", { className: "flow-stage-detail" }, stage.detail)
  );
}

function AgentMeter({ meter }) {
  return React.createElement(
    "div",
    { className: cls("agent-meter", meter.tone) },
    React.createElement("div", { className: "agent-meter-label" }, meter.label),
    React.createElement("div", { className: "agent-meter-value" }, String(meter.value)),
    React.createElement("div", { className: "agent-meter-sublabel" }, meter.sublabel)
  );
}

function MilestoneBadge({ item }) {
  return React.createElement(
    "div",
    { className: cls("milestone-badge", item.source === "clickhouse" ? "milestone-live" : "") },
    React.createElement("div", { className: "milestone-badge-top" },
      React.createElement("span", { className: "milestone-badge-label" }, item.label),
      React.createElement("span", { className: "milestone-badge-time" }, prettyTime(item.ts))
    ),
    React.createElement("div", { className: "milestone-badge-bottom" },
      item.symbol ? React.createElement("span", { className: "milestone-pill" }, item.symbol) : null,
      item.decision ? React.createElement("span", { className: "milestone-pill muted" }, item.decision) : null
    )
  );
}

function E3DAuthPanel({
  mode,
  onModeChange,
  loginEmail,
  onLoginEmailChange,
  loginPassword,
  onLoginPasswordChange,
  apiKey,
  onApiKeyChange,
  authStatus,
  statusLoading,
  statusMessage,
  statusError,
  connectLoading,
  clearLoading,
  onConnect,
  onClear,
  onRefresh
}) {
  const connected = Boolean(authStatus?.connected);
  const badgeClass = authStatus?.lastError ? "badge badge-red" : connected ? "badge badge-green" : "badge badge-amber";
  const modeLabel = mode === "login" ? "Username/password" : "API key";
  const connectedLabel = connected
    ? authStatus?.mode === "login"
      ? "Connected with login session"
      : "Connected with API key"
    : "Not connected";

  return React.createElement(
    "section",
    { className: "card auth-panel" },
    React.createElement(
      "div",
      { className: "auth-panel-head" },
      React.createElement(
        "div",
        { className: "auth-panel-copy" },
        React.createElement("div", { className: "auth-panel-title" }, "e3d.ai access"),
        React.createElement(
          "div",
          { className: "auth-panel-note" },
          "Authenticate the trading floor to e3d.ai with either a session login or API key. Secrets stay on the server so the dashboard can use the full story, thesis, and flow surface without the anonymous limit."
        )
      ),
      React.createElement(
        "div",
        { className: "auth-panel-status" },
        React.createElement("span", { className: badgeClass }, connectedLabel),
        React.createElement(
          "button",
          { className: "button button-secondary", onClick: onRefresh, disabled: statusLoading },
          statusLoading ? "Refreshing…" : "Refresh status"
        )
      )
    ),
    React.createElement(
      "div",
      { className: "auth-panel-grid" },
      React.createElement(
        "div",
        { className: "auth-form" },
        React.createElement(
          "div",
          { className: "auth-form-row" },
          React.createElement(
            "div",
            { className: "auth-form-field" },
            React.createElement("label", { className: "auth-label" }, "Auth mode"),
            React.createElement(
              "select",
              {
                className: "auth-input",
                value: mode,
                onChange: (event) => onModeChange(event.target.value)
              },
              React.createElement("option", { value: "api_key" }, "API key"),
              React.createElement("option", { value: "login" }, "Username/password")
            )
          ),
          React.createElement(
            "div",
            { className: "auth-form-field" },
            React.createElement("label", { className: "auth-label" }, mode === "login" ? "Email / username" : "API key"),
            mode === "login"
              ? React.createElement("input", {
                  className: "auth-input",
                  type: "email",
                  autoComplete: "username",
                  spellCheck: "false",
                  placeholder: "you@example.com",
                  value: loginEmail,
                  onChange: (event) => onLoginEmailChange(event.target.value)
                })
              : React.createElement("input", {
                  className: "auth-input",
                  type: "password",
                  autoComplete: "off",
                  spellCheck: "false",
                  placeholder: "e3d_...",
                  value: apiKey,
                  onChange: (event) => onApiKeyChange(event.target.value)
                })
          )
        ),
        mode === "login"
          ? React.createElement(
              "div",
              { className: "auth-form-field" },
              React.createElement("label", { className: "auth-label" }, "Password"),
              React.createElement("input", {
                className: "auth-input",
                type: "password",
                autoComplete: "current-password",
                spellCheck: "false",
                placeholder: "Password",
                value: loginPassword,
                onChange: (event) => onLoginPasswordChange(event.target.value)
              })
            )
          : null,
        React.createElement(
          "div",
          { className: "auth-actions" },
          React.createElement(
            "button",
            { className: "button button-primary", onClick: onConnect, disabled: connectLoading },
            connectLoading ? "Connecting…" : "Connect"
          ),
          React.createElement(
            "button",
            { className: "button button-danger", onClick: onClear, disabled: clearLoading },
            clearLoading ? "Clearing…" : "Clear credentials"
          )
        ),
        statusMessage ? React.createElement("div", { className: "auth-message" }, statusMessage) : null,
        statusError ? React.createElement("div", { className: "auth-error" }, statusError) : null,
        React.createElement(
          "div",
          { className: "auth-helper" },
          `Current mode: ${modeLabel}. Credentials are stored on the server using OS keychain when available, with encrypted local file fallback.`
        )
      ),
      React.createElement(
        "div",
        { className: "auth-form" },
        React.createElement("div", { className: "auth-label" }, "Current status"),
        React.createElement(
          "div",
          { className: "auth-helper" },
          authStatus?.mode === "login"
            ? `Login session active for ${authStatus.email || authStatus.username || "e3d.ai account"}.`
            : authStatus?.mode === "api_key"
              ? `API key active${authStatus.updatedAt ? ` · updated ${new Date(authStatus.updatedAt).toLocaleString()}` : ""}.`
              : "No e3d.ai credentials are stored yet."
        ),
        React.createElement(
          "div",
          { className: "auth-helper" },
          authStatus?.lastError ? `Last error: ${authStatus.lastError}` : "The dashboard will use this auth context for all e3d.ai requests made by the trading floor."
        ),
        React.createElement(
          "div",
          { className: "auth-helper" },
          "Username/password means your e3d.ai account login; the trading floor does not create a second identity."
        )
      )
    )
  );
}

function App() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [page, setPage] = useState(getPageFromHash());
  const [pipelineStatus, setPipelineStatus] = useState(null);
  const [intervalSeconds, setIntervalSeconds] = useState(300);
  const [pipelineMessage, setPipelineMessage] = useState(null);
  const [pipelineError, setPipelineError] = useState(null);
  const [authMode, setAuthMode] = useState("api_key");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authApiKey, setAuthApiKey] = useState("");
  const [authStatus, setAuthStatus] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authConnectLoading, setAuthConnectLoading] = useState(false);
  const [authClearLoading, setAuthClearLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState(null);
  const [authError, setAuthError] = useState(null);

  async function loadAuthStatus() {
    try {
      setAuthLoading(true);
      const res = await fetch("/api/e3d/auth/status");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setAuthStatus(data);
      if (data?.mode === "login" || data?.mode === "api_key") {
        setAuthMode(data.mode);
      }
      if (data?.connected) {
        setAuthMessage(data.mode === "login" ? "e3d.ai login session loaded." : "e3d.ai API key loaded.");
        setAuthError(null);
      }
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  }

  async function connectE3dAuth() {
    try {
      setAuthConnectLoading(true);
      setAuthError(null);
      setAuthMessage(null);
      const payload = authMode === "login"
        ? { mode: "login", username: authEmail, password: authPassword }
        : { mode: "api_key", apiKey: authApiKey };
      const res = await fetch("/api/e3d/auth/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setAuthStatus(data.auth || null);
      setAuthMessage(authMode === "login" ? "Connected to e3d.ai with login session." : "Connected to e3d.ai with API key.");
      setAuthPassword("");
      await loadAuthStatus();
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthConnectLoading(false);
    }
  }

  async function clearE3dAuth() {
    try {
      setAuthClearLoading(true);
      setAuthError(null);
      setAuthMessage(null);
      const res = await fetch("/api/e3d/auth/clear", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setAuthStatus(data.auth || null);
      setAuthApiKey("");
      setAuthPassword("");
      setAuthMessage("e3d.ai credentials cleared.");
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthClearLoading(false);
    }
  }
  async function load() {
    try {
      setError(null);
      const res = await fetch("/api/summary");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSummary(data);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadPipelineStatus() {
    try {
      const res = await fetch("/api/pipeline/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPipelineStatus(data);
    } catch (err) {
      setPipelineError(err.message);
    }
  }

  async function resetSystem() {
    const confirmed = typeof window !== "undefined" ? window.confirm("Reset the entire trading floor? This will stop the E3D Trading Agents, clear MongoDB, ClickHouse, and local logs.") : true;
    if (!confirmed) return;

    try {
      setPipelineError(null);
      setPipelineMessage(null);
      setError(null);
      const res = await fetch("/api/reset-all", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setPipelineStatus(data.pipeline || null);
      setPipelineMessage("Trading floor reset complete.");
      await Promise.all([load(), loadPipelineStatus()]);
    } catch (err) {
      setPipelineError(err.message);
    }
  }

  async function startPipeline() {
    try {
      setPipelineError(null);
      setPipelineMessage(null);
      const res = await fetch("/api/pipeline/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval_seconds: Number(intervalSeconds) || 300 })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPipelineStatus(data);
      setIntervalSeconds(Number(data.interval_seconds || intervalSeconds || 300));
      setPipelineMessage("E3D Trading Agents loop started.");
    } catch (err) {
      setPipelineError(err.message);
    }
  }

  async function stopPipeline() {
    try {
      setPipelineError(null);
      setPipelineMessage(null);
      const res = await fetch("/api/pipeline/stop", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPipelineStatus(data.pipeline || null);
      setPipelineMessage("E3D Trading Agents stop requested.");
    } catch (err) {
      setPipelineError(err.message);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    loadPipelineStatus();
    const id = setInterval(loadPipelineStatus, 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    loadAuthStatus();
    const id = setInterval(loadAuthStatus, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const syncPage = () => setPage(getPageFromHash());
    syncPage();
    window.addEventListener("hashchange", syncPage);
    if (!window.location.hash) {
      window.location.hash = "#portfolio";
    }
    return () => window.removeEventListener("hashchange", syncPage);
  }, []);

  const portfolio = summary?.portfolio || {};
  const events = summary?.activity || [];
  const positions = portfolio.positions || [];
  const history = portfolio.history || [];
  const floorState = useMemo(() => summarizeActivity(events), [events]);
  const intelligence = useMemo(() => summarizePortfolioIntelligence(events), [events]);
  const lanes = buildTradingLanes(floorState, portfolio);
  const latestCycleAt = floorState.latestCycle?.ts ? new Date(floorState.latestCycle.ts).getTime() : 0;
  const isPipelineLive = Number.isFinite(latestCycleAt) && latestCycleAt > 0 && (Date.now() - latestCycleAt) <= 3 * 60 * 1000;
  const hasOrbitActivity = isPipelineLive && (
    (floorState.flow || []).some((stage) => stage.status && stage.status !== "waiting") ||
    (floorState.meters || []).some((meter) => Number(meter.value || 0) > 0)
  );
  const pipelineRunning = Boolean(pipelineStatus?.running);
  const orbitNodes = [
    { lane: lanes[0], className: "orbit-node orbit-scout", title: "Scout" },
    { lane: lanes[2], className: "orbit-node orbit-risk", title: "Risk" },
    { lane: lanes[3], className: "orbit-node orbit-executor", title: "Executor" },
    { lane: lanes[1], className: "orbit-node orbit-harvest", title: "Harvest" }
  ];
  const portfolioPanel = React.createElement(
    "div",
    { className: "card panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "Portfolio"),
      React.createElement("span", { className: "panel-note" }, `${positions.length} tracked positions`)
    ),
    positions.length
      ? React.createElement("div", { className: "portfolio-list" }, positions.map((pos) => React.createElement(PortfolioRow, { key: pos.contract_address || pos.symbol, position: pos })))
      : React.createElement(
          "div",
          { className: "empty-book" },
          React.createElement("div", { className: "empty-book-head" }, "All cash on deck"),
          React.createElement("div", { className: "empty-book-copy" }, "No open positions yet. The portfolio is clean and ready for the next high-conviction setup."),
          React.createElement(
            "div",
            { className: "empty-book-metrics" },
            React.createElement("div", { className: "empty-book-metric" },
              React.createElement("span", null, "Cash ready"),
              React.createElement("strong", null, fmtUsd.format(portfolio.cash_usd || 0))
            ),
            React.createElement("div", { className: "empty-book-metric" },
              React.createElement("span", null, "Market regime"),
              React.createElement("strong", null, String(portfolio.market_regime || "unknown").replace(/_/g, " "))
            )
          )
        )
  );

  const historyPanel = React.createElement(
    "div",
    { className: "card panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "History"),
      React.createElement("span", { className: "panel-note" }, `${history.length} sold tokens`)
    ),
    history.length
      ? React.createElement("div", { className: "portfolio-list" }, history.map((pos, index) => React.createElement(PortfolioRow, { key: pos.trade_id || `${pos.contract_address || pos.symbol}-${pos.sold_at || pos.opened_at || index}`, position: pos })))
      : React.createElement(
          "div",
          { className: "empty-book" },
          React.createElement("div", { className: "empty-book-head" }, "No sold tokens yet"),
          React.createElement("div", { className: "empty-book-copy" }, "Closed trades will appear here with the same token details, entry price, sale price, and timestamps."),
          React.createElement(
            "div",
            { className: "empty-book-metrics" },
            React.createElement("div", { className: "empty-book-metric" }, React.createElement("span", null, "Sold tokens"), React.createElement("strong", null, "0")),
            React.createElement("div", { className: "empty-book-metric" }, React.createElement("span", null, "Closed PnL"), React.createElement("strong", null, fmtUsd.format(portfolio.realized_pnl_usd || 0)))
          )
        )
  );

  const decisionTrailPanel = React.createElement(
    "div",
    { className: "card panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "Decision Trail"),
      React.createElement("span", { className: "panel-note" }, "Scout → Harvest → Risk → Executor → Wallet")
    ),
    React.createElement(
      "div",
      { className: "floor-flow" },
      floorState.flow.map((stage, index) => React.createElement(React.Fragment, { key: stage.key },
        React.createElement(FlowStage, { stage }),
        index < floorState.flow.length - 1 ? React.createElement("div", { className: "flow-connector" }) : null
      ))
    ),
    React.createElement("div", { className: "floor-meters" }, floorState.meters.map((meter) => React.createElement(AgentMeter, { key: meter.label, meter }))),
    React.createElement("div", { className: "floor-milestones" }, floorState.milestones.length
      ? floorState.milestones.map((item) => React.createElement(MilestoneBadge, { key: item.id, item }))
      : React.createElement("div", { className: "empty-state" }, "No milestones yet — waiting on the next trading cycle."))
  );

  const orbitPanel = React.createElement(
    "div",
    { className: "book-lane book-lane-orbit" },
    React.createElement(
      "div",
      { className: "book-lane-head" },
      React.createElement("span", { className: "book-lane-title" }, "Agent orbit + wallet"),
      React.createElement("span", { className: "book-lane-note" }, "Scout → Risk → Executor → Harvest around the portfolio core")
    ),
    React.createElement(
      "div",
      { className: "orbit-stage" },
      React.createElement(
        "svg",
        { className: cls("orbit-lines", hasOrbitActivity && "has-activity"), viewBox: "0 0 1000 760", preserveAspectRatio: "none", "aria-hidden": "true" },
        React.createElement("circle", { className: cls("orbit-ring", hasOrbitActivity && "is-active"), cx: "500", cy: "380", r: "250" }),
        React.createElement("line", { className: cls("orbit-spoke orbit-spoke-scout", lanes[0].active && "is-active"), x1: "240", y1: "160", x2: "500", y2: "380" }),
        React.createElement("line", { className: cls("orbit-spoke orbit-spoke-risk", lanes[2].active && "is-active"), x1: "760", y1: "160", x2: "500", y2: "380" }),
        React.createElement("line", { className: cls("orbit-spoke orbit-spoke-executor", lanes[3].active && "is-active"), x1: "760", y1: "560", x2: "500", y2: "380" }),
        React.createElement("line", { className: cls("orbit-spoke orbit-spoke-harvest", lanes[1].active && "is-active"), x1: "240", y1: "560", x2: "500", y2: "380" })
      ),
      React.createElement(LaneNode, { lane: lanes[4], className: "orbit-node orbit-wallet" }),
      orbitNodes.map(({ lane, className }) => React.createElement(LaneNode, { key: lane.key, lane, className }))
    )
  );

  const orbitPage = React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section",
      { className: "page-grid page-grid-orbit" },
      React.createElement("div", { className: "page-column page-column-orbit-main" }, orbitPanel),
      React.createElement("div", { className: "page-column page-column-orbit-trail" }, decisionTrailPanel)
    )
  );

  const activityTrailPanel = React.createElement(
    "section",
    { className: "card panel" },
    React.createElement("div", { className: "panel-head" },
      React.createElement("h2", null, "Agent Trail"),
      React.createElement("span", { className: "panel-note" }, "Cycle freshness, approvals, and regime shifts")
    ),
    React.createElement("div", { className: "activity-grid" },
      React.createElement(
        "div",
        { className: "activity-box" },
        React.createElement("div", { className: "activity-title" }, "Cycle pulse"),
        React.createElement(
          "div",
          { className: "mini-list" },
          [floorState.latestCycle, events.find((item) => item.type === "market_regime"), events.find((item) => item.type === "candidate")]
            .filter(Boolean)
            .slice(0, 3)
            .map((item) => React.createElement("div", { className: "mini-row", key: item.id },
              React.createElement("span", null, item.type.replace(/_/g, " ")),
              React.createElement("span", null, prettyTime(item.ts))
            ))
        )
      ),
      React.createElement(
        "div",
        { className: "activity-box" },
        React.createElement("div", { className: "activity-title" }, "Milestone mix"),
        React.createElement(
          "div",
          { className: "mini-list" },
          React.createElement("div", { className: "mini-row" }, React.createElement("span", null, "Signals"), React.createElement("span", null, String(events.filter((item) => item.type === "candidate").length))),
          React.createElement("div", { className: "mini-row" }, React.createElement("span", null, "Approvals"), React.createElement("span", null, String(events.filter((item) => item.type === "risk_decision" && normalizeDecision(item.summary?.decision).includes("approved")).length))),
          React.createElement("div", { className: "mini-row" }, React.createElement("span", null, "Executions"), React.createElement("span", null, String(events.filter((item) => item.type === "executor_decision" && normalizeDecision(item.summary?.decision).includes("approved")).length)))
        )
      )
    )
  );

  const portfolioPage = React.createElement(
    "div",
    { className: "content-column-main" },
    portfolioPanel
  );

  const opportunitiesPage = React.createElement(
    "div",
    { className: "content-column-main" },
    React.createElement(IntelligencePanel, { intelligence, floorState })
  );

  const historyPage = React.createElement(
    "div",
    { className: "content-column-main" },
    historyPanel
  );

  const activityPage = React.createElement(
    React.Fragment,
    null,
    React.createElement(NetworkDebugFeed, null),
    React.createElement(AgentActivityPage, null),
    activityTrailPanel
  );

  const settingsPage = React.createElement(
    "div",
    { className: "content-column-main" },
    React.createElement(
      "section",
      { className: "card pipeline-controls-strip" },
      React.createElement(
        "div",
        { className: "pipeline-controls-strip-head" },
        React.createElement("span", { className: "pipeline-controls-title" }, "E3D Trading Agents"),
        React.createElement("span", { className: badgeForPipelineStatus(pipelineStatus) }, formatPipelineStatus(pipelineStatus))
      ),
      React.createElement(
        "div",
        { className: "pipeline-controls-strip-body" },
        React.createElement(
          "div",
          { className: "pipeline-control-row pipeline-control-row-inline" },
          React.createElement("label", { className: "pipeline-control-label", htmlFor: "pipeline-interval" }, "Cycle interval (sec)"),
          React.createElement("input", {
            id: "pipeline-interval",
            className: "pipeline-control-input",
            type: "number",
            min: 1,
            step: 1,
            value: intervalSeconds,
            onChange: (event) => setIntervalSeconds(event.target.value)
          })
        ),
        React.createElement(
          "div",
          { className: "pipeline-control-actions" },
          React.createElement(
            "button",
            { className: "button button-primary", onClick: startPipeline, disabled: pipelineRunning },
            pipelineRunning ? "Agents running" : "Start agents"
          ),
          React.createElement(
            "button",
            { className: "button button-secondary", onClick: stopPipeline, disabled: !pipelineRunning },
            "Stop agents"
          ),
          React.createElement(
            "button",
            { className: "button button-danger", onClick: resetSystem },
            "Reset all"
          )
        ),
        React.createElement("div", { className: "pipeline-controls-note" }, "Starts the E3D Trading Agents loop with your chosen interval."),
        pipelineMessage ? React.createElement("div", { className: "pipeline-controls-message" }, pipelineMessage) : null,
        pipelineError ? React.createElement("div", { className: "pipeline-controls-error" }, pipelineError) : null,
        pipelineStatus?.pid ? React.createElement("div", { className: "pipeline-controls-meta" }, `PID ${pipelineStatus.pid}`) : null
      )
    ),
    React.createElement(E3DAuthPanel, {
      mode: authMode,
      onModeChange: setAuthMode,
      loginEmail: authEmail,
      onLoginEmailChange: setAuthEmail,
      loginPassword: authPassword,
      onLoginPasswordChange: setAuthPassword,
      apiKey: authApiKey,
      onApiKeyChange: setAuthApiKey,
      authStatus,
      statusLoading: authLoading,
      statusMessage: authMessage,
      statusError: authError,
      connectLoading: authConnectLoading,
      clearLoading: authClearLoading,
      onConnect: connectE3dAuth,
      onClear: clearE3dAuth,
      onRefresh: loadAuthStatus
    })
  );

  const pageLabelMap = {
    portfolio: "Portfolio",
    opportunities: "Best Opportunities + Weakest Positions",
    history: "History",
    settings: "Settings",
    orbit: "Orbit + wallet",
    activity: "Agent Activity"
  };
  const pageNoteMap = {
    portfolio: "Open positions with entry, current value, and delta",
    opportunities: "High-conviction opportunities and the weakest current positions",
    history: "Sold positions with entry, exit, and realized PnL",
    settings: "Manage e3d.ai login, API key access, and pipeline controls",
    orbit: "Agent orbit and wallet view",
    activity: "Per-cycle story signals, tokens considered, and risk decisions"
  };
  const pageLabel = pageLabelMap[page] || pageLabelMap.portfolio;
  const pageNote = pageNoteMap[page] || pageNoteMap.portfolio;

  const goToPage = (nextPage) => {
    if (typeof window === "undefined") return;
    window.location.hash = `#${nextPage}`;
  };
  const pageContent = page === "opportunities"
    ? opportunitiesPage
    : page === "history"
      ? historyPage
      : page === "settings"
        ? settingsPage
        : page === "orbit"
          ? orbitPage
          : page === "activity"
            ? activityPage
            : portfolioPage;

  return React.createElement(
    React.Fragment,
    null,
    React.createElement("div", { className: "bg-orb bg-orb-1" }),
    React.createElement("div", { className: "bg-orb bg-orb-2" }),
    React.createElement(
      "div",
      { className: "hero card" },
      React.createElement(
        "div",
        { className: "hero-copy" },
        React.createElement("div", { className: "eyebrow" }, "E3D Agent Trading Floor"),
        React.createElement("h1", { className: "hero-title" }, pageLabel),
        React.createElement("p", null, pageNote),
        React.createElement(
          "div",
          { className: "hero-actions" },
          React.createElement("button", { className: cls("button", page === "portfolio" && "button-active"), onClick: () => goToPage("portfolio") }, "Portfolio"),
          React.createElement("button", { className: cls("button", page === "opportunities" && "button-active"), onClick: () => goToPage("opportunities") }, "Opportunities"),
          React.createElement("button", { className: cls("button", page === "history" && "button-active"), onClick: () => goToPage("history") }, "History"),
          React.createElement("button", { className: cls("button", page === "settings" && "button-active"), onClick: () => goToPage("settings") }, "Settings"),
          React.createElement("button", { className: cls("button", page === "orbit" && "button-active"), onClick: () => goToPage("orbit") }, "Orbit"),
          React.createElement("button", { className: cls("button", page === "activity" && "button-active"), onClick: () => goToPage("activity") }, "Activity"),
          React.createElement("button", { className: "button button-primary", onClick: load }, "Refresh now"),
          React.createElement("a", { className: "button button-secondary", href: "/api/activity", target: "_blank", rel: "noreferrer" }, "Raw activity API")
        )
      ),
      React.createElement(
        "div",
        { className: "hero-side" },
        React.createElement(
          "div",
          { className: "hero-side-top" },
          React.createElement("div", { className: badgeForRegime(portfolio.market_regime) }, portfolio.market_regime || "unknown"),
          React.createElement(
            "div",
            { className: "hero-side-stats" },
            React.createElement("div", { className: "hero-side-stat" },
              React.createElement("div", { className: "hero-side-label" }, "Positions"),
              React.createElement("div", { className: "hero-side-value" }, String(portfolio.open_positions ?? 0))
            ),
            React.createElement("div", { className: "hero-side-stat" },
              React.createElement("div", { className: "hero-side-label" }, "Updated"),
              React.createElement("div", { className: "hero-side-value" }, lastUpdated ? lastUpdated.toLocaleTimeString() : "—")
            )
          )
        )
      )
    ),
    loading && React.createElement("div", { className: "card loading" }, "Loading dashboard…"),
    error && React.createElement("div", { className: "card error" }, `Dashboard error: ${error}`),
    React.createElement(
      "section",
      { className: "metrics-grid" },
      React.createElement(MetricCard, { label: "Cash", value: fmtUsd.format(portfolio.cash_usd || 0), sublabel: "Available buying power" }),
      React.createElement(MetricCard, { label: "Equity", value: fmtUsd.format(portfolio.equity_usd || 0), sublabel: "Cash + open positions" }),
      React.createElement(MetricCard, { label: "Realized PnL", value: fmtUsd.format(portfolio.realized_pnl_usd || 0), sublabel: "Closed trades" }),
      React.createElement(MetricCard, { label: "Unrealized PnL", value: fmtUsd.format(portfolio.unrealized_pnl_usd || 0), sublabel: "Open positions" }),
      React.createElement(MetricCard, { label: "Max Drawdown", value: `${fmtNum.format((portfolio.max_drawdown_pct || 0) * 100)}%`, sublabel: "Peak-to-trough" }),
      React.createElement(MetricCard, { label: "Events", value: String(events.length), sublabel: "Latest agent + trade activity" })
    ),
    pageContent
  );
}

createRoot(document.getElementById("root")).render(React.createElement(App));
