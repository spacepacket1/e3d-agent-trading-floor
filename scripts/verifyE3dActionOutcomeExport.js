import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DEFAULT_LIMIT,
  DEFAULT_INSERT_BATCH_SIZE,
  DEFAULT_SINCE_HOURS,
  DESTINATION_TABLE_NAMES,
  SOURCE_APP,
  acquireLock,
  appendJsonlLog,
  createDestinationTables,
  defaultState,
  inferActionType,
  inferSimulatedSide,
  deliverCorpOutcomeCallbacks,
  insertJsonEachRow,
  insertMappedRecords,
  extractSignalTypes,
  extractStoryIds,
  mapCorpOutcomeCallbacks,
  mapCorpRealizedOutcome,
  mapCorpTradeOutcome,
  mapExecutorDecisionEvent,
  mapOutcomeObservationEvent,
  mapSourceEvents,
  mapTradeOutcomeEvent,
  formatCliSummary,
  parseArgs,
  readClickHouseTrainingEvents,
  readJsonlTrainingEvents,
  readSourceEvents,
  readState,
  releaseLock,
  resolveConfig,
  runExporter,
  writeState
} from "./e3dActionOutcomeExport.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e3d-exporter-"));
const logsDir = path.join(fixtureRoot, "logs");
const stateDir = path.join(fixtureRoot, "state");
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

const trainingEventLog = path.join(logsDir, "training-events.jsonl");
const fixtureEvents = [
  {
    event_id: "ignored-cycle",
    schema_version: "1.0",
    ts: "2026-05-19T06:59:59.000Z",
    event_type: "cycle_start",
    actor: "pipeline",
    pipeline_run_id: "run-1",
    cycle_id: "cycle-1",
    cycle_index: 1,
    market_regime: "risk_on",
    candidate_id: "",
    position_id: "",
    trade_id: "",
    payload: { note: "ignore-non-phase-event" }
  },
  {
    event_id: "exec-1",
    schema_version: "1.0",
    ts: "2026-05-19T07:00:00.000Z",
    event_type: "executor_decision",
    actor: "executor",
    pipeline_run_id: "run-1",
    cycle_id: "cycle-1",
    cycle_index: 1,
    market_regime: "risk_on",
    candidate_id: "0xAbC123",
    position_id: "",
    trade_id: "",
    payload: {
      candidate_id: "0xAbC123",
      trade_kind: "buy",
      decision: "paper_trade",
      review: {
        executor_decision: "paper_trade",
        reason_summary: "Sizing passed.",
        blocker_list: [],
        approved_size_pct: 12.5,
        max_slippage_bps: 75
      },
      action: {
        type: "buy",
        candidate: {
          token: {
            contract_address: "0xAbC123",
            symbol: "ABC",
            chain: "base"
          },
          confidence: 0.74,
          conviction_score: 0.81,
          why_now: "Momentum and liquidity aligned.",
          liquidity_data: {
            liquidity_usd: 125000
          },
          execution_data: {
            estimated_slippage_bps: 61
          },
          market_data: {
            current_price: 1.23
          },
          evidence_packet_id: "evidence-1"
        }
      },
      portfolio_snapshot: {
        cash_usd: 2000
      }
    }
  },
  {
    event_id: "trade-1",
    schema_version: "1.0",
    ts: "2026-05-19T08:00:00.000Z",
    event_type: "trade",
    actor: "executor",
    pipeline_run_id: "run-1",
    cycle_id: "cycle-1",
    cycle_index: 1,
    market_regime: "risk_on",
    candidate_id: "0xAbC123",
    position_id: "pos-1",
    trade_id: "trade-1",
    payload: {
      trade_id: "trade-1",
      position_id: "pos-1",
      candidate_id: "0xAbC123",
      quoted_price: 1.2,
      fill_price: 1.26,
      portfolio_snapshot: {
        cash_usd: 94000,
        equity_usd: 100500,
        open_positions: 2,
        market_regime: "risk_on"
      },
      slippage_bps_applied: 50,
      fee_bps_applied: 12.5,
      fee_usd: 1.1,
      slippage_usd: 2.25,
      trade: {
        ts: "2026-05-19T08:00:00.000Z",
        side: "buy",
        symbol: "ABC",
        contract_address: "0xAbC123",
        chain: "base",
        avg_entry_price: 1.2,
        pnl_usd: 0,
        fraction: 1,
        trade_lifecycle: "open"
      },
      mandate_trace: {
        mandate_id: "mandate-1",
        correlation_id: "corr-1",
        proposal_id: "proposal-1",
        decision_id: "decision-1"
      }
    }
  },
  {
    event_id: "outcome-1",
    schema_version: "1.0",
    ts: "2026-05-19T09:00:00.000Z",
    event_type: "outcome",
    actor: "portfolio",
    pipeline_run_id: "run-1",
    cycle_id: "cycle-1",
    cycle_index: 1,
    market_regime: "risk_on",
    candidate_id: "0xAbC123",
    position_id: "pos-1",
    trade_id: "trade-1",
    payload: {
      trade_id: "trade-1",
      position_id: "pos-1",
      candidate_id: "0xAbC123",
      outcome_label: "profit",
      pnl_usd: 42,
      exit_price: 1.5,
      entry_price: 1.2,
      holding_days: 2.5,
      portfolio_snapshot: {
        cash_usd: 96000,
        equity_usd: 101200,
        open_positions: 1,
        market_regime: "risk_on"
      },
      position_before: {
        contract_address: "0xAbC123",
        symbol: "ABC",
        chain: "base",
        avg_entry_price: 1.2,
        quantity: 100,
        market_value_usd: 150
      },
      mandate_trace: {
        mandate_id: "mandate-1",
        correlation_id: "corr-1",
        proposal_id: "proposal-1",
        decision_id: "decision-1"
      }
    }
  },
  {
    event_id: "trade-2",
    schema_version: "1.0",
    ts: "2026-05-20T08:00:00.000Z",
    event_type: "trade",
    actor: "executor",
    pipeline_run_id: "run-2",
    cycle_id: "cycle-2",
    cycle_index: 2,
    market_regime: "risk_off",
    candidate_id: "cand-2",
    position_id: "pos-2",
    trade_id: "trade-2",
    payload: {
      trade_id: "trade-2",
      position_id: "pos-2",
      candidate_id: "cand-2",
      quoted_price: 2.4,
      fill_price: 2.3,
      trade: {
        ts: "2026-05-20T08:00:00.000Z",
        side: "sell",
        symbol: "XYZ",
        contract_address: "0xDef456",
        avg_entry_price: 2,
        pnl_usd: 30
      }
    }
  }
];
fs.writeFileSync(trainingEventLog, `${fixtureEvents.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

const parsed = parseArgs([
  "--dry-run",
  "--since-hours=12",
  "--limit",
  "42",
  "--from-ts",
  "2026-05-19T00:00:00-07:00",
  "--to-ts=2026-05-20T00:00:00-07:00",
  "--verbose"
]);
assert.equal(parsed.dryRun, true);
assert.equal(parsed.sinceHours, 12);
assert.equal(parsed.limit, 42);
assert.equal(parsed.verbose, true);
assert.equal(parsed.fromTs, "2026-05-19T07:00:00.000Z");
assert.equal(parsed.toTs, "2026-05-20T07:00:00.000Z");

const defaults = parseArgs([]);
assert.equal(defaults.limit, DEFAULT_LIMIT);
assert.equal(defaults.sinceHours, DEFAULT_SINCE_HOURS);
assert.equal(defaults.sourceClickHouse, false);
assert.equal(defaults.createTablesOnly, false);

const jsonlRead = readJsonlTrainingEvents({
  logPath: trainingEventLog,
  filters: {
    fromMs: Date.parse("2026-05-19T07:00:00.000Z"),
    toMs: Date.parse("2026-05-19T23:59:59.000Z")
  },
  limit: 10
});
assert.equal(jsonlRead.source, "jsonl");
assert.equal(jsonlRead.sourceEventsRead, 5);
assert.deepEqual(jsonlRead.events.map((event) => event.event_id), ["exec-1", "trade-1", "outcome-1"]);
assert.equal(typeof jsonlRead.events[0].payload, "object");

const limitedRead = readJsonlTrainingEvents({
  logPath: trainingEventLog,
  filters: {
    fromMs: null,
    toMs: null
  },
  limit: 2
});
assert.deepEqual(limitedRead.events.map((event) => event.event_id), ["exec-1", "trade-1"]);

const sourceSummary = readSourceEvents({
  options: {
    sourceClickHouse: false,
    sinceHours: 24,
    fromTs: null,
    toTs: null,
    limit: 10
  },
  config: {
    paths: {
      trainingEventLog
    }
  },
  now: new Date("2026-05-20T09:00:00.000Z")
});
assert.equal(sourceSummary.source, "jsonl");
assert.deepEqual(sourceSummary.eventTypeCounts, {
  executor_decision: 0,
  trade: 1,
  outcome: 1
});
assert.equal(sourceSummary.sourceMinTs, "2026-05-19T09:00:00.000Z");
assert.equal(sourceSummary.sourceMaxTs, "2026-05-20T08:00:00.000Z");

assert.equal(inferActionType("paper_trade", "buy"), "PAPER_BUY");
assert.equal(inferActionType("paper_trade", "exit"), "PAPER_SELL");
assert.equal(inferActionType("reject", "buy"), "REJECT");
assert.equal(inferActionType("wait_for_entry", "buy"), "WAIT");
assert.equal(inferSimulatedSide("buy", "paper_trade"), "buy");
assert.equal(inferSimulatedSide("exit", "paper_trade"), "sell");
assert.equal(inferSimulatedSide("buy", "reject"), "none");

const mappedAction = mapExecutorDecisionEvent(fixtureEvents[1]);
assert.equal(mappedAction.source_app, SOURCE_APP);
assert.equal(mappedAction.agent_stage, "executor");
assert.equal(mappedAction.agent_decision, "paper_trade");
assert.equal(mappedAction.action_type, "PAPER_BUY");
assert.equal(mappedAction.simulated_side, "buy");
assert.equal(mappedAction.token_address, "0xabc123");
assert.equal(mappedAction.symbol, "ABC");
assert.equal(mappedAction.chain, "base");
assert.equal(mappedAction.entry_price, 1.23);
assert.equal(mappedAction.allocation_usd, 250);
assert.equal(mappedAction.confidence_score, 0.81);
assert.equal(mappedAction.liquidity_usd, 125000);
assert.equal(mappedAction.slippage_bps, 61);
assert.equal(mappedAction.evidence_packet_id, "evidence-1");
assert.equal(mappedAction.payload_json, JSON.stringify(fixtureEvents[1].payload));
assert.equal(typeof mappedAction.action_id, "string");
assert.equal(mappedAction.action_id.length, 64);

// Decay/freshness fields default to empty/0 when the candidate carries no narrative_data.
assert.equal(mappedAction.thesis_state, "");
assert.equal(mappedAction.thesis_freshness, 0);
assert.equal(mappedAction.narrative_decay, 0);
assert.equal(mappedAction.story_strength, 0);
assert.equal(mappedAction.flow_direction, "");
assert.equal(mappedAction.action_tilt, "");
assert.equal(mappedAction.price_freshness, "");
assert.equal(mappedAction.liquidity_freshness, "");
assert.equal(typeof mappedAction.expires_at, "number");
assert.equal(mappedAction.expires_at, new Date(fixtureEvents[1].ts).getTime());

const mappedTradeOutcome = mapTradeOutcomeEvent(fixtureEvents[2]);
assert.equal(mappedTradeOutcome.source_app, SOURCE_APP);
assert.equal(mappedTradeOutcome.outcome_type, "paper_trade");
assert.equal(mappedTradeOutcome.outcome_window, "trade");
assert.equal(mappedTradeOutcome.outcome_label, "buy");
assert.equal(mappedTradeOutcome.verdict, "recorded");
assert.equal(mappedTradeOutcome.token_address, "0xabc123");
assert.equal(mappedTradeOutcome.symbol, "ABC");
assert.equal(mappedTradeOutcome.chain, "base");
assert.equal(mappedTradeOutcome.entry_price, 1.2);
assert.equal(mappedTradeOutcome.current_price, 1.26);
assert.equal(mappedTradeOutcome.exit_price, 0);
assert.equal(mappedTradeOutcome.pnl_pct, 0);
assert(Math.abs(mappedTradeOutcome.price_delta_pct - 5) < 1e-9);
assert.equal(mappedTradeOutcome.payload_json, JSON.stringify(fixtureEvents[2].payload));

const mappedRealizedOutcome = mapOutcomeObservationEvent(fixtureEvents[3]);
assert.equal(mappedRealizedOutcome.outcome_type, "realized_outcome");
assert.equal(mappedRealizedOutcome.outcome_window, "realized");
assert.equal(mappedRealizedOutcome.outcome_label, "profit");
assert.equal(mappedRealizedOutcome.verdict, "validated");
assert.equal(mappedRealizedOutcome.token_address, "0xabc123");
assert.equal(mappedRealizedOutcome.symbol, "ABC");
assert.equal(mappedRealizedOutcome.chain, "base");
assert.equal(mappedRealizedOutcome.entry_price, 1.2);
assert.equal(mappedRealizedOutcome.exit_price, 1.5);
assert.equal(mappedRealizedOutcome.current_price, 1.5);
assert.equal(mappedRealizedOutcome.holding_days, 2.5);
assert(Math.abs(mappedRealizedOutcome.pnl_pct - 25) < 1e-9);
assert.equal(mappedRealizedOutcome.payload_json, JSON.stringify(fixtureEvents[3].payload));

const mappedSource = mapSourceEvents(fixtureEvents);
assert.equal(mappedSource.actions.length, 1);
assert.equal(mappedSource.outcomes.length, 3);

const mappedCorpTradeOutcome = mapCorpTradeOutcome(fixtureEvents[2]);
assert.equal(mappedCorpTradeOutcome.type, "trade.executed");
assert.equal(mappedCorpTradeOutcome.mandate_id, "mandate-1");
assert.equal(mappedCorpTradeOutcome.correlation_id, "corr-1");
assert.equal(mappedCorpTradeOutcome.trade_id, "trade-1");
assert.equal(mappedCorpTradeOutcome.portfolio_snapshot.cash_usd, 94000);

const mappedCorpRealizedOutcome = mapCorpRealizedOutcome(fixtureEvents[3]);
assert.equal(mappedCorpRealizedOutcome.type, "trade.realized");
assert.equal(mappedCorpRealizedOutcome.mandate_id, "mandate-1");
assert.equal(mappedCorpRealizedOutcome.correlation_id, "corr-1");
assert.equal(mappedCorpRealizedOutcome.outcome_label, "profit");

const corpCallbacks = mapCorpOutcomeCallbacks(fixtureEvents);
assert.equal(corpCallbacks.length, 2);
assert.deepEqual(corpCallbacks.map((row) => row.type), ["trade.executed", "trade.realized"]);

const clickhouseRead = readClickHouseTrainingEvents({
  client: {
    config: {
      database: "e3d",
      table: "training_events"
    },
    query({ query }) {
      assert(query.includes("FROM e3d.training_events"));
      assert(query.includes("event_type IN ('executor_decision', 'trade', 'outcome')"));
      assert(query.includes("LIMIT 3"));
      return [
        JSON.stringify({
          ...fixtureEvents[1],
          payload: JSON.stringify(fixtureEvents[1].payload)
        }),
        JSON.stringify({
          ...fixtureEvents[2],
          payload: JSON.stringify(fixtureEvents[2].payload)
        })
      ].join("\n");
    }
  },
  filters: {
    fromTs: "2026-05-19T07:00:00.000Z",
    toTs: "2026-05-19T09:00:00.000Z"
  },
  limit: 3
});
assert.equal(clickhouseRead.source, "clickhouse");
assert.deepEqual(clickhouseRead.events.map((event) => event.event_id), ["exec-1", "trade-1"]);
assert.equal(typeof clickhouseRead.events[0].payload, "object");

const config = resolveConfig({
  root: fixtureRoot,
  env: {
    TRAINING_EVENT_LOG: "custom/training.jsonl",
    E3D_ACTION_OUTCOME_EXPORT_LOG: "custom/export.jsonl",
    E3D_ACTION_OUTCOME_EXPORT_STATE_FILE: "custom/state.json",
    E3D_ACTION_OUTCOME_EXPORT_LOCK_FILE: "custom/export.lock",
    EXPORT_OVERLAP_MINUTES: "15",
    EXPORT_LOCK_STALE_MINUTES: "45",
    AWS_E3D_CLICKHOUSE_HTTP_URL: "https://clickhouse.example.test:8443"
  }
});
assert.equal(config.paths.trainingEventLog, path.join(fixtureRoot, "custom", "training.jsonl"));
assert.equal(config.runtime.overlapMinutes, 15);
assert.equal(config.runtime.lockStaleMinutes, 45);
assert.equal(config.awsClickHouse.describe().baseUrl, "https://clickhouse.example.test:8443/");
assert.equal(config.e3dCorp.outcomePath, "/webhooks/e3d-trade-outcomes");

const stateFile = path.join(stateDir, "export-state.json");
const baseState = defaultState();
writeState(stateFile, { ...baseState, last_success_count: 7 });
assert.equal(readState(stateFile).last_success_count, 7);

const logFile = path.join(logsDir, "export.jsonl");
appendJsonlLog(logFile, { stage: "export_summary", ok: true });
assert.equal(fs.readFileSync(logFile, "utf8").trim().split("\n").length, 1);

const lockFile = path.join(stateDir, "export.lock");
const firstLock = acquireLock({
  lockFile,
  staleMs: 30 * 60 * 1000,
  now: new Date("2026-05-20T10:00:00.000Z"),
  pid: 1234,
  exportRunId: "run-1"
});
assert.equal(firstLock.acquired, true);
const secondLock = acquireLock({
  lockFile,
  staleMs: 30 * 60 * 1000,
  now: new Date("2026-05-20T10:10:00.000Z"),
  pid: 1235,
  exportRunId: "run-2"
});
assert.equal(secondLock.acquired, false);
const staleLock = acquireLock({
  lockFile,
  staleMs: 30 * 60 * 1000,
  now: new Date("2026-05-20T10:45:01.000Z"),
  pid: 1236,
  exportRunId: "run-3"
});
assert.equal(staleLock.acquired, true);
assert.equal(staleLock.staleRemoved, true);
releaseLock(lockFile);

const runResult = await runExporter({
  argv: ["--dry-run"],
  root: fixtureRoot,
  env: {},
  now: new Date("2026-05-20T11:00:00.000Z")
});
assert.equal(runResult.ok, true);
assert.equal(runResult.summary.status, "mapped_records_ready");
assert.equal(runResult.summary.counts.events_selected, 1);
assert.equal(runResult.summary.counts.actions_mapped, 0);
assert.equal(runResult.summary.counts.outcomes_mapped, 1);
assert.equal(runResult.summary.counts.corp_outcomes_mapped, 0);
assert.deepEqual(runResult.summary.event_type_counts, {
  executor_decision: 0,
  trade: 1,
  outcome: 0
});
assert.deepEqual(formatCliSummary(runResult), [
  `e3dActionOutcomeExport: phase_6_manual_validation mapped_records_ready (run_id=${runResult.exportRunId}, dry_run=true, source=jsonl)`,
  "e3dActionOutcomeExport: events_scanned=5 events_selected=1 actions_mapped=0 outcomes_mapped=1 corp_outcomes_mapped=0",
  "e3dActionOutcomeExport: source_window min_ts=2026-05-20T08:00:00.000Z max_ts=2026-05-20T08:00:00.000Z"
]);

const exportLogPath = path.join(fixtureRoot, "logs", "e3d-action-outcome-export.jsonl");
const exportStatePath = path.join(fixtureRoot, "state", "e3d-action-outcome-export-state.json");
assert.equal(fs.existsSync(exportLogPath), true);
assert.equal(fs.existsSync(exportStatePath), true);
assert.equal(readState(exportStatePath).last_error, null);

const exportInserts = [];
const corpDeliveries = [];
const realExportResult = await runExporter({
  argv: ["--since-hours=48"],
  root: fixtureRoot,
  env: {
    AWS_E3D_CLICKHOUSE_HTTP_URL: "https://clickhouse.example.test:8443",
    E3D_CORP_BASE_URL: "http://corp.example.test:3000",
    E3D_CORP_API_KEY: "corp-token"
  },
  now: new Date("2026-05-20T11:02:00.000Z"),
  config: {
    ...resolveConfig({
      root: fixtureRoot,
      env: {
        AWS_E3D_CLICKHOUSE_HTTP_URL: "https://clickhouse.example.test:8443",
        E3D_CORP_BASE_URL: "http://corp.example.test:3000",
        E3D_CORP_API_KEY: "corp-token"
      }
    }),
    awsClickHouse: {
      config: {
        baseUrl: "https://clickhouse.example.test:8443",
        database: "e3d"
      },
      query({ query, input }) {
        exportInserts.push({ query, input });
        return "";
      },
      describe() {
        return {
          label: "aws",
          baseUrl: "https://clickhouse.example.test:8443/",
          database: "e3d",
          user: "default",
          secure: true
        };
      }
    },
    e3dCorp: {
      baseUrl: "http://corp.example.test:3000",
      outcomePath: "/webhooks/e3d-trade-outcomes",
      apiKey: "corp-token",
      sessionCookie: null,
      timeoutMs: 1000,
      maxAttempts: 2
    }
  },
  fetchImpl: async (url, options) => {
    corpDeliveries.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async text() {
        return "";
      }
    };
  }
});
assert.equal(realExportResult.ok, true);
assert.equal(realExportResult.summary.status, "records_inserted");
assert.equal(realExportResult.summary.counts.actions_mapped, 1);
assert.equal(realExportResult.summary.counts.outcomes_mapped, 3);
assert.equal(realExportResult.summary.counts.corp_outcomes_mapped, 2);
assert.equal(realExportResult.summary.counts.actions_inserted, 1);
assert.equal(realExportResult.summary.counts.outcomes_inserted, 3);
assert.equal(realExportResult.summary.counts.corp_outcomes_delivered, 2);
assert.equal(realExportResult.summary.counts.inserted_rows, 4);
assert.deepEqual(realExportResult.summary.destination_tables, ["E3DAgentActions", "E3DAgentOutcomes"]);
assert.equal(exportInserts.length, 2);
assert.equal(corpDeliveries.length, 2);
assert.equal(corpDeliveries[0].url, "http://corp.example.test:3000/webhooks/e3d-trade-outcomes");
assert.equal(corpDeliveries[0].options.headers["Idempotency-Key"], corpDeliveries[0].body.outcome_id);
assert.equal(corpDeliveries[0].body.mandate_id, "mandate-1");
assert.equal(corpDeliveries[1].body.type, "trade.realized");
assert(exportInserts[0].query.startsWith("INSERT INTO e3d.E3DAgentActions"));
assert(exportInserts[0].query.includes("input_format_skip_unknown_fields = 1"));
assert(exportInserts[0].query.includes("FORMAT JSONEachRow"));
assert(exportInserts[1].query.startsWith("INSERT INTO e3d.E3DAgentOutcomes"));
assert(exportInserts[1].query.includes("input_format_skip_unknown_fields = 1"));
assert.deepEqual(formatCliSummary(realExportResult), [
  `e3dActionOutcomeExport: phase_6_manual_validation records_inserted (run_id=${realExportResult.exportRunId}, dry_run=false, source=jsonl)`,
  "e3dActionOutcomeExport: events_scanned=5 events_selected=4 actions_mapped=1 outcomes_mapped=3 corp_outcomes_mapped=2 actions_inserted=1 outcomes_inserted=3 corp_outcomes_delivered=2 inserted_rows=4",
  "e3dActionOutcomeExport: source_window min_ts=2026-05-19T07:00:00.000Z max_ts=2026-05-20T08:00:00.000Z",
  "e3dActionOutcomeExport: destination_tables=E3DAgentActions,E3DAgentOutcomes"
]);

let retryAttempts = 0;
const deliveryResult = await deliverCorpOutcomeCallbacks({
  callbacks: corpCallbacks,
  corpConfig: {
    baseUrl: "http://corp.example.test:3000",
    outcomePath: "/webhooks/e3d-trade-outcomes",
    apiKey: "corp-token",
    timeoutMs: 1000,
    maxAttempts: 3
  },
  fetchImpl: async () => {
    retryAttempts += 1;
    if (retryAttempts < 3) {
      return {
        ok: false,
        status: 503,
        async text() {
          return "temporary";
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return "";
      }
    };
  }
});
assert.equal(deliveryResult.enabled, true);
assert.equal(deliveryResult.delivered, 2);
assert.equal(retryAttempts, 4);

const plannedTables = createDestinationTables({
  client: config.awsClickHouse,
  dryRun: true
});
assert.equal(plannedTables.ok, true);
assert.equal(plannedTables.dryRun, true);
assert.deepEqual(plannedTables.tables, DESTINATION_TABLE_NAMES);

const executedQueries = [];
const tableCreationResult = createDestinationTables({
  client: {
    config: {
      baseUrl: "https://clickhouse.example.test:8443",
      database: "fixture_db"
    },
    query({ query }) {
      executedQueries.push(query);
      return "";
    }
  }
});
assert.equal(tableCreationResult.ok, true);
assert.equal(tableCreationResult.dryRun, false);
const createQueries = executedQueries.filter((q) => q.startsWith("CREATE TABLE"));
const alterQueries = executedQueries.filter((q) => q.startsWith("ALTER TABLE"));
assert.equal(createQueries.length, DESTINATION_TABLE_NAMES.length);
assert(createQueries.every((query) => query.includes("CREATE TABLE IF NOT EXISTS fixture_db.")));
// Migrations include the decay fields. Spot-check that each new column appears once.
assert(alterQueries.length >= 9, `expected at least 9 ALTER TABLE migrations, got ${alterQueries.length}`);
for (const col of ["expires_at", "thesis_state", "thesis_freshness", "narrative_decay",
                   "story_strength", "flow_direction", "action_tilt",
                   "price_freshness", "liquidity_freshness"]) {
  assert(alterQueries.some((q) => q.includes(`ADD COLUMN IF NOT EXISTS ${col}`)),
    `missing ALTER for column ${col}`);
}
assert.equal(tableCreationResult.migrationsApplied, alterQueries.length);

const insertQueries = [];
const batchedInsert = insertJsonEachRow({
  client: {
    config: {
      baseUrl: "https://clickhouse.example.test:8443",
      database: "fixture_db"
    },
    query({ query, input }) {
      insertQueries.push({ query, input });
      return "";
    }
  },
  tableName: "E3DAgentActions",
  rows: [
    { action_id: "a-1", payload_json: "{}" },
    { action_id: "a-2", payload_json: "{}" },
    { action_id: "a-3", payload_json: "{}" }
  ],
  batchSize: 2
});
assert.equal(batchedInsert.ok, true);
assert.equal(batchedInsert.dryRun, false);
assert.equal(batchedInsert.rowCount, 3);
assert.equal(batchedInsert.batchCount, 2);
assert.equal(insertQueries.length, 2);
assert.equal(insertQueries[0].query,
  "INSERT INTO fixture_db.E3DAgentActions SETTINGS input_format_skip_unknown_fields = 1 FORMAT JSONEachRow");
assert.equal(insertQueries[0].input, `${JSON.stringify({ action_id: "a-1", payload_json: "{}" })}\n${JSON.stringify({ action_id: "a-2", payload_json: "{}" })}`);
assert.equal(insertQueries[1].input, JSON.stringify({ action_id: "a-3", payload_json: "{}" }));

const dryInsert = insertJsonEachRow({
  client: config.awsClickHouse,
  tableName: "E3DAgentOutcomes",
  rows: [{ outcome_id: "o-1", payload_json: "{}" }],
  dryRun: true
});
assert.equal(dryInsert.ok, true);
assert.equal(dryInsert.dryRun, true);
assert.equal(dryInsert.batchSize, DEFAULT_INSERT_BATCH_SIZE);

const mappedInsert = insertMappedRecords({
  client: {
    config: {
      baseUrl: "https://clickhouse.example.test:8443",
      database: "fixture_db"
    },
    query() {
      return "";
    }
  },
  mapped: mappedSource,
  dryRun: true
});
assert.equal(mappedInsert.ok, true);
assert.equal(mappedInsert.insertedRows, 4);
assert.equal(mappedInsert.actionsInserted, 1);
assert.equal(mappedInsert.outcomesInserted, 3);

const createTablesOnlyResult = await runExporter({
  argv: ["--create-tables-only", "--dry-run"],
  root: fixtureRoot,
  env: {
    AWS_E3D_CLICKHOUSE_HTTP_URL: "https://clickhouse.example.test:8443"
  },
  now: new Date("2026-05-20T11:05:00.000Z")
});
assert.equal(createTablesOnlyResult.ok, true);
assert.equal(createTablesOnlyResult.summary.status, "destination_tables_planned");
assert.deepEqual(createTablesOnlyResult.summary.destination_tables, DESTINATION_TABLE_NAMES);
assert.deepEqual(formatCliSummary(createTablesOnlyResult), [
  `e3dActionOutcomeExport: phase_6_manual_validation destination_tables_planned (run_id=${createTablesOnlyResult.exportRunId}, dry_run=true, source=jsonl)`,
  `e3dActionOutcomeExport: table_count=${DESTINATION_TABLE_NAMES.length} destination_tables=${DESTINATION_TABLE_NAMES.join(",")}`
]);

const clickhouseUnavailableResult = await runExporter({
  argv: ["--dry-run", "--source-clickhouse"],
  root: fixtureRoot,
  env: {},
  now: new Date("2026-05-20T11:10:00.000Z"),
  config: {
    ...resolveConfig({ root: fixtureRoot, env: {} }),
    localClickHouse: {
      config: {
        baseUrl: "http://127.0.0.1:8123",
        database: "e3d",
        table: "training_events"
      },
      query() {
        const error = new Error("curl: (7) Failed to connect to 127.0.0.1 port 8123");
        error.stderr = "curl: (7) Failed to connect to 127.0.0.1 port 8123";
        throw error;
      },
      describe() {
        return {
          label: "local",
          baseUrl: "http://127.0.0.1:8123/",
          database: "e3d",
          user: "default",
          secure: false
        };
      }
    }
  }
});
assert.equal(clickhouseUnavailableResult.ok, false);
assert.equal(clickhouseUnavailableResult.message, "ClickHouse unavailable — run without --source-clickhouse to use the default JSONL source.");

// --- extractSignalTypes / extractStoryIds regression coverage ---
// Free-text evidence: scout's tool-use output style. Case-sensitive ALL-CAPS match —
// the canonical "STAGING" tag is picked up, but lowercase prose like "thesis cluster"
// is treated as English narrative, not a story-type citation.
assert.deepEqual(
  extractSignalTypes({
    setup_type: "STAGING",
    why_now: "Strong accumulation flow with buy_sell_ratio_1h=4. STAGING signal present.",
    evidence: ["STAGING", "ACCUMULATION", "Rabbit thesis cluster"],
    risks: []
  }),
  ["ACCUMULATION", "STAGING"]
);

// Structured evidence/risks: v1 shortlist style + scout's {signal:"..."} live shape.
assert.deepEqual(
  extractSignalTypes({
    setup_type: "buy",
    why_now: "",
    evidence: [
      { type: "BREAKOUT_CONFIRMED" },
      { story_type: "FLOW" },
      { signal: "STAGING", value: 9.97 }
    ],
    risks: [{ type: "LIQUIDITY_DRAIN" }]
  }),
  ["BREAKOUT_CONFIRMED", "FLOW", "LIQUIDITY_DRAIN", "STAGING"]
);

// False-positive guard: WASH_TRADE inside a longer token must still match as whole word,
// but FLOW must not match substring "OUTFLOW".
assert.deepEqual(
  extractSignalTypes({
    setup_type: "buy",
    why_now: "Net OUTFLOW from CEX detected; no LOOP or WASH_TRADE indicators.",
    evidence: []
  }),
  ["LOOP", "WASH_TRADE"]
);

// Missing/empty input
assert.deepEqual(extractSignalTypes(null), []);
assert.deepEqual(extractSignalTypes({}), []);

// Story-id extraction picks up explicit story_ids and evi_* tokens in evidence.
assert.deepEqual(
  extractStoryIds({
    story_ids: ["story_abc", "story_def"],
    evidence: ["evi_xyz", "loose text", { evidence_id: "evi_qqq" }]
  }),
  ["evi_qqq", "evi_xyz", "story_abc", "story_def"]
);

// End-to-end: extractor wired into the action mapper.
const enrichedFixture = {
  ...fixtureEvents[1],
  payload: {
    ...fixtureEvents[1].payload,
    action: {
      ...fixtureEvents[1].payload.action,
      candidate: {
        ...fixtureEvents[1].payload.action.candidate,
        setup_type: "STAGING",
        why_now: "STAGING + ACCUMULATION setup. THESIS conviction 75.",
        evidence: ["STAGING", "ACCUMULATION pattern", "evi_aaa", "evi_bbb"],
        story_ids: ["story_zzz"]
      }
    }
  }
};
const enrichedAction = mapExecutorDecisionEvent(enrichedFixture);
assert.deepEqual(enrichedAction.source_signal_types, ["ACCUMULATION", "STAGING", "THESIS"]);
assert.deepEqual(enrichedAction.source_story_ids, ["evi_aaa", "evi_bbb", "story_zzz"]);

// Reject decision with no candidate still produces empty arrays (not undefined).
const rejectFixture = {
  ...fixtureEvents[1],
  payload: { ...fixtureEvents[1].payload, action: null }
};
const rejectAction = mapExecutorDecisionEvent(rejectFixture);
assert.deepEqual(rejectAction.source_signal_types, []);
assert.deepEqual(rejectAction.source_story_ids, []);

// Harvest-style exit decision: full decay state should flow through.
const harvestExitFixture = {
  event_id: "exec-harvest-1",
  schema_version: "1.0",
  ts: "2026-05-19T07:30:00.000Z",
  event_type: "executor_decision",
  actor: "executor",
  pipeline_run_id: "run-1",
  cycle_id: "cycle-1",
  cycle_index: 1,
  market_regime: "risk_off",
  candidate_id: "0xdef456",
  position_id: "pos-1",
  trade_id: "",
  payload: {
    candidate_id: "0xdef456",
    trade_kind: "exit",
    decision: "paper_trade",
    review: {
      executor_decision: "paper_trade",
      reason_summary: "Thesis decay triggered exit.",
      blocker_list: [],
      approved_size_pct: 100,
      max_slippage_bps: 100
    },
    action: {
      source_agent: "harvest",
      created_at: "2026-05-19T07:25:00.000Z",
      expires_at: "2026-05-19T19:25:00.000Z",
      token: { contract_address: "0xdef456", symbol: "XYZ", chain: "ethereum" },
      action: "exit",
      thesis_state: "decaying",
      narrative_data: {
        thesis_health: 28,
        narrative_decay: 76,
        story_strength: 14,
        flow_direction: "bearish"
      },
      market_data_quality: {
        normalized: {
          price_freshness: "fresh",
          liquidity_freshness: "aging"
        }
      }
    },
    portfolio_snapshot: { cash_usd: 1000 }
  }
};
const harvestExit = mapExecutorDecisionEvent(harvestExitFixture);
assert.equal(harvestExit.thesis_state, "decaying");
assert.equal(harvestExit.thesis_freshness, 28);
assert.equal(harvestExit.narrative_decay, 76);
assert.equal(harvestExit.story_strength, 14);
assert.equal(harvestExit.flow_direction, "bearish");
assert.equal(harvestExit.action_tilt, "exit");
assert.equal(harvestExit.price_freshness, "fresh");
assert.equal(harvestExit.liquidity_freshness, "aging");
// expires_at on the action takes precedence over record.ts when present.
assert.equal(harvestExit.expires_at, new Date("2026-05-19T19:25:00.000Z").getTime());

console.log("verifyE3dActionOutcomeExport: ok");
