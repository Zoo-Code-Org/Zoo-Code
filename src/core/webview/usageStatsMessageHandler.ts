import * as vscode from "vscode"
import * as path from "path"
import * as os from "os"

import type { WebviewMessage, StatsQuery, StatsSnapshot, SessionSummary, UsageEventV1 } from "@roo-code/types"
import { StatsQuery as StatsQuerySchema } from "@roo-code/types"

import type { ClineProvider } from "./ClineProvider"
import type { UsageStatsService, JsonExport } from "../../services/stats"
import { StatsServiceError } from "../../services/stats"
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
	| "STATS_HANDLER/export/001" // invalid payload
	| "STATS_HANDLER/export/002" // service unavailable
	| "STATS_HANDLER/export/003" // service error
	| "STATS_HANDLER/export/004" // unsupported format
	| "STATS_HANDLER/sessions/001" // invalid payload (invalid stats query)
	| "STATS_HANDLER/sessions/002" // service unavailable
	| "STATS_HANDLER/sessions/003" // service error

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

		// Notify all open webviews that stats changed
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
 * Groups usage events by `taskId` and produces a {@link SessionSummary} for
 * each group. The summary uses the first event's model/provider/mode as
 * representative values (a session may span multiple models, but the first
 * event is a reasonable proxy for display purposes).
 *
 * @param events Filtered usage events (already scoped to the requested time
 *   range and `includeCancelled` policy).
 * @param globalStoragePath Used to read task messages for title extraction.
 */
async function buildSessionSummaries(events: UsageEventV1[], globalStoragePath: string): Promise<SessionSummary[]> {
	// Group events by taskId, preserving insertion order for determinism.
	const groups = new Map<string, UsageEventV1[]>()
	for (const event of events) {
		const list = groups.get(event.taskId)
		if (list) {
			list.push(event)
		} else {
			groups.set(event.taskId, [event])
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
		let totalTokens = 0
		let totalCost = 0
		for (const ev of sorted) {
			totalTokens += ev.usage.totalTokens?.value ?? 0
			totalCost += ev.usage.costUsd?.value ?? 0
		}

		const title = await deriveSessionTitle(taskId, globalStoragePath)

		summaries.push({
			taskId,
			title,
			timestamp: new Date(last.occurredAt).getTime(),
			model: first.model,
			provider: first.provider,
			mode: first.mode,
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

		// Export returns the filtered raw events (JSON format) which we then
		// group by taskId. This reuses the service's existing time-range and
		// includeCancelled filtering logic without exposing a new public method.
		const exportData = await service.exportStats(query, "json")
		const events: UsageEventV1[] = (exportData as JsonExport).events ?? []

		const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath

		let summaries = await buildSessionSummaries(events, globalStoragePath)

		// Apply optional model/provider filters (post-grouping).
		const filters = message.dashboardSessionFilters
		if (filters?.model) {
			summaries = summaries.filter((s) => s.model === filters.model)
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

// Re-export StatsServiceError for convenience in tests
export { StatsServiceError }
