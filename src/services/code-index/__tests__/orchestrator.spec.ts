import { describe, it, expect, beforeEach, vi } from "vitest"
import { CodeIndexOrchestrator } from "../orchestrator"
import { TelemetryService } from "@roo-code/telemetry"
import * as vscode from "vscode"
import { CodeIndexStateManager } from "../state-manager"

import { clearAllMocks } from "../../../test-utils/reset"

// Mock vscode workspace so startIndexing passes workspace check
vi.mock("vscode", () => {
	const path = require("path")
	const testWorkspacePath = path.join(path.sep, "test", "workspace")
	return {
		EventEmitter: class {
			event = vi.fn().mockReturnValue({ dispose: vi.fn() })
			fire = vi.fn()
			dispose = vi.fn()
		},
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
			hasCodePoints: vi.fn().mockResolvedValue(false),
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

	it.each([
		{ collectionCreated: false, hasExistingData: true, message: "Checking for new or modified files..." },
		{ collectionCreated: false, hasExistingData: false, message: "Services ready. Starting workspace scan..." },
		{ collectionCreated: true, hasExistingData: true, message: "Services ready. Starting workspace scan..." },
	])(
		"completes scanning with $collectionCreated / $hasExistingData",
		async ({ collectionCreated, hasExistingData, message }) => {
			vectorStore.initialize.mockResolvedValue(collectionCreated)
			vectorStore.hasIndexedData.mockResolvedValue(hasExistingData)
			scanner.scanDirectory.mockImplementation(
				async (
					_dir: string,
					_onBatchError: (error: Error) => void,
					onBlocksIndexed: (count: number) => void,
					onFileParsed: (count: number) => void,
				) => {
					onFileParsed(3)
					onBlocksIndexed(2)
					onBlocksIndexed(1)
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

			expect(stateManager.setSystemState).toHaveBeenCalledWith("Indexing", message)
			expect(stateManager.reportBlockIndexingProgress.mock.calls).toEqual([
				[0, 3],
				[2, 3],
				[3, 3],
			])
			expect(scanner.scanDirectory).toHaveBeenCalledWith(
				workspacePath,
				expect.any(Function),
				expect.any(Function),
				expect.any(Function),
				expect.any(AbortSignal),
			)
			expect(vectorStore.markIndexingIncomplete).toHaveBeenCalledTimes(1)
			expect(fileWatcher.initialize).toHaveBeenCalledTimes(1)
			expect(vectorStore.markIndexingComplete).toHaveBeenCalledTimes(1)
			expect(stateManager.state).toBe("Indexed")
			expect(vectorStore.clearCollection).not.toHaveBeenCalled()
			expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(collectionCreated ? 1 : 0)
		},
	)

	it.each([
		{ found: 0, indexed: 0, batchError: false, expected: "Indexed" },
		{ found: 3, indexed: 0, batchError: false, expected: "Error" },
		{ found: 3, indexed: 0, batchError: true, expected: "Error" },
		{ found: 0, indexed: 0, batchError: true, expected: "Error" },
		{ found: 10, indexed: 9, batchError: true, expected: "Indexed" },
		{ found: 10, indexed: 8, batchError: true, expected: "Error" },
		{ found: 10, indexed: 8, batchError: false, expected: "Indexed" },
	])(
		"preserves full-scan validation for $indexed/$found blocks, batch error: $batchError",
		async ({ found, indexed, batchError, expected }) => {
			vectorStore.initialize.mockResolvedValue(false)
			vectorStore.hasIndexedData.mockResolvedValue(false)
			scanner.scanDirectory.mockImplementation(
				async (
					_dir: string,
					onError: (error: Error) => void,
					onBlocksIndexed: (count: number) => void,
					onFileParsed: (count: number) => void,
				) => {
					onFileParsed(found)
					onBlocksIndexed(indexed)
					if (batchError) onError(new Error("batch failure"))
					return { stats: { processed: 1, skipped: 0 }, totalBlockCount: found }
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

			expect(orchestrator.state).toBe(expected)
			expect(vectorStore.markIndexingComplete).toHaveBeenCalledTimes(expected === "Indexed" ? 1 : 0)
		},
	)

	it.each(["success", "batch error", "file error"])(
		"preserves %s after trailing progress with the real state manager",
		async (outcome) => {
			const realState = new CodeIndexStateManager()
			vectorStore.initialize.mockResolvedValue(false)
			vectorStore.hasIndexedData.mockResolvedValue(true)
			scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
			const orchestrator = new CodeIndexOrchestrator(
				configManager,
				realState,
				workspacePath,
				cacheManager,
				vectorStore,
				scanner,
				fileWatcher,
			)
			try {
				await orchestrator.startIndexing()
				const onProgress = fileWatcher.onBatchProgressUpdate.mock.calls[0][0]
				const onFinished = fileWatcher.onDidFinishBatchProcessing.mock.calls[0][0]
				onProgress({ processedInBatch: 0, totalInBatch: 1, currentFile: "/workspace/test.ts" })
				expect(realState.getCurrentStatus()).toMatchObject({
					systemStatus: "Indexing",
					totalItems: 1,
					currentItemUnit: "files",
				})
				onFinished({
					processedFiles: [{ path: "test.ts", status: outcome === "file error" ? "error" : "success" }],
					batchError: outcome === "batch error" ? new Error("batch failed") : undefined,
				})
				const terminalStatus = realState.getCurrentStatus()
				expect(terminalStatus.systemStatus).toBe(outcome === "success" ? "Indexed" : "Error")
				onProgress({ processedInBatch: 1, totalInBatch: 1 })
				expect(realState.getCurrentStatus()).toEqual(terminalStatus)
				onProgress({ processedInBatch: 0, totalInBatch: 0 })
				expect(realState.getCurrentStatus()).toEqual(terminalStatus)
				await orchestrator.startIndexing()
				expect(scanner.scanDirectory).toHaveBeenCalledTimes(2)
			} finally {
				orchestrator.stopWatcher()
				realState.dispose()
			}
		},
	)

	it("should handle watcher progress and completion through registered callbacks", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
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
		const onProgress = fileWatcher.onBatchProgressUpdate.mock.calls[0][0]
		const onFinished = fileWatcher.onDidFinishBatchProcessing.mock.calls[0][0]

		onProgress({ processedInBatch: 1, totalInBatch: 2, currentFile: "/test/workspace/example.ts" })
		expect(orchestrator.state).toBe("Indexing")
		expect(stateManager.reportFileQueueProgress).toHaveBeenLastCalledWith(1, 2, "example.ts")
		onProgress({ processedInBatch: 1, totalInBatch: 2 })
		expect(stateManager.reportFileQueueProgress).toHaveBeenLastCalledWith(1, 2, undefined)
		onProgress({ processedInBatch: 2, totalInBatch: 2 })
		expect(orchestrator.state).toBe("Indexing")
		onFinished({ processedFiles: [{ path: "example.ts", status: "success" }] })
		expect(orchestrator.state).toBe("Indexed")
		onProgress({ processedInBatch: 2, totalInBatch: 2 })
		expect(orchestrator.state).toBe("Indexed")
		onProgress({ processedInBatch: 0, totalInBatch: 1 })
		onFinished({ processedFiles: [] })
		onProgress({ processedInBatch: 0, totalInBatch: 0 })
		expect(orchestrator.state).toBe("Indexed")

		const error = new Error("watcher batch failed")
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			onFinished({ processedFiles: [], batchError: error })
			expect(log).toHaveBeenCalledWith("[CodeIndexWatcherSession] Batch processing failed:", error)
			onProgress({ processedInBatch: 1, totalInBatch: 1 })
			onProgress({ processedInBatch: 0, totalInBatch: 0 })
			expect(orchestrator.state).toBe("Error")
			onFinished({ processedFiles: [] })
		} finally {
			log.mockRestore()
		}
	})

	it.each(["error", "local_error"])(
		"should report watcher file failures without a batch error (%s)",
		async (status) => {
			vectorStore.initialize.mockResolvedValue(false)
			vectorStore.hasIndexedData.mockResolvedValue(true)
			scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
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
			const onFinished = fileWatcher.onDidFinishBatchProcessing.mock.calls[0][0]
			const onProgress = fileWatcher.onBatchProgressUpdate.mock.calls[0][0]
			onFinished({ processedFiles: [{ path: "bad.ts", status }] })
			onProgress({ processedInBatch: 1, totalInBatch: 1 })
			onProgress({ processedInBatch: 0, totalInBatch: 0 })
			expect(orchestrator.state).toBe("Error")
			onProgress({ processedInBatch: 0, totalInBatch: 1 })
			onFinished({ processedFiles: [{ path: "bad.ts", status: "success" }] })
			expect(orchestrator.state).toBe("Indexed")
		},
	)

	it("should reuse active watcher subscriptions on repeated indexing", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(true)
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
		const disposeProgress = vi.fn()
		const disposeFinished = vi.fn()
		fileWatcher.onBatchProgressUpdate.mockReturnValue({ dispose: disposeProgress })
		fileWatcher.onDidFinishBatchProcessing.mockReturnValue({ dispose: disposeFinished })
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
		await orchestrator.startIndexing()
		expect(fileWatcher.initialize).toHaveBeenCalledTimes(1)
		expect(fileWatcher.onBatchProgressUpdate).toHaveBeenCalledTimes(1)
		expect(fileWatcher.onDidFinishBatchProcessing).toHaveBeenCalledTimes(1)
		orchestrator.stopWatcher()
		expect(disposeProgress).toHaveBeenCalledTimes(1)
		expect(disposeFinished).toHaveBeenCalledTimes(1)
	})

	it.each([undefined, []])("rejects indexing without workspace folders (%s)", async (folders) => {
		const original = vscode.workspace.workspaceFolders
		Object.defineProperty(vscode.workspace, "workspaceFolders", { value: folders, configurable: true })
		try {
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
			expect(vectorStore.initialize).not.toHaveBeenCalled()
		} finally {
			Object.defineProperty(vscode.workspace, "workspaceFolders", { value: original, configurable: true })
		}
	})

	it("rejects indexing without configuration", async () => {
		configManager.isFeatureConfigured = false
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
		expect(orchestrator.state).toBe("Standby")
		expect(vectorStore.initialize).not.toHaveBeenCalled()
	})

	it.each(["Indexing", "Stopping"])("rejects indexing in %s state", async (state) => {
		stateManager.setSystemState(state, "busy")
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
		expect(orchestrator.state).toBe(state)
		expect(vectorStore.initialize).not.toHaveBeenCalled()
	})

	it.each(["configuration lost", "watcher failed"])("handles watcher startup failure: %s", async (failure) => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(true)
		scanner.scanDirectory.mockImplementation(async () => {
			if (failure === "configuration lost") configManager.isFeatureConfigured = false
			return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
		})
		fileWatcher.initialize.mockRejectedValue(new Error("watcher failed"))
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
		expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
		expect(fileWatcher.dispose).toHaveBeenCalled()
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ location: "startIndexing" }),
		)
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledTimes(1)
		if (failure === "configuration lost") {
			expect(fileWatcher.initialize).not.toHaveBeenCalled()
		}
	})

	it("preserves the original error when collection cleanup rejects a non-Error value", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		scanner.scanDirectory.mockRejectedValue(new Error("original failure"))
		vectorStore.clearCollection.mockRejectedValue("cleanup failed")
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
		expect(cacheManager.clearCacheFile).toHaveBeenCalledOnce()
		expect(stateManager.setSystemState).toHaveBeenLastCalledWith(
			"Error",
			expect.stringContaining("original failure"),
		)
		expect(TelemetryService.instance.captureEvent).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ location: "startIndexing.cleanup", error: "cleanup failed", stack: undefined }),
		)
	})

	it.each([null, "connection failed", { message: "" }])("handles unexpected rejection values (%s)", async (error) => {
		vectorStore.initialize.mockRejectedValue(error)
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)
		await expect(orchestrator.startIndexing()).resolves.toBeUndefined()
		expect(stateManager.setSystemState).toHaveBeenLastCalledWith("Error", expect.stringContaining("unknownError"))
		expect(fileWatcher.dispose).toHaveBeenCalled()
	})

	it("clears cache without deleting storage when configuration is missing", async () => {
		configManager.isFeatureConfigured = false
		vectorStore.deleteCollection = vi.fn()
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)
		const stopWatcher = vi.spyOn(orchestrator, "stopWatcher")
		await orchestrator.clearIndexData()
		expect(stopWatcher).not.toHaveBeenCalled()
		expect(vectorStore.deleteCollection).not.toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).toHaveBeenCalledOnce()
		expect(orchestrator.state).toBe("Standby")
	})

	it("reports non-Error deletion failures and releases the clearing guard", async () => {
		vectorStore.deleteCollection = vi.fn().mockRejectedValueOnce("delete failed").mockResolvedValue(undefined)
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)
		await orchestrator.clearIndexData()
		expect(stateManager.setSystemState).toHaveBeenLastCalledWith(
			"Error",
			"Failed to clear index data: delete failed",
		)
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		await orchestrator.clearIndexData()
		expect(orchestrator.state).toBe("Standby")
	})

	it("should preserve existing data when checking collection contents fails", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockRejectedValue(new Error("query failed"))
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
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		expect(scanner.scanDirectory).not.toHaveBeenCalled()
	})

	it.each([false, true])(
		"never clears data when point presence is unknown (created/recreated: %s)",
		async (created) => {
			vectorStore.initialize.mockResolvedValue(created)
			vectorStore.hasCodePoints.mockRejectedValue(new Error("point query failed"))
			vectorStore.hasIndexedData.mockResolvedValue(false)
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
			expect(vectorStore.clearCollection).not.toHaveBeenCalled()
			expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
			expect(scanner.scanDirectory).not.toHaveBeenCalled()
			expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
		},
	)

	it.each([false, true])("cleans a failed full scan that started empty (created/recreated: %s)", async (created) => {
		const points = new Set<string>()
		const cache = new Map<string, string>()
		vectorStore.initialize.mockResolvedValue(created)
		vectorStore.hasCodePoints.mockImplementation(async () => points.size > 0)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		vectorStore.clearCollection.mockImplementation(async () => {
			points.clear()
		})
		cacheManager.clearCacheFile.mockImplementation(async () => {
			cache.clear()
		})
		scanner.scanDirectory.mockImplementation(async () => {
			points.add("partial-block")
			cache.set("partial.ts", "partial-hash")
			throw new Error("scan failed")
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
		expect(orchestrator.state).toBe("Error")
		expect(points.size).toBe(0)
		expect(cache.size).toBe(0)
		expect(vectorStore.clearCollection).toHaveBeenCalledOnce()
		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(created ? 2 : 1)
		expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
	})

	it("should finish error handling when cache cleanup fails", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		scanner.scanDirectory.mockRejectedValue(new Error("scan failed"))
		cacheManager.clearCacheFile.mockRejectedValue(new Error("cache cleanup failed"))
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		await expect(orchestrator.startIndexing()).resolves.toBeUndefined()
		expect(orchestrator.state).toBe("Error")
		expect(fileWatcher.dispose).toHaveBeenCalled()
		expect(stateManager.setSystemState).toHaveBeenLastCalledWith("Error", expect.stringContaining("scan failed"))
	})

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
			fileWatcher,
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
			fileWatcher,
		)

		await orchestrator.startIndexing()

		// With a batch error and zero indexed blocks the orchestrator sets Error state
		const calls = stateManager.setSystemState.mock.calls.map((c: any[]) => c[0])
		expect(calls[calls.length - 1]).toBe("Error")
	})

	it.each([false, true])(
		"preserves stored points and cache after an incremental failure and a failed retry (new orchestrator: %s)",
		async (recreate) => {
			const points = new Set(["existing-code-block"])
			const cache = new Map([["existing.ts", "unchanged-hash"]])
			let complete = true
			vectorStore.initialize.mockResolvedValue(false)
			vectorStore.hasIndexedData.mockImplementation(async () => points.size > 0 && complete)
			vectorStore.hasCodePoints = vi.fn(async () => points.size > 0)
			vectorStore.markIndexingIncomplete.mockImplementation(async () => {
				complete = false
			})
			vectorStore.clearCollection.mockImplementation(async () => {
				points.clear()
			})
			cacheManager.clearCacheFile.mockImplementation(async () => {
				cache.clear()
			})
			scanner.scanDirectory.mockImplementation(async (_dir: string, onError: (error: Error) => void) => {
				onError(new Error("embedding unavailable"))
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
			})
			let orchestrator = new CodeIndexOrchestrator(
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
			expect(complete).toBe(false)
			expect(points.size).toBe(1)
			if (recreate) {
				orchestrator = new CodeIndexOrchestrator(
					configManager,
					new CodeIndexStateManager(),
					workspacePath,
					cacheManager,
					vectorStore,
					scanner,
					fileWatcher,
				)
			}
			await orchestrator.startIndexing()
			expect(scanner.scanDirectory).toHaveBeenCalledTimes(2)
			expect(orchestrator.state).toBe("Error")
			expect(points).toEqual(new Set(["existing-code-block"]))
			expect(cache).toEqual(new Map([["existing.ts", "unchanged-hash"]]))
			expect(vectorStore.clearCollection).not.toHaveBeenCalled()
			expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
			expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
		},
	)

	it.each([0, 2])(
		"should report incremental batch failure without deleting existing data (%s blocks indexed)",
		async (indexedCount) => {
			const batchError = new Error("incremental batch failure")
			vectorStore.initialize.mockResolvedValue(false) // existing collection
			vectorStore.hasIndexedData.mockResolvedValue(true) // force incremental scan path
			vectorStore.markIndexingIncomplete.mockResolvedValue(undefined)
			vectorStore.markIndexingComplete.mockResolvedValue(undefined)

			// A failed batch must prevent success even if another batch was indexed.
			scanner.scanDirectory.mockImplementation(
				async (
					_dir: string,
					onBatchError: (error: Error) => void,
					onBlocksIndexed: (count: number) => void,
					onFileParsed: (count: number) => void,
				) => {
					onFileParsed(3)
					if (indexedCount > 0) {
						onBlocksIndexed(indexedCount)
					}
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
			expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
			expect(stateManager.setSystemState).not.toHaveBeenCalledWith("Indexed", expect.any(String))
			expect(vectorStore.clearCollection).not.toHaveBeenCalled()
			expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
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
			hasCodePoints: vi.fn().mockResolvedValue(false),
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

	it("preserves active indexing state when a repeated start finds missing configuration", async () => {
		let releasePreparation!: () => void
		const preparation = new Promise<void>((resolve) => {
			releasePreparation = resolve
		})
		vectorStore.initialize.mockImplementationOnce(async () => {
			await preparation
			return false
		})
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)
		const indexing = orchestrator.startIndexing()
		try {
			configManager.isFeatureConfigured = false
			stateManager.setSystemState.mockClear()
			await orchestrator.startIndexing()
			expect(orchestrator.state).toBe("Indexing")
			expect(stateManager.setSystemState).not.toHaveBeenCalled()
			expect(vectorStore.initialize).toHaveBeenCalledTimes(1)
		} finally {
			configManager.isFeatureConfigured = true
			releasePreparation()
			await indexing
		}
	})

	it("retains a cancelled run until cache flushing finishes and allows a fresh run afterwards", async () => {
		let finishPreparation!: () => void
		const preparation = new Promise<void>((resolve) => {
			finishPreparation = resolve
		})
		let notifyFlushing!: () => void
		const flushing = new Promise<void>((resolve) => {
			notifyFlushing = resolve
		})
		let finishFlushing!: () => void
		const flushed = new Promise<void>((resolve) => {
			finishFlushing = resolve
		})
		vectorStore.initialize.mockImplementationOnce(async () => {
			await preparation
			return false
		})
		cacheManager.flush.mockImplementationOnce(async () => {
			notifyFlushing()
			await flushed
		})
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		const indexing = orchestrator.startIndexing()
		orchestrator.stopIndexing()
		orchestrator.stopIndexing()
		finishPreparation()
		await flushing
		try {
			// A visible state update must not release ownership while cleanup is pending.
			stateManager.setSystemState("Standby", "External status update")
			await orchestrator.startIndexing()
			expect(vectorStore.initialize).toHaveBeenCalledTimes(1)
			expect(vectorStore.clearCollection).not.toHaveBeenCalled()
			expect(fileWatcher.initialize).not.toHaveBeenCalled()
		} finally {
			finishFlushing()
			await indexing
		}

		await orchestrator.startIndexing()
		expect(vectorStore.initialize).toHaveBeenCalledTimes(2)
		expect(orchestrator.state).toBe("Indexed")
	})

	it("releases a watcher created after cancellation before deleting index data", async () => {
		let notifyStarting!: () => void
		const starting = new Promise<void>((resolve) => {
			notifyStarting = resolve
		})
		let releaseInitialization!: () => void
		const initialization = new Promise<void>((resolve) => {
			releaseInitialization = resolve
		})
		const events: string[] = []
		let watcherAlive = false
		fileWatcher.initialize.mockImplementation(async () => {
			notifyStarting()
			await initialization
			watcherAlive = true
			events.push("watcher created")
		})
		fileWatcher.dispose.mockImplementation(() => {
			if (watcherAlive) events.push("watcher released")
			watcherAlive = false
		})
		const aliveDuringDeletion: boolean[] = []
		vectorStore.deleteCollection = vi.fn().mockImplementation(async () => {
			aliveDuringDeletion.push(watcherAlive)
			events.push("collection deleted")
		})
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)
		const indexing = orchestrator.startIndexing()
		await starting
		const clearing = orchestrator.clearIndexData()
		try {
			await Promise.resolve()
			expect(vectorStore.deleteCollection).not.toHaveBeenCalled()
		} finally {
			releaseInitialization()
			await Promise.all([indexing, clearing])
		}

		expect(aliveDuringDeletion).toEqual([false])
		expect(events).toEqual(["watcher created", "watcher released", "collection deleted"])
		expect(watcherAlive).toBe(false)
		expect(fileWatcher.onBatchProgressUpdate).not.toHaveBeenCalled()
		expect(fileWatcher.onDidFinishBatchProcessing).not.toHaveBeenCalled()
		expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
		expect(orchestrator.state).toBe("Standby")
	})

	it("should abort and await an active scan before deleting index data", async () => {
		const events: string[] = []
		let notifyScanStarted!: () => void
		const scanStarted = new Promise<void>((resolve) => {
			notifyScanStarted = resolve
		})
		let releaseScan!: () => void
		const scanReleased = new Promise<void>((resolve) => {
			releaseScan = resolve
		})
		let notifyClearAction!: () => void
		const clearAction = new Promise<void>((resolve) => {
			notifyClearAction = resolve
		})
		let scanSignal: AbortSignal | undefined

		vectorStore.deleteCollection = vi.fn().mockImplementation(async () => {
			events.push("collection deleted")
			notifyClearAction()
		})
		scanner.scanDirectory.mockImplementation(
			async (
				_dir: string,
				_onError?: (error: Error) => void,
				_onBlocksIndexed?: (count: number) => void,
				_onFileParsed?: (count: number) => void,
				signal?: AbortSignal,
			) => {
				scanSignal = signal
				signal?.addEventListener("abort", notifyClearAction, { once: true })
				notifyScanStarted()
				// Even after cancellation, an in-flight scan needs time to settle.
				await scanReleased
				signal?.removeEventListener("abort", notifyClearAction)
				events.push("scan finished")
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

		const indexing = orchestrator.startIndexing()
		await scanStarted
		const clearing = orchestrator.clearIndexData()
		// Either cancellation (correct) or deletion (bug) lets the test proceed.
		await clearAction
		releaseScan()
		await Promise.all([indexing, clearing])

		expect(events).toEqual(["scan finished", "collection deleted"])
		expect(scanSignal?.aborted).toBe(true)
		expect(fileWatcher.initialize).not.toHaveBeenCalled()
		expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
		expect(orchestrator.state).toBe("Standby")
	})

	it("should reject indexing while collection deletion is pending and allow it after clearing", async () => {
		let notifyDeletionStarted!: () => void
		const deletionStarted = new Promise<void>((resolve) => {
			notifyDeletionStarted = resolve
		})
		let finishDeletion!: () => void
		const deletionFinished = new Promise<void>((resolve) => {
			finishDeletion = resolve
		})
		vectorStore.deleteCollection = vi.fn().mockImplementation(async () => {
			notifyDeletionStarted()
			await deletionFinished
		})
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		const clearing = orchestrator.clearIndexData()
		await deletionStarted
		try {
			await orchestrator.clearIndexData()
			expect(vectorStore.deleteCollection).toHaveBeenCalledTimes(1)
			await orchestrator.startIndexing()
			expect(vectorStore.initialize).not.toHaveBeenCalled()
			expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		} finally {
			finishDeletion()
			await clearing
		}
		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1)
		await orchestrator.startIndexing()
		expect(orchestrator.state).toBe("Indexed")
	})

	it("should preserve cache on deletion failure and allow clearing to be retried", async () => {
		vectorStore.deleteCollection = vi
			.fn()
			.mockRejectedValueOnce(new Error("delete failed"))
			.mockResolvedValue(undefined)
		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		await orchestrator.clearIndexData()
		expect(orchestrator.state).toBe("Error")
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()

		await orchestrator.clearIndexData()
		expect(orchestrator.state).toBe("Standby")
		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1)
	})

	it.each([false, true])(
		"should remain stopped when watcher initialization finishes after cancellation (existing data: %s)",
		async (hasExistingData) => {
			vectorStore.hasIndexedData.mockResolvedValue(hasExistingData)
			let notifyWatcherStarting!: () => void
			const watcherStarting = new Promise<void>((resolve) => {
				notifyWatcherStarting = resolve
			})
			let finishWatcherInitialization!: () => void
			const watcherInitialization = new Promise<void>((resolve) => {
				finishWatcherInitialization = resolve
			})
			scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
			fileWatcher.initialize.mockImplementation(async () => {
				notifyWatcherStarting()
				await watcherInitialization
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

			const indexing = orchestrator.startIndexing()
			await watcherStarting
			orchestrator.stopIndexing()
			finishWatcherInitialization()
			await indexing

			expect(TelemetryService.instance.captureEvent).not.toHaveBeenCalled()
			expect(orchestrator.state).toBe("Standby")
			expect(vectorStore.markIndexingComplete).not.toHaveBeenCalled()
			expect(stateManager.setSystemState).not.toHaveBeenCalledWith("Indexed", expect.any(String))
		},
	)

	it.each([false, true])(
		"should restore the incomplete marker when cancelled during completion persistence (existing data: %s)",
		async (hasExistingData) => {
			vectorStore.hasIndexedData.mockResolvedValue(hasExistingData)
			let notifySaving!: () => void
			const saving = new Promise<void>((resolve) => {
				notifySaving = resolve
			})
			let finishSaving!: () => void
			const saved = new Promise<void>((resolve) => {
				finishSaving = resolve
			})
			let complete = false
			vectorStore.markIndexingIncomplete.mockImplementation(async () => {
				complete = false
			})
			vectorStore.markIndexingComplete.mockImplementation(async () => {
				notifySaving()
				await saved
				complete = true
			})
			scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 })
			const orchestrator = new CodeIndexOrchestrator(
				configManager,
				stateManager,
				workspacePath,
				cacheManager,
				vectorStore,
				scanner,
				fileWatcher,
			)
			const indexing = orchestrator.startIndexing()
			await saving
			orchestrator.stopIndexing()
			finishSaving()
			await indexing

			expect(complete).toBe(false)
			expect(orchestrator.state).toBe("Standby")
			expect(stateManager.setSystemState).not.toHaveBeenCalledWith("Indexed", expect.any(String))
		},
	)

	it.each([false, true])(
		"should finish cancellation when cache flush fails (scanner throws: %s)",
		async (throwsAbort) => {
			let notifyStarted!: () => void
			const started = new Promise<void>((resolve) => {
				notifyStarted = resolve
			})
			let releaseScan!: () => void
			const released = new Promise<void>((resolve) => {
				releaseScan = resolve
			})
			cacheManager.flush.mockRejectedValue(new Error("flush failed"))
			scanner.scanDirectory.mockImplementation(async () => {
				notifyStarted()
				await released
				if (throwsAbort) throw new DOMException("Stopped", "AbortError")
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
			const indexing = orchestrator.startIndexing()
			await started
			orchestrator.stopIndexing()
			fileWatcher.dispose.mockClear()
			releaseScan()

			await expect(indexing).resolves.toBeUndefined()
			expect(orchestrator.state).toBe("Standby")
			expect(fileWatcher.dispose).toHaveBeenCalled()
			expect(cacheManager.flush).toHaveBeenCalledTimes(1)
			expect(vectorStore.clearCollection).not.toHaveBeenCalled()
			expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		},
	)

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
