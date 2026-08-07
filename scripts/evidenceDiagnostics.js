function toNum(value, fallback = NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function stableObjectFromEntries(entries = []) {
  return Object.fromEntries(
    [...entries]
      .filter(([, value]) => value > 0)
      .sort(([a], [b]) => {
        const aNum = Number(a);
        const bNum = Number(b);
        if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
        return String(a).localeCompare(String(b));
      })
  );
}

function sumFiniteOrNull(values = []) {
  const nums = values.map((value) => toNum(value, NaN)).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0);
}

function inferEvidenceSource(value) {
  const text = String(
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? JSON.stringify(value)
        : value ?? ""
  ).toLowerCase();

  if (!text) return "unknown";
  if (/(honeypot|security_risk|rug|fraud|token[_ ]risk)/.test(text)) return "token_risk";
  if (/(stale|missing data|data quality|degraded data|quality gate)/.test(text)) return "data_quality";
  if (/(watchlist|user_watchlist)/.test(text)) return "watchlist";
  if (/(thesis|target_|invalidation|conviction)/.test(text)) return "thesis";
  if (/(current_price|price|market cap|volume_24h|change_24h|change_30m|coingecko|market_data)/.test(text)) return "market_data";
  if (/(liquidity|spread|slippage|quote_source)/.test(text)) return "liquidity";
  if (/(flow_signal|buy_sell_ratio|order flow|dexscreener|distribution|accumulation)/.test(text)) return "flow";
  if (/(position|portfolio|pnl|avg_entry|market_value|holding)/.test(text)) return "portfolio";
  if (/(expectancy|profit factor|win rate|performance)/.test(text)) return "performance";
  if (/(story|smart_money|breakout|mover|surge|staging|cluster|funnel|exchange_flow|treasury_distribution|concentration_shift|liquidity_drain)/.test(text)) return "story";
  return "unknown";
}

function evidenceList(item) {
  return Array.isArray(item?.evidence) ? item.evidence : [];
}

function buildEvidenceCountDistribution(items = []) {
  const counts = new Map();
  for (const item of items) {
    const evidenceCount = evidenceList(item).length;
    counts.set(String(evidenceCount), (counts.get(String(evidenceCount)) || 0) + 1);
  }
  return stableObjectFromEntries(counts.entries());
}

function buildEvidenceSourceDistribution(items = []) {
  const counts = new Map();
  for (const item of items) {
    for (const evidence of evidenceList(item)) {
      const source = inferEvidenceSource(evidence);
      counts.set(source, (counts.get(source) || 0) + 1);
    }
  }
  return stableObjectFromEntries(counts.entries());
}

function buildLlmAggregate(input = []) {
  const batches = Array.isArray(input)
    ? input
    : Array.isArray(input?.llm_batches) ? input.llm_batches : [];
  // Fallback path: caller passed an already-aggregated diagnostics object
  // (no raw batches). Preserve the pre-computed counters instead of zeroing them.
  if (batches.length === 0 && !Array.isArray(input) && input && typeof input === "object") {
    const hasAggregate =
      input.llm_batch_count != null || input.prompt_chars != null ||
      input.total_tokens != null || input.llm_duration_ms != null;
    if (hasAggregate) {
      const numOrNull = (v) => (Number.isFinite(toNum(v, NaN)) ? toNum(v) : null);
      return {
        batch_count: toNum(input.llm_batch_count, 0),
        prompt_chars: toNum(input.prompt_chars, 0),
        prompt_tokens: numOrNull(input.prompt_tokens),
        completion_tokens: numOrNull(input.completion_tokens),
        total_tokens: numOrNull(input.total_tokens),
        duration_ms: toNum(input.llm_duration_ms, 0)
      };
    }
  }
  return {
    batch_count: batches.length,
    prompt_chars: batches.reduce((sum, batch) => sum + toNum(batch?.prompt_chars, 0), 0),
    prompt_tokens: sumFiniteOrNull(batches.map((batch) => batch?.prompt_tokens)),
    completion_tokens: sumFiniteOrNull(batches.map((batch) => batch?.completion_tokens)),
    total_tokens: sumFiniteOrNull(batches.map((batch) => batch?.total_tokens)),
    duration_ms: sumFiniteOrNull(batches.map((batch) => batch?.duration_ms)) ?? 0
  };
}

function buildCoverageSummary(coverage = null, storiesChecked = []) {
  const safeCoverage = coverage && typeof coverage === "object" ? coverage : {};
  const checked = Array.isArray(storiesChecked) ? storiesChecked : [];
  return {
    coverage_pct: toNum(safeCoverage.coverage_pct, NaN),
    expected_type_count: Array.isArray(safeCoverage.expected_types) ? safeCoverage.expected_types.length : 0,
    self_reported_type_count: Array.isArray(safeCoverage.self_reported_types) ? safeCoverage.self_reported_types.length : 0,
    evidence_cited_type_count: Array.isArray(safeCoverage.evidence_cited_types) ? safeCoverage.evidence_cited_types.length : 0,
    stories_checked_count: checked.length
  };
}

function compactCoverageSummary(coverageSummary = {}) {
  return {
    coverage_pct: Number.isFinite(coverageSummary.coverage_pct) ? Number(coverageSummary.coverage_pct.toFixed(2)) : null,
    expected_type_count: coverageSummary.expected_type_count ?? 0,
    self_reported_type_count: coverageSummary.self_reported_type_count ?? 0,
    evidence_cited_type_count: coverageSummary.evidence_cited_type_count ?? 0,
    stories_checked_count: coverageSummary.stories_checked_count ?? 0
  };
}

function buildCandidateEvidenceSummary(items = [], fullEvidenceMin = 3) {
  const list = Array.isArray(items) ? items : [];
  const full = list.filter((item) => evidenceList(item).length >= fullEvidenceMin).length;
  return {
    returned: list.length,
    with_full_evidence: full,
    with_thin_evidence: Math.max(0, list.length - full),
    evidence_count_distribution: buildEvidenceCountDistribution(list),
    evidence_source_distribution: buildEvidenceSourceDistribution(list)
  };
}

export function buildScoutEvidenceDiagnostics(input = {}) {
  const llm = buildLlmAggregate(input);
  const candidates = buildCandidateEvidenceSummary(input.candidates, 3);
  const coverage = buildCoverageSummary(input.coverage, input.stories_checked);
  return {
    agent: "scout",
    input_candidate_count: toNum(input.input_candidate_count, 0),
    llm_batch_count: llm.batch_count,
    prompt_chars: llm.prompt_chars,
    prompt_tokens: llm.prompt_tokens,
    completion_tokens: llm.completion_tokens,
    total_tokens: llm.total_tokens,
    llm_duration_ms: llm.duration_ms,
    candidates_returned: candidates.returned,
    address_repairs_in_cycle: toNum(input.address_repairs_in_cycle, 0),
    candidates_with_full_evidence: candidates.with_full_evidence,
    candidates_with_thin_evidence: candidates.with_thin_evidence,
    evidence_count_distribution: candidates.evidence_count_distribution,
    evidence_source_distribution: candidates.evidence_source_distribution,
    story_coverage: compactCoverageSummary(coverage)
  };
}

export function buildHarvestEvidenceDiagnostics(input = {}) {
  const llm = buildLlmAggregate(input);
  const exits = buildCandidateEvidenceSummary(input.exit_candidates, 2);
  const coverage = buildCoverageSummary(input.coverage, input.stories_checked);
  const positionReviews = Array.isArray(input.position_reviews) ? input.position_reviews : [];
  return {
    agent: "harvest",
    input_candidate_count: toNum(input.input_candidate_count, positionReviews.length),
    llm_batch_count: llm.batch_count,
    prompt_chars: llm.prompt_chars,
    prompt_tokens: llm.prompt_tokens,
    completion_tokens: llm.completion_tokens,
    total_tokens: llm.total_tokens,
    llm_duration_ms: llm.duration_ms,
    positions_reviewed: toNum(input.positions_reviewed, positionReviews.length),
    exit_candidates_returned: exits.returned,
    exit_candidates_with_full_evidence: exits.with_full_evidence,
    exit_candidates_with_thin_evidence: exits.with_thin_evidence,
    evidence_count_distribution: exits.evidence_count_distribution,
    evidence_source_distribution: exits.evidence_source_distribution,
    story_coverage: compactCoverageSummary(coverage)
  };
}

export function buildEvidenceDiagnosticsEvent(input = {}) {
  const scout = input?.scout && typeof input.scout === "object" ? input.scout : null;
  const harvest = input?.harvest && typeof input.harvest === "object" ? input.harvest : null;
  return {
    cycle_id: cleanText(input?.cycle_id),
    pipeline_run_id: cleanText(input?.pipeline_run_id),
    scout: scout ? {
      input_candidate_count: scout.input_candidate_count,
      llm_batch_count: scout.llm_batch_count,
      prompt_chars: scout.prompt_chars,
      total_tokens: scout.total_tokens,
      llm_duration_ms: scout.llm_duration_ms,
      candidates_returned: scout.candidates_returned,
      address_repairs_in_cycle: scout.address_repairs_in_cycle,
      candidates_with_thin_evidence: scout.candidates_with_thin_evidence
    } : null,
    harvest: harvest ? {
      input_candidate_count: harvest.input_candidate_count,
      llm_batch_count: harvest.llm_batch_count,
      prompt_chars: harvest.prompt_chars,
      total_tokens: harvest.total_tokens,
      llm_duration_ms: harvest.llm_duration_ms,
      positions_reviewed: harvest.positions_reviewed,
      exit_candidates_returned: harvest.exit_candidates_returned,
      exit_candidates_with_thin_evidence: harvest.exit_candidates_with_thin_evidence
    } : null
  };
}
