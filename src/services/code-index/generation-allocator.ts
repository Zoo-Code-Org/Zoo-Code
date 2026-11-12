import type { CacheManager } from "./cache-manager"
import type { IVectorStore } from "./interfaces"
import { IndexWriteGate } from "./index-write-gate"
import { throwIfAborted } from "./parser-errors"

const GENERATION_BLOCK_SIZE = 1024

export class GenerationAllocator {
	private nextGeneration: number
	private reservedThrough: number
	private allocationTail: Promise<void> = Promise.resolve()
	private initialized = false

	constructor(private readonly cacheManager: CacheManager) {
		this.reservedThrough = cacheManager.generationWatermark ?? 0
		this.nextGeneration = this.reservedThrough + 1
	}

	async initialize(vectorStore: IVectorStore, signal: AbortSignal, gate: IndexWriteGate): Promise<void> {
		if (this.initialized) return
		throwIfAborted(signal)
		if (this.cacheManager.generationWatermark === undefined) {
			if (await vectorStore.hasIndexedData()) {
				await gate.run(signal, () => vectorStore.clearCollection())
			}
			throwIfAborted(signal)
			await this.cacheManager.clearCacheFile()
		}
		await this.reserve(signal)
		this.initialized = true
	}

	private async reserve(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal)
		const watermark =
			Math.max(this.reservedThrough, this.cacheManager.generationWatermark ?? 0) + GENERATION_BLOCK_SIZE
		if (!Number.isSafeInteger(watermark)) throw new Error("Index generation counter exhausted; clear index storage")
		await this.cacheManager.reserveGenerations(watermark)
		throwIfAborted(signal)
		this.reservedThrough = watermark
	}

	allocate(signal?: AbortSignal): Promise<number> {
		const allocation = this.allocationTail
			.catch(() => {})
			.then(async () => {
				throwIfAborted(signal)
				if (this.nextGeneration > this.reservedThrough) await this.reserve(signal)
				throwIfAborted(signal)
				return this.nextGeneration++
			})
		this.allocationTail = allocation.then(
			() => {},
			() => {},
		)
		return allocation
	}
}
