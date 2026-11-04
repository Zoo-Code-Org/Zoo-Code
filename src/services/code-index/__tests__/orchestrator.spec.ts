import { describe, it, expect, beforeEach, vi } from "vitest"
import { CodeIndexOrchestrator } from "../orchestrator"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"

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
vi.mock("../../../i18n", () => ({
	t: (key: string, params?: { errorMessage?: string }) => {
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
				fileWatcher,
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
				fileWatcher,
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
			fileWatcher,
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

	it.each([false, true])(
		"only cleans up a failed full scan when the collection was created by this run: %s",
		async (created) => {
			vectorStore.initialize.mockResolvedValue(created)
			vectorStore.hasIndexedData.mockResolvedValue(false) // force full scan path
			vectorStore.markIndexingIncomplete.mockRejectedValue(new Error("mark incomplete failure"))

			const orchestrator = new CodeIndexOrchestrator(
				configManager,
				stateManager,
				workspacePath,
				cacheManager,
				vectorStore,
				scanner,
				fileWatcher,
			)

			// Act
			await orchestrator.startIndexing()

			expect(vectorStore.clearCollection).toHaveBeenCalledTimes(created ? 1 : 0)
			// A new collection clears stale cache at initialization and again on failure.
			expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(created ? 2 : 0)

			// Error state should be set
			expect(stateManager.setSystemState).toHaveBeenCalled()
			const lastCall = stateManager.setSystemState.mock.calls[stateManager.setSystemState.mock.calls.length - 1]
			expect(lastCall[0]).toBe("Error")
		},
	)

	it.each([false, true])(
		"only cleans up after partial full-scan progress when the collection was created by this run: %s",
		async (created) => {
			const failure = new Error("batch failure after partial progress")
			vectorStore.initialize.mockResolvedValue(created)
			vectorStore.hasIndexedData.mockResolvedValue(false)
			vectorStore.markIndexingIncomplete.mockResolvedValue(undefined)
			scanner.scanDirectory.mockImplementation(
				async (
					_dir: string,
					onError: (error: Error) => void,
					onIndexed: (count: number) => void,
					onParsed: (count: number) => void,
				) => {
					onParsed(3)
					onIndexed(1)
					onError(failure)
					return { stats: { processed: 1, skipped: 0 }, totalBlockCount: 3 }
				},
			)
			const orchestrator = new CodeIndexOrchestrator(
				configManager,
				stateManager,
				workspacePath,
				cacheManager,
				vectorStore,
				scanner,
				fileWatcher,
			)

			await orchestrator.startIndexing()

			expect(scanner.scanDirectory).toHaveBeenCalledOnce()
			expect(stateManager.reportBlockIndexingProgress).toHaveBeenLastCalledWith(1, 3)
			expect(stateManager.setSystemState).toHaveBeenLastCalledWith(
				"Error",
				expect.stringContaining(failure.message),
			)
			expect(stateManager.setSystemState).not.toHaveBeenCalledWith("Indexed", expect.any(String))
			expect(vectorStore.clearCollection).toHaveBeenCalledTimes(created ? 1 : 0)
			// New collections clear stale cache before scanning and again during error cleanup.
			expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(created ? 2 : 0)
			expect(vectorStore.markIndexingIncomplete).toHaveBeenCalledOnce()
			expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
			expect(fileWatcher.initialize).not.toHaveBeenCalled()
			expect(fileWatcher.dispose).toHaveBeenCalledOnce()
		},
	)

	it.each([false, true])(
		"keeps private error details out of telemetry (cleanup failure: %s)",
		async (cleanupFails) => {
			const messages = [
				"Embedding failed (Workspace: /Users/private-user/Secret Project, File: /Users/private-user/Secret Project/src/private.ts)",
				"Embedding failed (Workspace: C:\\Users\\private-user\\Secret Project, File: C:\\Users\\private-user\\Secret Project\\private.ts)",
			]
			const failures = messages.map((message) => {
				const error = new Error(message)
				error.stack = `${message}\n    at privateFunction (/Users/private-user/Secret Project/private.ts:12:3)`
				return error
			})
			vectorStore.initialize.mockResolvedValue(cleanupFails)
			vectorStore.hasIndexedData.mockResolvedValue(!cleanupFails)
			vectorStore.markIndexingIncomplete.mockResolvedValue(undefined)
			scanner.scanDirectory.mockImplementation(async (_dir: string, onError: (error: Error) => void) => {
				for (const failure of failures) onError(failure)
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
			})
			if (cleanupFails) vectorStore.clearCollection.mockRejectedValue(failures[1])
			const orchestrator = new CodeIndexOrchestrator(
				configManager,
				stateManager,
				workspacePath,
				cacheManager,
				vectorStore,
				scanner,
				fileWatcher,
			)

			await orchestrator.startIndexing()

			const expectedEvents = [
				[TelemetryEventName.CODE_INDEX_ERROR, { error: "Indexing failed", location: "startIndexing" }],
			]
			if (cleanupFails) {
				expectedEvents.push([
					TelemetryEventName.CODE_INDEX_ERROR,
					{ error: "Index cleanup failed", location: "startIndexing.cleanup" },
				])
			}
			// Exact payload assertions also exclude stacks, nested causes and aggregate error objects.
			expect(vi.mocked(TelemetryService.instance.captureEvent).mock.calls).toEqual(expectedEvents)
			expect(stateManager.setSystemState).toHaveBeenLastCalledWith("Error", expect.stringContaining(messages[0]))
			if (!cleanupFails) {
				expect(stateManager.setSystemState).toHaveBeenLastCalledWith(
					"Error",
					expect.stringContaining(messages[1]),
				)
			}
		},
	)

	it("preserves an existing index after an incremental failure and a failed full-scan retry", async () => {
		let complete = true
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockImplementation(async () => complete)
		vectorStore.markIndexingIncomplete.mockImplementation(async () => {
			complete = false
		})
		scanner.scanDirectory.mockImplementation(async (_dir: string, onError: (error: Error) => void) => {
			onError(new Error("embedding failed"))
			return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
		})
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		for (let attempt = 1; attempt <= 2; attempt++) {
			await orchestrator.startIndexing()
			expect(complete).toBe(false)
			expect(orchestrator.state).toBe("Error")
			expect(scanner.scanDirectory).toHaveBeenCalledTimes(attempt)
			expect(vectorStore.markIndexingIncomplete).toHaveBeenCalledTimes(attempt)
			expect(vectorStore.clearCollection).not.toHaveBeenCalled()
			expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
			expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
			expect(fileWatcher.initialize).not.toHaveBeenCalled()
		}
		expect(stateManager.setSystemState).toHaveBeenCalledWith("Indexing", "Checking for new or modified files...")
		expect(stateManager.setSystemState).toHaveBeenCalledWith(
			"Indexing",
			"Services ready. Starting workspace scan...",
		)
		expect(stateManager.setSystemState).not.toHaveBeenCalledWith("Indexed", expect.any(String))
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
			fileWatcher,
		)

		await orchestrator.startIndexing()

		// With a batch error and zero indexed blocks the orchestrator sets Error state
		const calls = stateManager.setSystemState.mock.calls.map((c: any[]) => c[0])
		expect(calls[calls.length - 1]).toBe("Error")
	})

	it.each([0, 2])(
		"preserves the existing index on incremental batch failure after %s indexed blocks",
		async (indexed) => {
			const batchError = new Error("incremental batch failure")
			vectorStore.initialize.mockResolvedValue(false) // existing collection
			vectorStore.hasIndexedData.mockResolvedValue(true) // force incremental scan path
			vectorStore.markIndexingIncomplete.mockResolvedValue(undefined)
			vectorStore.markIndexingComplete.mockResolvedValue(undefined)

			scanner.scanDirectory.mockImplementation(
				async (_dir: string, onBatchError: (e: Error) => void, onIndexed: (count: number) => void) => {
					onIndexed(indexed)
					onBatchError(batchError)
					return { stats: { processed: 1, skipped: 0 }, totalBlockCount: 3 }
				},
			)

			const orchestrator = new CodeIndexOrchestrator(
				configManager,
				stateManager,
				workspacePath,
				cacheManager,
				vectorStore,
				scanner,
				fileWatcher,
			)

			await orchestrator.startIndexing()

			expect(orchestrator.state).toBe("Error")
			expect(stateManager.setSystemState).toHaveBeenLastCalledWith(
				"Error",
				expect.stringContaining(batchError.message),
			)
			expect(stateManager.setSystemState).not.toHaveBeenCalledWith("Indexed", expect.any(String))
			expect(vectorStore.markIndexingIncomplete).toHaveBeenCalledOnce()
			expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
			expect(vectorStore.clearCollection).not.toHaveBeenCalled()
			expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
			expect(fileWatcher.initialize).not.toHaveBeenCalled()
			expect(fileWatcher.dispose).toHaveBeenCalledOnce()
		},
	)
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
			fileWatcher,
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
			fileWatcher,
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
			fileWatcher,
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
