import { listFiles } from "../../glob/list-files"
import type { Ignore } from "ignore"
import { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import { stat } from "fs/promises"
import * as path from "path"
import { generateRelativeFilePath } from "../shared/get-relative-path"
import { getWorkspacePathForContext } from "../../../utils/path"
import { scannerExtensions } from "../shared/supported-extensions"
import * as vscode from "vscode"
import type { ICodeParser, IEmbedder, IVectorStore, IDirectoryScanner } from "../interfaces"
import { createHash } from "crypto"
import type { CacheManager } from "../cache-manager"
import {
	MAX_FILE_SIZE_BYTES,
	MAX_LIST_FILES_LIMIT_CODE_INDEX,
	BATCH_SEGMENT_THRESHOLD,
	PARSING_CONCURRENCY,
	BATCH_PROCESSING_CONCURRENCY,
} from "../constants"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"
import { Package } from "../../../shared/package"
import { IndexWriteGate } from "../index-write-gate"
import { abortError, ParserFatalError, throwIfAborted } from "../parser-errors"
import { GenerationAllocator } from "../generation-allocator"
import { FileIndexWriter } from "../file-completion"
import { FileFailureRegistry, UNKNOWN_REVISION, type FileFailureActivity } from "../file-failure-registry"
import { codeIndexLog } from "../code-index-log"
import { ProviderPacerRegistry } from "../provider-pacer"
import { readSource, SOURCE_MISSING } from "../shared/indexing-errors"

export class DirectoryScanner implements IDirectoryScanner {
	private readonly batchSegmentThreshold: number
	private incompleteFiles = new Set<string>()

	constructor(
		private readonly embedder: IEmbedder,
		private readonly qdrantClient: IVectorStore,
		private readonly codeParser: ICodeParser,
		private readonly cacheManager: CacheManager,
		private readonly ignoreInstance: Ignore,
		batchSegmentThreshold?: number,
		private readonly writeGate = new IndexWriteGate(),
		private readonly generations = new GenerationAllocator(cacheManager),
		private readonly failures = new FileFailureRegistry(),
		private readonly workspacePath?: string,
		private readonly isCurrentAttempt: () => boolean = () => true,
		private readonly providerPacers = new ProviderPacerRegistry(),
	) {
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

	public get hasIncompleteFiles(): boolean {
		return this.incompleteFiles.size > 0 || this.failures.list().length > 0
	}

	public async scanDirectory(
		directory: string,
		onError?: (error: Error) => void,
		onBlocksIndexed?: (indexedCount: number) => void,
		onFileParsed?: (fileBlockCount: number) => void,
		signal = new AbortController().signal,
	): Promise<{
		stats: { processed: number; skipped: number }
		totalBlockCount: number
		incompleteFiles?: string[]
	}> {
		const startedAt = Date.now()
		let processedCount = 0
		let skippedCount = 0
		let totalBlockCount = 0
		let indexedBlockCount = 0
		let partialReason: string | undefined
		let fatalError: ParserFatalError | undefined
		const checkActive = () => {
			throwIfAborted(signal)
			if (!this.isCurrentAttempt()) throw abortError()
			if (fatalError) throw fatalError
		}
		checkActive()
		const failureBatch = codeIndexLog.createFailureBatch({ source: "scan" })
		const subscription = this.failures.onDidRecord((failure) => {
			if (!signal.aborted && this.isCurrentAttempt()) {
				failureBatch.record({ ...failure, willRetry: failure.state === "retrying" })
			}
		})
		try {
			const incompleteFiles = new Set<string>()
			this.incompleteFiles = incompleteFiles
			const scanWorkspace = this.workspacePath ?? getWorkspacePathForContext(directory)
			const [allPaths] = await listFiles(directory, true, MAX_LIST_FILES_LIMIT_CODE_INDEX)
			checkActive()
			const ignoreController = new RooIgnoreController(directory)
			await ignoreController.initialize()
			checkActive()
			const allowedPaths = ignoreController.filterPaths(allPaths.filter((filePath) => !filePath.endsWith("/")))
			const selectedPaths = new Set(
				allowedPaths.filter((filePath) => {
					const relativePath = generateRelativeFilePath(filePath, scanWorkspace)
					return (
						!isPathInIgnoredDirectory(relativePath) &&
						scannerExtensions.includes(path.extname(filePath).toLowerCase()) &&
						!this.ignoreInstance.ignores(relativePath)
					)
				}),
			)
			// Discovery precedes dispatch so stopping during a read or parse still reports partial work.
			for (const filePath of selectedPaths) incompleteFiles.add(filePath)
			const trackedPaths = new Set([
				...this.cacheManager.getTrackedPaths(),
				...this.failures.list().map((failure) => path.resolve(scanWorkspace, failure.path)),
			])
			for (const filePath of trackedPaths) {
				if (!selectedPaths.has(filePath)) incompleteFiles.add(filePath)
			}

			const writer = new FileIndexWriter(
				this.cacheManager,
				this.qdrantClient,
				this.writeGate,
				this.generations,
				scanWorkspace,
				this.failures,
				this.providerPacers,
			)
			const reportError = (error: unknown, filePath: string) => {
				checkActive()
				if (error instanceof ParserFatalError) {
					fatalError = error
					throw error
				}
				if (error instanceof Error && error.name === "AbortError") throw error
				const message = codeIndexLog.redact(error instanceof Error ? error.message : String(error))
				const relativePath = generateRelativeFilePath(filePath, scanWorkspace)
				onError?.(new Error(`${message} (File: ${relativePath})`, { cause: error }))
			}
			const dropSelected = (filePath: string) => {
				selectedPaths.delete(filePath)
				if (!trackedPaths.has(filePath)) incompleteFiles.delete(filePath)
			}
			// A missing source falls into the removal phase; it is neither processed nor skipped.
			const dropMissing = (filePath: string, relativePath: string) => {
				codeIndexLog.debug("Source missing at read; treating as removed", { path: relativePath })
				dropSelected(filePath)
			}
			const processFile = async (filePath: string) => {
				checkActive()
				const relativePath = generateRelativeFilePath(filePath, scanWorkspace)
				let revision = this.failures.getRevision(relativePath) ?? UNKNOWN_REVISION
				this.failures.renew(relativePath, revision)
				let activity: FileFailureActivity = "read"
				let fileSignal = signal
				try {
					const stats = await readSource(stat(filePath))
					checkActive()
					if (stats === SOURCE_MISSING) return dropMissing(filePath, relativePath)
					if (stats.size > MAX_FILE_SIZE_BYTES) {
						dropSelected(filePath)
						skippedCount++
						return
					}
					const buffer = await readSource(vscode.workspace.fs.readFile(vscode.Uri.file(filePath)))
					checkActive()
					if (buffer === SOURCE_MISSING) return dropMissing(filePath, relativePath)
					const content = Buffer.from(buffer).toString("utf-8")
					const hash = createHash("sha256").update(content).digest("hex")
					revision = hash
					fileSignal = AbortSignal.any([signal, this.failures.renew(relativePath, hash)])
					this.writeGate.own(fileSignal, signal)
					if (
						this.cacheManager.getHash(filePath) === hash &&
						!this.writeGate.needsReconciliation(filePath) &&
						!this.failures.has(relativePath)
					) {
						incompleteFiles.delete(filePath)
						skippedCount++
						return
					}
					activity = "embed"
					this.failures.assertRetryable(relativePath, hash)
					activity = "parse"
					// Cancelling an active parse terminates the shared worker, so only the session may cancel it.
					const blocks = await this.codeParser.parseFile(filePath, {
						content,
						fileHash: hash,
						signal,
					})
					throwIfAborted(fileSignal)
					checkActive()
					processedCount++
					const selectedBlockCount = blocks.filter((block) => block.content.trim()).length
					onFileParsed?.(selectedBlockCount)
					checkActive()
					if (!this.embedder || !this.qdrantClient) return
					totalBlockCount += selectedBlockCount
					activity = "embed"
					await writer.replace(
						filePath,
						hash,
						blocks,
						this.embedder,
						fileSignal,
						this.batchSegmentThreshold,
						(count) => {
							checkActive()
							incompleteFiles.delete(filePath)
							indexedBlockCount += count
							onBlocksIndexed?.(count)
						},
						signal,
					)
				} catch (error) {
					checkActive()
					if (
						(activity === "read" || activity === "parse") &&
						!fileSignal.aborted &&
						!(error instanceof Error && error.name === "AbortError")
					) {
						this.failures.record(
							relativePath,
							revision,
							activity,
							codeIndexLog.redact(error instanceof Error ? error.message : String(error)),
							1,
							"exhausted",
						)
					}
					if (error instanceof ParserFatalError) reportError(error, filePath)
					if (fileSignal.aborted) return
					reportError(error, filePath)
				}
			}
			const processPaths = async (paths: string[], process: (filePath: string) => Promise<void>) => {
				let nextPath = 0
				const worker = async () => {
					while (nextPath < paths.length) {
						checkActive()
						const filePath = paths[nextPath++]
						await process(filePath)
					}
				}
				const concurrency = Math.min(PARSING_CONCURRENCY, BATCH_PROCESSING_CONCURRENCY, paths.length)
				await Promise.all(Array.from({ length: concurrency }, worker))
			}
			await processPaths([...selectedPaths], processFile)
			checkActive()

			const removedPaths = [...new Set([...trackedPaths, ...this.cacheManager.getTrackedPaths()])].filter(
				(filePath) => !selectedPaths.has(filePath),
			)
			for (const filePath of removedPaths) incompleteFiles.add(filePath)
			await processPaths(removedPaths, async (filePath) => {
				try {
					checkActive()
					if (!this.qdrantClient) return
					await writer.remove(filePath, signal)
					checkActive()
					incompleteFiles.delete(filePath)
				} catch (error) {
					reportError(error, filePath)
				}
			})
			checkActive()
			return {
				stats: { processed: processedCount, skipped: skippedCount },
				totalBlockCount,
				incompleteFiles: [...incompleteFiles],
			}
		} catch (error) {
			partialReason = error instanceof Error ? error.message : String(error)
			throw error
		} finally {
			subscription.dispose()
			failureBatch.flush()
			codeIndexLog.info("Scan summary", {
				processed: processedCount,
				skipped: skippedCount,
				failed: this.failures.list().length,
				blocksFound: totalBlockCount,
				blocksIndexed: indexedBlockCount,
				elapsedMs: Date.now() - startedAt,
				partialReason: partialReason ?? (this.hasIncompleteFiles ? "Unresolved files" : undefined),
			})
		}
	}
}
