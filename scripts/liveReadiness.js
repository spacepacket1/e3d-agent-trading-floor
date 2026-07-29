import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_REPORTS_DIR = path.join(ROOT, "reports");
const REQUIRED_GRADE_SET = new Set(["A", "B"]);
const RECOGNIZED_GRADE_SET = new Set(["A", "B", "C", "D", "F"]);
export const PROMOTION_SIGNED_REPORT_MARKER = "signed_strategy_promotion_gate_v1";
export const LIVE_PROMOTION_TARGET_STATES = Object.freeze(["tiny_live", "scaled_live"]);

export const LIVE_READINESS_POLICY = Object.freeze({
  required_consecutive_cycles: 50,
  qualifying_grades: Object.freeze(["A", "B"])
});

function cleanText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

function ordinalCompare(left, right) {
  const a = String(left);
  const b = String(right);
  return a === b ? 0 : (a < b ? -1 : 1);
}

function normalizeTimestamp(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? { ms, iso: new Date(ms).toISOString() } : null;
}

function normalizePolicy(policy = {}) {
  const required = Number.isInteger(policy.required_consecutive_cycles) && policy.required_consecutive_cycles > 0
    ? policy.required_consecutive_cycles
    : LIVE_READINESS_POLICY.required_consecutive_cycles;
  const qualifyingGrades = Array.isArray(policy.qualifying_grades)
    ? [...new Set(policy.qualifying_grades.map((grade) => cleanText(grade)?.toUpperCase()).filter(Boolean))]
    : [...LIVE_READINESS_POLICY.qualifying_grades];
  return Object.freeze({
    required_consecutive_cycles: required,
    qualifying_grades: Object.freeze(qualifyingGrades.length ? qualifyingGrades : [...LIVE_READINESS_POLICY.qualifying_grades])
  });
}

function normalizeReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return { valid: false, reason: "not_an_object" };
  const reportId = cleanText(report.report_id);
  const strategyVersion = cleanText(report.strategy_version);
  const grade = cleanText(report.overall_grade)?.toUpperCase();
  const generated = normalizeTimestamp(report.generated_at);
  if (!reportId) {
    return { valid: false, report_id: null, reason: "missing_report_id" };
  }
  if (!strategyVersion || !generated || !RECOGNIZED_GRADE_SET.has(grade)) {
    return { valid: false, report_id: reportId, reason: "missing_or_invalid_required_field" };
  }
  return {
    valid: true,
    report_id: reportId,
    report: {
      report_id: reportId,
      strategy_version: strategyVersion,
      generated_at: generated.iso,
      generated_at_ms: generated.ms,
      overall_grade: grade
    }
  };
}

function loadReportsFromDirectory(reportsDir = DEFAULT_REPORTS_DIR) {
  try {
    const resolved = path.resolve(reportsDir);
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^cycle-.*\.json$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => ordinalCompare(left, right));
    const reports = [];
    for (const name of entries) {
      try {
        reports.push(JSON.parse(fs.readFileSync(path.join(resolved, name), "utf8")));
      } catch (error) {
        reports.push({ __read_error: true, __file_name: name, __error: error?.message || "read_error" });
      }
    }
    return { reports, error: null, reportsDir: resolved };
  } catch (error) {
    return { reports: [], error: error?.code || error?.message || "reports_directory_unavailable", reportsDir: path.resolve(reportsDir) };
  }
}

function emptyResult(strategyVersion, policy, blockerCode, blockerDetail, diagnostics = []) {
  return {
    strategy_version: strategyVersion,
    required_consecutive_cycles: policy.required_consecutive_cycles,
    qualifying_grades: [...policy.qualifying_grades],
    valid_cycle_count: 0,
    current_qualifying_streak: 0,
    remaining_qualifying_cycles: policy.required_consecutive_cycles,
    progress_pct: 0,
    readiness_met: false,
    latest_cycle: null,
    threshold_cycle: null,
    blockers: blockerCode ? [{ code: blockerCode, detail: blockerDetail }] : [],
    diagnostics
  };
}

function cloneBlockers(blockers = []) {
  return Array.isArray(blockers) ? blockers.map((blocker) => ({ ...blocker })) : [];
}

function readinessEpochMatches(left = null, right = null) {
  return Boolean(left
    && right
    && left.strategy_version === right.strategy_version
    && left.required_consecutive_cycles === right.required_consecutive_cycles
    && JSON.stringify(left.qualifying_grades || []) === JSON.stringify(right.qualifying_grades || [])
    && left.readiness_met === true
    && left.threshold_cycle?.report_id === right.threshold_cycle?.report_id
    && left.threshold_cycle?.generated_at === right.threshold_cycle?.generated_at);
}

function comparePromotionEnvelopeAndPayload(trusted = null, envelope = null) {
  return Boolean(trusted
    && envelope
    && trusted.report_id === envelope.report_id
    && trusted.generated_at === envelope.generated_at
    && trusted.signed_report_marker === envelope.signed_report_marker
    && trusted.strategy_version === envelope.strategy_version
    && trusted.target_state === envelope.target_state
    && trusted.promotion_decision === envelope.promotion_decision
    && trusted.promotion_allowed === envelope.promotion_allowed);
}

export function evaluateLiveReadinessFromReports(reports = [], options = {}) {
  const policy = normalizePolicy(options.policy);
  const strategyVersion = cleanText(options.strategyVersion);
  if (!strategyVersion) {
    return emptyResult(null, policy, "missing_strategy_version", "A non-empty strategy_version is required.");
  }

  const diagnostics = [];
  const grouped = new Map();
  for (const [index, rawReport] of Array.isArray(reports) ? reports.entries() : []) {
    const normalized = normalizeReport(rawReport);
    if (!normalized.valid) {
      diagnostics.push({ code: "malformed_report", report_index: index, report_id: normalized.report_id || null, detail: normalized.reason });
      if (!normalized.report_id) continue;
    }
    const key = normalized.report_id;
    const current = grouped.get(key) || { variants: [], canonical: null };
    if (normalized.valid) current.variants.push(normalized.report);
    else current.variants.push({ report_id: key, __invalid: true, __invalid_reason: normalized.reason });
    grouped.set(key, current);
  }

  const canonicalReports = [];
  for (const [reportId, entry] of [...grouped.entries()].sort((left, right) => ordinalCompare(left[0], right[0]))) {
    const variants = entry.variants;
    const validVariants = variants.filter((variant) => !variant.__invalid);
    const first = validVariants[0] || null;
    const conflicted = validVariants.length !== variants.length
      || validVariants.some((variant) =>
        variant.strategy_version !== first.strategy_version
        || variant.generated_at_ms !== first.generated_at_ms
        || variant.overall_grade !== first.overall_grade
      );
    if (conflicted) {
      diagnostics.push({ code: "conflicting_duplicate_report_id", report_id: reportId, detail: "Conflicting duplicates were excluded." });
      continue;
    }
    if (validVariants.length > 1) {
      diagnostics.push({ code: "duplicate_report_id", report_id: reportId, detail: "Equivalent duplicates counted once." });
    }
    canonicalReports.push(first);
  }

  const matchingReports = canonicalReports
    .filter((report) => report.strategy_version === strategyVersion)
    .sort((left, right) => left.generated_at_ms - right.generated_at_ms || ordinalCompare(left.report_id, right.report_id));

  if (!matchingReports.length) {
    return {
      ...emptyResult(strategyVersion, policy, "no_valid_matching_manager_reports", "No valid Manager reports matched the requested strategy version.", diagnostics),
      diagnostics: diagnostics.sort((left, right) => ordinalCompare(left.code, right.code) || ordinalCompare(left.report_id || "", right.report_id || ""))
    };
  }

  const qualifyingGrades = new Set(policy.qualifying_grades);
  let currentStreak = 0;
  let thresholdCycle = null;
  let latestCycle = null;
  let validCycleCount = 0;

  for (const report of matchingReports) {
    validCycleCount += 1;
    latestCycle = {
      report_id: report.report_id,
      generated_at: report.generated_at,
      strategy_version: report.strategy_version,
      overall_grade: report.overall_grade
    };

    if (qualifyingGrades.has(report.overall_grade)) {
      currentStreak += 1;
      if (currentStreak === policy.required_consecutive_cycles && !thresholdCycle) {
        thresholdCycle = {
          report_id: report.report_id,
          generated_at: report.generated_at,
          strategy_version: report.strategy_version,
          overall_grade: report.overall_grade
        };
      }
      continue;
    }

    currentStreak = 0;
    thresholdCycle = null;
  }

  const readinessMet = currentStreak >= policy.required_consecutive_cycles;
  const remaining = Math.max(0, policy.required_consecutive_cycles - currentStreak);
  const progress = Math.min(100, Number(((currentStreak / policy.required_consecutive_cycles) * 100).toFixed(2)));
  const blockers = readinessMet
    ? []
    : [{
      code: "insufficient_qualifying_cycles",
      detail: `Need ${policy.required_consecutive_cycles} consecutive A/B Manager cycles; found ${currentStreak}.`
    }];

  return {
    strategy_version: strategyVersion,
    required_consecutive_cycles: policy.required_consecutive_cycles,
    qualifying_grades: [...policy.qualifying_grades],
    valid_cycle_count: validCycleCount,
    current_qualifying_streak: currentStreak,
    remaining_qualifying_cycles: remaining,
    progress_pct: progress,
    readiness_met: readinessMet,
    latest_cycle: latestCycle,
    threshold_cycle: readinessMet ? thresholdCycle : null,
    blockers,
    diagnostics: diagnostics.sort((left, right) =>
      ordinalCompare(left.code, right.code)
      || ordinalCompare(left.report_id || "", right.report_id || "")
      || Number(left.report_index ?? -1) - Number(right.report_index ?? -1)
    )
  };
}

export function evaluateLiveReadiness(options = {}) {
  const policy = normalizePolicy(options.policy);
  const strategyVersion = cleanText(options.strategyVersion);
  if (!strategyVersion) {
    return emptyResult(null, policy, "missing_strategy_version", "A non-empty strategy_version is required.");
  }

  if (Array.isArray(options.reports)) {
    return evaluateLiveReadinessFromReports(options.reports, { ...options, policy, strategyVersion });
  }

  const loaded = loadReportsFromDirectory(options.reportsDir || DEFAULT_REPORTS_DIR);
  if (loaded.error) {
    return emptyResult(strategyVersion, policy, "no_valid_matching_manager_reports", `Unable to read reports directory: ${loaded.error}.`, [
      { code: "reports_directory_unavailable", detail: String(loaded.error), reports_dir: loaded.reportsDir }
    ]);
  }

  return evaluateLiveReadinessFromReports(loaded.reports, { ...options, policy, strategyVersion });
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function normalizePromotionTimestamp(value) {
  const normalized = normalizeTimestamp(value);
  return normalized ? { ...normalized, raw: String(value ?? "") } : null;
}

function canonicalProof(readiness = null) {
  if (!readiness) return null;
  return {
    strategy_version: readiness.strategy_version || null,
    required_consecutive_cycles: readiness.required_consecutive_cycles ?? LIVE_READINESS_POLICY.required_consecutive_cycles,
    qualifying_grades: Array.isArray(readiness.qualifying_grades) ? [...readiness.qualifying_grades] : [...LIVE_READINESS_POLICY.qualifying_grades],
    readiness_met: readiness.readiness_met === true,
    threshold_cycle: readiness.threshold_cycle ? {
      report_id: readiness.threshold_cycle.report_id || null,
      generated_at: readiness.threshold_cycle.generated_at || null
    } : null
  };
}

function buildSignedPayloadHash(payload) {
  return sha256(stableStringify(payload));
}

function verifyPromotionSignature(report = {}) {
  const signedPayload = report?.signed_payload;
  const signature = cleanText(report?.signature);
  const signedPayloadHash = cleanText(report?.signed_payload_hash);
  if (!signature) return { verified: false, state: "missing_signature", signature: null, signedPayloadHash: null, payloadHash: null };
  if (!signedPayload || typeof signedPayload !== "object" || Array.isArray(signedPayload)) {
    return { verified: false, state: "missing_signed_payload", signature, signedPayloadHash: null, payloadHash: null };
  }

  const payloadHash = buildSignedPayloadHash(signedPayload);
  const expectedSignature = sha256(`promotion_gates:${payloadHash}`);
  if (signedPayloadHash !== payloadHash) {
    return { verified: false, state: "payload_hash_mismatch", signature, signedPayloadHash, payloadHash, expectedSignature };
  }
  if (signature !== expectedSignature) {
    return { verified: false, state: "invalid_signature", signature, signedPayloadHash, payloadHash, expectedSignature };
  }
  return { verified: true, state: "verified", signature, signedPayloadHash, payloadHash, expectedSignature };
}

function normalizePromotionReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { selectable: false, valid: false, reason: "not_an_object" };
  }

  const reportId = cleanText(report.report_id);
  const generated = normalizePromotionTimestamp(report.generated_at);
  if (!reportId || !generated) {
    return {
      selectable: false,
      valid: false,
      report_id: reportId || null,
      reason: !reportId ? "missing_report_id" : "invalid_generated_at"
    };
  }

  const signatureState = verifyPromotionSignature(report);
  const signedPayload = signatureState.verified ? report.signed_payload : null;
  const trustedMarker = cleanText(signedPayload?.signed_report_marker);
  const trustedStrategyVersion = cleanText(signedPayload?.strategy_version);
  const trustedTargetState = cleanText(signedPayload?.target_state);
  const trustedDecision = cleanText(signedPayload?.promotion_decision);
  const trustedGenerated = normalizePromotionTimestamp(signedPayload?.generated_at);
  const trustedReportId = cleanText(signedPayload?.report_id);
  const trustedAllowed = signedPayload?.promotion_allowed === true;
  const trustedProof = signedPayload?.readiness_proof && typeof signedPayload.readiness_proof === "object" && !Array.isArray(signedPayload.readiness_proof)
    ? signedPayload.readiness_proof
    : null;

  const claimsRequestedStrategy = signatureState.verified
    ? trustedStrategyVersion
    : cleanText(report.strategy_version);

  const canonicalEnvelope = {
    report_id: reportId,
    generated_at: generated.iso
  };
  const canonicalFingerprint = stableStringify({
    envelope: canonicalEnvelope,
    signed_payload_hash: signatureState.payloadHash || null,
    signature: report.signature || null,
    signed_payload: signedPayload || null
  });

  const trustedSummary = signatureState.verified ? {
    report_id: trustedReportId,
    generated_at: trustedGenerated?.iso || null,
    signed_report_marker: trustedMarker,
    strategy_version: trustedStrategyVersion,
    target_state: trustedTargetState,
    promotion_decision: trustedDecision,
    promotion_allowed: trustedAllowed,
    readiness_summary: signedPayload.readiness_summary || null,
    readiness_proof: trustedProof
  } : null;

  return {
    selectable: true,
    valid: true,
    report_id: reportId,
    generated_at: generated.iso,
    generated_at_ms: generated.ms,
    fingerprint: canonicalFingerprint,
    signature_state: signatureState.state,
    signature_verified: signatureState.verified,
    signature: cleanText(report.signature),
    signed_payload_hash: cleanText(report.signed_payload_hash),
    envelope: {
      report_id: reportId,
      generated_at: generated.iso,
      strategy_version: cleanText(report.strategy_version),
      target_state: cleanText(report.target_state),
      promotion_decision: cleanText(report.promotion_decision),
      promotion_allowed: report.promotion_allowed === true,
      signed_report_marker: cleanText(report.signed_report_marker)
    },
    trusted: trustedSummary,
    claims_requested_strategy: cleanText(claimsRequestedStrategy),
    claim_source: signatureState.verified ? "signed_payload" : "envelope",
    signed_payload_available: Boolean(report.signed_payload && typeof report.signed_payload === "object" && !Array.isArray(report.signed_payload)),
    signature_state_detail: signatureState
  };
}

function groupPromotionReports(reports = []) {
  const selectable = [];
  for (const [index, report] of (Array.isArray(reports) ? reports : []).entries()) {
    const normalized = normalizePromotionReport(report);
    if (!normalized.selectable) continue;
    selectable.push({ ...normalized, source_index: index });
  }

  const grouped = new Map();
  for (const entry of selectable) {
    const current = grouped.get(entry.report_id) || [];
    current.push(entry);
    grouped.set(entry.report_id, current);
  }

  const diagnostics = [];
  const canonical = [];
  for (const [reportId, variants] of [...grouped.entries()].sort((left, right) => ordinalCompare(left[0], right[0]))) {
    const byFingerprint = new Map();
    for (const variant of variants) {
      const list = byFingerprint.get(variant.fingerprint) || [];
      list.push(variant);
      byFingerprint.set(variant.fingerprint, list);
    }
    if (byFingerprint.size > 1) {
      diagnostics.push({ code: "conflicting_duplicate_promotion_report_id", report_id: reportId, detail: "Conflicting duplicate promotion reports were excluded." });
      continue;
    }
    if (variants.length > 1) {
      diagnostics.push({ code: "duplicate_promotion_report_id", report_id: reportId, detail: "Equivalent duplicate promotion reports counted once." });
    }
    canonical.push(byFingerprint.values().next().value[0]);
  }

  canonical.sort((left, right) =>
    right.generated_at_ms - left.generated_at_ms
    || ordinalCompare(right.report_id, left.report_id)
    || ordinalCompare(right.fingerprint, left.fingerprint)
  );

  return { reports: canonical, diagnostics };
}

function buildReadinessSnapshot(readiness = null, strategyVersion = null) {
  const ready = readiness && typeof readiness === "object" ? readiness : null;
  const proof = canonicalProof(ready);
  return {
    strategy_version: ready?.strategy_version || strategyVersion || null,
    readiness_met: Boolean(ready?.readiness_met),
    required_consecutive_cycles: ready?.required_consecutive_cycles ?? LIVE_READINESS_POLICY.required_consecutive_cycles,
    qualifying_grades: Array.isArray(ready?.qualifying_grades) ? [...ready.qualifying_grades] : [...LIVE_READINESS_POLICY.qualifying_grades],
    current_qualifying_streak: ready?.current_qualifying_streak ?? 0,
    remaining_qualifying_cycles: ready?.remaining_qualifying_cycles ?? LIVE_READINESS_POLICY.required_consecutive_cycles,
    progress_pct: ready?.progress_pct ?? 0,
    latest_cycle: ready?.latest_cycle || null,
    threshold_cycle: ready?.threshold_cycle || null,
    blockers: Array.isArray(ready?.blockers) ? ready.blockers.map((blocker) => ({ ...blocker })) : [],
    diagnostics: Array.isArray(ready?.diagnostics) ? ready.diagnostics.map((item) => ({ ...item })) : [],
    readiness_proof: proof
  };
}

export function evaluatePromotionActivation(options = {}) {
  const strategyVersion = cleanText(options.strategyVersion || options.readiness?.strategy_version);
  const requestedTargetState = cleanText(options.targetState);
  const readiness = options.readiness && typeof options.readiness === "object"
    ? options.readiness
    : evaluateLiveReadiness({
        strategyVersion,
        reports: Array.isArray(options.readinessReports) ? options.readinessReports : undefined,
        reportsDir: options.readinessReportsDir || DEFAULT_REPORTS_DIR,
        policy: options.policy || undefined
      });
  const readinessSnapshot = buildReadinessSnapshot(readiness, strategyVersion);
  const promotionSource = Array.isArray(options.promotionReports)
    ? { reports: options.promotionReports, diagnostics: [] }
    : loadReportsFromDirectory(options.promotionReportsDir || path.join(ROOT, "reports", "promotions"));
  const grouped = groupPromotionReports(promotionSource.reports);
  const diagnostics = [
    ...(Array.isArray(readinessSnapshot.diagnostics) ? readinessSnapshot.diagnostics : []),
    ...(promotionSource.error ? [{ code: "promotion_reports_unavailable", detail: String(promotionSource.error), reports_dir: options.promotionReportsDir || path.join(ROOT, "reports", "promotions") }] : []),
    ...promotionSource.diagnostics,
    ...grouped.diagnostics
  ];
  const activation = {
    strategy_version: strategyVersion,
    target_state: requestedTargetState,
    readiness: readinessSnapshot,
    confirmation: {
      selected_candidate: null,
      selected_report_id: null,
      report_count: grouped.reports.length,
      structurally_selectable_report_count: promotionSource.reports.length,
      envelope_match: false,
      signature_verified: false,
      signature_state: null,
      timestamp_match: false,
      readiness_epoch_match: false,
      trusted_fields: null,
      untrusted_envelope: null,
      claim_source: null
    },
    blockers: [],
    diagnostics
  };

  const addBlocker = (code, detail) => {
    if (!activation.blockers.some((blocker) => blocker.code === code)) {
      activation.blockers.push({ code, detail });
    }
  };

  if (requestedTargetState && !LIVE_PROMOTION_TARGET_STATES.includes(requestedTargetState)) {
    addBlocker("confirmation_non_live_target", "Activation is only available for tiny_live or scaled_live targets.");
  }
  if (!readinessSnapshot.readiness_met) {
    addBlocker("readiness_not_met", "Promotion readiness has not reached the immutable 50-cycle threshold.");
  }

  const candidate = grouped.reports.find((report) => report.claims_requested_strategy === strategyVersion) || null;
  if (!candidate) {
    addBlocker("missing_confirmation", "No structurally selectable promotion report claimed the requested strategy.");
    activation.confirmation.selected_candidate = null;
    activation.activation_allowed = false;
    return activation;
  }

  activation.confirmation.selected_candidate = {
    report_id: candidate.report_id,
    generated_at: candidate.generated_at,
    signature_verified: candidate.signature_verified,
    signature_state: candidate.signature_state,
    claim_source: candidate.claim_source,
    untrusted_envelope: candidate.envelope,
    trusted_fields: candidate.trusted
  };
  activation.confirmation.selected_report_id = candidate.report_id;
  activation.confirmation.signature_verified = candidate.signature_verified;
  activation.confirmation.signature_state = candidate.signature_state;
  activation.confirmation.claim_source = candidate.claim_source;
  activation.confirmation.untrusted_envelope = candidate.envelope;
  activation.confirmation.trusted_fields = candidate.trusted;

  if (!candidate.signature_verified) {
    if (!candidate.signature_state_detail?.signature) {
      addBlocker("confirmation_missing_signature", "The selected confirmation candidate does not carry a signature.");
    } else {
      addBlocker("confirmation_invalid_signature", `The selected confirmation candidate failed signature verification (${candidate.signature_state}).`);
    }
  }

  if (candidate.signature_verified) {
    const trusted = candidate.trusted || {};
    const envelope = candidate.envelope || {};
    const envelopeMatch = comparePromotionEnvelopeAndPayload(trusted, envelope);
    activation.confirmation.envelope_match = envelopeMatch;
    activation.confirmation.timestamp_match = Boolean(trusted.generated_at && readinessSnapshot.threshold_cycle && new Date(trusted.generated_at).getTime() > new Date(readinessSnapshot.threshold_cycle.generated_at).getTime());
    activation.confirmation.readiness_epoch_match = readinessEpochMatches(trusted.readiness_proof, readinessSnapshot.readiness_proof);

    if (!envelopeMatch) addBlocker("confirmation_signed_payload_mismatch", "The signed payload and envelope do not match for the selected confirmation.");
    if (!LIVE_PROMOTION_TARGET_STATES.includes(trusted.target_state)) addBlocker("confirmation_non_live_target", "The signed confirmation target is not live-capable.");
    if (trusted.promotion_allowed !== true) addBlocker("confirmation_promotion_blocked", "The signed confirmation is blocked.");
    if (!activation.confirmation.timestamp_match) addBlocker("confirmation_not_after_readiness", "The signed confirmation was created at or before the readiness threshold cycle.");
    if (!activation.confirmation.readiness_epoch_match) addBlocker("confirmation_stale_readiness_epoch", "The signed readiness proof does not match the current readiness epoch.");
  } else {
    if (!LIVE_PROMOTION_TARGET_STATES.includes(candidate.envelope.target_state)) {
      addBlocker("confirmation_non_live_target", "The confirmation candidate does not point to a live-capable target.");
    }
    if (candidate.envelope.promotion_allowed !== true) {
      addBlocker("confirmation_promotion_blocked", "The confirmation candidate is marked as blocked.");
    }
  }

  activation.activation_allowed = activation.blockers.length === 0;
  return activation;
}

export function buildLiveReadinessActivationSummary(options = {}) {
  const readiness = options.readiness && typeof options.readiness === "object"
    ? options.readiness
    : evaluateLiveReadiness({
        strategyVersion: options.strategyVersion,
        reports: Array.isArray(options.readinessReports) ? options.readinessReports : undefined,
        reportsDir: options.readinessReportsDir || DEFAULT_REPORTS_DIR,
        policy: options.policy || undefined
      });
  const activation = options.activation && typeof options.activation === "object"
    ? options.activation
    : evaluatePromotionActivation({
        strategyVersion: options.strategyVersion || readiness.strategy_version,
        readiness,
        targetState: options.targetState || LIVE_PROMOTION_TARGET_STATES[0],
        promotionReports: Array.isArray(options.promotionReports) ? options.promotionReports : undefined,
        promotionReportsDir: options.promotionReportsDir || path.join(ROOT, "reports", "promotions"),
        readinessReports: Array.isArray(options.readinessReports) ? options.readinessReports : undefined,
        readinessReportsDir: options.readinessReportsDir || DEFAULT_REPORTS_DIR,
        policy: options.policy || undefined
      });

  return {
    ...readiness,
    activation_allowed: Boolean(activation.activation_allowed),
    confirmation: activation.confirmation ? { ...activation.confirmation } : null,
    activation_blockers: cloneBlockers(activation.blockers),
    next_action: readiness.readiness_met
      ? (activation.activation_allowed ? "live_eligible" : "request_live_promotion_confirmation")
      : "continue_paper_validation"
  };
}

export function inspectPromotionConfirmation(report = {}) {
  const normalized = normalizePromotionReport(report);
  if (!normalized.selectable) {
    return {
      selectable: false,
      valid: false,
      report_id: normalized.report_id || null,
      generated_at: null,
      signature_verified: false,
      signature_state: null,
      signature_state_detail: null,
      claim_source: null,
      untrusted_envelope: null,
      trusted_fields: null,
      envelope_match: false,
      signed_report_identity: null,
      signed_timestamp: null,
      readiness: null,
      threshold_cycle: null
    };
  }

  const envelope = normalized.envelope || null;
  const trusted = normalized.trusted || null;
  const envelopeMatch = normalized.signature_verified ? comparePromotionEnvelopeAndPayload(trusted, envelope) : false;

  return {
    selectable: true,
    valid: true,
    report_id: normalized.report_id,
    generated_at: normalized.generated_at,
    signature_verified: normalized.signature_verified,
    signature_state: normalized.signature_state,
    signature_state_detail: normalized.signature_state_detail,
    claim_source: normalized.claim_source,
    untrusted_envelope: envelope ? { ...envelope } : null,
    trusted_fields: trusted ? { ...trusted } : null,
    envelope_match: envelopeMatch,
    signed_report_identity: trusted ? {
      report_id: trusted.report_id || null,
      generated_at: trusted.generated_at || null,
      signed_report_marker: trusted.signed_report_marker || null,
      strategy_version: trusted.strategy_version || null
    } : null,
    signed_timestamp: trusted?.generated_at || null,
    readiness: trusted?.readiness_summary && typeof trusted.readiness_summary === "object" ? { ...trusted.readiness_summary } : null,
    threshold_cycle: trusted?.readiness_proof?.threshold_cycle ? { ...trusted.readiness_proof.threshold_cycle } : null
  };
}

export function readPromotionReportsFromDirectory(promotionReportsDir = path.join(ROOT, "reports", "promotions")) {
  return loadReportsFromDirectory(promotionReportsDir);
}

export { loadReportsFromDirectory };
