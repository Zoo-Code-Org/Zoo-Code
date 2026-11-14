import { listFiles } from "../../glob/list-files"
import { Ignore } from "ignore"
import { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import { stat } from "fs/promises"
import * as path from "path"
import { generateNormalizedAbsolutePath, generateRelativeFilePath } from "../shared/get-relative-path"
import { getWorkspacePathForContext } from "../../../utils/path"
import { scannerExtensions } from "../shared/supported-extensions"
import * as vscode from "vscode"
import { CodeBlock, ICodeParser, IEmbedder, IVectorStore, IDirectoryScanner } from "../interfaces"
import { createHash } from "crypto"
import pLimit from "p-limit"
import { CacheManager } from "../cache-manager"
import { t } from "../../../i18n"
import {
	MAX_FILE_SIZE_BYTES,
	MAX_LIST_FILES_LIMIT_CODE_INDEX,
	BATCH_SEGMENT_THRESHOLD,
	PARSING_CONCURRENCY,
	BATCH_PROCESSING_CONCURRENCY,
} from "../constants"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { sanitizeErrorMessage } from "../shared/validation-helpers"
import { Package } from "../../../shared/package"
import { type FileFailureRegistry, UNKNOWN_REVISION, type FileFailureActivity } from "../file-failure-registry"
import type { ProviderPacerRegistry } from "../provider-pacer"
import { FileIndexWriter } from "../file-index-writer"
import { readSource, SOURCE_MISSING } from "../shared/indexing-errors"

export class DirectoryScanner implements IDirectoryScanner {
	private readonly batchSegmentThreshold: number

	constructor(
		private readonly embedder: IEmbedder,
		private readonly qdrantClient: IVectorStore,
		private readonly codeParser: ICodeParser,
		private readonly cacheManager: CacheManager,
		private readonly ignoreInstance: Ignore,
		batchSegmentThreshold: number | undefined,
		private readonly failures: FileFailureRegistry,
		private readonly pacers: ProviderPacerRegistry,
	) {
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
	 * Recursively scans a directory, indexes new or changed files and removes entries for files that are gone.
	 * File-level failures are recorded in the failure registry and do not stop the scan.
	 */
	public async scanDirectory(
		directory: string,
		onError?: (error: Error) => void,
		onBlocksIndexed?: (indexedCount: number) => void,
		onFileParsed?: (fileBlockCount: number) => void,
		signal?: AbortSignal,
	): Promise<{ stats: { processed: number; skipped: number }; totalBlockCount: number }> {
		const directoryPath = directory
		// Capture workspace context at scan start
		const scanWorkspace = getWorkspacePathForContext(directoryPath)
		const writer = new FileIndexWriter(
			this.embedder,
			this.qdrantClient,
			this.cacheManager,
			this.failures,
			this.pacers,
			scanWorkspace,
			this.batchSegmentThreshold,
		)

		// Get all files recursively (handles .gitignore automatically)
		const [allPaths, _] = await listFiles(directoryPath, true, MAX_LIST_FILES_LIMIT_CODE_INDEX)

		// Filter out directories (marked with trailing '/')
		const filePaths = allPaths.filter((p) => !p.endsWith("/"))

		// Initialize RooIgnoreController if not provided
		const ignoreController = new RooIgnoreController(directoryPath)

		await ignoreController.initialize()

		// Filter paths using .rooignore
		const allowedPaths = ignoreController.filterPaths(filePaths)

		// Filter by supported extensions, ignore patterns, and excluded directories
		const supportedPaths = allowedPaths.filter((filePath) => {
			const ext = path.extname(filePath).toLowerCase()
			const relativeFilePath = generateRelativeFilePath(filePath, scanWorkspace)

			// Check if file is in an ignored directory using the shared helper
			// Use relative path to avoid matching parent directories outside the workspace
			if (isPathInIgnoredDirectory(relativeFilePath)) {
				return false
			}

			return scannerExtensions.includes(ext) && !this.ignoreInstance.ignores(relativeFilePath)
		})

		const processedFiles = new Set<string>()
		let processedCount = 0
		let skippedCount = 0
		let totalBlockCount = 0

		const parseLimiter = pLimit(PARSING_CONCURRENCY)
		const writeLimiter = pLimit(BATCH_PROCESSING_CONCURRENCY)
		const writes: Promise<void>[] = []

		const recordLocalFailure = (
			filePath: string,
			revision: string,
			activity: FileFailureActivity,
			error: unknown,
		) => {
			if (signal?.aborted) return
			const relativePath = generateRelativeFilePath(filePath, scanWorkspace)
			const reason = error instanceof Error ? error.message : String(error)
			this.failures.renew(relativePath, revision)
			this.failures.record(relativePath, revision, activity, reason, 1, "exhausted")
			this.reportError(error, `scanDirectory:${activity}`, filePath, scanWorkspace, onError)
		}

		const parsePromises = supportedPaths.map((filePath) =>
			parseLimiter(async () => {
				if (signal?.aborted) return

				let content: string
				try {
					const stats = await readSource(stat(filePath))
					// A file deleted after listing is a removal: leaving it out lets the removal phase delete it.
					if (stats === SOURCE_MISSING) return
					if (stats.size > MAX_FILE_SIZE_BYTES) {
						skippedCount++
						return
					}
					const buffer = await readSource(vscode.workspace.fs.readFile(vscode.Uri.file(filePath)))
					if (buffer === SOURCE_MISSING) return
					content = Buffer.from(buffer).toString("utf-8")
				} catch (error) {
					processedFiles.add(filePath)
					recordLocalFailure(filePath, UNKNOWN_REVISION, "read", error)
					return
				}

				const currentFileHash = createHash("sha256").update(content).digest("hex")
				processedFiles.add(filePath)
				if (this.cacheManager.getHash(filePath) === currentFileHash) {
					skippedCount++
					// The stored hash proves the file is indexed; an earlier read failure is stale.
					if (!signal?.aborted) this.failures.clear(generateRelativeFilePath(filePath, scanWorkspace))
					return
				}

				let blocks: CodeBlock[]
				try {
					blocks = await this.codeParser.parseFile(filePath, { content, fileHash: currentFileHash })
				} catch (error) {
					// Covers ParserLoadError: the hash stays unstored so Start Indexing retries the unchanged file.
					recordLocalFailure(filePath, currentFileHash, "parse", error)
					return
				}
				onFileParsed?.(blocks.length)
				processedCount++
				if (!this.embedder || !this.qdrantClient) {
					this.cacheManager.updateHash(filePath, currentFileHash)
					return
				}
				totalBlockCount += blocks.length

				writes.push(
					writeLimiter(async () => {
						if (signal?.aborted) return
						const indexed = await writer.replace(filePath, currentFileHash, blocks, signal)
						if (indexed) onBlocksIndexed?.(blocks.filter((block) => block.content.trim()).length)
					}),
				)
			}),
		)

		await Promise.all(parsePromises)
		await Promise.all(writes)

		if (signal?.aborted) {
			return { stats: { processed: processedCount, skipped: skippedCount }, totalBlockCount }
		}

		const removalCandidates = new Map<string, string>()
		for (const cachedFilePath of Object.keys(this.cacheManager.getAllHashes())) {
			removalCandidates.set(generateRelativeFilePath(cachedFilePath, scanWorkspace), cachedFilePath)
		}
		// A file whose first write failed has no hash, but its failure entry means partial points may exist.
		for (const failure of this.failures.list()) {
			if (!removalCandidates.has(failure.path)) {
				removalCandidates.set(failure.path, generateNormalizedAbsolutePath(failure.path, scanWorkspace))
			}
		}
		const processedRelative = new Set(
			[...processedFiles].map((filePath) => generateRelativeFilePath(filePath, scanWorkspace)),
		)
		for (const [relativePath, removedFilePath] of removalCandidates) {
			if (processedRelative.has(relativePath)) continue
			if (signal?.aborted) break
			const removed = await writer.remove(removedFilePath, signal)
			if (!removed && !signal?.aborted) {
				this.reportError(
					new Error(t("embeddings:scanner.unknownErrorDeletingPoints", { filePath: removedFilePath })),
					"scanDirectory:deleteRemovedFiles",
					removedFilePath,
					scanWorkspace,
					onError,
				)
			}
		}

		return { stats: { processed: processedCount, skipped: skippedCount }, totalBlockCount }
	}

	private reportError(
		error: unknown,
		location: string,
		filePath: string,
		scanWorkspace: string,
		onError?: (error: Error) => void,
	): void {
		console.error(`Error processing file ${filePath} in workspace ${scanWorkspace}:`, error)
		TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
			error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
			stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
			location,
		})
		onError?.(
			error instanceof Error
				? new Error(`${error.message} (Workspace: ${scanWorkspace}, File: ${filePath})`)
				: new Error(
						t("embeddings:scanner.unknownErrorProcessingFile", { filePath }) +
							` (Workspace: ${scanWorkspace})`,
					),
		)
	}
}
