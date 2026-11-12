import * as vscode from "vscode"
import { ContextProxy } from "../../core/config/ContextProxy"
import type { IndexingState } from "./interfaces/manager"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager } from "./state-manager"
import { CodeIndexServiceFactory } from "./service-factory"
import { CodeIndexSearchService, type CodeIndexSearchResponse } from "./search-service"
import { CodeIndexOrchestrator } from "./orchestrator"
import { CacheManager } from "./cache-manager"
import { SembleProvider } from "./semble"
import { RooIgnoreController } from "../../core/ignore/RooIgnoreController"
import fs from "fs/promises"
import ignore from "ignore"
import path from "path"
import { t } from "../../i18n"
import { IndexWriteGate } from "./index-write-gate"
import { GenerationAllocator } from "./generation-allocator"
import { FileFailureRegistry, type FailedFile } from "./file-failure-registry"
import { ParseWorkerClient } from "./parse-worker-client"
import { codeIndexLog } from "./code-index-log"
import { initializeCodeIndexHostLogging } from "./code-index-log-host"
import { ProviderPacerRegistry } from "./provider-pacer"
import { classifyIndexingError } from "./shared/indexing-errors"
import { formatProviderWaitMessage } from "./shared/provider-wait-message"
type FailedFileStatus = Pick<FailedFile, "path" | "activity" | "reason" | "state">
type FailedFileSummary = FailedFileStatus & { count: number }

export class CodeIndexManager {
	private static readonly diagnosticOwners = new Set<CodeIndexManager>()
	private _configManager?: CodeIndexConfigManager
	private _serviceFactory?: CodeIndexServiceFactory
	private _orchestrator?: CodeIndexOrchestrator
	private _searchService?: CodeIndexSearchService
	private _cacheManager?: CacheManager
	private cacheInitialization?: Promise<void>
	private _sembleProvider?: SembleProvider
	private sembleState?: CodeIndexStateManager
	private sembleSubscription?: vscode.Disposable
	private parser?: ParseWorkerClient
	private _isRecoveringFromError = false
	private parserFailed = false
	private parserFailureMessage = ""
	private servicesStopped = false
	private disabledSinceFailure = false
	private readonly writeGate = new IndexWriteGate()
	private generationAllocator?: GenerationAllocator
	private currentAttempt = 0
	private readonly idleStop = Promise.resolve()
	private clearing: Promise<void> = Promise.resolve()
	private startInFlight?: Promise<void>
	private servicesRestartPending = false
	private startupFailureMessage?: string
	private startupEpoch = 0
	public readonly fileFailureRegistry = new FileFailureRegistry()
	public readonly providerPacerRegistry = new ProviderPacerRegistry()
	private readonly progressEmitter = new vscode.EventEmitter<ReturnType<CodeIndexManager["getCurrentStatus"]>>()
	private readonly statusSubscriptions: vscode.Disposable[] = []

	/** @internal — construct only via CodeIndexManagerRegistry. */
	public constructor(
		private readonly workspacePath: string,
		private readonly _folderUri: vscode.Uri,
		private readonly context: vscode.ExtensionContext,
		private readonly _stateManager: CodeIndexStateManager,
	) {
		initializeCodeIndexHostLogging()
		CodeIndexManager.diagnosticOwners.add(this)
		this.configureDiagnostics()
		this.statusSubscriptions.push(
			this._stateManager.onProgressUpdate(() => this.progressEmitter.fire(this.getCurrentStatus())),
			this.fileFailureRegistry.onDidChange(() => this.progressEmitter.fire(this.getCurrentStatus())),
			this.providerPacerRegistry.onDidChange(() => this.progressEmitter.fire(this.getCurrentStatus())),
		)
	}

	private _workspaceEnabledKey(): string {
		return "codeIndexWorkspaceEnabled:" + this._folderUri.toString(true)
	}

	public get isWorkspaceEnabled(): boolean {
		return (
			this.context.workspaceState.get<boolean | undefined>(this._workspaceEnabledKey(), undefined) ??
			this.autoEnableDefault
		)
	}

	public async setWorkspaceEnabled(enabled: boolean): Promise<void> {
		const wasEnabled = this.isWorkspaceEnabled
		await this.context.workspaceState.update(this._workspaceEnabledKey(), enabled)
		if (!enabled) {
			this.disabledSinceFailure = true
			void this.stopWatcher()
		} else if (!wasEnabled) {
			this.renewAfterDisable()
		}
		this.progressEmitter.fire(this.getCurrentStatus())
	}

	public get autoEnableDefault(): boolean {
		return this.context.globalState.get("codeIndexAutoEnableDefault", true)
	}

	public async setAutoEnableDefault(enabled: boolean): Promise<void> {
		await this.context.globalState.update("codeIndexAutoEnableDefault", enabled)
	}

	public get onProgressUpdate() {
		return this.progressEmitter.event
	}

	private assertInitialized(): void {
		if (this._sembleProvider) return
		if (!this._configManager || !this._orchestrator || !this._searchService || !this._cacheManager) {
			throw new Error("CodeIndexManager not initialized. Call initialize() first.")
		}
	}

	public get state(): IndexingState {
		return this.getCurrentStatus().systemStatus
	}

	public get isFeatureEnabled(): boolean {
		return this._configManager?.isFeatureEnabled ?? false
	}

	public get isFeatureConfigured(): boolean {
		return this._configManager?.isFeatureConfigured ?? false
	}

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

	private renewAfterDisable(): void {
		this.parserFailed = false
		this.startupFailureMessage = undefined
		this.disabledSinceFailure = false
		this.fileFailureRegistry.resetAllBudgets()
	}

	private async initializeCache(): Promise<void> {
		if (!this.cacheInitialization) {
			const cache = (this._cacheManager ??= new CacheManager(this.context, this.workspacePath))
			this.cacheInitialization = cache
				.initialize()
				.then(() => {
					this.writeGate.recover(Object.keys(cache.getOpenFiles()), cache.loadedAt)
					this.generationAllocator = new GenerationAllocator(cache)
				})
				.catch((error: unknown) => {
					this.cacheInitialization = undefined
					throw error
				})
		}
		await this.cacheInitialization
	}

	public async initialize(contextProxy: ContextProxy, autoStart = true): Promise<{ requiresRestart: boolean }> {
		const epoch = this.startupEpoch
		const configuration = (this._configManager ??= new CodeIndexConfigManager(contextProxy))
		const { requiresRestart } = await configuration.loadConfiguration()
		if (configuration !== this._configManager || epoch !== this.startupEpoch) return { requiresRestart }
		this.configureDiagnostics()
		if (!this.isFeatureEnabled || !this.isWorkspaceEnabled) {
			this.disabledSinceFailure = true
			void this.stopWatcher()
			return { requiresRestart }
		}
		if (!this.workspacePath) {
			this._stateManager.setSystemState("Standby", "No workspace folder open")
			return { requiresRestart }
		}
		if (this.disabledSinceFailure) this.renewAfterDisable()
		if (autoStart && (this.parserFailed || this.startupFailureMessage)) return { requiresRestart }
		if (!autoStart) {
			await this.initializeCache()
			return { requiresRestart }
		}
		if (this.startInFlight) {
			this.servicesRestartPending ||= requiresRestart
			await this.startInFlight
		} else if ((!this._serviceFactory && !this._sembleProvider) || requiresRestart || this.servicesStopped) {
			await this.runStartup(async (startupEpoch) => {
				await this.initializeCache()
				if (startupEpoch === this.startupEpoch) await this._recreateServices()
			})
		}
		return { requiresRestart }
	}

	/** Resolves after startup, not after the background scan. */
	public startIndexing(contextProxy?: ContextProxy): Promise<void> {
		if (this.startInFlight) return this.startInFlight
		if (this._sembleProvider) {
			return this.runStartup(async (epoch) => {
				await this.clearing
				if (epoch !== this.startupEpoch || !this.isFeatureEnabled || !this.isWorkspaceEnabled) return
				this.startupFailureMessage = undefined
				this.servicesStopped = false
				this.subscribeSembleState()
			})
		}
		if (
			this.isFeatureEnabled &&
			this.isWorkspaceEnabled &&
			this._orchestrator?.isScanning &&
			!this._orchestrator.stopped
		) {
			return this._orchestrator.startupResult
		}
		return this.runStartup(async (epoch) => {
			if (contextProxy) await this.initialize(contextProxy, false)
			if (epoch !== this.startupEpoch || !this.isFeatureEnabled || !this.isWorkspaceEnabled) return
			this.parserFailed = false
			this.startupFailureMessage = undefined
			await this.initializeCache()
			if (epoch !== this.startupEpoch) return
			await this._recreateServices()
			if (epoch !== this.startupEpoch) return
			this.fileFailureRegistry.resetAllBudgets()
			this.assertInitialized()
		})
	}

	private runStartup(operation: (epoch: number) => Promise<void>): Promise<void> {
		if (this.startInFlight) return this.startInFlight
		const epoch = this.startupEpoch
		const startup = Promise.resolve().then(async () => {
			try {
				if (epoch !== this.startupEpoch) return
				await operation(epoch)
				while (
					epoch === this.startupEpoch &&
					!this.parserFailed &&
					this.isFeatureEnabled &&
					this.isWorkspaceEnabled
				) {
					if (this.servicesRestartPending) {
						this.servicesRestartPending = false
						await this._recreateServices()
						continue
					}
					await this.startIndexingInBackground()
					if (!this.servicesRestartPending) break
				}
			} catch (error) {
				if (epoch !== this.startupEpoch) return
				this.startupFailureMessage = codeIndexLog.redact(error instanceof Error ? error.message : String(error))
				this._stateManager.setSystemState("Error", this.startupFailureMessage)
				codeIndexLog.error("Indexing startup failed", { error, attempt: this.currentAttempt })
				throw error
			}
		})
		this.startInFlight = startup.finally(() => {
			this.startInFlight = undefined
			this.servicesRestartPending = false
		})
		return this.startInFlight
	}

	private async startIndexingInBackground(): Promise<void> {
		if (this.servicesStopped || !this.isFeatureEnabled || !this.isWorkspaceEnabled) return
		if (this._sembleProvider) {
			await this._sembleProvider.startIndexing()
			return
		}
		const orchestrator = this._orchestrator
		if (!orchestrator) return
		const attempt = this.currentAttempt
		void orchestrator.startIndexing().catch((error: unknown) => {
			if (attempt !== this.currentAttempt || orchestrator.stopped) return
			codeIndexLog.error("Background scan failed", { error, attempt })
		})
		await orchestrator.startupResult
	}

	public stopIndexing(): Promise<void> {
		this.startupEpoch++
		this.servicesStopped = true
		this._sembleProvider?.stopIndexing()
		this.parser?.stop()
		if (this._orchestrator) return this._orchestrator.stopIndexing()
		this.currentAttempt++
		return this.idleStop
	}

	public stopWatcher(): Promise<void> {
		this.startupEpoch++
		this.servicesStopped = true
		this._sembleProvider?.stopIndexing()
		this.parser?.stop()
		if (this._orchestrator) return this._orchestrator.stopWatcher()
		this.currentAttempt++
		return this.idleStop
	}

	/** Drops services without clearing the fatal-parser latch or retained workspace data. */
	public async recoverFromError(): Promise<void> {
		if (this._isRecoveringFromError) return
		this._isRecoveringFromError = true
		try {
			void this.stopWatcher()
			this.currentAttempt++
			this._stateManager.setSystemState("Standby", "")
		} catch (error) {
			codeIndexLog.error("Failed to clear error state during recovery", { error })
		} finally {
			this._configManager = undefined
			this._serviceFactory = undefined
			this._orchestrator = undefined
			this._searchService = undefined
			this.disposeSemble()
			this._isRecoveringFromError = false
		}
	}

	private subscribeSembleState(): void {
		this.sembleSubscription?.dispose()
		const state = this.sembleState
		const epoch = this.startupEpoch
		const attempt = this.currentAttempt
		this.sembleSubscription = state?.onProgressUpdate(() => {
			if (epoch !== this.startupEpoch || attempt !== this.currentAttempt) return
			const status = state.getCurrentStatus()
			this._stateManager.setSystemState(status.systemStatus, status.message)
		})
	}

	private disposeSemble(): void {
		this.sembleSubscription?.dispose()
		this.sembleSubscription = undefined
		this._sembleProvider?.dispose()
		this._sembleProvider = undefined
		this.sembleState?.dispose()
		this.sembleState = undefined
	}

	public dispose(): void {
		void this.stopWatcher()
		this.currentAttempt++
		this.disposeSemble()
		this.statusSubscriptions.forEach((subscription) => subscription.dispose())
		this.progressEmitter.dispose()
		this._stateManager.dispose()
		CodeIndexManager.diagnosticOwners.delete(this)
	}

	public async clearIndexData(): Promise<void> {
		if (!this.isFeatureEnabled) return
		this.assertInitialized()
		this.startupEpoch++
		this.servicesStopped = true
		const clearing = this._sembleProvider
			? this._sembleProvider.clearIndexData()
			: this._orchestrator!.clearIndexData()
		this.clearing = clearing.catch(() => {})
		await clearing
	}

	public getCurrentStatus() {
		const status = this._stateManager.getCurrentStatus()
		const stopped =
			this.servicesStopped || !!this._orchestrator?.stopped || !this.isWorkspaceEnabled || !this.isFeatureEnabled
		const failedFiles: FailedFileStatus[] = this.fileFailureRegistry.list().map((failure) => ({
			path: codeIndexLog.redact(
				path.isAbsolute(failure.path) ? path.relative(this.workspacePath, failure.path) : failure.path,
			),
			activity: failure.activity,
			reason: codeIndexLog.redact(failure.reason),
			state: stopped ? "exhausted" : failure.state,
		}))
		const representative = failedFiles.find((failure) => failure.state === "retrying") ?? failedFiles[0]
		const failedFileSummary: FailedFileSummary | undefined = representative
			? { ...representative, count: failedFiles.length }
			: undefined
		const providerWaits = this.providerPacerRegistry.providerWaits().map((wait) => ({
			...wait,
			waitingFiles: wait.waitingFiles.map((file) =>
				codeIndexLog.redact(path.isAbsolute(file) ? path.relative(this.workspacePath, file) : file),
			),
		}))
		const waiting = !stopped && this.providerPacerRegistry.hasWaitingRequests()
		let systemStatus: IndexingState = status.systemStatus
		let message = status.message
		if (this.parserFailed || this.startupFailureMessage) {
			systemStatus = "Error"
			message = this.parserFailed ? this.parserFailureMessage : this.startupFailureMessage!
		} else if (systemStatus !== "Error" && systemStatus !== "Stopping") {
			const retrying = failedFiles.some((failure) => failure.state === "retrying")
			if (stopped) {
				systemStatus = "Standby"
			} else if (waiting) {
				systemStatus = "Indexing"
				message = formatProviderWaitMessage(providerWaits)
			} else if (this._orchestrator?.isScanning || retrying || systemStatus === "Indexing") {
				systemStatus = "Indexing"
				if (retrying) message = t("embeddings:orchestrator.indexingFilesRetrying")
			} else if (this._orchestrator?.isNaturallySettledPartial) {
				systemStatus = "Standby"
				message = t("embeddings:orchestrator.indexingFilesFailed")
			} else if (systemStatus !== "Indexed") {
				systemStatus = "Standby"
			}
		}
		return {
			...status,
			systemStatus,
			message: codeIndexLog.redact(message),
			failedFiles,
			failedFileSummary,
			providerWaits,
			workspacePath: this.workspacePath,
			workspaceEnabled: this.isWorkspaceEnabled,
			autoEnableDefault: this.autoEnableDefault,
		}
	}

	public async searchIndex(
		query: string,
		directoryPrefix?: string,
		signal?: AbortSignal,
	): Promise<CodeIndexSearchResponse> {
		if (!this.isFeatureEnabled) {
			const failedPaths = this.fileFailureRegistry.list().map((failure) => failure.path)
			const waitingPaths = this.providerPacerRegistry.waitingPaths()
			return {
				results: [],
				incomplete: failedPaths.length > 0 || waitingPaths.length > 0,
				failedPaths,
				waitingPaths,
			}
		}
		if (this._sembleProvider) {
			return {
				results: await this._sembleProvider.searchIndex(query, directoryPrefix),
				incomplete: false,
				failedPaths: [],
				waitingPaths: [],
			}
		}
		this.assertInitialized()
		return this._searchService!.searchIndex(query, directoryPrefix, signal)
	}

	private async _recreateServices(): Promise<void> {
		const epoch = this.startupEpoch
		// Keep the clearing owner's attempt valid until its deletion has finished.
		await this.clearing
		if (epoch !== this.startupEpoch || !this.isFeatureEnabled || !this.isWorkspaceEnabled) return
		const attempt = ++this.currentAttempt
		const isCurrentAttempt = () => attempt === this.currentAttempt
		const isCurrentStartup = () => isCurrentAttempt() && epoch === this.startupEpoch
		this._stateManager.setDiagnosticContext({ source: "manager", attempt })
		void this._orchestrator?.stopWatcher()
		this.parser?.stop()
		this.parser = undefined
		this._orchestrator = undefined
		this._searchService = undefined
		this._serviceFactory = undefined
		this.disposeSemble()
		if (this._configManager!.currentEmbedderProvider === "semble") {
			const state = new CodeIndexStateManager()
			this.sembleState = state
			this.subscribeSembleState()
			const provider = new SembleProvider(this.workspacePath, this.context, state)
			this._sembleProvider = provider
			await provider.initialize()
			if (!isCurrentStartup()) {
				if (this._sembleProvider === provider) this.disposeSemble()
				else provider.dispose()
				return
			}
			this.servicesStopped = false
			return
		}
		const ignoreInstance = ignore()
		try {
			ignoreInstance.add(await fs.readFile(path.join(this.workspacePath, ".gitignore"), "utf8"))
			ignoreInstance.add(".gitignore")
		} catch (error) {
			codeIndexLog.debug("Could not load .gitignore", { error })
		}
		if (!isCurrentStartup()) return
		const rooIgnoreController = new RooIgnoreController(this.workspacePath)
		await rooIgnoreController.initialize()
		if (!isCurrentStartup()) return
		const parser = new ParseWorkerClient()
		this.parser = parser
		const factory = new CodeIndexServiceFactory(
			this._configManager!,
			this.workspacePath,
			this._cacheManager!,
			this.writeGate,
			this.generationAllocator!,
			this.fileFailureRegistry,
			parser,
			isCurrentAttempt,
			this.providerPacerRegistry,
		)
		this._serviceFactory = factory
		const { embedder, vectorStore, scanner, fileWatcher } = factory.createServices(
			this.context,
			this._cacheManager!,
			ignoreInstance,
			rooIgnoreController,
		)
		const pacer = this.providerPacerRegistry.get(embedder.rateLimitScope)
		let deferredValidation = pacer.state().pausedUntil !== undefined
		let validationResult: { valid: boolean; error?: string } = { valid: true }
		if (!deferredValidation) {
			const issueSeq = pacer.markIssued()
			try {
				validationResult = await factory.validateEmbedder(embedder)
			} catch (error) {
				if (!isCurrentStartup()) {
					parser.stop()
					fileWatcher.dispose()
					return
				}
				if (classifyIndexingError(error) !== "rate-limit") {
					parser.stop()
					fileWatcher.dispose()
					throw error
				}
				pacer.reportRateLimit(error, issueSeq)
				deferredValidation = true
			}
		}
		if (!isCurrentStartup()) {
			parser.stop()
			fileWatcher.dispose()
			return
		}
		if (!validationResult.valid) {
			parser.stop()
			fileWatcher.dispose()
			throw new Error(validationResult.error || "Embedder configuration validation failed")
		}
		this._orchestrator = new CodeIndexOrchestrator(
			this._configManager!,
			this._stateManager,
			this.workspacePath,
			this._cacheManager!,
			vectorStore,
			scanner,
			fileWatcher,
			parser,
			this.writeGate,
			this.generationAllocator!,
			this.fileFailureRegistry,
			isCurrentAttempt,
			(_error, message) => {
				if (!isCurrentAttempt()) return
				this.parserFailed = true
				this.parserFailureMessage = codeIndexLog.redact(message)
				this.servicesStopped = true
				this.progressEmitter.fire(this.getCurrentStatus())
			},
			this.providerPacerRegistry,
			deferredValidation
				? async (signal) => {
						const result = await pacer.run(undefined, signal, () => factory.validateEmbedder(embedder))
						if (!result.valid) throw new Error(result.error || "Embedder configuration validation failed")
					}
				: undefined,
		)
		this._searchService = new CodeIndexSearchService(
			this._configManager!,
			this._stateManager,
			embedder,
			vectorStore,
			this.fileFailureRegistry,
			this.providerPacerRegistry,
			() => this.getCurrentStatus(),
		)
		this.servicesStopped = false
		this._stateManager.setSystemState("Standby", "")
	}

	private configureDiagnostics(): void {
		const owners = [...CodeIndexManager.diagnosticOwners]
		codeIndexLog.configure({
			workspacePaths: owners.map((manager) => manager.workspacePath),
			secrets: owners.flatMap((manager) => {
				const config = manager._configManager?.getConfig()
				return [
					config?.openAiOptions?.openAiNativeApiKey,
					config?.openAiCompatibleOptions?.apiKey,
					config?.geminiOptions?.apiKey,
					config?.mistralOptions?.apiKey,
					config?.vercelAiGatewayOptions?.apiKey,
					config?.openRouterOptions?.apiKey,
					config?.qdrantApiKey,
				].filter((secret): secret is string => !!secret)
			}),
		})
	}

	public async handleSettingsChange(): Promise<void> {
		const configuration = this._configManager
		if (!configuration) return
		const epoch = this.startupEpoch
		const { requiresRestart } = await configuration.loadConfiguration()
		if (configuration !== this._configManager || epoch !== this.startupEpoch) return
		this.configureDiagnostics()
		if (!this.isFeatureEnabled || !this.isWorkspaceEnabled) {
			this.disabledSinceFailure = true
			void this.stopWatcher()
			return
		}
		if (this.disabledSinceFailure) this.renewAfterDisable()
		if (this.parserFailed) return
		if (this.startInFlight) {
			this.servicesRestartPending ||= requiresRestart
			return this.startInFlight
		}
		if ((requiresRestart || this.servicesStopped || this.startupFailureMessage) && this.isFeatureConfigured) {
			return this.runStartup(async (startupEpoch) => {
				this.startupFailureMessage = undefined
				await this.initializeCache()
				if (startupEpoch === this.startupEpoch) await this._recreateServices()
			})
		}
	}
}
