// ── Stats Service Barrel Export ─────────────────────────────────────────────
//
// Re-exports the public APIs of UsageEventStore, UsageStatsDatabase,
// UsageStatsMigration, UsageAggregator, UsageStatsService, and UsageRecorder.
// Task instrumentation in Commit 3 and handlers in Commit 4 import this module.

export { UsageEventStore, StatsStoreError } from "./UsageEventStore"
export type { UsageStatsManifest, QuarantineReportEntry, StatsStoreErrorCode } from "./UsageEventStore"

export { UsageStatsDatabase, StatsDbError } from "./UsageStatsDatabase"
export type {
	StatsDbErrorCode,
	AppendResult,
	EventBatch,
	SessionPage,
	SessionRow,
	DailyRollupRow,
	MigrationCheckpoint,
} from "./UsageStatsDatabase"

export { UsageStatsMigration, StatsMigrationError } from "./UsageStatsMigration"
export type { StatsMigrationErrorCode } from "./UsageStatsMigration"

export { UsageAggregator } from "./UsageAggregator"

export { UsageStatsService, StatsServiceError } from "./UsageStatsService"
export type { ExportFormat, JsonExport, StatsServiceErrorCode } from "./UsageStatsService"

export { UsageRecorder } from "./UsageRecorder"
export type { UsageRecordingContext, UsageEventSink } from "./UsageRecorder"

export { resolveEndpoint } from "./UsageCapture"

export { UsageStatsStreamCoordinator } from "./UsageStatsStreamCoordinator"
export type { StatsStreamSink, StatsStreamErrorCode } from "./UsageStatsStreamCoordinator"

export { getEffectiveCost, computeEventCost, lookupModelInfo, providerReportsCache } from "./costRecalculation"

export { resolveStatsQueryRangeMs, isStatsQueryRangeBounded, isWithinStatsQueryRange } from "./statsQueryRange"
export type { StatsQueryRangeMs } from "./statsQueryRange"
