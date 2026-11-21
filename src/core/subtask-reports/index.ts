/**
 * Public API of the host-side subtask report store (design D6).
 *
 * Invariant: the host owns report persistence; children only return markdown
 * through attempt_completion. Reports live under
 * `<cwd>/.zoocode/subtask-reports/<parentTaskId>/` and are written atomically.
 */
export { getSubtaskReportsDir, writeSubtaskReport } from "./writeReport"
export type { SubtaskReport, WriteSubtaskReportParams } from "./writeReport"
export { sanitizeReportLabel, resolveReportPath } from "./naming"
