import * as vscode from "vscode"
import * as path from "path"
import type { CodeIndexConfigManager } from "./config-manager"
import type { CodeIndexStateManager, IndexingState } from "./state-manager"
import type { IFileWatcher, IVectorStore, IDirectoryScanner } from "./interfaces"
import type { CacheManager } from "./cache-manager"
import { CodeIndexScanExecutor } from "./code-index-scan-executor"
import { t } from "../../i18n"
import { ParserFatalError, abortError } from "./parser-errors"
import { ParseWorkerClient } from "./parse-worker-client"
import { IndexWriteGate } from "./index-write-gate"
import { GenerationAllocator } from "./generation-allocator"
import { FileFailureRegistry } from "./file-failure-registry"
import { ProviderPacerRegistry } from "./provider-pacer"
import { INDEX_STOP_LIMIT_MS } from "./constants"
import { codeIndexLog } from "./code-index-log"
import { formatProviderWaitMessage } from "./shared/provider-wait-message"
import { generateRelativeFilePath } from "./shared/get-relative-path"

export class CodeIndexOrchestrator {
	private watcherSubscriptions: vscode.Disposable[] = []
	private scanning = false
	private controller?: AbortController
	private scanPromise?: Promise<void>
	private stopPromise?: Promise<void>
	private readonly idleStop = Promise.resolve()
	public startupResult: Promise<void> = Promise.resolve()
	private resolveStartup?: () => void
	private rejectStartup?: (error: unknown) => void
	private failureSubscription?: vscode.Disposable
	private pacerSubscription?: vscode.Disposable
	private watcherBatchPending = false
	private scanPartial = false
	private batchPartial = false
	private naturallySettled = false
	public stopped = false
	private parserFailure?: ParserFatalError
	private collectionIncomplete = false
	private recoveryCompletion?: Promise<void>
	private readonly scanExecutor: CodeIndexScanExecutor

	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		private readonly workspacePath: string,
		private readonly cacheManager: CacheManager,
		private readonly vectorStore: IVectorStore,
		private readonly scanner: IDirectoryScanner,
		private readonly fileWatcher: IFileWatcher,
		private readonly parser: ParseWorkerClient = new ParseWorkerClient(),
		private readonly writeGate = new IndexWriteGate(),
		private readonly generations = new GenerationAllocator(cacheManager),
		private readonly failures = new FileFailureRegistry(),
		private readonly isCurrentAttempt: () => boolean = () => true,
		private readonly onFatal?: (error: ParserFatalError, message: string) => void,
		private readonly providerPacers = new ProviderPacerRegistry(),
		private readonly beforeScan?: (signal: AbortSignal) => Promise<void>,
	) {
		this.scanExecutor = new CodeIndexScanExecutor(workspacePath, scanner, stateManager, isCurrentAttempt)
	}

	private isLive(signal: AbortSignal): boolean {
		return !signal.aborted && this.isCurrentAttempt()
	}

	private checkLive(signal: AbortSignal): void {
		if (!this.isLive(signal)) throw abortError()
	}

	private write<Result>(signal: AbortSignal, operation: () => Result | Promise<Result>): Promise<Result> {
		return this.writeGate.run(signal, () => {
			this.checkLive(signal)
			return operation()
		})
	}

	private failStop(error: ParserFatalError): void {
		const signal = this.controller?.signal
		if (!signal || !this.isLive(signal) || this.parserFailure) return
		this.parserFailure = error
		const message = t("embeddings:orchestrator.parserFailed", {
			filePath: error.filePath,
			category: error.category,
		})
		this.stateManager.setSystemState("Error", message, "error")
		if (this.isLive(signal)) this.onFatal?.(error, message)
		void this.stop(true)
	}

	private hasIncompleteFiles(): boolean {
		return (
			this.failures.list().length > 0 ||
			this.providerPacers.waitingPaths().length > 0 ||
			this.watcherBatchPending ||
			this.scanPartial ||
			this.batchPartial ||
			(this.stopped && !!this.scanner.hasIncompleteFiles) ||
			Object.keys(this.cacheManager.getOpenFiles()).length > 0
		)
	}

	private updateRecoveryStatus(signal: AbortSignal, source = "changed-file-batch"): void {
		if (
			!this.isLive(signal) ||
			this.stopped ||
			this.stateManager.state === "Error" ||
			this.stateManager.state === "Stopping"
		)
			return
		const failures = this.failures.list()
		const retrying = failures.some((failure) => failure.state === "retrying")
		const message = t(
			retrying ? "embeddings:orchestrator.indexingFilesRetrying" : "embeddings:orchestrator.indexingFilesFailed",
		)
		if (this.providerPacers.hasWaitingRequests()) {
			this.stateManager.setSystemState(
				"Indexing",
				formatProviderWaitMessage(this.providerPacers.providerWaits()),
				source,
			)
		} else if (this.scanning || this.watcherBatchPending || retrying) {
			this.stateManager.setSystemState("Indexing", failures.length > 0 ? message : undefined, source)
		} else if (this.hasIncompleteFiles()) {
			if (this.naturallySettled) this.stateManager.setSystemState("Standby", message, source)
		} else if (this.collectionIncomplete) {
			this.recoveryCompletion ??= this.completeRecovery(signal, source).finally(() => {
				this.recoveryCompletion = undefined
			})
		} else {
			this.stateManager.setSystemState("Indexed", t("embeddings:orchestrator.fileWatcherStarted"), source)
		}
	}

	private async completeRecovery(signal: AbortSignal, source: string): Promise<void> {
		try {
			await this.write(signal, async () => {
				if (
					this.stopped ||
					this.stateManager.state === "Error" ||
					this.stateManager.state === "Stopping" ||
					this.hasIncompleteFiles() ||
					this.scanning
				)
					return
				await this.vectorStore.markIndexingComplete()
				if (this.isLive(signal)) this.collectionIncomplete = false
			})
			if (this.isLive(signal) && !this.collectionIncomplete) this.updateRecoveryStatus(signal, source)
		} catch (error) {
			if (!this.isLive(signal) || this.stopped) return
			codeIndexLog.error("Recovery completion failed", { error })
			this.stateManager.setSystemState("Error", String(error), "error")
			void this.stop(true)
		}
	}

	private async startWatcher(signal: AbortSignal): Promise<void> {
		this.checkLive(signal)
		this.watcherSubscriptions = [
			this.fileWatcher.onDidStartBatchProcessing(() => {
				if (!this.isLive(signal)) return
				this.watcherBatchPending = true
				this.naturallySettled = false
				this.stateManager.setSystemState("Indexing", "Processing file changes...", "changed-file-batch")
			}),
			this.fileWatcher.onBatchProgressUpdate(({ processedInBatch, totalInBatch, currentFile }) => {
				if (!this.isLive(signal)) return
				this.stateManager.reportFileQueueProgress(
					processedInBatch,
					totalInBatch,
					currentFile ? path.basename(currentFile) : undefined,
					"changed-file-batch",
				)
			}),
			this.fileWatcher.onDidFinishBatchProcessing((summary) => {
				if (!this.isLive(signal)) return
				this.watcherBatchPending = false
				this.naturallySettled = true
				// Registry-backed failures recover through the registry, not a sticky batch flag.
				const registered = new Set(this.failures.list().map((failure) => failure.path))
				this.batchPartial =
					(!!summary.batchError && summary.processedFiles.length === 0) ||
					summary.processedFiles.some(
						(file) =>
							(file.status === "error" || file.status === "local_error") &&
							!registered.has(generateRelativeFilePath(file.path, this.workspacePath)),
					)
				this.updateRecoveryStatus(signal)
			}),
		]
		if (this.fileWatcher.onParserFatal) {
			this.watcherSubscriptions.push(this.fileWatcher.onParserFatal((error) => this.failStop(error)))
		}
		await this.fileWatcher.initialize(signal)
		this.checkLive(signal)
	}

	public startIndexing(): Promise<void> {
		if (this.stopped || !this.isCurrentAttempt()) return Promise.resolve()
		if (this.scanning) return this.scanPromise ?? Promise.resolve()
		if (this.controller) return Promise.resolve()
		if (!vscode.workspace.workspaceFolders?.length) {
			const message = t("embeddings:orchestrator.indexingRequiresWorkspace")
			this.stateManager.setSystemState("Error", message, "error")
			this.startupResult = Promise.reject(new Error(message))
			void this.startupResult.catch(() => {})
			return Promise.resolve()
		}
		if (!this.configManager.isFeatureConfigured) {
			this.stateManager.setSystemState(
				"Standby",
				"Missing configuration. Save your settings to start indexing.",
				"start-request",
			)
			return Promise.resolve()
		}
		this.scanning = true
		this.controller = new AbortController()
		this.startupResult = new Promise<void>((resolve, reject) => {
			this.resolveStartup = resolve
			this.rejectStartup = reject
		})
		void this.startupResult.catch(() => {})
		const signal = this.controller.signal
		this.failureSubscription = this.failures.onDidChange(() =>
			this.updateRecoveryStatus(signal, this.scanning ? "scan" : "changed-file-batch"),
		)
		this.pacerSubscription = this.providerPacers.onDidChange(() =>
			this.updateRecoveryStatus(signal, this.scanning ? "scan" : "changed-file-batch"),
		)
		this.stateManager.setSystemState("Indexing", "Initializing services...", "start-request")
		this.scanPromise = this.runScan(signal)
		return this.scanPromise
	}

	private async runScan(signal: AbortSignal): Promise<void> {
		let clearIndexOnError = false
		try {
			if (this.beforeScan) {
				this.resolveStartup?.()
				await this.beforeScan(signal)
				this.checkLive(signal)
			}
			clearIndexOnError = await this.write(signal, () => this.vectorStore.initialize())
			this.checkLive(signal)
			if (clearIndexOnError) await this.write(signal, () => this.cacheManager.clearCacheFile())
			this.checkLive(signal)
			await this.generations.initialize(this.vectorStore, signal, this.writeGate)
			this.checkLive(signal)
			const hasExistingData = await this.vectorStore.hasIndexedData()
			this.checkLive(signal)
			await this.write(signal, () => this.vectorStore.markIndexingIncomplete())
			this.checkLive(signal)
			this.collectionIncomplete = true
			this.resolveStartup?.()
			const completed =
				hasExistingData && !clearIndexOnError
					? await this.scanExecutor.runIncrementalScan(signal)
					: await this.scanExecutor.runFullScan(signal)
			this.checkLive(signal)
			if (!completed) {
				void this.stop(true)
				return
			}
			this.scanPartial = this.scanExecutor.partial && this.failures.list().length === 0
			await this.startWatcher(signal)
			this.checkLive(signal)
			this.naturallySettled = true
		} catch (error) {
			this.rejectStartup?.(error)
			if (!this.isLive(signal)) return
			if (error instanceof ParserFatalError) {
				this.failStop(error)
				return
			}
			if (error instanceof Error && error.name === "AbortError") {
				void this.stop(true)
				return
			}
			codeIndexLog.error("Initial scan failed", { error })
			if (clearIndexOnError) {
				try {
					await this.write(signal, () => this.vectorStore.clearCollection())
					await this.write(signal, () => this.cacheManager.clearCacheFile())
				} catch (cleanupError) {
					if (this.isLive(signal)) codeIndexLog.error("Index cleanup failed", { error: cleanupError })
				}
			}
			if (!this.isLive(signal)) return
			this.stateManager.setSystemState(
				"Error",
				t("embeddings:orchestrator.failedDuringInitialScan", {
					errorMessage: error instanceof Error ? error.message : t("embeddings:orchestrator.unknownError"),
				}),
				"error",
			)
			void this.stop(true)
		} finally {
			this.resolveStartup?.()
			this.scanning = false
			this.updateRecoveryStatus(signal, "scan-end")
			if (this.recoveryCompletion) await this.recoveryCompletion
		}
	}

	public stopIndexing(): Promise<void> {
		return this.stop(false)
	}

	public stopWatcher(): Promise<void> {
		return this.stop(true)
	}

	private persistUncertain(signal?: AbortSignal): Promise<void> {
		if (!this.isCurrentAttempt()) return Promise.resolve()
		const paths = signal ? this.writeGate.uncertainFiles(signal) : []
		return Promise.all(paths.map((filePath) => this.cacheManager.invalidateFile(filePath)))
			.then(() => (this.isCurrentAttempt() ? this.cacheManager.flush() : undefined))
			.catch((error: unknown) => {
				if (this.isCurrentAttempt()) codeIndexLog.error("Stopped index cache persistence failed", { error })
			})
	}

	private stop(force: boolean): Promise<void> {
		if (this.stopPromise) return this.stopPromise
		const signal = this.controller?.signal
		const active = !!signal && !signal.aborted
		if (!active && !force && !this.parserFailure) return this.idleStop
		const preserveError = this.stateManager.state === "Error" || !!this.parserFailure
		const expiresAt = Date.now() + INDEX_STOP_LIMIT_MS
		if (signal) this.writeGate.stopAt(signal, expiresAt)
		this.stopPromise = Promise.resolve().then(async () => {
			let timer: ReturnType<typeof setTimeout> | undefined
			let workerStopped = false
			const workerExit = this.parser.stopped.then(() => {
				workerStopped = true
			})
			const settled = Promise.allSettled([
				this.scanPromise,
				signal ? this.writeGate.settled(signal) : undefined,
				workerExit,
			]).then(async () => {
				await this.persistUncertain(signal)
				return false
			})
			const expired = await Promise.race([
				settled,
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(true), Math.max(0, expiresAt - Date.now()))
				}),
			])
			clearTimeout(timer)
			if (expired && signal) {
				this.writeGate.abandon(signal, expiresAt)
				// Invalidation mutates the retained cache synchronously; disk I/O cannot extend the stop deadline.
				void this.persistUncertain(signal)
			}
			if (expired && !workerStopped) this.parser.logStopTimeout()
			if (!active || !this.isCurrentAttempt() || preserveError || this.state === "Error") return
			this.stateManager.setSystemState(
				"Standby",
				t(
					expired || this.hasIncompleteFiles()
						? "embeddings:orchestrator.indexingStoppedPartial"
						: "embeddings:orchestrator.indexingStopped",
				),
				"stop",
			)
		})
		this.stopped = true
		this.naturallySettled = false
		this.controller?.abort()
		this.resolveStartup?.()
		this.failureSubscription?.dispose()
		this.failureSubscription = undefined
		this.pacerSubscription?.dispose()
		this.pacerSubscription = undefined
		this.parser.stop()
		this.fileWatcher.dispose()
		this.watcherSubscriptions.forEach((subscription) => subscription.dispose())
		this.watcherSubscriptions = []
		if (active && !preserveError && this.isCurrentAttempt()) {
			this.stateManager.setSystemState("Stopping", t("embeddings:orchestrator.indexingStopping"), "stop")
		}
		return this.stopPromise
	}

	public async clearIndexData(): Promise<void> {
		await this.stopWatcher()
		const signal = new AbortController().signal
		try {
			this.checkLive(signal)
			if (this.configManager.isFeatureConfigured) {
				await this.write(signal, () => this.vectorStore.deleteCollection())
			}
			await this.write(signal, () => this.cacheManager.clearCacheFile())
			if (this.isLive(signal))
				this.stateManager.setSystemState("Standby", "Index data cleared successfully.", "rebuild")
		} catch (error) {
			if (!this.isLive(signal)) return
			this.stateManager.setSystemState("Error", `Failed to clear index data: ${String(error)}`, "error")
			throw error
		}
	}

	public get isScanning(): boolean {
		return this.scanning
	}

	public get isActive(): boolean {
		return !!this.controller && this.isLive(this.controller.signal) && !this.stopped
	}

	public get isNaturallySettledPartial(): boolean {
		return (
			this.isActive &&
			this.naturallySettled &&
			!this.scanning &&
			!this.watcherBatchPending &&
			this.hasIncompleteFiles()
		)
	}

	public get state(): IndexingState {
		return this.stateManager.state
	}
}
