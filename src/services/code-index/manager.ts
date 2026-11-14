import * as vscode from "vscode"
import { ContextProxy } from "../../core/config/ContextProxy"
import { IndexingState } from "./interfaces/manager"
import { CodeIndexConfigManager } from "./config-manager"
import type { CodeIndexStateManager } from "./state-manager"
import { CodeIndexServiceFactory } from "./service-factory"
import { CodeIndexSearchService, type CodeIndexSearchResponse } from "./search-service"
import { CodeIndexOrchestrator } from "./orchestrator"
import { CacheManager } from "./cache-manager"
import { SembleProvider } from "./semble"
import { FileFailureRegistry } from "./file-failure-registry"
import { ProviderPacerRegistry } from "./provider-pacer"
import { formatProviderWaitMessage } from "./shared/provider-wait-message"
import { RooIgnoreController } from "../../core/ignore/RooIgnoreController"
import fs from "fs/promises"
import ignore from "ignore"
import path from "path"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName, type FailedFileSummary } from "@roo-code/types"
import { t } from "../../i18n"

export class CodeIndexManager {
	// Specialized class instances
	private _configManager: CodeIndexConfigManager | undefined
	private readonly _stateManager: CodeIndexStateManager
	private _serviceFactory: CodeIndexServiceFactory | undefined
	private _orchestrator: CodeIndexOrchestrator | undefined
	private _searchService: CodeIndexSearchService | undefined
	private _cacheManager: CacheManager | undefined
	private _sembleProvider: SembleProvider | undefined

	// One registry and pacer set per workspace: recreating services must not reset retry budgets or provider waits.
	private readonly failureRegistry = new FileFailureRegistry()
	private readonly pacers = new ProviderPacerRegistry()
	private startInFlight?: Promise<void>

	// Flag to prevent race conditions during error recovery
	private _isRecoveringFromError = false

	private readonly workspacePath: string
	private readonly _folderUri: vscode.Uri
	private readonly context: vscode.ExtensionContext

	/** @internal — construct only via {@link CodeIndexManagerRegistry} */
	public constructor(
		workspacePath: string,
		folderUri: vscode.Uri,
		context: vscode.ExtensionContext,
		stateManager: CodeIndexStateManager,
	) {
		this.workspacePath = workspacePath
		this._folderUri = folderUri
		this.context = context
		this._stateManager = stateManager
	}

	// --- Public API ---

	/**
	 * Returns the workspaceState key for per-folder indexing enablement,
	 * keyed by the real workspace folder URI so local/remote schemes cannot collide.
	 */
	private _workspaceEnabledKey(): string {
		return "codeIndexWorkspaceEnabled:" + this._folderUri.toString(true)
	}

	public get isWorkspaceEnabled(): boolean {
		const explicit = this.context.workspaceState.get<boolean | undefined>(this._workspaceEnabledKey(), undefined)
		if (explicit !== undefined) return explicit
		return this.autoEnableDefault
	}

	public async setWorkspaceEnabled(enabled: boolean): Promise<void> {
		await this.context.workspaceState.update(this._workspaceEnabledKey(), enabled)
		if (enabled) this.failureRegistry.resetAllBudgets()
	}

	public get autoEnableDefault(): boolean {
		return this.context.globalState.get("codeIndexAutoEnableDefault", true)
	}

	public async setAutoEnableDefault(enabled: boolean): Promise<void> {
		await this.context.globalState.update("codeIndexAutoEnableDefault", enabled)
	}

	public get onProgressUpdate() {
		return this._stateManager.onProgressUpdate
	}

	private assertInitialized() {
		if (this._sembleProvider) {
			// When semble is active, we don't need orchestrator/searchService
			return
		}
		if (!this._configManager || !this._orchestrator || !this._searchService || !this._cacheManager) {
			throw new Error("CodeIndexManager not initialized. Call initialize() first.")
		}
	}

	public get state(): IndexingState {
		if (!this.isFeatureEnabled) {
			return "Standby"
		}
		if (this._sembleProvider) {
			return this._sembleProvider.state
		}
		this.assertInitialized()
		return this._orchestrator!.state
	}

	public get isFeatureEnabled(): boolean {
		return this._configManager?.isFeatureEnabled ?? false
	}

	public get isFeatureConfigured(): boolean {
		return this._configManager?.isFeatureConfigured ?? false
	}

	/** Whether configuration loading has succeeded, independently of service or indexing readiness. */
	public get isConfigurationLoaded(): boolean {
		return this._configManager?.isConfigurationLoaded ?? false
	}

	public get isInitialized(): boolean {
		try {
			this.assertInitialized()
			return true
		} catch {
			return false
		}
	}

	/**
	 * Initializes the manager with configuration and dependent services.
	 * Must be called before using any other methods.
	 * @returns Object indicating if a restart is needed
	 */
	public async initialize(contextProxy: ContextProxy): Promise<{ requiresRestart: boolean }> {
		// 1. ConfigManager Initialization and Configuration Loading
		if (!this._configManager) {
			this._configManager = new CodeIndexConfigManager(contextProxy)
		}
		// Load configuration once to get current state and restart requirements
		const { requiresRestart } = await this._configManager.loadConfiguration()

		// 2. Check if feature is enabled
		if (!this.isFeatureEnabled) {
			if (this._orchestrator) {
				await this._orchestrator.stopIndexing()
			}
			if (this._sembleProvider) {
				this._sembleProvider.stopIndexing()
			}
			return { requiresRestart }
		}

		// 3. Check if workspace is available
		const workspacePath = this.workspacePath
		if (!workspacePath) {
			this._stateManager.setSystemState("Standby", "No workspace folder open")
			return { requiresRestart }
		}

		// 4. Check workspace-level enablement (before creating expensive services)
		if (!this.isWorkspaceEnabled) {
			this._stateManager.setSystemState("Standby", "Indexing not enabled for this workspace")
			return { requiresRestart }
		}

		// 5. CacheManager Initialization; an unreadable cache ends here so existing index data is kept.
		if (!(await this.ensureCacheManager())) return { requiresRestart }

		// 6. Determine if Core Services Need Recreation
		const needsServiceRecreation = (!this._serviceFactory && !this._sembleProvider) || requiresRestart

		if (needsServiceRecreation) {
			await this._recreateServices()
		}

		// 7. Handle Indexing Start/Restart
		if (this._sembleProvider) {
			// For semble, start indexing if needed
			const shouldStartIndexing = requiresRestart || needsServiceRecreation
			if (shouldStartIndexing) {
				await this._sembleProvider.startIndexing()
			}
		} else {
			const shouldStartOrRestartIndexing =
				requiresRestart ||
				(needsServiceRecreation && (!this._orchestrator || this._orchestrator.state !== "Indexing"))

			if (shouldStartOrRestartIndexing) {
				this.startIndexingInBackground()
			}
		}

		return { requiresRestart }
	}

	/** Returns false when the cache could not be read; status is then Error and Start Indexing retries. */
	private async ensureCacheManager(): Promise<boolean> {
		if (this._cacheManager) return true
		const cacheManager = new CacheManager(this.context, this.workspacePath)
		try {
			await cacheManager.initialize()
		} catch (error) {
			console.error("[CodeIndexManager] Failed to read the index cache:", error)
			this._stateManager.setSystemState(
				"Error",
				error instanceof Error ? error.message : t("embeddings:orchestrator.cacheReadFailed"),
			)
			return false
		}
		this._cacheManager = cacheManager
		return true
	}

	private startIndexingInBackground(): void {
		// Initialization awaits the cache read; indexing may have been disabled meanwhile.
		if (!this.isFeatureEnabled || !this.isWorkspaceEnabled) return
		void this.startOrchestrator().catch((error) => {
			console.error("[CodeIndexManager] Background indexing failed:", error)
		})
	}

	private startOrchestrator(): Promise<void> {
		if (this.startInFlight) return this.startInFlight
		const orchestrator = this._orchestrator
		if (!orchestrator) return Promise.resolve()
		this.startInFlight = orchestrator.startIndexing().finally(() => {
			this.startInFlight = undefined
		})
		return this.startInFlight
	}

	/**
	 * Initiates the indexing process (initial scan and starts watcher).
	 * Automatically recovers from error state if needed before starting.
	 * A repeated call while a start or scan is running returns that start's promise (R13).
	 */
	public async startIndexing(): Promise<void> {
		if (!this.isFeatureEnabled || !this.isWorkspaceEnabled) {
			return
		}

		// Delegate to semble provider if active
		if (this._sembleProvider) {
			await this._sembleProvider.startIndexing()
			return
		}

		if (this.startInFlight) return this.startInFlight
		this.failureRegistry.resetAllBudgets()

		// Check if we're in error state and recover if needed
		const currentStatus = this.getCurrentStatus()
		if (currentStatus.systemStatus === "Error") {
			await this.recoverFromError()

			// After recovery, we need to reinitialize since recoverFromError clears all services
			// This will be handled by the caller (webviewMessageHandler) checking isInitialized
			return
		}

		this.assertInitialized()
		await this.startOrchestrator()
	}

	/**
	 * Stops any in-progress indexing operation and the file watcher.
	 * Repeated calls while stopping return the same promise.
	 */
	public stopIndexing(): Promise<void> {
		if (this._sembleProvider) {
			this._sembleProvider.stopIndexing()
			return Promise.resolve()
		}
		return this._orchestrator?.stopIndexing() ?? Promise.resolve()
	}

	/**
	 * Stops the file watcher and potentially cleans up resources.
	 */
	public stopWatcher(): Promise<void> {
		if (!this.isFeatureEnabled) {
			return Promise.resolve()
		}
		return this._orchestrator?.stopWatcher() ?? Promise.resolve()
	}

	/**
	 * Recovers from error state by stopping the current scan and watcher, clearing the error and
	 * dropping service instances so the next initialize() recreates them.
	 *
	 * @remarks
	 * - Safe to call even when not in error state (idempotent)
	 * - Does not restart indexing automatically - call initialize() after recovery
	 * - Prevents race conditions from multiple concurrent recovery attempts
	 */
	public async recoverFromError(): Promise<void> {
		// Prevent race conditions from multiple rapid recovery attempts
		if (this._isRecoveringFromError) {
			return
		}

		this._isRecoveringFromError = true
		try {
			// The old scan and watcher must stop before replacement work starts (R37).
			await this._orchestrator?.stopIndexing()
			this._stateManager.setSystemState("Standby", "")
		} catch (error) {
			// Log error but continue with recovery - clearing service instances is more important
			console.error("Failed to clear error state during recovery:", error)
		} finally {
			// Force re-initialization by clearing service instances
			// This ensures a clean slate even if state update failed
			this._configManager = undefined
			this._serviceFactory = undefined
			this._orchestrator = undefined
			this._searchService = undefined
			this._sembleProvider = undefined
			this._cacheManager = undefined

			// Reset the flag after recovery is complete
			this._isRecoveringFromError = false
		}
	}

	/**
	 * Cleans up the manager instance.
	 */
	public dispose(): void {
		void this.stopIndexing()
		if (this._sembleProvider) {
			this._sembleProvider.dispose()
			this._sembleProvider = undefined
		}
		this._stateManager.dispose()
	}

	/**
	 * Clears all index data by stopping the watcher, clearing the Qdrant collection,
	 * and deleting the cache file.
	 */
	public async clearIndexData(): Promise<void> {
		if (!this.isFeatureEnabled) {
			return
		}
		if (this._sembleProvider) {
			await this._sembleProvider.clearIndexData()
			return
		}
		this.assertInitialized()
		await this._orchestrator!.clearIndexData()
		await this._cacheManager!.clearCacheFile()
	}

	// --- Private Helpers ---

	/**
	 * Status precedence: Error > Stopping > active indexing or provider wait > idle partial (Standby with
	 * failures) > Indexed > Standby.
	 */
	public getCurrentStatus() {
		const status = this._stateManager.getCurrentStatus()
		const failedFiles = this.failureRegistry.list().map((failure) => ({
			path: failure.path,
			activity: failure.activity,
			reason: failure.reason,
			state: failure.state,
		}))
		const representative = failedFiles.find((failure) => failure.state === "retrying") ?? failedFiles.at(0)
		const failedFileSummary: FailedFileSummary | undefined = representative && {
			...representative,
			count: failedFiles.length,
		}
		const providerWaits = this.pacers.providerWaits()
		let systemStatus: IndexingState = status.systemStatus
		let message = status.message
		if (systemStatus !== "Error" && systemStatus !== "Stopping") {
			if (this.pacers.hasWaitingRequests()) {
				systemStatus = "Indexing"
				message = formatProviderWaitMessage(providerWaits)
			} else if (this._orchestrator?.isScanning) {
				systemStatus = "Indexing"
			} else if (systemStatus !== "Indexing" && failedFiles.length > 0) {
				systemStatus = "Standby"
				message = t("embeddings:orchestrator.indexingFilesFailed")
			}
		}
		return {
			...status,
			systemStatus,
			message,
			failedFiles,
			failedFileSummary,
			providerWaits,
			workspacePath: this.workspacePath,
			workspaceEnabled: this.isWorkspaceEnabled,
			autoEnableDefault: this.autoEnableDefault,
		}
	}

	public async searchIndex(query: string, directoryPrefix?: string): Promise<CodeIndexSearchResponse> {
		const empty: CodeIndexSearchResponse = { results: [], incomplete: false, failedPaths: [], waitingPaths: [] }
		if (!this.isFeatureEnabled) {
			return empty
		}
		if (this._sembleProvider) {
			return { ...empty, results: await this._sembleProvider.searchIndex(query, directoryPrefix) }
		}
		this.assertInitialized()
		return this._searchService!.searchIndex(query, directoryPrefix)
	}

	/**
	 * Private helper method to recreate services with current configuration.
	 * Used by both initialize() and handleSettingsChange().
	 */
	private async _recreateServices(): Promise<void> {
		// The old scan and watcher must stop before replacement services start (R37).
		if (this._orchestrator) {
			await this._orchestrator.stopIndexing()
		}
		// Dispose existing semble provider if switching away
		if (this._sembleProvider) {
			this._sembleProvider.dispose()
			this._sembleProvider = undefined
		}
		// Clear existing services to ensure clean state
		this._orchestrator = undefined
		this._searchService = undefined

		// Branch: if provider is "semble", create SembleProvider instead of external services
		if (this._configManager!.currentEmbedderProvider === "semble") {
			this._sembleProvider = new SembleProvider(this.workspacePath, this.context, this._stateManager)
			await this._sembleProvider.initialize()
			return
		}

		// (Re)Initialize service factory for external providers
		this._serviceFactory = new CodeIndexServiceFactory(
			this._configManager!,
			this.workspacePath,
			this._cacheManager!,
			this.failureRegistry,
			this.pacers,
		)

		const ignoreInstance = ignore()
		const workspacePath = this.workspacePath

		if (!workspacePath) {
			this._stateManager.setSystemState("Standby", "")
			return
		}

		// Create .gitignore instance
		const ignorePath = path.join(workspacePath, ".gitignore")
		try {
			const content = await fs.readFile(ignorePath, "utf8")
			ignoreInstance.add(content)
			ignoreInstance.add(".gitignore")
		} catch (error) {
			// Should never happen: reading file failed even though it exists
			console.error("Unexpected error loading .gitignore:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "_recreateServices",
			})
		}

		// Create RooIgnoreController instance
		const rooIgnoreController = new RooIgnoreController(workspacePath)
		await rooIgnoreController.initialize()

		// (Re)Create shared service instances
		const { embedder, vectorStore, scanner, fileWatcher } = this._serviceFactory.createServices(
			this.context,
			this._cacheManager!,
			ignoreInstance,
			rooIgnoreController,
		)

		// (Re)Initialize orchestrator
		this._orchestrator = new CodeIndexOrchestrator(
			this._configManager!,
			this._stateManager,
			this.workspacePath,
			this._cacheManager!,
			vectorStore,
			scanner,
			fileWatcher,
			this.failureRegistry,
			this.pacers,
		)

		// (Re)Initialize search service
		this._searchService = new CodeIndexSearchService(
			this._configManager!,
			this._stateManager,
			embedder,
			vectorStore,
			this.failureRegistry,
			this.pacers,
		)

		// Clear any error state after successful recreation
		this._stateManager.setSystemState("Standby", "")
	}

	/**
	 * Handle code index settings changes.
	 * This method should be called when code index settings are updated
	 * to ensure the CodeIndexConfigManager picks up the new configuration.
	 * If the configuration changes require a restart, the service will be restarted.
	 */
	public async handleSettingsChange(): Promise<void> {
		if (this._configManager) {
			const { requiresRestart } = await this._configManager.loadConfiguration()

			const isFeatureEnabled = this.isFeatureEnabled
			const isFeatureConfigured = this.isFeatureConfigured

			// If feature is disabled, stop the service (including any active scan)
			if (!isFeatureEnabled) {
				await this.stopIndexing()
				this._stateManager.setSystemState("Standby", "Code indexing is disabled")
				return
			}

			if (requiresRestart && isFeatureEnabled && isFeatureConfigured) {
				try {
					// Ensure cacheManager is initialized before recreating services
					if (!(await this.ensureCacheManager())) return

					// Recreate services with new configuration
					await this._recreateServices()
				} catch (error) {
					console.error("Failed to recreate services:", error)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
						location: "handleSettingsChange",
					})
					// Replacement failures leave indexing restartable from Error.
					this._stateManager.setSystemState(
						"Error",
						error instanceof Error ? error.message : t("embeddings:orchestrator.unknownError"),
					)
					// Re-throw the error so the caller knows validation failed
					throw error
				}
			}
		}
	}
}
