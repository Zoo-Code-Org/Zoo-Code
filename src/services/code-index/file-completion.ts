import { v5 as uuidv5 } from "uuid"
import type { CacheManager } from "./cache-manager"
import { GenerationAllocator } from "./generation-allocator"
import { IndexWriteGate } from "./index-write-gate"
import type { CodeBlock, IEmbedder, IVectorStore } from "./interfaces"
import { BATCH_SEGMENT_THRESHOLD, QDRANT_CODE_BLOCK_NAMESPACE } from "./constants"
import { FileFailureRegistry, REMOVAL_REVISION, type FileFailureActivity } from "./file-failure-registry"
import { ProviderPacerRegistry } from "./provider-pacer"
import { retryWithPolicy } from "./shared/retry-policy"
import { generateRelativeFilePath } from "./shared/get-relative-path"
import { throwIfAborted } from "./parser-errors"

export class FileCompletion {
	public registrationComplete = false
	public outstanding = 0
	public failed = false
	private finishing?: Promise<void>

	constructor(private readonly finish: () => Promise<void>) {}

	register(): void {
		if (this.registrationComplete) throw new Error("File registration already complete")
		this.outstanding++
	}

	async settled(success: boolean): Promise<void> {
		this.failed ||= !success
		this.outstanding--
		await this.tryComplete()
	}

	async registered(): Promise<void> {
		this.registrationComplete = true
		await this.tryComplete()
	}

	private async tryComplete(): Promise<void> {
		if (!this.registrationComplete || this.outstanding !== 0 || this.failed) return
		this.finishing ??= this.finish().catch((error) => {
			this.failed = true
			throw error
		})
		await this.finishing
	}
}

export class FileIndexWriter {
	private readonly owners = new WeakMap<AbortSignal, AbortSignal>()
	constructor(
		private readonly cache: CacheManager,
		private readonly store: IVectorStore,
		private readonly gate: IndexWriteGate,
		private readonly generations: GenerationAllocator,
		private readonly workspacePath: string,
		private readonly failures = new FileFailureRegistry(),
		private readonly pacers = new ProviderPacerRegistry(),
	) {}

	private async run<T>(signal: AbortSignal, operation: () => Promise<T>, files: string[] = []): Promise<T> {
		const owner = this.owners.get(signal) ?? signal
		// Track revision cancellation separately without treating a late successful save as a rejection.
		const outcome = await this.gate.run(
			signal,
			() =>
				this.gate
					.run(
						owner,
						() => {
							throwIfAborted(signal)
							return operation()
						},
						files,
					)
					.then(
						(value) => ({ value, error: undefined }),
						(error: unknown) => ({ value: undefined, error }),
					),
			files,
		)
		if (outcome.error !== undefined) throw outcome.error
		return outcome.value as T
	}

	async retryTransient<T>(
		operation: () => Promise<T>,
		options: {
			signal: AbortSignal
			activity: FileFailureActivity
			file: string
			revision: string
			rateLimitScope?: string
		},
	): Promise<T> {
		const { signal, activity, file, revision, rateLimitScope = this.store.rateLimitScope } = options
		const relativePath = generateRelativeFilePath(file, this.workspacePath)
		const previous = this.failures.getFailure(relativePath, revision, activity)
		if (previous?.state === "exhausted") throw Object.assign(new Error(previous.reason), previous)
		return await retryWithPolicy(
			() =>
				this.pacers
					.get(rateLimitScope)
					.run(relativePath, signal, () =>
						this.run(signal, operation, activity === "upsert" || activity === "delete" ? [file] : []),
					),
			{
				signal,
				activity,
				budget: this.failures.getRetryBudget(relativePath, revision, activity),
				onFailure: ({ error, attempt, willRetry, classification, ...delay }) => {
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
			},
		)
	}

	private async withRevision<T>(
		filePath: string,
		revision: string,
		parent: AbortSignal,
		operation: (signal: AbortSignal) => Promise<T>,
		owner = parent,
	): Promise<T> {
		throwIfAborted(parent)
		const relativePath = generateRelativeFilePath(filePath, this.workspacePath)
		const revisionSignal = this.failures.renew(relativePath, revision)
		const signal = AbortSignal.any([parent, revisionSignal])
		this.owners.set(signal, owner)
		try {
			this.failures.assertRetryable(relativePath, revision)
			return await operation(signal)
		} catch (error) {
			if (!signal.aborted && !this.failures.hasRevisionFailure(relativePath, revision)) {
				this.failures.record(
					relativePath,
					revision,
					revision === REMOVAL_REVISION ? "delete" : "upsert",
					error instanceof Error ? error.message : String(error),
					1,
					"exhausted",
				)
			}
			throw error
		} finally {
			const failure = this.failures.get(relativePath)
			if (!revisionSignal.aborted && failure?.revision === revision && failure.state === "retrying") {
				this.failures.record(
					relativePath,
					revision,
					failure.activity,
					failure.reason,
					failure.attempt,
					"exhausted",
					failure.classification,
				)
			}
		}
	}

	async remove(filePath: string, signal: AbortSignal, owner = signal): Promise<void> {
		return this.withRevision(
			filePath,
			REMOVAL_REVISION,
			signal,
			(current) => this.removeCurrent(filePath, current),
			owner,
		)
	}

	private async removeCurrent(filePath: string, signal: AbortSignal): Promise<void> {
		const generation = await this.generations.allocate(signal)
		await this.run(signal, () => this.cache.invalidateFile(filePath))
		await this.retryTransient(() => this.store.deletePointsByFilePath(filePath, generation), {
			signal,
			activity: "delete",
			file: filePath,
			revision: REMOVAL_REVISION,
		})
		throwIfAborted(signal)
		this.cache.completeRemoval(filePath)
		this.failures.clear(generateRelativeFilePath(filePath, this.workspacePath), REMOVAL_REVISION)
	}

	async replace(
		filePath: string,
		hash: string,
		blocks: CodeBlock[],
		embedder: IEmbedder,
		signal: AbortSignal,
		batchSize = BATCH_SEGMENT_THRESHOLD,
		onComplete?: (blockCount: number) => void,
		owner = signal,
	): Promise<void> {
		return this.withRevision(
			filePath,
			hash,
			signal,
			(current) => this.replaceCurrent(filePath, hash, blocks, embedder, current, batchSize, onComplete),
			owner,
		)
	}

	private async replaceCurrent(
		filePath: string,
		hash: string,
		blocks: CodeBlock[],
		embedder: IEmbedder,
		signal: AbortSignal,
		batchSize: number,
		onComplete?: (blockCount: number) => void,
	): Promise<void> {
		const generation = await this.generations.allocate(signal)
		await this.run(signal, () => this.cache.invalidateFile(filePath))
		const retryOptions = { signal, file: filePath, revision: hash }
		const selected = blocks.filter((block) => block.content.trim())
		const verify = async () => {
			throwIfAborted(signal)
			const counts = await this.retryTransient(() => this.store.countPointsForFile(filePath, generation), {
				...retryOptions,
				activity: "verify",
			})
			throwIfAborted(signal)
			if (counts.current !== selected.length || counts.other !== 0) {
				const reason = `Index verification failed for ${filePath}: expected ${selected.length}, current ${counts.current}, other ${counts.other}`
				this.failures.record(
					generateRelativeFilePath(filePath, this.workspacePath),
					hash,
					"verify",
					reason,
					1,
					"exhausted",
				)
				throw new Error(reason)
			}
		}
		const completion = new FileCompletion(async () => {
			await this.retryTransient(() => this.store.deletePointsByFilePath(filePath, generation), {
				...retryOptions,
				activity: "delete",
			})
			await verify()
			const waitedForPriorWrites = await this.gate.waitForPriorWrites(filePath, signal)
			if (this.gate.needsReconciliation(filePath)) {
				do {
					await this.gate.waitForGrace(filePath, signal)
					await verify()
				} while (this.gate.graceDeadline(filePath) > Date.now())
			} else if (waitedForPriorWrites) {
				await verify()
			}
			throwIfAborted(signal)
			this.cache.completeFile(filePath, hash)
			this.gate.reconciled(filePath)
			this.failures.clear(generateRelativeFilePath(filePath, this.workspacePath), hash)
			onComplete?.(selected.length)
		})
		const batches: CodeBlock[][] = []
		for (let offset = 0; offset < selected.length; offset += Math.max(1, batchSize)) {
			completion.register()
			batches.push(selected.slice(offset, offset + Math.max(1, batchSize)))
		}
		await completion.registered()
		for (const batch of batches) {
			try {
				throwIfAborted(signal)
				const { embeddings } = await this.retryTransient(
					async () => {
						const result = await embedder.createEmbeddings(
							batch.map((block) => block.content.trim()),
							undefined,
							signal,
						)
						if (result.embeddings.length !== batch.length)
							throw new Error(`Incomplete embeddings for ${filePath}`)
						return result
					},
					{ ...retryOptions, activity: "embed", rateLimitScope: embedder.rateLimitScope },
				)
				throwIfAborted(signal)
				const points = batch.map((block, index) => ({
					id: uuidv5(`${block.segmentHash}:${generation}`, QDRANT_CODE_BLOCK_NAMESPACE),
					vector: embeddings[index],
					payload: {
						filePath: generateRelativeFilePath(filePath, this.workspacePath),
						codeChunk: block.content,
						startLine: block.start_line,
						endLine: block.end_line,
						segmentHash: block.segmentHash,
						generation,
					},
				}))
				await this.retryTransient(() => this.store.upsertPoints(points), {
					...retryOptions,
					activity: "upsert",
				})
			} catch (error) {
				await completion.settled(false)
				throw error
			}
			await completion.settled(true)
		}
	}
}
