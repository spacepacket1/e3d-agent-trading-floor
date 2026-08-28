import crypto from "crypto";

export const TOKEN_RISK_SCANNER_SCHEMA_VERSION = "1.0";
export const TOKEN_RISK_SCANNER_VERSION = "token-risk-scanner-v1";

const NON_TRADEABLE_SYMBOL_PATTERN = /^(USDC?|USDT|DAI|USDS|BUSD|TUSD|FRAX|LUSD|SUSD|GUSD|PYUSD|FDUSD|USDE|SUSDE|USDY|USDP|HUSD|MUSD|CRVUSD|GHO|RLUSD|USDX|USDK|USDM|XAUt|PAXG|CACHE|XAUT|WETH|WBTC|cbBTC|rETH|stETH|wstETH|cbETH|ankrETH|BETH|sETH2|ETH2x|STETH)$/i;

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function cleanAddress(value) {
  const text = String(value || "").trim().toLowerCase();
  return text || null;
}

function round(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function firstFinite(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeToken(input = {}) {
  const token = input.token && typeof input.token === "object" ? input.token : input;
  const marketData = input.market_data && typeof input.market_data === "object"
    ? input.market_data
    : token.market_data && typeof token.market_data === "object"
      ? token.market_data
      : {};
  const liquidityData = input.liquidity_data && typeof input.liquidity_data === "object"
    ? input.liquidity_data
    : token.liquidity_data && typeof token.liquidity_data === "object"
      ? token.liquidity_data
      : {};
  const executionData = input.execution_data && typeof input.execution_data === "object"
    ? input.execution_data
    : token.execution_data && typeof token.execution_data === "object"
      ? token.execution_data
      : {};

  return {
    symbol: cleanText(token.symbol || input.symbol),
    name: cleanText(token.name || input.name),
    contract_address: cleanAddress(token.contract_address || token.address || input.contract_address),
    category: cleanText(token.category || input.category),
    liquidity_usd: round(Math.max(0, toNum(
      token.liquidity_usd,
      toNum(liquidityData.liquidity_usd, toNum(input.liquidity_usd, 0))
    )), 2),
    liquidity_quality: firstFinite(token.liquidity_quality, input.liquidity_quality),
    fraud_risk: firstFinite(token.fraud_risk, input.fraud_risk),
    current_price: firstFinite(
      token.current_price,
      marketData.current_price,
      input.current_price,
      input.price
    ),
    spread_bps: firstFinite(token.spread_bps, executionData.spread_bps, input.spread_bps),
    slippage_bps: firstFinite(token.slippage_bps, executionData.estimated_slippage_bps, input.slippage_bps),
    holder_count: firstFinite(token.holder_count, token.holders, input.holder_count),
    top_holder_pct: firstFinite(
      token.top_holder_pct,
      token.top_holder_percent,
      token.top_holder_share_pct,
      input.top_holder_pct
    ),
    holder_concentration_pct: firstFinite(
      token.holder_concentration_pct,
      token.holder_concentration_percent,
      input.holder_concentration_pct
    ),
    verified_contract: token.verified_contract ?? token.contract_verified ?? token.is_verified ?? input.verified_contract ?? null,
    ownership_renounced: token.ownership_renounced ?? token.is_ownership_renounced ?? input.ownership_renounced ?? null,
    proxy_contract: token.proxy_contract ?? token.is_proxy_contract ?? input.proxy_contract ?? null,
    honeypot_risk: firstFinite(token.honeypot_risk, input.honeypot_risk),
    rug_pull_risk: firstFinite(token.rug_pull_risk, token.rug_risk, input.rug_pull_risk)
  };
}

function buildCheck(code, label, status, value = null, detail = null) {
  return { code, label, status, value, detail };
}

function classificationForToken(token) {
  const symbol = String(token.symbol || "").trim();
  const name = String(token.name || "").trim().toUpperCase();
  const category = String(token.category || "").trim().toLowerCase();
  const excludedBySymbol = NON_TRADEABLE_SYMBOL_PATTERN.test(symbol);
  const stablecoinLike = excludedBySymbol || category.includes("stable") || /\bUSD\b/.test(name);
  const baseAssetLike = excludedBySymbol || category.includes("wrapped") || category.includes("base");
  return { stablecoinLike, baseAssetLike };
}

export function buildTokenRiskScan(input = {}) {
  const evaluatedAt = cleanText(input.evaluated_at) || new Date().toISOString();
  const token = normalizeToken(input);
  const side = cleanText(input.side || input.intent?.side || "buy") || "buy";
  const mode = cleanText(input.mode || "research") || "research";
  const { stablecoinLike, baseAssetLike } = classificationForToken(token);
  const fraudRisk = firstFinite(token.fraud_risk, token.rug_pull_risk, token.honeypot_risk);
  const liquidityQuality = firstFinite(token.liquidity_quality);
  const checks = [];
  const blockers = [];
  const warnings = [];
  const missingMetadata = [];

  checks.push(buildCheck(
    "contract_address_present",
    "Contract address present",
    token.contract_address ? "pass" : "warn",
    token.contract_address
  ));
  if (!token.contract_address) missingMetadata.push("contract_address");

  checks.push(buildCheck(
    "symbol_present",
    "Token symbol present",
    token.symbol ? "pass" : "warn",
    token.symbol
  ));
  if (!token.symbol) missingMetadata.push("symbol");

  checks.push(buildCheck(
    "fraud_risk_indicator",
    "Fraud or rug indicator",
    fraudRisk == null ? "warn" : fraudRisk >= 75 ? "block" : fraudRisk >= 35 ? "warn" : "pass",
    fraudRisk
  ));
  if (fraudRisk == null) {
    missingMetadata.push("fraud_risk");
    warnings.push("missing_fraud_risk_metadata");
  } else if (fraudRisk >= 75) {
    blockers.push("fraud_risk_critical");
  } else if (fraudRisk >= 35) {
    warnings.push("fraud_risk_elevated");
  }

  checks.push(buildCheck(
    "liquidity_quality_indicator",
    "Liquidity quality indicator",
    liquidityQuality == null ? "warn" : liquidityQuality <= 25 ? "warn" : "pass",
    liquidityQuality
  ));
  if (liquidityQuality == null) {
    missingMetadata.push("liquidity_quality");
    warnings.push("missing_liquidity_quality_metadata");
  } else if (liquidityQuality <= 25) {
    warnings.push("liquidity_quality_weak");
  }

  checks.push(buildCheck(
    "liquidity_usd_indicator",
    "Liquidity USD present",
    token.liquidity_usd > 0 ? (token.liquidity_usd < 100000 ? "warn" : "pass") : "warn",
    token.liquidity_usd
  ));
  if (!(token.liquidity_usd > 0)) {
    missingMetadata.push("liquidity_usd");
    warnings.push("missing_liquidity_metadata");
  } else if (token.liquidity_usd < 100000) {
    warnings.push("liquidity_thin");
  }

  const allowBaseAsset = input.allow_base_asset === true || String(input.category || token.category || "").toLowerCase() === "trend_overlay";
  checks.push(buildCheck(
    "stablecoin_exclusion",
    "Stablecoin exclusion",
    stablecoinLike && !allowBaseAsset ? "block" : "pass",
    stablecoinLike
  ));
  if (stablecoinLike && !allowBaseAsset) blockers.push("stablecoin_excluded");

  checks.push(buildCheck(
    "base_asset_exclusion",
    "Base or wrapped asset exclusion",
    baseAssetLike && !allowBaseAsset ? "block" : "pass",
    baseAssetLike
  ));
  if (baseAssetLike && !allowBaseAsset) blockers.push("base_asset_excluded");

  const holderFieldStatuses = [];
  if (token.holder_count == null) {
    missingMetadata.push("holder_count");
    holderFieldStatuses.push(buildCheck("holder_count_present", "Holder count present", "warn", null));
  } else {
    holderFieldStatuses.push(buildCheck("holder_count_present", "Holder count present", token.holder_count >= 100 ? "pass" : "warn", token.holder_count));
    if (token.holder_count < 100) warnings.push("holder_count_low");
  }

  if (token.top_holder_pct != null) {
    holderFieldStatuses.push(buildCheck("top_holder_pct", "Top holder concentration", token.top_holder_pct >= 50 ? "warn" : "pass", token.top_holder_pct));
    if (token.top_holder_pct >= 50) warnings.push("top_holder_concentration_high");
  }
  if (token.holder_concentration_pct != null) {
    holderFieldStatuses.push(buildCheck("holder_concentration_pct", "Holder concentration", token.holder_concentration_pct >= 80 ? "warn" : "pass", token.holder_concentration_pct));
    if (token.holder_concentration_pct >= 80) warnings.push("holder_concentration_high");
  }
  if (token.verified_contract != null) {
    holderFieldStatuses.push(buildCheck("verified_contract", "Verified contract metadata", token.verified_contract ? "pass" : "warn", token.verified_contract));
    if (!token.verified_contract) warnings.push("contract_unverified");
  }
  if (token.ownership_renounced != null) {
    holderFieldStatuses.push(buildCheck("ownership_renounced", "Ownership renounced metadata", token.ownership_renounced ? "pass" : "warn", token.ownership_renounced));
  }
  if (token.proxy_contract != null) {
    holderFieldStatuses.push(buildCheck("proxy_contract", "Proxy contract metadata", token.proxy_contract ? "warn" : "pass", token.proxy_contract));
    if (token.proxy_contract) warnings.push("proxy_contract_present");
  }

  checks.push(...holderFieldStatuses);

  const idBasis = {
    scanner_version: TOKEN_RISK_SCANNER_VERSION,
    evaluated_at: evaluatedAt,
    mode,
    side,
    symbol: token.symbol,
    contract_address: token.contract_address,
    category: token.category,
    liquidity_usd: token.liquidity_usd,
    liquidity_quality: liquidityQuality,
    fraud_risk: fraudRisk,
    holder_count: token.holder_count,
    top_holder_pct: token.top_holder_pct,
    holder_concentration_pct: token.holder_concentration_pct,
    verified_contract: token.verified_contract,
    ownership_renounced: token.ownership_renounced,
    proxy_contract: token.proxy_contract,
    candidate_id: cleanText(input.candidate_id),
    position_id: cleanText(input.position_id),
    trade_id: cleanText(input.trade_id),
    source_trade_id: cleanText(input.source_trade_id),
    order_id: cleanText(input.order_id),
    risk_decision_id: cleanText(input.risk_decision_id),
    signal_snapshot_ref: input.signal_snapshot_ref || null
  };
  const severity = blockers.length ? "block" : warnings.length ? "warn" : "pass";

  return {
    schema_version: TOKEN_RISK_SCANNER_SCHEMA_VERSION,
    scanner_version: TOKEN_RISK_SCANNER_VERSION,
    token_risk_scan_id: `trs_${sha256(stableStringify(idBasis)).slice(0, 32)}`,
    token_risk_scan_id_basis: "sha256(scanner_version,evaluated_at,mode,side,token_metadata,holder_contract_fields,linked_refs)",
    evaluated_at: evaluatedAt,
    mode,
    side,
    symbol: token.symbol,
    contract_address: token.contract_address,
    category: token.category,
    decision: severity,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    checks,
    exclusions: {
      stablecoin: stablecoinLike,
      base_asset: baseAssetLike
    },
    market_metadata: {
      liquidity_usd: token.liquidity_usd,
      liquidity_quality: liquidityQuality,
      current_price: token.current_price,
      spread_bps: token.spread_bps,
      slippage_bps: token.slippage_bps,
      fraud_risk: fraudRisk
    },
    holder_contract_metadata: {
      holder_count: token.holder_count,
      top_holder_pct: token.top_holder_pct,
      holder_concentration_pct: token.holder_concentration_pct,
      verified_contract: token.verified_contract,
      ownership_renounced: token.ownership_renounced,
      proxy_contract: token.proxy_contract,
      honeypot_risk: token.honeypot_risk,
      rug_pull_risk: token.rug_pull_risk
    },
    metadata_gaps: [...new Set(missingMetadata)],
    linked_refs: {
      candidate_id: cleanText(input.candidate_id),
      position_id: cleanText(input.position_id),
      trade_id: cleanText(input.trade_id),
      source_trade_id: cleanText(input.source_trade_id),
      order_id: cleanText(input.order_id),
      risk_decision_id: cleanText(input.risk_decision_id),
      signal_snapshot_ref: input.signal_snapshot_ref || null,
      risk_decision_ref: input.risk_decision_ref || null
    },
    live_submission_enabled: false,
    live_submission_attempted: false,
    summary: severity === "block"
      ? `Token risk scan blocked by ${[...new Set(blockers)].join(", ")}.`
      : severity === "warn"
        ? `Token risk scan warnings: ${[...new Set(warnings)].join(", ")}.`
        : "Token risk scan passed available deterministic checks."
  };
}

export function buildTokenRiskScanRef(scan = null, context = {}) {
  if (!scan?.token_risk_scan_id) return null;
  return {
    event_type: "token_risk_scan",
    token_risk_scan_id: scan.token_risk_scan_id,
    contract_address: scan.contract_address || null,
    symbol: scan.symbol || null,
    decision: scan.decision || null,
    cycle_id: context.cycle_id || null,
    pipeline_run_id: context.pipeline_run_id || null,
    report_id: context.report_id || null
  };
}
