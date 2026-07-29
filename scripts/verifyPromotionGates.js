import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { evaluatePromotionGates } from "./promotionGates.js";
import {
  PROMOTION_SIGNED_REPORT_MARKER,
  evaluateLiveReadinessFromReports,
  evaluatePromotionActivation
} from "./liveReadiness.js";
import {
  buildProfessionalDashboardSummary,
  buildReadinessApiResponse,
  resolveReadinessStrategyVersion,
  summarizePromotionReport
} from "../server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STRATEGY = "fixture-live-readiness-v1";
const OTHER_STRATEGY = "fixture-live-readiness-other-v1";
const BASE_MS = Date.parse("2026-07-29T00:00:00.000Z");

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function buildReadinessProof(readiness) {
  return {
    strategy_version: readiness.strategy_version,
    required_consecutive_cycles: readiness.required_consecutive_cycles,
    qualifying_grades: [...readiness.qualifying_grades],
    readiness_met: readiness.readiness_met,
    threshold_cycle: readiness.threshold_cycle ? {
      report_id: readiness.threshold_cycle.report_id,
      generated_at: readiness.threshold_cycle.generated_at
    } : null
  };
}

function makeManagerReport(index, overrides = {}) {
  const grade = overrides.overall_grade || (index % 2 === 0 ? "B" : "A");
  return {
    report_id: overrides.report_id || `cycle-${String(index).padStart(3, "0")}`,
    generated_at: overrides.generated_at || new Date(BASE_MS + (index - 1) * 60_000).toISOString(),
    strategy_version: overrides.strategy_version || STRATEGY,
    overall_grade: grade,
    ...overrides
  };
}

function makeReadinessReports(count, strategyVersion = STRATEGY, startIndex = 1, options = {}) {
  const reports = [];
  for (let index = 0; index < count; index += 1) {
    reports.push(makeManagerReport(startIndex + index, {
      strategy_version: strategyVersion,
      overall_grade: Array.isArray(options.grades) ? options.grades[index] || "A" : (options.grade || "A"),
      generated_at: new Date((options.baseMs || BASE_MS) + index * 60_000).toISOString()
    }));
  }
  return reports;
}

function makeReadinessSequence() {
  return [
    ...makeReadinessReports(50, STRATEGY, 1, { grade: "A" }),
    makeManagerReport(51, {
      report_id: "cycle-reset",
      overall_grade: "C",
      generated_at: new Date(BASE_MS + 50 * 60_000).toISOString()
    }),
    makeManagerReport(52, {
      report_id: "cycle-after-reset-1",
      overall_grade: "A",
      generated_at: new Date(BASE_MS + 51 * 60_000).toISOString()
    }),
    makeManagerReport(53, {
      report_id: "cycle-after-reset-2",
      overall_grade: "B",
      generated_at: new Date(BASE_MS + 52 * 60_000).toISOString()
    })
  ];
}

function signPromotionPayload(payload) {
  const payloadHash = sha256(stableStringify(payload));
  return {
    signed: true,
    signature_scheme: "sha256-stable-json",
    signer: "promotion_gates",
    signed_at: payload.generated_at,
    signed_payload_hash: payloadHash,
    signature: sha256(`promotion_gates:${payloadHash}`)
  };
}

function makePromotionReport(readiness, overrides = {}) {
  const targetState = overrides.target_state || "tiny_live";
  const reportId = overrides.report_id || `promotion-${sha256(`${readiness.threshold_cycle?.report_id || "unknown"}:${targetState}:${overrides.report_suffix || "base"}`).slice(0, 16)}`;
  const signedGeneratedAt = overrides.signed_generated_at
    || new Date((overrides.signed_generated_at_ms || (Date.parse(readiness.threshold_cycle.generated_at) + 60_000))).toISOString();
  const signedPayload = {
    report_id: reportId,
    generated_at: signedGeneratedAt,
    signed_report_marker: PROMOTION_SIGNED_REPORT_MARKER,
    strategy_version: overrides.strategy_version || STRATEGY,
    target_state: targetState,
    promotion_decision: overrides.promotion_decision || `approved_for_${targetState}`,
    promotion_allowed: overrides.promotion_allowed !== false,
    blockers: overrides.blockers || [],
    warnings: overrides.warnings || [],
    readiness_summary: readiness,
    readiness_proof: buildReadinessProof(readiness),
    ...overrides.signed_payload_overrides
  };
  const report = {
    report_id: reportId,
    report_type: "strategy_promotion_gate",
    schema_version: "1.0",
    generated_at: overrides.envelope_generated_at || signedGeneratedAt,
    strategy_version: overrides.envelope_strategy_version || signedPayload.strategy_version,
    target_state: overrides.envelope_target_state || signedPayload.target_state,
    promotion_decision: overrides.envelope_promotion_decision || signedPayload.promotion_decision,
    promotion_allowed: overrides.envelope_promotion_allowed ?? signedPayload.promotion_allowed,
    signed_report_marker: overrides.envelope_signed_report_marker || signedPayload.signed_report_marker,
    signed_payload: signedPayload
  };
  return {
    ...report,
    ...signPromotionPayload(signedPayload),
    ...(overrides.envelope_overrides || {})
  };
}

function activationCodes(result) {
  return (result?.blockers || []).map((blocker) => blocker.code);
}

function assertBlocked(result, expectedCodes, message) {
  assert.equal(result.activation_allowed, false, message || "activation should be blocked");
  for (const code of expectedCodes) {
    assert(activationCodes(result).includes(code), `expected blocker ${code}`);
  }
}

function assertAllowed(result, message) {
  assert.equal(result.activation_allowed, true, message || "activation should be allowed");
  assert.equal(result.blockers.length, 0, "allowed activation should not have blockers");
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e3d-promotion-gates-"));
try {
  const fortyNine = makeReadinessReports(49);
  const ready50 = evaluateLiveReadinessFromReports(makeReadinessReports(50), { strategyVersion: STRATEGY });
  const ready55 = evaluateLiveReadinessFromReports(makeReadinessReports(55), { strategyVersion: STRATEGY });
  const resetReady = evaluateLiveReadinessFromReports(makeReadinessSequence(), { strategyVersion: STRATEGY });
  const otherReady = evaluateLiveReadinessFromReports(makeReadinessReports(50, OTHER_STRATEGY), { strategyVersion: OTHER_STRATEGY });

  const blocked49 = evaluateLiveReadinessFromReports(fortyNine, { strategyVersion: STRATEGY });
  assert.equal(blocked49.readiness_met, false, "49 qualifying cycles should remain blocked");
  assert.equal(blocked49.current_qualifying_streak, 49);
  assert.equal(blocked49.remaining_qualifying_cycles, 1);
  assert.equal(blocked49.progress_pct, 98);

  assert.equal(ready50.readiness_met, true, "50 qualifying cycles should unlock readiness");
  assert.equal(ready50.current_qualifying_streak, 50);
  assert.equal(ready50.remaining_qualifying_cycles, 0);
  assert.equal(ready50.progress_pct, 100);
  assert.equal(ready50.threshold_cycle.report_id, "cycle-050");

  const validApproval = makePromotionReport(ready50, { report_suffix: "valid" });
  const activationReady50 = evaluatePromotionActivation({
    strategyVersion: STRATEGY,
    readiness: ready50,
    promotionReports: [validApproval]
  });
  assertAllowed(activationReady50, "valid readiness and approval should activate");
  assert.equal(activationReady50.confirmation.selected_report_id, validApproval.report_id);
  assert.equal(activationReady50.confirmation.signature_verified, true);

  const activationReady55 = evaluatePromotionActivation({
    strategyVersion: STRATEGY,
    readiness: ready55,
    promotionReports: [validApproval]
  });
  assertAllowed(activationReady55, "later A/B cycles in the same epoch should preserve approval");
  assert.deepEqual(activationReady55.confirmation.trusted_fields.readiness_proof, buildReadinessProof(ready50));

  const activationOtherStrategy = evaluatePromotionActivation({
    strategyVersion: STRATEGY,
    readiness: otherReady,
    promotionReports: [validApproval]
  });
  assertBlocked(activationOtherStrategy, ["confirmation_stale_readiness_epoch"], "readiness from a different strategy should not satisfy activation");

  const activationReadinessOnly = evaluatePromotionActivation({
    strategyVersion: STRATEGY,
    readiness: ready50,
    promotionReports: []
  });
  assertBlocked(activationReadinessOnly, ["missing_confirmation"], "readiness alone should not activate");

  const staleApproval = evaluatePromotionActivation({
    strategyVersion: STRATEGY,
    readiness: resetReady,
    promotionReports: [validApproval]
  });
  assertBlocked(staleApproval, ["confirmation_stale_readiness_epoch"], "reset should stale the older approval");

  const laterReadyReports = [
    ...makeReadinessReports(50, STRATEGY, 1, { grade: "A" }),
    makeManagerReport(51, { report_id: "cycle-reset-2", overall_grade: "C", generated_at: new Date(BASE_MS + 50 * 60_000).toISOString() }),
    ...makeReadinessReports(50, STRATEGY, 52, { grade: "B", baseMs: BASE_MS + 51 * 60_000 })
  ];
  const laterReady = evaluateLiveReadinessFromReports(laterReadyReports, { strategyVersion: STRATEGY });
  assert.equal(laterReady.threshold_cycle.report_id, "cycle-101");
  const newApproval = makePromotionReport(laterReady, { report_suffix: "new-streak" });
  assertBlocked(
    evaluatePromotionActivation({ strategyVersion: STRATEGY, readiness: ready50, promotionReports: [newApproval] }),
    ["confirmation_stale_readiness_epoch"],
    "a later streak approval should not validate against the old epoch"
  );
  assertAllowed(
    evaluatePromotionActivation({ strategyVersion: STRATEGY, readiness: laterReady, promotionReports: [newApproval] }),
    "a new approval bound to the new threshold should activate"
  );

  const apiReady49 = buildReadinessApiResponse({
    strategyVersion: STRATEGY,
    readinessReports: fortyNine,
    promotionReports: []
  });
  assert.equal(apiReady49.readiness_met, false, "readiness api should mirror blocked progress");
  assert.equal(apiReady49.next_action, "continue_paper_validation");
  assert(apiReady49.activation_blockers.some((blocker) => blocker.code === "readiness_not_met"));

  const apiReady50 = buildReadinessApiResponse({
    strategyVersion: STRATEGY,
    readinessReports: makeReadinessReports(50),
    promotionReports: [validApproval]
  });
  assert.equal(apiReady50.readiness_met, true, "readiness api should expose readiness");
  assert.equal(apiReady50.activation_allowed, true, "readiness api should expose activation state");
  assert.equal(apiReady50.next_action, "live_eligible", "ready and confirmed strategy should be live eligible");
  assert.equal(apiReady50.confirmation.signature_verified, true, "confirmation should report verified signed payloads");

  const apiReady50NoConfirmation = buildReadinessApiResponse({
    strategyVersion: STRATEGY,
    readinessReports: makeReadinessReports(50),
    promotionReports: []
  });
  assert.equal(apiReady50NoConfirmation.next_action, "request_live_promotion_confirmation", "ready but unconfirmed strategy should request confirmation");
  assert(apiReady50NoConfirmation.activation_blockers.some((blocker) => blocker.code === "missing_confirmation"));

  const explicitStrategy = resolveReadinessStrategyVersion(new URLSearchParams("strategy_version=fixture-live-readiness-v1"));
  assert.equal(explicitStrategy.strategyVersion, STRATEGY);
  assert.equal(resolveReadinessStrategyVersion(new URLSearchParams("")).strategyVersion, "paper-pipeline-v1");
  assert.equal(resolveReadinessStrategyVersion(new URLSearchParams("strategy_version=")).error.code, "INVALID_STRATEGY_VERSION");
  assert.equal(resolveReadinessStrategyVersion(new URLSearchParams("strategy_version=one&strategy_version=two")).error.code, "INVALID_STRATEGY_VERSION");

  const sameEpochApproval = makePromotionReport(ready50, { report_suffix: "same-epoch" });
  assertAllowed(
    evaluatePromotionActivation({ strategyVersion: STRATEGY, readiness: ready55, promotionReports: [sameEpochApproval] }),
    "same approval should remain valid after extra qualifying cycles"
  );

  const atThreshold = makePromotionReport(ready50, {
    report_suffix: "threshold",
    signed_generated_at: ready50.threshold_cycle.generated_at
  });
  assertBlocked(
    evaluatePromotionActivation({ strategyVersion: STRATEGY, readiness: ready50, promotionReports: [atThreshold] }),
    ["confirmation_not_after_readiness"],
    "confirmation timestamp at the threshold should fail closed"
  );

  const envelopeLaterButSignedEarlier = makePromotionReport(ready50, {
    report_suffix: "envelope-later",
    signed_generated_at: new Date(Date.parse(ready50.threshold_cycle.generated_at) - 60_000).toISOString(),
    envelope_generated_at: new Date(Date.parse(ready50.threshold_cycle.generated_at) + 60_000).toISOString()
  });
  assertBlocked(
    evaluatePromotionActivation({ strategyVersion: STRATEGY, readiness: ready50, promotionReports: [envelopeLaterButSignedEarlier] }),
    ["confirmation_not_after_readiness"],
    "an unsigned later envelope timestamp cannot rescue an earlier signed confirmation"
  );

  const unsignedApproval = makePromotionReport(ready50, { report_suffix: "unsigned" });
  delete unsignedApproval.signature;
  delete unsignedApproval.signed_payload_hash;
  delete unsignedApproval.signed;
  assertBlocked(
    evaluatePromotionActivation({ strategyVersion: STRATEGY, readiness: ready50, promotionReports: [unsignedApproval] }),
    ["confirmation_missing_signature"],
    "unsigned confirmations must fail closed"
  );

  const invalidSignatureApproval = makePromotionReport(ready50, { report_suffix: "invalid-sig" });
  invalidSignatureApproval.signature = `${invalidSignatureApproval.signature}-tampered`;
  assertBlocked(
    evaluatePromotionActivation({ strategyVersion: STRATEGY, readiness: ready50, promotionReports: [invalidSignatureApproval] }),
    ["confirmation_invalid_signature"],
    "tampered signatures must fail closed"
  );

  const blockedApproval = makePromotionReport(ready50, { report_suffix: "blocked", promotion_allowed: false, promotion_decision: "blocked" });
  assertBlocked(
    evaluatePromotionActivation({ strategyVersion: STRATEGY, readiness: ready50, promotionReports: [blockedApproval] }),
    ["confirmation_promotion_blocked"],
    "blocked promotions cannot activate"
  );

  const nonLiveApproval = makePromotionReport(ready50, { report_suffix: "nonlive", target_state: "paper", promotion_decision: "approved_for_paper" });
  assertBlocked(
    evaluatePromotionActivation({ strategyVersion: STRATEGY, readiness: ready50, promotionReports: [nonLiveApproval] }),
    ["confirmation_non_live_target"],
    "non-live targets cannot activate"
  );

  const tamperedEnvelopeCases = [
    ["strategy", { envelope_strategy_version: OTHER_STRATEGY }],
    ["target", { envelope_target_state: "paper" }],
    ["decision", { envelope_promotion_decision: "blocked" }],
    ["marker", { envelope_signed_report_marker: "other_marker" }],
    ["report_id", { envelope_overrides: { report_id: "promotion-tampered-report" } }],
    ["generated_at", { envelope_generated_at: new Date(Date.parse(ready50.threshold_cycle.generated_at) + 5 * 60_000).toISOString() }]
  ];
  for (const [label, overrides] of tamperedEnvelopeCases) {
    const tampered = makePromotionReport(ready50, { report_suffix: `tampered-${label}`, ...overrides });
    const activation = evaluatePromotionActivation({ strategyVersion: STRATEGY, readiness: ready50, promotionReports: [tampered] });
    assert.equal(activation.activation_allowed, false, `tampered envelope ${label} must fail closed`);
    assert(
      activationCodes(activation).includes("confirmation_signed_payload_mismatch")
      || activationCodes(activation).includes("confirmation_non_live_target")
      || activationCodes(activation).includes("confirmation_promotion_blocked"),
      `tampered envelope ${label} should report a confirmation blocker`
    );
  }

  const conflictingId = "promotion-conflicting-id";
  const conflictingA = makePromotionReport(ready50, { report_id: conflictingId, report_suffix: "conflict-a" });
  const conflictingB = makePromotionReport(ready50, {
    report_id: conflictingId,
    report_suffix: "conflict-b",
    signed_payload_overrides: { promotion_decision: "blocked", promotion_allowed: false }
  });
  const conflictingActivation = evaluatePromotionActivation({
    strategyVersion: STRATEGY,
    readiness: ready50,
    promotionReports: [conflictingA, conflictingB]
  });
  assertBlocked(conflictingActivation, ["missing_confirmation"], "conflicting duplicate IDs must fail closed");
  assert(
    conflictingActivation.diagnostics.some((item) => item.code === "conflicting_duplicate_promotion_report_id"),
    "conflicting duplicate IDs should be diagnosed"
  );

  const newerInvalid = makePromotionReport(ready50, { report_suffix: "newer-invalid", signed_payload_overrides: { promotion_allowed: false, promotion_decision: "blocked" } });
  newerInvalid.generated_at = new Date(Date.parse(validApproval.generated_at) + 60_000).toISOString();
  const olderValid = makePromotionReport(ready50, { report_suffix: "older-valid" });
  const blockedByNewerInvalid = evaluatePromotionActivation({
    strategyVersion: STRATEGY,
    readiness: ready50,
    promotionReports: [olderValid, newerInvalid]
  });
  assertBlocked(blockedByNewerInvalid, ["confirmation_promotion_blocked"], "newer invalid candidates should block older approvals");

  const newerInvalidUnrelated = makePromotionReport(ready50, {
    report_suffix: "newer-unrelated",
    strategy_version: OTHER_STRATEGY,
    signed_payload_overrides: { strategy_version: OTHER_STRATEGY }
  });
  newerInvalidUnrelated.generated_at = new Date(Date.parse(validApproval.generated_at) + 60_000).toISOString();
  const unrelatedBypass = evaluatePromotionActivation({
    strategyVersion: STRATEGY,
    readiness: ready50,
    promotionReports: [olderValid, newerInvalidUnrelated]
  });
  assertAllowed(unrelatedBypass, "an unrelated newer invalid report must not block an older valid approval");

  const backtestFixture = {
    report_id: "fixture-backtest",
    report_type: "backtest_replay",
    schema_version: "1.0",
    generated_at: "2026-04-28T00:00:00.000Z",
    strategy_version: STRATEGY,
    input_hash: "fixture-input-hash",
    determinism: { output_hash: "fixture-output-hash" },
    metrics: {
      initial_equity_usd: 100000,
      final_equity_usd: 100100,
      total_return_pct: 0.1,
      realized_pnl_usd: 100,
      unrealized_pnl_usd: 0,
      profit_factor: 2,
      max_drawdown_pct: 0.1,
      turnover_ratio: 0.01,
      fee_slippage_drag_usd: 4
    },
    baselines: {
      cash: { total_return_pct: 0 },
      buy_and_hold_eth: { available: false }
    },
    replay: {
      simulated_fills: [
        {
          ts: "2026-04-27T00:00:00.000Z",
          symbol: "AAA",
          replay_decision: "filled",
          fill: {
            realized_pnl_usd: 120,
            gross_notional_usd: 1000,
            fee_usd: 1,
            slippage_usd: 1
          }
        },
        {
          ts: "2026-04-27T01:00:00.000Z",
          symbol: "AAA",
          replay_decision: "filled",
          fill: {
            realized_pnl_usd: -20,
            gross_notional_usd: 1000,
            fee_usd: 1,
            slippage_usd: 1
          }
        }
      ]
    }
  };
  fs.writeFileSync(path.join(tempRoot, "backtest.json"), `${JSON.stringify(backtestFixture, null, 2)}\n`, "utf8");
  const underSampled = evaluatePromotionGates({
    backtestReport: path.join(tempRoot, "backtest.json"),
    targetState: "paper",
    appendEvent: false,
    writeReport: false,
    generatedAt: "2026-07-29T00:00:00.000Z",
    readinessReportsDir: tempRoot
  });
  assert.equal(underSampled.promotion_allowed, false, "under-sampled backtests should remain blocked");
  assert(underSampled.blockers.some((blocker) => blocker.code === "minimum_sample_size_not_met"));

  const liveReadinessSummary = apiReady50;
  const promotionSummary = summarizePromotionReport(validApproval);
  assert.equal(promotionSummary.readiness?.threshold_cycle?.report_id, ready50.threshold_cycle.report_id, "promotion summaries should surface readiness");
  assert.equal(promotionSummary.signed_timestamp, validApproval.signed_payload.generated_at, "promotion summaries should surface the signed timestamp");
  assert.equal(promotionSummary.signature_verification.signature_verified, true, "promotion summaries should surface signature verification");

  const dashboard = await buildProfessionalDashboardSummary({
    portfolio: {
      settings: { paper_mode: true },
      stats: { market_regime: "unknown" },
      positions: {},
      closed_trades: [],
      action_history: []
    },
    trainingEvents: [],
    performanceReport: null,
    backtestReport: null,
    promotionReport: validApproval,
    attributionReport: null,
    operationsReport: { overall_status: "ok", alerts: { active_count: 0 }, incidents: { active_count: 0 }, health: { pipeline: { status: "ok" }, dashboard: { status: "ok" }, order_queue: { status: "ok" } } },
    reconciliationReport: null,
    liveReadiness: liveReadinessSummary
  });
  assert.deepEqual(dashboard.strategy.live_readiness, liveReadinessSummary, "professional summary should embed live readiness without mutation");

  console.log(JSON.stringify({
    verified: true,
    cases: [
      "49 blocked",
      "50 unlocks",
      "activation success",
      "strategy isolation",
      "readiness only blocked",
      "epoch reset stale",
      "new epoch approval",
      "timestamp gating",
      "unsigned blocked",
      "invalid signature blocked",
      "blocked approval blocked",
      "non-live blocked",
      "envelope tampering blocked",
      "conflicting duplicate ids blocked",
      "newer invalid blocks older valid",
      "newer unrelated invalid bypassed",
      "api readiness summary",
      "strategy-version validation",
      "promotion summary metadata",
      "professional summary live readiness",
      "under-sampled backtest blocked"
    ]
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
