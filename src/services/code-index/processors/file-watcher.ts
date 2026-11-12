import * as vscode from "vscode"
import * as path from "path"
import { createHash } from "crypto"
import type { Ignore } from "ignore"
import { MAX_FILE_SIZE_BYTES, BATCH_SEGMENT_THRESHOLD } from "../constants"
import { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import { scannerExtensions } from "../shared/supported-extensions"
import type {
	IFileWatcher,
	FileProcessingResult,
	IEmbedder,
	IVectorStore,
	ICodeParser,
	BatchProcessingSummary,
} from "../interfaces"
import { ParseWorkerClient } from "../parse-worker-client"
import { IndexWriteGate } from "../index-write-gate"
import { GenerationAllocator } from "../generation-allocator"
import { FileIndexWriter } from "../file-completion"
import { abortError, ParserFatalError, throwIfAborted } from "../parser-errors"
import type { CacheManager } from "../cache-manager"
import { generateRelativeFilePath } from "../shared/get-relative-path"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"
import { Package } from "../../../shared/package"
import { FileFailureRegistry, UNKNOWN_REVISION, type FileFailureActivity } from "../file-failure-registry"
import { codeIndexLog } from "../code-index-log"
import { ProviderPacerRegistry } from "../provider-pacer"

type FileEvent = { uri: vscode.Uri; type: "create" | "change" | "delete" }

export class FileWatcher implements IFileWatcher {
	private fileWatcher?: vscode.FileSystemWatcher
	private readonly ignoreController: RooIgnoreController
	private readonly accumulatedEvents = new Map<string, FileEvent>()
	private batchProcessDebounceTimer?: NodeJS.Timeout
	private readonly BATCH_DEBOUNCE_DELAY_MS = 500
	private readonly FILE_PROCESSING_CONCURRENCY_LIMIT = 10
	private readonly batchSegmentThreshold: number
	private readonly writer?: FileIndexWriter
	private readonly pathControllers = new Map<string, AbortController>()
	private readonly localAbortController = new AbortController()
	private signal = this.localAbortController.signal
	private attemptOwner = this.localAbortController.signal
	private processingBatch = false
	private activeFiles = 0
	private disposed = false
	private fatalReported = false
	private readonly parserFatal = new vscode.EventEmitter<ParserFatalError>()
	public readonly onParserFatal = this.parserFatal.event
	private readonly _onDidStartBatchProcessing = new vscode.EventEmitter<string[]>()
	private readonly _onBatchProgressUpdate = new vscode.EventEmitter<{
		processedInBatch: number
		totalInBatch: number
		currentFile?: string
	}>()
	private readonly _onDidFinishBatchProcessing = new vscode.EventEmitter<BatchProcessingSummary>()
	public readonly onDidStartBatchProcessing = this._onDidStartBatchProcessing.event
	public readonly onBatchProgressUpdate = this._onBatchProgressUpdate.event
	public readonly onDidFinishBatchProcessing = this._onDidFinishBatchProcessing.event

	constructor(
		private readonly workspacePath: string,
		_context: vscode.ExtensionContext,
		private readonly cacheManager: CacheManager,
		private readonly embedder?: IEmbedder,
		vectorStore?: IVectorStore,
		private readonly ignoreInstance?: Ignore,
		ignoreController?: RooIgnoreController,
		batchSegmentThreshold?: number,
		private readonly parser: ICodeParser = new ParseWorkerClient(),
		private readonly writeGate = new IndexWriteGate(),
		generations = new GenerationAllocator(cacheManager),
		private readonly failures = new FileFailureRegistry(),
		private readonly isCurrentAttempt: () => boolean = () => true,
		private readonly providerPacers = new ProviderPacerRegistry(),
	) {
		this.ignoreController = ignoreController ?? new RooIgnoreController(workspacePath)
		if (vectorStore) {
			this.writer = new FileIndexWriter(
				cacheManager,
				vectorStore,
				writeGate,
				generations,
				workspacePath,
				failures,
				this.providerPacers,
			)
		}
		if (batchSegmentThreshold !== undefined) {
			this.batchSegmentThreshold = batchSegmentThreshold
		} else {
			try {
				this.batchSegmentThreshold = vscode.workspace
					.getConfiguration(Package.name)
					.get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
			} catch {
				this.batchSegmentThreshold = BATCH_SEGMENT_THRESHOLD
			}
		}
	}

	public get isProcessing(): boolean {
		return this.processingBatch || this.activeFiles > 0
	}

	private isLive(): boolean {
		return !this.disposed && !this.signal.aborted && this.isCurrentAttempt()
	}

	private checkActive(signal = this.signal): void {
		throwIfAborted(signal)
		if (!this.isLive()) throw abortError()
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		this.checkActive()
		if (this.fileWatcher) return
		this.attemptOwner = signal ?? this.localAbortController.signal
		this.signal = signal
			? AbortSignal.any([signal, this.localAbortController.signal])
			: this.localAbortController.signal
		this.checkActive()
		this.writeGate.own(this.signal, this.attemptOwner)
		const filePattern = new vscode.RelativePattern(
			this.workspacePath,
			`**/*{${scannerExtensions.map((extension) => extension.substring(1)).join(",")}}`,
		)
		this.fileWatcher = vscode.workspace.createFileSystemWatcher(filePattern)
		this.fileWatcher.onDidCreate((uri) => this.handleFileEvent(uri, "create"))
		this.fileWatcher.onDidChange((uri) => this.handleFileEvent(uri, "change"))
		this.fileWatcher.onDidDelete((uri) => this.handleFileEvent(uri, "delete"))
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.localAbortController.abort()
		this.parserFatal.dispose()
		this.fileWatcher?.dispose()
		clearTimeout(this.batchProcessDebounceTimer)
		this._onDidStartBatchProcessing.dispose()
		this._onBatchProgressUpdate.dispose()
		this._onDidFinishBatchProcessing.dispose()
		this.accumulatedEvents.clear()
	}

	private handleFileEvent(uri: vscode.Uri, type: FileEvent["type"]): void {
		if (!this.isLive()) return
		this.pathControllers.get(uri.fsPath)?.abort()
		this.accumulatedEvents.set(uri.fsPath, { uri, type })
		this.scheduleBatchProcessing()
	}

	private scheduleBatchProcessing(): void {
		if (!this.isLive()) return
		clearTimeout(this.batchProcessDebounceTimer)
		this.batchProcessDebounceTimer = setTimeout(
			() => void this.triggerBatchProcessing(),
			this.BATCH_DEBOUNCE_DELAY_MS,
		)
	}

	private async triggerBatchProcessing(): Promise<void> {
		if (!this.isLive() || this.processingBatch || this.accumulatedEvents.size === 0) return
		const eventsToProcess = new Map(this.accumulatedEvents)
		this.accumulatedEvents.clear()
		this.processingBatch = true
		try {
			this._onDidStartBatchProcessing.fire([...eventsToProcess.keys()])
			await this.processBatch(eventsToProcess)
		} catch (error) {
			if (!this.isLive()) return
			if (error instanceof ParserFatalError) this.reportFatal(error)
			else {
				this._onDidFinishBatchProcessing.fire({ processedFiles: [], batchError: this.toError(error) })
			}
		} finally {
			this.processingBatch = false
			if (this.accumulatedEvents.size > 0) this.scheduleBatchProcessing()
		}
	}

	private async processBatch(eventsToProcess: Map<string, FileEvent>): Promise<void> {
		this.checkActive()
		const events = [...eventsToProcess.values()]
		const failureBatch = codeIndexLog.createFailureBatch({ source: "watcher" })
		const subscription = this.failures.onDidRecord((failure) => {
			if (this.isLive()) failureBatch.record({ ...failure, willRetry: failure.state === "retrying" })
		})
		try {
			const results: FileProcessingResult[] = []
			let nextEvent = 0
			let completed = 0
			this._onBatchProgressUpdate.fire({ processedInBatch: 0, totalInBatch: events.length })
			const processNext = async () => {
				while (nextEvent < events.length) {
					this.checkActive()
					const event = events[nextEvent++]
					const result =
						event.type === "delete"
							? await this.removeFile(event.uri.fsPath)
							: await this.processFile(event.uri.fsPath)
					this.checkActive()
					results.push(result)
					if (result.status === "success" || result.status === "skipped") {
						completed++
						this._onBatchProgressUpdate.fire({
							processedInBatch: completed,
							totalInBatch: events.length,
							currentFile: result.path,
						})
					}
				}
			}
			// Complete each file independently rather than waiting for a cross-file flush.
			await Promise.all(
				Array.from({ length: Math.min(events.length, this.FILE_PROCESSING_CONCURRENCY_LIMIT) }, processNext),
			)
			this.checkActive()
			const errors = results.filter((result) => result.status === "local_error")
			this._onDidFinishBatchProcessing.fire({
				processedFiles: results,
				batchError: errors.length ? new Error(`${errors.length} file changes could not be indexed`) : undefined,
			})
		} finally {
			subscription.dispose()
			failureBatch.flush()
		}
	}

	private reportFatal(error: ParserFatalError): void {
		if (this.fatalReported || !this.isLive()) return
		this.fatalReported = true
		this.parserFatal.fire(error)
		this.dispose()
	}

	private toError(error: unknown): Error {
		return new Error(codeIndexLog.redact(error instanceof Error ? error.message : String(error)), { cause: error })
	}

	private async removeFile(filePath: string, signal = this.signal): Promise<FileProcessingResult> {
		this.checkActive(signal)
		const controller = signal === this.signal ? new AbortController() : undefined
		if (controller) {
			this.pathControllers.get(filePath)?.abort()
			this.pathControllers.set(filePath, controller)
			signal = AbortSignal.any([signal, controller.signal])
		}
		try {
			this.checkActive(signal)
			if (
				!this.cacheManager.isTracked(filePath) &&
				!this.failures.has(generateRelativeFilePath(filePath, this.workspacePath))
			) {
				return { path: filePath, status: "skipped", reason: "File is not tracked" }
			}
			if (!this.writer) throw new Error("Vector store is not configured")
			await this.writer.remove(filePath, signal, this.attemptOwner)
			this.checkActive(signal)
			return { path: filePath, status: "success" }
		} catch (error) {
			this.checkActive()
			if (signal.aborted) return { path: filePath, status: "skipped", reason: "File change was superseded" }
			if (error instanceof Error && error.name === "AbortError") throw error
			return { path: filePath, status: "local_error", error: this.toError(error) }
		} finally {
			if (controller && this.pathControllers.get(filePath) === controller) this.pathControllers.delete(filePath)
		}
	}

	async processFile(filePath: string): Promise<FileProcessingResult> {
		this.checkActive()
		this.activeFiles++
		this.pathControllers.get(filePath)?.abort()
		const controller = new AbortController()
		this.pathControllers.set(filePath, controller)
		let signal = AbortSignal.any([this.signal, controller.signal])
		const relativeFilePath = generateRelativeFilePath(filePath, this.workspacePath)
		let revision = this.failures.getRevision(relativeFilePath) ?? UNKNOWN_REVISION
		let activity: FileFailureActivity = "read"
		try {
			this.failures.renew(relativeFilePath, revision)
			if (
				!scannerExtensions.includes(path.extname(filePath).toLowerCase()) ||
				isPathInIgnoredDirectory(relativeFilePath) ||
				!this.ignoreController.validateAccess(filePath) ||
				this.ignoreInstance?.ignores(relativeFilePath)
			) {
				return await this.removeFile(filePath, signal)
			}
			const fileStat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath))
			this.checkActive(signal)
			if (fileStat.size > MAX_FILE_SIZE_BYTES) return await this.removeFile(filePath, signal)
			const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))
			this.checkActive(signal)
			const content = Buffer.from(fileContent).toString("utf8")
			const newHash = createHash("sha256").update(content).digest("hex")
			revision = newHash
			signal = AbortSignal.any([signal, this.failures.renew(relativeFilePath, newHash)])
			this.writeGate.own(signal, this.attemptOwner)
			if (
				this.cacheManager.getHash(filePath) === newHash &&
				!this.writeGate.needsReconciliation(filePath) &&
				!this.failures.has(relativeFilePath)
			) {
				return { path: filePath, status: "skipped", reason: "File has not changed" }
			}
			activity = "embed"
			if (!this.writer || !this.embedder) throw new Error("Indexing services are not configured")
			this.failures.assertRetryable(relativeFilePath, revision)
			activity = "parse"
			// Cancelling an active parse terminates the shared worker, not just this file's request.
			const blocks = await this.parser.parseFile(filePath, { content, fileHash: newHash, signal: this.signal })
			this.checkActive(signal)
			activity = "embed"
			await this.writer.replace(
				filePath,
				newHash,
				blocks,
				this.embedder,
				signal,
				this.batchSegmentThreshold,
				undefined,
				this.attemptOwner,
			)
			this.checkActive(signal)
			return { path: filePath, status: "success" }
		} catch (error) {
			this.checkActive()
			if (
				(activity === "read" || activity === "parse") &&
				!signal.aborted &&
				!(error instanceof Error && error.name === "AbortError")
			) {
				this.failures.record(relativeFilePath, revision, activity, this.toError(error).message, 1, "exhausted")
			}
			if (error instanceof ParserFatalError) {
				this.reportFatal(error)
				throw error
			}
			if (signal.aborted) return { path: filePath, status: "skipped", reason: "File change was superseded" }
			if (error instanceof Error && error.name === "AbortError") throw error
			return { path: filePath, status: "local_error", error: this.toError(error) }
		} finally {
			if (this.pathControllers.get(filePath) === controller) this.pathControllers.delete(filePath)
			this.activeFiles--
		}
	}
}
