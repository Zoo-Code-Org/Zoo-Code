import { GenerationAllocator } from "../generation-allocator"
import { IndexWriteGate } from "../index-write-gate"
import type { CacheManager } from "../cache-manager"
import type { IVectorStore } from "../interfaces"

function setup(watermark: number | undefined = 0) {
	const cache = {
		generationWatermark: watermark as number | undefined,
		clearCacheFile: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		reserveGenerations: vi.fn(async (nextWatermark: number) => {
			cache.generationWatermark = nextWatermark
		}),
	}
	const store = {
		hasIndexedData: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
		clearCollection: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
	}
	// Doubles supply only durable generation reservation/reset and collection inspection/reset.
	const allocator = new GenerationAllocator(cache as unknown as CacheManager)
	const vectorStore = store as unknown as IVectorStore
	const signal = new AbortController().signal
	const gate = new IndexWriteGate()
	return { cache, store, allocator, vectorStore, signal, gate }
}

describe("GenerationAllocator", () => {
	it("awaits durable reservation before issuing a generation", async () => {
		const { cache, allocator, vectorStore, signal, gate } = setup()
		let release!: () => void
		const reservation = new Promise<void>((resolve) => {
			release = resolve
		})
		cache.reserveGenerations.mockReturnValueOnce(reservation)
		const initialized = vi.fn()
		const pending = allocator.initialize(vectorStore, signal, gate).then(initialized)
		await Promise.resolve()
		expect(cache.reserveGenerations).toHaveBeenCalledWith(1024)
		expect(initialized).not.toHaveBeenCalled()
		release()
		await pending
		await expect(allocator.allocate()).resolves.toBe(1)
	})

	it("serializes allocations and reserves only when the 1024-value block runs out", async () => {
		const { cache, allocator, vectorStore, signal, gate } = setup()
		await allocator.initialize(vectorStore, signal, gate)
		const generations = await Promise.all(Array.from({ length: 1024 }, () => allocator.allocate()))
		expect(generations).toEqual(Array.from({ length: 1024 }, (_, offset) => offset + 1))
		expect(cache.reserveGenerations).toHaveBeenCalledExactlyOnceWith(1024)
		await expect(allocator.allocate()).resolves.toBe(1025)
		expect(cache.reserveGenerations).toHaveBeenLastCalledWith(2048)
	})

	it("resumes above the entire durable block without consulting the clock", async () => {
		const { cache, allocator, vectorStore, signal, gate } = setup(4096)
		await allocator.initialize(vectorStore, signal, gate)
		await expect(allocator.allocate()).resolves.toBe(4097)
		expect(cache.reserveGenerations).toHaveBeenCalledWith(5120)
		expect(cache.clearCacheFile).not.toHaveBeenCalled()
	})

	it.each([false, true])("resets unknown ordering with indexed data %s", async (hasData) => {
		const { cache, store, allocator, vectorStore, signal, gate } = setup()
		cache.generationWatermark = undefined
		store.hasIndexedData.mockResolvedValue(hasData)
		await allocator.initialize(vectorStore, signal, gate)
		expect(store.clearCollection).toHaveBeenCalledTimes(hasData ? 1 : 0)
		expect(cache.clearCacheFile).toHaveBeenCalledOnce()
		expect(cache.reserveGenerations).toHaveBeenCalledWith(1024)
	})

	it("refuses initialization after reset failure without reserving", async () => {
		const { cache, store, allocator, vectorStore, signal, gate } = setup()
		cache.generationWatermark = undefined
		store.hasIndexedData.mockResolvedValue(true)
		store.clearCollection.mockRejectedValue(new Error("reset failed"))
		await expect(allocator.initialize(vectorStore, signal, gate)).rejects.toThrow("reset failed")
		expect(cache.reserveGenerations).not.toHaveBeenCalled()
	})

	it("recovers the allocation queue after reservation failure", async () => {
		const { cache, allocator } = setup(1024)
		cache.reserveGenerations.mockRejectedValueOnce(new Error("disk full"))
		await expect(allocator.allocate()).rejects.toThrow("disk full")
		await expect(allocator.allocate()).resolves.toBe(1025)
		expect(cache.reserveGenerations).toHaveBeenLastCalledWith(2048)
	})

	it("rejects cancellation without consuming a generation", async () => {
		const { allocator, vectorStore, signal, gate } = setup()
		await allocator.initialize(vectorStore, signal, gate)
		await expect(allocator.allocate(AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" })
		await expect(allocator.allocate(signal)).resolves.toBe(1)
	})

	it("rejects unsafe integer exhaustion before persistence", async () => {
		const { cache, allocator, vectorStore, signal, gate } = setup(Number.MAX_SAFE_INTEGER)
		await expect(allocator.initialize(vectorStore, signal, gate)).rejects.toThrow("counter exhausted")
		expect(cache.reserveGenerations).not.toHaveBeenCalled()
	})
})
