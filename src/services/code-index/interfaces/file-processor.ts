import type * as vscode from "vscode"
import type { PointStruct } from "./vector-store"
import type { ParserFatalError } from "../parser-errors"

export type { ICodeParser, CodeBlock } from "../parser-types"

/**
 * Interface for directory scanner
 */
export interface IDirectoryScanner {
	readonly hasIncompleteFiles?: boolean

	/**
	 * Scans a directory for code blocks
	 * @param directoryPath Path to the directory to scan
	 * @param options Optional scanning options
	 * @returns Promise resolving to scan results
	 */
	scanDirectory(
		directory: string,
		onError?: (error: Error) => void,
		onBlocksIndexed?: (indexedCount: number) => void,
		onFileParsed?: (fileBlockCount: number) => void,
		signal?: AbortSignal,
	): Promise<{
		stats: {
			processed: number
			skipped: number
		}
		totalBlockCount: number
		incompleteFiles?: string[]
	}>
}

/**
 * Interface for file watcher
 */
export interface IFileWatcher extends vscode.Disposable {
	/**
	 * Initializes the file watcher
	 */
	initialize(signal?: AbortSignal): Promise<void>
	readonly onParserFatal?: vscode.Event<ParserFatalError>
	readonly isProcessing?: boolean

	/**
	 * Event emitted when a batch of files begins processing.
	 * The event payload is an array of file paths included in the batch.
	 */
	readonly onDidStartBatchProcessing: vscode.Event<string[]>

	/**
	 * Event emitted to report progress during batch processing.
	 */
	readonly onBatchProgressUpdate: vscode.Event<{
		processedInBatch: number
		totalInBatch: number
		currentFile?: string
	}>

	/**
	 * Event emitted when a batch of files has finished processing.
	 * The event payload contains a summary of the batch operation.
	 */
	readonly onDidFinishBatchProcessing: vscode.Event<BatchProcessingSummary>

	/**
	 * Processes a file
	 * @param filePath Path to the file to process
	 * @returns Promise resolving to processing result
	 */
	processFile(filePath: string): Promise<FileProcessingResult>
}

export interface BatchProcessingSummary {
	/** All files attempted in the batch, including their final status. */
	processedFiles: FileProcessingResult[]
	/** Optional error if the entire batch operation failed (e.g., database connection issue). */
	batchError?: Error
}

export interface FileProcessingResult {
	path: string
	status: "success" | "skipped" | "error" | "processed_for_batching" | "local_error"
	error?: Error
	reason?: string
	newHash?: string
	pointsToUpsert?: PointStruct[]
}
