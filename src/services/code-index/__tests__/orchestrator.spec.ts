import { CodeIndexOrchestrator } from "../orchestrator"
import { ParserFatalError } from "../parser-errors"
import { INDEX_STOP_LIMIT_MS } from "../constants"
import { FileFailureRegistry } from "../file-failure-registry"
import { ProviderPacerRegistry } from "../provider-pacer"
import { EmbeddingError } from "../shared/indexing-errors"
import { CodeIndexStateManager } from "../state-manager"
import { codeIndexLog } from "../code-index-log"
import { IndexWriteGate } from "../index-write-gate"
import type { CacheManager } from "../cache-manager"
import type { CodeIndexConfigManager } from "../config-manager"
import type { GenerationAllocator } from "../generation-allocator"
import type { ParseWorkerClient } from "../parse-worker-client"
import type { IDirectoryScanner, IFileWatcher, IVectorStore } from "../interfaces"
import { clearAllMocks } from "../../../test-utils/reset"

vi.mock("../code-index-log", () => ({ codeIndexLog: { info: vi.fn(), error: vi.fn() } }))
vi.mock("vscode", () => ({
	workspace: { workspaceFolders: [{ uri: { fsPath: "/workspace" } }] },
	EventEmitter: class {
		event = vi.fn()
		fire = vi.fn()
		dispose = vi.fn()
	},
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

const scanResult = { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
function deferred() {
	let resolve!: () => void
	let reject!: (error: Error) => void
	const promise = new Promise<void>((complete, fail) => {
		resolve = complete
		reject = fail
	})
	return { promise, resolve, reject }
}
async function drain() {
	for (let iter = 0; iter < 50; iter++) await Promise.resolve()
}
function fixtures() {
	const cache = {
		getOpenFiles: vi.fn<CacheManager["getOpenFiles"]>(() => ({})),
		clearCacheFile: vi.fn<CacheManager["clearCacheFile"]>().mockResolvedValue(undefined),
		flush: vi.fn<CacheManager["flush"]>().mockResolvedValue(undefined),
		invalidateFile: vi.fn<CacheManager["invalidateFile"]>().mockResolvedValue(undefined),
	}
	const store = {
		initialize: vi.fn<IVectorStore["initialize"]>().mockResolvedValue(false),
		hasIndexedData: vi.fn<IVectorStore["hasIndexedData"]>().mockResolvedValue(false),
		markIndexingIncomplete: vi.fn<IVectorStore["markIndexingIncomplete"]>().mockResolvedValue(undefined),
		markIndexingComplete: vi.fn<IVectorStore["markIndexingComplete"]>().mockResolvedValue(undefined),
		clearCollection: vi.fn<IVectorStore["clearCollection"]>().mockResolvedValue(undefined),
		deleteCollection: vi.fn<IVectorStore["deleteCollection"]>().mockResolvedValue(undefined),
	}
	const scanner = {
		hasIncompleteFiles: false,
		scanDirectory: vi.fn<IDirectoryScanner["scanDirectory"]>().mockResolvedValue(scanResult),
	}
	const watcher = {
		isProcessing: false,
		initialize: vi.fn<IFileWatcher["initialize"]>().mockResolvedValue(undefined),
		dispose: vi.fn(),
		onDidStartBatchProcessing: vi.fn<IFileWatcher["onDidStartBatchProcessing"]>(() => ({ dispose: vi.fn() })),
		onBatchProgressUpdate: vi.fn<IFileWatcher["onBatchProgressUpdate"]>(() => ({ dispose: vi.fn() })),
		onDidFinishBatchProcessing: vi.fn<IFileWatcher["onDidFinishBatchProcessing"]>(() => ({ dispose: vi.fn() })),
		onParserFatal: vi.fn<NonNullable<IFileWatcher["onParserFatal"]>>(() => ({ dispose: vi.fn() })),
		processFile: vi.fn<IFileWatcher["processFile"]>(),
	}
	const worker = { stop: vi.fn(), stopped: Promise.resolve(), logStopTimeout: vi.fn() }
	const gate = new IndexWriteGate()
	vi.spyOn(gate, "run")
	vi.spyOn(gate, "settled")
	vi.spyOn(gate, "hasPending")
	vi.spyOn(gate, "abandon")
	const allocator = { initialize: vi.fn<GenerationAllocator["initialize"]>().mockResolvedValue(undefined) }
	return { cache, store, scanner, watcher, worker, gate, allocator }
}

describe("CodeIndexOrchestrator lifecycle", () => {
	let state: CodeIndexStateManager
	let cache: ReturnType<typeof fixtures>["cache"]
	let store: ReturnType<typeof fixtures>["store"]
	let scanner: ReturnType<typeof fixtures>["scanner"]
	let watcher: ReturnType<typeof fixtures>["watcher"]
	let worker: ReturnType<typeof fixtures>["worker"]
	let gate: IndexWriteGate
	let allocator: ReturnType<typeof fixtures>["allocator"]
	let current: boolean
	let fatal: ReturnType<typeof vi.fn<(error: ParserFatalError, message: string) => void>>
	let orchestrator: CodeIndexOrchestrator
	let failures: FileFailureRegistry
	let pacers: ProviderPacerRegistry

	beforeEach(() => {
		vi.useFakeTimers()
		clearAllMocks()
		state = new CodeIndexStateManager()
		state.setDiagnosticContext({ source: "manager", attempt: 57 })
		vi.spyOn(state, "setSystemState")
		vi.spyOn(state, "reportBlockIndexingProgress")
		vi.spyOn(state, "reportFileQueueProgress")
		;({ cache, store, scanner, watcher, worker, gate, allocator } = fixtures())
		current = true
		fatal = vi.fn<(error: ParserFatalError, message: string) => void>()
		failures = new FileFailureRegistry()
		pacers = new ProviderPacerRegistry()
		orchestrator = createOrchestrator()
	})

	function createOrchestrator(beforeScan?: (signal: AbortSignal) => Promise<void>) {
		// These structural doubles provide only the public lifecycle dependencies used by the owner.
		return new CodeIndexOrchestrator(
			{ isFeatureConfigured: true } as CodeIndexConfigManager,
			state,
			"/workspace",
			cache as unknown as CacheManager,
			store as unknown as IVectorStore,
			scanner,
			watcher,
			worker as unknown as ParseWorkerClient,
			gate,
			allocator as unknown as GenerationAllocator,
			failures,
			() => current,
			fatal,
			pacers,
			beforeScan,
		)
	}

	afterEach(() => vi.useRealTimers())

	it("initializes the allocator after the store and before dispatch", async () => {
		const order: string[] = []
		store.initialize.mockImplementation(async () => {
			order.push("store")
			return false
		})
		allocator.initialize.mockImplementation(async () => {
			order.push("allocator")
		})
		scanner.scanDirectory.mockImplementation(async () => {
			order.push("scan")
			return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
		})
		await orchestrator.startIndexing()
		expect(order).toEqual(["store", "allocator", "scan"])
		expect(store.markIndexingIncomplete).toHaveBeenCalledOnce()
		expect(store.markIndexingComplete).toHaveBeenCalledOnce()
		expect(store.markIndexingIncomplete).toHaveBeenCalledBefore(scanner.scanDirectory)
		expect(store.markIndexingComplete).toHaveBeenCalledAfter(watcher.initialize)
		expect(allocator.initialize).toHaveBeenCalledWith(store, expect.any(AbortSignal), gate)
		expect(state.state).toBe("Indexed")
	})

	it("exposes startup completion before the scan settles", async () => {
		const held = deferred()
		scanner.scanDirectory.mockReturnValue(held.promise.then(() => scanResult))
		const scan = orchestrator.startIndexing()
		await orchestrator.startupResult
		expect(scanner.scanDirectory).toHaveBeenCalledOnce()
		expect(state.state).toBe("Indexing")
		held.resolve()
		await scan
	})

	it.each(["resolve", "reject"])("settles startup promptly on stop before initialization can %s", async (ending) => {
		const held = deferred()
		store.initialize.mockReturnValue(held.promise.then(() => false))
		const scan = orchestrator.startIndexing()
		const startupSettled = vi.fn()
		void orchestrator.startupResult.then(startupSettled, startupSettled)
		await drain()
		expect(startupSettled).not.toHaveBeenCalled()
		const stop = orchestrator.stopIndexing()
		await drain()
		expect(startupSettled).toHaveBeenCalledOnce()
		await vi.advanceTimersByTimeAsync(INDEX_STOP_LIMIT_MS)
		await stop
		expect(state.state).toBe("Standby")
		if (ending === "resolve") held.resolve()
		else held.reject(new Error("late initialization failure"))
		await scan
		expect(allocator.initialize).not.toHaveBeenCalled()
		expect(scanner.scanDirectory).not.toHaveBeenCalled()
		expect(startupSettled).toHaveBeenCalledOnce()
		expect(state.state).toBe("Standby")
	})

	it("logs scan, changed-file batch and stop transitions with the original attempt", async () => {
		scanner.scanDirectory.mockImplementation(async (_directory, _onError, onIndexed) => {
			state.setSystemState("Standby", "Paused", "test")
			onIndexed?.(1)
			return { stats: { processed: 1, skipped: 0 }, totalBlockCount: 1 }
		})
		await orchestrator.startIndexing()
		expect(codeIndexLog.info).toHaveBeenCalledWith(
			"State transition",
			expect.objectContaining({ newState: "Indexed", source: "scan-end", attempt: 57 }),
		)
		watcher.onDidStartBatchProcessing.mock.calls[0][0]([])
		state.setSystemState("Standby", "Paused", "test")
		watcher.onDidStartBatchProcessing.mock.calls[0][0]([])
		watcher.onBatchProgressUpdate.mock.calls[0][0]({ processedInBatch: 1, totalInBatch: 2 })
		watcher.onDidFinishBatchProcessing.mock.calls[0][0]({ processedFiles: [] })
		for (const [newState, source] of [
			["Indexing", "scan"],
			["Indexing", "changed-file-batch"],
			["Indexed", "changed-file-batch"],
		]) {
			expect(codeIndexLog.info).toHaveBeenCalledWith(
				"State transition",
				expect.objectContaining({ newState, source, attempt: 57 }),
			)
		}
		watcher.isProcessing = true
		await orchestrator.stopIndexing()
		for (const newState of ["Stopping", "Standby"]) {
			expect(codeIndexLog.info).toHaveBeenCalledWith(
				"State transition",
				expect.objectContaining({ newState, source: "stop", attempt: 57 }),
			)
		}
	})

	it("returns to Indexed when all failed files recover without a new scan", async () => {
		failures.renew("bad.ts", "revision")
		failures.record("bad.ts", "revision", "read", "read failed", 1, "exhausted")
		await orchestrator.startIndexing()
		expect(state.state).toBe("Standby")
		expect(store.markIndexingComplete).not.toHaveBeenCalled()
		const completion = deferred()
		store.markIndexingComplete.mockReturnValue(completion.promise)
		failures.clear("bad.ts", "revision")
		await drain()
		expect(store.markIndexingComplete).toHaveBeenCalledOnce()
		expect(state.state).toBe("Standby")
		completion.resolve()
		await drain()
		expect(state.state).toBe("Indexed")
		expect(scanner.scanDirectory).toHaveBeenCalledOnce()
	})

	it.each(["stop", "parser", "superseded", "batch"])(
		"does not issue recovery completion after queued work becomes %s",
		async (ending) => {
			failures.renew("bad.ts", "revision")
			failures.record("bad.ts", "revision", "read", "read failed", 1, "exhausted")
			await orchestrator.startIndexing()
			const queued = deferred()
			vi.mocked(gate.run).mockImplementation(
				async <Result>(_signal: AbortSignal, write: () => Result | Promise<Result>) => {
					await queued.promise
					return write()
				},
			)
			failures.clear("bad.ts", "revision")
			if (ending === "stop") {
				const stopping = orchestrator.stopWatcher()
				await vi.advanceTimersByTimeAsync(INDEX_STOP_LIMIT_MS)
				await stopping
			}
			if (ending === "parser")
				watcher.onParserFatal.mock.calls[0][0](new ParserFatalError("parser-abort", "bad.ts"))
			if (ending === "superseded") current = false
			if (ending === "batch") watcher.onDidStartBatchProcessing.mock.calls[0][0]([])
			queued.resolve()
			await drain()
			expect(store.markIndexingComplete).not.toHaveBeenCalled()
			if (ending === "batch") {
				watcher.onDidFinishBatchProcessing.mock.calls[0][0]({ processedFiles: [] })
				await drain()
				expect(store.markIndexingComplete).toHaveBeenCalledOnce()
				expect(state.state).toBe("Indexed")
			}
		},
	)

	it.each(["stop", "superseded", "failure"])("handles pending recovery completion on %s", async (ending) => {
		failures.renew("bad.ts", "revision")
		failures.record("bad.ts", "revision", "read", "read failed", 1, "exhausted")
		await orchestrator.startIndexing()
		const completion = deferred()
		store.markIndexingComplete.mockReturnValue(completion.promise)
		failures.clear("bad.ts", "revision")
		await drain()
		if (ending === "stop") {
			const stopping = orchestrator.stopWatcher()
			await vi.advanceTimersByTimeAsync(INDEX_STOP_LIMIT_MS)
			await stopping
		}
		if (ending === "superseded") current = false
		vi.mocked(state.setSystemState).mockClear()
		if (ending === "failure") completion.reject(new Error("metadata failed"))
		else completion.resolve()
		await drain()
		if (ending === "failure") {
			expect(state.state).toBe("Error")
			expect(codeIndexLog.error).toHaveBeenCalledWith("Recovery completion failed", { error: expect.any(Error) })
		} else expect(state.setSystemState).not.toHaveBeenCalled()
	})

	it.each(["stop", "parser", "superseded"])("recovery never overrides %s", async (ending) => {
		failures.renew("bad.ts", "revision")
		failures.record("bad.ts", "revision", "read", "read failed", 1, "exhausted")
		await orchestrator.startIndexing()
		if (ending === "stop") {
			const stopping = orchestrator.stopWatcher()
			await vi.advanceTimersByTimeAsync(INDEX_STOP_LIMIT_MS)
			await stopping
		}
		if (ending === "parser") watcher.onParserFatal.mock.calls[0][0](new ParserFatalError("parser-abort", "bad.ts"))
		if (ending === "superseded") current = false
		vi.mocked(state.setSystemState).mockClear()
		failures.clear("bad.ts", "revision")
		expect(state.setSystemState).not.toHaveBeenCalled()
	})

	it("distinguishes active retries, exhausted failures and a user stop", async () => {
		await orchestrator.startIndexing()
		failures.renew("bad.ts", "revision")
		failures.record("bad.ts", "revision", "embed", "failed", 1, "retrying")
		expect(state.getCurrentStatus()).toMatchObject({
			systemStatus: "Indexing",
			message: "embeddings:orchestrator.indexingFilesRetrying",
		})
		failures.record("bad.ts", "revision", "embed", "failed", 3, "exhausted")
		expect(state.getCurrentStatus()).toMatchObject({
			systemStatus: "Standby",
			message: "embeddings:orchestrator.indexingFilesFailed",
		})
		watcher.isProcessing = true
		watcher.onDidStartBatchProcessing.mock.calls[0][0]([])
		await orchestrator.stopIndexing()
		expect(state.getCurrentStatus()).toMatchObject({
			systemStatus: "Standby",
			message: "embeddings:orchestrator.indexingStoppedPartial",
		})
	})

	it("keeps recovery Indexing while a watcher batch remains active", async () => {
		await orchestrator.startIndexing()
		watcher.onDidStartBatchProcessing.mock.calls[0][0](["bad.ts"])
		failures.renew("bad.ts", "revision")
		failures.record("bad.ts", "revision", "embed", "retrying", 1, "retrying")
		failures.clear("bad.ts", "revision")
		expect(state.state).toBe("Indexing")
		watcher.onDidFinishBatchProcessing.mock.calls[0][0]({ processedFiles: [] })
		await drain()
		expect(state.state).toBe("Indexed")
	})

	it("refuses scanning after a durable reservation failure without destroying data", async () => {
		allocator.initialize.mockRejectedValue(new Error("Storage reservation failed"))
		const scan = orchestrator.startIndexing()
		await expect(orchestrator.startupResult).rejects.toThrow("Storage reservation failed")
		await scan
		expect(scanner.scanDirectory).not.toHaveBeenCalled()
		expect(state.state).toBe("Error")
		expect(store.clearCollection).not.toHaveBeenCalled()
		expect(cache.clearCacheFile).not.toHaveBeenCalled()
	})

	it.each(["batch error", "incomplete file", "missing blocks"])(
		"does not complete a scan with %s",
		async (reason) => {
			scanner.scanDirectory.mockImplementation(async (_directory, onError, onIndexed, onParsed) => {
				if (reason === "batch error") onError?.(new Error("save failed"))
				if (reason === "missing blocks") {
					onParsed?.(10)
					onIndexed?.(9)
				}
				return {
					stats: { processed: 1, skipped: 0 },
					totalBlockCount: 10,
					incompleteFiles: reason === "incomplete file" ? ["bad.ts"] : [],
				}
			})
			await orchestrator.startIndexing()
			expect(store.markIndexingComplete).not.toHaveBeenCalled()
			expect(state.state).toBe("Standby")
			expect(state.setSystemState).toHaveBeenLastCalledWith(
				"Standby",
				"embeddings:orchestrator.indexingFilesFailed",
				"scan-end",
			)
		},
	)

	it("queue progress never declares a failed watcher batch Indexed", async () => {
		await orchestrator.startIndexing()
		vi.mocked(state.setSystemState).mockClear()
		watcher.onDidStartBatchProcessing.mock.calls[0][0](["bad.ts"])
		watcher.onBatchProgressUpdate.mock.calls[0][0]({ processedInBatch: 1, totalInBatch: 1 })
		expect(state.state).toBe("Indexing")
		failures.renew("bad.ts", "revision")
		failures.record("bad.ts", "revision", "read", "read failed", 1, "exhausted")
		watcher.onDidFinishBatchProcessing.mock.calls[0][0]({
			processedFiles: [{ path: "/workspace/bad.ts", status: "error" }],
		})
		expect(state.state).toBe("Standby")
		expect(vi.mocked(state.setSystemState).mock.calls.some(([next]) => next === "Indexed")).toBe(false)
	})

	it.each([
		{
			name: "recovers Indexed once a registered failed file clears",
			summary: { processedFiles: [{ path: "/workspace/bad.ts", status: "error" as const }] },
			expected: "Indexed",
		},
		{
			name: "stays partial after a whole-batch error with no processed files",
			summary: { processedFiles: [], batchError: new Error("batch failed") },
			expected: "Standby",
		},
	])("watcher batch $name", async ({ summary, expected }) => {
		await orchestrator.startIndexing()
		watcher.onDidStartBatchProcessing.mock.calls[0][0](["bad.ts"])
		failures.renew("bad.ts", "revision")
		failures.record("bad.ts", "revision", "read", "read failed", 1, "exhausted")
		watcher.onDidFinishBatchProcessing.mock.calls[0][0](summary)
		failures.clear("bad.ts", "revision")
		await drain()
		expect(state.state).toBe(expected)
	})

	it("keeps an unregistered watcher failure partial while another file is registered", async () => {
		await orchestrator.startIndexing()
		failures.renew("other.ts", "revision")
		failures.record("other.ts", "revision", "read", "read failed", 1, "exhausted")
		watcher.onDidFinishBatchProcessing.mock.calls[0][0]({
			processedFiles: [{ path: "/workspace/unregistered.ts", status: "local_error" }],
		})
		failures.clear("other.ts", "revision")
		await drain()
		expect(state.state).toBe("Standby")
	})

	it("reports partial when cancellation interrupts a watcher before durable invalidation", async () => {
		await orchestrator.startIndexing()
		watcher.isProcessing = true
		watcher.onDidStartBatchProcessing.mock.calls[0][0](["reading.ts"])
		await orchestrator.stopIndexing()
		expect(state.setSystemState).toHaveBeenLastCalledWith(
			"Standby",
			"embeddings:orchestrator.indexingStoppedPartial",
			"stop",
		)
	})

	it("stops the watcher session after a naturally ended scan", async () => {
		await orchestrator.startIndexing()
		expect(orchestrator.isScanning).toBe(false)
		expect(orchestrator.isActive).toBe(true)
		const stop = orchestrator.stopIndexing()
		expect(orchestrator.stopWatcher()).toBe(stop)
		expect(worker.stop).toHaveBeenCalledOnce()
		expect(watcher.dispose).toHaveBeenCalledOnce()
		await stop
		expect(orchestrator.isActive).toBe(false)
	})

	it.each(["scan", "gate", "worker"])("bounds stopping when %s never settles", async (pending) => {
		const held = deferred()
		if (pending === "scan") scanner.scanDirectory.mockReturnValue(held.promise.then(() => scanResult))
		if (pending === "gate") {
			vi.mocked(gate.settled).mockReturnValue(held.promise)
			vi.mocked(gate.hasPending).mockReturnValue(true)
		}
		if (pending === "worker") worker.stopped = held.promise
		const scan = orchestrator.startIndexing()
		await drain()
		watcher.isProcessing = true
		const stop = orchestrator.stopIndexing()
		expect(orchestrator.stopIndexing()).toBe(stop)
		expect(orchestrator.stopWatcher()).toBe(stop)
		expect(state.state).toBe("Stopping")
		await vi.advanceTimersByTimeAsync(INDEX_STOP_LIMIT_MS - 1)
		expect(state.state).toBe("Stopping")
		await vi.advanceTimersByTimeAsync(1)
		await stop
		expect(gate.abandon).toHaveBeenCalledOnce()
		expect(state.setSystemState).toHaveBeenLastCalledWith(
			"Standby",
			"embeddings:orchestrator.indexingStoppedPartial",
			"stop",
		)
		expect(worker.logStopTimeout).toHaveBeenCalledTimes(pending === "worker" ? 1 : 0)
		held.resolve()
		await scan
		expect(store.markIndexingComplete).toHaveBeenCalledTimes(pending === "scan" ? 0 : 1)
	})

	it("waits for all scan, writes and physical worker exit before a fully settled stop", async () => {
		const scanFinished = deferred()
		const writesFinished = deferred()
		const workerFinished = deferred()
		scanner.scanDirectory.mockReturnValue(scanFinished.promise.then(() => scanResult))
		vi.mocked(gate.settled).mockReturnValue(writesFinished.promise)
		worker.stopped = workerFinished.promise
		const scan = orchestrator.startIndexing()
		await drain()
		const stop = orchestrator.stopIndexing()
		scanFinished.resolve()
		writesFinished.resolve()
		await drain()
		expect(state.state).toBe("Stopping")
		workerFinished.resolve()
		await stop
		await scan
		expect(state.setSystemState).toHaveBeenLastCalledWith(
			"Standby",
			"embeddings:orchestrator.indexingStopped",
			"stop",
		)
		expect(gate.abandon).not.toHaveBeenCalled()
	})

	it("preserves incomplete-file status even when every stop wait settles", async () => {
		const scanFinished = deferred()
		scanner.scanDirectory.mockReturnValue(scanFinished.promise.then(() => scanResult))
		cache.getOpenFiles.mockReturnValue({ "bad.ts": true })
		void orchestrator.startIndexing()
		await drain()
		const stop = orchestrator.stopIndexing()
		scanFinished.resolve()
		await stop
		expect(state.setSystemState).toHaveBeenLastCalledWith(
			"Standby",
			"embeddings:orchestrator.indexingStoppedPartial",
			"stop",
		)
	})

	it("does not overwrite a newer attempt when the previous stop expires", async () => {
		scanner.scanDirectory.mockReturnValue(deferred().promise.then(() => scanResult))
		void orchestrator.startIndexing()
		await drain()
		const stop = orchestrator.stopIndexing()
		current = false
		state.setSystemState("Indexing", "new attempt")
		await vi.advanceTimersByTimeAsync(INDEX_STOP_LIMIT_MS)
		await stop
		expect(state.setSystemState).toHaveBeenLastCalledWith("Indexing", "new attempt")
	})

	it.each(["scan", "watcher"])(
		"latches fatal %s failure, preserves Error and rejects late callbacks",
		async (source) => {
			let lateProgress: (count: number) => void = () => {}
			if (source === "scan") {
				scanner.scanDirectory.mockImplementation(async (_directory, _onError, onProgress) => {
					lateProgress = (count) => onProgress?.(count)
					throw new ParserFatalError("parser-abort", "bad.ts")
				})
			}
			await orchestrator.startIndexing()
			if (source === "watcher") {
				watcher.isProcessing = true
				lateProgress = () =>
					watcher.onBatchProgressUpdate.mock.calls[0][0]({ processedInBatch: 1, totalInBatch: 1 })
				watcher.onParserFatal.mock.calls[0][0](new ParserFatalError("parse-timeout", "bad.ts"))
			}
			await orchestrator.stopIndexing()
			lateProgress(100)
			expect(state.state).toBe("Error")
			expect(codeIndexLog.info).toHaveBeenCalledWith(
				"State transition",
				expect.objectContaining({ newState: "Error", source: "error", attempt: 57 }),
			)
			expect(vi.mocked(state.setSystemState).mock.calls.some(([next]) => next === "Stopping")).toBe(false)
			expect(fatal).toHaveBeenCalledOnce()
			expect(worker.stop).toHaveBeenCalledOnce()
			expect(store.clearCollection).not.toHaveBeenCalled()
			expect(cache.clearCacheFile).not.toHaveBeenCalled()
			expect(state.reportBlockIndexingProgress).not.toHaveBeenCalled()
			expect(state.reportFileQueueProgress).not.toHaveBeenCalled()
			await orchestrator.startIndexing()
			expect(scanner.scanDirectory).toHaveBeenCalledOnce()
		},
	)

	it("keeps ordinary scan errors and completed data after cancel", async () => {
		scanner.scanDirectory.mockRejectedValue(new Error("network failed"))
		await orchestrator.startIndexing()
		await orchestrator.stopIndexing()
		expect(state.state).toBe("Error")
		expect(codeIndexLog.info).toHaveBeenCalledWith(
			"State transition",
			expect.objectContaining({ newState: "Error", source: "error", attempt: 57 }),
		)
		expect(store.clearCollection).not.toHaveBeenCalled()
		expect(cache.clearCacheFile).not.toHaveBeenCalled()
	})
	it.each([false, true])("chooses the scan before exactly one incomplete mark: %s", async (incremental) => {
		const order: string[] = []
		store.hasIndexedData.mockImplementation(async () => {
			order.push("choose")
			return incremental
		})
		store.markIndexingIncomplete.mockImplementation(async () => {
			order.push("mark")
		})
		const held = deferred()
		scanner.scanDirectory.mockImplementation(async () => {
			order.push("scan")
			await held.promise
			return scanResult
		})
		const scan = orchestrator.startIndexing()
		await orchestrator.startupResult
		expect(order).toEqual(["choose", "mark", "scan"])
		expect(store.markIndexingIncomplete).toHaveBeenCalledOnce()
		held.resolve()
		await scan
		expect(watcher.initialize).toHaveBeenCalledWith(expect.any(AbortSignal))
	})

	it.each([false, true])("only cleans up a failed newly created collection: %s", async (created) => {
		store.initialize.mockResolvedValue(created)
		store.markIndexingIncomplete.mockRejectedValue(new Error("metadata failed"))
		await orchestrator.startIndexing()
		expect(store.clearCollection).toHaveBeenCalledTimes(created ? 1 : 0)
		expect(cache.clearCacheFile).toHaveBeenCalledTimes(created ? 2 : 0)
		expect(state.state).toBe("Error")
	})

	it("keeps partial summary until recovery and stopped text until a new start", async () => {
		failures.renew("bad.ts", "revision")
		failures.record("bad.ts", "revision", "read", "failed", 1, "exhausted")
		await orchestrator.startIndexing()
		expect(orchestrator.isNaturallySettledPartial).toBe(true)
		await orchestrator.stopIndexing()
		const stoppedMessage = state.getCurrentStatus().message
		failures.clear("bad.ts")
		await drain()
		expect(orchestrator.isNaturallySettledPartial).toBe(false)
		expect(state.getCurrentStatus().message).toBe(stoppedMessage)
	})

	it("abandons and persists uncertain paths at the stop deadline", async () => {
		await orchestrator.startIndexing()
		const held = deferred()
		const signal = watcher.initialize.mock.calls[0][0]!
		const pending = gate.run(signal, () => held.promise, ["uncertain.ts"]).catch(() => {})
		await drain()
		const stop = orchestrator.stopIndexing()
		await vi.advanceTimersByTimeAsync(INDEX_STOP_LIMIT_MS)
		await stop
		expect(cache.invalidateFile).toHaveBeenCalledWith("uncertain.ts")
		expect(cache.flush).toHaveBeenCalled()
		held.resolve()
		await pending
	})

	it.each(["success", "delete", "cache"] as const)(
		"settles clear with the caller-visible %s result",
		async (result) => {
			await orchestrator.startIndexing()
			const failure = new Error(`${result} failed`)
			if (result === "delete") store.deleteCollection.mockRejectedValue(failure)
			if (result === "cache") cache.clearCacheFile.mockRejectedValue(failure)
			const clearing = orchestrator.clearIndexData()
			if (result === "success") {
				await expect(clearing).resolves.toBeUndefined()
				expect(state.getCurrentStatus()).toMatchObject({
					systemStatus: "Standby",
					message: "Index data cleared successfully.",
				})
			} else {
				await expect(clearing).rejects.toBe(failure)
				expect(state.getCurrentStatus()).toMatchObject({
					systemStatus: "Error",
					message: `Failed to clear index data: ${String(failure)}`,
				})
			}
			expect(store.deleteCollection).toHaveBeenCalledOnce()
			expect(cache.clearCacheFile).toHaveBeenCalledTimes(result === "delete" ? 0 : 1)
		},
	)

	it.each(["resolve", "reject"] as const)("quietly unwinds a stale clear that later %s", async (ending) => {
		await orchestrator.startIndexing()
		const held = deferred()
		store.deleteCollection.mockReturnValue(held.promise)
		const clearing = orchestrator.clearIndexData()
		await drain()
		current = false
		vi.mocked(state.setSystemState).mockClear()
		if (ending === "resolve") held.resolve()
		else held.reject(new Error("old delete failed"))
		await expect(clearing).resolves.toBeUndefined()
		expect(cache.clearCacheFile).not.toHaveBeenCalled()
		expect(state.setSystemState).not.toHaveBeenCalled()
	})

	it("keeps stop independent of a hung clear and fences its stale continuation", async () => {
		await orchestrator.startIndexing()
		const held = deferred()
		store.deleteCollection.mockReturnValue(held.promise)
		const clearing = orchestrator.clearIndexData()
		await drain()
		const stop = orchestrator.stopWatcher()
		expect(orchestrator.stopIndexing()).toBe(stop)
		await stop
		current = false
		vi.mocked(state.setSystemState).mockClear()
		held.resolve()
		await clearing
		expect(cache.clearCacheFile).not.toHaveBeenCalled()
		expect(state.setSystemState).not.toHaveBeenCalled()
	})
	it.each(["stop", "supersede"])("fences new-collection cleanup after %s", async (ending) => {
		store.initialize.mockResolvedValue(true)
		const held = deferred()
		scanner.scanDirectory.mockImplementation(async () => {
			await held.promise
			throw new Error("late scan failure")
		})
		const scan = orchestrator.startIndexing()
		await orchestrator.startupResult
		if (ending === "stop") {
			const stop = orchestrator.stopWatcher()
			held.resolve()
			await stop
		} else {
			current = false
			held.resolve()
		}
		await scan
		expect(store.clearCollection).not.toHaveBeenCalled()
		expect(cache.clearCacheFile).toHaveBeenCalledOnce()
	})

	it("contains a fatal parser event during watcher initialization", async () => {
		watcher.initialize.mockImplementation(async () => {
			watcher.onParserFatal.mock.calls[0][0](new ParserFatalError("parse-timeout", "bad.ts"))
		})
		await orchestrator.startIndexing()
		await orchestrator.stopWatcher()
		expect(fatal).toHaveBeenCalledOnce()
		expect(state.state).toBe("Error")
		expect(store.markIndexingComplete).not.toHaveBeenCalled()
	})

	it("bounds stop when cache persistence hangs", async () => {
		await orchestrator.startIndexing()
		const held = deferred()
		cache.flush.mockReturnValue(held.promise)
		const stop = orchestrator.stopWatcher()
		await vi.advanceTimersByTimeAsync(INDEX_STOP_LIMIT_MS)
		await stop
		expect(state.state).toBe("Standby")
		held.resolve()
		await drain()
	})

	it.each(["success", "failure", "stop", "supersede"])(
		"acknowledges deferred validation before initialization: %s",
		async (ending) => {
			const held = deferred()
			orchestrator = createOrchestrator(async () => held.promise)
			const scan = orchestrator.startIndexing()
			await orchestrator.startupResult
			expect(store.initialize).not.toHaveBeenCalled()
			expect(store.markIndexingIncomplete).not.toHaveBeenCalled()
			if (ending === "stop") {
				const stopping = orchestrator.stopIndexing()
				await vi.advanceTimersByTimeAsync(INDEX_STOP_LIMIT_MS)
				await stopping
			}
			if (ending === "supersede") current = false
			if (ending === "failure") held.reject(new Error("bad key"))
			else held.resolve()
			await scan
			if (ending === "success") {
				expect(store.initialize).toHaveBeenCalledOnce()
				expect(store.markIndexingComplete).toHaveBeenCalledOnce()
				expect(state.state).toBe("Indexed")
			} else {
				expect(store.initialize).not.toHaveBeenCalled()
				expect(scanner.scanDirectory).not.toHaveBeenCalled()
				expect(store.clearCollection).not.toHaveBeenCalled()
				expect(cache.clearCacheFile).not.toHaveBeenCalled()
				expect(fatal).not.toHaveBeenCalled()
				if (ending === "failure") expect(state.state).toBe("Error")
			}
		},
	)

	it("keeps recovery and provider callbacks from replacing Stopping", async () => {
		await orchestrator.startIndexing()
		state.setSystemState("Stopping", "original")
		vi.mocked(state.setSystemState).mockClear()
		failures.renew("bad.ts", "revision")
		failures.record("bad.ts", "revision", "read", "failed", 1, "exhausted")
		const pacer = pacers.get("embedding:test")
		pacer.reportRateLimit(
			new EmbeddingError("limited", { status: 429 }, { retryAfterMs: 61_000 }),
			pacer.markIssued(),
		)
		const controller = new AbortController()
		const waiting = pacer.run("waiting.ts", controller.signal, async () => {}).catch(() => {})
		failures.clear("bad.ts", "revision")
		controller.abort()
		await waiting
		await drain()
		expect(state.setSystemState).not.toHaveBeenCalled()
		expect(state.getCurrentStatus()).toMatchObject({ systemStatus: "Stopping", message: "original" })
	})

	it("publishes provider waiting and returns to Indexed when queued work resumes", async () => {
		await orchestrator.startIndexing()
		const pacer = pacers.get("embedding:test")
		pacer.reportRateLimit(
			new EmbeddingError("limited", { status: 429 }, { retryAfterMs: 1000 }),
			pacer.markIssued(),
		)
		expect(state.state).toBe("Indexed")
		const request = vi.fn(async () => {})
		const waiting = pacer.run("waiting.ts", undefined, request)
		await drain()
		expect(state.getCurrentStatus()).toMatchObject({
			systemStatus: "Indexing",
			message: "embeddings:orchestrator.providerWaitingUntil",
		})
		expect(failures.list()).toEqual([])
		expect(request).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1000)
		await waiting
		expect(state.state).toBe("Indexed")
		expect(store.markIndexingComplete).toHaveBeenCalledOnce()
	})

	it("disposes the provider subscription on stop", async () => {
		const subscribe = vi.spyOn(pacers, "onDidChange")
		await orchestrator.startIndexing()
		const subscription = subscribe.mock.results[0].value
		const dispose = vi.spyOn(subscription, "dispose")
		await orchestrator.stopIndexing()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it("leaves a naturally settled partial scan idle and incomplete", async () => {
		scanner.scanDirectory.mockResolvedValue({ ...scanResult, incompleteFiles: ["bad.ts"] })
		await orchestrator.startIndexing()
		expect(orchestrator.isScanning).toBe(false)
		expect(orchestrator.isNaturallySettledPartial).toBe(true)
		expect(state.state).toBe("Standby")
		expect(store.markIndexingIncomplete).toHaveBeenCalledOnce()
		expect(store.markIndexingComplete).not.toHaveBeenCalled()
	})
})
