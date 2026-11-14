import * as vscode from "vscode"
import { BATCH_SEGMENT_THRESHOLD } from "../constants"
import { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import { Ignore } from "ignore"
import { scannerExtensions } from "../shared/supported-extensions"
import { IFileWatcher, FileProcessingResult, IEmbedder, IVectorStore, BatchProcessingSummary } from "../interfaces"
import { codeParser } from "./parser"
import { FilePreparation, SKIP_UNCHANGED } from "./file-preparation"
import { CacheManager } from "../cache-manager"
import { Package } from "../../../shared/package"
import { type FileFailureRegistry, UNKNOWN_REVISION } from "../file-failure-registry"
import type { ProviderPacerRegistry } from "../provider-pacer"
import { FileIndexWriter } from "../file-index-writer"
import { generateRelativeFilePath } from "../shared/get-relative-path"

/**
 * Implementation of the file watcher interface
 */
export class FileWatcher implements IFileWatcher {
	private readonly filePreparation: FilePreparation
	private writer?: FileIndexWriter
	private signal?: AbortSignal
	private ignoreInstance?: Ignore
	private fileWatcher?: vscode.FileSystemWatcher
	private ignoreController: RooIgnoreController
	private accumulatedEvents: Map<string, { uri: vscode.Uri; type: "create" | "change" | "delete" }> = new Map()
	private batchQueue: Promise<void> = Promise.resolve()
	private batchProcessDebounceTimer?: NodeJS.Timeout
	private readonly BATCH_DEBOUNCE_DELAY_MS = 500
	private readonly FILE_PROCESSING_CONCURRENCY_LIMIT = 10
	private readonly batchSegmentThreshold: number

	private readonly _onDidStartBatchProcessing = new vscode.EventEmitter<string[]>()
	private readonly _onBatchProgressUpdate = new vscode.EventEmitter<{
		processedInBatch: number
		totalInBatch: number
		currentFile?: string
	}>()
	private readonly _onDidFinishBatchProcessing = new vscode.EventEmitter<BatchProcessingSummary>()

	/**
	 * Event emitted when a batch of files begins processing
	 */
	public readonly onDidStartBatchProcessing = this._onDidStartBatchProcessing.event

	/**
	 * Event emitted to report progress during batch processing
	 */
	public readonly onBatchProgressUpdate = this._onBatchProgressUpdate.event

	/**
	 * Event emitted when a batch of files has finished processing
	 */
	public readonly onDidFinishBatchProcessing = this._onDidFinishBatchProcessing.event

	/**
	 * Creates a new file watcher
	 * @param workspacePath Path to the workspace
	 * @param context VS Code extension context
	 * @param embedder Optional embedder
	 * @param vectorStore Optional vector store
	 * @param cacheManager Cache manager
	 */
	constructor(
		private workspacePath: string,
		_context: vscode.ExtensionContext,
		private readonly cacheManager: CacheManager,
		private embedder: IEmbedder | undefined,
		private vectorStore: IVectorStore | undefined,
		ignoreInstance: Ignore | undefined,
		ignoreController: RooIgnoreController | undefined,
		batchSegmentThreshold: number | undefined,
		private readonly failures: FileFailureRegistry,
		private readonly pacers: ProviderPacerRegistry,
	) {
		this.ignoreController = ignoreController || new RooIgnoreController(workspacePath)
		if (ignoreInstance) {
			this.ignoreInstance = ignoreInstance
		}
		this.filePreparation = new FilePreparation({
			workspacePath: this.workspacePath,
			ignoreController: this.ignoreController,
			ignoreInstance: this.ignoreInstance,
			fileSystem: vscode.workspace.fs,
			cacheManager: this.cacheManager,
			parser: codeParser,
		})
		// Get the configurable batch size from VSCode settings, fallback to default
		// If not provided in constructor, try to get from VSCode settings
		if (batchSegmentThreshold !== undefined) {
			this.batchSegmentThreshold = batchSegmentThreshold
		} else {
			try {
				this.batchSegmentThreshold = vscode.workspace
					.getConfiguration(Package.name)
					.get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
			} catch {
				// In test environment, vscode.workspace might not be available
				this.batchSegmentThreshold = BATCH_SEGMENT_THRESHOLD
			}
		}
		if (this.embedder && this.vectorStore) {
			this.writer = new FileIndexWriter(
				this.embedder,
				this.vectorStore,
				this.cacheManager,
				this.failures,
				this.pacers,
				this.workspacePath,
				this.batchSegmentThreshold,
			)
		}
	}

	/**
	 * Initializes the file watcher; `signal` is the indexing session's abort signal.
	 */
	async initialize(signal?: AbortSignal): Promise<void> {
		this.signal = signal
		// Create file watcher
		const filePattern = new vscode.RelativePattern(
			this.workspacePath,
			`**/*{${scannerExtensions.map((e) => e.substring(1)).join(",")}}`,
		)
		this.fileWatcher = vscode.workspace.createFileSystemWatcher(filePattern)

		// Register event handlers
		this.fileWatcher.onDidCreate(this.handleFileCreated.bind(this))
		this.fileWatcher.onDidChange(this.handleFileChanged.bind(this))
		this.fileWatcher.onDidDelete(this.handleFileDeleted.bind(this))
	}

	/**
	 * Stops watching. The event emitters stay usable because the orchestrator reuses this watcher on restart;
	 * it disposes its own subscriptions.
	 */
	dispose(): void {
		this.fileWatcher?.dispose()
		this.fileWatcher = undefined
		if (this.batchProcessDebounceTimer) {
			clearTimeout(this.batchProcessDebounceTimer)
		}
		this.accumulatedEvents.clear()
	}

	/**
	 * Handles file creation events
	 * @param uri URI of the created file
	 */
	private async handleFileCreated(uri: vscode.Uri): Promise<void> {
		this.accumulatedEvents.set(uri.fsPath, { uri, type: "create" })
		this.scheduleBatchProcessing()
	}

	/**
	 * Handles file change events
	 * @param uri URI of the changed file
	 */
	private async handleFileChanged(uri: vscode.Uri): Promise<void> {
		this.accumulatedEvents.set(uri.fsPath, { uri, type: "change" })
		this.scheduleBatchProcessing()
	}

	/**
	 * Handles file deletion events
	 * @param uri URI of the deleted file
	 */
	private async handleFileDeleted(uri: vscode.Uri): Promise<void> {
		this.accumulatedEvents.set(uri.fsPath, { uri, type: "delete" })
		this.scheduleBatchProcessing()
	}

	/**
	 * Schedules batch processing with debounce
	 */
	private scheduleBatchProcessing(): void {
		if (this.batchProcessDebounceTimer) {
			clearTimeout(this.batchProcessDebounceTimer)
		}
		this.batchProcessDebounceTimer = setTimeout(() => this.triggerBatchProcessing(), this.BATCH_DEBOUNCE_DELAY_MS)
	}

	/**
	 * Triggers processing of accumulated events
	 */
	private async triggerBatchProcessing(): Promise<void> {
		if (this.accumulatedEvents.size === 0) {
			return
		}

		const eventsToProcess = new Map(this.accumulatedEvents)
		this.accumulatedEvents.clear()

		const filePathsInBatch = Array.from(eventsToProcess.keys())
		this._onDidStartBatchProcessing.fire(filePathsInBatch)

		// Batches run one at a time so a later change or delete of a path cannot finish before an earlier one.
		// Each batch keeps its own session signal, so a restart's new signal never authorizes a stale write.
		const signal = this.signal
		this.batchQueue = this.batchQueue
			.then(() => this.processBatch(eventsToProcess, signal))
			.catch((error) => console.error("[FileWatcher] Batch processing failed:", error))
		await this.batchQueue
	}

	private async removeFile(filePath: string, signal: AbortSignal | undefined): Promise<FileProcessingResult> {
		if (!this.writer) return { path: filePath, status: "success" }
		const removed = await this.writer.remove(filePath, signal)
		return removed
			? { path: filePath, status: "success" }
			: { path: filePath, status: "error", error: new Error(`Failed to remove ${filePath} from the index`) }
	}

	private async indexFile(filePath: string, signal: AbortSignal | undefined): Promise<FileProcessingResult> {
		const result = await this.processFile(filePath)
		if (result.status === "missing") return this.removeFile(filePath, signal)
		if (result.status === "local_error") {
			if (!signal?.aborted) {
				const relativePath = generateRelativeFilePath(filePath, this.workspacePath)
				const revision = result.newHash ?? UNKNOWN_REVISION
				const reason = result.error instanceof Error ? result.error.message : String(result.error)
				this.failures.renew(relativePath, revision)
				this.failures.record(relativePath, revision, result.activity ?? "read", reason, 1, "exhausted")
			}
			return result
		}
		if (result.status === "skipped") {
			if (result.reason === SKIP_UNCHANGED) {
				// Content matches the stored hash, so the file is indexed; an earlier read failure is stale.
				if (!signal?.aborted) this.failures.clear(generateRelativeFilePath(filePath, this.workspacePath))
				return result
			}
			// A file that became ignored or too large must not keep its old points.
			if (this.cacheManager.getHash(filePath) !== undefined) return this.removeFile(filePath, signal)
			return result
		}
		if (result.status !== "processed_for_batching" || !result.newHash || !this.writer) return result
		const indexed = await this.writer.replace(filePath, result.newHash, result.blocks ?? [], signal)
		return indexed
			? { path: filePath, status: "success" }
			: { path: filePath, status: "error", error: new Error(`Failed to index ${filePath}`) }
	}

	private async processBatch(
		eventsToProcess: Map<string, { uri: vscode.Uri; type: "create" | "change" | "delete" }>,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const batchResults: FileProcessingResult[] = []
		const totalFilesInBatch = eventsToProcess.size
		let processedCountInBatch = 0
		this._onBatchProgressUpdate.fire({
			processedInBatch: 0,
			totalInBatch: totalFilesInBatch,
			currentFile: undefined,
		})

		const events = [...eventsToProcess.values()]
		for (let offset = 0; offset < events.length; offset += this.FILE_PROCESSING_CONCURRENCY_LIMIT) {
			if (signal?.aborted) break
			const chunk = events.slice(offset, offset + this.FILE_PROCESSING_CONCURRENCY_LIMIT)
			const results = await Promise.all(
				chunk.map(async (event) => {
					const filePath = event.uri.fsPath
					try {
						return event.type === "delete"
							? await this.removeFile(filePath, signal)
							: await this.indexFile(filePath, signal)
					} catch (error) {
						return { path: filePath, status: "error", error: error as Error } satisfies FileProcessingResult
					}
				}),
			)
			for (const result of results) {
				batchResults.push(result)
				processedCountInBatch++
				this._onBatchProgressUpdate.fire({
					processedInBatch: processedCountInBatch,
					totalInBatch: totalFilesInBatch,
					currentFile: result.path,
				})
			}
		}

		this._onDidFinishBatchProcessing.fire({ processedFiles: batchResults })
		this._onBatchProgressUpdate.fire({ processedInBatch: totalFilesInBatch, totalInBatch: totalFilesInBatch })
		if (this.accumulatedEvents.size === 0) {
			this._onBatchProgressUpdate.fire({ processedInBatch: 0, totalInBatch: 0, currentFile: undefined })
		}
	}

	/**
	 * Processes a file
	 * @param filePath Path to the file to process
	 * @returns Promise resolving to processing result
	 */
	async processFile(filePath: string): Promise<FileProcessingResult> {
		return this.filePreparation.prepareFile(filePath)
	}
}
