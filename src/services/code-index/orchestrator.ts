import * as vscode from "vscode"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager, IndexingState } from "./state-manager"
import { IFileWatcher, IVectorStore } from "./interfaces"
import { DirectoryScanner } from "./processors"
import { CacheManager } from "./cache-manager"
import { CodeIndexScanExecutor } from "./code-index-scan-executor"
import { CodeIndexRun, CodeIndexRunState, CodeIndexScanMode } from "./code-index-run"
import { StateHolder } from "../../utils/StateHolder"
import { CodeIndexWatcherSession } from "./code-index-watcher-session"
import { CodeIndexRecovery } from "./code-index-recovery"
import { t } from "../../i18n"

/**
 * Manages the code indexing workflow, coordinating between different services and managers.
 */
export class CodeIndexOrchestrator {
	private readonly codeIndexWatcherSession: CodeIndexWatcherSession
	private readonly codeIndexRecovery: CodeIndexRecovery
	private _activeRun: CodeIndexRun | undefined
	private _isClearing = false
	private readonly codeIndexScanExecutor: CodeIndexScanExecutor

	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		workspacePath: string,
		private readonly cacheManager: CacheManager,
		private readonly vectorStore: IVectorStore,
		scanner: DirectoryScanner,
		fileWatcher: IFileWatcher,
	) {
		this.codeIndexScanExecutor = new CodeIndexScanExecutor(workspacePath, scanner, vectorStore, stateManager)
		this.codeIndexWatcherSession = new CodeIndexWatcherSession(fileWatcher, stateManager)
		this.codeIndexRecovery = new CodeIndexRecovery(
			cacheManager,
			vectorStore,
			stateManager,
			this.codeIndexWatcherSession,
		)
	}

	/**
	 * Gets the current state of the indexing system.
	 */
	public get state(): IndexingState {
		return this.stateManager.state
	}

	/** Runs a scan and starts watching files, retaining ownership until cleanup finishes. */
	public async startIndexing(): Promise<void> {
		if (!this._canStartIndexing()) return

		const run = new CodeIndexRun(new AbortController(), new StateHolder<CodeIndexRunState>("running"))
		this._activeRun = run

		try {
			this.stateManager.setSystemState("Indexing", "Initializing services...")
			const scanMode = await this._prepareScan(run)
			await this._runScan(run, scanMode)
			await this._completeIndexing(run.signal)
		} catch (error) {
			await this.codeIndexRecovery.handle(error, run)
		} finally {
			this._activeRun = undefined
			run.finish()
		}
	}

	/**
	 * Checks start preconditions and reports why a request was rejected.
	 */
	private _canStartIndexing(): boolean {
		if (this._isClearing) {
			return false
		}

		// Rejected requests must not overwrite the active run's status.
		if (this._activeRun) {
			console.warn("[CodeIndexOrchestrator] Start rejected: An indexing run is still active.")
			return false
		}

		if (!vscode.workspace.workspaceFolders?.length) {
			this.stateManager.setSystemState("Error", t("embeddings:orchestrator.indexingRequiresWorkspace"))
			console.warn("[CodeIndexOrchestrator] Start rejected: No workspace folder open.")
			return false
		}

		if (!this.configManager.isFeatureConfigured) {
			this.stateManager.setSystemState("Standby", "Missing configuration. Save your settings to start indexing.")
			console.warn("[CodeIndexOrchestrator] Start rejected: Missing configuration.")
			return false
		}

		if (!["Standby", "Error", "Indexed"].includes(this.stateManager.state)) {
			console.warn(
				`[CodeIndexOrchestrator] Start rejected: Already processing or in state ${this.stateManager.state}.`,
			)
			return false
		}

		return true
	}

	private async _prepareScan(run: CodeIndexRun): Promise<CodeIndexScanMode> {
		const collectionCreated = await this.vectorStore.initialize()
		// Read actual contents, not completion metadata, before granting cleanup ownership.
		// Query even a recreated collection; a failed read must never authorize cleanup.
		run.preexistingCodePoints = await this.vectorStore.hasCodePoints()
		if (collectionCreated) {
			await this.cacheManager.clearCacheFile()
		}

		// Existing data can be updated incrementally using the cache.
		const hasExistingData = await this.vectorStore.hasIndexedData()
		return hasExistingData && !collectionCreated ? "incremental" : "full"
	}

	private async _runScan(run: CodeIndexRun, mode: CodeIndexScanMode): Promise<void> {
		run.markScanStarted(mode)
		if (mode === "incremental") {
			await this.codeIndexScanExecutor.runIncrementalScan(run.signal)
		} else {
			await this.codeIndexScanExecutor.runFullScan(run.signal)
		}
	}

	private async _completeIndexing(signal: AbortSignal): Promise<void> {
		await this._startWatcher(signal)
		signal.throwIfAborted()
		await this.vectorStore.markIndexingComplete()
		if (signal.aborted) {
			await this.vectorStore.markIndexingIncomplete()
		}
		signal.throwIfAborted()

		this.stateManager.setSystemState("Indexed", t("embeddings:orchestrator.fileWatcherStarted"))
	}

	/**
	 * Starts the file watcher if not already running.
	 */
	private async _startWatcher(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted()
		if (!this.configManager.isFeatureConfigured) {
			throw new Error("Cannot start watcher: Service not configured.")
		}
		if (this.codeIndexWatcherSession.isRunning) return

		this.stateManager.setSystemState("Indexing", "Initializing file watcher...")
		await this.codeIndexWatcherSession.start(signal)
	}

	/**
	 * Clears all index data by stopping indexing, clearing the vector store,
	 * and resetting the cache file.
	 */
	public async clearIndexData(): Promise<void> {
		if (this._isClearing) {
			return
		}
		this._isClearing = true

		try {
			await this._stopAndAwaitIndexing()
			await this._deleteIndexData()
			this.stateManager.setSystemState("Standby", "Index data cleared successfully.")
		} catch (error) {
			this.codeIndexRecovery.handleClearError(error)
		} finally {
			this._isClearing = false
		}
	}

	private async _stopAndAwaitIndexing(): Promise<void> {
		const run = this._activeRun
		this._requestIndexingCancellation(run)
		this.codeIndexWatcherSession.stop()
		await run?.waitUntilFinished()
	}

	private async _deleteIndexData(): Promise<void> {
		if (this.configManager.isFeatureConfigured) {
			await this.vectorStore.deleteCollection()
		} else {
			console.warn("[CodeIndexOrchestrator] Service not configured, skipping vector collection clear.")
		}

		await this.cacheManager.clearCacheFile()
	}

	/**
	 * Stops any in-progress indexing by aborting the scan and stopping the file watcher.
	 */
	public stopIndexing(): void {
		this._requestIndexingCancellation(this._activeRun)
		this.stopWatcher()
	}

	private _requestIndexingCancellation(run: CodeIndexRun | undefined): void {
		if (!run || run.signal.aborted) return
		this.stateManager.setSystemState("Stopping", t("embeddings:orchestrator.indexingStoppedPartial"))
		run.cancel()
	}

	/**
	 * Stops the file watcher and cleans up resources.
	 */
	public stopWatcher(): void {
		this.codeIndexWatcherSession.stop()

		if (!["Error", "Stopping"].includes(this.stateManager.state)) {
			this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.fileWatcherStopped"))
		}
	}
}
