import { describe, it, expect, beforeEach, vi } from "vitest"
import { CodeIndexOrchestrator } from "../orchestrator"

import { clearAllMocks } from "../../../test-utils/reset"

// Mock vscode workspace so startIndexing passes workspace check
vi.mock("vscode", () => {
	const path = require("path")
	const testWorkspacePath = path.join(path.sep, "test", "workspace")
	return {
		window: {
			activeTextEditor: null,
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: testWorkspacePath },
					name: "test",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn().mockReturnValue({
				onDidCreate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidDelete: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				dispose: vi.fn(),
			}),
		},
		RelativePattern: vi.fn().mockImplementation(function (base: string, pattern: string) {
			return { base, pattern }
		}),
	}
})

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

// Mock i18n translator used in orchestrator messages
vi.mock("../../i18n", () => ({
	t: (key: string, params?: any) => {
		if (key === "embeddings:orchestrator.failedDuringInitialScan" && params?.errorMessage) {
			return `Failed during initial scan: ${params.errorMessage}`
		}
		return key
	},
}))

describe("CodeIndexOrchestrator - error path cleanup gating", () => {
	const workspacePath = "/test/workspace"

	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let scanner: any
	let fileWatcher: any

	beforeEach(() => {
		clearAllMocks()

		configManager = {
			isFeatureConfigured: true,
		}

		// Minimal state manager that tracks state transitions
		let currentState = "Standby"
		stateManager = {
			get state() {
				return currentState
			},
			setSystemState: vi.fn().mockImplementation((state: string, _msg: string) => {
				currentState = state
			}),
			reportFileQueueProgress: vi.fn(),
			reportBlockIndexingProgress: vi.fn(),
		}

		cacheManager = {
			clearCacheFile: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
		}

		vectorStore = {
			initialize: vi.fn(),
			hasIndexedData: vi.fn(),
			markIndexingIncomplete: vi.fn(),
			markIndexingComplete: vi.fn(),
			clearCollection: vi.fn().mockResolvedValue(undefined),
		}

		scanner = {
			scanDirectory: vi.fn(),
		}

		fileWatcher = {
			initialize: vi.fn().mockResolvedValue(undefined),
			onDidStartBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onBatchProgressUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidFinishBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			dispose: vi.fn(),
		}
	})

	it.each([false, true])(
		"keeps watcher startup and completion after scanning (incremental: %s)",
		async (incremental) => {
			const events: string[] = []
			vectorStore.initialize.mockResolvedValue(false)
			vectorStore.hasIndexedData.mockResolvedValue(incremental)
			vectorStore.markIndexingIncomplete.mockImplementation(async () => {
				events.push("incomplete")
			})
			scanner.scanDirectory.mockImplementation(async () => {
				events.push("scan")
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
			})
			fileWatcher.initialize.mockImplementation(async () => {
				events.push("watcher")
			})
			vectorStore.markIndexingComplete.mockImplementation(async () => {
				events.push("complete")
			})
			const orchestrator = new CodeIndexOrchestrator(
				configManager,
				stateManager,
				workspacePath,
				cacheManager,
				vectorStore,
				scanner,
				{ create: () => fileWatcher },
			)
			await orchestrator.startIndexing()
			expect(events).toEqual(["incomplete", "scan", "watcher", "complete"])
			expect(orchestrator.state).toBe("Indexed")
			expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
			expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		},
	)

	it.each([false, true])(
		"keeps returned cancellation cleanup in the owner (incremental: %s)",
		async (incremental) => {
			vectorStore.initialize.mockResolvedValue(false)
			vectorStore.hasIndexedData.mockResolvedValue(incremental)
			const orchestrator = new CodeIndexOrchestrator(
				configManager,
				stateManager,
				workspacePath,
				cacheManager,
				vectorStore,
				scanner,
				{ create: () => fileWatcher },
			)
			scanner.scanDirectory.mockImplementation(async () => {
				orchestrator.stopIndexing()
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
			})
			// Preserve the original normal-return path: a failed flush is retried by the catch handler.
			cacheManager.flush.mockRejectedValueOnce(new Error("flush failed"))
			await orchestrator.startIndexing()
			expect(cacheManager.flush).toHaveBeenCalledTimes(2)
			expect(orchestrator.state).toBe("Standby")
			expect(fileWatcher.initialize).not.toHaveBeenCalled()
			expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
			expect(vectorStore.clearCollection).not.toHaveBeenCalled()
			expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		},
	)

	it("should not call clearCollection() or clear cache when initialize() fails (indexing not started)", async () => {
		// Arrange: fail at initialize()
		vectorStore.initialize.mockRejectedValue(new Error("Qdrant unreachable"))

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			{ create: () => fileWatcher },
		)

		// Act
		await orchestrator.startIndexing()

		// Assert
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()

		// Error state should be set
		expect(stateManager.setSystemState).toHaveBeenCalled()
		const lastCall = stateManager.setSystemState.mock.calls[stateManager.setSystemState.mock.calls.length - 1]
		expect(lastCall[0]).toBe("Error")
	})

	it("should call clearCollection() and clear cache when an error occurs after initialize() succeeds (indexing started)", async () => {
		// Arrange: initialize succeeds; fail soon after to enter error path with indexingStarted=true
		vectorStore.initialize.mockResolvedValue(false) // existing collection
		vectorStore.hasIndexedData.mockResolvedValue(false) // force full scan path
		vectorStore.markIndexingIncomplete.mockRejectedValue(new Error("mark incomplete failure"))

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			{ create: () => fileWatcher },
		)

		// Act
		await orchestrator.startIndexing()

		// Assert: cleanup gated behind indexingStarted should have happened
		expect(vectorStore.clearCollection).toHaveBeenCalledTimes(1)
		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1)

		// Error state should be set
		expect(stateManager.setSystemState).toHaveBeenCalled()
		const lastCall = stateManager.setSystemState.mock.calls[stateManager.setSystemState.mock.calls.length - 1]
		expect(lastCall[0]).toBe("Error")
	})

	it("collects batch errors from full scan and transitions to Error when all blocks fail", async () => {
		const batchError = new Error("batch failure")
		vectorStore.initialize.mockResolvedValue(false) // existing collection
		vectorStore.hasIndexedData.mockResolvedValue(false) // force full scan path
		vectorStore.markIndexingIncomplete.mockResolvedValue(undefined)
		vectorStore.markIndexingComplete.mockResolvedValue(undefined)

		// Report a batch error — no blocks indexed, so orchestrator treats it as complete failure
		scanner.scanDirectory.mockImplementation(async (_dir: string, onBatchError: (e: Error) => void) => {
			onBatchError(batchError)
			return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
		})

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			{ create: () => fileWatcher },
		)

		await orchestrator.startIndexing()

		// With a batch error and zero indexed blocks the orchestrator sets Error state
		const calls = stateManager.setSystemState.mock.calls.map((c: any[]) => c[0])
		expect(calls[calls.length - 1]).toBe("Error")
	})

	it("collects batch errors from incremental scan and still completes indexing", async () => {
		const batchError = new Error("incremental batch failure")
		vectorStore.initialize.mockResolvedValue(false) // existing collection
		vectorStore.hasIndexedData.mockResolvedValue(true) // force incremental scan path
		vectorStore.markIndexingIncomplete.mockResolvedValue(undefined)
		vectorStore.markIndexingComplete.mockResolvedValue(undefined)

		// Incremental scan reports a batch error but returns a result — orchestrator completes normally
		scanner.scanDirectory.mockImplementation(async (_dir: string, onBatchError: (e: Error) => void) => {
			onBatchError(batchError)
			return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
		})

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			{ create: () => fileWatcher },
		)

		await orchestrator.startIndexing()

		// Incremental scan doesn't gate on batch errors — Indexed state is still reached
		const calls = stateManager.setSystemState.mock.calls.map((c: any[]) => c[0])
		expect(calls[calls.length - 1]).toBe("Indexed")
		expect(calls).not.toContain("Error")
	})
})

describe("CodeIndexOrchestrator - stopIndexing", () => {
	const workspacePath = "/test/workspace"

	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let scanner: any
	let fileWatcher: any

	beforeEach(() => {
		clearAllMocks()

		configManager = {
			isFeatureConfigured: true,
		}

		let currentState = "Standby"
		stateManager = {
			get state() {
				return currentState
			},
			setSystemState: vi.fn().mockImplementation((state: string, _msg: string) => {
				currentState = state
			}),
			reportFileQueueProgress: vi.fn(),
			reportBlockIndexingProgress: vi.fn(),
		}

		cacheManager = {
			clearCacheFile: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
		}

		vectorStore = {
			initialize: vi.fn().mockResolvedValue(false),
			hasIndexedData: vi.fn().mockResolvedValue(false),
			markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
			markIndexingComplete: vi.fn().mockResolvedValue(undefined),
			clearCollection: vi.fn().mockResolvedValue(undefined),
		}

		scanner = {
			scanDirectory: vi.fn(),
		}

		fileWatcher = {
			initialize: vi.fn().mockResolvedValue(undefined),
			onDidStartBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onBatchProgressUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidFinishBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			dispose: vi.fn(),
		}
	})

	it("does not publish Indexed when stopped during watcher initialization", async () => {
		let finishInitialization!: () => void
		let enteredInitialization!: () => void
		const entered = new Promise<void>((resolve) => {
			enteredInitialization = resolve
		})
		fileWatcher.initialize.mockImplementation(() => {
			enteredInitialization()
			return new Promise<void>((resolve) => {
				finishInitialization = resolve
			})
		})
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			{ create: () => fileWatcher },
		)
		const indexing = orchestrator.startIndexing()
		await entered
		orchestrator.stopIndexing()
		finishInitialization()
		await indexing
		expect(stateManager.state).toBe("Standby")
		expect(stateManager.setSystemState).not.toHaveBeenCalledWith("Indexed", expect.anything())
		expect(fileWatcher.onDidStartBatchProcessing).not.toHaveBeenCalled()
		expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
	})

	it.each(["stop", "clear", "error"])("restarts the same orchestrator after %s", async (reason) => {
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
		vectorStore.deleteCollection = vi.fn().mockResolvedValue(undefined)
		const nextWatcher = {
			initialize: vi.fn().mockResolvedValue(undefined),
			processFile: vi.fn(),
			onDidStartBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onBatchProgressUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidFinishBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			dispose: vi.fn(),
		}
		const factory = { create: vi.fn().mockReturnValueOnce(fileWatcher).mockReturnValue(nextWatcher) }
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			factory,
		)
		if (reason === "error") vectorStore.initialize.mockRejectedValueOnce(new Error("Qdrant unavailable"))
		await orchestrator.startIndexing()
		if (reason === "error") {
			expect(stateManager.state).toBe("Error")
			expect(factory.create).not.toHaveBeenCalled()
		} else {
			expect(stateManager.state).toBe("Indexed")
			if (reason === "stop") orchestrator.stopIndexing()
			else await orchestrator.clearIndexData()
			expect(fileWatcher.dispose).toHaveBeenCalledTimes(1)
		}
		await orchestrator.startIndexing()
		expect(stateManager.state).toBe("Indexed")
		expect(factory.create).toHaveBeenCalledTimes(reason === "error" ? 1 : 2)
		expect(fileWatcher.initialize).toHaveBeenCalledTimes(1)
		expect(nextWatcher.initialize).toHaveBeenCalledTimes(reason === "error" ? 0 : 1)
	})

	it("should abort indexing when stopIndexing() is called", async () => {
		// Make scanner hang until aborted
		scanner.scanDirectory.mockImplementation(
			async (_dir: string, _onError?: any, _onBlocksIndexed?: any, _onFileParsed?: any, signal?: AbortSignal) => {
				// Wait for abort signal
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					signal?.addEventListener("abort", () => resolve())
				})
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
			},
		)

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			{ create: () => fileWatcher },
		)

		// Start indexing (async, don't await)
		const indexingPromise = orchestrator.startIndexing()

		// Give it a tick to begin
		await new Promise((resolve) => setTimeout(resolve, 10))

		// Stop indexing
		orchestrator.stopIndexing()

		// Wait for indexing to complete
		await indexingPromise

		// State should be Standby (not Error)
		const setStateCalls = stateManager.setSystemState.mock.calls
		const lastCall = setStateCalls[setStateCalls.length - 1]
		expect(lastCall[0]).toBe("Standby")
	})

	it("should set state to Standby after abort, not Error", async () => {
		// Make scanner throw AbortError when signal is aborted
		scanner.scanDirectory.mockImplementation(
			async (_dir: string, _onError?: any, _onBlocksIndexed?: any, _onFileParsed?: any, signal?: AbortSignal) => {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					signal?.addEventListener("abort", () => resolve())
				})
				throw new DOMException("Indexing aborted", "AbortError")
			},
		)

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			{ create: () => fileWatcher },
		)

		const indexingPromise = orchestrator.startIndexing()
		await new Promise((resolve) => setTimeout(resolve, 10))

		orchestrator.stopIndexing()
		await indexingPromise

		// Should NOT have set Error state — abort is handled gracefully
		const errorCalls = stateManager.setSystemState.mock.calls.filter((call: any[]) => call[0] === "Error")
		expect(errorCalls).toHaveLength(0)

		// Should NOT have cleared collection on abort
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
	})

	it("should preserve partial index data after stop", async () => {
		scanner.scanDirectory.mockImplementation(
			async (_dir: string, _onError?: any, _onBlocksIndexed?: any, _onFileParsed?: any, signal?: AbortSignal) => {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					signal?.addEventListener("abort", () => resolve())
				})
				return { stats: { processed: 5, skipped: 0 }, totalBlockCount: 5 }
			},
		)

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			{ create: () => fileWatcher },
		)

		const indexingPromise = orchestrator.startIndexing()
		await new Promise((resolve) => setTimeout(resolve, 10))

		orchestrator.stopIndexing()
		await indexingPromise

		// Cache should NOT be cleared on user-initiated stop
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		// Collection should NOT be cleared on user-initiated stop
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
	})
})
