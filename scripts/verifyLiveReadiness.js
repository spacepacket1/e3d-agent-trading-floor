import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { evaluateLiveReadiness, evaluateLiveReadinessFromReports } from "./liveReadiness.js";

const STRATEGY = "fixture-live-readiness-v1";
const BASE_MS = Date.parse("2026-07-29T00:00:00.000Z");

function makeReport(index, overrides = {}) {
  const grade = overrides.overall_grade || (index % 2 === 0 ? "B" : "A");
  return {
    report_id: overrides.report_id || `cycle-${String(index).padStart(3, "0")}`,
    generated_at: overrides.generated_at || new Date(BASE_MS + (index - 1) * 60_000).toISOString(),
    strategy_version: overrides.strategy_version || STRATEGY,
    overall_grade: grade,
    ...overrides
  };
}

function stripDiagnostics(result) {
  const { diagnostics, ...rest } = result;
  return rest;
}

function writeReports(dir, reports) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [index, report] of reports.entries()) {
    fs.writeFileSync(path.join(dir, `cycle-${String(index + 1).padStart(3, "0")}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e3d-live-readiness-"));
try {
  const fortyNine = Array.from({ length: 49 }, (_, index) => makeReport(index + 1));
  const fifty = [...fortyNine, makeReport(50)];
  const fiftyFive = [...fifty, ...Array.from({ length: 5 }, (_, index) => makeReport(51 + index))];

  const blocked49 = evaluateLiveReadinessFromReports(fortyNine, { strategyVersion: STRATEGY });
  assert.equal(blocked49.readiness_met, false, "49 qualifying cycles should remain blocked");
  assert.equal(blocked49.current_qualifying_streak, 49);
  assert.equal(blocked49.remaining_qualifying_cycles, 1);
  assert.equal(blocked49.progress_pct, 98);
  assert.ok(blocked49.blockers.some((blocker) => blocker.code === "insufficient_qualifying_cycles"));

  const ready50 = evaluateLiveReadinessFromReports(fifty, { strategyVersion: STRATEGY });
  assert.equal(ready50.readiness_met, true, "50 qualifying cycles should unlock readiness");
  assert.equal(ready50.current_qualifying_streak, 50);
  assert.equal(ready50.remaining_qualifying_cycles, 0);
  assert.equal(ready50.progress_pct, 100);
  assert.equal(ready50.threshold_cycle.report_id, "cycle-050");
  assert.equal(ready50.threshold_cycle.generated_at, new Date(BASE_MS + 49 * 60_000).toISOString());

  const ready55 = evaluateLiveReadinessFromReports(fiftyFive, { strategyVersion: STRATEGY });
  assert.equal(ready55.readiness_met, true);
  assert.equal(ready55.current_qualifying_streak, 55);
  assert.equal(ready55.remaining_qualifying_cycles, 0);
  assert.equal(ready55.progress_pct, 100);
  assert.deepEqual(ready55.threshold_cycle, ready50.threshold_cycle, "additional qualifying cycles should preserve threshold cycle");

  const resetSequence = [
    ...Array.from({ length: 50 }, (_, index) => makeReport(index + 1)),
    makeReport(51, { report_id: "cycle-reset", overall_grade: "C", generated_at: new Date(BASE_MS + 50 * 60_000).toISOString() }),
    makeReport(52, { report_id: "cycle-after-reset-1", overall_grade: "A", generated_at: new Date(BASE_MS + 51 * 60_000).toISOString() }),
    makeReport(53, { report_id: "cycle-after-reset-2", overall_grade: "B", generated_at: new Date(BASE_MS + 52 * 60_000).toISOString() })
  ];
  const resetResult = evaluateLiveReadinessFromReports(resetSequence, { strategyVersion: STRATEGY });
  assert.equal(resetResult.readiness_met, false, "a C grade should clear readiness");
  assert.equal(resetResult.current_qualifying_streak, 2);
  assert.equal(resetResult.threshold_cycle, null);
  assert.ok(resetResult.blockers.some((blocker) => blocker.code === "insufficient_qualifying_cycles"));

  const otherStrategy = evaluateLiveReadinessFromReports(
    [...fortyNine, ...Array.from({ length: 10 }, (_, index) => makeReport(100 + index, { strategy_version: "other-strategy-v2" }))],
    { strategyVersion: STRATEGY }
  );
  assert.deepEqual(otherStrategy, blocked49, "other strategy reports should be ignored");

  const equivalentDuplicateBase = [makeReport(1, { report_id: "dup-1", generated_at: "2026-07-29T00:00:00Z" })];
  const equivalentDuplicateAlt = [makeReport(1, { report_id: "dup-1", generated_at: "2026-07-29T00:00:00.000Z" })];
  assert.deepEqual(
    stripDiagnostics(evaluateLiveReadinessFromReports(equivalentDuplicateBase, { strategyVersion: STRATEGY })),
    stripDiagnostics(evaluateLiveReadinessFromReports([...equivalentDuplicateBase, ...equivalentDuplicateBase], { strategyVersion: STRATEGY })),
    "equivalent duplicates should count once"
  );
  assert.deepEqual(
    evaluateLiveReadinessFromReports(equivalentDuplicateBase, { strategyVersion: STRATEGY }),
    evaluateLiveReadinessFromReports(equivalentDuplicateAlt, { strategyVersion: STRATEGY }),
    "equivalent timestamp representations should normalize identically"
  );

  const conflictPair = [
    makeReport(1, { report_id: "conflict-1", generated_at: "2026-07-29T00:00:00Z", overall_grade: "A" }),
    makeReport(1, { report_id: "conflict-1", generated_at: "2026-07-29T00:00:00Z", overall_grade: "C" })
  ];
  const conflictingA = [
    ...conflictPair,
    ...Array.from({ length: 48 }, (_, index) => makeReport(index + 2))
  ];
  const conflictingB = [
    ...conflictPair.slice().reverse(),
    ...Array.from({ length: 48 }, (_, index) => makeReport(index + 2))
  ];
  const conflictResultA = evaluateLiveReadinessFromReports(conflictingA, { strategyVersion: STRATEGY });
  const conflictResultB = evaluateLiveReadinessFromReports(conflictingB, { strategyVersion: STRATEGY });
  assert.deepEqual(conflictResultA, conflictResultB, "conflicting duplicates should be order-independent");
  assert.equal(conflictResultA.valid_cycle_count, 48, "conflicting duplicate ids should be excluded");

  const malformedBase = evaluateLiveReadinessFromReports(fortyNine, { strategyVersion: STRATEGY });
  const malformedResult = evaluateLiveReadinessFromReports([...fortyNine, { report_id: "", generated_at: "nope", overall_grade: "Z" }], { strategyVersion: STRATEGY });
  assert.deepEqual(stripDiagnostics(malformedResult), stripDiagnostics(malformedBase), "malformed reports should not inflate progress");

  const equalTimestampReports = Array.from({ length: 50 }, (_, index) => makeReport(index + 1, {
    report_id: `equal-${String(51 - index).padStart(3, "0")}`,
    generated_at: "2026-07-29T00:00:00Z"
  }));
  const equalTimestampResult = evaluateLiveReadinessFromReports(equalTimestampReports, { strategyVersion: STRATEGY });
  const reversedEqualTimestampResult = evaluateLiveReadinessFromReports([...equalTimestampReports].reverse(), { strategyVersion: STRATEGY });
  assert.deepEqual(equalTimestampResult, reversedEqualTimestampResult, "equal timestamps should sort deterministically");

  const scanDir = path.join(tempRoot, "scan");
  const scannedReports = Array.from({ length: 50 }, (_, index) => makeReport(index + 1, {
    report_id: `scan-${String(50 - index).padStart(3, "0")}`,
    generated_at: "2026-07-29T00:00:00Z"
  }));
  writeReports(scanDir, [...scannedReports].reverse());
  const dirResult = evaluateLiveReadiness({ strategyVersion: STRATEGY, reportsDir: scanDir });
  const arrayResult = evaluateLiveReadinessFromReports(scannedReports, { strategyVersion: STRATEGY });
  assert.deepEqual(dirResult, arrayResult, "filesystem enumeration should not change readiness results");

  const missingDir = path.join(tempRoot, "missing");
  const missingDirResult = evaluateLiveReadiness({ strategyVersion: STRATEGY, reportsDir: missingDir });
  assert.equal(missingDirResult.readiness_met, false);
  assert.ok(missingDirResult.blockers.some((blocker) => blocker.code === "no_valid_matching_manager_reports"), "missing directories should fail closed");

  console.log(JSON.stringify({
    verified: true,
    cases: [
      "49 blocked",
      "50 unlocks",
      "threshold preserved",
      "reset clears threshold",
      "strategy isolation",
      "equivalent duplicates",
      "conflict exclusion",
      "malformed ignored",
      "equal timestamp ordering",
      "directory scan"
    ]
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
