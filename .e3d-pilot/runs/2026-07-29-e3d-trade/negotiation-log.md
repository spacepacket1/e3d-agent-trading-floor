---
run_id: 2026-07-29-e3d-trade
---

# Negotiation Log

## Round 1

### Draft Before Round

```text
# Performance-Gated Paper-to-Live Readiness

## Overview

Replace config-only paper-to-live promotion with a deterministic progression gate based on the Manager’s existing A–F cycle grades. A strategy becomes live-ready only after 50 consecutive Manager cycles graded A or B, followed by an explicit, cryptographically verified live-state promotion approval. The pipeline must fail closed to paper mode when either condition is absent.

Expose machine-readable readiness progress through the existing server APIs. Dashboard UI changes are excluded because `dashboard/**` is protected.

## Goals

- Track consecutive qualifying Manager cycles per strategy version.
- Require 50 consecutive A/B cycles for live readiness.
- Reset progress on any C, D, or F cycle.
- Prevent reports from different strategy versions from being combined.
- Require an explicit, cryptographically verified signed promotion approval after readiness is achieved.
- Force requested live operation back to paper mode when readiness or confirmation is missing or invalid.
- Expose progress, remaining cycles, blockers, and confirmation state through existing APIs.
- Preserve the current default of paper mode and all existing promotion checks.

## Non-Goals

- Implementing exchange order submission, wallet signing, custody, or new live execution infrastructure.
- Modifying custody, risk-engine, executor, dashboard, installer, cron, or dependency-lock files.
- Adding tiered live capabilities.
- Allowing an environment variable or portfolio setting to reduce the 50-cycle production threshold.
- Treating historical Manager reports without a matching strategy version as qualifying.
- Automatically enabling live mode when the threshold is reached.
- Adding the visual dashboard progress bar; this spec provides the API contract that a later dashboard change can consume.

## Existing Files

- `pipeline.js` creates Manager cycle reports and contains the runtime paper/live decision path.
- `scripts/promotionGates.js` evaluates signed strategy promotion reports for `research`, `paper`, `shadow`, `tiny_live`, and `scaled_live`.
- `scripts/verifyPromotionGates.js` verifies promotion gates with isolated fixtures.
- `server.js` exposes Manager and promotion report APIs plus the professional summary.
- `package.json` defines the configured `npm run check` verification command.
- `README.md` documents paper-mode safety and current live-trading prerequisites.

## Shared Constraints

- Keep the implementation within 8 changed files and 600 changed lines.
- Preserve “AI suggests, code decides”: readiness and activation decisions must be deterministic and outside LLM prompts.
- Production readiness policy is exactly 50 consecutive Manager reports whose `overall_grade` is `A` or `B`.
- Readiness must be evaluated independently for the current strategy version.
- A report qualifies only when it has a non-empty `report_id`, valid `generated_at`, matching `strategy_version`, and recognized `overall_grade`.
- Duplicate `report_id` values count once.
- Sort reports chronologically by `generated_at`, with a stable report-ID tie-breaker.
- Malformed or unrelated files must never contribute qualifying progress.
- Reaching 50 qualifying cycles establishes eligibility only; it must not mutate portfolio settings or activate live execution automatically.
- Live activation additionally requires a cryptographically verified, successful promotion report for the same strategy version and a live-capable target state.
- The verified signed payload must bind the strategy version, target state, promotion decision, and readiness summary used to approve the promotion; values outside the verified payload must not authorize activation.
- Any missing, malformed, mismatched, unsigned, signature-invalid, tampered, or blocked confirmation must fail closed to paper mode.
- Preserve and reuse all existing promotion metrics, custody checks, canonical signing and verification behavior, and audit behavior.
- Do not modify any protected path.
- Use only Node.js built-ins and existing dependencies.
- `npm run check` is the configured verification command for every phase.

## Phase 1 - Deterministic Live-Readiness Tracker

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/verifyLiveReadiness.js -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:read=scripts/verifyPromotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Add `scripts/liveReadiness.js` with side-effect-free exported evaluators that can accept in-memory reports for tests and scan a supplied reports directory for production.
- Define an immutable production policy of:
  - `required_consecutive_cycles: 50`
  - `qualifying_grades: ["A", "B"]`
- Evaluate only Manager cycle reports matching the requested strategy version.
- Deduplicate reports by `report_id`, order them deterministically, and calculate the consecutive qualifying streak ending at the newest valid report.
- Reset the streak to zero after a nonqualifying recognized grade, then count any subsequent A/B reports.
- Return a stable JSON-ready result containing at least:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `valid_cycle_count`
  - `current_qualifying_streak`
  - `remaining_qualifying_cycles`
  - `progress_pct`
  - `readiness_met`
  - `latest_cycle`
  - `blockers`
- Use explicit blocker codes for missing strategy version, insufficient qualifying cycles, and absence of valid matching Manager reports.
- Permit test-only policy injection through function arguments without exposing a production environment-variable override.
- Stamp newly generated Manager reports in `pipeline.js` with the active `PAPER_ORDER_STRATEGY_VERSION` as `strategy_version`.
- Do not retroactively treat unstamped historical reports as belonging to the current strategy.
- Add `scripts/verifyLiveReadiness.js` using temporary fixtures to verify:
  - 49 consecutive A/B reports remain blocked.
  - The 50th consecutive A/B report unlocks readiness.
  - A C grade resets the streak.
  - Reports for another strategy version do not count.
  - Duplicate and malformed reports do not inflate progress.
  - Ordering is deterministic for equal timestamps.
- Add syntax checking and execution of the new verifier to the existing `npm run check` command without replacing or broadening it to another package script.

### Acceptance Criteria

- A strategy with 50 valid consecutive A/B Manager reports returns `readiness_met: true`, zero remaining cycles, and 100% progress.
- A strategy with any shorter terminal streak returns `readiness_met: false` and an `insufficient_qualifying_cycles` blocker.
- A C, D, or F report breaks the preceding streak even when older history contains 50 qualifying reports.
- Reports from other or missing strategy versions cannot contribute progress.
- Repeated evaluation over identical inputs returns deeply equal results.
- Existing Manager report generation remains compatible apart from the additive `strategy_version` field.
- `npm run check` passes.

## Phase 2 - Promotion Confirmation and Runtime Enforcement

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/promotionGates.js -->
<!-- pilot:touches=scripts/verifyPromotionGates.js -->
<!-- pilot:touches=pipeline.js -->
<!-- runner:read=scripts/auditTrail.js -->
<!-- runner:read=README.md -->
<!-- runner:verify=npm run check -->

### Requirements

- Extend the readiness module with an activation evaluator that combines:
  - The current Phase 1 readiness result.
  - The latest applicable promotion report for the same strategy version.
  - A live-capable target state of `tiny_live` or `scaled_live`.
  - `promotion_allowed: true`.
  - A recognized signed-report marker.
  - A non-empty signature that passes the existing cryptographic verification procedure over the canonical signed payload.
- Select promotion reports deterministically using their valid generation timestamp and the existing stable report identifier as a tie-breaker. Malformed candidates must not be treated as confirmations.
- Require the cryptographically verified payload itself to bind the matching `strategy_version`, live-capable target state, `promotion_allowed: true`, and readiness summary. Do not trust duplicate unsigned envelope fields when making activation decisions.
- Return activation status separately from readiness status so reaching the streak never implies automatic activation.
- Add explicit activation blocker codes for missing confirmation, strategy mismatch, non-live target, blocked promotion, missing signature, invalid signature, and signed-payload mismatch.
- Integrate Phase 1 readiness into `evaluatePromotionGates()`:
  - `research`, `paper`, and `shadow` retain their existing behavior.
  - `tiny_live` and `scaled_live` receive a blocking `live_readiness_not_met` gate until the 50-cycle policy is satisfied for the evaluated strategy version.
  - Include the full readiness summary and evaluated strategy version in the canonical payload of the signed promotion report.
  - Preserve every existing gate; readiness is an additional requirement, not a replacement.
- Ensure the promotion command remains an explicit operator action. It may write a signed approval report but must not change `portfolio.json` or automatically disable paper mode.
- At cycle startup, when `portfolio.settings.paper_mode` requests live behavior, evaluate activation for `PAPER_ORDER_STRATEGY_VERSION` using the current readiness result and the deterministically selected promotion report.
- If activation is not allowed, use paper mode for all Risk and Executor decisions in that cycle and emit a structured pipeline warning containing the activation blocker codes.
- Compute the effective paper/live mode once at cycle startup and pass that effective mode consistently to every downstream Risk and Executor decision in the cycle.
- Do not silently bypass the gate when report directories are missing or unreadable.
- Do not change behavior for an already requested paper-mode cycle.
- Extend `scripts/verifyPromotionGates.js` with isolated fixtures proving:
  - An otherwise promotable live target is blocked at 49 qualifying cycles.
  - An otherwise promotable live target is approved at 50 qualifying cycles.
  - Readiness from a different strategy version does not satisfy promotion.
  - Readiness alone does not satisfy runtime activation.
  - An unsigned, signature-invalid, tampered, blocked, non-live, or mismatched promotion report cannot activate live behavior.
  - Altering an unsigned envelope field without changing the verified payload cannot authorize activation.
  - A cryptographically verified successful live promotion whose signed payload binds the matching ready strategy satisfies activation.
  - A subsequent readiness reset prevents an older approval from activating live behavior.
  - Existing under-sampled backtest blocking behavior remains intact.

### Acceptance Criteria

- No `tiny_live` or `scaled_live` promotion can be approved without 50 consecutive matching A/B Manager cycles.
- Achieving readiness does not mutate portfolio mode or activate live execution.
- Live-mode requests require a subsequent matching, cryptographically verified signed promotion approval.
- A live-mode request without both prerequisites is deterministically treated as paper mode for the entire cycle.
- A fabricated, invalid, or tampered signature cannot authorize live behavior.
- The fail-closed decision is visible in structured logs with stable blocker codes.
- Existing backtest, walk-forward, custody, operator-permission, signing, verification, and audit gates continue to apply.
- `npm run check` passes.

## Phase 3 - Readiness API and Operator Documentation

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=README.md -->
<!-- runner:read=scripts/liveReadiness.js -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Import and use the shared readiness and activation evaluators in `server.js`; do not duplicate grade, streak, report-selection, or signature-verification logic.
- Add a read-only `GET /api/promotions/readiness` endpoint.
- Accept an optional `strategy_version` query parameter, defaulting to the active strategy version used by the pipeline.
- Return the Phase 1 readiness fields plus:
  - `activation_allowed`
  - `confirmation`
  - `activation_blockers`
  - `next_action`
- Ensure `confirmation` reports signature verification status without exposing signing secrets or treating an unverified report as confirmed.
- Make `next_action` deterministic:
  - Continue paper validation when readiness is incomplete.
  - Request explicit live promotion confirmation when readiness is complete but a valid verified confirmation is absent.
  - Report live eligibility when both gates pass.
- Add the same compact readiness and activation summary to `/api/professional/summary` under `strategy.live_readiness` so existing clients can render progress without another request.
- Extend promotion summaries additively with readiness and signature-verification information when present; older promotion reports must remain readable but must not authorize activation unless they satisfy the required verified signed-payload contract.
- Keep all endpoints read-only. A GET request must never write reports, change settings, start the pipeline, or confirm promotion.
- Update `README.md` to document:
  - The 50-consecutive-A/B policy.
  - Strategy-version isolation and streak reset behavior.
  - The distinction between readiness, cryptographically verified signed confirmation, and runtime activation.
  - The fail-closed paper-mode behavior for missing, invalid, or tampered confirmations.
  - The readiness endpoint and representative response fields.
  - That reaching 50 cycles does not automatically enable live trading.
- Do not modify dashboard assets.

### Acceptance Criteria

- `GET /api/promotions/readiness` returns deterministic progress and cryptographically verified activation state for the selected strategy.
- The professional summary exposes the same readiness counts and blocker state.
- API responses distinguish “continue validating,” “awaiting explicit confirmation,” and “eligible.”
- Missing reports return a valid blocked response rather than an exception or optimistic status.
- Invalid or tampered promotion signatures return a blocked response and never report eligibility.
- Reading either endpoint causes no filesystem or portfolio mutation.
- Existing clients remain compatible because all response changes are additive.
- Documentation no longer describes live trading as enabled by a configuration change alone.
- `npm run check` passes.

```

### Reviewer 1: devin

Status: approved

Reason: Spec is internally consistent, fail-closed by design, cryptographically sound, strategy-version isolated, and all three phases have testable deterministic acceptance criteria with no ambiguous activation paths.

Raw Response:

```text
---STATUS---
status: approved
reason: Spec is internally consistent, fail-closed by design, cryptographically sound, strategy-version isolated, and all three phases have testable deterministic acceptance criteria with no ambiguous activation paths.
```

### Reviewer 2: codex

Status: revise

Reason: The draft needs deterministic conflict handling and an immutable readiness-epoch proof so later qualifying cycles preserve approval while any streak reset invalidates it.

Replacement Spec:

```spec
# Performance-Gated Paper-to-Live Readiness

## Overview

Replace config-only paper-to-live promotion with a deterministic progression gate based on the Manager’s existing A–F cycle grades. A strategy becomes live-ready only after 50 consecutive Manager cycles graded A or B. Live activation additionally requires an explicit, cryptographically verified promotion approval created after that threshold was reached and bound to the same strategy version and readiness epoch. The pipeline must fail closed to paper mode when any condition is absent or invalid.

Expose machine-readable readiness progress through the existing server APIs. Dashboard UI changes are excluded because `dashboard/**` is protected.

## Goals

- Track consecutive qualifying Manager cycles per strategy version.
- Require 50 consecutive A/B cycles for live readiness.
- Reset progress on any C, D, or F cycle.
- Prevent reports from different strategy versions from being combined.
- Require an explicit, cryptographically verified signed promotion approval after readiness is achieved.
- Bind approval to an immutable proof of the current qualifying streak so later A/B cycles preserve approval while a subsequent reset invalidates it.
- Force requested live operation back to paper mode when readiness or confirmation is missing or invalid.
- Expose progress, remaining cycles, blockers, and confirmation state through existing APIs.
- Preserve the current default of paper mode and all existing promotion checks.

## Non-Goals

- Implementing exchange order submission, wallet signing, custody, or new live execution infrastructure.
- Modifying custody, risk-engine, executor, dashboard, installer, cron, or dependency-lock files.
- Adding tiered live capabilities.
- Allowing an environment variable or portfolio setting to reduce the 50-cycle production threshold.
- Treating historical Manager reports without a matching strategy version as qualifying.
- Automatically enabling live mode when the threshold is reached.
- Adding the visual dashboard progress bar; this spec provides the API contract that a later dashboard change can consume.

## Existing Files

- `pipeline.js` creates Manager cycle reports and contains the runtime paper/live decision path.
- `scripts/promotionGates.js` evaluates signed strategy promotion reports for `research`, `paper`, `shadow`, `tiny_live`, and `scaled_live`.
- `scripts/verifyPromotionGates.js` verifies promotion gates with isolated fixtures.
- `server.js` exposes Manager and promotion report APIs plus the professional summary.
- `package.json` defines the configured `npm run check` verification command.
- `README.md` documents paper-mode safety and current live-trading prerequisites.

## Shared Constraints

- Keep the implementation within 8 changed files and 600 changed lines.
- Preserve “AI suggests, code decides”: readiness and activation decisions must be deterministic and outside LLM prompts.
- Production readiness policy is immutable and exactly:
  - `required_consecutive_cycles: 50`
  - `qualifying_grades: ["A", "B"]`
- Readiness must be evaluated independently for the requested strategy version.
- A Manager report is valid only when it has:
  - A non-empty string `report_id`.
  - A `generated_at` value that parses as a valid timestamp.
  - A non-empty string `strategy_version`.
  - A recognized `overall_grade` of `A`, `B`, `C`, `D`, or `F`.
- Normalize valid timestamps to their numeric epoch value for comparison but retain a stable serialized timestamp in returned summaries.
- Group Manager reports by `report_id` before counting:
  - Byte-for-byte or canonically equivalent duplicates count once.
  - If reports sharing an ID disagree on any readiness-relevant field, exclude the entire conflicting ID from progress and treat it as malformed.
  - Filesystem enumeration order must never decide which duplicate wins.
- Sort remaining reports by timestamp ascending and then by `report_id` ascending using a documented ordinal string comparison.
- Malformed, conflicting, unreadable, or unrelated files must never contribute qualifying progress.
- The current streak is the terminal run of A/B reports after the newest valid C, D, or F report for the requested strategy.
- The readiness epoch is the terminal A/B run containing the current streak. When the streak first reaches 50, its 50th report becomes the immutable `threshold_cycle` for that epoch. Additional A/B reports do not change that threshold cycle. Any later C, D, or F report ends the epoch; a future streak receives a different threshold cycle.
- Reaching 50 qualifying cycles establishes eligibility only; it must not mutate portfolio settings or activate live execution automatically.
- Live activation additionally requires a cryptographically verified, successful promotion report for the same strategy version and a live-capable target state.
- The signed payload must bind the strategy version, target state, promotion decision, readiness policy, and immutable threshold-cycle proof used to approve promotion. Values outside the verified payload must not authorize activation.
- A confirmation is valid for the current readiness epoch when its signed readiness proof matches:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `readiness_met: true`
  - `threshold_cycle.report_id`
  - `threshold_cycle.generated_at`
- Mutable fields such as current streak length, remaining cycles, progress percentage, valid-cycle count, and latest cycle may be included for auditability but must not be required to remain equal after later qualifying cycles.
- A promotion confirmation must have a valid `generated_at` strictly later than the bound threshold cycle’s timestamp.
- Any missing, malformed, mismatched, unsigned, signature-invalid, tampered, stale-epoch, or blocked confirmation must fail closed to paper mode.
- Preserve and reuse all existing promotion metrics, custody checks, canonical signing and verification behavior, and audit behavior.
- Do not modify any protected path.
- Use only Node.js built-ins and existing dependencies.
- `npm run check` is the configured verification command for every phase.

## Phase 1 - Deterministic Live-Readiness Tracker

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/verifyLiveReadiness.js -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:read=scripts/verifyPromotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Add `scripts/liveReadiness.js` with side-effect-free exported evaluators that can accept in-memory reports for tests and scan a supplied reports directory for production.
- Apply the immutable production policy defined in Shared Constraints.
- Evaluate only valid Manager cycle reports matching the requested strategy version.
- Apply the specified duplicate grouping, conflict exclusion, and deterministic ordering rules.
- Calculate the consecutive qualifying streak ending at the newest valid matching report.
- Reset the streak to zero after a nonqualifying recognized grade, then count any subsequent A/B reports.
- Return a stable JSON-ready result containing at least:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `valid_cycle_count`
  - `current_qualifying_streak`
  - `remaining_qualifying_cycles`
  - `progress_pct`
  - `readiness_met`
  - `latest_cycle`
  - `threshold_cycle`
  - `blockers`
- `threshold_cycle` must be `null` before readiness and otherwise contain at least the report ID and normalized generation timestamp of the 50th report in the current readiness epoch.
- Clamp `remaining_qualifying_cycles` to zero and `progress_pct` to 100.
- Use explicit blocker codes for:
  - `missing_strategy_version`
  - `no_valid_matching_manager_reports`
  - `insufficient_qualifying_cycles`
- Malformed and conflicting duplicates may be exposed as nonblocking diagnostics but must not introduce input-order-dependent blockers or results.
- Permit test-only policy injection through explicit function arguments without exposing a production environment-variable or portfolio-setting override.
- Stamp newly generated Manager reports in `pipeline.js` with the active `PAPER_ORDER_STRATEGY_VERSION` as `strategy_version`.
- Do not retroactively treat unstamped historical reports as belonging to the current strategy.
- Directory scanning must return a blocked readiness result, rather than throwing or succeeding optimistically, when the directory is missing or unreadable.
- Add `scripts/verifyLiveReadiness.js` using temporary fixtures to verify:
  - 49 consecutive A/B reports remain blocked.
  - The 50th consecutive A/B report unlocks readiness.
  - Additional A/B reports preserve the same threshold cycle.
  - A C, D, or F grade resets the streak and clears the threshold cycle.
  - Reports for another strategy version do not count.
  - Equivalent duplicates count once.
  - Conflicting duplicates are excluded regardless of input order.
  - Malformed reports do not inflate progress.
  - Ordering is deterministic for equal timestamps.
  - Reversing the input array and filesystem enumeration produces deeply equal results.
- Add syntax checking and execution of the new verifier to the existing `npm run check` command without replacing or broadening it to another package script.

### Acceptance Criteria

- A strategy with 50 valid consecutive A/B Manager reports returns `readiness_met: true`, zero remaining cycles, 100% progress, and a deterministic threshold cycle.
- A strategy with any shorter terminal streak returns `readiness_met: false` and an `insufficient_qualifying_cycles` blocker.
- A C, D, or F report breaks the preceding streak even when older history contains 50 qualifying reports.
- Reports from other or missing strategy versions cannot contribute progress.
- Conflicting reports sharing an ID cannot contribute progress.
- Repeated evaluation over identical logical inputs returns deeply equal results regardless of input or directory enumeration order.
- Existing Manager report generation remains compatible apart from the additive `strategy_version` field.
- `npm run check` passes.

## Phase 2 - Promotion Confirmation and Runtime Enforcement

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/promotionGates.js -->
<!-- pilot:touches=scripts/verifyPromotionGates.js -->
<!-- pilot:touches=pipeline.js -->
<!-- runner:read=scripts/auditTrail.js -->
<!-- runner:read=README.md -->
<!-- runner:verify=npm run check -->

### Requirements

- Extend the readiness module with an activation evaluator that combines:
  - The current Phase 1 readiness result.
  - The deterministically selected promotion confirmation candidate.
  - A live-capable target state of `tiny_live` or `scaled_live`.
  - `promotion_allowed: true`.
  - A recognized signed-report marker.
  - A non-empty signature that passes the existing cryptographic verification procedure over the canonical signed payload.
  - A signed readiness proof matching the current readiness epoch as defined in Shared Constraints.
- Promotion confirmation files are structurally selectable only when they have a non-empty stable report identifier and valid generation timestamp.
- Group promotion reports by their stable report identifier:
  - Canonically equivalent duplicates count once.
  - Conflicting duplicates are excluded.
- Order selectable promotion reports by generation timestamp descending and stable report identifier descending using ordinal string comparison.
- Determine candidates for the requested strategy from the cryptographically verified signed payload, never solely from unsigned envelope fields.
- If a newer structurally valid report claims the requested strategy in unsigned fields but its signature or payload is invalid, it must remain visible as the newest failed candidate and fail closed rather than allowing an older approval to bypass it.
- Unsigned envelope fields may help identify and diagnose a failed candidate but must never authorize activation.
- Return activation status separately from readiness status so reaching the streak never implies automatic activation.
- Return a `confirmation` object that identifies the selected candidate, its signature-verification state, and its trusted signed-payload fields without exposing secrets.
- Add explicit activation blocker codes for:
  - `readiness_not_met`
  - `missing_confirmation`
  - `confirmation_strategy_mismatch`
  - `confirmation_non_live_target`
  - `confirmation_promotion_blocked`
  - `confirmation_missing_signature`
  - `confirmation_invalid_signature`
  - `confirmation_signed_payload_mismatch`
  - `confirmation_not_after_readiness`
  - `confirmation_stale_readiness_epoch`
- Blocker precedence and combinations must be deterministic and tested. Signature verification must occur before any signed field is treated as trusted.
- Integrate Phase 1 readiness into `evaluatePromotionGates()`:
  - `research`, `paper`, and `shadow` retain their existing behavior.
  - `tiny_live` and `scaled_live` receive a blocking `live_readiness_not_met` gate until the production 50-cycle policy is satisfied for the evaluated strategy version.
  - Include the full readiness summary and evaluated strategy version in the canonical payload of the signed promotion report.
  - Include the immutable readiness proof fields specified in Shared Constraints.
  - Preserve every existing gate; readiness is an additional requirement, not a replacement.
- Promotion signing must occur only after all gates, including readiness, are evaluated. The signed promotion decision must reflect the final gate result.
- Ensure the promotion command remains an explicit operator action. It may write a signed approval report but must not change `portfolio.json` or automatically disable paper mode.
- At cycle startup, when `portfolio.settings.paper_mode` requests live behavior, evaluate activation for `PAPER_ORDER_STRATEGY_VERSION` using one readiness snapshot and the deterministically selected promotion candidate.
- If activation is not allowed, use paper mode for all Risk and Executor decisions in that cycle and emit a structured pipeline warning containing the activation blocker codes.
- Compute the effective paper/live mode once at cycle startup and pass that effective mode consistently to every downstream Risk and Executor decision in the cycle.
- Do not silently bypass the gate when Manager or promotion report directories are missing or unreadable.
- Do not change behavior for an already requested paper-mode cycle and do not require promotion report scanning to keep that cycle in paper mode.
- Extend `scripts/verifyPromotionGates.js` with isolated fixtures proving:
  - An otherwise promotable live target is blocked at 49 qualifying cycles.
  - An otherwise promotable live target is approved at 50 qualifying cycles.
  - Readiness from a different strategy version does not satisfy promotion.
  - Readiness alone does not satisfy runtime activation.
  - An unsigned, signature-invalid, tampered, blocked, non-live, or mismatched promotion report cannot activate live behavior.
  - Altering an unsigned envelope field without changing the verified payload cannot authorize activation.
  - A cryptographically verified successful live promotion generated after readiness and bound to the matching strategy and threshold cycle satisfies activation.
  - The same approval remains valid after additional A/B cycles in the same readiness epoch.
  - A subsequent C, D, or F reset makes the older approval stale and prevents activation.
  - A later new 50-cycle streak requires a new approval bound to its new threshold cycle.
  - A confirmation timestamp at or before the threshold-cycle timestamp cannot activate live behavior.
  - Conflicting duplicate promotion IDs cannot activate live behavior.
  - A newer invalid candidate claiming the strategy cannot be bypassed by an older valid approval.
  - Existing under-sampled backtest blocking behavior remains intact.

### Acceptance Criteria

- No `tiny_live` or `scaled_live` promotion can be approved without 50 consecutive matching A/B Manager cycles.
- Achieving readiness does not mutate portfolio mode or activate live execution.
- Live-mode requests require a subsequent matching, cryptographically verified signed promotion approval.
- An approval remains usable through later qualifying cycles in the same readiness epoch but becomes invalid after a streak reset.
- A live-mode request without all prerequisites is deterministically treated as paper mode for the entire cycle.
- A fabricated, invalid, stale, conflicting, or tampered signature cannot authorize live behavior.
- The fail-closed decision is visible in structured logs with stable blocker codes.
- Existing backtest, walk-forward, custody, operator-permission, signing, verification, and audit gates continue to apply.
- `npm run check` passes.

## Phase 3 - Readiness API and Operator Documentation

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=README.md -->
<!-- runner:read=scripts/liveReadiness.js -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Import and use the shared readiness and activation evaluators in `server.js`; do not duplicate validation, deduplication, grade, streak, report-selection, epoch-binding, or signature-verification logic.
- Add a read-only `GET /api/promotions/readiness` endpoint.
- Accept an optional `strategy_version` query parameter, defaulting to the active strategy version used by the pipeline.
- Reject an explicitly supplied empty or invalidly typed strategy version with a deterministic client error rather than silently substituting the default.
- Return the Phase 1 readiness fields plus:
  - `activation_allowed`
  - `confirmation`
  - `activation_blockers`
  - `next_action`
- Ensure `confirmation` reports signature-verification and readiness-epoch matching status without exposing signing secrets or treating an unverified report as confirmed.
- Make `next_action` deterministic:
  - `continue_paper_validation` when readiness is incomplete.
  - `request_live_promotion_confirmation` when readiness is complete but a valid verified confirmation for the current epoch is absent.
  - `live_eligible` when both gates pass.
- Add the same compact readiness and activation summary to `/api/professional/summary` under `strategy.live_readiness` so existing clients can render progress without another request.
- Extend promotion summaries additively with readiness, threshold-cycle, and signature-verification information when present. Older promotion reports must remain readable but must not authorize activation unless they satisfy the verified signed-payload and current-readiness-epoch contract.
- Keep all endpoints read-only. A GET request must never write reports, change settings, start the pipeline, sign data, or confirm promotion.
- Missing or unreadable report directories must return valid blocked responses with stable blockers rather than exceptions or optimistic status.
- Update `README.md` to document:
  - The 50-consecutive-A/B policy.
  - Strategy-version isolation, duplicate handling, and streak reset behavior.
  - The readiness epoch and threshold-cycle proof.
  - The distinction between readiness, cryptographically verified signed confirmation, and runtime activation.
  - That an approval survives later A/B cycles in the same epoch but is invalidated by a C, D, or F reset.
  - The fail-closed paper-mode behavior for missing, invalid, stale, conflicting, or tampered confirmations.
  - The readiness endpoint and representative response fields.
  - That reaching 50 cycles does not automatically enable live trading.
- Do not modify dashboard assets.

### Acceptance Criteria

- `GET /api/promotions/readiness` returns deterministic progress and cryptographically verified activation state for the selected strategy.
- The professional summary exposes the same readiness counts and blocker state.
- API responses distinguish “continue validating,” “awaiting explicit confirmation,” and “eligible.”
- Missing reports return a valid blocked response rather than an exception or optimistic status.
- Invalid, stale, or tampered promotion signatures return a blocked response and never report eligibility.
- Later qualifying cycles do not incorrectly invalidate an approval bound to the same readiness epoch.
- Reading either endpoint causes no filesystem or portfolio mutation.
- Existing clients remain compatible because all response changes are additive.
- Documentation no longer describes live trading as enabled by a configuration change alone.
- `npm run check` passes.
```

Raw Response:

```text
---STATUS---
status: revise
reason: The draft needs deterministic conflict handling and an immutable readiness-epoch proof so later qualifying cycles preserve approval while any streak reset invalidates it.
```spec
# Performance-Gated Paper-to-Live Readiness

## Overview

Replace config-only paper-to-live promotion with a deterministic progression gate based on the Manager’s existing A–F cycle grades. A strategy becomes live-ready only after 50 consecutive Manager cycles graded A or B. Live activation additionally requires an explicit, cryptographically verified promotion approval created after that threshold was reached and bound to the same strategy version and readiness epoch. The pipeline must fail closed to paper mode when any condition is absent or invalid.

Expose machine-readable readiness progress through the existing server APIs. Dashboard UI changes are excluded because `dashboard/**` is protected.

## Goals

- Track consecutive qualifying Manager cycles per strategy version.
- Require 50 consecutive A/B cycles for live readiness.
- Reset progress on any C, D, or F cycle.
- Prevent reports from different strategy versions from being combined.
- Require an explicit, cryptographically verified signed promotion approval after readiness is achieved.
- Bind approval to an immutable proof of the current qualifying streak so later A/B cycles preserve approval while a subsequent reset invalidates it.
- Force requested live operation back to paper mode when readiness or confirmation is missing or invalid.
- Expose progress, remaining cycles, blockers, and confirmation state through existing APIs.
- Preserve the current default of paper mode and all existing promotion checks.

## Non-Goals

- Implementing exchange order submission, wallet signing, custody, or new live execution infrastructure.
- Modifying custody, risk-engine, executor, dashboard, installer, cron, or dependency-lock files.
- Adding tiered live capabilities.
- Allowing an environment variable or portfolio setting to reduce the 50-cycle production threshold.
- Treating historical Manager reports without a matching strategy version as qualifying.
- Automatically enabling live mode when the threshold is reached.
- Adding the visual dashboard progress bar; this spec provides the API contract that a later dashboard change can consume.

## Existing Files

- `pipeline.js` creates Manager cycle reports and contains the runtime paper/live decision path.
- `scripts/promotionGates.js` evaluates signed strategy promotion reports for `research`, `paper`, `shadow`, `tiny_live`, and `scaled_live`.
- `scripts/verifyPromotionGates.js` verifies promotion gates with isolated fixtures.
- `server.js` exposes Manager and promotion report APIs plus the professional summary.
- `package.json` defines the configured `npm run check` verification command.
- `README.md` documents paper-mode safety and current live-trading prerequisites.

## Shared Constraints

- Keep the implementation within 8 changed files and 600 changed lines.
- Preserve “AI suggests, code decides”: readiness and activation decisions must be deterministic and outside LLM prompts.
- Production readiness policy is immutable and exactly:
  - `required_consecutive_cycles: 50`
  - `qualifying_grades: ["A", "B"]`
- Readiness must be evaluated independently for the requested strategy version.
- A Manager report is valid only when it has:
  - A non-empty string `report_id`.
  - A `generated_at` value that parses as a valid timestamp.
  - A non-empty string `strategy_version`.
  - A recognized `overall_grade` of `A`, `B`, `C`, `D`, or `F`.
- Normalize valid timestamps to their numeric epoch value for comparison but retain a stable serialized timestamp in returned summaries.
- Group Manager reports by `report_id` before counting:
  - Byte-for-byte or canonically equivalent duplicates count once.
  - If reports sharing an ID disagree on any readiness-relevant field, exclude the entire conflicting ID from progress and treat it as malformed.
  - Filesystem enumeration order must never decide which duplicate wins.
- Sort remaining reports by timestamp ascending and then by `report_id` ascending using a documented ordinal string comparison.
- Malformed, conflicting, unreadable, or unrelated files must never contribute qualifying progress.
- The current streak is the terminal run of A/B reports after the newest valid C, D, or F report for the requested strategy.
- The readiness epoch is the terminal A/B run containing the current streak. When the streak first reaches 50, its 50th report becomes the immutable `threshold_cycle` for that epoch. Additional A/B reports do not change that threshold cycle. Any later C, D, or F report ends the epoch; a future streak receives a different threshold cycle.
- Reaching 50 qualifying cycles establishes eligibility only; it must not mutate portfolio settings or activate live execution automatically.
- Live activation additionally requires a cryptographically verified, successful promotion report for the same strategy version and a live-capable target state.
- The signed payload must bind the strategy version, target state, promotion decision, readiness policy, and immutable threshold-cycle proof used to approve promotion. Values outside the verified payload must not authorize activation.
- A confirmation is valid for the current readiness epoch when its signed readiness proof matches:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `readiness_met: true`
  - `threshold_cycle.report_id`
  - `threshold_cycle.generated_at`
- Mutable fields such as current streak length, remaining cycles, progress percentage, valid-cycle count, and latest cycle may be included for auditability but must not be required to remain equal after later qualifying cycles.
- A promotion confirmation must have a valid `generated_at` strictly later than the bound threshold cycle’s timestamp.
- Any missing, malformed, mismatched, unsigned, signature-invalid, tampered, stale-epoch, or blocked confirmation must fail closed to paper mode.
- Preserve and reuse all existing promotion metrics, custody checks, canonical signing and verification behavior, and audit behavior.
- Do not modify any protected path.
- Use only Node.js built-ins and existing dependencies.
- `npm run check` is the configured verification command for every phase.

## Phase 1 - Deterministic Live-Readiness Tracker

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/verifyLiveReadiness.js -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:read=scripts/verifyPromotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Add `scripts/liveReadiness.js` with side-effect-free exported evaluators that can accept in-memory reports for tests and scan a supplied reports directory for production.
- Apply the immutable production policy defined in Shared Constraints.
- Evaluate only valid Manager cycle reports matching the requested strategy version.
- Apply the specified duplicate grouping, conflict exclusion, and deterministic ordering rules.
- Calculate the consecutive qualifying streak ending at the newest valid matching report.
- Reset the streak to zero after a nonqualifying recognized grade, then count any subsequent A/B reports.
- Return a stable JSON-ready result containing at least:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `valid_cycle_count`
  - `current_qualifying_streak`
  - `remaining_qualifying_cycles`
  - `progress_pct`
  - `readiness_met`
  - `latest_cycle`
  - `threshold_cycle`
  - `blockers`
- `threshold_cycle` must be `null` before readiness and otherwise contain at least the report ID and normalized generation timestamp of the 50th report in the current readiness epoch.
- Clamp `remaining_qualifying_cycles` to zero and `progress_pct` to 100.
- Use explicit blocker codes for:
  - `missing_strategy_version`
  - `no_valid_matching_manager_reports`
  - `insufficient_qualifying_cycles`
- Malformed and conflicting duplicates may be exposed as nonblocking diagnostics but must not introduce input-order-dependent blockers or results.
- Permit test-only policy injection through explicit function arguments without exposing a production environment-variable or portfolio-setting override.
- Stamp newly generated Manager reports in `pipeline.js` with the active `PAPER_ORDER_STRATEGY_VERSION` as `strategy_version`.
- Do not retroactively treat unstamped historical reports as belonging to the current strategy.
- Directory scanning must return a blocked readiness result, rather than throwing or succeeding optimistically, when the directory is missing or unreadable.
- Add `scripts/verifyLiveReadiness.js` using temporary fixtures to verify:
  - 49 consecutive A/B reports remain blocked.
  - The 50th consecutive A/B report unlocks readiness.
  - Additional A/B reports preserve the same threshold cycle.
  - A C, D, or F grade resets the streak and clears the threshold cycle.
  - Reports for another strategy version do not count.
  - Equivalent duplicates count once.
  - Conflicting duplicates are excluded regardless of input order.
  - Malformed reports do not inflate progress.
  - Ordering is deterministic for equal timestamps.
  - Reversing the input array and filesystem enumeration produces deeply equal results.
- Add syntax checking and execution of the new verifier to the existing `npm run check` command without replacing or broadening it to another package script.

### Acceptance Criteria

- A strategy with 50 valid consecutive A/B Manager reports returns `readiness_met: true`, zero remaining cycles, 100% progress, and a deterministic threshold cycle.
- A strategy with any shorter terminal streak returns `readiness_met: false` and an `insufficient_qualifying_cycles` blocker.
- A C, D, or F report breaks the preceding streak even when older history contains 50 qualifying reports.
- Reports from other or missing strategy versions cannot contribute progress.
- Conflicting reports sharing an ID cannot contribute progress.
- Repeated evaluation over identical logical inputs returns deeply equal results regardless of input or directory enumeration order.
- Existing Manager report generation remains compatible apart from the additive `strategy_version` field.
- `npm run check` passes.

## Phase 2 - Promotion Confirmation and Runtime Enforcement

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/promotionGates.js -->
<!-- pilot:touches=scripts/verifyPromotionGates.js -->
<!-- pilot:touches=pipeline.js -->
<!-- runner:read=scripts/auditTrail.js -->
<!-- runner:read=README.md -->
<!-- runner:verify=npm run check -->

### Requirements

- Extend the readiness module with an activation evaluator that combines:
  - The current Phase 1 readiness result.
  - The deterministically selected promotion confirmation candidate.
  - A live-capable target state of `tiny_live` or `scaled_live`.
  - `promotion_allowed: true`.
  - A recognized signed-report marker.
  - A non-empty signature that passes the existing cryptographic verification procedure over the canonical signed payload.
  - A signed readiness proof matching the current readiness epoch as defined in Shared Constraints.
- Promotion confirmation files are structurally selectable only when they have a non-empty stable report identifier and valid generation timestamp.
- Group promotion reports by their stable report identifier:
  - Canonically equivalent duplicates count once.
  - Conflicting duplicates are excluded.
- Order selectable promotion reports by generation timestamp descending and stable report identifier descending using ordinal string comparison.
- Determine candidates for the requested strategy from the cryptographically verified signed payload, never solely from unsigned envelope fields.
- If a newer structurally valid report claims the requested strategy in unsigned fields but its signature or payload is invalid, it must remain visible as the newest failed candidate and fail closed rather than allowing an older approval to bypass it.
- Unsigned envelope fields may help identify and diagnose a failed candidate but must never authorize activation.
- Return activation status separately from readiness status so reaching the streak never implies automatic activation.
- Return a `confirmation` object that identifies the selected candidate, its signature-verification state, and its trusted signed-payload fields without exposing secrets.
- Add explicit activation blocker codes for:
  - `readiness_not_met`
  - `missing_confirmation`
  - `confirmation_strategy_mismatch`
  - `confirmation_non_live_target`
  - `confirmation_promotion_blocked`
  - `confirmation_missing_signature`
  - `confirmation_invalid_signature`
  - `confirmation_signed_payload_mismatch`
  - `confirmation_not_after_readiness`
  - `confirmation_stale_readiness_epoch`
- Blocker precedence and combinations must be deterministic and tested. Signature verification must occur before any signed field is treated as trusted.
- Integrate Phase 1 readiness into `evaluatePromotionGates()`:
  - `research`, `paper`, and `shadow` retain their existing behavior.
  - `tiny_live` and `scaled_live` receive a blocking `live_readiness_not_met` gate until the production 50-cycle policy is satisfied for the evaluated strategy version.
  - Include the full readiness summary and evaluated strategy version in the canonical payload of the signed promotion report.
  - Include the immutable readiness proof fields specified in Shared Constraints.
  - Preserve every existing gate; readiness is an additional requirement, not a replacement.
- Promotion signing must occur only after all gates, including readiness, are evaluated. The signed promotion decision must reflect the final gate result.
- Ensure the promotion command remains an explicit operator action. It may write a signed approval report but must not change `portfolio.json` or automatically disable paper mode.
- At cycle startup, when `portfolio.settings.paper_mode` requests live behavior, evaluate activation for `PAPER_ORDER_STRATEGY_VERSION` using one readiness snapshot and the deterministically selected promotion candidate.
- If activation is not allowed, use paper mode for all Risk and Executor decisions in that cycle and emit a structured pipeline warning containing the activation blocker codes.
- Compute the effective paper/live mode once at cycle startup and pass that effective mode consistently to every downstream Risk and Executor decision in the cycle.
- Do not silently bypass the gate when Manager or promotion report directories are missing or unreadable.
- Do not change behavior for an already requested paper-mode cycle and do not require promotion report scanning to keep that cycle in paper mode.
- Extend `scripts/verifyPromotionGates.js` with isolated fixtures proving:
  - An otherwise promotable live target is blocked at 49 qualifying cycles.
  - An otherwise promotable live target is approved at 50 qualifying cycles.
  - Readiness from a different strategy version does not satisfy promotion.
  - Readiness alone does not satisfy runtime activation.
  - An unsigned, signature-invalid, tampered, blocked, non-live, or mismatched promotion report cannot activate live behavior.
  - Altering an unsigned envelope field without changing the verified payload cannot authorize activation.
  - A cryptographically verified successful live promotion generated after readiness and bound to the matching strategy and threshold cycle satisfies activation.
  - The same approval remains valid after additional A/B cycles in the same readiness epoch.
  - A subsequent C, D, or F reset makes the older approval stale and prevents activation.
  - A later new 50-cycle streak requires a new approval bound to its new threshold cycle.
  - A confirmation timestamp at or before the threshold-cycle timestamp cannot activate live behavior.
  - Conflicting duplicate promotion IDs cannot activate live behavior.
  - A newer invalid candidate claiming the strategy cannot be bypassed by an older valid approval.
  - Existing under-sampled backtest blocking behavior remains intact.

### Acceptance Criteria

- No `tiny_live` or `scaled_live` promotion can be approved without 50 consecutive matching A/B Manager cycles.
- Achieving readiness does not mutate portfolio mode or activate live execution.
- Live-mode requests require a subsequent matching, cryptographically verified signed promotion approval.
- An approval remains usable through later qualifying cycles in the same readiness epoch but becomes invalid after a streak reset.
- A live-mode request without all prerequisites is deterministically treated as paper mode for the entire cycle.
- A fabricated, invalid, stale, conflicting, or tampered signature cannot authorize live behavior.
- The fail-closed decision is visible in structured logs with stable blocker codes.
- Existing backtest, walk-forward, custody, operator-permission, signing, verification, and audit gates continue to apply.
- `npm run check` passes.

## Phase 3 - Readiness API and Operator Documentation

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=README.md -->
<!-- runner:read=scripts/liveReadiness.js -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Import and use the shared readiness and activation evaluators in `server.js`; do not duplicate validation, deduplication, grade, streak, report-selection, epoch-binding, or signature-verification logic.
- Add a read-only `GET /api/promotions/readiness` endpoint.
- Accept an optional `strategy_version` query parameter, defaulting to the active strategy version used by the pipeline.
- Reject an explicitly supplied empty or invalidly typed strategy version with a deterministic client error rather than silently substituting the default.
- Return the Phase 1 readiness fields plus:
  - `activation_allowed`
  - `confirmation`
  - `activation_blockers`
  - `next_action`
- Ensure `confirmation` reports signature-verification and readiness-epoch matching status without exposing signing secrets or treating an unverified report as confirmed.
- Make `next_action` deterministic:
  - `continue_paper_validation` when readiness is incomplete.
  - `request_live_promotion_confirmation` when readiness is complete but a valid verified confirmation for the current epoch is absent.
  - `live_eligible` when both gates pass.
- Add the same compact readiness and activation summary to `/api/professional/summary` under `strategy.live_readiness` so existing clients can render progress without another request.
- Extend promotion summaries additively with readiness, threshold-cycle, and signature-verification information when present. Older promotion reports must remain readable but must not authorize activation unless they satisfy the verified signed-payload and current-readiness-epoch contract.
- Keep all endpoints read-only. A GET request must never write reports, change settings, start the pipeline, sign data, or confirm promotion.
- Missing or unreadable report directories must return valid blocked responses with stable blockers rather than exceptions or optimistic status.
- Update `README.md` to document:
  - The 50-consecutive-A/B policy.
  - Strategy-version isolation, duplicate handling, and streak reset behavior.
  - The readiness epoch and threshold-cycle proof.
  - The distinction between readiness, cryptographically verified signed confirmation, and runtime activation.
  - That an approval survives later A/B cycles in the same epoch but is invalidated by a C, D, or F reset.
  - The fail-closed paper-mode behavior for missing, invalid, stale, conflicting, or tampered confirmations.
  - The readiness endpoint and representative response fields.
  - That reaching 50 cycles does not automatically enable live trading.
- Do not modify dashboard assets.

### Acceptance Criteria

- `GET /api/promotions/readiness` returns deterministic progress and cryptographically verified activation state for the selected strategy.
- The professional summary exposes the same readiness counts and blocker state.
- API responses distinguish “continue validating,” “awaiting explicit confirmation,” and “eligible.”
- Missing reports return a valid blocked response rather than an exception or optimistic status.
- Invalid, stale, or tampered promotion signatures return a blocked response and never report eligibility.
- Later qualifying cycles do not incorrectly invalidate an approval bound to the same readiness epoch.
- Reading either endpoint causes no filesystem or portfolio mutation.
- Existing clients remain compatible because all response changes are additive.
- Documentation no longer describes live trading as enabled by a configuration change alone.
- `npm run check` passes.
```
```

Round Result: not converged

At least one reviewer requested revision in round 1.

## Round 2

### Draft Before Round

```text
# Performance-Gated Paper-to-Live Readiness

## Overview

Replace config-only paper-to-live promotion with a deterministic progression gate based on the Manager’s existing A–F cycle grades. A strategy becomes live-ready only after 50 consecutive Manager cycles graded A or B. Live activation additionally requires an explicit, cryptographically verified promotion approval created after that threshold was reached and bound to the same strategy version and readiness epoch. The pipeline must fail closed to paper mode when any condition is absent or invalid.

Expose machine-readable readiness progress through the existing server APIs. Dashboard UI changes are excluded because `dashboard/**` is protected.

## Goals

- Track consecutive qualifying Manager cycles per strategy version.
- Require 50 consecutive A/B cycles for live readiness.
- Reset progress on any C, D, or F cycle.
- Prevent reports from different strategy versions from being combined.
- Require an explicit, cryptographically verified signed promotion approval after readiness is achieved.
- Bind approval to an immutable proof of the current qualifying streak so later A/B cycles preserve approval while a subsequent reset invalidates it.
- Force requested live operation back to paper mode when readiness or confirmation is missing or invalid.
- Expose progress, remaining cycles, blockers, and confirmation state through existing APIs.
- Preserve the current default of paper mode and all existing promotion checks.

## Non-Goals

- Implementing exchange order submission, wallet signing, custody, or new live execution infrastructure.
- Modifying custody, risk-engine, executor, dashboard, installer, cron, or dependency-lock files.
- Adding tiered live capabilities.
- Allowing an environment variable or portfolio setting to reduce the 50-cycle production threshold.
- Treating historical Manager reports without a matching strategy version as qualifying.
- Automatically enabling live mode when the threshold is reached.
- Adding the visual dashboard progress bar; this spec provides the API contract that a later dashboard change can consume.

## Existing Files

- `pipeline.js` creates Manager cycle reports and contains the runtime paper/live decision path.
- `scripts/promotionGates.js` evaluates signed strategy promotion reports for `research`, `paper`, `shadow`, `tiny_live`, and `scaled_live`.
- `scripts/verifyPromotionGates.js` verifies promotion gates with isolated fixtures.
- `server.js` exposes Manager and promotion report APIs plus the professional summary.
- `package.json` defines the configured `npm run check` verification command.
- `README.md` documents paper-mode safety and current live-trading prerequisites.

## Shared Constraints

- Keep the implementation within 8 changed files and 600 changed lines.
- Preserve “AI suggests, code decides”: readiness and activation decisions must be deterministic and outside LLM prompts.
- Production readiness policy is immutable and exactly:
  - `required_consecutive_cycles: 50`
  - `qualifying_grades: ["A", "B"]`
- Readiness must be evaluated independently for the requested strategy version.
- A Manager report is valid only when it has:
  - A non-empty string `report_id`.
  - A `generated_at` value that parses as a valid timestamp.
  - A non-empty string `strategy_version`.
  - A recognized `overall_grade` of `A`, `B`, `C`, `D`, or `F`.
- Normalize valid timestamps to their numeric epoch value for comparison but retain a stable serialized timestamp in returned summaries.
- Group Manager reports by `report_id` before counting:
  - Byte-for-byte or canonically equivalent duplicates count once.
  - If reports sharing an ID disagree on any readiness-relevant field, exclude the entire conflicting ID from progress and treat it as malformed.
  - Filesystem enumeration order must never decide which duplicate wins.
- Sort remaining reports by timestamp ascending and then by `report_id` ascending using a documented ordinal string comparison.
- Malformed, conflicting, unreadable, or unrelated files must never contribute qualifying progress.
- The current streak is the terminal run of A/B reports after the newest valid C, D, or F report for the requested strategy.
- The readiness epoch is the terminal A/B run containing the current streak. When the streak first reaches 50, its 50th report becomes the immutable `threshold_cycle` for that epoch. Additional A/B reports do not change that threshold cycle. Any later C, D, or F report ends the epoch; a future streak receives a different threshold cycle.
- Reaching 50 qualifying cycles establishes eligibility only; it must not mutate portfolio settings or activate live execution automatically.
- Live activation additionally requires a cryptographically verified, successful promotion report for the same strategy version and a live-capable target state.
- The signed payload must bind the strategy version, target state, promotion decision, readiness policy, and immutable threshold-cycle proof used to approve promotion. Values outside the verified payload must not authorize activation.
- A confirmation is valid for the current readiness epoch when its signed readiness proof matches:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `readiness_met: true`
  - `threshold_cycle.report_id`
  - `threshold_cycle.generated_at`
- Mutable fields such as current streak length, remaining cycles, progress percentage, valid-cycle count, and latest cycle may be included for auditability but must not be required to remain equal after later qualifying cycles.
- A promotion confirmation must have a valid `generated_at` strictly later than the bound threshold cycle’s timestamp.
- Any missing, malformed, mismatched, unsigned, signature-invalid, tampered, stale-epoch, or blocked confirmation must fail closed to paper mode.
- Preserve and reuse all existing promotion metrics, custody checks, canonical signing and verification behavior, and audit behavior.
- Do not modify any protected path.
- Use only Node.js built-ins and existing dependencies.
- `npm run check` is the configured verification command for every phase.

## Phase 1 - Deterministic Live-Readiness Tracker

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/verifyLiveReadiness.js -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:read=scripts/verifyPromotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Add `scripts/liveReadiness.js` with side-effect-free exported evaluators that can accept in-memory reports for tests and scan a supplied reports directory for production.
- Apply the immutable production policy defined in Shared Constraints.
- Evaluate only valid Manager cycle reports matching the requested strategy version.
- Apply the specified duplicate grouping, conflict exclusion, and deterministic ordering rules.
- Calculate the consecutive qualifying streak ending at the newest valid matching report.
- Reset the streak to zero after a nonqualifying recognized grade, then count any subsequent A/B reports.
- Return a stable JSON-ready result containing at least:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `valid_cycle_count`
  - `current_qualifying_streak`
  - `remaining_qualifying_cycles`
  - `progress_pct`
  - `readiness_met`
  - `latest_cycle`
  - `threshold_cycle`
  - `blockers`
- `threshold_cycle` must be `null` before readiness and otherwise contain at least the report ID and normalized generation timestamp of the 50th report in the current readiness epoch.
- Clamp `remaining_qualifying_cycles` to zero and `progress_pct` to 100.
- Use explicit blocker codes for:
  - `missing_strategy_version`
  - `no_valid_matching_manager_reports`
  - `insufficient_qualifying_cycles`
- Malformed and conflicting duplicates may be exposed as nonblocking diagnostics but must not introduce input-order-dependent blockers or results.
- Permit test-only policy injection through explicit function arguments without exposing a production environment-variable or portfolio-setting override.
- Stamp newly generated Manager reports in `pipeline.js` with the active `PAPER_ORDER_STRATEGY_VERSION` as `strategy_version`.
- Do not retroactively treat unstamped historical reports as belonging to the current strategy.
- Directory scanning must return a blocked readiness result, rather than throwing or succeeding optimistically, when the directory is missing or unreadable.
- Add `scripts/verifyLiveReadiness.js` using temporary fixtures to verify:
  - 49 consecutive A/B reports remain blocked.
  - The 50th consecutive A/B report unlocks readiness.
  - Additional A/B reports preserve the same threshold cycle.
  - A C, D, or F grade resets the streak and clears the threshold cycle.
  - Reports for another strategy version do not count.
  - Equivalent duplicates count once.
  - Conflicting duplicates are excluded regardless of input order.
  - Malformed reports do not inflate progress.
  - Ordering is deterministic for equal timestamps.
  - Reversing the input array and filesystem enumeration produces deeply equal results.
- Add syntax checking and execution of the new verifier to the existing `npm run check` command without replacing or broadening it to another package script.

### Acceptance Criteria

- A strategy with 50 valid consecutive A/B Manager reports returns `readiness_met: true`, zero remaining cycles, 100% progress, and a deterministic threshold cycle.
- A strategy with any shorter terminal streak returns `readiness_met: false` and an `insufficient_qualifying_cycles` blocker.
- A C, D, or F report breaks the preceding streak even when older history contains 50 qualifying reports.
- Reports from other or missing strategy versions cannot contribute progress.
- Conflicting reports sharing an ID cannot contribute progress.
- Repeated evaluation over identical logical inputs returns deeply equal results regardless of input or directory enumeration order.
- Existing Manager report generation remains compatible apart from the additive `strategy_version` field.
- `npm run check` passes.

## Phase 2 - Promotion Confirmation and Runtime Enforcement

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/promotionGates.js -->
<!-- pilot:touches=scripts/verifyPromotionGates.js -->
<!-- pilot:touches=pipeline.js -->
<!-- runner:read=scripts/auditTrail.js -->
<!-- runner:read=README.md -->
<!-- runner:verify=npm run check -->

### Requirements

- Extend the readiness module with an activation evaluator that combines:
  - The current Phase 1 readiness result.
  - The deterministically selected promotion confirmation candidate.
  - A live-capable target state of `tiny_live` or `scaled_live`.
  - `promotion_allowed: true`.
  - A recognized signed-report marker.
  - A non-empty signature that passes the existing cryptographic verification procedure over the canonical signed payload.
  - A signed readiness proof matching the current readiness epoch as defined in Shared Constraints.
- Promotion confirmation files are structurally selectable only when they have a non-empty stable report identifier and valid generation timestamp.
- Group promotion reports by their stable report identifier:
  - Canonically equivalent duplicates count once.
  - Conflicting duplicates are excluded.
- Order selectable promotion reports by generation timestamp descending and stable report identifier descending using ordinal string comparison.
- Determine candidates for the requested strategy from the cryptographically verified signed payload, never solely from unsigned envelope fields.
- If a newer structurally valid report claims the requested strategy in unsigned fields but its signature or payload is invalid, it must remain visible as the newest failed candidate and fail closed rather than allowing an older approval to bypass it.
- Unsigned envelope fields may help identify and diagnose a failed candidate but must never authorize activation.
- Return activation status separately from readiness status so reaching the streak never implies automatic activation.
- Return a `confirmation` object that identifies the selected candidate, its signature-verification state, and its trusted signed-payload fields without exposing secrets.
- Add explicit activation blocker codes for:
  - `readiness_not_met`
  - `missing_confirmation`
  - `confirmation_strategy_mismatch`
  - `confirmation_non_live_target`
  - `confirmation_promotion_blocked`
  - `confirmation_missing_signature`
  - `confirmation_invalid_signature`
  - `confirmation_signed_payload_mismatch`
  - `confirmation_not_after_readiness`
  - `confirmation_stale_readiness_epoch`
- Blocker precedence and combinations must be deterministic and tested. Signature verification must occur before any signed field is treated as trusted.
- Integrate Phase 1 readiness into `evaluatePromotionGates()`:
  - `research`, `paper`, and `shadow` retain their existing behavior.
  - `tiny_live` and `scaled_live` receive a blocking `live_readiness_not_met` gate until the production 50-cycle policy is satisfied for the evaluated strategy version.
  - Include the full readiness summary and evaluated strategy version in the canonical payload of the signed promotion report.
  - Include the immutable readiness proof fields specified in Shared Constraints.
  - Preserve every existing gate; readiness is an additional requirement, not a replacement.
- Promotion signing must occur only after all gates, including readiness, are evaluated. The signed promotion decision must reflect the final gate result.
- Ensure the promotion command remains an explicit operator action. It may write a signed approval report but must not change `portfolio.json` or automatically disable paper mode.
- At cycle startup, when `portfolio.settings.paper_mode` requests live behavior, evaluate activation for `PAPER_ORDER_STRATEGY_VERSION` using one readiness snapshot and the deterministically selected promotion candidate.
- If activation is not allowed, use paper mode for all Risk and Executor decisions in that cycle and emit a structured pipeline warning containing the activation blocker codes.
- Compute the effective paper/live mode once at cycle startup and pass that effective mode consistently to every downstream Risk and Executor decision in the cycle.
- Do not silently bypass the gate when Manager or promotion report directories are missing or unreadable.
- Do not change behavior for an already requested paper-mode cycle and do not require promotion report scanning to keep that cycle in paper mode.
- Extend `scripts/verifyPromotionGates.js` with isolated fixtures proving:
  - An otherwise promotable live target is blocked at 49 qualifying cycles.
  - An otherwise promotable live target is approved at 50 qualifying cycles.
  - Readiness from a different strategy version does not satisfy promotion.
  - Readiness alone does not satisfy runtime activation.
  - An unsigned, signature-invalid, tampered, blocked, non-live, or mismatched promotion report cannot activate live behavior.
  - Altering an unsigned envelope field without changing the verified payload cannot authorize activation.
  - A cryptographically verified successful live promotion generated after readiness and bound to the matching strategy and threshold cycle satisfies activation.
  - The same approval remains valid after additional A/B cycles in the same readiness epoch.
  - A subsequent C, D, or F reset makes the older approval stale and prevents activation.
  - A later new 50-cycle streak requires a new approval bound to its new threshold cycle.
  - A confirmation timestamp at or before the threshold-cycle timestamp cannot activate live behavior.
  - Conflicting duplicate promotion IDs cannot activate live behavior.
  - A newer invalid candidate claiming the strategy cannot be bypassed by an older valid approval.
  - Existing under-sampled backtest blocking behavior remains intact.

### Acceptance Criteria

- No `tiny_live` or `scaled_live` promotion can be approved without 50 consecutive matching A/B Manager cycles.
- Achieving readiness does not mutate portfolio mode or activate live execution.
- Live-mode requests require a subsequent matching, cryptographically verified signed promotion approval.
- An approval remains usable through later qualifying cycles in the same readiness epoch but becomes invalid after a streak reset.
- A live-mode request without all prerequisites is deterministically treated as paper mode for the entire cycle.
- A fabricated, invalid, stale, conflicting, or tampered signature cannot authorize live behavior.
- The fail-closed decision is visible in structured logs with stable blocker codes.
- Existing backtest, walk-forward, custody, operator-permission, signing, verification, and audit gates continue to apply.
- `npm run check` passes.

## Phase 3 - Readiness API and Operator Documentation

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=README.md -->
<!-- runner:read=scripts/liveReadiness.js -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Import and use the shared readiness and activation evaluators in `server.js`; do not duplicate validation, deduplication, grade, streak, report-selection, epoch-binding, or signature-verification logic.
- Add a read-only `GET /api/promotions/readiness` endpoint.
- Accept an optional `strategy_version` query parameter, defaulting to the active strategy version used by the pipeline.
- Reject an explicitly supplied empty or invalidly typed strategy version with a deterministic client error rather than silently substituting the default.
- Return the Phase 1 readiness fields plus:
  - `activation_allowed`
  - `confirmation`
  - `activation_blockers`
  - `next_action`
- Ensure `confirmation` reports signature-verification and readiness-epoch matching status without exposing signing secrets or treating an unverified report as confirmed.
- Make `next_action` deterministic:
  - `continue_paper_validation` when readiness is incomplete.
  - `request_live_promotion_confirmation` when readiness is complete but a valid verified confirmation for the current epoch is absent.
  - `live_eligible` when both gates pass.
- Add the same compact readiness and activation summary to `/api/professional/summary` under `strategy.live_readiness` so existing clients can render progress without another request.
- Extend promotion summaries additively with readiness, threshold-cycle, and signature-verification information when present. Older promotion reports must remain readable but must not authorize activation unless they satisfy the verified signed-payload and current-readiness-epoch contract.
- Keep all endpoints read-only. A GET request must never write reports, change settings, start the pipeline, sign data, or confirm promotion.
- Missing or unreadable report directories must return valid blocked responses with stable blockers rather than exceptions or optimistic status.
- Update `README.md` to document:
  - The 50-consecutive-A/B policy.
  - Strategy-version isolation, duplicate handling, and streak reset behavior.
  - The readiness epoch and threshold-cycle proof.
  - The distinction between readiness, cryptographically verified signed confirmation, and runtime activation.
  - That an approval survives later A/B cycles in the same epoch but is invalidated by a C, D, or F reset.
  - The fail-closed paper-mode behavior for missing, invalid, stale, conflicting, or tampered confirmations.
  - The readiness endpoint and representative response fields.
  - That reaching 50 cycles does not automatically enable live trading.
- Do not modify dashboard assets.

### Acceptance Criteria

- `GET /api/promotions/readiness` returns deterministic progress and cryptographically verified activation state for the selected strategy.
- The professional summary exposes the same readiness counts and blocker state.
- API responses distinguish “continue validating,” “awaiting explicit confirmation,” and “eligible.”
- Missing reports return a valid blocked response rather than an exception or optimistic status.
- Invalid, stale, or tampered promotion signatures return a blocked response and never report eligibility.
- Later qualifying cycles do not incorrectly invalidate an approval bound to the same readiness epoch.
- Reading either endpoint causes no filesystem or portfolio mutation.
- Existing clients remain compatible because all response changes are additive.
- Documentation no longer describes live trading as enabled by a configuration change alone.
- `npm run check` passes.

```

### Reviewer 1: devin

Status: approved

Reason: Internally consistent, fail-closed security model, epoch-binding prevents stale approvals, 8-file budget exactly matches touched-files inventory, acceptance criteria are deterministic and testable.

Raw Response:

```text
---STATUS---
status: approved
reason: Internally consistent, fail-closed security model, epoch-binding prevents stale approvals, 8-file budget exactly matches touched-files inventory, acceptance criteria are deterministic and testable.
```

### Reviewer 2: codex

Status: revise

Reason: The confirmation timestamp and report identity are not explicitly bound to the verified signed payload, allowing unsigned envelope changes to influence candidate ordering and the required post-readiness authorization check.

Replacement Spec:

```spec
# Performance-Gated Paper-to-Live Readiness

## Overview

Replace config-only paper-to-live promotion with a deterministic progression gate based on the Manager’s existing A–F cycle grades. A strategy becomes live-ready only after 50 consecutive Manager cycles graded A or B. Live activation additionally requires an explicit, cryptographically verified promotion approval created after that threshold was reached and bound to the same strategy version and readiness epoch. The pipeline must fail closed to paper mode when any condition is absent or invalid.

Expose machine-readable readiness progress through the existing server APIs. Dashboard UI changes are excluded because `dashboard/**` is protected.

## Goals

- Track consecutive qualifying Manager cycles per strategy version.
- Require 50 consecutive A/B cycles for live readiness.
- Reset progress on any C, D, or F cycle.
- Prevent reports from different strategy versions from being combined.
- Require an explicit, cryptographically verified signed promotion approval after readiness is achieved.
- Bind approval to an immutable proof of the current qualifying streak so later A/B cycles preserve approval while a subsequent reset invalidates it.
- Bind the promotion report identity and creation timestamp to the verified signed payload.
- Force requested live operation back to paper mode when readiness or confirmation is missing or invalid.
- Expose progress, remaining cycles, blockers, and confirmation state through existing APIs.
- Preserve the current default of paper mode and all existing promotion checks.

## Non-Goals

- Implementing exchange order submission, wallet signing, custody, or new live execution infrastructure.
- Modifying custody, risk-engine, executor, dashboard, installer, cron, or dependency-lock files.
- Adding tiered live capabilities.
- Allowing an environment variable or portfolio setting to reduce the 50-cycle production threshold.
- Treating historical Manager reports without a matching strategy version as qualifying.
- Automatically enabling live mode when the threshold is reached.
- Adding the visual dashboard progress bar; this spec provides the API contract that a later dashboard change can consume.

## Existing Files

- `pipeline.js` creates Manager cycle reports and contains the runtime paper/live decision path.
- `scripts/promotionGates.js` evaluates signed strategy promotion reports for `research`, `paper`, `shadow`, `tiny_live`, and `scaled_live`.
- `scripts/verifyPromotionGates.js` verifies promotion gates with isolated fixtures.
- `server.js` exposes Manager and promotion report APIs plus the professional summary.
- `package.json` defines the configured `npm run check` verification command.
- `README.md` documents paper-mode safety and current live-trading prerequisites.

## Shared Constraints

- Keep the implementation within 8 changed files and 600 changed lines.
- Preserve “AI suggests, code decides”: readiness and activation decisions must be deterministic and outside LLM prompts.
- Production readiness policy is immutable and exactly:
  - `required_consecutive_cycles: 50`
  - `qualifying_grades: ["A", "B"]`
- Readiness must be evaluated independently for the requested strategy version.
- A Manager report is valid only when it has:
  - A non-empty string `report_id`.
  - A `generated_at` value that parses as a valid timestamp.
  - A non-empty string `strategy_version`.
  - A recognized `overall_grade` of `A`, `B`, `C`, `D`, or `F`.
- Normalize valid timestamps to their numeric epoch value for comparison and serialize returned normalized timestamps as UTC ISO-8601 strings using `new Date(epoch).toISOString()`.
- Group Manager reports by `report_id` before counting:
  - Byte-for-byte or canonically equivalent duplicates count once.
  - If reports sharing an ID disagree on any readiness-relevant field, exclude the entire conflicting ID from progress and treat it as malformed.
  - Filesystem enumeration order must never decide which duplicate wins.
- Sort remaining reports by timestamp ascending and then by `report_id` ascending using ordinal Unicode code-unit string comparison.
- Malformed, conflicting, unreadable, or unrelated files must never contribute qualifying progress.
- The current streak is the terminal run of A/B reports after the newest valid C, D, or F report for the requested strategy.
- The readiness epoch is the terminal A/B run containing the current streak. When the streak first reaches 50, its 50th report becomes the immutable `threshold_cycle` for that epoch. Additional A/B reports do not change that threshold cycle. Any later C, D, or F report ends the epoch; a future streak receives a different threshold cycle.
- Reaching 50 qualifying cycles establishes eligibility only; it must not mutate portfolio settings or activate live execution automatically.
- Live activation additionally requires a cryptographically verified, successful promotion report for the same strategy version and a live-capable target state.
- The signed payload must bind:
  - The promotion report’s stable identifier.
  - The promotion report’s normalized generation timestamp.
  - The recognized signed-report marker.
  - The strategy version.
  - The target state.
  - The promotion decision.
  - The readiness policy.
  - The immutable threshold-cycle proof used to approve promotion.
- For a cryptographically verified report, its top-level report identifier, generation timestamp, signed-report marker, strategy version, target state, and promotion decision must match their signed-payload counterparts. A mismatch makes the confirmation invalid.
- Values outside the verified payload must not authorize activation, satisfy the post-readiness timestamp check, or supply trusted confirmation fields.
- A confirmation is valid for the current readiness epoch when its signed readiness proof matches:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `readiness_met: true`
  - `threshold_cycle.report_id`
  - `threshold_cycle.generated_at`
- Timestamp proof comparisons must use normalized UTC ISO-8601 values derived from epoch milliseconds, so equivalent input timestamp representations compare equally.
- Mutable fields such as current streak length, remaining cycles, progress percentage, valid-cycle count, and latest cycle may be included for auditability but must not be required to remain equal after later qualifying cycles.
- A promotion confirmation’s signed `generated_at` must be valid and strictly later by epoch milliseconds than the bound threshold cycle’s timestamp.
- Any missing, malformed, mismatched, unsigned, signature-invalid, tampered, stale-epoch, or blocked confirmation must fail closed to paper mode.
- Preserve and reuse all existing promotion metrics, custody checks, canonical signing and verification behavior, and audit behavior.
- Do not modify any protected path.
- Use only Node.js built-ins and existing dependencies.
- `npm run check` is the configured verification command for every phase.

## Phase 1 - Deterministic Live-Readiness Tracker

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/verifyLiveReadiness.js -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:read=scripts/verifyPromotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Add `scripts/liveReadiness.js` with side-effect-free exported evaluators that can accept in-memory reports for tests and scan a supplied reports directory for production.
- Apply the immutable production policy defined in Shared Constraints.
- Evaluate only valid Manager cycle reports matching the requested strategy version.
- Apply the specified duplicate grouping, conflict exclusion, timestamp normalization, and deterministic ordering rules.
- Calculate the consecutive qualifying streak ending at the newest valid matching report.
- Reset the streak to zero after a nonqualifying recognized grade, then count any subsequent A/B reports.
- Return a stable JSON-ready result containing at least:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `valid_cycle_count`
  - `current_qualifying_streak`
  - `remaining_qualifying_cycles`
  - `progress_pct`
  - `readiness_met`
  - `latest_cycle`
  - `threshold_cycle`
  - `blockers`
- `threshold_cycle` must be `null` before readiness and otherwise contain at least the report ID and normalized UTC ISO-8601 generation timestamp of the 50th report in the current readiness epoch.
- Clamp `remaining_qualifying_cycles` to zero and `progress_pct` to 100.
- Use explicit blocker codes for:
  - `missing_strategy_version`
  - `no_valid_matching_manager_reports`
  - `insufficient_qualifying_cycles`
- Malformed and conflicting duplicates may be exposed as nonblocking diagnostics but must not introduce input-order-dependent blockers or results.
- Permit test-only policy injection through explicit function arguments without exposing a production environment-variable or portfolio-setting override.
- Stamp newly generated Manager reports in `pipeline.js` with the active `PAPER_ORDER_STRATEGY_VERSION` as `strategy_version`.
- Do not retroactively treat unstamped historical reports as belonging to the current strategy.
- Directory scanning must return a blocked readiness result, rather than throwing or succeeding optimistically, when the directory is missing or unreadable.
- Add `scripts/verifyLiveReadiness.js` using temporary fixtures to verify:
  - 49 consecutive A/B reports remain blocked.
  - The 50th consecutive A/B report unlocks readiness.
  - Additional A/B reports preserve the same threshold cycle.
  - A C, D, or F grade resets the streak and clears the threshold cycle.
  - Reports for another strategy version do not count.
  - Equivalent duplicates count once.
  - Conflicting duplicates are excluded regardless of input order.
  - Malformed reports do not inflate progress.
  - Ordering is deterministic for equal timestamps.
  - Equivalent timestamp representations normalize identically.
  - Reversing the input array and filesystem enumeration produces deeply equal results.
- Add syntax checking and execution of the new verifier to the existing `npm run check` command without replacing or broadening it to another package script.

### Acceptance Criteria

- A strategy with 50 valid consecutive A/B Manager reports returns `readiness_met: true`, zero remaining cycles, 100% progress, and a deterministic threshold cycle.
- A strategy with any shorter terminal streak returns `readiness_met: false` and an `insufficient_qualifying_cycles` blocker.
- A C, D, or F report breaks the preceding streak even when older history contains 50 qualifying reports.
- Reports from other or missing strategy versions cannot contribute progress.
- Conflicting reports sharing an ID cannot contribute progress.
- Repeated evaluation over identical logical inputs returns deeply equal results regardless of input or directory enumeration order.
- Existing Manager report generation remains compatible apart from the additive `strategy_version` field.
- `npm run check` passes.

## Phase 2 - Promotion Confirmation and Runtime Enforcement

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/promotionGates.js -->
<!-- pilot:touches=scripts/verifyPromotionGates.js -->
<!-- pilot:touches=pipeline.js -->
<!-- runner:read=scripts/auditTrail.js -->
<!-- runner:read=README.md -->
<!-- runner:verify=npm run check -->

### Requirements

- Extend the readiness module with an activation evaluator that combines:
  - The current Phase 1 readiness result.
  - The deterministically selected promotion confirmation candidate.
  - A live-capable target state of `tiny_live` or `scaled_live`.
  - `promotion_allowed: true`.
  - A recognized signed-report marker present in and verified as part of the signed payload.
  - A non-empty signature that passes the existing cryptographic verification procedure over the canonical signed payload.
  - Signed report identity and timestamp fields matching the structural envelope.
  - A signed readiness proof matching the current readiness epoch as defined in Shared Constraints.
- Promotion confirmation files are structurally selectable only when their top-level envelope has a non-empty stable report identifier and valid generation timestamp.
- Group structurally selectable promotion reports by their top-level stable report identifier:
  - Canonically equivalent duplicates count once.
  - Conflicting duplicates are excluded.
- Order selectable promotion reports by their top-level generation timestamp descending and stable report identifier descending using ordinal Unicode code-unit string comparison.
- For a report with a valid signature, determine whether it is a candidate for the requested strategy only from its verified signed payload.
- For a report whose signed payload or signature cannot be verified, treat it as claiming the requested strategy only when its designated top-level `strategy_version` field is a non-empty string exactly equal to the requested strategy version.
- A newer structurally valid report that claims the requested strategy under the preceding rules must remain visible as the newest failed candidate and fail closed rather than allowing an older approval to bypass it.
- An invalid report without either a verified signed strategy match or an exact designated top-level strategy claim is unrelated and must not block the requested strategy.
- Unsigned envelope fields may identify and diagnose a failed candidate but must never authorize activation, satisfy the confirmation timestamp requirement, or appear as trusted confirmation fields.
- Return activation status separately from readiness status so reaching the streak never implies automatic activation.
- Return a `confirmation` object that identifies the selected candidate, distinguishes untrusted envelope metadata from trusted signed-payload fields, and reports signature-verification, envelope-match, timestamp, and readiness-epoch matching state without exposing secrets.
- Add explicit activation blocker codes for:
  - `readiness_not_met`
  - `missing_confirmation`
  - `confirmation_strategy_mismatch`
  - `confirmation_non_live_target`
  - `confirmation_promotion_blocked`
  - `confirmation_missing_signature`
  - `confirmation_invalid_signature`
  - `confirmation_signed_payload_mismatch`
  - `confirmation_not_after_readiness`
  - `confirmation_stale_readiness_epoch`
- Blocker precedence and combinations must be deterministic and tested. Signature verification must occur before any signed field is treated as trusted.
- Integrate Phase 1 readiness into `evaluatePromotionGates()`:
  - `research`, `paper`, and `shadow` retain their existing behavior.
  - `tiny_live` and `scaled_live` receive a blocking `live_readiness_not_met` gate until the production 50-cycle policy is satisfied for the evaluated strategy version.
  - Include the full readiness summary and evaluated strategy version in the canonical payload of the signed promotion report.
  - Include the stable promotion report identifier, normalized UTC ISO-8601 promotion generation timestamp, recognized signed-report marker, and immutable readiness proof fields specified in Shared Constraints in that payload.
  - Preserve every existing gate; readiness is an additional requirement, not a replacement.
- Promotion signing must occur only after all gates, including readiness, are evaluated. The signed promotion decision must reflect the final gate result.
- Ensure the promotion command remains an explicit operator action. It may write a signed approval report but must not change `portfolio.json` or automatically disable paper mode.
- At cycle startup, when `portfolio.settings.paper_mode` requests live behavior, evaluate activation for `PAPER_ORDER_STRATEGY_VERSION` using one readiness snapshot and the deterministically selected promotion candidate.
- If activation is not allowed, use paper mode for all Risk and Executor decisions in that cycle and emit a structured pipeline warning containing the activation blocker codes.
- Compute the effective paper/live mode once at cycle startup and pass that effective mode consistently to every downstream Risk and Executor decision in the cycle.
- Do not silently bypass the gate when Manager or promotion report directories are missing or unreadable.
- Do not change behavior for an already requested paper-mode cycle and do not require promotion report scanning to keep that cycle in paper mode.
- Extend `scripts/verifyPromotionGates.js` with isolated fixtures proving:
  - An otherwise promotable live target is blocked at 49 qualifying cycles.
  - An otherwise promotable live target is approved at 50 qualifying cycles.
  - Readiness from a different strategy version does not satisfy promotion.
  - Readiness alone does not satisfy runtime activation.
  - An unsigned, signature-invalid, tampered, blocked, non-live, or mismatched promotion report cannot activate live behavior.
  - Altering an unsigned envelope strategy, target, decision, marker, report identifier, or generation timestamp without changing the verified payload cannot authorize activation.
  - A cryptographically verified successful live promotion generated after readiness and bound to the matching report identity, timestamp, strategy, and threshold cycle satisfies activation.
  - The same approval remains valid after additional A/B cycles in the same readiness epoch.
  - A subsequent C, D, or F reset makes the older approval stale and prevents activation.
  - A later new 50-cycle streak requires a new approval bound to its new threshold cycle.
  - A signed confirmation timestamp at or before the threshold-cycle timestamp cannot activate live behavior.
  - An unsigned envelope timestamp later than the threshold cannot make an earlier signed confirmation timestamp valid.
  - Conflicting duplicate promotion IDs cannot activate live behavior.
  - A newer invalid candidate claiming the strategy cannot be bypassed by an older valid approval.
  - A newer invalid report unrelated to the requested strategy does not block an older valid approval.
  - Existing under-sampled backtest blocking behavior remains intact.

### Acceptance Criteria

- No `tiny_live` or `scaled_live` promotion can be approved without 50 consecutive matching A/B Manager cycles.
- Achieving readiness does not mutate portfolio mode or activate live execution.
- Live-mode requests require a subsequent matching, cryptographically verified signed promotion approval.
- The approval’s report identity and post-readiness creation timestamp are authenticated by its signature.
- An approval remains usable through later qualifying cycles in the same readiness epoch but becomes invalid after a streak reset.
- A live-mode request without all prerequisites is deterministically treated as paper mode for the entire cycle.
- A fabricated, invalid, stale, conflicting, or tampered signature cannot authorize live behavior.
- The fail-closed decision is visible in structured logs with stable blocker codes.
- Existing backtest, walk-forward, custody, operator-permission, signing, verification, and audit gates continue to apply.
- `npm run check` passes.

## Phase 3 - Readiness API and Operator Documentation

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=README.md -->
<!-- runner:read=scripts/liveReadiness.js -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Import and use the shared readiness and activation evaluators in `server.js`; do not duplicate validation, deduplication, timestamp normalization, grade, streak, report-selection, epoch-binding, or signature-verification logic.
- Add a read-only `GET /api/promotions/readiness` endpoint.
- Accept an optional `strategy_version` query parameter, defaulting to the active strategy version used by the pipeline.
- Reject an explicitly supplied empty or invalidly typed strategy version with a deterministic client error rather than silently substituting the default.
- Return the Phase 1 readiness fields plus:
  - `activation_allowed`
  - `confirmation`
  - `activation_blockers`
  - `next_action`
- Ensure `confirmation` distinguishes untrusted envelope metadata from trusted signed-payload fields and reports signature-verification, envelope-match, timestamp, and readiness-epoch matching status without exposing signing secrets or treating an unverified report as confirmed.
- Make `next_action` deterministic:
  - `continue_paper_validation` when readiness is incomplete.
  - `request_live_promotion_confirmation` when readiness is complete but a valid verified confirmation for the current epoch is absent.
  - `live_eligible` when both gates pass.
- Add the same compact readiness and activation summary to `/api/professional/summary` under `strategy.live_readiness` so existing clients can render progress without another request.
- Extend promotion summaries additively with readiness, threshold-cycle, signed report identity, signed timestamp, envelope-match, and signature-verification information when present. Older promotion reports must remain readable but must not authorize activation unless they satisfy the verified signed-payload and current-readiness-epoch contract.
- Keep all endpoints read-only. A GET request must never write reports, change settings, start the pipeline, sign data, or confirm promotion.
- Missing or unreadable report directories must return valid blocked responses with stable blockers rather than exceptions or optimistic status.
- Update `README.md` to document:
  - The 50-consecutive-A/B policy.
  - Strategy-version isolation, duplicate handling, and streak reset behavior.
  - The readiness epoch and threshold-cycle proof.
  - The distinction between readiness, cryptographically verified signed confirmation, and runtime activation.
  - That confirmation identity and generation time are part of the signed payload.
  - That an approval survives later A/B cycles in the same epoch but is invalidated by a C, D, or F reset.
  - The fail-closed paper-mode behavior for missing, invalid, stale, conflicting, or tampered confirmations.
  - The readiness endpoint and representative response fields.
  - That reaching 50 cycles does not automatically enable live trading.
- Do not modify dashboard assets.

### Acceptance Criteria

- `GET /api/promotions/readiness` returns deterministic progress and cryptographically verified activation state for the selected strategy.
- The professional summary exposes the same readiness counts and blocker state.
- API responses distinguish “continue validating,” “awaiting explicit confirmation,” and “eligible.”
- Missing reports return a valid blocked response rather than an exception or optimistic status.
- Invalid, stale, or tampered promotion signatures or unsigned envelope metadata return a blocked response and never report eligibility.
- Later qualifying cycles do not incorrectly invalidate an approval bound to the same readiness epoch.
- Reading either endpoint causes no filesystem or portfolio mutation.
- Existing clients remain compatible because all response changes are additive.
- Documentation no longer describes live trading as enabled by a configuration change alone.
- `npm run check` passes.
```

Raw Response:

```text
---STATUS---
status: revise
reason: The confirmation timestamp and report identity are not explicitly bound to the verified signed payload, allowing unsigned envelope changes to influence candidate ordering and the required post-readiness authorization check.
```spec
# Performance-Gated Paper-to-Live Readiness

## Overview

Replace config-only paper-to-live promotion with a deterministic progression gate based on the Manager’s existing A–F cycle grades. A strategy becomes live-ready only after 50 consecutive Manager cycles graded A or B. Live activation additionally requires an explicit, cryptographically verified promotion approval created after that threshold was reached and bound to the same strategy version and readiness epoch. The pipeline must fail closed to paper mode when any condition is absent or invalid.

Expose machine-readable readiness progress through the existing server APIs. Dashboard UI changes are excluded because `dashboard/**` is protected.

## Goals

- Track consecutive qualifying Manager cycles per strategy version.
- Require 50 consecutive A/B cycles for live readiness.
- Reset progress on any C, D, or F cycle.
- Prevent reports from different strategy versions from being combined.
- Require an explicit, cryptographically verified signed promotion approval after readiness is achieved.
- Bind approval to an immutable proof of the current qualifying streak so later A/B cycles preserve approval while a subsequent reset invalidates it.
- Bind the promotion report identity and creation timestamp to the verified signed payload.
- Force requested live operation back to paper mode when readiness or confirmation is missing or invalid.
- Expose progress, remaining cycles, blockers, and confirmation state through existing APIs.
- Preserve the current default of paper mode and all existing promotion checks.

## Non-Goals

- Implementing exchange order submission, wallet signing, custody, or new live execution infrastructure.
- Modifying custody, risk-engine, executor, dashboard, installer, cron, or dependency-lock files.
- Adding tiered live capabilities.
- Allowing an environment variable or portfolio setting to reduce the 50-cycle production threshold.
- Treating historical Manager reports without a matching strategy version as qualifying.
- Automatically enabling live mode when the threshold is reached.
- Adding the visual dashboard progress bar; this spec provides the API contract that a later dashboard change can consume.

## Existing Files

- `pipeline.js` creates Manager cycle reports and contains the runtime paper/live decision path.
- `scripts/promotionGates.js` evaluates signed strategy promotion reports for `research`, `paper`, `shadow`, `tiny_live`, and `scaled_live`.
- `scripts/verifyPromotionGates.js` verifies promotion gates with isolated fixtures.
- `server.js` exposes Manager and promotion report APIs plus the professional summary.
- `package.json` defines the configured `npm run check` verification command.
- `README.md` documents paper-mode safety and current live-trading prerequisites.

## Shared Constraints

- Keep the implementation within 8 changed files and 600 changed lines.
- Preserve “AI suggests, code decides”: readiness and activation decisions must be deterministic and outside LLM prompts.
- Production readiness policy is immutable and exactly:
  - `required_consecutive_cycles: 50`
  - `qualifying_grades: ["A", "B"]`
- Readiness must be evaluated independently for the requested strategy version.
- A Manager report is valid only when it has:
  - A non-empty string `report_id`.
  - A `generated_at` value that parses as a valid timestamp.
  - A non-empty string `strategy_version`.
  - A recognized `overall_grade` of `A`, `B`, `C`, `D`, or `F`.
- Normalize valid timestamps to their numeric epoch value for comparison and serialize returned normalized timestamps as UTC ISO-8601 strings using `new Date(epoch).toISOString()`.
- Group Manager reports by `report_id` before counting:
  - Byte-for-byte or canonically equivalent duplicates count once.
  - If reports sharing an ID disagree on any readiness-relevant field, exclude the entire conflicting ID from progress and treat it as malformed.
  - Filesystem enumeration order must never decide which duplicate wins.
- Sort remaining reports by timestamp ascending and then by `report_id` ascending using ordinal Unicode code-unit string comparison.
- Malformed, conflicting, unreadable, or unrelated files must never contribute qualifying progress.
- The current streak is the terminal run of A/B reports after the newest valid C, D, or F report for the requested strategy.
- The readiness epoch is the terminal A/B run containing the current streak. When the streak first reaches 50, its 50th report becomes the immutable `threshold_cycle` for that epoch. Additional A/B reports do not change that threshold cycle. Any later C, D, or F report ends the epoch; a future streak receives a different threshold cycle.
- Reaching 50 qualifying cycles establishes eligibility only; it must not mutate portfolio settings or activate live execution automatically.
- Live activation additionally requires a cryptographically verified, successful promotion report for the same strategy version and a live-capable target state.
- The signed payload must bind:
  - The promotion report’s stable identifier.
  - The promotion report’s normalized generation timestamp.
  - The recognized signed-report marker.
  - The strategy version.
  - The target state.
  - The promotion decision.
  - The readiness policy.
  - The immutable threshold-cycle proof used to approve promotion.
- For a cryptographically verified report, its top-level report identifier, generation timestamp, signed-report marker, strategy version, target state, and promotion decision must match their signed-payload counterparts. A mismatch makes the confirmation invalid.
- Values outside the verified payload must not authorize activation, satisfy the post-readiness timestamp check, or supply trusted confirmation fields.
- A confirmation is valid for the current readiness epoch when its signed readiness proof matches:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `readiness_met: true`
  - `threshold_cycle.report_id`
  - `threshold_cycle.generated_at`
- Timestamp proof comparisons must use normalized UTC ISO-8601 values derived from epoch milliseconds, so equivalent input timestamp representations compare equally.
- Mutable fields such as current streak length, remaining cycles, progress percentage, valid-cycle count, and latest cycle may be included for auditability but must not be required to remain equal after later qualifying cycles.
- A promotion confirmation’s signed `generated_at` must be valid and strictly later by epoch milliseconds than the bound threshold cycle’s timestamp.
- Any missing, malformed, mismatched, unsigned, signature-invalid, tampered, stale-epoch, or blocked confirmation must fail closed to paper mode.
- Preserve and reuse all existing promotion metrics, custody checks, canonical signing and verification behavior, and audit behavior.
- Do not modify any protected path.
- Use only Node.js built-ins and existing dependencies.
- `npm run check` is the configured verification command for every phase.

## Phase 1 - Deterministic Live-Readiness Tracker

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/verifyLiveReadiness.js -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:read=scripts/verifyPromotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Add `scripts/liveReadiness.js` with side-effect-free exported evaluators that can accept in-memory reports for tests and scan a supplied reports directory for production.
- Apply the immutable production policy defined in Shared Constraints.
- Evaluate only valid Manager cycle reports matching the requested strategy version.
- Apply the specified duplicate grouping, conflict exclusion, timestamp normalization, and deterministic ordering rules.
- Calculate the consecutive qualifying streak ending at the newest valid matching report.
- Reset the streak to zero after a nonqualifying recognized grade, then count any subsequent A/B reports.
- Return a stable JSON-ready result containing at least:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `valid_cycle_count`
  - `current_qualifying_streak`
  - `remaining_qualifying_cycles`
  - `progress_pct`
  - `readiness_met`
  - `latest_cycle`
  - `threshold_cycle`
  - `blockers`
- `threshold_cycle` must be `null` before readiness and otherwise contain at least the report ID and normalized UTC ISO-8601 generation timestamp of the 50th report in the current readiness epoch.
- Clamp `remaining_qualifying_cycles` to zero and `progress_pct` to 100.
- Use explicit blocker codes for:
  - `missing_strategy_version`
  - `no_valid_matching_manager_reports`
  - `insufficient_qualifying_cycles`
- Malformed and conflicting duplicates may be exposed as nonblocking diagnostics but must not introduce input-order-dependent blockers or results.
- Permit test-only policy injection through explicit function arguments without exposing a production environment-variable or portfolio-setting override.
- Stamp newly generated Manager reports in `pipeline.js` with the active `PAPER_ORDER_STRATEGY_VERSION` as `strategy_version`.
- Do not retroactively treat unstamped historical reports as belonging to the current strategy.
- Directory scanning must return a blocked readiness result, rather than throwing or succeeding optimistically, when the directory is missing or unreadable.
- Add `scripts/verifyLiveReadiness.js` using temporary fixtures to verify:
  - 49 consecutive A/B reports remain blocked.
  - The 50th consecutive A/B report unlocks readiness.
  - Additional A/B reports preserve the same threshold cycle.
  - A C, D, or F grade resets the streak and clears the threshold cycle.
  - Reports for another strategy version do not count.
  - Equivalent duplicates count once.
  - Conflicting duplicates are excluded regardless of input order.
  - Malformed reports do not inflate progress.
  - Ordering is deterministic for equal timestamps.
  - Equivalent timestamp representations normalize identically.
  - Reversing the input array and filesystem enumeration produces deeply equal results.
- Add syntax checking and execution of the new verifier to the existing `npm run check` command without replacing or broadening it to another package script.

### Acceptance Criteria

- A strategy with 50 valid consecutive A/B Manager reports returns `readiness_met: true`, zero remaining cycles, 100% progress, and a deterministic threshold cycle.
- A strategy with any shorter terminal streak returns `readiness_met: false` and an `insufficient_qualifying_cycles` blocker.
- A C, D, or F report breaks the preceding streak even when older history contains 50 qualifying reports.
- Reports from other or missing strategy versions cannot contribute progress.
- Conflicting reports sharing an ID cannot contribute progress.
- Repeated evaluation over identical logical inputs returns deeply equal results regardless of input or directory enumeration order.
- Existing Manager report generation remains compatible apart from the additive `strategy_version` field.
- `npm run check` passes.

## Phase 2 - Promotion Confirmation and Runtime Enforcement

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/promotionGates.js -->
<!-- pilot:touches=scripts/verifyPromotionGates.js -->
<!-- pilot:touches=pipeline.js -->
<!-- runner:read=scripts/auditTrail.js -->
<!-- runner:read=README.md -->
<!-- runner:verify=npm run check -->

### Requirements

- Extend the readiness module with an activation evaluator that combines:
  - The current Phase 1 readiness result.
  - The deterministically selected promotion confirmation candidate.
  - A live-capable target state of `tiny_live` or `scaled_live`.
  - `promotion_allowed: true`.
  - A recognized signed-report marker present in and verified as part of the signed payload.
  - A non-empty signature that passes the existing cryptographic verification procedure over the canonical signed payload.
  - Signed report identity and timestamp fields matching the structural envelope.
  - A signed readiness proof matching the current readiness epoch as defined in Shared Constraints.
- Promotion confirmation files are structurally selectable only when their top-level envelope has a non-empty stable report identifier and valid generation timestamp.
- Group structurally selectable promotion reports by their top-level stable report identifier:
  - Canonically equivalent duplicates count once.
  - Conflicting duplicates are excluded.
- Order selectable promotion reports by their top-level generation timestamp descending and stable report identifier descending using ordinal Unicode code-unit string comparison.
- For a report with a valid signature, determine whether it is a candidate for the requested strategy only from its verified signed payload.
- For a report whose signed payload or signature cannot be verified, treat it as claiming the requested strategy only when its designated top-level `strategy_version` field is a non-empty string exactly equal to the requested strategy version.
- A newer structurally valid report that claims the requested strategy under the preceding rules must remain visible as the newest failed candidate and fail closed rather than allowing an older approval to bypass it.
- An invalid report without either a verified signed strategy match or an exact designated top-level strategy claim is unrelated and must not block the requested strategy.
- Unsigned envelope fields may identify and diagnose a failed candidate but must never authorize activation, satisfy the confirmation timestamp requirement, or appear as trusted confirmation fields.
- Return activation status separately from readiness status so reaching the streak never implies automatic activation.
- Return a `confirmation` object that identifies the selected candidate, distinguishes untrusted envelope metadata from trusted signed-payload fields, and reports signature-verification, envelope-match, timestamp, and readiness-epoch matching state without exposing secrets.
- Add explicit activation blocker codes for:
  - `readiness_not_met`
  - `missing_confirmation`
  - `confirmation_strategy_mismatch`
  - `confirmation_non_live_target`
  - `confirmation_promotion_blocked`
  - `confirmation_missing_signature`
  - `confirmation_invalid_signature`
  - `confirmation_signed_payload_mismatch`
  - `confirmation_not_after_readiness`
  - `confirmation_stale_readiness_epoch`
- Blocker precedence and combinations must be deterministic and tested. Signature verification must occur before any signed field is treated as trusted.
- Integrate Phase 1 readiness into `evaluatePromotionGates()`:
  - `research`, `paper`, and `shadow` retain their existing behavior.
  - `tiny_live` and `scaled_live` receive a blocking `live_readiness_not_met` gate until the production 50-cycle policy is satisfied for the evaluated strategy version.
  - Include the full readiness summary and evaluated strategy version in the canonical payload of the signed promotion report.
  - Include the stable promotion report identifier, normalized UTC ISO-8601 promotion generation timestamp, recognized signed-report marker, and immutable readiness proof fields specified in Shared Constraints in that payload.
  - Preserve every existing gate; readiness is an additional requirement, not a replacement.
- Promotion signing must occur only after all gates, including readiness, are evaluated. The signed promotion decision must reflect the final gate result.
- Ensure the promotion command remains an explicit operator action. It may write a signed approval report but must not change `portfolio.json` or automatically disable paper mode.
- At cycle startup, when `portfolio.settings.paper_mode` requests live behavior, evaluate activation for `PAPER_ORDER_STRATEGY_VERSION` using one readiness snapshot and the deterministically selected promotion candidate.
- If activation is not allowed, use paper mode for all Risk and Executor decisions in that cycle and emit a structured pipeline warning containing the activation blocker codes.
- Compute the effective paper/live mode once at cycle startup and pass that effective mode consistently to every downstream Risk and Executor decision in the cycle.
- Do not silently bypass the gate when Manager or promotion report directories are missing or unreadable.
- Do not change behavior for an already requested paper-mode cycle and do not require promotion report scanning to keep that cycle in paper mode.
- Extend `scripts/verifyPromotionGates.js` with isolated fixtures proving:
  - An otherwise promotable live target is blocked at 49 qualifying cycles.
  - An otherwise promotable live target is approved at 50 qualifying cycles.
  - Readiness from a different strategy version does not satisfy promotion.
  - Readiness alone does not satisfy runtime activation.
  - An unsigned, signature-invalid, tampered, blocked, non-live, or mismatched promotion report cannot activate live behavior.
  - Altering an unsigned envelope strategy, target, decision, marker, report identifier, or generation timestamp without changing the verified payload cannot authorize activation.
  - A cryptographically verified successful live promotion generated after readiness and bound to the matching report identity, timestamp, strategy, and threshold cycle satisfies activation.
  - The same approval remains valid after additional A/B cycles in the same readiness epoch.
  - A subsequent C, D, or F reset makes the older approval stale and prevents activation.
  - A later new 50-cycle streak requires a new approval bound to its new threshold cycle.
  - A signed confirmation timestamp at or before the threshold-cycle timestamp cannot activate live behavior.
  - An unsigned envelope timestamp later than the threshold cannot make an earlier signed confirmation timestamp valid.
  - Conflicting duplicate promotion IDs cannot activate live behavior.
  - A newer invalid candidate claiming the strategy cannot be bypassed by an older valid approval.
  - A newer invalid report unrelated to the requested strategy does not block an older valid approval.
  - Existing under-sampled backtest blocking behavior remains intact.

### Acceptance Criteria

- No `tiny_live` or `scaled_live` promotion can be approved without 50 consecutive matching A/B Manager cycles.
- Achieving readiness does not mutate portfolio mode or activate live execution.
- Live-mode requests require a subsequent matching, cryptographically verified signed promotion approval.
- The approval’s report identity and post-readiness creation timestamp are authenticated by its signature.
- An approval remains usable through later qualifying cycles in the same readiness epoch but becomes invalid after a streak reset.
- A live-mode request without all prerequisites is deterministically treated as paper mode for the entire cycle.
- A fabricated, invalid, stale, conflicting, or tampered signature cannot authorize live behavior.
- The fail-closed decision is visible in structured logs with stable blocker codes.
- Existing backtest, walk-forward, custody, operator-permission, signing, verification, and audit gates continue to apply.
- `npm run check` passes.

## Phase 3 - Readiness API and Operator Documentation

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=README.md -->
<!-- runner:read=scripts/liveReadiness.js -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Import and use the shared readiness and activation evaluators in `server.js`; do not duplicate validation, deduplication, timestamp normalization, grade, streak, report-selection, epoch-binding, or signature-verification logic.
- Add a read-only `GET /api/promotions/readiness` endpoint.
- Accept an optional `strategy_version` query parameter, defaulting to the active strategy version used by the pipeline.
- Reject an explicitly supplied empty or invalidly typed strategy version with a deterministic client error rather than silently substituting the default.
- Return the Phase 1 readiness fields plus:
  - `activation_allowed`
  - `confirmation`
  - `activation_blockers`
  - `next_action`
- Ensure `confirmation` distinguishes untrusted envelope metadata from trusted signed-payload fields and reports signature-verification, envelope-match, timestamp, and readiness-epoch matching status without exposing signing secrets or treating an unverified report as confirmed.
- Make `next_action` deterministic:
  - `continue_paper_validation` when readiness is incomplete.
  - `request_live_promotion_confirmation` when readiness is complete but a valid verified confirmation for the current epoch is absent.
  - `live_eligible` when both gates pass.
- Add the same compact readiness and activation summary to `/api/professional/summary` under `strategy.live_readiness` so existing clients can render progress without another request.
- Extend promotion summaries additively with readiness, threshold-cycle, signed report identity, signed timestamp, envelope-match, and signature-verification information when present. Older promotion reports must remain readable but must not authorize activation unless they satisfy the verified signed-payload and current-readiness-epoch contract.
- Keep all endpoints read-only. A GET request must never write reports, change settings, start the pipeline, sign data, or confirm promotion.
- Missing or unreadable report directories must return valid blocked responses with stable blockers rather than exceptions or optimistic status.
- Update `README.md` to document:
  - The 50-consecutive-A/B policy.
  - Strategy-version isolation, duplicate handling, and streak reset behavior.
  - The readiness epoch and threshold-cycle proof.
  - The distinction between readiness, cryptographically verified signed confirmation, and runtime activation.
  - That confirmation identity and generation time are part of the signed payload.
  - That an approval survives later A/B cycles in the same epoch but is invalidated by a C, D, or F reset.
  - The fail-closed paper-mode behavior for missing, invalid, stale, conflicting, or tampered confirmations.
  - The readiness endpoint and representative response fields.
  - That reaching 50 cycles does not automatically enable live trading.
- Do not modify dashboard assets.

### Acceptance Criteria

- `GET /api/promotions/readiness` returns deterministic progress and cryptographically verified activation state for the selected strategy.
- The professional summary exposes the same readiness counts and blocker state.
- API responses distinguish “continue validating,” “awaiting explicit confirmation,” and “eligible.”
- Missing reports return a valid blocked response rather than an exception or optimistic status.
- Invalid, stale, or tampered promotion signatures or unsigned envelope metadata return a blocked response and never report eligibility.
- Later qualifying cycles do not incorrectly invalidate an approval bound to the same readiness epoch.
- Reading either endpoint causes no filesystem or portfolio mutation.
- Existing clients remain compatible because all response changes are additive.
- Documentation no longer describes live trading as enabled by a configuration change alone.
- `npm run check` passes.
```
```

Round Result: not converged

At least one reviewer requested revision in round 2.

## Round 3

### Draft Before Round

```text
# Performance-Gated Paper-to-Live Readiness

## Overview

Replace config-only paper-to-live promotion with a deterministic progression gate based on the Manager’s existing A–F cycle grades. A strategy becomes live-ready only after 50 consecutive Manager cycles graded A or B. Live activation additionally requires an explicit, cryptographically verified promotion approval created after that threshold was reached and bound to the same strategy version and readiness epoch. The pipeline must fail closed to paper mode when any condition is absent or invalid.

Expose machine-readable readiness progress through the existing server APIs. Dashboard UI changes are excluded because `dashboard/**` is protected.

## Goals

- Track consecutive qualifying Manager cycles per strategy version.
- Require 50 consecutive A/B cycles for live readiness.
- Reset progress on any C, D, or F cycle.
- Prevent reports from different strategy versions from being combined.
- Require an explicit, cryptographically verified signed promotion approval after readiness is achieved.
- Bind approval to an immutable proof of the current qualifying streak so later A/B cycles preserve approval while a subsequent reset invalidates it.
- Bind the promotion report identity and creation timestamp to the verified signed payload.
- Force requested live operation back to paper mode when readiness or confirmation is missing or invalid.
- Expose progress, remaining cycles, blockers, and confirmation state through existing APIs.
- Preserve the current default of paper mode and all existing promotion checks.

## Non-Goals

- Implementing exchange order submission, wallet signing, custody, or new live execution infrastructure.
- Modifying custody, risk-engine, executor, dashboard, installer, cron, or dependency-lock files.
- Adding tiered live capabilities.
- Allowing an environment variable or portfolio setting to reduce the 50-cycle production threshold.
- Treating historical Manager reports without a matching strategy version as qualifying.
- Automatically enabling live mode when the threshold is reached.
- Adding the visual dashboard progress bar; this spec provides the API contract that a later dashboard change can consume.

## Existing Files

- `pipeline.js` creates Manager cycle reports and contains the runtime paper/live decision path.
- `scripts/promotionGates.js` evaluates signed strategy promotion reports for `research`, `paper`, `shadow`, `tiny_live`, and `scaled_live`.
- `scripts/verifyPromotionGates.js` verifies promotion gates with isolated fixtures.
- `server.js` exposes Manager and promotion report APIs plus the professional summary.
- `package.json` defines the configured `npm run check` verification command.
- `README.md` documents paper-mode safety and current live-trading prerequisites.

## Shared Constraints

- Keep the implementation within 8 changed files and 600 changed lines.
- Preserve “AI suggests, code decides”: readiness and activation decisions must be deterministic and outside LLM prompts.
- Production readiness policy is immutable and exactly:
  - `required_consecutive_cycles: 50`
  - `qualifying_grades: ["A", "B"]`
- Readiness must be evaluated independently for the requested strategy version.
- A Manager report is valid only when it has:
  - A non-empty string `report_id`.
  - A `generated_at` value that parses as a valid timestamp.
  - A non-empty string `strategy_version`.
  - A recognized `overall_grade` of `A`, `B`, `C`, `D`, or `F`.
- Normalize valid timestamps to their numeric epoch value for comparison and serialize returned normalized timestamps as UTC ISO-8601 strings using `new Date(epoch).toISOString()`.
- Group Manager reports by `report_id` before counting:
  - Byte-for-byte or canonically equivalent duplicates count once.
  - If reports sharing an ID disagree on any readiness-relevant field, exclude the entire conflicting ID from progress and treat it as malformed.
  - Filesystem enumeration order must never decide which duplicate wins.
- Sort remaining reports by timestamp ascending and then by `report_id` ascending using ordinal Unicode code-unit string comparison.
- Malformed, conflicting, unreadable, or unrelated files must never contribute qualifying progress.
- The current streak is the terminal run of A/B reports after the newest valid C, D, or F report for the requested strategy.
- The readiness epoch is the terminal A/B run containing the current streak. When the streak first reaches 50, its 50th report becomes the immutable `threshold_cycle` for that epoch. Additional A/B reports do not change that threshold cycle. Any later C, D, or F report ends the epoch; a future streak receives a different threshold cycle.
- Reaching 50 qualifying cycles establishes eligibility only; it must not mutate portfolio settings or activate live execution automatically.
- Live activation additionally requires a cryptographically verified, successful promotion report for the same strategy version and a live-capable target state.
- The signed payload must bind:
  - The promotion report’s stable identifier.
  - The promotion report’s normalized generation timestamp.
  - The recognized signed-report marker.
  - The strategy version.
  - The target state.
  - The promotion decision.
  - The readiness policy.
  - The immutable threshold-cycle proof used to approve promotion.
- For a cryptographically verified report, its top-level report identifier, generation timestamp, signed-report marker, strategy version, target state, and promotion decision must match their signed-payload counterparts. A mismatch makes the confirmation invalid.
- Values outside the verified payload must not authorize activation, satisfy the post-readiness timestamp check, or supply trusted confirmation fields.
- A confirmation is valid for the current readiness epoch when its signed readiness proof matches:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `readiness_met: true`
  - `threshold_cycle.report_id`
  - `threshold_cycle.generated_at`
- Timestamp proof comparisons must use normalized UTC ISO-8601 values derived from epoch milliseconds, so equivalent input timestamp representations compare equally.
- Mutable fields such as current streak length, remaining cycles, progress percentage, valid-cycle count, and latest cycle may be included for auditability but must not be required to remain equal after later qualifying cycles.
- A promotion confirmation’s signed `generated_at` must be valid and strictly later by epoch milliseconds than the bound threshold cycle’s timestamp.
- Any missing, malformed, mismatched, unsigned, signature-invalid, tampered, stale-epoch, or blocked confirmation must fail closed to paper mode.
- Preserve and reuse all existing promotion metrics, custody checks, canonical signing and verification behavior, and audit behavior.
- Do not modify any protected path.
- Use only Node.js built-ins and existing dependencies.
- `npm run check` is the configured verification command for every phase.

## Phase 1 - Deterministic Live-Readiness Tracker

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/verifyLiveReadiness.js -->
<!-- pilot:touches=pipeline.js -->
<!-- pilot:touches=package.json -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:read=scripts/verifyPromotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Add `scripts/liveReadiness.js` with side-effect-free exported evaluators that can accept in-memory reports for tests and scan a supplied reports directory for production.
- Apply the immutable production policy defined in Shared Constraints.
- Evaluate only valid Manager cycle reports matching the requested strategy version.
- Apply the specified duplicate grouping, conflict exclusion, timestamp normalization, and deterministic ordering rules.
- Calculate the consecutive qualifying streak ending at the newest valid matching report.
- Reset the streak to zero after a nonqualifying recognized grade, then count any subsequent A/B reports.
- Return a stable JSON-ready result containing at least:
  - `strategy_version`
  - `required_consecutive_cycles`
  - `qualifying_grades`
  - `valid_cycle_count`
  - `current_qualifying_streak`
  - `remaining_qualifying_cycles`
  - `progress_pct`
  - `readiness_met`
  - `latest_cycle`
  - `threshold_cycle`
  - `blockers`
- `threshold_cycle` must be `null` before readiness and otherwise contain at least the report ID and normalized UTC ISO-8601 generation timestamp of the 50th report in the current readiness epoch.
- Clamp `remaining_qualifying_cycles` to zero and `progress_pct` to 100.
- Use explicit blocker codes for:
  - `missing_strategy_version`
  - `no_valid_matching_manager_reports`
  - `insufficient_qualifying_cycles`
- Malformed and conflicting duplicates may be exposed as nonblocking diagnostics but must not introduce input-order-dependent blockers or results.
- Permit test-only policy injection through explicit function arguments without exposing a production environment-variable or portfolio-setting override.
- Stamp newly generated Manager reports in `pipeline.js` with the active `PAPER_ORDER_STRATEGY_VERSION` as `strategy_version`.
- Do not retroactively treat unstamped historical reports as belonging to the current strategy.
- Directory scanning must return a blocked readiness result, rather than throwing or succeeding optimistically, when the directory is missing or unreadable.
- Add `scripts/verifyLiveReadiness.js` using temporary fixtures to verify:
  - 49 consecutive A/B reports remain blocked.
  - The 50th consecutive A/B report unlocks readiness.
  - Additional A/B reports preserve the same threshold cycle.
  - A C, D, or F grade resets the streak and clears the threshold cycle.
  - Reports for another strategy version do not count.
  - Equivalent duplicates count once.
  - Conflicting duplicates are excluded regardless of input order.
  - Malformed reports do not inflate progress.
  - Ordering is deterministic for equal timestamps.
  - Equivalent timestamp representations normalize identically.
  - Reversing the input array and filesystem enumeration produces deeply equal results.
- Add syntax checking and execution of the new verifier to the existing `npm run check` command without replacing or broadening it to another package script.

### Acceptance Criteria

- A strategy with 50 valid consecutive A/B Manager reports returns `readiness_met: true`, zero remaining cycles, 100% progress, and a deterministic threshold cycle.
- A strategy with any shorter terminal streak returns `readiness_met: false` and an `insufficient_qualifying_cycles` blocker.
- A C, D, or F report breaks the preceding streak even when older history contains 50 qualifying reports.
- Reports from other or missing strategy versions cannot contribute progress.
- Conflicting reports sharing an ID cannot contribute progress.
- Repeated evaluation over identical logical inputs returns deeply equal results regardless of input or directory enumeration order.
- Existing Manager report generation remains compatible apart from the additive `strategy_version` field.
- `npm run check` passes.

## Phase 2 - Promotion Confirmation and Runtime Enforcement

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=scripts/liveReadiness.js -->
<!-- pilot:touches=scripts/promotionGates.js -->
<!-- pilot:touches=scripts/verifyPromotionGates.js -->
<!-- pilot:touches=pipeline.js -->
<!-- runner:read=scripts/auditTrail.js -->
<!-- runner:read=README.md -->
<!-- runner:verify=npm run check -->

### Requirements

- Extend the readiness module with an activation evaluator that combines:
  - The current Phase 1 readiness result.
  - The deterministically selected promotion confirmation candidate.
  - A live-capable target state of `tiny_live` or `scaled_live`.
  - `promotion_allowed: true`.
  - A recognized signed-report marker present in and verified as part of the signed payload.
  - A non-empty signature that passes the existing cryptographic verification procedure over the canonical signed payload.
  - Signed report identity and timestamp fields matching the structural envelope.
  - A signed readiness proof matching the current readiness epoch as defined in Shared Constraints.
- Promotion confirmation files are structurally selectable only when their top-level envelope has a non-empty stable report identifier and valid generation timestamp.
- Group structurally selectable promotion reports by their top-level stable report identifier:
  - Canonically equivalent duplicates count once.
  - Conflicting duplicates are excluded.
- Order selectable promotion reports by their top-level generation timestamp descending and stable report identifier descending using ordinal Unicode code-unit string comparison.
- For a report with a valid signature, determine whether it is a candidate for the requested strategy only from its verified signed payload.
- For a report whose signed payload or signature cannot be verified, treat it as claiming the requested strategy only when its designated top-level `strategy_version` field is a non-empty string exactly equal to the requested strategy version.
- A newer structurally valid report that claims the requested strategy under the preceding rules must remain visible as the newest failed candidate and fail closed rather than allowing an older approval to bypass it.
- An invalid report without either a verified signed strategy match or an exact designated top-level strategy claim is unrelated and must not block the requested strategy.
- Unsigned envelope fields may identify and diagnose a failed candidate but must never authorize activation, satisfy the confirmation timestamp requirement, or appear as trusted confirmation fields.
- Return activation status separately from readiness status so reaching the streak never implies automatic activation.
- Return a `confirmation` object that identifies the selected candidate, distinguishes untrusted envelope metadata from trusted signed-payload fields, and reports signature-verification, envelope-match, timestamp, and readiness-epoch matching state without exposing secrets.
- Add explicit activation blocker codes for:
  - `readiness_not_met`
  - `missing_confirmation`
  - `confirmation_strategy_mismatch`
  - `confirmation_non_live_target`
  - `confirmation_promotion_blocked`
  - `confirmation_missing_signature`
  - `confirmation_invalid_signature`
  - `confirmation_signed_payload_mismatch`
  - `confirmation_not_after_readiness`
  - `confirmation_stale_readiness_epoch`
- Blocker precedence and combinations must be deterministic and tested. Signature verification must occur before any signed field is treated as trusted.
- Integrate Phase 1 readiness into `evaluatePromotionGates()`:
  - `research`, `paper`, and `shadow` retain their existing behavior.
  - `tiny_live` and `scaled_live` receive a blocking `live_readiness_not_met` gate until the production 50-cycle policy is satisfied for the evaluated strategy version.
  - Include the full readiness summary and evaluated strategy version in the canonical payload of the signed promotion report.
  - Include the stable promotion report identifier, normalized UTC ISO-8601 promotion generation timestamp, recognized signed-report marker, and immutable readiness proof fields specified in Shared Constraints in that payload.
  - Preserve every existing gate; readiness is an additional requirement, not a replacement.
- Promotion signing must occur only after all gates, including readiness, are evaluated. The signed promotion decision must reflect the final gate result.
- Ensure the promotion command remains an explicit operator action. It may write a signed approval report but must not change `portfolio.json` or automatically disable paper mode.
- At cycle startup, when `portfolio.settings.paper_mode` requests live behavior, evaluate activation for `PAPER_ORDER_STRATEGY_VERSION` using one readiness snapshot and the deterministically selected promotion candidate.
- If activation is not allowed, use paper mode for all Risk and Executor decisions in that cycle and emit a structured pipeline warning containing the activation blocker codes.
- Compute the effective paper/live mode once at cycle startup and pass that effective mode consistently to every downstream Risk and Executor decision in the cycle.
- Do not silently bypass the gate when Manager or promotion report directories are missing or unreadable.
- Do not change behavior for an already requested paper-mode cycle and do not require promotion report scanning to keep that cycle in paper mode.
- Extend `scripts/verifyPromotionGates.js` with isolated fixtures proving:
  - An otherwise promotable live target is blocked at 49 qualifying cycles.
  - An otherwise promotable live target is approved at 50 qualifying cycles.
  - Readiness from a different strategy version does not satisfy promotion.
  - Readiness alone does not satisfy runtime activation.
  - An unsigned, signature-invalid, tampered, blocked, non-live, or mismatched promotion report cannot activate live behavior.
  - Altering an unsigned envelope strategy, target, decision, marker, report identifier, or generation timestamp without changing the verified payload cannot authorize activation.
  - A cryptographically verified successful live promotion generated after readiness and bound to the matching report identity, timestamp, strategy, and threshold cycle satisfies activation.
  - The same approval remains valid after additional A/B cycles in the same readiness epoch.
  - A subsequent C, D, or F reset makes the older approval stale and prevents activation.
  - A later new 50-cycle streak requires a new approval bound to its new threshold cycle.
  - A signed confirmation timestamp at or before the threshold-cycle timestamp cannot activate live behavior.
  - An unsigned envelope timestamp later than the threshold cannot make an earlier signed confirmation timestamp valid.
  - Conflicting duplicate promotion IDs cannot activate live behavior.
  - A newer invalid candidate claiming the strategy cannot be bypassed by an older valid approval.
  - A newer invalid report unrelated to the requested strategy does not block an older valid approval.
  - Existing under-sampled backtest blocking behavior remains intact.

### Acceptance Criteria

- No `tiny_live` or `scaled_live` promotion can be approved without 50 consecutive matching A/B Manager cycles.
- Achieving readiness does not mutate portfolio mode or activate live execution.
- Live-mode requests require a subsequent matching, cryptographically verified signed promotion approval.
- The approval’s report identity and post-readiness creation timestamp are authenticated by its signature.
- An approval remains usable through later qualifying cycles in the same readiness epoch but becomes invalid after a streak reset.
- A live-mode request without all prerequisites is deterministically treated as paper mode for the entire cycle.
- A fabricated, invalid, stale, conflicting, or tampered signature cannot authorize live behavior.
- The fail-closed decision is visible in structured logs with stable blocker codes.
- Existing backtest, walk-forward, custody, operator-permission, signing, verification, and audit gates continue to apply.
- `npm run check` passes.

## Phase 3 - Readiness API and Operator Documentation

<!-- runner:model=codex:gpt-5.4-mini -->
<!-- pilot:touches=server.js -->
<!-- pilot:touches=README.md -->
<!-- runner:read=scripts/liveReadiness.js -->
<!-- runner:read=scripts/promotionGates.js -->
<!-- runner:verify=npm run check -->

### Requirements

- Import and use the shared readiness and activation evaluators in `server.js`; do not duplicate validation, deduplication, timestamp normalization, grade, streak, report-selection, epoch-binding, or signature-verification logic.
- Add a read-only `GET /api/promotions/readiness` endpoint.
- Accept an optional `strategy_version` query parameter, defaulting to the active strategy version used by the pipeline.
- Reject an explicitly supplied empty or invalidly typed strategy version with a deterministic client error rather than silently substituting the default.
- Return the Phase 1 readiness fields plus:
  - `activation_allowed`
  - `confirmation`
  - `activation_blockers`
  - `next_action`
- Ensure `confirmation` distinguishes untrusted envelope metadata from trusted signed-payload fields and reports signature-verification, envelope-match, timestamp, and readiness-epoch matching status without exposing signing secrets or treating an unverified report as confirmed.
- Make `next_action` deterministic:
  - `continue_paper_validation` when readiness is incomplete.
  - `request_live_promotion_confirmation` when readiness is complete but a valid verified confirmation for the current epoch is absent.
  - `live_eligible` when both gates pass.
- Add the same compact readiness and activation summary to `/api/professional/summary` under `strategy.live_readiness` so existing clients can render progress without another request.
- Extend promotion summaries additively with readiness, threshold-cycle, signed report identity, signed timestamp, envelope-match, and signature-verification information when present. Older promotion reports must remain readable but must not authorize activation unless they satisfy the verified signed-payload and current-readiness-epoch contract.
- Keep all endpoints read-only. A GET request must never write reports, change settings, start the pipeline, sign data, or confirm promotion.
- Missing or unreadable report directories must return valid blocked responses with stable blockers rather than exceptions or optimistic status.
- Update `README.md` to document:
  - The 50-consecutive-A/B policy.
  - Strategy-version isolation, duplicate handling, and streak reset behavior.
  - The readiness epoch and threshold-cycle proof.
  - The distinction between readiness, cryptographically verified signed confirmation, and runtime activation.
  - That confirmation identity and generation time are part of the signed payload.
  - That an approval survives later A/B cycles in the same epoch but is invalidated by a C, D, or F reset.
  - The fail-closed paper-mode behavior for missing, invalid, stale, conflicting, or tampered confirmations.
  - The readiness endpoint and representative response fields.
  - That reaching 50 cycles does not automatically enable live trading.
- Do not modify dashboard assets.

### Acceptance Criteria

- `GET /api/promotions/readiness` returns deterministic progress and cryptographically verified activation state for the selected strategy.
- The professional summary exposes the same readiness counts and blocker state.
- API responses distinguish “continue validating,” “awaiting explicit confirmation,” and “eligible.”
- Missing reports return a valid blocked response rather than an exception or optimistic status.
- Invalid, stale, or tampered promotion signatures or unsigned envelope metadata return a blocked response and never report eligibility.
- Later qualifying cycles do not incorrectly invalidate an approval bound to the same readiness epoch.
- Reading either endpoint causes no filesystem or portfolio mutation.
- Existing clients remain compatible because all response changes are additive.
- Documentation no longer describes live trading as enabled by a configuration change alone.
- `npm run check` passes.

```

### Reviewer 1: devin

Status: approved

Reason: Spec is complete, internally consistent, fail-closed, and all edge cases (duplicates, epoch binding, newer-invalid-blocks-older, timestamp normalization) are explicitly covered with matching acceptance criteria and verification fixtures across all three phases.

Raw Response:

```text
---STATUS---
status: approved
reason: Spec is complete, internally consistent, fail-closed, and all edge cases (duplicates, epoch binding, newer-invalid-blocks-older, timestamp normalization) are explicitly covered with matching acceptance criteria and verification fixtures across all three phases.
```

### Reviewer 2: codex

Status: approved

Reason: The draft is internally consistent, deterministic, security-focused, testable, and sufficiently specific to implement all three phases without unresolved requirements.

Raw Response:

```text
---STATUS---
status: approved
reason: The draft is internally consistent, deterministic, security-focused, testable, and sufficiently specific to implement all three phases without unresolved requirements.
```

## Final Outcome

Converged in round 3.
