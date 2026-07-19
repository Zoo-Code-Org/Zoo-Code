import * as vscode from "vscode"
import * as path from "path"
import * as os from "os"

import type { WebviewMessage, StatsQuery, StatsSnapshot } from "@roo-code/types"
import { StatsQuery as StatsQuerySchema } from "@roo-code/types"

import type { ClineProvider } from "./ClineProvider"
import type { UsageStatsService, JsonExport } from "../../services/stats"
import { StatsServiceError } from "../../services/stats"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"

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

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * Handles the `getUsageStats` message.
 * Validates the StatsQuery payload, queries the UsageStatsService, and posts
 * the result back to the webview with requestId correlation.
 *
 * Security: prompt, response, API key, workspace path are never stored or transmitted.
 */
export async function handleGetUsageStats(
	provider: ClineProvider,
	message: WebviewMessage,
): Promise<void> {
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
			const errorMsg = queryResult.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ")

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
export async function handleClearUsageStats(
	provider: ClineProvider,
	message: WebviewMessage,
): Promise<void> {
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
export async function handleExportUsageStats(
	provider: ClineProvider,
	message: WebviewMessage,
): Promise<void> {
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
			const errorMsg = queryResult.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ")

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
			format === "json"
				? JSON.stringify(exportData as JsonExport, null, 2)
				: (exportData as string)

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
			filters:
				format === "json"
					? { "JSON": ["json"] }
					: { "CSV": ["csv"] },
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

// Re-export StatsServiceError for convenience in tests
export { StatsServiceError }
