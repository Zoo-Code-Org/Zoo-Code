// npx vitest services/code-index/processors/__tests__/file-watcher.spec.ts

import * as vscode from "vscode"

import { FileWatcher } from "../file-watcher"
import { FilePreparation } from "../file-preparation"
import type { FileProcessingResult } from "../../interfaces"

import { clearAllMocks } from "../../../../test-utils/reset"

// Mock TelemetryService
vi.mock("../../../../../packages/telemetry/src/TelemetryService", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

// Mock dependencies
vi.mock("../../cache-manager")
vi.mock("../../../core/ignore/RooIgnoreController", () => ({
	RooIgnoreController: vi.fn().mockImplementation(function () {
		return {
			validateAccess: vi.fn().mockReturnValue(true),
		}
	}),
}))
vi.mock("ignore")
vi.mock("../parser", () => ({
	codeParser: {
		parseFile: vi.fn().mockImplementation(async (filePath: string) => [
			{
				file_path: filePath,
				content: "test content",
				start_line: 1,
				end_line: 1,
			},
		]),
	},
}))

const createMockEventEmitter = () => {
	const listeners = new Set<(event: any) => void>()

	return {
		event: vi.fn((listener: (event: any) => void) => {
			listeners.add(listener)
			return {
				dispose: () => listeners.delete(listener),
			}
		}),
		fire: vi.fn((event: any) => {
			for (const listener of listeners) {
				listener(event)
			}
		}),
		dispose: vi.fn(() => {
			listeners.clear()
		}),
	}
}

// Mock vscode module
vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(),
		workspaceFolders: [
			{
				uri: {
					fsPath: "/mock/workspace",
				},
			},
		],
		fs: {
			stat: vi.fn().mockResolvedValue({ size: 1000 }),
			readFile: vi.fn().mockResolvedValue(Buffer.from("test content")),
		},
	},
	RelativePattern: vi.fn().mockImplementation(function (base, pattern) {
		return { base, pattern }
	}),
	Uri: {
		file: vi.fn().mockImplementation((path) => ({ fsPath: path })),
	},
	EventEmitter: vi.fn().mockImplementation(function () {
		return createMockEventEmitter()
	}),
	ExtensionContext: vi.fn(),
}))

describe("FileWatcher", () => {
	let fileWatcher: FileWatcher
	let mockWatcher: any
	let mockOnDidCreate: any
	let mockOnDidChange: any
	let mockOnDidDelete: any
	let mockContext: any
	let mockCacheManager: any
	let mockEmbedder: any
	let mockVectorStore: any
	let mockIgnoreInstance: any

	const waitForNextBatch = () =>
		new Promise<any>((resolve) => {
			const disposable = fileWatcher.onDidFinishBatchProcessing((summary) => {
				disposable.dispose()
				resolve(summary)
			})
		})

	const flushBatch = async () => {
		await vi.advanceTimersByTimeAsync(500)
	}

	beforeEach(() => {
		// Reset all mocks
		clearAllMocks()
		vi.useFakeTimers()

		// Create mock event handlers
		mockOnDidCreate = vi.fn()
		mockOnDidChange = vi.fn()
		mockOnDidDelete = vi.fn()

		// Create mock watcher
		mockWatcher = {
			onDidCreate: vi.fn().mockImplementation((handler) => {
				mockOnDidCreate = handler
				return { dispose: vi.fn() }
			}),
			onDidChange: vi.fn().mockImplementation((handler) => {
				mockOnDidChange = handler
				return { dispose: vi.fn() }
			}),
			onDidDelete: vi.fn().mockImplementation((handler) => {
				mockOnDidDelete = handler
				return { dispose: vi.fn() }
			}),
			dispose: vi.fn(),
		}

		// Mock createFileSystemWatcher to return our mock watcher
		vi.mocked(vscode.workspace.createFileSystemWatcher).mockReturnValue(mockWatcher)

		// Create mock dependencies
		mockContext = {
			subscriptions: [],
		}

		mockCacheManager = {
			getHash: vi.fn(),
			updateHash: vi.fn(),
			deleteHash: vi.fn(),
		}

		mockEmbedder = {
			createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] }),
		}

		mockVectorStore = {
			upsertPoints: vi.fn().mockResolvedValue(undefined),
			deletePointsByFilePath: vi.fn().mockResolvedValue(undefined),
			deletePointsByMultipleFilePaths: vi.fn().mockResolvedValue(undefined),
		}

		mockIgnoreInstance = {
			ignores: vi.fn().mockReturnValue(false),
		}

		fileWatcher = new FileWatcher(
			"/mock/workspace",
			mockContext,
			mockCacheManager,
			mockEmbedder,
			mockVectorStore,
			mockIgnoreInstance,
		)
	})

	afterEach(async () => {
		fileWatcher?.dispose()
		await vi.runOnlyPendingTimersAsync()
		vi.useRealTimers()
	})

	it("reuses constructor-created preparation for public processFile without writing points or cache", async () => {
		const prepare = vi.spyOn(FilePreparation.prototype, "prepareFile")
		try {
			const preparation = fileWatcher["filePreparation"]
			expect(preparation).toBeInstanceOf(FilePreparation)
			expect(preparation["dependencies"].fileSystem).toBe(vscode.workspace.fs)
			expect(preparation["dependencies"].cacheManager).toBe(mockCacheManager)
			expect(preparation["dependencies"].ignoreController).toBe(fileWatcher["ignoreController"])
			const path = "/mock/workspace/src/file.ts"
			const result = await fileWatcher.processFile(path)
			expect(prepare).toHaveBeenNthCalledWith(1, path)
			expect(result).toBe(await prepare.mock.results[0].value)
			expect(result.status).toBe("processed_for_batching")
			expect(result.pointsToUpsert).toHaveLength(1)
			expect(vscode.workspace.fs.stat).toHaveBeenCalledWith(vscode.Uri.file(path))
			expect(vscode.workspace.fs.readFile).toHaveBeenCalledWith(vscode.Uri.file(path))
			const secondPath = "/mock/workspace/src/second.ts"
			const secondResult = await fileWatcher.processFile(secondPath)
			expect(prepare).toHaveBeenCalledTimes(2)
			expect(prepare).toHaveBeenNthCalledWith(2, secondPath)
			expect(prepare.mock.contexts[0]).toBe(preparation)
			expect(prepare.mock.contexts[1]).toBe(preparation)
			expect(secondResult).toBe(await prepare.mock.results[1].value)
			expect(secondResult.status).toBe("processed_for_batching")
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
			expect(mockCacheManager.deleteHash).not.toHaveBeenCalled()
		} finally {
			prepare.mockRestore()
		}
	})

	describe("file filtering", () => {
		it("should ignore files in hidden directories on create events", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			const batchPromise = waitForNextBatch()

			// Simulate file creation events
			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.git/config", shouldProcess: false },
				{ path: "/mock/workspace/.hidden/file.ts", shouldProcess: false },
				{ path: "/mock/workspace/src/.next/static/file.js", shouldProcess: false },
				{ path: "/mock/workspace/node_modules/package/index.js", shouldProcess: false },
				{ path: "/mock/workspace/normal/file.js", shouldProcess: true },
			]

			// Trigger file creation events
			for (const { path } of testCases) {
				await mockOnDidCreate({ fsPath: path })
			}

			await flushBatch()

			const batchSummary = await batchPromise
			const successPaths = batchSummary.processedFiles
				.filter((result: any) => result.status === "success")
				.map((result: any) => result.path)
			const skippedPaths = batchSummary.processedFiles
				.filter((result: any) => result.status === "skipped")
				.map((result: any) => result.path)

			// Check that files in hidden directories were not processed
			expect(successPaths).toContain("/mock/workspace/src/file.ts")
			expect(successPaths).toContain("/mock/workspace/normal/file.js")
			expect(skippedPaths).toContain("/mock/workspace/.git/config")
			expect(skippedPaths).toContain("/mock/workspace/.hidden/file.ts")
			expect(skippedPaths).toContain("/mock/workspace/src/.next/static/file.js")
			expect(skippedPaths).toContain("/mock/workspace/node_modules/package/index.js")
		})

		it("should ignore files in hidden directories on change events", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			const batchPromise = waitForNextBatch()

			// Simulate file change events
			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.vscode/settings.json", shouldProcess: false },
				{ path: "/mock/workspace/src/.cache/data.json", shouldProcess: false },
				{ path: "/mock/workspace/dist/bundle.js", shouldProcess: false },
			]

			// Trigger file change events
			for (const { path } of testCases) {
				await mockOnDidChange({ fsPath: path })
			}

			await flushBatch()

			const batchSummary = await batchPromise
			const successPaths = batchSummary.processedFiles
				.filter((result: any) => result.status === "success")
				.map((result: any) => result.path)
			const skippedPaths = batchSummary.processedFiles
				.filter((result: any) => result.status === "skipped")
				.map((result: any) => result.path)

			// Check that files in hidden directories were not processed
			expect(successPaths).toContain("/mock/workspace/src/file.ts")
			expect(skippedPaths).toContain("/mock/workspace/.vscode/settings.json")
			expect(skippedPaths).toContain("/mock/workspace/src/.cache/data.json")
			expect(skippedPaths).toContain("/mock/workspace/dist/bundle.js")
		})

		it("should batch delete events after the debounce window", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			const deletedFiles: string[] = []
			mockVectorStore.deletePointsByMultipleFilePaths.mockImplementation(async (filePaths: string[]) => {
				deletedFiles.push(...filePaths)
			})
			const batchPromise = waitForNextBatch()

			// Simulate file deletion events
			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.git/objects/abc123", shouldProcess: false },
				{ path: "/mock/workspace/.DS_Store", shouldProcess: false },
				{ path: "/mock/workspace/build/.cache/temp.js", shouldProcess: false },
			]

			// Trigger file deletion events
			for (const { path } of testCases) {
				await mockOnDidDelete({ fsPath: path })
			}

			await flushBatch()
			await batchPromise

			expect(deletedFiles).toEqual(testCases.map(({ path }) => path))
		})

		it("should handle nested hidden directories correctly", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			const batchPromise = waitForNextBatch()

			// Test deeply nested hidden directories
			const testCases = [
				{ path: "/mock/workspace/src/components/Button.tsx", shouldProcess: true },
				{ path: "/mock/workspace/src/.hidden/components/Button.tsx", shouldProcess: false },
				{ path: "/mock/workspace/.hidden/src/components/Button.tsx", shouldProcess: false },
				{ path: "/mock/workspace/src/components/.hidden/Button.tsx", shouldProcess: false },
			]

			// Trigger file creation events
			for (const { path } of testCases) {
				await mockOnDidCreate({ fsPath: path })
			}

			await flushBatch()

			const batchSummary = await batchPromise
			const successPaths = batchSummary.processedFiles
				.filter((result: any) => result.status === "success")
				.map((result: any) => result.path)
			const skippedPaths = batchSummary.processedFiles
				.filter((result: any) => result.status === "skipped")
				.map((result: any) => result.path)

			// Check that files in hidden directories were not processed
			expect(successPaths).toContain("/mock/workspace/src/components/Button.tsx")
			expect(skippedPaths).toContain("/mock/workspace/src/.hidden/components/Button.tsx")
			expect(skippedPaths).toContain("/mock/workspace/.hidden/src/components/Button.tsx")
			expect(skippedPaths).toContain("/mock/workspace/src/components/.hidden/Button.tsx")
		})
	})

	describe("per-workspace circuit breaker", () => {
		/** Fire one create event, flush the debounce window, and wait for the batch to finish. */
		const runBatch = async (filePath: string) => {
			const batchPromise = waitForNextBatch()
			await mockOnDidCreate({ fsPath: filePath })
			await vi.advanceTimersByTimeAsync(500)
			return batchPromise
		}

		it("stops consuming file-system events after three consecutive failed batches", async () => {
			await fileWatcher.initialize()
			mockEmbedder.createEmbeddings.mockRejectedValue(new Error("embedder misconfigured"))

			// Three consecutive all-fail batches trip the breaker on the third.
			for (let i = 0; i < 3; i++) {
				const summary = await runBatch(`/mock/workspace/src/broken-${i}.ts`)
				expect(summary.processedFiles).toHaveLength(1)
				expect(summary.processedFiles[0].status).toBe("local_error")
			}
			expect(mockEmbedder.createEmbeddings).toHaveBeenCalledTimes(3)

			// Further events are dropped: no batch starts and no embedder call is made.
			const started = vi.fn()
			fileWatcher.onDidStartBatchProcessing(started)
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/after-breaker.ts" })
			await vi.advanceTimersByTimeAsync(500)
			expect(started).not.toHaveBeenCalled()
			expect(mockEmbedder.createEmbeddings).toHaveBeenCalledTimes(3)
		})

		it("resets the failure counter when a batch succeeds between failures", async () => {
			await fileWatcher.initialize()

			const fail = () => mockEmbedder.createEmbeddings.mockRejectedValue(new Error("down"))
			const succeed = () => mockEmbedder.createEmbeddings.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] })

			// Two consecutive failures...
			fail()
			await runBatch("/mock/workspace/src/fail-1.ts")
			await runBatch("/mock/workspace/src/fail-2.ts")

			// ...then a success resets the counter.
			succeed()
			await runBatch("/mock/workspace/src/ok-1.ts")

			// Only two failures since the reset: the breaker must stay closed.
			fail()
			await runBatch("/mock/workspace/src/fail-3.ts")
			await runBatch("/mock/workspace/src/fail-4.ts")

			const started = vi.fn()
			fileWatcher.onDidStartBatchProcessing(started)
			const batchPromise = waitForNextBatch()
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/fail-5.ts" })
			await vi.advanceTimersByTimeAsync(500)
			await batchPromise
			expect(started).toHaveBeenCalledTimes(1)

			// That third consecutive failure opens the breaker; the next event is dropped.
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/after-breaker.ts" })
			await vi.advanceTimersByTimeAsync(500)
			expect(started).toHaveBeenCalledTimes(1)
		})

		it("counts a batch whose upsert exhausts retries as a failed batch", async () => {
			await fileWatcher.initialize()
			mockVectorStore.upsertPoints.mockRejectedValue(new Error("qdrant down"))

			// Each batch exhausts MAX_BATCH_RETRIES (3 attempts) before failing.
			for (let i = 0; i < 3; i++) {
				const batchPromise = waitForNextBatch()
				await mockOnDidCreate({ fsPath: `/mock/workspace/src/upsert-fail-${i}.ts` })
				await vi.advanceTimersByTimeAsync(10_000)
				const summary = await batchPromise
				expect(summary.batchError).toBeDefined()
			}
			expect(mockVectorStore.upsertPoints).toHaveBeenCalledTimes(9)

			// Breaker is open: further events produce no upsert attempts at all.
			const upsertCalls = mockVectorStore.upsertPoints.mock.calls.length
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/after-breaker.ts" })
			await vi.advanceTimersByTimeAsync(10_000)
			expect(mockVectorStore.upsertPoints.mock.calls.length).toBe(upsertCalls)
		})

		it("does not open the breaker when only isolated files in a batch fail", async () => {
			await fileWatcher.initialize()

			const defaultReadFile = () => Buffer.from("test content")
			vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: vscode.Uri) => {
				if (uri.fsPath.includes("bad")) {
					throw new Error("EACCES: unreadable file")
				}
				return defaultReadFile()
			})

			try {
				// Five batches in a row where exactly one of two files fails must never
				// count as a consecutive failure.
				for (let i = 0; i < 5; i++) {
					const batchPromise = waitForNextBatch()
					await mockOnDidCreate({ fsPath: `/mock/workspace/src/ok-${i}.ts` })
					await mockOnDidCreate({ fsPath: `/mock/workspace/src/bad-${i}.ts` })
					await vi.advanceTimersByTimeAsync(500)
					const summary = await batchPromise
					expect(
						summary.processedFiles.some((result: FileProcessingResult) => result.status === "success"),
					).toBe(true)
					expect(
						summary.processedFiles.some((result: FileProcessingResult) => result.status === "local_error"),
					).toBe(true)
				}

				// Breaker still closed: the next batch runs normally.
				const started = vi.fn()
				fileWatcher.onDidStartBatchProcessing(started)
				const batchPromise = waitForNextBatch()
				await mockOnDidCreate({ fsPath: "/mock/workspace/src/still-ok.ts" })
				await vi.advanceTimersByTimeAsync(500)
				await batchPromise
				expect(started).toHaveBeenCalledTimes(1)
			} finally {
				vi.mocked(vscode.workspace.fs.readFile).mockReset()
				vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(defaultReadFile())
			}
		})
	})

	describe("dispose", () => {
		it("should dispose of the watcher when disposed", async () => {
			await fileWatcher.initialize()
			fileWatcher.dispose()

			expect(mockWatcher.dispose).toHaveBeenCalled()
		})
	})
})
