import * as vscode from "vscode"
import * as path from "path"
import * as os from "os"

import type {
	WebviewMessage,
	StatsQuery,
	StatsSnapshot,
	SessionSummary,
	SessionDetail,
	APICallRecord,
	UsageEventV1,
	ExtensionMessage,
} from "@roo-code/types"
import {
	StatsQuery as StatsQuerySchema,
	DashboardStatsSubscription as DashboardStatsSubscriptionSchema,
} from "@roo-code/types"

import type { ClineProvider } from "./ClineProvider"
import type { UsageStatsService, JsonExport } from "../../services/stats"
import { StatsServiceError } from "../../services/stats"
import type { UsageStatsStreamCoordinator, StatsStreamSink } from "../../services/stats"
import { getEffectiveCost } from "../../services/stats/costRecalculation"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { readTaskMessages } from "../task-persistence/taskMessages"

// ── Error Codes ─────────────────────────────────────────────────────────────

export type UsageStatsHandlerErrorCode =
	| "STATS_HANDLER/query/001" // invalid payload
	| "STATS_HANDLER/query/002" // service unavailable
	| "STATS_HANDLER/query/003" // service error
	| "STATS_HANDLER/clear/001" // invalid payload (missing nonce)
	| "STATS_HANDLER/clear/002" // service unavailable
	| "STATS_HANDLER/clear/003" // service error
	| "STATS_HANDLER/rebuild/001" // database not initialized
	| "STATS_HANDLER/rebuild/002" // service unavailable
	| "STATS_HANDLER/rebuild/003" // service error
	| "STATS_HANDLER/export/001" // invalid payload
	| "STATS_HANDLER/export/002" // service unavailable
	| "STATS_HANDLER/export/003" // service error
	| "STATS_HANDLER/export/004" // unsupported format
	| "STATS_HANDLER/sessions/001" // invalid payload (invalid stats query)
	| "STATS_HANDLER/sessions/002" // service unavailable
	| "STATS_HANDLER/sessions/003" // service error
	| "STATS_HANDLER/sessionDetail/001" // invalid payload (missing taskId)
	| "STATS_HANDLER/sessionDetail/002" // service unavailable
	| "STATS_HANDLER/sessionDetail/003" // service error
	| "STATS_HANDLER/stream/001" // invalid subscription payload
	| "STATS_HANDLER/stream/002" // service/coordinator unavailable
	| "STATS_HANDLER/stream/003" // coordinator error
	| "STATS_HANDLER/stream/004" // invalid page request (missing cursor or limit)
	| "STATS_HANDLER/stream/005" // page query error

// ── Stream Sink Adapter ──────────────────────────────────────────────────────

/**
 * Adapter that bridges the coordinator's narrow {@link StatsStreamSink}
 * interface to the provider's `postMessageToWebview` and webview visibility.
 *
 * The coordinator never depends on ClineProvider directly; this adapter is
 * the only glue. One instance is created per provider and reused for the
 * lifetime of the subscription.
 */
export class ProviderStreamSink implements StatsStreamSink {
	constructor(private readonly provider: ClineProvider) {}

	postMessage(message: ExtensionMessage): void {
		this.provider.postMessageToWebview(message).catch(() => {
			// Swallow — the coordinator handles delivery failure by marking
			// the subscriber for snapshot fallback.
		})
	}

	isVisible(): boolean {
		// Access the private `view` property via cast. The coordinator's
		// StatsStreamSink interface requires this; the alternative would be
		// adding a public getter to ClineProvider, which is a larger scope change.
		return (this.provider as unknown as { view?: { visible?: boolean } }).view?.visible === true
	}
}

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * Handles the `getUsageStats` message.
 * Validates the StatsQuery payload, queries the UsageStatsService, and posts
 * the result back to the webview with requestId correlation.
 *
 * Security: prompt, response, API key, workspace path are never stored or transmitted.
 */
export async function handleGetUsageStats(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	try {
		const service = provider.getUsageStatsService()

		if (!service) {
			await provider.postMessageToWebview({
				type: "getUsageStatsResponse",
				requestId,
				error: "[STATS_HANDLER/query/002] Usage stats service is unavailable",
			})
			return
		}

		// Validate payload
		const queryResult = StatsQuerySchema.safeParse(message.usageStatsQuery)

		if (!queryResult.success) {
			const errorMsg = queryResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")

			await provider.postMessageToWebview({
				type: "getUsageStatsResponse",
				requestId,
				error: `[STATS_HANDLER/query/001] Invalid stats query: ${errorMsg}`,
			})
			return
		}

		const query: StatsQuery = queryResult.data

		const recordingPaused = service.isCapped()

		const snapshot: StatsSnapshot = await service.queryStats(query, {
			recordingPaused,
		})

		await provider.postMessageToWebview({
			type: "getUsageStatsResponse",
			requestId,
			usageStatsSnapshot: snapshot,
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/query/003] Error querying usage stats: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		await provider.postMessageToWebview({
			type: "getUsageStatsResponse",
			requestId,
			error: `[STATS_HANDLER/query/003] Failed to query usage stats: ${errorMessage}`,
		})
	}
}

/**
 * Handles the `clearUsageStats` message.
 * Requires a valid confirmation nonce (issued by the service).
 * The nonce is short-lived (5 minutes) and single-use.
 *
 * Security: clear does not touch task history, provider settings, or prompt/response data.
 */
export async function handleClearUsageStats(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	try {
		const service = provider.getUsageStatsService()

		if (!service) {
			await provider.postMessageToWebview({
				type: "clearUsageStatsResponse",
				requestId,
				clearUsageStatsResult: {
					success: false,
					error: "[STATS_HANDLER/clear/002] Usage stats service is unavailable",
				},
			})
			return
		}

		// Validate nonce
		const nonce = message.clearUsageStatsNonce

		if (!nonce || typeof nonce !== "string") {
			await provider.postMessageToWebview({
				type: "clearUsageStatsResponse",
				requestId,
				clearUsageStatsResult: {
					success: false,
					error: "[STATS_HANDLER/clear/001] Missing or invalid confirmation nonce",
				},
			})
			return
		}

		await service.clearStats(nonce)

		// Notify this window's webview that stats changed.
		// Other windows are notified via the FileSystemWatcher in
		// UsageStatsService (cross-window sync) or via their own
		// UsageRecorder notifyChanged callback (same-window sync).
		await provider.postMessageToWebview({
			type: "usageStatsChanged",
		})

		await provider.postMessageToWebview({
			type: "clearUsageStatsResponse",
			requestId,
			clearUsageStatsResult: {
				success: true,
			},
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/clear/003] Error clearing usage stats: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		await provider.postMessageToWebview({
			type: "clearUsageStatsResponse",
			requestId,
			clearUsageStatsResult: {
				success: false,
				error: `[STATS_HANDLER/clear/003] Failed to clear usage stats: ${errorMessage}`,
			},
		})
	}
}

/**
 * Handles the `rebuildUsageStats` message.
 * Rebuilds all derived tables (stats_rollup, session_metadata, session_activity)
 * from the raw usage_events table. This is a maintenance operation for fixing
 * stale or missing rollup data.
 */
export async function handleRebuildUsageStats(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	try {
		const service = provider.getUsageStatsService()

		if (!service) {
			await provider.postMessageToWebview({
				type: "rebuildUsageStatsResponse",
				requestId,
				rebuildUsageStatsResult: {
					success: false,
					error: "[STATS_HANDLER/rebuild/002] Usage stats service is unavailable",
				},
			})
			return
		}

		const database = service.getDatabase()

		if (!database) {
			await provider.postMessageToWebview({
				type: "rebuildUsageStatsResponse",
				requestId,
				rebuildUsageStatsResult: {
					success: false,
					error: "[STATS_HANDLER/rebuild/001] Database is not initialized",
				},
			})
			return
		}

		database.rebuildRollupsFromEvents()

		// Notify this window's webview that stats changed
		await provider.postMessageToWebview({
			type: "usageStatsChanged",
		})

		await provider.postMessageToWebview({
			type: "rebuildUsageStatsResponse",
			requestId,
			rebuildUsageStatsResult: {
				success: true,
			},
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/rebuild/003] Error rebuilding usage stats: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		await provider.postMessageToWebview({
			type: "rebuildUsageStatsResponse",
			requestId,
			rebuildUsageStatsResult: {
				success: false,
				error: `[STATS_HANDLER/rebuild/003] Failed to rebuild usage stats: ${errorMessage}`,
			},
		})
	}
}

/**
 * Handles the `exportUsageStats` message.
 * Validates the format and query, calls the service to generate export data,
 * opens a VS Code save dialog, writes the file, and posts the result back.
 *
 * Security: the full event array is never sent to the webview. The host writes
 * the file directly to the user-selected location.
 */
export async function handleExportUsageStats(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	try {
		const service = provider.getUsageStatsService()

		if (!service) {
			await provider.postMessageToWebview({
				type: "exportUsageStatsResponse",
				requestId,
				exportUsageStatsResult: {
					format: "json",
					data: "",
					error: "[STATS_HANDLER/export/002] Usage stats service is unavailable",
				},
			})
			return
		}

		// Validate format
		const format = message.exportUsageStatsFormat

		if (format !== "json" && format !== "csv") {
			await provider.postMessageToWebview({
				type: "exportUsageStatsResponse",
				requestId,
				exportUsageStatsResult: {
					format: "json",
					data: "",
					error: `[STATS_HANDLER/export/004] Unsupported export format: ${String(format)}`,
				},
			})
			return
		}

		// Validate query
		const queryResult = StatsQuerySchema.safeParse(message.usageStatsQuery)

		if (!queryResult.success) {
			const errorMsg = queryResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")

			await provider.postMessageToWebview({
				type: "exportUsageStatsResponse",
				requestId,
				exportUsageStatsResult: {
					format,
					data: "",
					error: `[STATS_HANDLER/export/001] Invalid stats query: ${errorMsg}`,
				},
			})
			return
		}

		const query: StatsQuery = queryResult.data

		// Generate export data
		const exportData = await service.exportStats(query, format)

		// Serialize to file content
		const fileContent =
			format === "json" ? JSON.stringify(exportData as JsonExport, null, 2) : (exportData as string)

		// Determine default file name and extension
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
		const defaultFileName = `usage-stats-${timestamp}.${format === "json" ? "json" : "csv"}`

		// Resolve default save URI
		const defaultUri = await resolveDefaultSaveUri(
			provider.contextProxy,
			"lastUsageStatsExportPath",
			defaultFileName,
			{
				useWorkspace: false,
				fallbackDir: path.join(os.homedir(), "Downloads"),
			},
		)

		// Open save dialog
		const saveUri = await vscode.window.showSaveDialog({
			defaultUri,
			filters: format === "json" ? { JSON: ["json"] } : { CSV: ["csv"] },
			saveLabel: "Export Usage Stats",
		})

		// User cancelled the save dialog — not an error
		if (!saveUri) {
			await provider.postMessageToWebview({
				type: "exportUsageStatsResponse",
				requestId,
				exportUsageStatsResult: {
					format,
					data: "",
				},
			})
			return
		}

		// Write file
		await vscode.workspace.fs.writeFile(saveUri, Buffer.from(fileContent, "utf-8"))

		// Save last export path
		await saveLastExportPath(provider.contextProxy, "lastUsageStatsExportPath", saveUri)

		// Post success result (only file name, not full path)
		const fileName = path.basename(saveUri.fsPath)

		await provider.postMessageToWebview({
			type: "exportUsageStatsResponse",
			requestId,
			exportUsageStatsResult: {
				format,
				data: fileName,
			},
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/export/003] Error exporting usage stats: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		await provider.postMessageToWebview({
			type: "exportUsageStatsResponse",
			requestId,
			exportUsageStatsResult: {
				format: message.exportUsageStatsFormat ?? "json",
				data: "",
				error: `[STATS_HANDLER/export/003] Failed to export usage stats: ${errorMessage}`,
			},
		})
	}
}

/**
 * Handles the `requestClearNonce` message (B2 fix).
 *
 * Issues a host-generated clear confirmation nonce and posts it back to the
 * webview as `requestClearNonceResponse`. The webview must include this nonce
 * in the subsequent `clearUsageStats` message.
 *
 * Previously the webview generated its own nonce, which the host never stored,
 * so `clearStats` always failed with "nonce mismatch". The nonce is now
 * host-issued, short-lived (5 minutes), and single-use — matching the security
 * design intent.
 */
export async function handleRequestClearNonce(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	try {
		const service = provider.getUsageStatsService()

		if (!service) {
			await provider.postMessageToWebview({
				type: "requestClearNonceResponse",
				requestId,
				clearNonce: null,
				error: "[STATS_HANDLER/clear/002] Usage stats service is unavailable",
			})
			return
		}

		const nonce = service.issueClearNonce()

		await provider.postMessageToWebview({
			type: "requestClearNonceResponse",
			requestId,
			clearNonce: nonce,
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/clear/003] Error issuing clear nonce: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		await provider.postMessageToWebview({
			type: "requestClearNonceResponse",
			requestId,
			clearNonce: null,
			error: `[STATS_HANDLER/clear/003] Failed to issue clear nonce: ${errorMessage}`,
		})
	}
}

// ── Dashboard Sessions ──────────────────────────────────────────────────────

/**
 * Maximum number of characters used from the first user message when deriving
 * a session title. Keeps the session list readable without truncating in the
 * UI layer.
 */
const SESSION_TITLE_MAX_LENGTH = 80

/**
 * Best-effort safe logging helper that does not depend on a provider instance.
 * Falls back to `console.warn` so it works in pure utility contexts.
 */
function providerLogSafe(message: string): void {
	// Avoid throwing if console is unavailable (defensive).
	try {
		console.warn(message)
	} catch {
		// no-op
	}
}

/**
 * Derives a human-readable session title from a task's UI messages.
 *
 * Strategy (best-effort):
 *  1. Read `ui_messages.json` for the task via `readTaskMessages`.
 *  2. Find the first `ClineMessage` whose `type === "say"` and whose `say` is
 *     either `"user_feedback"` (a user-typed follow-up) or `"text"` / `"task"`
 *     (the initial task prompt). The `text` field of that message is the title.
 *  3. Truncate to {@link SESSION_TITLE_MAX_LENGTH} characters (first line only).
 *  4. If no user message is found, fall back to a truncated taskId.
 *
 * Security: only the `text` field of UI messages is read. No prompt bodies,
 * response bodies, or API keys are accessed.
 */
async function deriveSessionTitle(taskId: string, globalStoragePath: string): Promise<string> {
	try {
		const messages = await readTaskMessages({ taskId, globalStoragePath })

		for (const msg of messages) {
			if (msg.type !== "say") continue
			if (msg.say !== "user_feedback" && msg.say !== "text" && msg.say !== "task") continue
			const raw = (msg.text ?? "").trim()
			if (!raw) continue
			// Use only the first line to keep the title compact.
			const firstLine = raw.split(/\r?\n/, 1)[0] ?? raw
			if (firstLine.length <= SESSION_TITLE_MAX_LENGTH) return firstLine
			return `${firstLine.slice(0, SESSION_TITLE_MAX_LENGTH - 1)}\u2026`
		}
	} catch (error) {
		// Title extraction is best-effort; never fail the whole request.
		providerLogSafe(
			`[STATS_HANDLER/sessions/003] Failed to read task messages for title (taskId=${taskId}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}

	// Fallback: truncated taskId
	return taskId.length > SESSION_TITLE_MAX_LENGTH ? `${taskId.slice(0, SESSION_TITLE_MAX_LENGTH - 1)}\u2026` : taskId
}

/**
 * Resolves the root task ID for a usage event.
 *
 * Feature 2: Sessions should be grouped by conversation session (root task),
 * not by individual subtask. A subtask has a `parentTaskId` pointing to its
 * parent. By following the parent chain, we can group all subtasks under
 * their root conversation session.
 *
 * Since the event only carries its immediate `parentTaskId` (not the full
 * chain), we build a parent→children map from the event set and walk up
 * the chain. If an event has no `parentTaskId`, it IS the root.
 *
 * @param event The usage event to resolve.
 * @param parentMap Map of taskId → parentTaskId (built from the event set).
 * @returns The root task ID for grouping.
 */
function resolveRootTaskId(event: UsageEventV1, parentMap: Map<string, string | undefined>): string {
	let current = event.taskId
	const visited = new Set<string>() // Guard against cycles

	while (!visited.has(current)) {
		visited.add(current)
		const parent = parentMap.get(current)
		if (!parent) break // No parent → this is the root
		current = parent
	}

	return current
}

/**
 * Builds a map of taskId → parentTaskId from a set of usage events.
 * This allows resolving the root task for any event in the set.
 */
function buildParentMap(events: UsageEventV1[]): Map<string, string | undefined> {
	const parentMap = new Map<string, string | undefined>()
	for (const event of events) {
		if (!parentMap.has(event.taskId)) {
			parentMap.set(event.taskId, event.parentTaskId)
		}
	}
	return parentMap
}

/**
 * Groups usage events by their root conversation session and produces a
 * {@link SessionSummary} for each group.
 *
 * Feature 2: Events are grouped by root task ID (following `parentTaskId`
 * chains) so that subtasks appear under their parent conversation session.
 * If an event has no `parentTaskId`, it is its own root.
 *
 * Feature 1: Missing `costUsd` values are computed on-the-fly using the
 * model's pricing info. The NDJSON store is never modified.
 *
 * The summary uses the first event's model/provider/mode as representative
 * values (a session may span multiple models, but the first event is a
 * reasonable proxy for display purposes).
 *
 * @param events Filtered usage events (already scoped to the requested time
 *   range and `includeCancelled` policy).
 * @param globalStoragePath Used to read task messages for title extraction.
 */
async function buildSessionSummaries(events: UsageEventV1[], globalStoragePath: string): Promise<SessionSummary[]> {
	// Feature 2: Build parent map and group by root task ID.
	const parentMap = buildParentMap(events)

	// Group events by root taskId, preserving insertion order for determinism.
	const groups = new Map<string, UsageEventV1[]>()
	for (const event of events) {
		const rootTaskId = resolveRootTaskId(event, parentMap)
		const list = groups.get(rootTaskId)
		if (list) {
			list.push(event)
		} else {
			groups.set(rootTaskId, [event])
		}
	}

	const summaries: SessionSummary[] = []

	for (const [taskId, taskEvents] of groups) {
		// Sort events within a task by occurredAt ascending so the first
		// event is the earliest (representative model/provider/mode) and
		// the last event gives the most recent activity timestamp.
		const sorted = [...taskEvents].sort(
			(a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
		)

		const first = sorted[0]
		const last = sorted[sorted.length - 1]

		// Aggregate totals across all events in the task.
		// Feature 1: Use getEffectiveCost to compute missing costs on-the-fly.
		let totalTokens = 0
		let totalCost = 0
		for (const ev of sorted) {
			totalTokens += ev.usage.totalTokens?.value ?? 0
			totalCost += getEffectiveCost(ev)
		}

		const title = await deriveSessionTitle(taskId, globalStoragePath)

		summaries.push({
			taskId,
			title,
			timestamp: new Date(last.occurredAt).getTime(),
			model: first.model,
			provider: first.provider,
			mode: first.mode,
			// Preserve first-seen order across the session's events so that
			// multi-model/multi-mode sessions (e.g. orchestrator delegations)
			// are fully represented. `model`/`mode` above keep the earliest
			// value for backward compatibility.
			models: [...new Set(sorted.map((e) => e.model))],
			modes: [...new Set(sorted.map((e) => e.mode))],
			totalTokens,
			totalCost,
			callCount: sorted.length,
		})
	}

	// Sort sessions by timestamp descending (most recent first).
	summaries.sort((a, b) => b.timestamp - a.timestamp)

	return summaries
}

/**
 * Handles the `getDashboardSessions` message.
 *
 * Reads the time-range query (reusing the existing `StatsQuery` validation
 * infrastructure), queries the `UsageStatsService` for raw events, groups
 * them by `taskId` into {@link SessionSummary} entries, applies optional
 * model/provider filters, and posts the result back to the webview as
 * `dashboardSessionsResponse`.
 *
 * The session title is derived best-effort from the task's UI messages; if
 * unavailable, a truncated taskId is used as the title.
 *
 * Security: only `taskId`, model/provider/mode, token totals, cost, and the
 * first user message text (truncated) are sent to the webview. No prompt
 * bodies, response bodies, or API keys are transmitted.
 */
export async function handleGetDashboardSessions(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	try {
		const service = provider.getUsageStatsService()

		if (!service) {
			await provider.postMessageToWebview({
				type: "dashboardSessionsResponse",
				requestId,
				dashboardSessions: null,
				error: "[STATS_HANDLER/sessions/002] Usage stats service is unavailable",
			})
			return
		}

		// Validate the stats query payload (time range + timezone + groupBy).
		// `groupBy` is required by the schema but irrelevant for session
		// grouping; the caller still has to provide a valid value.
		const queryResult = StatsQuerySchema.safeParse(message.usageStatsQuery)

		if (!queryResult.success) {
			const errorMsg = queryResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")

			await provider.postMessageToWebview({
				type: "dashboardSessionsResponse",
				requestId,
				dashboardSessions: null,
				error: `[STATS_HANDLER/sessions/001] Invalid stats query: ${errorMsg}`,
			})
			return
		}

		const query: StatsQuery = queryResult.data

		// Use the cached events directly instead of export→JSON→parse. This
		// preserves the same time-range and includeCancelled filtering while
		// avoiding an unnecessary serialize/parse round-trip.
		const events = await service.getFilteredEvents(query)

		const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath

		let summaries = await buildSessionSummaries(events, globalStoragePath)

		// Apply optional model/provider filters (post-grouping).
		// The model filter checks `models` (the full set used in the session)
		// so that sessions which switched models are still matched; it falls
		// back to the legacy `model` field when `models` is absent.
		const filters = message.dashboardSessionFilters
		if (filters?.model) {
			summaries = summaries.filter((s) => s.models?.includes(filters.model!) ?? s.model === filters.model)
		}
		if (filters?.provider) {
			summaries = summaries.filter((s) => s.provider === filters.provider)
		}

		await provider.postMessageToWebview({
			type: "dashboardSessionsResponse",
			requestId,
			dashboardSessions: summaries,
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/sessions/003] Error querying dashboard sessions: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		await provider.postMessageToWebview({
			type: "dashboardSessionsResponse",
			requestId,
			dashboardSessions: null,
			error: `[STATS_HANDLER/sessions/003] Failed to query dashboard sessions: ${errorMessage}`,
		})
	}
}

// ── Dashboard Session Detail ─────────────────────────────────────────────────

/**
 * Maps a single {@link UsageEventV1} to an {@link APICallRecord} for display
 * in the session detail expansion. Only the fields needed by the UI are
 * projected; prompt bodies, response bodies, API keys, and workspace paths
 * are never included.
 *
 * @param event The raw usage event.
 * @param index The 1-based index of the event within its task (for display).
 */
function mapEventToApiCall(event: UsageEventV1, index: number): APICallRecord {
	return {
		index,
		mode: event.mode,
		timestamp: new Date(event.occurredAt).getTime(),
		inputTokens: event.usage.inputTokens?.value ?? 0,
		outputTokens: event.usage.outputTokens?.value ?? 0,
		cacheReadTokens: event.usage.cacheReadTokens?.value ?? 0,
		cacheWriteTokens: event.usage.cacheWriteTokens?.value ?? 0,
		reasoningTokens: event.usage.reasoningTokens?.value ?? 0,
		// Feature 1: Compute missing cost on-the-fly from model pricing.
		costUsd: getEffectiveCost(event),
		status: event.status,
		model: event.model,
	}
}

/**
 * Builds a {@link SessionDetail} from the raw usage events for a single task.
 *
 * The summary fields mirror {@link buildSessionSummaries} so the expanded
 * detail header matches the row summary the user clicked. The `apiCalls` array
 * is sorted by `occurredAt` ascending (oldest first) so the index column
 * reflects chronological order within the session.
 *
 * @param taskId The task identifier to build the detail for.
 * @param events The raw usage events filtered to this task.
 * @param globalStoragePath Used to read task messages for title extraction.
 */
async function buildSessionDetail(
	taskId: string,
	events: UsageEventV1[],
	globalStoragePath: string,
): Promise<SessionDetail> {
	// Sort events by occurredAt ascending so index reflects chronological order.
	const sorted = [...events].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime())

	const first = sorted[0]
	const last = sorted[sorted.length - 1]

	// Aggregate totals across all events in the task.
	// Feature 1: Use getEffectiveCost to compute missing costs on-the-fly.
	let totalTokens = 0
	let totalCost = 0
	for (const ev of sorted) {
		totalTokens += ev.usage.totalTokens?.value ?? 0
		totalCost += getEffectiveCost(ev)
	}

	const title = await deriveSessionTitle(taskId, globalStoragePath)

	const apiCalls: APICallRecord[] = sorted.map((event, i) => mapEventToApiCall(event, i + 1))

	return {
		taskId,
		title,
		timestamp: new Date(last.occurredAt).getTime(),
		model: first.model,
		provider: first.provider,
		mode: first.mode,
		// Mirror buildSessionSummaries: capture every unique model/mode in
		// first-seen order so the detail view can show the full set.
		models: [...new Set(sorted.map((e) => e.model))],
		modes: [...new Set(sorted.map((e) => e.mode))],
		totalTokens,
		totalCost,
		callCount: sorted.length,
		apiCalls,
	}
}

/**
 * Handles the `getDashboardSessionDetail` message (Commit 4).
 *
 * Reads the `taskId` from the message, queries the `UsageStatsService` for all
 * raw events (using a permissive time-range query so every event for the task
 * is returned), filters to the requested `taskId`, builds a {@link SessionDetail}
 * with per-API-call records, and posts the result back to the webview as
 * `dashboardSessionDetailResponse`.
 *
 * The query reuses `exportStats` with the "all" preset (no from/to bounds) so
 * the detail is not clipped by the dashboard's current time-range selection.
 * This matches user expectations: clicking a session row shows the full
 * session, not just the portion within the current range.
 *
 * Security: only `taskId`, model/provider/mode, token totals, cost, status,
 * timestamps, and the first user message text (truncated) are sent to the
 * webview. No prompt bodies, response bodies, or API keys are transmitted.
 */
export async function handleGetDashboardSessionDetail(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	try {
		const service = provider.getUsageStatsService()

		if (!service) {
			await provider.postMessageToWebview({
				type: "dashboardSessionDetailResponse",
				requestId,
				dashboardSessionDetail: null,
				error: "[STATS_HANDLER/sessionDetail/002] Usage stats service is unavailable",
			})
			return
		}

		// The taskId is carried in `message.text` (the conventional field for
		// single-string payloads in WebviewMessage). It is also accepted via
		// `message.taskId` for explicitness.
		const taskId = message.taskId ?? message.text

		if (!taskId || typeof taskId !== "string") {
			await provider.postMessageToWebview({
				type: "dashboardSessionDetailResponse",
				requestId,
				dashboardSessionDetail: null,
				error: "[STATS_HANDLER/sessionDetail/001] Missing or invalid taskId",
			})
			return
		}

		// Query all events (no time-range bounds) so the session detail is
		// not clipped by the dashboard's current range selection. The
		// `includeCancelled` flag is true so failed/cancelled calls appear in
		// the per-call list (the summary already excludes them from totals
		// when the dashboard range filters them out, but the detail view
		// should show every call that happened in the session).
		const allQuery: StatsQuery = {
			preset: "all",
			timezone: "UTC",
			groupBy: ["model"],
			includeCancelled: true,
		}

		// Query all events directly to avoid the export→JSON→parse round-trip.
		const allEvents = await service.getFilteredEvents(allQuery)

		// Feature 2: Filter to the requested root task AND its subtasks.
		// The session list groups events by root task ID, so clicking a
		// session row passes the root task ID. We need to include events
		// from all subtasks whose root resolves to this taskId.
		const parentMap = buildParentMap(allEvents)
		const taskEvents = allEvents.filter((ev) => resolveRootTaskId(ev, parentMap) === taskId)

		if (taskEvents.length === 0) {
			// No events for this task — return an empty detail rather than an
			// error so the UI can render the "no API calls" empty state.
			const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath
			const title = await deriveSessionTitle(taskId, globalStoragePath)

			await provider.postMessageToWebview({
				type: "dashboardSessionDetailResponse",
				requestId,
				dashboardSessionDetail: {
					taskId,
					title,
					timestamp: 0,
					model: "",
					provider: "",
					mode: "",
					models: [],
					modes: [],
					totalTokens: 0,
					totalCost: 0,
					callCount: 0,
					apiCalls: [],
				},
			})
			return
		}

		const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath
		const detail = await buildSessionDetail(taskId, taskEvents, globalStoragePath)

		await provider.postMessageToWebview({
			type: "dashboardSessionDetailResponse",
			requestId,
			dashboardSessionDetail: detail,
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/sessionDetail/003] Error querying dashboard session detail: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		await provider.postMessageToWebview({
			type: "dashboardSessionDetailResponse",
			requestId,
			dashboardSessionDetail: null,
			error: `[STATS_HANDLER/sessionDetail/003] Failed to query dashboard session detail: ${errorMessage}`,
		})
	}
}

// ── Dashboard Stats Stream Handlers ──────────────────────────────────────────

/**
 * Lazily creates (or retrieves) the {@link ProviderStreamSink} for a provider.
 * The sink is stored on the provider as a non-enumerable property so it
 * persists across messages but is cleaned up when the provider is disposed.
 *
 * The coordinator is obtained from the UsageStatsService. If the service or
 * coordinator is unavailable, an error response is sent.
 */
async function getCoordinatorAndSink(
	provider: ClineProvider,
	requestId: string | undefined,
): Promise<{ coordinator: UsageStatsStreamCoordinator; sink: ProviderStreamSink } | null> {
	const service = provider.getUsageStatsService()

	if (!service) {
		if (requestId) {
			provider
				.postMessageToWebview({
					type: "dashboardStatsStreamError",
					dashboardStatsStreamError: {
						requestId,
						code: "STATS_HANDLER/stream/002",
						message: "[STATS_HANDLER/stream/002] Usage stats service is unavailable",
					},
				})
				.catch(() => {})
		}
		return null
	}

	await service.ensureInitialized()

	const coordinator = service.getCoordinator()

	if (!coordinator) {
		if (requestId) {
			provider
				.postMessageToWebview({
					type: "dashboardStatsStreamError",
					dashboardStatsStreamError: {
						requestId,
						code: "STATS_HANDLER/stream/002",
						message: "[STATS_HANDLER/stream/002] Stream coordinator is unavailable",
					},
				})
				.catch(() => {})
		}
		return null
	}

	// Reuse a single sink per provider instance.
	let sink = (provider as unknown as { _streamSink?: ProviderStreamSink })._streamSink

	if (!sink) {
		sink = new ProviderStreamSink(provider)
		;(provider as unknown as { _streamSink?: ProviderStreamSink })._streamSink = sink
	}

	return { coordinator, sink }
}

/**
 * Handles the `subscribeDashboardStats` message.
 *
 * Validates the subscription payload, obtains the coordinator, and subscribes
 * the provider's sink. The coordinator sends the initial snapshot immediately.
 */
export async function handleSubscribeDashboardStats(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	const result = await getCoordinatorAndSink(provider, requestId)

	if (!result) return

	const { coordinator, sink } = result

	// Validate subscription payload
	const subResult = DashboardStatsSubscriptionSchema.safeParse(message.dashboardStatsSubscription)

	if (!subResult.success) {
		const errorMsg = subResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")

		provider
			.postMessageToWebview({
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: {
					requestId: requestId ?? "",
					code: "STATS_HANDLER/stream/001",
					message: `[STATS_HANDLER/stream/001] Invalid subscription payload: ${errorMsg}`,
				},
			})
			.catch(() => {})
		return
	}

	try {
		coordinator.subscribe(sink, subResult.data)
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/stream/003] Error subscribing to dashboard stats: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		provider
			.postMessageToWebview({
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: {
					requestId: requestId ?? "",
					code: "STATS_HANDLER/stream/003",
					message: `[STATS_HANDLER/stream/003] Failed to subscribe: ${errorMessage}`,
				},
			})
			.catch(() => {})
	}
}

/**
 * Handles the `unsubscribeDashboardStats` message.
 * Releases the provider's subscription from the coordinator.
 */
export async function handleUnsubscribeDashboardStats(provider: ClineProvider, _message: WebviewMessage): Promise<void> {
	const result = await getCoordinatorAndSink(provider, undefined)

	if (!result) return

	const { coordinator, sink } = result

	coordinator.unsubscribe(sink)
}

/**
 * Handles the `replaceDashboardStatsSubscription` message.
 *
 * Validates the new subscription payload and replaces the existing subscription.
 * The coordinator sends a fresh snapshot for the new query.
 */
export async function handleReplaceDashboardStatsSubscription(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	const result = await getCoordinatorAndSink(provider, requestId)

	if (!result) return

	const { coordinator, sink } = result

	// Validate subscription payload
	const subResult = DashboardStatsSubscriptionSchema.safeParse(message.dashboardStatsSubscription)

	if (!subResult.success) {
		const errorMsg = subResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")

		provider
			.postMessageToWebview({
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: {
					requestId: requestId ?? "",
					code: "STATS_HANDLER/stream/001",
					message: `[STATS_HANDLER/stream/001] Invalid subscription payload: ${errorMsg}`,
				},
			})
			.catch(() => {})
		return
	}

	try {
		coordinator.replaceSubscription(sink, subResult.data)
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/stream/003] Error replacing dashboard stats subscription: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		provider
			.postMessageToWebview({
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: {
					requestId: requestId ?? "",
					code: "STATS_HANDLER/stream/003",
					message: `[STATS_HANDLER/stream/003] Failed to replace subscription: ${errorMessage}`,
				},
			})
			.catch(() => {})
	}
}

/**
 * Handles the `pauseDashboardStats` message.
 * Pauses delta delivery for the provider's subscription, retaining the cursor.
 */
export async function handlePauseDashboardStats(provider: ClineProvider, _message: WebviewMessage): Promise<void> {
	const result = await getCoordinatorAndSink(provider, undefined)

	if (!result) return

	const { coordinator, sink } = result

	coordinator.pause(sink)
}

/**
 * Handles the `resumeDashboardStats` message.
 *
 * Resumes delta delivery from the last acknowledged sequence. If the gap is
 * too large or the generation changed, the coordinator sends a full snapshot.
 *
 * The `value` field carries the last sequence number acknowledged by the webview.
 */
export async function handleResumeDashboardStats(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const result = await getCoordinatorAndSink(provider, undefined)

	if (!result) return

	const { coordinator, sink } = result

	// The last sequence is carried in `message.value` (a numeric field).
	const lastSequence = typeof message.value === "number" ? message.value : 0

	coordinator.resume(sink, lastSequence)
}

/**
 * Handles the `resyncDashboardStats` message.
 *
 * Forces a full snapshot replacement for the provider's subscription.
 * This is used when the webview detects inconsistency or after an error recovery.
 * Internally, this calls `replaceSubscription` with the same subscription
 * descriptor to trigger a fresh snapshot.
 */
export async function handleResyncDashboardStats(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	const result = await getCoordinatorAndSink(provider, requestId)

	if (!result) return

	const { coordinator, sink } = result

	// Validate subscription payload (required for resync to know the query)
	const subResult = DashboardStatsSubscriptionSchema.safeParse(message.dashboardStatsSubscription)

	if (!subResult.success) {
		const errorMsg = subResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")

		provider
			.postMessageToWebview({
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: {
					requestId: requestId ?? "",
					code: "STATS_HANDLER/stream/001",
					message: `[STATS_HANDLER/stream/001] Invalid subscription payload for resync: ${errorMsg}`,
				},
			})
			.catch(() => {})
		return
	}

	try {
		// Replace subscription triggers a fresh snapshot for the same query.
		coordinator.replaceSubscription(sink, subResult.data)
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/stream/003] Error resyncing dashboard stats: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		provider
			.postMessageToWebview({
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: {
					requestId: requestId ?? "",
					code: "STATS_HANDLER/stream/003",
					message: `[STATS_HANDLER/stream/003] Failed to resync: ${errorMessage}`,
				},
			})
			.catch(() => {})
	}
}

/**
 * Handles the `getDashboardSessionPage` message.
 *
 * Fetches the next page of sessions from the database using the opaque cursor
 * from the previous page. Posts the result back as `dashboardSessionPageResponse`.
 *
 * Security: only session summaries (rootTaskId, title, totals, model, provider,
 * lastActivity, eventCount) are sent. No prompt bodies, response bodies, or
 * API keys are transmitted.
 */
export async function handleGetDashboardSessionPage(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const requestId = message.requestId

	try {
		const service = provider.getUsageStatsService()

		if (!service) {
			await provider.postMessageToWebview({
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: {
					requestId: requestId ?? "",
					code: "STATS_HANDLER/stream/002",
					message: "[STATS_HANDLER/stream/002] Usage stats service is unavailable",
				},
			})
			return
		}

		const database = service.getDatabase()

		if (!database) {
			await provider.postMessageToWebview({
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: {
					requestId: requestId ?? "",
					code: "STATS_HANDLER/stream/002",
					message: "[STATS_HANDLER/stream/002] Database is unavailable",
				},
			})
			return
		}

		// Validate cursor and limit
		const cursor = message.dashboardSessionCursor
		const limit = message.dashboardSessionLimit

		if (typeof limit !== "number" || limit < 1 || limit > 100) {
			await provider.postMessageToWebview({
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: {
					requestId: requestId ?? "",
					code: "STATS_HANDLER/stream/004",
					message: "[STATS_HANDLER/stream/004] Invalid or missing page limit (must be 1-100)",
				},
			})
			return
		}

		// Import computeSessionPage lazily to avoid circular dependency at module load.
		const { computeSessionPage } = await import("../../services/stats/UsageStatsProjection")

		const page = computeSessionPage(database, requestId ?? "", cursor, limit)

		await provider.postMessageToWebview({
			type: "dashboardSessionPageResponse",
			dashboardSessionPage: page,
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		provider.log(
			`[STATS_HANDLER/stream/005] Error fetching dashboard session page: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)

		await provider.postMessageToWebview({
			type: "dashboardStatsStreamError",
			dashboardStatsStreamError: {
				requestId: requestId ?? "",
				code: "STATS_HANDLER/stream/005",
				message: `[STATS_HANDLER/stream/005] Failed to fetch session page: ${errorMessage}`,
			},
		})
	}
}

// Re-export StatsServiceError for convenience in tests
export { StatsServiceError }
