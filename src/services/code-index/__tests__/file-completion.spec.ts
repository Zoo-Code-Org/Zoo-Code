import "./mock-code-index-log"
import { v5 as uuidv5 } from "uuid"
import { FileCompletion, FileIndexWriter } from "../file-completion"
import { IndexWriteGate, LATE_WRITE_GRACE_MS } from "../index-write-gate"
import { QDRANT_CODE_BLOCK_NAMESPACE } from "../constants"
import type { CodeBlock, IVectorStore } from "../interfaces"
import type { CacheManager } from "../cache-manager"
import type { GenerationAllocator } from "../generation-allocator"
import { makeRateLimitScope, ProviderPacerRegistry } from "../provider-pacer"
import { FileFailureRegistry } from "../file-failure-registry"

function deferred<Value = void>() {
	let resolve!: (value: Value) => void
	let reject!: (error: Error) => void
	const promise = new Promise<Value>((complete, fail) => {
		resolve = complete
		reject = fail
	})
	return { promise, resolve, reject }
}

describe("FileCompletion", () => {
	it("does not finish when an early batch settles before the final batch is registered", async () => {
		const finish = vi.fn().mockResolvedValue(undefined)
		const completion = new FileCompletion(finish)
		completion.register()
		await completion.settled(true)
		expect(completion.outstanding).toBe(0)
		expect(finish).not.toHaveBeenCalled()
		completion.register()
		await completion.registered()
		expect(finish).not.toHaveBeenCalled()
		await completion.settled(true)
		expect(finish).toHaveBeenCalledOnce()
	})

	it("finishes an empty file once and rejects registration after the file is closed", async () => {
		const finish = vi.fn().mockResolvedValue(undefined)
		const completion = new FileCompletion(finish)
		await completion.registered()
		await completion.registered()
		expect(finish).toHaveBeenCalledOnce()
		expect(() => completion.register()).toThrow("registration already complete")
	})

	it.each(["before registration", "after registration"])("keeps a failed file incomplete %s", async (timing) => {
		const finish = vi.fn()
		const completion = new FileCompletion(finish)
		completion.register()
		completion.register()
		if (timing === "after registration") await completion.registered()
		await completion.settled(false)
		if (timing === "before registration") await completion.registered()
		await completion.settled(true)
		expect(completion.failed).toBe(true)
		expect(completion.outstanding).toBe(0)
		expect(finish).not.toHaveBeenCalled()
	})

	it("shares a pending finish and never retries a failed finish", async () => {
		const held = deferred()
		const finish = vi.fn(() => held.promise)
		const completion = new FileCompletion(finish)
		const first = completion.registered()
		const second = completion.registered()
		const firstRejected = expect(first).rejects.toThrow("Verification failed")
		const secondRejected = expect(second).rejects.toThrow("Verification failed")
		expect(finish).toHaveBeenCalledOnce()
		held.reject(new Error("Verification failed"))
		await Promise.all([firstRejected, secondRejected])
		expect(completion.failed).toBe(true)
		await completion.registered()
		expect(finish).toHaveBeenCalledOnce()
	})
})

function createWriterDoubles() {
	return {
		cache: {
			invalidateFile: vi.fn<(filePath: string) => Promise<void>>().mockResolvedValue(undefined),
			completeFile: vi.fn<(filePath: string, hash: string) => void>(),
			completeRemoval: vi.fn<(filePath: string) => void>(),
		},
		store: {
			rateLimitScope: "qdrant:writer-test",
			upsertPoints: vi.fn<IVectorStore["upsertPoints"]>().mockResolvedValue(undefined),
			deletePointsByFilePath: vi
				.fn<(filePath: string, generation: number) => Promise<void>>()
				.mockResolvedValue(undefined),
			countPointsForFile: vi
				.fn<(filePath: string, generation: number) => Promise<{ current: number; other: number }>>()
				.mockResolvedValue({ current: 2, other: 0 }),
		},
		generations: { allocate: vi.fn<GenerationAllocator["allocate"]>().mockResolvedValue(17) },
		embedder: {
			createEmbeddings: vi.fn(async (texts: string[]) => ({ embeddings: texts.map(() => [0.1, 0.2]) })),
			rateLimitScope: "openai:writer-test",
			validateConfiguration: vi.fn(async () => ({ valid: true })),
			embedderInfo: { name: "openai" as const },
		},
	}
}

function createWriter(
	doubles: Pick<ReturnType<typeof createWriterDoubles>, "cache" | "store" | "generations">,
	gate: IndexWriteGate,
	failures: FileFailureRegistry,
) {
	// Doubles expose invalidation/completion, vector mutations/counts, and allocation without unrelated dependencies.
	return new FileIndexWriter(
		doubles.cache as unknown as CacheManager,
		doubles.store as unknown as IVectorStore,
		gate,
		doubles.generations as unknown as GenerationAllocator,
		"/workspace",
		failures,
	)
}

describe("FileIndexWriter", () => {
	const filePath = "/workspace/file.ts"
	let cache: ReturnType<typeof createWriterDoubles>["cache"]
	let store: ReturnType<typeof createWriterDoubles>["store"]
	let generations: ReturnType<typeof createWriterDoubles>["generations"]
	let embedder: ReturnType<typeof createWriterDoubles>["embedder"]
	let gate: IndexWriteGate
	let attempt: AbortController
	let writer: FileIndexWriter
	let failures: FileFailureRegistry

	function blocks(count: number): CodeBlock[] {
		return Array.from({ length: count }, (_, offset) => ({
			file_path: filePath,
			identifier: null,
			type: "function",
			start_line: 1,
			end_line: 1,
			content: ` block ${offset} `,
			fileHash: "hash",
			segmentHash: `segment-${offset}`,
		}))
	}

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(100_000)
		;({ cache, store, generations, embedder } = createWriterDoubles())
		gate = new IndexWriteGate()
		attempt = new AbortController()
		failures = new FileFailureRegistry()
		writer = createWriter({ cache, store, generations }, gate, failures)
	})

	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it.each(["embed", "upsert", "delete", "verify", "remove"])(
		"retries only %s at 500/1000 ms and preserves its generation",
		async (activity) => {
			const request =
				activity === "embed"
					? embedder.createEmbeddings
					: activity === "upsert"
						? store.upsertPoints
						: activity === "verify"
							? store.countPointsForFile
							: store.deletePointsByFilePath
			request.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }))
			request.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }))

			const records = vi.fn()
			failures.onDidRecord(records)
			const pending =
				activity === "remove"
					? writer.remove(filePath, attempt.signal)
					: writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal)
			await vi.advanceTimersByTimeAsync(0)
			expect(request).toHaveBeenCalledTimes(1)
			expect(failures.list()[0]).toMatchObject({ attempt: 1, state: "retrying", classification: "server" })
			await vi.advanceTimersByTimeAsync(499)
			expect(request).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(1)
			expect(request).toHaveBeenCalledTimes(2)
			await vi.advanceTimersByTimeAsync(999)
			expect(request).toHaveBeenCalledTimes(2)
			await vi.advanceTimersByTimeAsync(1)
			expect(request).toHaveBeenCalledTimes(3)
			await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS)
			await pending
			expect(generations.allocate).toHaveBeenCalledOnce()
			expect(embedder.createEmbeddings).toHaveBeenCalledTimes(
				activity === "embed" ? 3 : activity === "remove" ? 0 : 1,
			)
			expect(records).toHaveBeenCalledTimes(2)
			expect(failures.list()).toEqual([])
		},
	)

	it.each(["embed", "upsert"])("shares exactly two %s retries across batches", async (activity) => {
		const request = activity === "embed" ? embedder.createEmbeddings : store.upsertPoints
		request.mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ status: 503 })
		if (activity === "embed") embedder.createEmbeddings.mockResolvedValueOnce({ embeddings: [[0.1]] })
		else store.upsertPoints.mockResolvedValueOnce(undefined)
		request.mockRejectedValue({ status: 503 })
		const pending = writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal, 1).catch((error) => error)
		await vi.advanceTimersByTimeAsync(1500)
		expect(await pending).toMatchObject({ activity, attempts: 3 })
		expect(request).toHaveBeenCalledTimes(4)
		expect(failures.list()[0]).toMatchObject({ activity, attempt: 3, state: "exhausted" })
		await expect(writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal, 1)).rejects.toThrow()
		expect(request).toHaveBeenCalledTimes(4)
	})

	it("does not charge successful batch first calls against retries", async () => {
		await writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal, 1)
		expect(embedder.createEmbeddings).toHaveBeenCalledTimes(2)
		expect(store.upsertPoints).toHaveBeenCalledTimes(2)
		expect(failures.list()).toEqual([])
	})

	it("keeps exhausted store budgets across writer recreation and unrelated renewal", async () => {
		store.upsertPoints.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 503 }))
		const pending = writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal).catch((error) => error)
		await vi.advanceTimersByTimeAsync(1500)
		expect(await pending).toMatchObject({ activity: "upsert", attempts: 3, classification: "server" })
		failures.renew("other.ts", "new")
		const recreated = createWriter({ cache, store, generations }, gate, failures)
		await expect(recreated.replace(filePath, "hash", blocks(2), embedder, attempt.signal)).rejects.toThrow(
			"unavailable",
		)
		expect(store.upsertPoints).toHaveBeenCalledTimes(3)
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(failures.list()[0]).toMatchObject({ attempt: 3, state: "exhausted" })
	})

	it.each(["allocation", "invalidation"])(
		"exhausts a new revision after %s fails despite an old entry",
		async (stage) => {
			store.upsertPoints.mockRejectedValue(Object.assign(new Error("old server failure"), { status: 503 }))
			const old = writer.replace(filePath, "r1", blocks(2), embedder, attempt.signal).catch((error) => error)
			await vi.advanceTimersByTimeAsync(1500)
			expect(await old).toMatchObject({ attempts: 3 })
			const failingOperation = stage === "allocation" ? generations.allocate : cache.invalidateFile
			failingOperation.mockRejectedValue(new Error(`new ${stage} failure`))
			const records = vi.fn()
			failures.onDidRecord(records)

			await expect(writer.replace(filePath, "r2", blocks(2), embedder, attempt.signal)).rejects.toThrow(
				`new ${stage} failure`,
			)
			const calls = failingOperation.mock.calls.length
			await expect(writer.replace(filePath, "r2", blocks(2), embedder, attempt.signal)).rejects.toThrow(
				`new ${stage} failure`,
			)
			expect(failingOperation).toHaveBeenCalledTimes(calls)
			expect(records).toHaveBeenCalledOnce()
			expect(failures.list()[0]).toMatchObject({
				revision: "r2",
				reason: `new ${stage} failure`,
				attempt: 1,
				state: "exhausted",
			})
			expect(store.upsertPoints).toHaveBeenCalledTimes(3)
		},
	)

	it.each(["allocation", "invalidation"])(
		"exhausts a retained successful retry when the same revision later fails %s",
		async (stage) => {
			failures.renew("file.ts", "hash")
			const request = vi
				.fn()
				.mockRejectedValueOnce(Object.assign(new Error("temporary failure"), { status: 503 }))
			const retry = writer.retryTransient(request, {
				signal: attempt.signal,
				file: filePath,
				revision: "hash",
				activity: "embed",
			})
			await vi.advanceTimersByTimeAsync(500)
			await retry
			expect(failures.list()[0]).toMatchObject({ state: "retrying", attempt: 1 })
			const failingOperation = stage === "allocation" ? generations.allocate : cache.invalidateFile
			failingOperation.mockRejectedValue(new Error(`${stage} failed`))
			await expect(writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal)).rejects.toThrow(
				`${stage} failed`,
			)
			expect(failures.list()[0]).toMatchObject({
				activity: "embed",
				reason: "temporary failure",
				attempt: 1,
				classification: "server",
				state: "exhausted",
			})
			expect(cache.completeFile).not.toHaveBeenCalled()
		},
	)

	it.each(["allocation", "invalidation"])(
		"exhausts recovered retries when completion fails before a later %s failure",
		async (stage) => {
			embedder.createEmbeddings.mockRejectedValueOnce(
				Object.assign(new Error("temporary embedding failure"), { status: 503 }),
			)
			cache.completeFile.mockImplementation(() => {
				throw new Error("completion failed")
			})
			const pending = writer
				.replace(filePath, "hash", blocks(2), embedder, attempt.signal)
				.catch((error) => error)
			await vi.advanceTimersByTimeAsync(500)
			expect(await pending).toMatchObject({ message: "completion failed" })
			expect(embedder.createEmbeddings).toHaveBeenCalledTimes(2)
			expect(store.countPointsForFile).toHaveBeenCalledOnce()
			const failure = {
				activity: "embed",
				reason: "temporary embedding failure",
				attempt: 1,
				classification: "server",
				state: "exhausted",
			}
			expect(failures.list()[0]).toMatchObject(failure)
			expect(failures.getFailure("file.ts", "hash", "embed")).toMatchObject(failure)

			const failingOperation = stage === "allocation" ? generations.allocate : cache.invalidateFile
			failingOperation.mockRejectedValue(new Error(`later ${stage} failure`))
			const calls = failingOperation.mock.calls.length
			await expect(writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal)).rejects.toThrow(
				"temporary embedding failure",
			)
			expect(failingOperation).toHaveBeenCalledTimes(calls)
			expect(failures.list()[0]).toMatchObject(failure)
		},
	)

	it("T35 a different API key completes through the writer while the original allowance remains paused", async () => {
		const pacers = new ProviderPacerRegistry()
		const originalScope = makeRateLimitScope("openai", "https://api.example.test/v1", "first-test-key")
		const independentScope = makeRateLimitScope("openai", "https://api.example.test/v1", "second-test-key")
		const paused = pacers.get(originalScope)
		paused.reportRateLimit({ status: 429, retryAfterMs: 30_000 }, paused.markIssued())
		const resumeAt = paused.state().pausedUntil
		embedder.rateLimitScope = independentScope
		// These doubles provide cache completion, store writes/counts, and generation allocation.
		writer = new FileIndexWriter(
			cache as unknown as CacheManager,
			store as unknown as IVectorStore,
			gate,
			generations as unknown as GenerationAllocator,
			"/workspace",
			failures,
			pacers,
		)
		await writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal)
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(store.upsertPoints).toHaveBeenCalledOnce()
		expect(cache.completeFile).toHaveBeenCalledWith(filePath, "hash")
		expect(paused.state().pausedUntil).toBe(resumeAt)
		expect(pacers.get(independentScope).state().pausedUntil).toBeUndefined()
		expect(failures.list()).toEqual([])
	})

	it("T41 an upsert aborted inside a paused pacer never enters the gate or incurs grace", async () => {
		const pacers = new ProviderPacerRegistry()
		// These doubles provide cache completion, store writes/counts, and generation allocation.
		writer = new FileIndexWriter(
			cache as unknown as CacheManager,
			store as unknown as IVectorStore,
			gate,
			generations as unknown as GenerationAllocator,
			"/workspace",
			failures,
			pacers,
		)
		const pacer = pacers.get(store.rateLimitScope)
		pacer.reportRateLimit({ status: 429, retryAfterMs: 30_000 }, pacer.markIssued())
		const pending = writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal).catch((error) => error)
		await vi.advanceTimersByTimeAsync(0)
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(pacer.state().waitingPaths).toEqual(["file.ts"])
		expect(gate.hasPending(attempt.signal)).toBe(false)
		expect(store.upsertPoints).not.toHaveBeenCalled()
		attempt.abort()
		expect(await pending).toBe(attempt.signal.reason)
		expect(gate.uncertainFiles(attempt.signal)).toEqual([])
		expect(gate.graceDeadline(filePath)).toBe(0)
		expect(gate.needsReconciliation(filePath)).toBe(false)
		await gate.settled(attempt.signal)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(store.upsertPoints).not.toHaveBeenCalled()
		expect(cache.completeFile).not.toHaveBeenCalled()
		expect(failures.list()).toEqual([])
	})

	it.each(["permanent", "abort", "revision"])("ends automatic attempts for %s", async (ending) => {
		embedder.createEmbeddings.mockRejectedValue(
			Object.assign(new Error("failed"), {
				status: ending === "permanent" ? 401 : 503,
			}),
		)
		const pending = writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal).catch((error) => error)
		await vi.advanceTimersByTimeAsync(0)
		if (ending === "abort") attempt.abort()
		if (ending === "revision") {
			failures.renew("file.ts", "new")
			failures.record("file.ts", "new", "read", "new failure", 1, "exhausted")
		}
		await vi.advanceTimersByTimeAsync(1500)
		await pending
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(store.upsertPoints).not.toHaveBeenCalled()
		expect(failures.list()[0].state).toBe("exhausted")
		if (ending === "revision") expect(failures.list()[0].reason).toBe("new failure")
	})

	it("discards issued old-revision embeddings without mutating the new failure", async () => {
		const held = deferred<{ embeddings: number[][] }>()
		embedder.createEmbeddings.mockReturnValueOnce(held.promise)
		const pending = writer.replace(filePath, "old", blocks(2), embedder, attempt.signal).catch((error) => error)
		await vi.advanceTimersByTimeAsync(0)
		failures.renew("file.ts", "new")
		failures.record("file.ts", "new", "parse", "new failure", 1, "exhausted")
		held.resolve({ embeddings: [[1], [1]] })
		expect(await pending).toMatchObject({ name: "AbortError" })
		expect(store.upsertPoints).not.toHaveBeenCalled()
		expect(cache.completeFile).not.toHaveBeenCalled()
		expect(failures.list()[0].reason).toBe("new failure")
	})

	it("waits for an issued superseded revision save before completing the newer revision", async () => {
		const held = deferred()
		store.upsertPoints.mockReturnValueOnce(held.promise)
		const old = writer.replace(filePath, "old", blocks(2), embedder, attempt.signal).catch((error) => error)
		await vi.advanceTimersByTimeAsync(0)
		const current = writer.replace(filePath, "new", blocks(2), embedder, attempt.signal)
		await vi.advanceTimersByTimeAsync(0)
		expect(store.upsertPoints).toHaveBeenCalledTimes(2)
		expect(cache.completeFile).not.toHaveBeenCalled()
		held.resolve()
		await current
		expect(await old).toMatchObject({ name: "AbortError" })
		expect(cache.completeFile).toHaveBeenCalledExactlyOnceWith(filePath, "new")
		expect(store.countPointsForFile).toHaveBeenCalledTimes(2)
	})

	it("awaits durable invalidation before any embedding or vector mutation", async () => {
		const held = deferred()
		cache.invalidateFile.mockReturnValue(held.promise)
		const pending = writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal)
		await vi.advanceTimersByTimeAsync(0)
		expect(cache.invalidateFile).toHaveBeenCalledWith(filePath)
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expect(store.upsertPoints).not.toHaveBeenCalled()
		expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
		held.resolve()
		await pending
		expect(cache.completeFile).toHaveBeenCalledWith(filePath, "hash")
	})

	it.each(["replace", "remove"] as const)(
		"issues no vector mutation when %s invalidation fails",
		async (operation) => {
			cache.invalidateFile.mockRejectedValue(new Error("Disk full"))
			const pending =
				operation === "replace"
					? writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal)
					: writer.remove(filePath, attempt.signal)
			await expect(pending).rejects.toThrow("Disk full")
			expect(store.upsertPoints).not.toHaveBeenCalled()
			expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
			expect(cache.completeFile).not.toHaveBeenCalled()
			expect(cache.completeRemoval).not.toHaveBeenCalled()
			expect(gate.needsReconciliation(filePath)).toBe(false)
			expect(failures.list()).toEqual([
				expect.objectContaining({
					path: "file.ts",
					revision: operation === "replace" ? "hash" : "removed",
					activity: operation === "replace" ? "upsert" : "delete",
					reason: "Disk full",
					state: "exhausted",
				}),
			])
		},
	)

	it.each(["replace", "remove"] as const)("records %s allocation failures before any mutation", async (operation) => {
		generations.allocate.mockRejectedValue(new Error("watermark save failed"))
		const pending =
			operation === "replace"
				? writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal)
				: writer.remove(filePath, attempt.signal)
		await expect(pending).rejects.toThrow("watermark save failed")
		expect(cache.invalidateFile).not.toHaveBeenCalled()
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expect(store.upsertPoints).not.toHaveBeenCalled()
		expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
		expect(failures.list()[0]).toMatchObject({
			path: "file.ts",
			activity: operation === "replace" ? "upsert" : "delete",
			reason: "watermark save failed",
			state: "exhausted",
			classification: "permanent",
		})
	})

	it("upserts every registered batch before fenced cleanup, verification, hash and progress", async () => {
		const finalBatch = deferred()
		store.upsertPoints.mockResolvedValueOnce(undefined).mockReturnValueOnce(finalBatch.promise)
		const onComplete = vi.fn()
		const pending = writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal, 1, onComplete)
		await vi.advanceTimersByTimeAsync(0)
		expect(store.upsertPoints).toHaveBeenCalledTimes(2)
		expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
		expect(cache.completeFile).not.toHaveBeenCalled()
		finalBatch.resolve()
		await pending
		expect(store.deletePointsByFilePath).toHaveBeenCalledWith(filePath, 17)
		expect(store.countPointsForFile).toHaveBeenCalledWith(filePath, 17)
		expect(cache.completeFile).toHaveBeenCalledWith(filePath, "hash")
		expect(onComplete).toHaveBeenCalledWith(2)
		expect(store.upsertPoints.mock.invocationCallOrder[1]).toBeLessThan(
			store.deletePointsByFilePath.mock.invocationCallOrder[0],
		)
		expect(store.countPointsForFile.mock.invocationCallOrder[0]).toBeLessThan(
			cache.completeFile.mock.invocationCallOrder[0],
		)
		expect(embedder.createEmbeddings).toHaveBeenNthCalledWith(1, ["block 0"], undefined, expect.any(AbortSignal))
		const points = store.upsertPoints.mock.calls.flatMap(([batch]) => batch)
		expect(points.map((point) => point.id)).toEqual([
			uuidv5("segment-0:17", QDRANT_CODE_BLOCK_NAMESPACE),
			uuidv5("segment-1:17", QDRANT_CODE_BLOCK_NAMESPACE),
		])
		expect(points[0].payload).toMatchObject({ filePath: "file.ts", generation: 17, segmentHash: "segment-0" })
		expect(new Set(points.map((point) => point.id)).size).toBe(2)
	})

	it.each([
		{ current: 1, other: 0 },
		{ current: 2, other: 1 },
	])("does not complete a file with missing or stale points (%j)", async (counts) => {
		store.countPointsForFile.mockResolvedValue(counts)
		await expect(writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal)).rejects.toThrow(
			"verification failed",
		)
		expect(cache.completeFile).not.toHaveBeenCalled()
	})

	it("cleans and verifies a zero-content file without embedding", async () => {
		store.countPointsForFile.mockResolvedValue({ current: 0, other: 0 })
		const whitespace = blocks(1)
		whitespace[0].content = " \n\t"
		await writer.replace(filePath, "hash", whitespace, embedder, attempt.signal)
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expect(store.upsertPoints).not.toHaveBeenCalled()
		expect(store.deletePointsByFilePath).toHaveBeenCalledWith(filePath, 17)
		expect(cache.completeFile).toHaveBeenCalledWith(filePath, "hash")
	})

	it("does not issue cleanup or completion after a failed batch", async () => {
		store.upsertPoints.mockRejectedValueOnce(new Error("Upsert failed"))
		await expect(writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal, 1)).rejects.toThrow(
			"Upsert failed",
		)
		expect(embedder.createEmbeddings).toHaveBeenCalledTimes(1)
		expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
		expect(cache.completeFile).not.toHaveBeenCalled()
		expect(gate.needsReconciliation(filePath)).toBe(true)
	})

	it("rejects incomplete embeddings without issuing an upsert", async () => {
		embedder.createEmbeddings.mockResolvedValue({ embeddings: [[0.1]] })
		await expect(writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal)).rejects.toThrow(
			"Incomplete embeddings",
		)
		expect(store.upsertPoints).not.toHaveBeenCalled()
		expect(cache.completeFile).not.toHaveBeenCalled()
	})

	it("discards late embedding results after cancellation without issuing subsequent batches", async () => {
		const held = deferred<{ embeddings: number[][] }>()
		embedder.createEmbeddings.mockReturnValueOnce(held.promise)
		const pending = writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal, 1)
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
		await vi.advanceTimersByTimeAsync(0)
		attempt.abort()
		held.resolve({ embeddings: [[0.1]] })
		await rejected
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(store.upsertPoints).not.toHaveBeenCalled()
		expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
		expect(cache.completeFile).not.toHaveBeenCalled()
	})

	it.each(["complete", "stale", "cancel"])(
		"keeps an uncertain file incomplete through grace (%s)",
		async (outcome) => {
			gate.recover([filePath])
			const onComplete = vi.fn()
			const pending = writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal, 1, onComplete)
			const observed = pending.catch((error) => error)
			await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS - 1)
			expect(store.countPointsForFile).toHaveBeenCalledTimes(1)
			expect(cache.completeFile).not.toHaveBeenCalled()
			expect(cache.completeRemoval).not.toHaveBeenCalled()
			expect(onComplete).not.toHaveBeenCalled()
			if (outcome === "cancel") attempt.abort()
			if (outcome === "stale") store.countPointsForFile.mockResolvedValue({ current: 2, other: 1 })
			await vi.advanceTimersByTimeAsync(1)
			const result = await observed
			if (outcome === "complete") {
				expect(result).toBeUndefined()
				expect(store.countPointsForFile).toHaveBeenCalledTimes(2)
				expect(cache.completeFile).toHaveBeenCalledWith(filePath, "hash")
				expect(onComplete).toHaveBeenCalledOnce()
				expect(gate.needsReconciliation(filePath)).toBe(false)
			} else {
				expect(result).toMatchObject(
					outcome === "cancel"
						? { name: "AbortError" }
						: { message: expect.stringContaining("verification failed") },
				)
				expect(cache.completeFile).not.toHaveBeenCalled()
				expect(onComplete).not.toHaveBeenCalled()
				expect(gate.needsReconciliation(filePath)).toBe(true)
			}
		},
	)

	it("extends grace when another uncertainty arrives during final verification", async () => {
		gate.recover([filePath])
		const heldCounts = deferred<{ current: number; other: number }>()
		store.countPointsForFile.mockResolvedValueOnce({ current: 2, other: 0 }).mockReturnValueOnce(heldCounts.promise)
		const pending = writer.replace(filePath, "hash", blocks(2), embedder, attempt.signal)
		await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS)
		expect(store.countPointsForFile).toHaveBeenCalledTimes(2)
		gate.recover([filePath])
		heldCounts.resolve({ current: 2, other: 0 })
		await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS - 1)
		expect(cache.completeFile).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await pending
		expect(store.countPointsForFile).toHaveBeenCalledTimes(3)
		expect(cache.completeFile).toHaveBeenCalledWith(filePath, "hash")
	})

	it("invalidates a completed file before removal and drops its open record only after success", async () => {
		const invalidation = deferred()
		const deletion = deferred()
		cache.invalidateFile.mockReturnValue(invalidation.promise)
		store.deletePointsByFilePath.mockReturnValue(deletion.promise)
		const pending = writer.remove(filePath, attempt.signal)
		await vi.advanceTimersByTimeAsync(0)
		expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
		invalidation.resolve()
		await vi.advanceTimersByTimeAsync(0)
		expect(store.deletePointsByFilePath).toHaveBeenCalledWith(filePath, 17)
		expect(cache.completeRemoval).not.toHaveBeenCalled()
		deletion.resolve()
		await pending
		expect(cache.completeRemoval).toHaveBeenCalledWith(filePath)
	})

	it("retains the open record after an uncertain removal failure", async () => {
		store.deletePointsByFilePath.mockRejectedValue(new DOMException("Lost result", "AbortError"))
		await expect(writer.remove(filePath, attempt.signal)).rejects.toMatchObject({ name: "AbortError" })
		expect(cache.invalidateFile).toHaveBeenCalledWith(filePath)
		expect(cache.completeRemoval).not.toHaveBeenCalled()
		expect(gate.needsReconciliation(filePath)).toBe(true)
	})
})
