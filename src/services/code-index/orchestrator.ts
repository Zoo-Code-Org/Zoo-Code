import * as vscode from "vscode"
import * as path from "path"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager, IndexingState } from "./state-manager"
import { IFileWatcher, IVectorStore, BatchProcessingSummary } from "./interfaces"
import { DirectoryScanner } from "./processors"
import { CacheManager } from "./cache-manager"
import { CodeIndexScanExecutor } from "./code-index-scan-executor"
import type { FileFailureRegistry } from "./file-failure-registry"
import type { ProviderPacerRegistry } from "./provider-pacer"
import { formatProviderWaitMessage } from "./shared/provider-wait-message"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { t } from "../../i18n"

/**
 * Manages the code indexing workflow, coordinating between different services and managers.
 *
 * One `AbortController` covers a whole session (scan and watcher). Every status write except the final
 * Standby in `stop()` first checks that controller's signal, so a stopped session cannot overwrite a later one.
 */
export class CodeIndexOrchestrator {
	private _fileWatcherSubscriptions: vscode.Disposable[] = []
	private _abortController: AbortController | null = null
	private scanPromise?: Promise<void>
	private stopPromise?: Promise<void>
	private scanDone = false
	private watcherBatchPending = false
	private recoverySubscriptions: vscode.Disposable[] = []
	private readonly scanExecutor: CodeIndexScanExecutor

	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		workspacePath: string,
		private readonly cacheManager: CacheManager,
		private readonly vectorStore: IVectorStore,
		scanner: DirectoryScanner,
		private readonly fileWatcher: IFileWatcher,
		private readonly failures: FileFailureRegistry,
		private readonly pacers: ProviderPacerRegistry,
	) {
		this.scanExecutor = new CodeIndexScanExecutor(workspacePath, scanner, vectorStore, stateManager)
	}

	private setState(signal: AbortSignal, state: IndexingState, message?: string): void {
		if (!signal.aborted) this.stateManager.setSystemState(state, message)
	}

	private hasOutstandingWork(): boolean {
		return this.failures.list().length > 0 || this.pacers.hasWaitingRequests()
	}

	/** Reflects failures and provider waits in the status; never replaces Stopping or Error. */
	private updateRecoveryStatus(signal: AbortSignal): void {
		const state = this.stateManager.state
		if (signal.aborted || state === "Stopping" || state === "Error") return
		if (this.pacers.hasWaitingRequests()) {
			this.stateManager.setSystemState("Indexing", formatProviderWaitMessage(this.pacers.providerWaits()))
			return
		}
		if (!this.scanDone || this.watcherBatchPending) return
		if (this.failures.list().length > 0) {
			this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.indexingFilesFailed"))
			return
		}
		if (state !== "Indexed") {
			this.stateManager.setSystemState("Indexed", t("embeddings:orchestrator.fileWatcherStarted"))
		}
	}

	private async _startWatcher(signal: AbortSignal): Promise<void> {
		if (!this.configManager.isFeatureConfigured) {
			throw new Error("Cannot start watcher: Service not configured.")
		}

		this.setState(signal, "Indexing", "Initializing file watcher...")

		try {
			await this.fileWatcher.initialize(signal)

			this._fileWatcherSubscriptions = [
				this.fileWatcher.onDidStartBatchProcessing(() => {
					this.watcherBatchPending = true
				}),
				this.fileWatcher.onBatchProgressUpdate(({ processedInBatch, totalInBatch, currentFile }) => {
					if (signal.aborted || this.stateManager.state === "Stopping") return
					if (totalInBatch > 0 && this.stateManager.state !== "Indexing") {
						this.stateManager.setSystemState("Indexing", "Processing file changes...")
					}
					this.stateManager.reportFileQueueProgress(
						processedInBatch,
						totalInBatch,
						currentFile ? path.basename(currentFile) : undefined,
					)
					// The watcher reports progress after the batch-finished event; settle the status again.
					if (processedInBatch === totalInBatch && !this.watcherBatchPending) {
						this.updateRecoveryStatus(signal)
					}
				}),
				this.fileWatcher.onDidFinishBatchProcessing((summary?: BatchProcessingSummary) => {
					if (summary?.batchError) {
						console.error(`[CodeIndexOrchestrator] Batch processing failed:`, summary.batchError)
					}
					this.watcherBatchPending = false
					this.updateRecoveryStatus(signal)
				}),
			]
		} catch (error) {
			console.error("[CodeIndexOrchestrator] Failed to start file watcher:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "_startWatcher",
			})
			throw error
		}
	}

	/**
	 * Starts one indexing session (scan, then watcher). A repeated call while a scan runs returns the running
	 * scan; a call while stopping waits for the stop to finish first; a call during the watcher phase stops
	 * that session and rescans, so an explicit retry reaches failed files.
	 */
	public async startIndexing(): Promise<void> {
		if (this.stopPromise) await this.stopPromise
		if (this.scanPromise) return this.scanPromise

		if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
			this.stateManager.setSystemState("Error", t("embeddings:orchestrator.indexingRequiresWorkspace"))
			console.warn("[CodeIndexOrchestrator] Start rejected: No workspace folder open.")
			return
		}

		if (!this.configManager.isFeatureConfigured) {
			this.stateManager.setSystemState("Standby", "Missing configuration. Save your settings to start indexing.")
			console.warn("[CodeIndexOrchestrator] Start rejected: Missing configuration.")
			return
		}

		if (this._abortController && !this._abortController.signal.aborted) {
			await this.stopIndexing()
			if (this.scanPromise) return this.scanPromise
		}

		this.scanDone = false
		this._abortController = new AbortController()
		const signal = this._abortController.signal
		this.recoverySubscriptions = [
			this.failures.onDidChange(() => this.updateRecoveryStatus(signal)),
			this.pacers.onDidChange(() => this.updateRecoveryStatus(signal)),
		]
		this.stateManager.setSystemState("Indexing", "Initializing services...")
		this.scanPromise = this.runScan(signal).finally(() => {
			this.scanPromise = undefined
		})
		return this.scanPromise
	}

	private async runScan(signal: AbortSignal): Promise<void> {
		// Only clean up collections created by this run; existing data must survive failed retries.
		let clearIndexOnError = false

		try {
			const collectionCreated = await this.vectorStore.initialize(signal)
			clearIndexOnError = collectionCreated

			if (collectionCreated && !signal.aborted) {
				await this.cacheManager.clearCacheFile()
			}

			const hasExistingData = await this.vectorStore.hasIndexedData()
			const completed =
				hasExistingData && !collectionCreated
					? await this.scanExecutor.runIncrementalScan(signal)
					: await this.scanExecutor.runFullScan(signal)
			if (!completed || signal.aborted) return

			await this._startWatcher(signal)
			if (signal.aborted) return

			this.scanDone = true
			if (!this.scanExecutor.partial && !this.hasOutstandingWork()) {
				await this.vectorStore.markIndexingComplete()
			}
			this.updateRecoveryStatus(signal)
		} catch (error: any) {
			// A stop aborts in-flight work; that is not an indexing failure.
			if (error?.name === "AbortError" || signal.aborted) {
				console.log("[CodeIndexOrchestrator] Indexing aborted by user.")
				return
			}

			console.error("[CodeIndexOrchestrator] Error during indexing:", error)
			// Scanner/provider errors and stacks may contain local paths or other private data.
			// Keep details local; send only a fixed failure category across the telemetry boundary.
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: "Indexing failed",
				location: "startIndexing",
			})
			if (clearIndexOnError) {
				try {
					await this.vectorStore.clearCollection()
				} catch (cleanupError) {
					console.error("[CodeIndexOrchestrator] Failed to clean up after error:", cleanupError)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: "Index cleanup failed",
						location: "startIndexing.cleanup",
					})
				}
				// Indexing started but failed mid-way - clear cache to avoid cache-Qdrant mismatch
				await this.cacheManager.clearCacheFile()
			} else {
				console.log("[CodeIndexOrchestrator] Preserving existing index and cache for a retry.")
			}

			this.setState(
				signal,
				"Error",
				t("embeddings:orchestrator.failedDuringInitialScan", {
					errorMessage: error?.message || t("embeddings:orchestrator.unknownError"),
				}),
			)
			this.disposeWatcher()
		}
	}

	/**
	 * Stops the session: aborts the scan, provider waits and retry waits at once, disposes the watcher,
	 * then writes Standby. Repeated calls while stopping join the same promise.
	 */
	public stopIndexing(): Promise<void> {
		if (this.stopPromise) return this.stopPromise
		const controller = this._abortController
		if (!controller || controller.signal.aborted) {
			this.disposeWatcher()
			return Promise.resolve()
		}
		const preserveError = this.stateManager.state === "Error"
		if (!preserveError) this.stateManager.setSystemState("Stopping", t("embeddings:orchestrator.indexingStopping"))
		controller.abort()
		this.disposeWatcher()
		const scan = this.scanPromise
		this.stopPromise = (async () => {
			await scan?.catch(() => {})
			await this.cacheManager.flush()
			if (!preserveError) {
				this.stateManager.setSystemState(
					"Standby",
					t(
						this.hasOutstandingWork() || !this.scanDone
							? "embeddings:orchestrator.indexingStoppedPartial"
							: "embeddings:orchestrator.indexingStopped",
					),
				)
			}
		})().finally(() => {
			this.stopPromise = undefined
		})
		return this.stopPromise
	}

	/** Stops scan and watcher; kept for callers that only need the watcher gone. */
	public stopWatcher(): Promise<void> {
		return this.stopIndexing()
	}

	private disposeWatcher(): void {
		this.fileWatcher.dispose()
		this._fileWatcherSubscriptions.forEach((sub) => sub.dispose())
		this._fileWatcherSubscriptions = []
		this.recoverySubscriptions.forEach((sub) => sub.dispose())
		this.recoverySubscriptions = []
		this.watcherBatchPending = false
	}

	/**
	 * Clears all index data by stopping the watcher, clearing the vector store,
	 * and resetting the cache file.
	 */
	public async clearIndexData(): Promise<void> {
		await this.stopIndexing()

		try {
			if (this.configManager.isFeatureConfigured) {
				await this.vectorStore.deleteCollection()
			} else {
				console.warn("[CodeIndexOrchestrator] Service not configured, skipping vector collection clear.")
			}
		} catch (error: any) {
			console.error("[CodeIndexOrchestrator] Failed to clear vector collection:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "clearIndexData",
			})
			this.stateManager.setSystemState("Error", `Failed to clear vector collection: ${error.message}`)
		}

		await this.cacheManager.clearCacheFile()

		if (this.stateManager.state !== "Error") {
			this.stateManager.setSystemState("Standby", "Index data cleared successfully.")
		}
	}

	public get isScanning(): boolean {
		return this.scanPromise !== undefined
	}

	/**
	 * Gets the current state of the indexing system.
	 */
	public get state(): IndexingState {
		return this.stateManager.state
	}
}
