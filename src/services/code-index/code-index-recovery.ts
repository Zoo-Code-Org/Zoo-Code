import type { CacheManager } from "./cache-manager"
import type { IVectorStore } from "./interfaces"
import type { CodeIndexStateManager } from "./state-manager"
import type { CodeIndexWatcherSession } from "./code-index-watcher-session"
import type { CodeIndexRun } from "./code-index-run"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { t } from "../../i18n"

/** Restores a consistent index state after cancellation or failure. Does not release run ownership. */
export class CodeIndexRecovery {
	constructor(
		private readonly cacheManager: Pick<CacheManager, "flush" | "clearCacheFile">,
		private readonly vectorStore: Pick<IVectorStore, "clearCollection">,
		private readonly stateManager: Pick<CodeIndexStateManager, "setSystemState">,
		private readonly watcherSession: Pick<CodeIndexWatcherSession, "stop">,
	) {}

	async handle(error: unknown, run: CodeIndexRun): Promise<void> {
		if (this._isCancellation(error, run.signal)) {
			await this._finishCancellation()
			return
		}

		this._reportError("[CodeIndexOrchestrator] Error during indexing:", error, "startIndexing")
		if (run.canCleanupFailedScan) {
			await this._cleanupFailedFullScan()
		} else {
			console.log("[CodeIndexOrchestrator] Preserving existing index and cache for a future incremental scan.")
		}

		const errorMessage =
			typeof error === "object" && error !== null && "message" in error && error.message
				? error.message
				: t("embeddings:orchestrator.unknownError")
		this.stateManager.setSystemState(
			"Error",
			t("embeddings:orchestrator.failedDuringInitialScan", { errorMessage }),
		)
		this.watcherSession.stop()
	}

	private async _finishCancellation(): Promise<void> {
		console.log("[CodeIndexOrchestrator] Indexing aborted by user.")
		try {
			await this.cacheManager.flush()
		} catch (flushError) {
			console.error("[CodeIndexOrchestrator] Failed to flush cache after cancellation:", flushError)
		}
		this.watcherSession.stop()
		this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.indexingStopped"))
	}

	private async _cleanupFailedFullScan(): Promise<void> {
		try {
			await this.vectorStore.clearCollection()
		} catch (cleanupError) {
			this._reportError(
				"[CodeIndexOrchestrator] Failed to clean up after error:",
				cleanupError,
				"startIndexing.cleanup",
			)
		}
		try {
			await this.cacheManager.clearCacheFile()
		} catch (cleanupError) {
			console.error("[CodeIndexOrchestrator] Failed to clear cache after indexing error:", cleanupError)
		}
		console.log("[CodeIndexOrchestrator] Indexing failed after starting. Clearing cache to avoid inconsistency.")
	}

	handleClearError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error)
		this._reportError("[CodeIndexOrchestrator] Failed to clear index data:", error, "clearIndexData")
		this.stateManager.setSystemState("Error", `Failed to clear index data: ${message}`)
	}

	private _isCancellation(error: unknown, signal: AbortSignal): boolean {
		return (
			signal.aborted ||
			(typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
		)
	}

	private _reportError(message: string, error: unknown, location: string): void {
		console.error(message, error)
		TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			location,
		})
	}
}
