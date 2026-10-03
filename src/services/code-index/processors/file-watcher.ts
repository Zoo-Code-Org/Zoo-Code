import * as vscode from "vscode"
import { BATCH_SEGMENT_THRESHOLD, MAX_BATCH_RETRIES, INITIAL_RETRY_DELAY_MS } from "../constants"
import { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import { Ignore } from "ignore"
import { scannerExtensions } from "../shared/supported-extensions"
import {
	IFileWatcher,
	FileProcessingResult,
	IEmbedder,
	IVectorStore,
	PointStruct,
	BatchProcessingSummary,
} from "../interfaces"
import { codeParser } from "./parser"
import { FilePreparation } from "./file-preparation"
import { FileEventAccumulator } from "./file-event-accumulator"
import type { FileWatcherEvent } from "../interfaces/file-watcher-event"
import type { PreparedWatcherFile } from "../interfaces/prepared-watcher-file"
import { CacheManager } from "../cache-manager"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { sanitizeErrorMessage } from "../shared/validation-helpers"
import { Package } from "../../../shared/package"

/**
 * Implementation of the file watcher interface
 */
export class FileWatcher implements IFileWatcher {
	private readonly filePreparation: FilePreparation
	private ignoreInstance?: Ignore
	private fileSystemWatcher?: vscode.FileSystemWatcher
	private ignoreController: RooIgnoreController
	private readonly eventAccumulator: FileEventAccumulator
	private batchReadySubscription?: vscode.Disposable
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
		private context: vscode.ExtensionContext,
		private readonly cacheManager: CacheManager,
		private embedder?: IEmbedder,
		private vectorStore?: IVectorStore,
		ignoreInstance?: Ignore,
		ignoreController?: RooIgnoreController,
		batchSegmentThreshold?: number,
	) {
		this.eventAccumulator = new FileEventAccumulator()
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
			embedder: this.embedder,
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
	}

	/**
	 * Initializes the file watcher
	 */
	async initialize(): Promise<void> {
		this.batchReadySubscription?.dispose()
		this.batchReadySubscription = this.eventAccumulator.onBatchReady(this.triggerBatchProcessing, this)
		// Create file watcher
		const filePattern = new vscode.RelativePattern(
			this.workspacePath,
			`**/*{${scannerExtensions.map((e) => e.substring(1)).join(",")}}`,
		)
		this.fileSystemWatcher = vscode.workspace.createFileSystemWatcher(filePattern)

		// Register event handlers
		this.fileSystemWatcher.onDidCreate((uri) => this.eventAccumulator.add({ uri, type: "create" }))
		this.fileSystemWatcher.onDidChange((uri) => this.eventAccumulator.add({ uri, type: "change" }))
		this.fileSystemWatcher.onDidDelete((uri) => this.eventAccumulator.add({ uri, type: "delete" }))
	}

	/**
	 * Disposes the file watcher
	 */
	dispose(): void {
		this.fileSystemWatcher?.dispose()
		this.batchReadySubscription?.dispose()
		this.eventAccumulator.dispose()
		this._onDidStartBatchProcessing.dispose()
		this._onBatchProgressUpdate.dispose()
		this._onDidFinishBatchProcessing.dispose()
	}

	/**
	 * Triggers processing of accumulated events
	 */
	private async triggerBatchProcessing(eventsToProcess: Map<string, FileWatcherEvent>): Promise<void> {
		const filePathsInBatch = Array.from(eventsToProcess.keys())
		this._onDidStartBatchProcessing.fire(filePathsInBatch)

		await this.processBatch(eventsToProcess)
	}

	/**
	 * Processes a batch of accumulated events
	 * @param eventsToProcess Map of events to process
	 */
	private async _handleBatchDeletions(
		batchResults: FileProcessingResult[],
		processedCountInBatch: number,
		totalFilesInBatch: number,
		pathsToExplicitlyDelete: string[],
		filesToUpsertDetails: Array<{ path: string; uri: vscode.Uri; originalType: "create" | "change" }>,
	): Promise<{ overallBatchError?: Error; clearedPaths: Set<string>; processedCount: number }> {
		let overallBatchError: Error | undefined
		const allPathsToClearFromDB = new Set<string>(pathsToExplicitlyDelete)

		for (const fileDetail of filesToUpsertDetails) {
			if (fileDetail.originalType === "change") {
				allPathsToClearFromDB.add(fileDetail.path)
			}
		}

		if (allPathsToClearFromDB.size > 0 && this.vectorStore) {
			try {
				await this.vectorStore.deletePointsByMultipleFilePaths(Array.from(allPathsToClearFromDB))

				for (const path of pathsToExplicitlyDelete) {
					this.cacheManager.deleteHash(path)
					batchResults.push({ path, status: "success" })
					processedCountInBatch++
					this._onBatchProgressUpdate.fire({
						processedInBatch: processedCountInBatch,
						totalInBatch: totalFilesInBatch,
						currentFile: path,
					})
				}
			} catch (error: any) {
				const errorStatus = error?.status || error?.response?.status || error?.statusCode
				const errorMessage = error instanceof Error ? error.message : String(error)

				// Log telemetry for deletion error
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: sanitizeErrorMessage(errorMessage),
					location: "deletePointsByMultipleFilePaths",
					errorType: "deletion_error",
					errorStatus: errorStatus,
				})

				// Mark all paths as error
				overallBatchError = error as Error
				for (const path of pathsToExplicitlyDelete) {
					batchResults.push({ path, status: "error", error: error as Error })
					processedCountInBatch++
					this._onBatchProgressUpdate.fire({
						processedInBatch: processedCountInBatch,
						totalInBatch: totalFilesInBatch,
						currentFile: path,
					})
				}
			}
		}

		return { overallBatchError, clearedPaths: allPathsToClearFromDB, processedCount: processedCountInBatch }
	}

	private async _processFilesAndPrepareUpserts(
		filesToUpsertDetails: Array<{ path: string; uri: vscode.Uri; originalType: "create" | "change" }>,
		batchResults: FileProcessingResult[],
		processedCountInBatch: number,
		totalFilesInBatch: number,
	): Promise<{
		pointsForBatchUpsert: PointStruct[]
		successfullyProcessedForUpsert: Array<{ path: string; newHash?: string }>
		processedCount: number
	}> {
		const pointsForBatchUpsert: PointStruct[] = []
		const successfullyProcessedForUpsert: Array<{ path: string; newHash?: string }> = []

		for (let i = 0; i < filesToUpsertDetails.length; i += this.FILE_PROCESSING_CONCURRENCY_LIMIT) {
			const chunkToProcess = filesToUpsertDetails.slice(i, i + this.FILE_PROCESSING_CONCURRENCY_LIMIT)

			const chunkProcessingPromises = chunkToProcess.map(async (fileDetail) => {
				this._onBatchProgressUpdate.fire({
					processedInBatch: processedCountInBatch,
					totalInBatch: totalFilesInBatch,
					currentFile: fileDetail.path,
				})
				return { path: fileDetail.path, result: await this.prepareFileForBatch(fileDetail.path) }
			})

			// Each preparation failure is captured above so other files can still complete.
			const chunkResults = await Promise.all(chunkProcessingPromises)

			for (const { path, result } of chunkResults) {
				if (result.kind === "completed") {
					batchResults.push(result.result)
				} else {
					pointsForBatchUpsert.push(...result.points)
					if (result.file) successfullyProcessedForUpsert.push(result.file)
				}

				// A path has one final event, so upserts and explicit deletions are disjoint.
				processedCountInBatch++
				this._onBatchProgressUpdate.fire({
					processedInBatch: processedCountInBatch,
					totalInBatch: totalFilesInBatch,
					currentFile: path,
				})
			}
		}

		return {
			pointsForBatchUpsert,
			successfullyProcessedForUpsert,
			processedCount: processedCountInBatch,
		}
	}

	private async prepareFileForBatch(path: string): Promise<PreparedWatcherFile> {
		let result: FileProcessingResult | undefined
		try {
			result = await this.processFile(path)
		} catch (error) {
			console.error(`[FileWatcher] Unhandled exception processing file ${path}:`, error)
			if (error) return { kind: "completed", result: { path, status: "error", error: error as Error } }
		}

		if (!result) {
			return {
				kind: "completed",
				result: {
					path,
					status: "error",
					error: new Error(`Fulfilled promise with no result or error for file ${path}`),
				},
			}
		}
		if (result.status === "skipped" || result.status === "local_error") {
			return { kind: "completed", result }
		}
		if (result.status === "processed_for_batching" && result.pointsToUpsert) {
			const prepared: PreparedWatcherFile = { kind: "upsert", points: result.pointsToUpsert }
			if (result.path) {
				prepared.file = result.newHash ? { path: result.path, newHash: result.newHash } : { path: result.path }
			}
			return prepared
		}

		return {
			kind: "completed",
			result: {
				path,
				status: "error",
				error: new Error(`Unexpected result status from processFile: ${result.status} for file ${path}`),
			},
		}
	}

	private async _executeBatchUpsertOperations(
		pointsForBatchUpsert: PointStruct[],
		successfullyProcessedForUpsert: Array<{ path: string; newHash?: string }>,
		batchResults: FileProcessingResult[],
		overallBatchError?: Error,
	): Promise<Error | undefined> {
		if (pointsForBatchUpsert.length > 0 && this.vectorStore && !overallBatchError) {
			try {
				for (let i = 0; i < pointsForBatchUpsert.length; i += this.batchSegmentThreshold) {
					const batch = pointsForBatchUpsert.slice(i, i + this.batchSegmentThreshold)
					let retryCount = 0
					let upsertError: Error | undefined

					while (retryCount < MAX_BATCH_RETRIES) {
						try {
							await this.vectorStore.upsertPoints(batch)
							break
						} catch (error) {
							upsertError = error as Error
							retryCount++
							if (retryCount === MAX_BATCH_RETRIES) {
								// Log telemetry for upsert failure
								TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
									error: sanitizeErrorMessage(upsertError.message),
									location: "upsertPoints",
									errorType: "upsert_retry_exhausted",
									retryCount: MAX_BATCH_RETRIES,
								})
								throw new Error(
									`Failed to upsert batch after ${MAX_BATCH_RETRIES} retries: ${upsertError.message}`,
								)
							}
							await new Promise((resolve) =>
								setTimeout(resolve, INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount - 1)),
							)
						}
					}
				}

				for (const { path, newHash } of successfullyProcessedForUpsert) {
					if (newHash) {
						this.cacheManager.updateHash(path, newHash)
					}
					batchResults.push({ path, status: "success" })
				}
			} catch (error) {
				const err = error as Error
				overallBatchError = overallBatchError || err
				// Log telemetry for batch upsert error
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: sanitizeErrorMessage(err.message),
					location: "executeBatchUpsertOperations",
					errorType: "batch_upsert_error",
					affectedFiles: successfullyProcessedForUpsert.length,
				})
				for (const { path } of successfullyProcessedForUpsert) {
					batchResults.push({ path, status: "error", error: err })
				}
			}
		} else if (overallBatchError && pointsForBatchUpsert.length > 0) {
			for (const { path } of successfullyProcessedForUpsert) {
				batchResults.push({ path, status: "error", error: overallBatchError })
			}
		}

		return overallBatchError
	}

	private async processBatch(eventsToProcess: Map<string, FileWatcherEvent>): Promise<void> {
		const batchResults: FileProcessingResult[] = []
		let processedCountInBatch = 0
		const totalFilesInBatch = eventsToProcess.size
		let overallBatchError: Error | undefined

		// Initial progress update
		this._onBatchProgressUpdate.fire({
			processedInBatch: 0,
			totalInBatch: totalFilesInBatch,
			currentFile: undefined,
		})

		// Categorize events
		const pathsToExplicitlyDelete: string[] = []
		const filesToUpsertDetails: Array<{ path: string; uri: vscode.Uri; originalType: "create" | "change" }> = []

		for (const event of eventsToProcess.values()) {
			if (event.type === "delete") {
				pathsToExplicitlyDelete.push(event.uri.fsPath)
			} else {
				filesToUpsertDetails.push({
					path: event.uri.fsPath,
					uri: event.uri,
					originalType: event.type,
				})
			}
		}

		// Phase 1: Handle deletions
		const { overallBatchError: deletionError, processedCount: deletionCount } = await this._handleBatchDeletions(
			batchResults,
			processedCountInBatch,
			totalFilesInBatch,
			pathsToExplicitlyDelete,
			filesToUpsertDetails,
		)
		overallBatchError = deletionError
		processedCountInBatch = deletionCount

		// Phase 2: Process files and prepare upserts
		const {
			pointsForBatchUpsert,
			successfullyProcessedForUpsert,
			processedCount: upsertCount,
		} = await this._processFilesAndPrepareUpserts(
			filesToUpsertDetails,
			batchResults,
			processedCountInBatch,
			totalFilesInBatch,
		)
		processedCountInBatch = upsertCount

		// Phase 3: Execute batch upsert
		overallBatchError = await this._executeBatchUpsertOperations(
			pointsForBatchUpsert,
			successfullyProcessedForUpsert,
			batchResults,
			overallBatchError,
		)

		// Finalize
		this._onDidFinishBatchProcessing.fire({
			processedFiles: batchResults,
			batchError: overallBatchError,
		})
		this._onBatchProgressUpdate.fire({
			processedInBatch: totalFilesInBatch,
			totalInBatch: totalFilesInBatch,
		})

		if (!this.eventAccumulator.hasPendingEvents) {
			this._onBatchProgressUpdate.fire({
				processedInBatch: 0,
				totalInBatch: 0,
				currentFile: undefined,
			})
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
