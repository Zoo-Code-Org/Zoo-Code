import { v5 as uuidv5 } from "uuid"
import type { CodeBlock, IEmbedder, IVectorStore, PointStruct } from "./interfaces"
import type { ICacheManager } from "./interfaces/cache"
import { BATCH_SEGMENT_THRESHOLD, QDRANT_CODE_BLOCK_NAMESPACE } from "./constants"
import { FileFailureRegistry, REMOVAL_REVISION, type FileFailureActivity } from "./file-failure-registry"
import type { ProviderPacerRegistry } from "./provider-pacer"
import { retryWithPolicy } from "./shared/retry-policy"
import { generateNormalizedAbsolutePath, generateRelativeFilePath } from "./shared/get-relative-path"

/** Embeds, saves and removes the blocks of one file; the only place code-index embeds run. */
export class FileIndexWriter {
	constructor(
		private readonly embedder: IEmbedder,
		private readonly store: IVectorStore,
		private readonly cache: Pick<ICacheManager, "getHash" | "updateHash" | "deleteHash">,
		private readonly failures: FileFailureRegistry,
		private readonly pacers: ProviderPacerRegistry,
		private readonly workspacePath: string,
		private readonly batchSize = BATCH_SEGMENT_THRESHOLD,
	) {}

	/** Replaces the file's points with `blocks`; returns false when the file failed and was recorded. */
	async replace(filePath: string, hash: string, blocks: CodeBlock[], signal?: AbortSignal): Promise<boolean> {
		const relativePath = generateRelativeFilePath(filePath, this.workspacePath)
		// A failed earlier attempt may have upserted some batches before any hash was stored.
		const mayHavePoints =
			this.cache.getHash(filePath) !== undefined ||
			this.failures.list().some((failure) => failure.path === relativePath)
		this.failures.renew(relativePath, hash)
		const selected = blocks.filter((block) => block.content.trim())
		try {
			if (mayHavePoints) {
				await this.attempt(relativePath, hash, "delete", this.store.rateLimitScope, signal, () =>
					this.store.deletePointsByFilePath(filePath),
				)
				// The old points are gone, so the old hash must not let an unchanged file skip re-indexing,
				// even when a stop landed while the delete was in flight.
				this.cache.deleteHash(filePath)
			}
			for (let offset = 0; offset < selected.length; offset += this.batchSize) {
				const batch = selected.slice(offset, offset + this.batchSize)
				const { embeddings } = await this.attempt(
					relativePath,
					hash,
					"embed",
					this.embedder.rateLimitScope,
					signal,
					() => this.embedder.createEmbeddings(batch.map((block) => block.content)),
				)
				const points = batch.map((block, index) => this.toPoint(block, embeddings[index]))
				await this.attempt(relativePath, hash, "upsert", this.store.rateLimitScope, signal, () =>
					this.store.upsertPoints(points),
				)
			}
		} catch (error) {
			if (signal?.aborted) throw error
			return false
		}
		if (signal?.aborted) return false
		this.cache.updateHash(filePath, hash)
		this.failures.clear(relativePath, hash)
		return true
	}

	/** Deletes the file's points and hash; returns false when the removal failed and was recorded. */
	async remove(filePath: string, signal?: AbortSignal): Promise<boolean> {
		const relativePath = generateRelativeFilePath(filePath, this.workspacePath)
		this.failures.renew(relativePath, REMOVAL_REVISION)
		try {
			await this.attempt(relativePath, REMOVAL_REVISION, "delete", this.store.rateLimitScope, signal, () =>
				this.store.deletePointsByFilePath(filePath),
			)
		} catch (error) {
			if (signal?.aborted) throw error
			return false
		}
		if (signal?.aborted) return false
		this.cache.deleteHash(filePath)
		this.failures.clear(relativePath, REMOVAL_REVISION)
		return true
	}

	private attempt<T>(
		relativePath: string,
		revision: string,
		activity: FileFailureActivity,
		scope: string,
		signal: AbortSignal | undefined,
		request: () => Promise<T>,
	): Promise<T> {
		return retryWithPolicy(() => this.pacers.get(scope).run(relativePath, signal, request), {
			signal,
			activity,
			budget: this.failures.getRetryBudget(relativePath, revision, activity),
			onFailure: ({ error, attempt, willRetry, classification, ...delay }) => {
				if (signal?.aborted) return
				this.failures.record(
					relativePath,
					revision,
					activity,
					error instanceof Error ? error.message : String(error),
					attempt,
					willRetry ? "retrying" : "exhausted",
					classification,
					delay,
				)
			},
		})
	}

	// Segment hash, not start line: segments split from one long line share a start line.
	private toPoint(block: CodeBlock, vector: number[]): PointStruct {
		const absolutePath = generateNormalizedAbsolutePath(block.file_path, this.workspacePath)
		return {
			id: uuidv5(block.segmentHash, QDRANT_CODE_BLOCK_NAMESPACE),
			vector,
			payload: {
				filePath: generateRelativeFilePath(absolutePath, this.workspacePath),
				codeChunk: block.content,
				startLine: block.start_line,
				endLine: block.end_line,
				segmentHash: block.segmentHash,
			},
		}
	}
}
