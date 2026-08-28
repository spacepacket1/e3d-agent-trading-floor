import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");
const DEFAULT_STATE_FILE = path.join(STATE_DIR, "capital-mandates.json");

export const CAPITAL_MANDATE_SCHEMA_VERSION = "1.0";
export const CAPITAL_MANDATE_STATUSES = Object.freeze([
  "proposed",
  "approved",
  "active",
  "completed",
  "expired",
  "revoked",
  "suspended"
]);

const TERMINAL_OR_INACTIVE_STATUSES = new Set(["completed", "expired", "revoked", "suspended"]);
const MAX_TIGHTEN_KEYS = Object.freeze({
  max_position_size_pct: "max_position_size_pct",
  max_token_exposure_pct: "max_token_exposure_pct",
  max_category_exposure_pct: "max_category_exposure_pct",
  max_strategy_exposure_pct: "max_strategy_exposure_pct",
  max_open_positions: "max_open_positions",
  max_daily_turnover_usd: "max_daily_turnover_usd",
  max_spread_bps: "max_spread_bps",
  max_slippage_bps: "max_slippage_bps"
});
const MIN_TIGHTEN_KEYS = Object.freeze({
  min_liquidity_usd: "min_liquidity_usd"
});
const SET_CONSTRAINT_KEYS = new Set([
  "allowed_symbols",
  "excluded_symbols",
  "allowed_contract_addresses",
  "excluded_contract_addresses",
  "allowed_categories",
  "excluded_categories"
]);
const ADDITIVE_NUMERIC_KEYS = new Set(["max_trade_notional_usd"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function toNum(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function hashMandatePayload(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function validIso(value) {
  if (value == null) return true;
  if (typeof value !== "string" || value.trim() === "") return false;
  return Number.isFinite(new Date(value).getTime());
}

function normalizeList(values, { lowercase = false } = {}) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanText(value))
    .filter(Boolean)
    .map((value) => lowercase ? value.toLowerCase() : value))].sort();
}

export function validateMandateConstraintsAgainstPolicy(constraints = {}, riskPolicy = {}) {
  const errors = [];
  if (!isPlainObject(constraints)) {
    return { valid: false, errors: ["constraints must be an object"] };
  }

  const supported = new Set([
    ...Object.keys(MAX_TIGHTEN_KEYS),
    ...Object.keys(MIN_TIGHTEN_KEYS),
    ...SET_CONSTRAINT_KEYS,
    ...ADDITIVE_NUMERIC_KEYS
  ]);
  for (const key of Object.keys(constraints)) {
    if (!supported.has(key)) errors.push(`unsupported constraint: ${key}`);
  }

  for (const [constraintKey, policyKey] of Object.entries(MAX_TIGHTEN_KEYS)) {
    if (constraints[constraintKey] == null) continue;
    const mandateValue = toNum(constraints[constraintKey]);
    const policyValue = toNum(riskPolicy?.[policyKey]);
    if (!Number.isFinite(mandateValue) || mandateValue < 0) {
      errors.push(`${constraintKey} must be a non-negative number`);
    } else if (Number.isFinite(policyValue) && mandateValue > policyValue) {
      errors.push(`${constraintKey} would relax existing Risk limit ${policyKey}`);
    }
  }

  for (const [constraintKey, policyKey] of Object.entries(MIN_TIGHTEN_KEYS)) {
    if (constraints[constraintKey] == null) continue;
    const mandateValue = toNum(constraints[constraintKey]);
    const policyValue = toNum(riskPolicy?.[policyKey]);
    if (!Number.isFinite(mandateValue) || mandateValue < 0) {
      errors.push(`${constraintKey} must be a non-negative number`);
    } else if (Number.isFinite(policyValue) && mandateValue < policyValue) {
      errors.push(`${constraintKey} would relax existing Risk limit ${policyKey}`);
    }
  }

  if (constraints.max_trade_notional_usd != null) {
    const value = toNum(constraints.max_trade_notional_usd);
    if (!Number.isFinite(value) || value < 0) errors.push("max_trade_notional_usd must be a non-negative number");
  }

  for (const key of SET_CONSTRAINT_KEYS) {
    if (constraints[key] == null) continue;
    if (!Array.isArray(constraints[key]) || constraints[key].some((item) => !cleanText(item))) {
      errors.push(`${key} must be an array of non-empty strings`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateCapitalMandatePayload(payload, options = {}) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return { valid: false, errors: ["capital_mandate payload must be an object"] };
  }

  for (const field of ["mandate_id", "version", "owner", "status", "correlation_id", "proposal_id", "decision_id", "objective"]) {
    if (!cleanText(payload[field])) errors.push(`${field} is required`);
  }
  if (payload.version !== CAPITAL_MANDATE_SCHEMA_VERSION) errors.push(`unsupported mandate version: ${payload.version ?? "missing"}`);
  if (!CAPITAL_MANDATE_STATUSES.includes(payload.status)) errors.push(`unsupported mandate status: ${payload.status ?? "missing"}`);
  for (const field of ["created_at", "approved_at", "effective_at", "expires_at", "revoked_at"]) {
    if (!validIso(payload[field])) errors.push(`${field} must be an ISO timestamp when present`);
  }
  for (const field of ["thesis_refs", "story_refs"]) {
    if (payload[field] != null && (!Array.isArray(payload[field]) || payload[field].some((item) => !cleanText(item)))) {
      errors.push(`${field} must be an array of non-empty strings when present`);
    }
  }

  const constraints = payload.constraints ?? {};
  const constraintValidation = validateMandateConstraintsAgainstPolicy(constraints, options.riskPolicy || {});
  if (!constraintValidation.valid) errors.push(...constraintValidation.errors);

  return { valid: errors.length === 0, errors };
}

export function currentMandateStatus(mandate, now = new Date()) {
  if (!mandate || !CAPITAL_MANDATE_STATUSES.includes(mandate.status)) return null;
  if (TERMINAL_OR_INACTIVE_STATUSES.has(mandate.status)) return mandate.status;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const effectiveMs = mandate.effective_at ? new Date(mandate.effective_at).getTime() : null;
  const expiresMs = mandate.expires_at ? new Date(mandate.expires_at).getTime() : null;
  if (Number.isFinite(expiresMs) && Number.isFinite(nowMs) && nowMs >= expiresMs) return "expired";
  if (mandate.status === "active" && Number.isFinite(effectiveMs) && Number.isFinite(nowMs) && nowMs < effectiveMs) return "approved";
  return mandate.status;
}

function readState(stateFile = DEFAULT_STATE_FILE) {
  try {
    if (!fs.existsSync(stateFile)) return { mandates: [] };
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return { mandates: Array.isArray(parsed?.mandates) ? parsed.mandates : [] };
  } catch {
    return { mandates: [] };
  }
}

function writeState(state, stateFile = DEFAULT_STATE_FILE) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function submitCapitalMandate(payload, options = {}) {
  const riskPolicy = options.riskPolicy || {};
  const validation = validateCapitalMandatePayload(payload, { riskPolicy });
  if (!validation.valid) {
    const error = new Error("INVALID_CAPITAL_MANDATE");
    error.statusCode = 400;
    error.details = validation.errors;
    throw error;
  }

  const stateFile = options.stateFile || DEFAULT_STATE_FILE;
  const state = readState(stateFile);
  const payloadHash = hashMandatePayload(payload);
  const existing = state.mandates.find((entry) => entry?.mandate?.mandate_id === payload.mandate_id);
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      const error = new Error("CAPITAL_MANDATE_CONFLICT");
      error.statusCode = 409;
      error.details = ["same mandate_id submitted with a different payload"];
      throw error;
    }
    return {
      accepted: true,
      idempotent: true,
      mandate_id: payload.mandate_id,
      status: currentMandateStatus(existing.mandate, options.now),
      mandate: existing.mandate,
      payload_hash: existing.payload_hash
    };
  }

  const record = {
    received_at: new Date().toISOString(),
    payload_hash: payloadHash,
    mandate: {
      ...payload,
      thesis_refs: normalizeList(payload.thesis_refs),
      story_refs: normalizeList(payload.story_refs),
      constraints: {
        ...(payload.constraints || {}),
        allowed_symbols: normalizeList(payload.constraints?.allowed_symbols),
        excluded_symbols: normalizeList(payload.constraints?.excluded_symbols),
        allowed_contract_addresses: normalizeList(payload.constraints?.allowed_contract_addresses, { lowercase: true }),
        excluded_contract_addresses: normalizeList(payload.constraints?.excluded_contract_addresses, { lowercase: true }),
        allowed_categories: normalizeList(payload.constraints?.allowed_categories),
        excluded_categories: normalizeList(payload.constraints?.excluded_categories)
      }
    }
  };
  state.mandates.push(record);
  writeState(state, stateFile);
  return {
    accepted: true,
    idempotent: false,
    mandate_id: payload.mandate_id,
    status: currentMandateStatus(record.mandate, options.now),
    mandate: record.mandate,
    payload_hash: payloadHash
  };
}

export function revokeCapitalMandate(mandateId, options = {}) {
  const stateFile = options.stateFile || DEFAULT_STATE_FILE;
  const state = readState(stateFile);
  const record = state.mandates.find((entry) => entry?.mandate?.mandate_id === mandateId);
  if (!record) {
    const error = new Error("CAPITAL_MANDATE_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }
  if (record.mandate.status !== "revoked") {
    record.mandate = {
      ...record.mandate,
      status: "revoked",
      revoked_at: options.revokedAt || new Date().toISOString()
    };
    record.payload_hash = hashMandatePayload(record.mandate);
    writeState(state, stateFile);
  }
  return {
    accepted: true,
    mandate_id: mandateId,
    status: "revoked",
    mandate: record.mandate
  };
}

export function getActiveCapitalMandate(options = {}) {
  const state = readState(options.stateFile || DEFAULT_STATE_FILE);
  const now = options.now || new Date();
  const active = [...state.mandates].reverse().find((entry) => currentMandateStatus(entry?.mandate, now) === "active");
  return active?.mandate || null;
}

export function buildMandateTrace(mandate = null) {
  if (currentMandateStatus(mandate) !== "active") return null;
  return {
    mandate_id: mandate.mandate_id,
    correlation_id: mandate.correlation_id,
    proposal_id: mandate.proposal_id || null,
    decision_id: mandate.decision_id || null,
    owner: mandate.owner || null
  };
}

export function applyMandateScoutBias(candidates = [], mandate = null) {
  const trace = buildMandateTrace(mandate);
  if (!trace || !Array.isArray(candidates)) return candidates;
  const constraints = mandate.constraints || {};
  const preferredSymbols = new Set(normalizeList(mandate.preferences?.preferred_symbols || constraints.allowed_symbols).map((s) => s.toLowerCase()));
  const preferredCategories = new Set(normalizeList(mandate.preferences?.preferred_categories || constraints.allowed_categories).map((s) => s.toLowerCase()));
  return candidates.map((candidate) => {
    const symbol = cleanText(candidate?.token?.symbol || candidate?.symbol)?.toLowerCase();
    const category = cleanText(candidate?.token?.category || candidate?.category)?.toLowerCase();
    const matched = (symbol && preferredSymbols.has(symbol)) || (category && preferredCategories.has(category));
    if (!matched) return candidate;
    return {
      ...candidate,
      mandate_trace: trace,
      mandate_bias: {
        mandate_id: trace.mandate_id,
        correlation_id: trace.correlation_id,
        reason: "matched_active_capital_mandate_preference"
      },
      opportunity_score: Math.min(100, toNum(candidate.opportunity_score, 0) + 5)
    };
  });
}
