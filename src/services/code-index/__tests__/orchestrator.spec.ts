import { CodeIndexOrchestrator } from "../orchestrator"
import { FileFailureRegistry } from "../file-failure-registry"
import { ProviderPacerRegistry } from "../provider-pacer"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import type { IDirectoryScanner } from "../interfaces"

import { clearAllMocks } from "../../../test-utils/reset"

vi.mock("vscode", () => ({
	workspace: { workspaceFolders: [{ uri: { fsPath: "/test/workspace" }, name: "test", index: 0 }] },
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureEvent: vi.fn() } },
}))

vi.mock("../../../i18n", () => ({
	t: (key: string, params?: { errorMessage?: string }) =>
		params?.errorMessage ? `${key}: ${params.errorMessage}` : key,
}))

type ScanResult = Awaited<ReturnType<IDirectoryScanner["scanDirectory"]>>
const emptyScan: ScanResult = { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }

function setup() {
	let currentState = "Standby"
	const stateManager = {
		get state() {
			return currentState
		},
		setSystemState: vi.fn((state: string, _message?: string) => {
			currentState = state
		}),
		reportFileQueueProgress: vi.fn(),
		reportBlockIndexingProgress: vi.fn(),
	}
	const cacheManager = {
		clearCacheFile: vi.fn().mockResolvedValue(undefined),
		flush: vi.fn().mockResolvedValue(undefined),
	}
	const vectorStore = {
		initialize: vi.fn().mockResolvedValue(false),
		hasIndexedData: vi.fn().mockResolvedValue(false),
		markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
		markIndexingComplete: vi.fn().mockResolvedValue(undefined),
		clearCollection: vi.fn().mockResolvedValue(undefined),
		deleteCollection: vi.fn().mockResolvedValue(undefined),
	}
	const scanner = { scanDirectory: vi.fn<IDirectoryScanner["scanDirectory"]>().mockResolvedValue(emptyScan) }
	const fileWatcher = {
		initialize: vi.fn().mockResolvedValue(undefined),
		onDidStartBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		onBatchProgressUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		onDidFinishBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		dispose: vi.fn(),
	}
	const failures = new FileFailureRegistry()
	const pacers = new ProviderPacerRegistry()
	// The doubles provide only the members the orchestrator calls on each collaborator.
	type Arguments = ConstructorParameters<typeof CodeIndexOrchestrator>
	const orchestrator = new CodeIndexOrchestrator(
		{ isFeatureConfigured: true } as unknown as Arguments[0],
		stateManager as unknown as Arguments[1],
		"/test/workspace",
		cacheManager as unknown as Arguments[3],
		vectorStore as unknown as Arguments[4],
		scanner as unknown as Arguments[5],
		fileWatcher as unknown as Arguments[6],
		failures,
		pacers,
	)
	return { orchestrator, stateManager, cacheManager, vectorStore, scanner, fileWatcher, failures, pacers }
}

/** A scanner that waits until its signal aborts, then returns normally. */
function waitForAbort(...args: Parameters<IDirectoryScanner["scanDirectory"]>) {
	const signal = args[4]
	return new Promise<ScanResult>((resolve) => {
		if (signal?.aborted) return resolve(emptyScan)
		signal?.addEventListener("abort", () => resolve(emptyScan), { once: true })
	})
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

type Progress = { processedInBatch: number; totalInBatch: number; currentFile?: string }

/** Wires the watcher double's three events to callable emitters. */
function emitters(fileWatcher: ReturnType<typeof setup>["fileWatcher"]) {
	const listeners: { start?: () => void; progress?: (event: Progress) => void; finish?: () => void } = {}
	fileWatcher.onDidStartBatchProcessing.mockImplementation((listener: () => void) => {
		listeners.start = listener
		return { dispose: vi.fn() }
	})
	fileWatcher.onBatchProgressUpdate.mockImplementation((listener: (event: Progress) => void) => {
		listeners.progress = listener
		return { dispose: vi.fn() }
	})
	fileWatcher.onDidFinishBatchProcessing.mockImplementation((listener: () => void) => {
		listeners.finish = listener
		return { dispose: vi.fn() }
	})
	/** Same order as `FileWatcher.processBatch()`: start, progress, finish, then two trailing progress events. */
	return (total: number, duringBatch?: () => void) => {
		listeners.start?.()
		listeners.progress?.({ processedInBatch: 0, totalInBatch: total })
		duringBatch?.()
		listeners.progress?.({ processedInBatch: total, totalInBatch: total, currentFile: "/w/a.ts" })
		listeners.finish?.()
		listeners.progress?.({ processedInBatch: total, totalInBatch: total })
		listeners.progress?.({ processedInBatch: 0, totalInBatch: 0 })
	}
}

describe("CodeIndexOrchestrator", () => {
	beforeEach(() => clearAllMocks())

	it.each([false, true])("starts the watcher and completes after a scan (incremental: %s)", async (incremental) => {
		const context = setup()
		const events: string[] = []
		context.vectorStore.hasIndexedData.mockResolvedValue(incremental)
		context.vectorStore.markIndexingIncomplete.mockImplementation(async () => void events.push("incomplete"))
		context.scanner.scanDirectory.mockImplementation(async () => {
			events.push("scan")
			return emptyScan
		})
		context.fileWatcher.initialize.mockImplementation(async () => void events.push("watcher"))
		context.vectorStore.markIndexingComplete.mockImplementation(async () => void events.push("complete"))

		await context.orchestrator.startIndexing()

		expect(events).toEqual(["incomplete", "scan", "watcher", "complete"])
		expect(context.orchestrator.state).toBe("Indexed")
		expect(context.fileWatcher.initialize).toHaveBeenCalledWith(expect.any(AbortSignal))
	})

	it("completes a scan with file failures as idle partial (Standby), without marking it complete", async () => {
		const context = setup()
		context.scanner.scanDirectory.mockImplementation(async (_dir, onError) => {
			context.failures.renew("a.ts", "h")
			context.failures.record("a.ts", "h", "embed", "server down", 3, "exhausted")
			onError?.(new Error("server down"))
			return emptyScan
		})
		await context.orchestrator.startIndexing()
		expect(context.orchestrator.state).toBe("Standby")
		expect(context.vectorStore.markIndexingComplete).not.toHaveBeenCalled()
		expect(context.fileWatcher.initialize).toHaveBeenCalled()

		context.failures.clear("a.ts", "h")
		expect(context.orchestrator.state).toBe("Indexed")
	})

	describe("watcher batch final state", () => {
		function progressSetup() {
			const context = setup()
			context.stateManager.reportFileQueueProgress.mockImplementation(() => {
				context.stateManager.setSystemState("Indexing")
			})
			return { context, runBatch: emitters(context.fileWatcher) }
		}

		it("ends in Indexed after batch-finished and the two trailing progress events", async () => {
			const { context, runBatch } = progressSetup()
			await context.orchestrator.startIndexing()
			expect(context.orchestrator.state).toBe("Indexed")
			runBatch(2)
			expect(context.orchestrator.state).toBe("Indexed")
		})

		it("ends in partial Standby when the batch recorded a failure", async () => {
			const { context, runBatch } = progressSetup()
			await context.orchestrator.startIndexing()
			runBatch(1, () => {
				context.failures.renew("a.ts", "h")
				context.failures.record("a.ts", "h", "embed", "down", 3, "exhausted")
			})
			expect(context.orchestrator.state).toBe("Standby")
			expect(context.stateManager.setSystemState).toHaveBeenLastCalledWith(
				"Standby",
				"embeddings:orchestrator.indexingFilesFailed",
			)
		})

		it("reuses the watcher events after stop and restart", async () => {
			const { context, runBatch } = progressSetup()
			await context.orchestrator.startIndexing()
			await context.orchestrator.stopIndexing()
			await context.orchestrator.startIndexing()
			runBatch(1)
			expect(context.orchestrator.state).toBe("Indexed")
			expect(context.fileWatcher.initialize).toHaveBeenCalledTimes(2)
		})
	})

	it("does not clean up when initialize() fails and ends in Error", async () => {
		const context = setup()
		context.vectorStore.initialize.mockRejectedValue(new Error("Qdrant unreachable"))
		await context.orchestrator.startIndexing()
		expect(context.vectorStore.clearCollection).not.toHaveBeenCalled()
		expect(context.cacheManager.clearCacheFile).not.toHaveBeenCalled()
		expect(context.orchestrator.state).toBe("Error")
	})

	it.each([false, true])("only cleans up a failed scan when this run created the collection: %s", async (created) => {
		const context = setup()
		context.vectorStore.initialize.mockResolvedValue(created)
		context.vectorStore.markIndexingIncomplete.mockRejectedValue(new Error("mark incomplete failure"))
		await context.orchestrator.startIndexing()
		expect(context.vectorStore.clearCollection).toHaveBeenCalledTimes(created ? 1 : 0)
		expect(context.cacheManager.clearCacheFile).toHaveBeenCalledTimes(created ? 2 : 0)
		expect(context.orchestrator.state).toBe("Error")
		expect(context.fileWatcher.dispose).toHaveBeenCalled()
	})

	it("keeps private error details out of telemetry", async () => {
		const context = setup()
		const message = "Failed (Workspace: /Users/private-user/Secret Project)"
		context.scanner.scanDirectory.mockRejectedValue(new Error(message))
		await context.orchestrator.startIndexing()
		expect(vi.mocked(TelemetryService.instance.captureEvent).mock.calls).toEqual([
			[TelemetryEventName.CODE_INDEX_ERROR, { error: "Indexing failed", location: "startIndexing" }],
		])
		expect(context.stateManager.setSystemState).toHaveBeenLastCalledWith("Error", expect.stringContaining(message))
	})

	describe("stop", () => {
		it("CI-OR-01: repeated stops join one promise and end in Standby without clearing data", async () => {
			const context = setup()
			context.scanner.scanDirectory.mockImplementation(waitForAbort)
			const start = context.orchestrator.startIndexing()
			await tick()

			const first = context.orchestrator.stopIndexing()
			const second = context.orchestrator.stopIndexing()
			expect(second).toBe(first)
			await Promise.all([first, start])

			expect(context.orchestrator.state).toBe("Standby")
			expect(context.stateManager.setSystemState).toHaveBeenLastCalledWith(
				"Standby",
				"embeddings:orchestrator.indexingStoppedPartial",
			)
			expect(context.cacheManager.flush).toHaveBeenCalledOnce()
			expect(context.vectorStore.clearCollection).not.toHaveBeenCalled()
			expect(context.cacheManager.clearCacheFile).not.toHaveBeenCalled()
			expect(context.fileWatcher.dispose).toHaveBeenCalled()
		})

		it("CI-OR-01: a stop during a provider wait reaches Standby without waiting for the delay", async () => {
			vi.useFakeTimers()
			try {
				const context = setup()
				const limited = Object.assign(new Error("limited"), { status: 429, retryAfterMs: 3_600_000 })
				context.scanner.scanDirectory.mockImplementation(
					async (_dir, _onError, _onIndexed, _onParsed, signal) => {
						const pacer = context.pacers.get("openai:1")
						await pacer.run("a.ts", signal, () => Promise.reject(limited)).catch(() => {})
						return emptyScan
					},
				)
				const start = context.orchestrator.startIndexing()
				await vi.advanceTimersByTimeAsync(0)
				expect(context.pacers.waitingPaths()).toEqual(["a.ts"])
				expect(context.orchestrator.state).toBe("Indexing")

				await context.orchestrator.stopIndexing()
				await start
				expect(context.orchestrator.state).toBe("Standby")
				expect(context.pacers.waitingPaths()).toEqual([])
				expect(context.failures.list()).toEqual([])
			} finally {
				vi.useRealTimers()
			}
		})

		it("CI-OR-02: no status write after the abort except the final Standby", async () => {
			const context = setup()
			let report: ((count: number) => void) | undefined
			context.scanner.scanDirectory.mockImplementation(async (dir, onError, onIndexed, onParsed, signal) => {
				report = onParsed
				return waitForAbort(dir, onError, onIndexed, onParsed, signal)
			})
			const start = context.orchestrator.startIndexing()
			await tick()

			const stop = context.orchestrator.stopIndexing()
			const writesAtAbort = context.stateManager.setSystemState.mock.calls.length
			report?.(5)
			context.failures.renew("late.ts", "h")
			context.failures.record("late.ts", "h", "embed", "late", 1, "exhausted")
			await Promise.all([stop, start])

			const lateWrites = context.stateManager.setSystemState.mock.calls
				.slice(writesAtAbort)
				.map(([state]) => state)
			expect(lateWrites).toEqual(["Standby"])
			expect(context.stateManager.reportBlockIndexingProgress).not.toHaveBeenCalled()
		})

		it("CI-OR-03: stop then start on the same orchestrator runs a new session and writes status again", async () => {
			const context = setup()
			context.scanner.scanDirectory.mockImplementationOnce(waitForAbort)
			const firstStart = context.orchestrator.startIndexing()
			await tick()
			await context.orchestrator.stopIndexing()
			await firstStart
			expect(context.orchestrator.state).toBe("Standby")

			await context.orchestrator.startIndexing()
			expect(context.scanner.scanDirectory).toHaveBeenCalledTimes(2)
			expect(context.orchestrator.state).toBe("Indexed")
		})

		it("a start after a partial index stops the watcher session and rescans the failed file", async () => {
			const context = setup()
			context.scanner.scanDirectory
				.mockImplementationOnce(async () => {
					context.failures.renew("a.ts", "h")
					context.failures.record("a.ts", "h", "embed", "server down", 3, "exhausted")
					return emptyScan
				})
				.mockImplementationOnce(async () => {
					context.failures.clear("a.ts", "h")
					return emptyScan
				})
			await context.orchestrator.startIndexing()
			expect(context.orchestrator.state).toBe("Standby")

			await context.orchestrator.startIndexing()
			expect(context.scanner.scanDirectory).toHaveBeenCalledTimes(2)
			expect(context.fileWatcher.dispose).toHaveBeenCalled()
			expect(context.failures.list()).toEqual([])
			expect(context.orchestrator.state).toBe("Indexed")
		})

		it("a start while stopping waits for the stop, then starts", async () => {
			const context = setup()
			context.scanner.scanDirectory.mockImplementationOnce(waitForAbort)
			const firstStart = context.orchestrator.startIndexing()
			await tick()
			const stop = context.orchestrator.stopIndexing()
			const secondStart = context.orchestrator.startIndexing()
			await Promise.all([stop, firstStart, secondStart])
			expect(context.scanner.scanDirectory).toHaveBeenCalledTimes(2)
			expect(context.orchestrator.state).toBe("Indexed")
		})

		it("a repeated start while scanning returns the running scan", async () => {
			const context = setup()
			context.scanner.scanDirectory.mockImplementationOnce(waitForAbort)
			const first = context.orchestrator.startIndexing()
			await tick()
			const second = context.orchestrator.startIndexing()
			await tick()
			expect(context.scanner.scanDirectory).toHaveBeenCalledOnce()
			await context.orchestrator.stopIndexing()
			await Promise.all([first, second])
		})

		it("preserves Error across a stop", async () => {
			const context = setup()
			context.vectorStore.initialize.mockRejectedValue(new Error("down"))
			await context.orchestrator.startIndexing()
			await context.orchestrator.stopIndexing()
			expect(context.orchestrator.state).toBe("Error")
		})
	})
})
