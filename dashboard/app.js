import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";

const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtNum = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function cls(...parts) {
  return parts.filter(Boolean).join(" ");
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
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
    minute: "2-digit"
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

function getPageFromHash() {
  if (typeof window === "undefined") return "portfolio";
  const hash = String(window.location.hash || "").replace(/^#/, "").toLowerCase();
  return hash === "orbit" ? "orbit" : "portfolio";
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
  const currentPrice = Number(position?.current_price || 0);
  const avgEntryUsd = purchasedPrice * quantity;
  const currentPriceUsd = currentPrice * quantity;
  const costUsd = Number(position?.cost_usd != null ? position.cost_usd : avgEntryUsd) || 0;
  const currentValueUsd = Number(
    position?.current_value_usd != null
      ? position.current_value_usd
      : position?.market_value_usd != null
        ? position.market_value_usd
        : currentPriceUsd
  ) || 0;
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
        React.createElement("div", { className: "portfolio-token-symbol" }, symbol || "—"),
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
  const value = position.market_value_usd || 0;
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
      setPipelineMessage("Pipeline loop started.");
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
      setPipelineMessage("Pipeline stop requested.");
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
  const lanes = buildTradingLanes(floorState, portfolio);
  const latestCycleAt = floorState.latestCycle?.ts ? new Date(floorState.latestCycle.ts).getTime() : 0;
  const isPipelineLive = Number.isFinite(latestCycleAt) && latestCycleAt > 0 && (Date.now() - latestCycleAt) <= 3 * 60 * 1000;
  const hasOrbitActivity = isPipelineLive && (
    (floorState.flow || []).some((stage) => stage.status && stage.status !== "waiting") ||
    (floorState.meters || []).some((meter) => Number(meter.value || 0) > 0)
  );
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

  const activityPanel = React.createElement(
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
    React.Fragment,
    null,
    React.createElement(
      "section",
      { className: "page-grid page-grid-portfolio" },
      React.createElement("div", { className: "page-column page-column-portfolio" }, portfolioPanel),
      React.createElement("div", { className: "page-column page-column-portfolio" }, historyPanel)
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
    ),
    activityPanel
  );

  const pageLabel = page === "orbit" ? "Orbit + decision trail" : "Portfolio";
  const pageNote = page === "orbit"
    ? "Agent orbit, wallet, and decision trail"
    : "Open positions with entry, current value, and delta";

  const goToPage = (nextPage) => {
    if (typeof window === "undefined") return;
    window.location.hash = `#${nextPage}`;
  };

  const pipelineRunning = Boolean(pipelineStatus?.running);

  return React.createElement(
    React.Fragment,
    null,
    React.createElement("div", { className: "bg-orb bg-orb-1" }),
    React.createElement("div", { className: "bg-orb bg-orb-2" }),
    React.createElement(
      "main",
      { className: "shell" },
      React.createElement(
        "header",
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
            React.createElement("button", { className: cls("button", page === "orbit" && "button-active"), onClick: () => goToPage("orbit") }, "Orbit + trail"),
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
      React.createElement(
        "section",
        { className: "card pipeline-controls-strip" },
        React.createElement(
          "div",
          { className: "pipeline-controls-strip-head" },
          React.createElement("span", { className: "pipeline-controls-title" }, "Pipeline controls"),
          React.createElement("span", { className: badgeForPipelineStatus(pipelineStatus) }, formatPipelineStatus(pipelineStatus))
        ),
        React.createElement(
          "div",
          { className: "pipeline-controls-strip-body" },
          React.createElement(
            "div",
            { className: "pipeline-control-row pipeline-control-row-inline" },
            React.createElement("label", { className: "pipeline-control-label", htmlFor: "pipeline-interval" }, "Loop interval (sec)"),
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
              pipelineRunning ? "Running" : "Start pipeline"
            ),
            React.createElement(
              "button",
              { className: "button button-secondary", onClick: stopPipeline, disabled: !pipelineRunning },
              "Stop pipeline"
            )
          ),
          React.createElement("div", { className: "pipeline-controls-note" }, "Starts `node pipeline.js --loop` with your chosen interval."),
          pipelineMessage ? React.createElement("div", { className: "pipeline-controls-message" }, pipelineMessage) : null,
          pipelineError ? React.createElement("div", { className: "pipeline-controls-error" }, pipelineError) : null,
          pipelineStatus?.pid ? React.createElement("div", { className: "pipeline-controls-meta" }, `PID ${pipelineStatus.pid}`) : null
        )
      ),
      page === "orbit" ? orbitPage : portfolioPage
    )
  );
}

createRoot(document.getElementById("root")).render(React.createElement(App));
