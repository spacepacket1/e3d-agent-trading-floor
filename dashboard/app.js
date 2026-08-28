import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";

const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtNum = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function fmtCompact(n) {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Number(n).toFixed(0)}`;
}

const SUBSCRIPT_MAP = { "0":"₀","1":"₁","2":"₂","3":"₃","4":"₄","5":"₅","6":"₆","7":"₇","8":"₈","9":"₉" };
function toSubscript(n) { return String(n).split("").map(c => SUBSCRIPT_MAP[c] || c).join(""); }

function formatPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return fmtUsd.format(0);
  if (n >= 0.01) return fmtUsd.format(n);
  const fixed = n.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
  const dec = fixed.indexOf(".");
  const frac = dec >= 0 ? fixed.slice(dec + 1) : "";
  const leadMatch = frac.match(/^0+/);
  const zeros = leadMatch ? leadMatch[0].length : 0;
  if (zeros > 2) {
    const sig = frac.slice(zeros, zeros + 4);
    return `$0.0${toSubscript(zeros)}${sig}`;
  }
  return `$0.${frac.slice(0, zeros + 4)}`;
}

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

function badgeForGrade(grade) {
  if (grade === "A") return "badge badge-green";
  if (grade === "B") return "badge badge-blue";
  if (grade === "C") return "badge badge-amber";
  if (grade === "D") return "badge badge-orange";
  if (grade === "F") return "badge badge-red";
  return "badge";
}

function badgeForOperationalStatus(status) {
  const value = String(status || "").toLowerCase();
  if (["paper_ready", "healthy", "running", "allow", "reconciled", "approved_for_paper", "approved_for_shadow"].includes(value)) return "badge badge-green";
  if (["degraded", "warning", "limited"].includes(value)) return "badge badge-amber";
  if (["blocked", "failed", "mismatch", "blocked_live_only"].includes(value) || value.startsWith("approved_for_tiny_live") || value.startsWith("approved_for_scaled_live")) return "badge badge-red";
  return "badge";
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

function formatPct(value, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(digits)}%` : "—";
}

function formatCount(value) {
  const num = Number(value);
  return Number.isFinite(num) ? fmtNum.format(num) : "—";
}

function formatTokenUsage(value) {
  const num = Number(value);
  return Number.isFinite(num) ? fmtNum.format(num) : "—";
}

function compactList(values, limit = 3) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].slice(0, limit);
}

function renderReportCandidateCard(item, keyPrefix = "candidate") {
  if (!item || typeof item !== "object") return null;
  const symbol = item.symbol || "?";
  const status = String(item.status || item.action || "candidate").replace(/_/g, " ");
  const labels = compactList(item.evidence_labels, 3);
  const blockers = compactList(item.blockers, 3);
  const warnings = compactList(item.warnings, 3);
  return React.createElement(
    "div",
    { className: "report-candidate-card", key: `${keyPrefix}-${item.evidence_packet_id || item.contract_address || item.symbol || "unknown"}` },
    React.createElement(
      "div",
      { className: "report-candidate-head" },
      React.createElement(
        "div",
        { className: "report-candidate-identity" },
        tokenLink(item.contract_address, symbol, "candidate-symbol"),
        item.evidence_packet_id ? React.createElement("span", { className: "report-candidate-meta" }, item.evidence_packet_id) : null
      ),
      React.createElement("span", { className: "badge" }, status)
    ),
    React.createElement(
      "div",
      { className: "report-candidate-metrics" },
      React.createElement("span", null, `Quality ${item.evidence_quality_score != null ? formatCount(item.evidence_quality_score) : "—"}`),
      React.createElement("span", null, `Refs ${item.evidence_ref_count != null ? formatCount(item.evidence_ref_count) : "—"}`)
    ),
    item.decision_reason ? React.createElement("div", { className: "report-candidate-copy" }, item.decision_reason) : null,
    labels.length ? React.createElement("div", { className: "candidate-evidence" }, labels.map((label, index) => React.createElement("span", { className: "candidate-evidence-tag", key: `${keyPrefix}-label-${index}` }, label))) : null,
    blockers.length || warnings.length ? React.createElement(
      "div",
      { className: "candidate-risks" },
      [...blockers, ...warnings].slice(0, 3).map((value, index) => React.createElement("span", { className: "candidate-risk-tag", key: `${keyPrefix}-warn-${index}` }, value))
    ) : null
  );
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

function ProfessionalDashboardPanel({ professional, error }) {
  const overall = professional?.overall || {};
  const performance = professional?.performance || {};
  const strategy = professional?.strategy || {};
  const execution = professional?.execution || {};
  const risk = professional?.risk || {};
  const cryptoOps = professional?.crypto_ops || {};
  const audit = professional?.audit || {};
  const incidents = professional?.incidents || {};
  const daily = performance.daily || null;
  const backtest = strategy.backtest || performance.backtest || null;
  const promotion = strategy.promotion || null;
  const attribution = strategy.attribution || performance.attribution || null;
  const operations = cryptoOps.operations || null;
  const reconciliation = cryptoOps.reconciliation || null;
  const custody = cryptoOps.custody || null;
  const blockedReasons = Array.isArray(risk.top_blocked_reasons) ? risk.top_blocked_reasons : [];
  const utilRows = Array.isArray(risk.utilization) ? risk.utilization : [];
  const recentOrders = Array.isArray(execution.recent_orders) ? execution.recent_orders : [];
  const recentActions = Array.isArray(audit.recent_operator_actions) ? audit.recent_operator_actions : [];
  const positiveSetups = Array.isArray(attribution?.top_positive_setups) ? attribution.top_positive_setups : [];
  const negativeSetups = Array.isArray(attribution?.top_negative_setups) ? attribution.top_negative_setups : [];
  const activeIncidents = Array.isArray(incidents.active) ? incidents.active : [];
  const resolvedIncidents = Array.isArray(incidents.resolved) ? incidents.resolved : [];

  return React.createElement(
    "section",
    { className: "card panel professional-panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "Professional Dashboard"),
      React.createElement("span", { className: "panel-note" }, professional?.generated_at ? `Updated ${prettyAgo(professional.generated_at)}` : "Read-only status view")
    ),
    error ? React.createElement("div", { className: "card error" }, error) : null,
    React.createElement(
      "div",
      { className: "professional-status-strip" },
      React.createElement(
        "div",
        { className: "professional-status-main" },
        React.createElement(
          "div",
          { className: "professional-status-head" },
          React.createElement("span", { className: badgeForOperationalStatus(overall.status) }, String(overall.status || "unknown").replace(/_/g, " ")),
          React.createElement("span", { className: "badge badge-blue" }, professional?.trading_mode || "paper"),
          React.createElement("span", { className: "badge badge-red" }, professional?.live_submission_enabled ? "live enabled" : "live disabled")
        ),
        React.createElement("div", { className: "professional-status-copy" }, overall.summary || "No professional summary yet.")
      ),
      React.createElement(
        "div",
        { className: "professional-status-metrics" },
        React.createElement("div", { className: "professional-mini-stat" }, React.createElement("span", null, "Trade now"), React.createElement("strong", null, overall.can_trade_now ? "yes" : "no")),
        React.createElement("div", { className: "professional-mini-stat" }, React.createElement("span", null, "New buys"), React.createElement("strong", null, overall.new_buys_allowed ? "allowed" : "blocked")),
        React.createElement("div", { className: "professional-mini-stat" }, React.createElement("span", null, "Ops"), React.createElement("strong", null, operations?.overall_status || "unknown")),
        React.createElement("div", { className: "professional-mini-stat" }, React.createElement("span", null, "Reconciliation"), React.createElement("strong", null, reconciliation?.status || "missing"))
      )
    ),
    React.createElement(
      "div",
      { className: "professional-grid professional-grid-top" },
      React.createElement("div", { className: "professional-box" },
        React.createElement("span", null, "24h realized PnL"),
        React.createElement("strong", null, daily ? fmtUsd.format(Number(daily.realized_pnl_usd || 0)) : "—"),
        React.createElement("small", null, daily ? `${formatPct(daily.win_rate || 0)} win rate · PF ${daily.profit_factor == null ? "n/a" : fmtNum.format(Number(daily.profit_factor || 0))}` : "No daily scorecard")
      ),
      React.createElement("div", { className: "professional-box" },
        React.createElement("span", null, "Backtest edge"),
        React.createElement("strong", null, backtest ? formatPct(backtest.total_return_pct || 0) : "—"),
        React.createElement("small", null, backtest ? `PF ${backtest.profit_factor == null ? "n/a" : fmtNum.format(Number(backtest.profit_factor || 0))} · MDD ${formatPct(backtest.max_drawdown_pct || 0)}` : "No replay report")
      ),
      React.createElement("div", { className: "professional-box" },
        React.createElement("span", null, "Promotion"),
        React.createElement("strong", null, promotion?.promotion_decision || "missing"),
        React.createElement("small", null, promotion ? `${promotion.blocker_count || 0} blockers · target ${promotion.target_state || "unknown"}` : "No promotion report")
      ),
      React.createElement("div", { className: "professional-box" },
        React.createElement("span", null, "Execution drag"),
        React.createElement("strong", null, execution?.backtest_execution_quality?.fee_slippage_drag_usd != null ? fmtUsd.format(Number(execution.backtest_execution_quality.fee_slippage_drag_usd || 0)) : backtest?.fee_slippage_drag_usd != null ? fmtUsd.format(Number(backtest.fee_slippage_drag_usd || 0)) : "—"),
        React.createElement("small", null, execution?.backtest_execution_quality ? `Fill ${formatPct((execution.backtest_execution_quality.fill_ratio || 0) * 100, 1)} · Slip ${execution.backtest_execution_quality.average_slippage_bps ?? "—"} bps` : "No execution summary")
      )
    ),
    React.createElement(
      "div",
      { className: "professional-grid professional-grid-main" },
      React.createElement(
        "div",
        { className: "professional-section" },
        React.createElement("div", { className: "professional-section-title" }, "Risk"),
        React.createElement("div", { className: "professional-kv-list" },
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Kill switches"), React.createElement("strong", null, (risk.active_kill_switches || []).length ? risk.active_kill_switches.join(", ") : "none")),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Latest decision"), React.createElement("strong", null, risk.latest_decision ? `${risk.latest_decision.decision} ${risk.latest_decision.symbol ? `· ${risk.latest_decision.symbol}` : ""}` : "none")),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Market regime"), React.createElement("strong", null, String(risk.market_regime || "unknown").replace(/_/g, " "))),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Blocked reasons"), React.createElement("strong", null, blockedReasons.length ? blockedReasons.slice(0, 3).map((item) => `${item.reason} ×${item.count}`).join(", ") : "none"))
        ),
        React.createElement(
          "div",
          { className: "professional-chip-list" },
          utilRows.slice(0, 4).map((item) => React.createElement(
            "div",
            { className: "professional-chip", key: item.key },
            React.createElement("span", null, item.label),
            React.createElement("strong", null, item.utilization_pct == null ? "—" : formatPct(item.utilization_pct))
          ))
        ),
        React.createElement(
          "div",
          { className: "professional-subsection" },
          React.createElement("div", { className: "professional-subtitle" }, "Top exposure"),
          React.createElement("div", { className: "professional-list" },
            (risk.exposure?.by_token || []).slice(0, 4).map((item) => React.createElement("div", { className: "professional-list-row", key: item.key }, React.createElement("span", null, item.key), React.createElement("strong", null, fmtUsd.format(Number(item.value_usd || 0)))))
          )
        )
      ),
      React.createElement(
        "div",
        { className: "professional-section" },
        React.createElement("div", { className: "professional-section-title" }, "Strategy + Performance"),
        React.createElement("div", { className: "professional-kv-list" },
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Strategy version"), React.createElement("strong", null, strategy.backtest?.strategy_version || strategy.promotion?.strategy_version || "unknown")),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Expectancy"), React.createElement("strong", null, attribution?.expectancy_usd == null ? "—" : fmtUsd.format(Number(attribution.expectancy_usd || 0)))),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Neg. expectancy groups"), React.createElement("strong", null, attribution?.negative_expectancy_group_count == null ? "—" : String(attribution.negative_expectancy_group_count))),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Benchmark drag"), React.createElement("strong", null, backtest?.execution_cost_impact?.total_return_pct_points == null ? "—" : `${fmtNum.format(Number(backtest.execution_cost_impact.total_return_pct_points || 0))} pts`))
        ),
        React.createElement(
          "div",
          { className: "professional-subsection" },
          React.createElement("div", { className: "professional-subtitle" }, "Best setups"),
          React.createElement("div", { className: "professional-list" },
            positiveSetups.slice(0, 3).map((item, index) => React.createElement("div", { className: "professional-list-row", key: `${item.setup_label || item.key || index}-pos` }, React.createElement("span", null, item.setup_label || item.key || "setup"), React.createElement("strong", null, item.expectancy_usd == null ? "—" : fmtUsd.format(Number(item.expectancy_usd || 0)))))
          )
        ),
        React.createElement(
          "div",
          { className: "professional-subsection" },
          React.createElement("div", { className: "professional-subtitle" }, "Worst setups"),
          React.createElement("div", { className: "professional-list" },
            negativeSetups.slice(0, 3).map((item, index) => React.createElement("div", { className: "professional-list-row", key: `${item.setup_label || item.key || index}-neg` }, React.createElement("span", null, item.setup_label || item.key || "setup"), React.createElement("strong", null, item.expectancy_usd == null ? "—" : fmtUsd.format(Number(item.expectancy_usd || 0)))))
          )
        )
      ),
      React.createElement(
        "div",
        { className: "professional-section" },
        React.createElement("div", { className: "professional-section-title" }, "Execution + Order Lifecycle"),
        React.createElement("div", { className: "professional-kv-list" },
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Recent orders"), React.createElement("strong", null, String(execution.recent_order_count || 0))),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Rejected / failed"), React.createElement("strong", null, String(execution.rejected_count || 0))),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Avg slippage"), React.createElement("strong", null, execution.average_slippage_bps == null ? "—" : `${fmtNum.format(Number(execution.average_slippage_bps || 0))} bps`)),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Avg fee"), React.createElement("strong", null, execution.average_fee_bps == null ? "—" : `${fmtNum.format(Number(execution.average_fee_bps || 0))} bps`))
        ),
        React.createElement(
          "div",
          { className: "professional-chip-list" },
          Object.entries(execution.lifecycle_counts || {}).slice(0, 6).map(([state, count]) => React.createElement(
            "div",
            { className: "professional-chip", key: state },
            React.createElement("span", null, state.replace(/_/g, " ")),
            React.createElement("strong", null, String(count))
          ))
        ),
        React.createElement(
          "div",
          { className: "professional-subsection" },
          React.createElement("div", { className: "professional-subtitle" }, "Latest orders"),
          React.createElement("div", { className: "professional-list" },
            recentOrders.length
              ? recentOrders.map((item, index) => React.createElement(
                  "div",
                  { className: "professional-list-row", key: item.order_id || `${item.symbol || "order"}-${index}` },
                  React.createElement("span", null, `${item.symbol || "?"} ${item.side || ""} · ${String(item.state || "unknown").replace(/_/g, " ")}`),
                  React.createElement("strong", null, item.reason || "ok")
                ))
              : React.createElement("div", { className: "empty-state" }, "No lifecycle records yet.")
          )
        )
      ),
      React.createElement(
        "div",
        { className: "professional-section" },
        React.createElement("div", { className: "professional-section-title" }, "Ops + Audit"),
        React.createElement("div", { className: "professional-kv-list" },
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Operations"), React.createElement("strong", null, operations?.overall_status || "unknown")),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Custody policy"), React.createElement("strong", null, custody?.capability_status || "unknown")),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Audit policy"), React.createElement("strong", null, audit.permission_decision || "unknown")),
          React.createElement("div", { className: "professional-kv-row" }, React.createElement("span", null, "Data quality"), React.createElement("strong", null, professional?.data_quality?.average_confidence == null ? "—" : fmtNum.format(Number(professional.data_quality.average_confidence || 0))))
        ),
        React.createElement(
          "div",
          { className: "professional-subsection" },
          React.createElement("div", { className: "professional-subtitle" }, "Recent operator actions"),
          React.createElement("div", { className: "professional-list" },
            recentActions.length
              ? recentActions.slice(0, 4).map((item) => React.createElement("div", { className: "professional-list-row", key: item.audit_event_id || `${item.ts}-${item.action_type}` }, React.createElement("span", null, `${item.action_type} · ${item.role}`), React.createElement("strong", null, prettyAgo(item.ts))))
              : React.createElement("div", { className: "empty-state" }, "No recent operator actions.")
          )
        ),
        React.createElement(
          "div",
          { className: "professional-subsection" },
          React.createElement("div", { className: "professional-subtitle" }, "Incidents"),
          React.createElement("div", { className: "professional-list" },
            activeIncidents.length
              ? activeIncidents.map((item) => React.createElement("div", { className: "professional-list-row", key: item.incident_id || item.summary }, React.createElement("span", null, `${item.severity} · ${item.summary}`), React.createElement("strong", null, item.root_cause || "active")))
              : resolvedIncidents.length
                ? resolvedIncidents.slice(0, 3).map((item) => React.createElement("div", { className: "professional-list-row", key: item.incident_id || item.summary }, React.createElement("span", null, `resolved · ${item.summary}`), React.createElement("strong", null, item.root_cause || "closed")))
                : React.createElement("div", { className: "empty-state" }, "No incidents recorded.")
          )
        )
      )
    )
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
  const [universeOpen, setUniverseOpen] = useState(false);
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
        const isWatchlist = c?.source_agent === "user_watchlist";

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
              name ? React.createElement("span", { className: "candidate-name" }, name) : null,
              isWatchlist ? React.createElement("span", { className: "candidate-watchlist-badge" }, "Watchlist") : null
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
    ) : null,
    // Token universe — what Scout was shown
    Array.isArray(scout.token_universe) && scout.token_universe.length > 0 ? React.createElement(
      "div",
      { className: "cycle-section" },
      React.createElement(
        "div",
        { className: "cycle-section-title universe-toggle", onClick: () => setUniverseOpen(o => !o), style: { cursor: "pointer", userSelect: "none" } },
        `Token universe (${scout.token_universe.length}) `,
        React.createElement("span", { className: "universe-chevron" }, universeOpen ? "▲" : "▼")
      ),
      universeOpen ? React.createElement(
        "div",
        { className: "universe-table-wrap" },
        React.createElement(
          "table",
          { className: "universe-table" },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              null,
              React.createElement("th", null, "Token"),
              React.createElement("th", null, "Price"),
              React.createElement("th", null, "24h %"),
              React.createElement("th", null, "Vol 24h"),
              React.createElement("th", null, "Liq"),
              React.createElement("th", null, "Flow")
            )
          ),
          React.createElement(
            "tbody",
            null,
            scout.token_universe.map((t, i) => {
              const flowCls = t.flow_signal
                ? (t.flow_signal.includes("accumulation") ? "flow-accum" : t.flow_signal.includes("distribution") ? "flow-dist" : "")
                : "";
              const chg = t.change_24h;
              return React.createElement(
                "tr",
                { key: t.address || i },
                React.createElement("td", null, tokenLink(t.address, t.symbol, "universe-symbol")),
                React.createElement("td", null, t.price_usd != null ? formatPrice(t.price_usd) : "—"),
                React.createElement("td", { className: chg > 0 ? "chg-pos" : chg < 0 ? "chg-neg" : "" },
                  chg != null ? `${chg > 0 ? "+" : ""}${Number(chg).toFixed(1)}%` : "—"
                ),
                React.createElement("td", null, t.volume_24h_usd != null ? fmtCompact(t.volume_24h_usd) : "—"),
                React.createElement("td", null, t.liquidity_usd != null ? fmtCompact(t.liquidity_usd) : "—"),
                React.createElement("td", { className: flowCls }, t.flow_signal ? t.flow_signal.replace(/_/g, " ") : "—")
              );
            })
          )
        )
      ) : null
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
  if (hash === "reports") return "reports";
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
  const review = position?.review || null;

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
        React.createElement("span", { className: "portfolio-stat-label" }, "Quantity"),
        React.createElement("strong", null, fmtNum.format(position.quantity || 0))
      ),
      React.createElement(
        "div",
        { className: "portfolio-stat" },
        React.createElement("span", { className: "portfolio-stat-label" }, "Purchased price"),
        React.createElement("strong", null, formatPrice(purchasedPrice))
      ),
      React.createElement(
        "div",
        { className: "portfolio-stat" },
        React.createElement("span", { className: "portfolio-stat-label" }, "Current price"),
        React.createElement("strong", null, formatPrice(currentPrice))
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
    ),
    review ? React.createElement(
      "div",
      { className: "trade-review-strip" },
      React.createElement("div", { className: "trade-review-pill" }, `Label ${review.training_label || "neutral"}`),
      React.createElement("div", { className: "trade-review-pill" }, `Entry ${review.entry_quality || "unknown"}`),
      React.createElement("div", { className: "trade-review-pill" }, `Exit ${review.exit_quality || "unknown"}`),
      React.createElement("div", { className: "trade-review-pill" }, `Agent ${review.primary_error_agent && review.primary_error_agent !== "none" ? review.primary_error_agent : review.primary_success_agent || "none"}`),
      review.avoidable_loss ? React.createElement("div", { className: "trade-review-pill is-negative" }, "Avoidable loss") : null,
      Array.isArray(review.lessons) && review.lessons[0] ? React.createElement("div", { className: "trade-review-lesson" }, review.lessons[0]) : null
    ) : null
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
      React.createElement("span", null, `entry ${formatPrice(position.avg_entry_price || 0)}`)
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
              ? `API key active${authStatus.apiKeyPreview ? ` · ${authStatus.apiKeyPreview}` : ""}${authStatus.updatedAt ? ` · updated ${new Date(authStatus.updatedAt).toLocaleString()}` : ""}.`
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

function LedgerView() {
  const [entries, setEntries] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    fetch("/api/run-ledger?limit=50")
      .then(r => r.json())
      .then(data => { setEntries(Array.isArray(data.entries) ? data.entries.reverse() : []); setLoading(false); })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, []);

  if (loading) return React.createElement("div", { className: "card" }, "Loading ledger…");
  if (error) return React.createElement("div", { className: "card error" }, `Ledger error: ${error}`);
  if (!entries.length) return React.createElement("div", { className: "card" }, "No ledger entries yet. Run a pipeline cycle to generate data.");

  return React.createElement(
    "div", { className: "card" },
    React.createElement("h2", null, "Run Ledger"),
    React.createElement("p", { className: "panel-note" }, `${entries.length} cycles — most recent first`),
    React.createElement(
      "div", { style: { overflowX: "auto" } },
      React.createElement(
        "table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" } },
        React.createElement(
          "thead", null,
          React.createElement(
            "tr", null,
            ["Cycle", "Time", "E3D Found", "Story Signals", "Scout Cands", "Approved", "Buys", "Sells", "Equity", "Regime", "Outcomes"].map(h =>
              React.createElement("th", { key: h, style: { textAlign: "left", padding: "6px 10px", borderBottom: "1px solid var(--border, #333)", whiteSpace: "nowrap" } }, h)
            )
          )
        ),
        React.createElement(
          "tbody", null,
          entries.map((e, i) => {
            const outcomeLabel = e?.outcomes?.outcome_label;
            const outcomeStyle = outcomeLabel === "win" ? { color: "#4ade80" } : outcomeLabel === "loss" ? { color: "#f87171" } : { color: "#9ca3af" };
            return React.createElement(
              "tr", { key: e?.cycle_id || i, style: { borderBottom: "1px solid var(--border-subtle, #222)" } },
              React.createElement("td", { style: { padding: "6px 10px", fontFamily: "monospace", fontSize: "0.75rem" } }, (e?.cycle_id || "").slice(0, 8)),
              React.createElement("td", { style: { padding: "6px 10px", whiteSpace: "nowrap" } }, e?.cycle_ts ? new Date(e.cycle_ts).toLocaleString() : "—"),
              React.createElement("td", { style: { padding: "6px 10px", textAlign: "right" } }, e?.perception?.e3d_candidates_found ?? "—"),
              React.createElement("td", { style: { padding: "6px 10px", textAlign: "right" } }, e?.perception?.story_signals_found ?? "—"),
              React.createElement("td", { style: { padding: "6px 10px", textAlign: "right" } }, e?.scout?.candidates_after_quality_gate ?? "—"),
              React.createElement("td", { style: { padding: "6px 10px", textAlign: "right" } }, e?.risk?.approved ?? "—"),
              React.createElement("td", { style: { padding: "6px 10px", textAlign: "right" } }, e?.execution?.buys ?? "—"),
              React.createElement("td", { style: { padding: "6px 10px", textAlign: "right" } }, e?.execution?.sells ?? "—"),
              React.createElement("td", { style: { padding: "6px 10px", textAlign: "right" } }, e?.portfolio_snapshot?.equity_usd != null ? `$${Math.round(e.portfolio_snapshot.equity_usd).toLocaleString()}` : "—"),
              React.createElement("td", { style: { padding: "6px 10px" } }, e?.macro?.regime || "—"),
              React.createElement("td", { style: { padding: "6px 10px", ...outcomeStyle } }, outcomeLabel || (e?.outcomes?.recorded_at ? "neutral" : "pending"))
            );
          })
        )
      )
    )
  );
}

function DecisionLayerPanel({ data, error }) {
  const actions  = data?.actions  || null;
  const outcomes = data?.outcomes || null;
  const byType   = actions?.by_type && typeof actions.by_type === "object" ? actions.by_type : {};
  const typeKeys = Object.keys(byType).sort();
  return React.createElement(
    "div",
    { className: "card panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "Decision Layer"),
      React.createElement("span", { className: "panel-note" }, actions ? "Live" : "No data yet")
    ),
    error ? React.createElement("div", { className: "card error" }, `Decision Layer error: ${error}`) : null,
    !data && !error ? React.createElement("div", { className: "empty-state" }, "No Decision Layer data. Pipeline must be running with E3D API connected.") : null,
    data ? React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "div",
        { className: "performance-grid" },
        React.createElement("div", { className: "performance-stat" },
          React.createElement("span", null, "Open Actions"),
          React.createElement("strong", null, String(actions?.open_total ?? "—")),
          React.createElement("small", null, typeKeys.length ? typeKeys.map(k => `${k.replace(/_signal$/, "")}: ${byType[k]}`).join("  ") : "no breakdown")
        ),
        React.createElement("div", { className: "performance-stat" },
          React.createElement("span", null, "30d Confirmation Rate"),
          React.createElement("strong", null, actions?.confirmation_rate_30d != null ? `${(actions.confirmation_rate_30d * 100).toFixed(1)}%` : "—"),
          React.createElement("small", null, outcomes?.confirmation_rate_by_type ? "by-type data available" : "outcomes summary")
        ),
        React.createElement("div", { className: "performance-stat" },
          React.createElement("span", null, "30d Mean Q_O"),
          React.createElement("strong", null, actions?.mean_outcome_score_30d != null ? `+${actions.mean_outcome_score_30d.toFixed(2)}` : "—"),
          React.createElement("small", null, `Evaluated: ${actions?.evaluated_30d ?? "—"}`)
        )
      )
    ) : null
  );
}

function App() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [page, setPage] = useState(getPageFromHash());
  const [pipelineStatus, setPipelineStatus] = useState(null);
  const [intervalSeconds, setIntervalSeconds] = useState(21600);
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
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState(null);
  const [expandedReportId, setExpandedReportId] = useState(null);
  const [reportDetails, setReportDetails] = useState({});
  const [reportDetailLoading, setReportDetailLoading] = useState(null);
  const [reportDetailError, setReportDetailError] = useState(null);
  const [performance, setPerformance] = useState(null);
  const [performanceError, setPerformanceError] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [readinessError, setReadinessError] = useState(null);
  const [operations, setOperations] = useState(null);
  const [operationsError, setOperationsError] = useState(null);
  const [professional, setProfessional] = useState(null);
  const [professionalError, setProfessionalError] = useState(null);
  const [auditStatus, setAuditStatus] = useState(null);
  const [auditError, setAuditError] = useState(null);
  const [decisionLayerSummary, setDecisionLayerSummary] = useState(null);
  const [decisionLayerError, setDecisionLayerError] = useState(null);

  async function loadDecisionLayerSummary() {
    try {
      setDecisionLayerError(null);
      const res = await fetch("/api/e3d/decision-layer/summary");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setDecisionLayerSummary(data);
    } catch (err) {
      setDecisionLayerError(err.message);
    }
  }

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

  async function loadReports() {
    try {
      setReportsLoading(true);
      setReportsError(null);
      const res = await fetch("/api/reports");
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setReports(Array.isArray(data) ? data : []);
    } catch (err) {
      setReportsError(err.message);
    } finally {
      setReportsLoading(false);
    }
  }

  async function loadReportDetail(reportId) {
    if (!reportId || reportDetails[reportId]) return;
    try {
      setReportDetailLoading(reportId);
      setReportDetailError(null);
      const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setReportDetails((prev) => ({ ...prev, [reportId]: data }));
    } catch (err) {
      setReportDetailError(err.message);
    } finally {
      setReportDetailLoading(null);
    }
  }

  async function loadPerformance() {
    try {
      setPerformanceError(null);
      const res = await fetch("/api/performance/latest");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setPerformance(data);
    } catch (err) {
      setPerformanceError(err.message);
    }
  }

  async function loadReadiness() {
    try {
      setReadinessError(null);
      const res = await fetch("/api/retraining/readiness");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setReadiness(data);
    } catch (err) {
      setReadinessError(err.message);
    }
  }

  async function loadOperations() {
    try {
      setOperationsError(null);
      const res = await fetch("/api/operations/latest");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setOperations(data);
    } catch (err) {
      setOperationsError(err.message);
    }
  }

  async function loadProfessional() {
    try {
      setProfessionalError(null);
      const res = await fetch("/api/professional/summary");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setProfessional(data);
    } catch (err) {
      setProfessionalError(err.message);
    }
  }

  async function loadAuditStatus() {
    try {
      setAuditError(null);
      const res = await fetch("/api/audit/status?action_type=mode_change_request&mode=paper&role=viewer");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      setAuditStatus(data);
    } catch (err) {
      setAuditError(err.message);
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
      const res = await fetch("/api/reset-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "dashboard reset all request" })
      });
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
        body: JSON.stringify({ interval_seconds: Number(intervalSeconds) || 300, reason: "dashboard start agents request" })
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
      const res = await fetch("/api/pipeline/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "dashboard stop agents request" })
      });
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
    loadPerformance();
    loadReadiness();
    loadOperations();
    loadProfessional();
    loadAuditStatus();
    loadDecisionLayerSummary();
    const id = setInterval(() => {
      loadPerformance();
      loadReadiness();
      loadOperations();
      loadProfessional();
      loadAuditStatus();
      loadDecisionLayerSummary();
    }, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (page === "reports") {
      loadReports();
    }
  }, [page]);

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
  const auditPolicy = auditStatus?.permission_policy || null;
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

  const performancePanel = React.createElement(
    "div",
    { className: "card panel performance-panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "Daily Performance"),
      React.createElement("span", { className: "panel-note" }, performance?.generated_at ? `Updated ${prettyAgo(performance.generated_at)}` : "Run npm run performance:daily")
    ),
    performanceError ? React.createElement("div", { className: "card error" }, performanceError) : null,
    performance ? React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "div",
        { className: "performance-grid" },
        React.createElement("div", { className: "performance-stat" },
          React.createElement("span", null, "Win rate"),
          React.createElement("strong", null, `${fmtNum.format(Number(performance.win_rate || 0))}%`),
          React.createElement("small", null, `${performance.trade_count || 0} closed trades`)
        ),
        React.createElement("div", { className: cls("performance-stat", Number(performance.realized_pnl_usd || 0) >= 0 ? "is-positive" : "is-negative") },
          React.createElement("span", null, "Realized PnL"),
          React.createElement("strong", null, fmtUsd.format(Number(performance.realized_pnl_usd || 0))),
          React.createElement("small", null, "24h window")
        ),
        React.createElement("div", { className: "performance-stat" },
          React.createElement("span", null, "Profit factor"),
          React.createElement("strong", null, performance.profit_factor == null ? "n/a" : fmtNum.format(Number(performance.profit_factor || 0))),
          React.createElement("small", null, `Retraining ${performance.retraining_recommendation || "hold"}`)
        )
      ),
      React.createElement(
        "div",
        { className: "performance-losses" },
        React.createElement("div", { className: "performance-losses-title" }, "Top loss reasons"),
        performance.top_loss_reasons?.length
          ? performance.top_loss_reasons.map((item) => React.createElement(
              "div",
              { className: "performance-loss-row", key: item.key },
              React.createElement("span", null, String(item.key || "unknown").replace(/_/g, " ")),
              React.createElement("strong", null, fmtUsd.format(Number(item.realized_pnl_usd || 0)))
            ))
          : React.createElement("div", { className: "empty-state" }, "No 24h loss reasons in the latest scorecard.")
      )
    ) : React.createElement("div", { className: "empty-state" }, "No daily performance scorecard has been generated yet.")
  );

  const readinessPanel = React.createElement(
    "div",
    { className: "card panel readiness-panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "Retraining Readiness"),
      React.createElement("span", { className: "panel-note" }, readiness?.generated_at ? `Updated ${prettyAgo(readiness.generated_at)}` : "Run npm run retraining:readiness")
    ),
    readinessError ? React.createElement("div", { className: "card error" }, readinessError) : null,
    readiness ? React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "div",
        { className: "readiness-grid" },
        React.createElement("div", { className: cls("readiness-status", readiness.eligible ? "is-positive" : "is-hold") },
          React.createElement("span", null, "Status"),
          React.createElement("strong", null, readiness.eligible ? "Eligible" : "Hold"),
          React.createElement("small", null, readiness.recommendation || "hold")
        ),
        React.createElement("div", { className: "readiness-status" },
          React.createElement("span", null, "Reviews"),
          React.createElement("strong", null, String(readiness.new_review_count || 0)),
          React.createElement("small", null, `${readiness.positive_examples || 0} positive / ${readiness.negative_examples || 0} negative`)
        ),
        React.createElement("div", { className: "readiness-status" },
          React.createElement("span", null, "Reason"),
          React.createElement("strong", null, String(readiness.reason || "unknown").replace(/_/g, " ")),
          React.createElement("small", null, `${readiness.neutral_examples || 0} neutral`)
        )
      ),
      React.createElement(
        "div",
        { className: "readiness-list" },
        (readiness.blockers?.length ? readiness.blockers : readiness.eligibility_reasons || []).slice(0, 4).map((item) => React.createElement("div", { className: "readiness-row", key: item }, String(item).replace(/_/g, " ")))
      )
    ) : React.createElement("div", { className: "empty-state" }, "No retraining readiness report has been generated yet.")
  );

  const operationsPanel = React.createElement(
    "div",
    { className: "card panel operations-panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "Policy + Signals"),
      React.createElement("span", { className: "panel-note" }, operations?.generated_at ? `Updated ${prettyAgo(operations.generated_at)}` : "Waiting for next cycle")
    ),
    operationsError ? React.createElement("div", { className: "card error" }, operationsError) : null,
    React.createElement(
      "div",
      { className: "operations-grid" },
      React.createElement("div", { className: "operations-box" },
        React.createElement("span", null, "Regime policy"),
        React.createElement("strong", null, operations?.regime_policy?.regime || "unknown"),
        React.createElement("small", null, (operations?.regime_policy?.reason_codes || []).slice(0, 2).join(", ") || "no policy event yet")
      ),
      React.createElement("div", { className: "operations-box" },
        React.createElement("span", null, "Sizing"),
        React.createElement("strong", null, operations?.latest_sizing_decision?.symbol || "none"),
        React.createElement("small", null, operations?.latest_sizing_decision ? `${fmtUsd.format(Number(operations.latest_sizing_decision.max_allocation_usd || 0))} max` : "no sizing event yet")
      ),
      React.createElement("div", { className: "operations-box" },
        React.createElement("span", null, "Signals"),
        React.createElement("strong", null, String(operations?.latest_signal_snapshot?.signals?.length || 0)),
        React.createElement("small", null, "normalized signal snapshots")
      ),
      React.createElement("div", { className: "operations-box" },
        React.createElement("span", null, "Arbitrage"),
        React.createElement("strong", null, operations?.latest_arbitrage_signal?.feasibility || "watch only"),
        React.createElement("small", null, operations?.latest_arbitrage_signal ? `${operations.latest_arbitrage_signal.net_edge_pct}% net edge` : "no live execution")
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
    React.createElement(ProfessionalDashboardPanel, { professional, error: professionalError }),
    performancePanel,
    operationsPanel,
    React.createElement(DecisionLayerPanel, { data: decisionLayerSummary, error: decisionLayerError }),
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
    readinessPanel,
    historyPanel
  );

  const activityPage = React.createElement(
    React.Fragment,
    null,
    React.createElement(NetworkDebugFeed, null),
    React.createElement(AgentActivityPage, null),
    activityTrailPanel
  );

  const renderReportFlag = (flag, index) => React.createElement(
    "div",
    { className: cls("report-flag", flag.severity), key: `${flag.code}-${index}` },
    React.createElement("span", { className: "report-flag-severity" }, flag.severity === "critical" ? "!" : flag.severity === "warning" ? "⚠" : "i"),
    React.createElement("div", null,
      React.createElement("div", { className: "report-flag-code" }, flag.code),
      React.createElement("div", { className: "report-flag-message" }, flag.message)
    )
  );

  const reportsPage = React.createElement(
    "div",
    { className: "card panel reports-panel" },
    React.createElement(
      "div",
      { className: "panel-head" },
      React.createElement("h2", null, "Reports"),
      React.createElement("span", { className: "panel-note" }, "Deterministic manager reports for completed cycles")
    ),
    reportsError ? React.createElement("div", { className: "card error" }, reportsError) : null,
    reportsLoading && reports.length === 0 ? React.createElement("div", { className: "empty-state" }, "Loading reports…") : null,
    !reportsLoading && reports.length === 0 ? React.createElement("div", { className: "empty-state" }, "No reports have been written yet.") : null,
    React.createElement(
      "div",
      { className: "reports-list" },
      reports.map((report) => {
        const isExpanded = expandedReportId === report.report_id;
        const detail = reportDetails[report.report_id] || null;
        const rowScoutVisibility = report?.dashboard_visibility?.scout || {};
        const rowHarvestVisibility = report?.dashboard_visibility?.harvest || {};
        const toggle = async () => {
          const nextExpanded = isExpanded ? null : report.report_id;
          setExpandedReportId(nextExpanded);
          if (nextExpanded) await loadReportDetail(report.report_id);
        };
        return React.createElement(
          "div",
          { className: cls("report-row", isExpanded && "is-expanded"), key: report.report_id },
          React.createElement(
            "button",
            { type: "button", className: "report-row-head", onClick: toggle },
            React.createElement("div", { className: "report-row-main" },
              React.createElement("span", { className: badgeForGrade(report.overall_grade) }, report.overall_grade || "F"),
              React.createElement("strong", null, `Cycle #${report.cycle_index ?? "—"}`),
              React.createElement("span", null, prettyDateTime(report.generated_at)),
              React.createElement("span", { className: badgeForRegime(report.market_regime) }, String(report.market_regime || "unknown").replace(/_/g, " ")),
              React.createElement("span", null, `${report.warning_flags || 0} warnings`),
              React.createElement("span", null, `${report.cycle_duration_seconds ?? "—"}s`),
              rowScoutVisibility.latest_token_usage != null ? React.createElement("span", null, `Scout ${formatTokenUsage(rowScoutVisibility.latest_token_usage)} tok`) : null,
              rowHarvestVisibility.latest_token_usage != null ? React.createElement("span", null, `Harvest ${formatTokenUsage(rowHarvestVisibility.latest_token_usage)} tok`) : null,
              rowScoutVisibility.shortlist_candidate_count != null ? React.createElement("span", null, `Shortlist ${formatCount(rowScoutVisibility.shortlist_candidate_count)}`) : null
            ),
            React.createElement("span", { className: "report-row-action" }, isExpanded ? "▼" : "▶")
          ),
          isExpanded ? React.createElement(
            "div",
            { className: "report-row-body" },
            reportDetailLoading === report.report_id ? React.createElement("div", { className: "empty-state" }, "Loading report details…") : null,
            reportDetailError ? React.createElement("div", { className: "card error" }, reportDetailError) : null,
            detail ? React.createElement(
              React.Fragment,
              null,
              (() => {
                const visibility = detail?.dashboard_visibility || {};
                const scoutVisibility = visibility?.scout || {};
                const harvestVisibility = visibility?.harvest || {};
                const candidateVisibility = detail?.candidate_visibility || {};
                const scoutCandidateVisibility = candidateVisibility?.scout || {};
                const harvestCandidateVisibility = candidateVisibility?.harvest || {};
                return React.createElement(
                  React.Fragment,
                  null,
              React.createElement(
                "div",
                { className: "report-detail-head" },
                React.createElement("div", null,
                  React.createElement("div", { className: "report-detail-title" }, `Cycle #${detail.cycle_index ?? report.cycle_index ?? "—"} — ${prettyDateTime(detail.generated_at || report.generated_at)}`),
                  React.createElement("div", { className: "report-detail-summary" }, detail.summary || report.summary || ""),
                  React.createElement("div", { className: "report-detail-meta" }, `${detail.overall_grade || report.overall_grade} (${detail.overall_score ?? report.overall_score})`)
                )
              ),
              React.createElement(
                "div",
                { className: "report-detail-section" },
                React.createElement("div", { className: "report-detail-section-title" }, "Evidence + Token Budget"),
                React.createElement(
                  "div",
                  { className: "report-compact-grid" },
                  React.createElement("div", { className: "report-compact-stat" },
                    React.createElement("span", null, "Scout tokens"),
                    React.createElement("strong", null, formatTokenUsage(scoutVisibility.latest_token_usage ?? detail?.agents?.scout?.llm_tokens))
                  ),
                  React.createElement("div", { className: "report-compact-stat" },
                    React.createElement("span", null, "Harvest tokens"),
                    React.createElement("strong", null, formatTokenUsage(harvestVisibility.latest_token_usage ?? detail?.agents?.harvest?.llm_tokens))
                  ),
                  React.createElement("div", { className: "report-compact-stat" },
                    React.createElement("span", null, "Scout shortlist"),
                    React.createElement("strong", null, formatCount(scoutVisibility.shortlist_candidate_count ?? detail?.evidence_summary?.scout?.shortlist_candidate_count))
                  ),
                  React.createElement("div", { className: "report-compact-stat" },
                    React.createElement("span", null, "Evidence qualified"),
                    React.createElement("strong", null, formatCount(scoutVisibility.evidence_qualified_count ?? detail?.evidence_summary?.scout?.evidence_qualified_candidates))
                  ),
                  React.createElement("div", { className: "report-compact-stat" },
                    React.createElement("span", null, "Evidence blocked"),
                    React.createElement("strong", null, formatCount(scoutVisibility.evidence_blocked_count ?? detail?.evidence_summary?.scout?.evidence_blocked_candidates))
                  ),
                  React.createElement("div", { className: "report-compact-stat" },
                    React.createElement("span", null, "Weak Scout downgraded"),
                    React.createElement("strong", null, formatCount(scoutVisibility.downgraded_weak_candidates ?? detail?.evidence_summary?.scout?.weak_candidate_downgrade_count))
                  ),
                  React.createElement("div", { className: "report-compact-stat" },
                    React.createElement("span", null, "Weak Harvest downgraded"),
                    React.createElement("strong", null, formatCount(harvestVisibility.downgraded_weak_exits ?? detail?.evidence_summary?.harvest?.weak_exit_downgrade_count ?? detail?.evidence_summary?.harvest?.evidence_downgrade_count))
                  )
                )
              ),
              React.createElement(
                "div",
                { className: "report-detail-section" },
                React.createElement("div", { className: "report-detail-section-title" }, "Flags"),
                Array.isArray(detail.flags) && detail.flags.length
                  ? React.createElement("div", { className: "report-flag-list" }, detail.flags.map(renderReportFlag))
                  : React.createElement("div", { className: "intelligence-empty" }, "No flags recorded.")
              ),
              React.createElement(
                "div",
                { className: "report-detail-section" },
                React.createElement("div", { className: "report-detail-section-title" }, "Agents"),
                React.createElement("div", { className: "report-agent-grid" },
                  ["scout", "harvest", "risk", "executor", "sizer", "pipeline"].map((agent) => {
                    const item = detail.agents?.[agent] || {};
                    const notes = agent === "scout"
                      ? `${item.coverage_pct != null ? `${Math.round(Number(item.coverage_pct) * 100)}% coverage` : ""}${item.candidates_proposed != null ? ` · ${item.candidates_proposed} candidates` : ""}`
                      : agent === "harvest"
                        ? `${item.positions_reviewed ?? 0}/${item.positions_held ?? 0} positions reviewed`
                        : agent === "risk"
                          ? `${item.approved ?? 0} approved / ${item.rejected ?? 0} rejected`
                          : agent === "executor"
                            ? `${item.paper_trades_recorded ?? 0} paper trades recorded`
                            : agent === "sizer"
                              ? `${item.decisions_made ?? 0} decisions / ${item.blocked_by_guardrails ?? 0} blocked`
                              : `${item.cycle_duration_seconds ?? detail.cycle_duration_seconds ?? 0}s cycle`;
                    return React.createElement(
                      "div",
                      { className: "report-agent-row", key: agent },
                      React.createElement("span", { className: "report-agent-name" }, agent.charAt(0).toUpperCase() + agent.slice(1)),
                      React.createElement("span", { className: badgeForGrade(item.grade) }, item.grade || "—"),
                      React.createElement("strong", null, item.score != null ? String(item.score) : "—"),
                      React.createElement("span", { className: "report-agent-notes" }, notes || "")
                    );
                  })
                )
              ),
              React.createElement(
                "div",
                { className: "report-detail-section report-detail-grid" },
                React.createElement(
                  "div",
                  null,
                  React.createElement("div", { className: "report-detail-section-title" }, "Portfolio Snapshot"),
                  React.createElement("div", { className: "report-kv" }, `Equity ${fmtUsd.format(Number(detail.portfolio_snapshot?.equity_usd || 0))}`),
                  React.createElement("div", { className: "report-kv" }, `Cash ${fmtUsd.format(Number(detail.portfolio_snapshot?.cash_usd || 0))}`),
                  React.createElement("div", { className: "report-kv" }, `${detail.portfolio_snapshot?.position_count ?? 0} positions`),
                  React.createElement("div", { className: "report-kv" }, `Unrealized PnL ${fmtUsd.format(Number(detail.portfolio_snapshot?.unrealized_pnl_usd || 0))}`),
                  React.createElement("div", { className: "report-kv" }, `Max Drawdown ${fmtNum.format(Number(detail.portfolio_snapshot?.max_drawdown_pct || 0) * 100)}%`)
                ),
                React.createElement(
                  "div",
                  null,
                  React.createElement("div", { className: "report-detail-section-title" }, "Cycle Actions"),
                  React.createElement("div", { className: "report-kv" }, `Buys: ${Array.isArray(detail.cycle_actions?.buys) && detail.cycle_actions.buys.length ? detail.cycle_actions.buys.map((item) => item.symbol).filter(Boolean).join(", ") : "none"}`),
                  React.createElement("div", { className: "report-kv" }, `Sells: ${Array.isArray(detail.cycle_actions?.sells) && detail.cycle_actions.sells.length ? detail.cycle_actions.sells.map((item) => item.symbol).filter(Boolean).join(", ") : "none"}`),
                  React.createElement("div", { className: "report-kv" }, `Rotations: ${Array.isArray(detail.cycle_actions?.rotations) && detail.cycle_actions.rotations.length ? detail.cycle_actions.rotations.map((item) => item.from_symbol || item.to_symbol).filter(Boolean).join(", ") : "none"}`)
                )
              )
              ,
              React.createElement(
                "div",
                { className: "report-detail-section report-detail-grid" },
                React.createElement(
                  "div",
                  null,
                  React.createElement("div", { className: "report-detail-section-title" }, "Scout Candidate Visibility"),
                  React.createElement("div", { className: "report-subsection-label" }, "Qualified"),
                  Array.isArray(scoutCandidateVisibility.qualified) && scoutCandidateVisibility.qualified.length
                    ? React.createElement("div", { className: "report-candidate-list" }, scoutCandidateVisibility.qualified.slice(0, 6).map((item, index) => renderReportCandidateCard(item, `scout-qualified-${index}`)))
                    : React.createElement("div", { className: "intelligence-empty" }, "No qualified Scout candidates recorded."),
                  React.createElement("div", { className: "report-subsection-label" }, "Blocked"),
                  Array.isArray(scoutCandidateVisibility.blocked) && scoutCandidateVisibility.blocked.length
                    ? React.createElement("div", { className: "report-candidate-list" }, scoutCandidateVisibility.blocked.slice(0, 6).map((item, index) => renderReportCandidateCard(item, `scout-blocked-${index}`)))
                    : React.createElement("div", { className: "intelligence-empty" }, "No evidence-blocked Scout candidates recorded."),
                  React.createElement("div", { className: "report-subsection-label" }, "Downgraded"),
                  Array.isArray(scoutCandidateVisibility.downgraded) && scoutCandidateVisibility.downgraded.length
                    ? React.createElement("div", { className: "report-candidate-list" }, scoutCandidateVisibility.downgraded.slice(0, 6).map((item, index) => renderReportCandidateCard(item, `scout-downgraded-${index}`)))
                    : React.createElement("div", { className: "intelligence-empty" }, "No Scout evidence downgrades recorded.")
                ),
                React.createElement(
                  "div",
                  null,
                  React.createElement("div", { className: "report-detail-section-title" }, "Harvest Candidate Visibility"),
                  React.createElement("div", { className: "report-subsection-label" }, "Exit-ready"),
                  Array.isArray(harvestCandidateVisibility.exit_candidates) && harvestCandidateVisibility.exit_candidates.length
                    ? React.createElement("div", { className: "report-candidate-list" }, harvestCandidateVisibility.exit_candidates.slice(0, 6).map((item, index) => renderReportCandidateCard(item, `harvest-exit-${index}`)))
                    : React.createElement("div", { className: "intelligence-empty" }, "No Harvest exit candidates recorded."),
                  React.createElement("div", { className: "report-subsection-label" }, "Downgraded"),
                  Array.isArray(harvestCandidateVisibility.downgraded) && harvestCandidateVisibility.downgraded.length
                    ? React.createElement("div", { className: "report-candidate-list" }, harvestCandidateVisibility.downgraded.slice(0, 6).map((item, index) => renderReportCandidateCard(item, `harvest-downgraded-${index}`)))
                    : React.createElement("div", { className: "intelligence-empty" }, "No Harvest evidence downgrades recorded.")
                )
              )
                );
              })()
            ) : null
          ) : null
        );
      })
    )
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
        React.createElement("div", { className: "pipeline-controls-note" }, "Starts the swing-hold desk. Default interval is 6 hours (21600s). Do not set this back to 300 unless you want the scalper back."),
        pipelineMessage ? React.createElement("div", { className: "pipeline-controls-message" }, pipelineMessage) : null,
        pipelineError ? React.createElement("div", { className: "pipeline-controls-error" }, pipelineError) : null,
        pipelineStatus?.pid ? React.createElement("div", { className: "pipeline-controls-meta" }, `PID ${pipelineStatus.pid}`) : null
      )
    ),
    React.createElement(
      "section",
      { className: "card audit-strip" },
      React.createElement(
        "div",
        { className: "audit-strip-head" },
        React.createElement("span", { className: "pipeline-controls-title" }, "Audit + Permissions"),
        React.createElement("span", { className: auditPolicy?.decision === "allow" ? "badge badge-green" : "badge badge-red" }, auditPolicy?.decision || "unknown")
      ),
      React.createElement(
        "div",
        { className: "audit-strip-grid" },
        React.createElement("div", { className: "audit-strip-item" },
          React.createElement("span", null, "Current mode"),
          React.createElement("strong", null, auditStatus?.current_mode || pipelineStatus?.mode || "stopped")
        ),
        React.createElement("div", { className: "audit-strip-item" },
          React.createElement("span", null, "Local role"),
          React.createElement("strong", null, auditPolicy?.operator?.role || "viewer")
        ),
        React.createElement("div", { className: "audit-strip-item" },
          React.createElement("span", null, "Live submission"),
          React.createElement("strong", null, auditPolicy?.live_submission_enabled ? "enabled" : "disabled")
        ),
        React.createElement("div", { className: "audit-strip-item" },
          React.createElement("span", null, "Recent actions"),
          React.createElement("strong", null, String(auditStatus?.recent_operator_actions?.length || 0))
        )
      ),
      auditPolicy?.blockers?.length
        ? React.createElement("div", { className: "pipeline-controls-error" }, `Blocked: ${auditPolicy.blockers.slice(0, 4).join(", ")}`)
        : React.createElement("div", { className: "pipeline-controls-note" }, "Local operator records are enabled for paper, shadow, reports, resets, and promotion decisions."),
      auditError ? React.createElement("div", { className: "pipeline-controls-error" }, auditError) : null
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
    reports: "Reports",
    settings: "Settings",
    orbit: "Orbit + wallet",
    activity: "Agent Activity",
    ledger: "Run Ledger"
  };
  const pageNoteMap = {
    portfolio: "Open positions with entry, current value, and delta",
    opportunities: "High-conviction opportunities and the weakest current positions",
    history: "Sold positions with entry, exit, and realized PnL",
    reports: "Cycle-by-cycle manager reports with flags and agent grades",
    settings: "Manage e3d.ai login, API key access, and pipeline controls",
    orbit: "Agent orbit and wallet view",
    activity: "Per-cycle story signals, tokens considered, and risk decisions",
    ledger: "Per-cycle record: signals detected, candidates scored, decisions made"
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
      : page === "reports"
        ? reportsPage
      : page === "settings"
        ? settingsPage
        : page === "orbit"
          ? orbitPage
          : page === "activity"
            ? activityPage
            : page === "ledger"
              ? React.createElement(LedgerView, null)
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
          React.createElement("button", { className: cls("button", page === "orbit" && "button-active"), onClick: () => goToPage("orbit") }, "Orbit"),
          React.createElement("button", { className: cls("button", page === "activity" && "button-active"), onClick: () => goToPage("activity") }, "Activity"),
          React.createElement("button", { className: cls("button", page === "reports" && "button-active"), onClick: () => goToPage("reports") }, "Reports"),
          React.createElement("button", { className: cls("button", page === "settings" && "button-active"), onClick: () => goToPage("settings") }, "Settings"),
          React.createElement("button", { className: cls("button", page === "ledger" && "button-active"), onClick: () => goToPage("ledger") }, "Ledger"),
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
