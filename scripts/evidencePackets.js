import crypto from "crypto";

export const EVIDENCE_PACKET_SCHEMA_VERSION = "1.0";
export const EVIDENCE_PACKET_BUILDER_VERSION = "evidence-packets-v1";
export const SCOUT_EVIDENCE_SHORTLIST_DEFAULT_LIMIT = 12;
export const SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT = 0;
export const SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H = 3.5;
export const SCOUT_FLOW_ONLY_MIN_LIQUIDITY_USD = 150000;
export const SCOUT_FLOW_ONLY_MIN_VOLUME_24H_USD = 75000;
export const SCOUT_FLOW_ONLY_MIN_MARKET_CAP_USD = 5000000;

const SOURCE_TYPES = new Set([
  "story",
  "market_data",
  "flow",
  "liquidity",
  "thesis",
  "watchlist",
  "token_risk",
  "data_quality",
  "portfolio",
  "performance",
  "manual"
]);

const DIRECTIONS = new Set(["bullish", "bearish", "neutral", "risk"]);

function toNum(value, fallback = NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanAddress(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text || null;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function clipText(value, limit = 160) {
  const text = cleanText(value);
  if (!text) return null;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function optionalMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function compactUsd(value) {
  const num = toNum(value, NaN);
  if (!Number.isFinite(num)) return null;
  if (Math.abs(num) >= 1e9) return `$${round(num / 1e9, 2)}B`;
  if (Math.abs(num) >= 1e6) return `$${round(num / 1e6, 2)}M`;
  if (Math.abs(num) >= 1e3) return `$${round(num / 1e3, 1)}k`;
  return `$${round(num, 4)}`;
}

function compactPct(value, digits = 1) {
  const num = toNum(value, NaN);
  if (!Number.isFinite(num)) return null;
  const prefix = num > 0 ? "+" : "";
  return `${prefix}${round(num, digits)}%`;
}

function compactNumber(value, digits = 2) {
  const num = toNum(value, NaN);
  if (!Number.isFinite(num)) return null;
  return String(round(num, digits));
}

function normalizeSourceType(value) {
  const text = cleanText(value)?.toLowerCase();
  if (SOURCE_TYPES.has(text)) return text;
  return inferSourceType(value);
}

function normalizeDirection(value, fallback = "neutral") {
  const text = cleanText(value)?.toLowerCase();
  if (DIRECTIONS.has(text)) return text;
  return fallback;
}

function inferSourceType(value) {
  const text = String(
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? JSON.stringify(value)
        : value ?? ""
  ).toLowerCase();

  if (!text) return "manual";
  if (/(honeypot|security[_ ]risk|rug|fraud|token[_ ]risk)/.test(text)) return "token_risk";
  if (/(missing data|stale|data quality|degraded data|quality|confidence)/.test(text)) return "data_quality";
  if (/(watchlist|user_watchlist)/.test(text)) return "watchlist";
  if (/(thesis|conviction|target_|invalidation)/.test(text)) return "thesis";
  if (/(buy_sell_ratio|flow_signal|accumulation|distribution|order flow)/.test(text)) return "flow";
  if (/(liquidity|spread|slippage)/.test(text)) return "liquidity";
  if (/(market cap|volume|current_price|change_24h|change_30m|price)/.test(text)) return "market_data";
  if (/(position|portfolio|pnl|entry|holding age|market value)/.test(text)) return "portfolio";
  if (/(expectancy|profit factor|win rate|performance)/.test(text)) return "performance";
  if (/(story|smart_money|breakout|mover|surge|staging|cluster|funnel|exchange_flow|treasury_distribution|concentration_shift|liquidity_drain)/.test(text)) return "story";
  return "manual";
}

function inferDirection(value, sourceType = "manual") {
  const text = String(
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? JSON.stringify(value)
        : value ?? ""
  ).toLowerCase();

  if (/(security[_ ]risk|honeypot|rug|fraud|stale|missing data|degraded|blocker|warning|risk)/.test(text)) return "risk";
  if (/(distribution|drain|widening|decline|declining|exit|trim|sell|bearish|down|invalidat)/.test(text)) return "bearish";
  if (/(accumulation|breakout|watchlist|thesis|bullish|support|smart_money|positive|uptrend|convergence)/.test(text)) return "bullish";
  if (sourceType === "token_risk" || sourceType === "data_quality") return "risk";
  return "neutral";
}

function inferLabel(sourceType, summary) {
  const text = cleanText(summary)?.toLowerCase() || "";
  if (sourceType === "story") {
    if (text.includes("breakout")) return "story_breakout";
    if (text.includes("accumulation")) return "story_accumulation";
    if (text.includes("treasury_distribution")) return "story_treasury_distribution";
    return "story_signal";
  }
  if (sourceType === "flow") return text.includes("distribution") ? "flow_distribution" : "flow_signal";
  if (sourceType === "liquidity") return "liquidity_snapshot";
  if (sourceType === "market_data") return "market_snapshot";
  if (sourceType === "thesis") return "thesis_support";
  if (sourceType === "watchlist") return "watchlist_context";
  if (sourceType === "token_risk") return "token_risk_scan";
  if (sourceType === "data_quality") return "data_quality_scan";
  if (sourceType === "portfolio") return "portfolio_context";
  if (sourceType === "performance") return "performance_context";
  return "manual_note";
}

function inferStrength(value, sourceType = "manual", direction = "neutral") {
  const explicit = toNum(value?.strength, NaN);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, Math.round(explicit)));

  const numericHints = [
    value?.conviction,
    value?.conviction_score,
    value?.confidence,
    value?.confidence_score,
    value?.score,
    value?.quality_score,
    value?.cohort_quality_score,
    value?.thesis_strength,
    value?.risk_score,
    value?.fraud_risk
  ].map((candidate) => toNum(candidate, NaN)).filter(Number.isFinite);
  if (numericHints.length) return Math.max(0, Math.min(100, Math.round(numericHints[0])));

  const text = String(
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? JSON.stringify(value)
        : value ?? ""
  );
  const pctMatch = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) {
    return Math.max(0, Math.min(100, Math.round(Math.abs(Number(pctMatch[1])))));
  }

  const defaults = {
    story: direction === "bearish" ? 65 : 68,
    market_data: 58,
    flow: direction === "bearish" ? 70 : 72,
    liquidity: 62,
    thesis: 70,
    watchlist: 48,
    token_risk: 88,
    data_quality: 84,
    portfolio: 64,
    performance: 55,
    manual: 50
  };
  return defaults[sourceType] ?? 50;
}

function inferFreshnessSeconds(ts, createdAt) {
  const tsMs = optionalMs(ts);
  const createdMs = optionalMs(createdAt);
  if (tsMs == null || createdMs == null) return null;
  return Math.max(0, Math.round((createdMs - tsMs) / 1000));
}

function normalizeFreshnessSeconds(value, ts, createdAt) {
  const direct = toNum(value, NaN);
  if (Number.isFinite(direct)) return Math.max(0, Math.round(direct));
  return inferFreshnessSeconds(ts, createdAt);
}

function sourceRefFromValue(value) {
  if (!value || typeof value !== "object") return null;
  return cleanText(
    value.source_ref
    || value.story_id
    || value.id
    || value.ref
    || value.thesis_id
    || value.candidate_id
    || value.watchlist_id
    || value.data_quality_id
    || value.token_risk_scan_id
    || value.position_id
    || value.performance_id
  );
}

function buildEvidenceId(packetBasis, evidence) {
  const digest = sha256(stableStringify({
    packet_type: packetBasis.packet_type,
    symbol: packetBasis.symbol,
    contract_address: packetBasis.contract_address,
    evidence
  }));
  return `evi_${digest.slice(0, 24)}`;
}

function normalizeEvidenceItem(item, packetBasis) {
  if (item == null) return null;
  const sourceType = normalizeSourceType(item?.source_type || item);
  const summary = clipText(
    typeof item === "string"
      ? item
      : item.summary || item.text || item.note || item.reason || item.description || item.label
  );
  if (!summary) return null;
  const direction = normalizeDirection(item?.direction, inferDirection(item, sourceType));
  const evidence = {
    source_type: sourceType,
    source_ref: sourceRefFromValue(item),
    label: cleanText(item?.label) || inferLabel(sourceType, summary),
    direction,
    strength: inferStrength(item, sourceType, direction),
    freshness_seconds: normalizeFreshnessSeconds(item?.freshness_seconds, item?.timestamp || item?.ts || item?.created_at || item?.updated_at, packetBasis.created_at),
    summary
  };
  return {
    evidence_id: buildEvidenceId(packetBasis, evidence),
    ...evidence
  };
}

function pushEvidence(target, item) {
  const normalized = item && typeof item === "object" ? { ...item } : item;
  target.push(normalized);
}

function buildMarketEvidence(input = {}, packetType) {
  const evidence = [];
  const marketData = input?.market_data && typeof input.market_data === "object" ? input.market_data : {};
  const price = toNum(
    marketData.current_price,
    toNum(marketData.price_usd, toNum(input.current_price, NaN))
  );
  const change24h = toNum(marketData.change_24h_pct, toNum(input.change_24h_pct, NaN));
  const change30m = toNum(marketData.change_30m_pct, toNum(input.change_30m_pct, NaN));
  const volume24h = toNum(marketData.volume_24h_usd, toNum(input.volume_24h_usd, NaN));
  const marketCap = toNum(marketData.market_cap_usd, toNum(input.market_cap_usd, NaN));
  const parts = [];
  if (Number.isFinite(price)) parts.push(`px ${compactUsd(price)}`);
  if (Number.isFinite(change30m)) parts.push(`30m ${compactPct(change30m)}`);
  if (Number.isFinite(change24h)) parts.push(`24h ${compactPct(change24h)}`);
  if (Number.isFinite(volume24h)) parts.push(`vol24 ${compactUsd(volume24h)}`);
  if (Number.isFinite(marketCap)) parts.push(`mcap ${compactUsd(marketCap)}`);
  if (parts.length) {
    pushEvidence(evidence, {
      source_type: "market_data",
      source_ref: cleanText(marketData.price_source),
      label: "market_snapshot",
      direction: Number.isFinite(change24h) ? (change24h >= 0 ? "bullish" : "bearish") : "neutral",
      strength: Math.min(100, Math.max(20, Math.round(Math.abs(Number.isFinite(change24h) ? change24h : 0) * 3) + 45)),
      freshness_seconds: normalizeFreshnessSeconds(null, marketData.price_timestamp || input.price_timestamp, input.created_at),
      summary: parts.join(", ")
    });
  }

  const flow = input?._dex_flow && typeof input._dex_flow === "object"
    ? input._dex_flow
    : input?.flow && typeof input.flow === "object"
      ? input.flow
      : null;
  const flowSignal = cleanText(flow?.flow_signal || input.flow_signal);
  const ratio = toNum(flow?.buy_sell_ratio_1h, toNum(input.buy_sell_ratio_1h, NaN));
  if (flowSignal || Number.isFinite(ratio)) {
    pushEvidence(evidence, {
      source_type: "flow",
      source_ref: cleanText(flow?.source || flow?.quote_source || "flow"),
      label: flowSignal && flowSignal.toLowerCase().includes("distribution") ? "flow_distribution" : "flow_signal",
      direction: flowSignal && flowSignal.toLowerCase().includes("distribution") ? "bearish" : flowSignal ? "bullish" : "neutral",
      strength: flowSignal && flowSignal.toLowerCase().includes("strong_") ? 82 : 68,
      freshness_seconds: normalizeFreshnessSeconds(null, flow?.timestamp || flow?.ts || input.flow_timestamp, input.created_at),
      summary: [
        flowSignal ? `flow ${flowSignal}` : null,
        Number.isFinite(ratio) ? `b/s 1h ${compactNumber(ratio, 2)}` : null,
        Number.isFinite(toNum(flow?.price_change_1h_pct, NaN)) ? `1h ${compactPct(flow.price_change_1h_pct)}` : null
      ].filter(Boolean).join(", ")
    });
  }

  const liquidityData = input?.liquidity_data && typeof input.liquidity_data === "object" ? input.liquidity_data : {};
  const executionData = input?.execution_data && typeof input.execution_data === "object" ? input.execution_data : {};
  const liquidityUsd = toNum(liquidityData.liquidity_usd, toNum(input.liquidity_usd, NaN));
  const spreadBps = toNum(executionData.spread_bps, toNum(input.spread_bps, NaN));
  const slippageBps = toNum(executionData.estimated_slippage_bps, toNum(input.slippage_bps, NaN));
  const liquidityParts = [];
  if (Number.isFinite(liquidityUsd)) liquidityParts.push(`liq ${compactUsd(liquidityUsd)}`);
  if (Number.isFinite(spreadBps)) liquidityParts.push(`spread ${compactNumber(spreadBps, 1)}bps`);
  if (Number.isFinite(slippageBps)) liquidityParts.push(`slip ${compactNumber(slippageBps, 1)}bps`);
  if (liquidityParts.length) {
    pushEvidence(evidence, {
      source_type: "liquidity",
      source_ref: cleanText(liquidityData.liquidity_source || executionData.quote_source),
      label: "liquidity_snapshot",
      direction: packetType === "harvest_position" && Number.isFinite(spreadBps) && spreadBps > 150 ? "bearish" : "neutral",
      strength: Number.isFinite(liquidityUsd) && liquidityUsd >= 200000 ? 72 : Number.isFinite(liquidityUsd) && liquidityUsd > 0 ? 54 : 45,
      freshness_seconds: normalizeFreshnessSeconds(null, liquidityData.liquidity_timestamp || executionData.quote_timestamp || input.liquidity_timestamp, input.created_at),
      summary: liquidityParts.join(", ")
    });
  }

  return evidence;
}

function buildThesisEvidence(input = {}) {
  const evidence = [];
  const thesis = input?.thesis && typeof input.thesis === "object" ? input.thesis : {};
  const conviction = toNum(thesis.conviction, toNum(input.conviction_score, NaN));
  const summaryText = clipText(thesis.summary || input.why_now || input.thesis_summary || input.summary);
  if (Number.isFinite(conviction) || summaryText) {
    pushEvidence(evidence, {
      source_type: "thesis",
      source_ref: cleanText(thesis.thesis_id || input.thesis_id),
      label: "thesis_support",
      direction: normalizeDirection(thesis.direction, "bullish"),
      strength: Number.isFinite(conviction) ? Math.round(conviction) : 64,
      freshness_seconds: normalizeFreshnessSeconds(thesis.freshness_seconds, thesis.updated_at || thesis.created_at, input.created_at),
      summary: clipText([
        Number.isFinite(conviction) ? `conviction ${Math.round(conviction)}` : null,
        summaryText
      ].filter(Boolean).join(", "))
    });
  }
  return evidence;
}

function buildWatchlistEvidence(input = {}) {
  const sourceAgent = cleanText(input.source_agent)?.toLowerCase();
  const watchlist = input?.watchlist && typeof input.watchlist === "object" ? input.watchlist : {};
  if (sourceAgent !== "user_watchlist" && !watchlist.added_at && !watchlist.label && !input.watchlist_id) return [];
  return [{
    source_type: "watchlist",
    source_ref: cleanText(input.watchlist_id || watchlist.watchlist_id),
    label: "watchlist_context",
    direction: "bullish",
    strength: 46,
    freshness_seconds: normalizeFreshnessSeconds(watchlist.freshness_seconds, watchlist.added_at, input.created_at),
    summary: clipText([
      "user watchlist",
      cleanText(watchlist.label)
    ].filter(Boolean).join(", "))
  }];
}

function buildDataQualityEvidence(input = {}) {
  const quality = input?.market_data_quality && typeof input.market_data_quality === "object"
    ? input.market_data_quality
    : input?.market_data_quality_ref && typeof input.market_data_quality_ref === "object"
      ? input.market_data_quality_ref
      : null;
  if (!quality) return [];
  const warnings = Array.isArray(quality.warnings) ? quality.warnings : [];
  const blockers = Array.isArray(quality.blockers) ? quality.blockers : [];
  return [{
    source_type: "data_quality",
    source_ref: cleanText(quality.data_quality_id),
    label: "data_quality_scan",
    direction: "risk",
    strength: Math.max(30, Math.min(100, 100 - Math.round(toNum(quality.normalized?.confidence, quality.confidence ?? 75)) + blockers.length * 10)),
    freshness_seconds: normalizeFreshnessSeconds(null, quality.evaluated_at, input.created_at),
    summary: clipText([
      quality.normalized?.confidence != null || quality.confidence != null ? `confidence ${Math.round(toNum(quality.normalized?.confidence, quality.confidence, 0))}` : null,
      blockers.length ? `blockers ${blockers.join("|")}` : null,
      warnings.length ? `warnings ${warnings.join("|")}` : null,
      quality.degraded_data_mode ? "degraded" : null
    ].filter(Boolean).join(", "))
  }];
}

function buildTokenRiskEvidence(input = {}) {
  const scan = input?.token_risk_scan && typeof input.token_risk_scan === "object"
    ? input.token_risk_scan
    : input?.token_risk_scan_ref && typeof input.token_risk_scan_ref === "object"
      ? input.token_risk_scan_ref
      : null;
  if (!scan) return [];
  const decision = cleanText(scan.decision) || "warn";
  const blockers = Array.isArray(scan.blockers) ? scan.blockers : [];
  const warnings = Array.isArray(scan.warnings) ? scan.warnings : [];
  return [{
    source_type: "token_risk",
    source_ref: cleanText(scan.token_risk_scan_id),
    label: "token_risk_scan",
    direction: "risk",
    strength: decision === "block" ? 95 : warnings.length ? 72 : 55,
    freshness_seconds: normalizeFreshnessSeconds(null, scan.evaluated_at, input.created_at),
    summary: clipText([
      `decision ${decision}`,
      blockers.length ? `blockers ${blockers.join("|")}` : null,
      warnings.length ? `warnings ${warnings.join("|")}` : null
    ].filter(Boolean).join(", "))
  }];
}

function buildPortfolioEvidence(input = {}) {
  const position = input?.position && typeof input.position === "object" ? input.position : input;
  const quantity = toNum(position.quantity, NaN);
  const avgEntry = toNum(position.avg_entry_price, NaN);
  const currentPrice = toNum(position.current_price, NaN);
  const marketValue = toNum(position.market_value_usd, NaN);
  const pnlPct = toNum(position.unrealized_pnl_pct, NaN);
  const holdingAgeHours = toNum(position.holding_age_hours, NaN);
  const parts = [];
  if (Number.isFinite(quantity)) parts.push(`qty ${compactNumber(quantity, 6)}`);
  if (Number.isFinite(avgEntry)) parts.push(`avg ${compactUsd(avgEntry)}`);
  if (Number.isFinite(currentPrice)) parts.push(`px ${compactUsd(currentPrice)}`);
  if (Number.isFinite(marketValue)) parts.push(`mv ${compactUsd(marketValue)}`);
  if (Number.isFinite(pnlPct)) parts.push(`pnl ${compactPct(pnlPct)}`);
  if (Number.isFinite(holdingAgeHours)) parts.push(`age ${compactNumber(holdingAgeHours, 1)}h`);
  if (!parts.length) return [];
  return [{
    source_type: "portfolio",
    source_ref: cleanText(position.position_id || input.position_id),
    label: "portfolio_context",
    direction: Number.isFinite(pnlPct) ? (pnlPct >= 0 ? "bullish" : "bearish") : "neutral",
    strength: Number.isFinite(Math.abs(pnlPct)) ? Math.min(100, 40 + Math.round(Math.abs(pnlPct))) : 56,
    freshness_seconds: normalizeFreshnessSeconds(null, position.updated_at || input.updated_at, input.created_at),
    summary: parts.join(", ")
  }];
}

function buildPerformanceEvidence(input = {}) {
  const performance = input?.performance && typeof input.performance === "object" ? input.performance : null;
  if (!performance) return [];
  const expectancy = toNum(performance.expectancy_usd, NaN);
  const winRate = toNum(performance.win_rate, NaN);
  const parts = [];
  if (Number.isFinite(expectancy)) parts.push(`expectancy ${compactUsd(expectancy)}`);
  if (Number.isFinite(winRate)) parts.push(`win_rate ${compactPct(winRate <= 1 ? winRate * 100 : winRate)}`);
  if (!parts.length) return [];
  return [{
    source_type: "performance",
    source_ref: cleanText(performance.performance_id),
    label: "performance_context",
    direction: Number.isFinite(expectancy) ? (expectancy >= 0 ? "bullish" : "bearish") : "neutral",
    strength: Number.isFinite(winRate) ? Math.max(20, Math.min(100, Math.round(winRate <= 1 ? winRate * 100 : winRate))) : 54,
    freshness_seconds: normalizeFreshnessSeconds(null, performance.evaluated_at, input.created_at),
    summary: parts.join(", ")
  }];
}

function collectBaseEvidence(input, packetBasis) {
  const collected = [];
  for (const item of Array.isArray(input?.evidence_items) ? input.evidence_items : []) pushEvidence(collected, item);
  for (const item of Array.isArray(input?.evidence) ? input.evidence : []) pushEvidence(collected, item);
  for (const item of Array.isArray(input?.stories) ? input.stories : []) pushEvidence(collected, { ...item, source_type: item?.source_type || "story" });
  for (const item of buildMarketEvidence(input, packetBasis.packet_type)) pushEvidence(collected, item);
  for (const item of buildThesisEvidence(input)) pushEvidence(collected, item);
  for (const item of buildWatchlistEvidence(input)) pushEvidence(collected, item);
  for (const item of buildTokenRiskEvidence(input)) pushEvidence(collected, item);
  for (const item of buildDataQualityEvidence(input)) pushEvidence(collected, item);
  if (packetBasis.packet_type === "harvest_position") {
    for (const item of buildPortfolioEvidence(input)) pushEvidence(collected, item);
    for (const item of buildPerformanceEvidence(input)) pushEvidence(collected, item);
  }

  const seen = new Set();
  return collected
    .map((item) => normalizeEvidenceItem(item, packetBasis))
    .filter(Boolean)
    .filter((item) => {
      const key = stableStringify({
        source_type: item.source_type,
        source_ref: item.source_ref,
        label: item.label,
        direction: item.direction,
        strength: item.strength,
        freshness_seconds: item.freshness_seconds,
        summary: item.summary
      });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      String(a.source_type).localeCompare(String(b.source_type))
      || String(a.label).localeCompare(String(b.label))
      || String(a.source_ref || "").localeCompare(String(b.source_ref || ""))
      || String(a.summary).localeCompare(String(b.summary))
    );
}

function buildMissingEvidence(packetType, counts, flags = {}) {
  const missing = [];
  if (counts.market_evidence_count === 0) missing.push("market_context");
  if (packetType === "scout_candidate" && counts.story_evidence_count === 0 && !flags.flow_only) missing.push("story_or_thesis_context");
  if (packetType === "harvest_position" && counts.portfolio_evidence_count === 0) missing.push("portfolio_context");
  if (counts.data_quality_count === 0) missing.push("data_quality_context");
  if (counts.token_risk_count === 0) missing.push("token_risk_context");
  return missing;
}

function scoreEvidencePacket(packetType, evidence, input = {}) {
  const counts = {
    evidence_count: evidence.length,
    bullish_count: evidence.filter((item) => item.direction === "bullish").length,
    bearish_count: evidence.filter((item) => item.direction === "bearish").length,
    risk_count: evidence.filter((item) => item.direction === "risk").length,
    market_evidence_count: evidence.filter((item) => ["market_data", "flow", "liquidity", "data_quality"].includes(item.source_type)).length,
    story_evidence_count: evidence.filter((item) => ["story", "thesis", "watchlist"].includes(item.source_type)).length,
    portfolio_evidence_count: evidence.filter((item) => item.source_type === "portfolio").length,
    data_quality_count: evidence.filter((item) => item.source_type === "data_quality").length,
    token_risk_count: evidence.filter((item) => item.source_type === "token_risk").length
  };

  const blockers = [];
  const warnings = [];
  const flags = {
    flow_only: counts.story_evidence_count === 0 && evidence.some((item) => item.source_type === "flow")
  };

  if (!cleanAddress(input.contract_address || input?.token?.contract_address || input.address)) blockers.push("missing_contract_address");
  if (!cleanText(input.symbol || input?.token?.symbol)) warnings.push("missing_symbol");
  if (counts.evidence_count < 2) blockers.push("under_evidenced");
  else if (counts.evidence_count < 3) warnings.push("thin_evidence");
  if (counts.market_evidence_count === 0) warnings.push("missing_market_evidence");
  if (packetType === "scout_candidate" && counts.story_evidence_count === 0) warnings.push("missing_story_or_thesis_evidence");
  if (packetType === "scout_candidate" && flags.flow_only) warnings.push("flow_only_candidate");
  if (packetType === "scout_candidate" && flags.flow_only && !evidence.some((item) => item.source_type === "liquidity")) blockers.push("flow_only_missing_liquidity_confirmation");
  if (packetType === "harvest_position" && counts.portfolio_evidence_count === 0) blockers.push("missing_portfolio_context");
  if (packetType === "harvest_position" && counts.bearish_count + counts.risk_count === 0) warnings.push("no_direct_exit_evidence");

  const tokenRiskScan = input?.token_risk_scan;
  if (Array.isArray(tokenRiskScan?.blockers) && tokenRiskScan.blockers.length) {
    blockers.push(...tokenRiskScan.blockers.map((code) => `token_risk:${code}`));
  }
  if (Array.isArray(tokenRiskScan?.warnings) && tokenRiskScan.warnings.length) {
    warnings.push(...tokenRiskScan.warnings.map((code) => `token_risk:${code}`));
  }

  const marketDataQuality = input?.market_data_quality;
  if (Array.isArray(marketDataQuality?.blockers) && marketDataQuality.blockers.length) {
    blockers.push(...marketDataQuality.blockers.map((code) => `data_quality:${code}`));
  }
  if (Array.isArray(marketDataQuality?.warnings) && marketDataQuality.warnings.length) {
    warnings.push(...marketDataQuality.warnings.map((code) => `data_quality:${code}`));
  }
  if (marketDataQuality?.degraded_data_mode) warnings.push("data_quality:degraded_data_mode");

  const missingEvidence = buildMissingEvidence(packetType, counts, flags);
  const uniqueSources = new Set(evidence.map((item) => item.source_type)).size;
  let qualityScore = 15;
  qualityScore += Math.min(35, counts.evidence_count * 9);
  qualityScore += Math.min(20, uniqueSources * 5);
  qualityScore += Math.min(15, counts.market_evidence_count * 5);
  qualityScore += Math.min(15, (packetType === "harvest_position" ? counts.portfolio_evidence_count : counts.story_evidence_count) * 5);
  qualityScore -= blockers.length * 20;
  qualityScore -= warnings.length * 6;
  qualityScore -= missingEvidence.length * 4;
  qualityScore = Math.max(0, Math.min(100, Math.round(qualityScore)));

  return {
    evidence_count: counts.evidence_count,
    bullish_count: counts.bullish_count,
    bearish_count: counts.bearish_count,
    risk_count: counts.risk_count,
    market_evidence_count: counts.market_evidence_count,
    story_evidence_count: counts.story_evidence_count,
    quality_score: qualityScore,
    missing_evidence: [...new Set(missingEvidence)].sort(),
    blockers: [...new Set(blockers)].sort(),
    warnings: [...new Set(warnings)].sort()
  };
}

function normalizePacketInput(input = {}, packetType, options = {}) {
  const token = input?.token && typeof input.token === "object" ? input.token : {};
  const symbol = cleanText(input.symbol || token.symbol || input?.position?.symbol);
  const contractAddress = cleanAddress(
    input.contract_address
    || token.contract_address
    || token.address
    || input?.position?.contract_address
    || input.address
  );
  const createdAt = cleanText(
    options.created_at
    || input.created_at
    || input.scan_timestamp
    || input.evaluated_at
    || input.updated_at
  ) || new Date().toISOString();
  return {
    symbol,
    contract_address: contractAddress,
    packet_type: packetType,
    created_at: createdAt,
    strategy_version: cleanText(input.strategy_version || input?.thesis?.strategy_version || input?.metadata?.strategy_version)
  };
}

function buildEvidencePacket(input = {}, packetType, options = {}) {
  const basis = normalizePacketInput(input, packetType, options);
  const evidence = collectBaseEvidence({ ...input, created_at: basis.created_at }, basis);
  const scoring = scoreEvidencePacket(packetType, evidence, {
    ...input,
    symbol: basis.symbol,
    contract_address: basis.contract_address
  });
  const packetDigest = sha256(stableStringify({
    builder_version: EVIDENCE_PACKET_BUILDER_VERSION,
    packet_type: basis.packet_type,
    symbol: basis.symbol,
    contract_address: basis.contract_address,
    strategy_version: basis.strategy_version,
    evidence: evidence.map((item) => ({
      source_type: item.source_type,
      source_ref: item.source_ref,
      label: item.label,
      direction: item.direction,
      strength: item.strength,
      freshness_seconds: item.freshness_seconds,
      summary: item.summary
    }))
  }));

  return {
    schema_version: EVIDENCE_PACKET_SCHEMA_VERSION,
    builder_version: EVIDENCE_PACKET_BUILDER_VERSION,
    evidence_packet_id: `ep_${packetDigest.slice(0, 32)}`,
    symbol: basis.symbol,
    contract_address: basis.contract_address,
    packet_type: basis.packet_type,
    created_at: basis.created_at,
    strategy_version: basis.strategy_version,
    evidence,
    ...scoring
  };
}

function scoutFlowOnlyMetrics(input = {}) {
  const marketData = input?.market_data && typeof input.market_data === "object" ? input.market_data : {};
  const liquidityData = input?.liquidity_data && typeof input.liquidity_data === "object" ? input.liquidity_data : {};
  const flow = input?._dex_flow && typeof input._dex_flow === "object"
    ? input._dex_flow
    : input?.flow && typeof input.flow === "object"
      ? input.flow
      : {};
  return {
    buy_sell_ratio_1h: toNum(flow?.buy_sell_ratio_1h, toNum(input.buy_sell_ratio_1h, NaN)),
    liquidity_usd: toNum(liquidityData.liquidity_usd, toNum(input.liquidity_usd, NaN)),
    volume_24h_usd: toNum(marketData.volume_24h_usd, toNum(input.volume_24h_usd, NaN)),
    market_cap_usd: toNum(marketData.market_cap_usd, toNum(input.market_cap_usd, NaN)),
    flow_signal: cleanText(flow?.flow_signal || input.flow_signal)?.toLowerCase() || null
  };
}

export function evaluateScoutPacketEligibility(packet = {}, input = {}) {
  const evidence = Array.isArray(packet?.evidence) ? packet.evidence : [];
  const hardBlockers = new Set(
    (Array.isArray(packet?.blockers) ? packet.blockers : [])
      .filter((blocker) =>
        String(blocker || "").startsWith("token_risk:")
        || String(blocker || "").startsWith("data_quality:")
        || ["missing_contract_address", "under_evidenced", "flow_only_missing_liquidity_confirmation"].includes(String(blocker || ""))
      )
  );
  const metrics = scoutFlowOnlyMetrics(input);
  const isFlowOnly = packet?.story_evidence_count === 0 && evidence.some((item) => item?.source_type === "flow");
  const reasons = [];

  if ((packet?.evidence_count ?? 0) < 3) reasons.push("requires_minimum_three_evidence_items");
  if ((packet?.market_evidence_count ?? 0) < 1) reasons.push("missing_market_liquidity_flow_or_quality_evidence");
  if (!isFlowOnly && (packet?.story_evidence_count ?? 0) < 1) reasons.push("missing_story_thesis_candidate_or_watchlist_evidence");
  if (hardBlockers.size) reasons.push("hard_packet_blocker");
  if (Number.isFinite(metrics.liquidity_usd) && metrics.liquidity_usd <= 0) reasons.push("zero_liquidity_untradeable");

  const flowOnlyPasses =
    isFlowOnly
    && metrics.flow_signal
    && !metrics.flow_signal.includes("distribution")
    && metrics.buy_sell_ratio_1h >= SCOUT_FLOW_ONLY_MIN_BUY_SELL_RATIO_1H
    && metrics.liquidity_usd >= SCOUT_FLOW_ONLY_MIN_LIQUIDITY_USD
    && metrics.volume_24h_usd >= SCOUT_FLOW_ONLY_MIN_VOLUME_24H_USD
    && metrics.market_cap_usd >= SCOUT_FLOW_ONLY_MIN_MARKET_CAP_USD;

  if (isFlowOnly && !flowOnlyPasses) reasons.push("flow_only_thresholds_not_met");

  return {
    eligible: reasons.length === 0,
    flow_only: isFlowOnly,
    flow_only_passes: flowOnlyPasses,
    hard_blockers: [...hardBlockers].sort(),
    reasons: [...new Set(reasons)].sort(),
    metrics
  };
}

export function rankScoutPacket(packet = {}, input = {}) {
  const eligibility = evaluateScoutPacketEligibility(packet, input);
  const metrics = eligibility.metrics;
  const candidateScore = toNum(input?.e3d_candidate?.convergence_score, NaN);
  const thesisConviction = toNum(input?.thesis?.conviction, NaN);
  const storyCount = Array.isArray(input?.stories) ? input.stories.length : 0;
  const watchlistBoost = input?.watchlist ? 1 : 0;
  const sourcePriority = Number.isFinite(candidateScore)
    ? 500
    : Number.isFinite(thesisConviction)
      ? 400
      : watchlistBoost
        ? 300
        : eligibility.flow_only
          ? 100
          : 200;

  const rankScore =
    (eligibility.eligible ? 1_000_000 : 0)
    + sourcePriority * 1000
    + toNum(packet?.quality_score, 0) * 100
    + toNum(packet?.evidence_count, 0) * 10
    + toNum(packet?.market_evidence_count, 0) * 5
    + toNum(packet?.story_evidence_count, 0) * 5
    + (Number.isFinite(candidateScore) ? candidateScore : 0)
    + (Number.isFinite(thesisConviction) ? thesisConviction : 0)
    + Math.min(99, storyCount)
    + watchlistBoost
    + Math.min(99, Math.round(toNum(metrics.liquidity_usd, 0) / 10000))
    + Math.min(99, Math.round(toNum(metrics.volume_24h_usd, 0) / 25000));

  return {
    score: Math.round(rankScore),
    source_priority: sourcePriority,
    candidate_score: Number.isFinite(candidateScore) ? candidateScore : null,
    thesis_conviction: Number.isFinite(thesisConviction) ? thesisConviction : null,
    story_count: storyCount,
    eligibility
  };
}

export function buildScoutEvidencePacket(input = {}, options = {}) {
  return buildEvidencePacket(input, "scout_candidate", options);
}

export function buildHarvestEvidencePacket(input = {}, options = {}) {
  return buildEvidencePacket(input, "harvest_position", options);
}

export function buildScoutEvidencePackets(inputs = [], options = {}) {
  return (Array.isArray(inputs) ? inputs : []).map((input) => buildScoutEvidencePacket(input, options));
}

export function buildHarvestEvidencePackets(inputs = [], options = {}) {
  return (Array.isArray(inputs) ? inputs : []).map((input) => buildHarvestEvidencePacket(input, options));
}
