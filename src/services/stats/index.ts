// ── Stats Service Barrel Export ─────────────────────────────────────────────
//
// Re-exports the public APIs of UsageEventStore, UsageAggregator, UsageStatsService, and UsageRecorder.
// Task instrumentation in Commit 3 and handlers in Commit 4 import this module.

export { UsageEventStore, StatsStoreError } from "./UsageEventStore"
export type { UsageStatsManifest, QuarantineReportEntry, StatsStoreErrorCode } from "./UsageEventStore"

export { UsageAggregator } from "./UsageAggregator"

export { UsageStatsService, StatsServiceError } from "./UsageStatsService"
export type { ExportFormat, JsonExport, StatsServiceErrorCode } from "./UsageStatsService"

export { UsageRecorder } from "./UsageRecorder"
export type { UsageRecordingContext } from "./UsageRecorder"

export { getEffectiveCost, computeEventCost, lookupModelInfo } from "./costRecalculation"
