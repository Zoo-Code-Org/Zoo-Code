import type { Disposable } from "vscode"
import * as path from "path"
import type { CodeIndexStateManager } from "./state-manager"
import type { IFileWatcher, BatchProcessingSummary } from "./interfaces"

/** Owns file watching, subscriptions and batch progress reporting. */
export class CodeIndexWatcherSession {
	private subscriptions: Disposable[] = []
	private phase: "stopped" | "starting" | "running" = "stopped"
	private generation = 0

	constructor(
		private readonly fileWatcher: IFileWatcher,
		private readonly stateManager: Pick<
			CodeIndexStateManager,
			"state" | "setSystemState" | "reportFileQueueProgress"
		>,
	) {}

	get isRunning(): boolean {
		return this.phase === "running"
	}

	async start(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted()
		if (this.isRunning) return
		if (this.phase === "starting") throw new Error("File watcher startup is already in progress.")
		const generation = this.generation
		this.phase = "starting"
		try {
			await this.fileWatcher.initialize()
			signal.throwIfAborted()
			if (generation !== this.generation) {
				throw new DOMException("File watcher startup was stopped.", "AbortError")
			}
			this.subscriptions.push(
				this.fileWatcher.onBatchProgressUpdate((progress) => this.handleBatchProgress(progress)),
			)
			this.subscriptions.push(
				this.fileWatcher.onDidFinishBatchProcessing((summary) => this.handleBatchFinished(summary)),
			)
			this.phase = "running"
		} catch (error) {
			this.releaseResources()
			this.phase = "stopped"
			throw error
		}
	}

	private handleBatchProgress({
		processedInBatch,
		totalInBatch,
		currentFile,
	}: {
		processedInBatch: number
		totalInBatch: number
		currentFile?: string
	}): void {
		// Reporting terminal progress would reset the batch's final state to Indexing.
		if (processedInBatch >= totalInBatch) return
		if (this.stateManager.state !== "Indexing") {
			this.stateManager.setSystemState("Indexing", "Processing file changes...")
		}
		this.stateManager.reportFileQueueProgress(
			processedInBatch,
			totalInBatch,
			currentFile ? path.basename(currentFile) : undefined,
		)
	}

	private handleBatchFinished(summary: BatchProcessingSummary): void {
		if (summary.batchError) {
			console.error("[CodeIndexWatcherSession] Batch processing failed:", summary.batchError)
			this.stateManager.setSystemState("Error", summary.batchError.message)
			return
		}
		const failedFile = summary.processedFiles.find(
			(file) => file.status === "error" || file.status === "local_error",
		)
		if (failedFile) {
			this.stateManager.setSystemState(
				"Error",
				failedFile.error?.message ?? `Failed to index file: ${failedFile.path}`,
			)
			return
		}
		this.stateManager.setSystemState("Indexed", "File changes processed. Index up-to-date.")
	}

	stop(): void {
		this.generation++
		// Keep startup exclusive until its await settles, even after a stop request.
		if (this.phase !== "starting") this.phase = "stopped"
		this.releaseResources()
	}

	private releaseResources(): void {
		const resources = [...this.subscriptions, this.fileWatcher]
		this.subscriptions = []
		for (const resource of resources) {
			try {
				resource.dispose()
			} catch (error) {
				// Cleanup must attempt every resource and preserve the original startup error.
				console.error("[CodeIndexWatcherSession] Failed to dispose watcher resource:", error)
			}
		}
	}
}
