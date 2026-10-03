// npx vitest services/code-index/processors/__tests__/file-watcher.spec.ts

import * as vscode from "vscode"

import { FileWatcher } from "../file-watcher"
import { FilePreparation } from "../file-preparation"
import { INITIAL_RETRY_DELAY_MS, MAX_BATCH_RETRIES } from "../../constants"
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
		event: vi.fn((listener: (event: unknown) => void, thisArgs?: unknown) => {
			const boundListener = (event: unknown) => listener.call(thisArgs, event)
			listeners.add(boundListener)
			return {
				dispose: () => listeners.delete(boundListener),
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
		getConfiguration: vi.fn(),
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
		vi.mocked(vscode.workspace.getConfiguration).mockReset()
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

	describe("event batching", () => {
		it("leaves all hashes unchanged when a later point chunk exhausts retries", async () => {
			fileWatcher.dispose()
			fileWatcher = new FileWatcher(
				"/mock/workspace",
				mockContext,
				mockCacheManager,
				mockEmbedder,
				mockVectorStore,
				undefined,
				undefined,
				1,
			)
			await fileWatcher.initialize()
			const paths = ["/mock/workspace/a.ts", "/mock/workspace/b.ts"]
			mockVectorStore.upsertPoints
				.mockResolvedValueOnce(undefined)
				.mockRejectedValue(new Error("second chunk failed"))
			const summary = waitForNextBatch()
			for (const path of paths) await mockOnDidCreate(vscode.Uri.file(path))
			await flushBatch()
			await vi.runAllTimersAsync()
			expect(mockVectorStore.upsertPoints).toHaveBeenCalledTimes(1 + MAX_BATCH_RETRIES)
			expect(await summary).toEqual({
				processedFiles: paths.map((path) => ({ path, status: "error", error: expect.any(Error) })),
				batchError: expect.any(Error),
			})
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
		})

		it("allows an in-flight storage write to finish after disposal without publishing more events", async () => {
			await fileWatcher.initialize()
			let finishWrite!: () => void
			mockVectorStore.upsertPoints.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finishWrite = resolve
					}),
			)
			const path = "/mock/workspace/file.ts"
			const progress = vi.fn()
			const finished = vi.fn()
			fileWatcher.onBatchProgressUpdate(progress)
			fileWatcher.onDidFinishBatchProcessing(finished)
			await mockOnDidCreate(vscode.Uri.file(path))
			await flushBatch()
			expect(mockVectorStore.upsertPoints).toHaveBeenCalledTimes(1)
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
			fileWatcher.dispose()
			progress.mockClear()
			finishWrite()
			await vi.advanceTimersByTimeAsync(0)
			// Disposal stops notifications, not storage work already in flight.
			expect(mockCacheManager.updateHash).toHaveBeenCalledExactlyOnceWith(path, expect.any(String))
			expect(progress).not.toHaveBeenCalled()
			expect(finished).not.toHaveBeenCalled()
		})

		it.each([{ status: 503 }, { response: { status: 502 } }, { statusCode: 500 }, "storage unavailable"])(
			"blocks prepared upserts after deletion fails with %j",
			async (error) => {
				await fileWatcher.initialize()
				const path = "/mock/workspace/src/file.ts"
				mockVectorStore.deletePointsByMultipleFilePaths.mockRejectedValueOnce(error)
				const summary = waitForNextBatch()
				await mockOnDidChange(vscode.Uri.file(path))
				await flushBatch()
				expect(await summary).toEqual({ processedFiles: [{ path, status: "error", error }], batchError: error })
				expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
				expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
			},
		)

		it("reports a rejection without an error value as a missing preparation result", async () => {
			await fileWatcher.initialize()
			const path = "/mock/workspace/src/file.ts"
			const prepare = vi.spyOn(fileWatcher, "processFile").mockRejectedValue(undefined)
			const summary = waitForNextBatch()
			await mockOnDidCreate(vscode.Uri.file(path))
			await flushBatch()
			expect(await summary).toEqual({
				processedFiles: [
					{
						path,
						status: "error",
						error: expect.objectContaining({
							message: `Fulfilled promise with no result or error for file ${path}`,
						}),
					},
				],
				batchError: undefined,
			})
			prepare.mockRestore()
		})

		it.each(["explicit", "configuration"])("splits point writes using the %s batch size", async (source) => {
			fileWatcher.dispose()
			const configuration = { get: vi.fn().mockReturnValue(1), has: vi.fn(), inspect: vi.fn(), update: vi.fn() }
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration)
			fileWatcher = new FileWatcher(
				"/mock/workspace",
				mockContext,
				mockCacheManager,
				mockEmbedder,
				mockVectorStore,
				undefined,
				undefined,
				source === "explicit" ? 2 : undefined,
			)
			await fileWatcher.initialize()
			const paths = ["a", "b", "c"].map((name) => `/mock/workspace/${name}.ts`)
			const summary = waitForNextBatch()
			for (const path of paths) await mockOnDidCreate(vscode.Uri.file(path))
			await flushBatch()
			expect(await summary).toEqual({
				processedFiles: paths.map((path) => ({ path, status: "success" })),
				batchError: undefined,
			})
			expect(mockVectorStore.upsertPoints.mock.calls.map(([points]: [unknown[]]) => points.length)).toEqual(
				source === "explicit" ? [2, 1] : [1, 1, 1],
			)
			expect(mockCacheManager.updateHash).toHaveBeenCalledTimes(3)
		})

		it("does not write storage or cache when no vector store is supplied", async () => {
			fileWatcher.dispose()
			fileWatcher = new FileWatcher("/mock/workspace", mockContext, mockCacheManager, mockEmbedder)
			await fileWatcher.initialize()
			const summary = waitForNextBatch()
			await mockOnDidCreate(vscode.Uri.file("/mock/workspace/created.ts"))
			await mockOnDidDelete(vscode.Uri.file("/mock/workspace/deleted.ts"))
			await flushBatch()
			expect(await summary).toEqual({ processedFiles: [], batchError: undefined })
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
			expect(mockCacheManager.deleteHash).not.toHaveBeenCalled()
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
		})

		it.each(["local_error", "throw", "unexpected", "missing_points", "empty_points", "no_hash", "empty_path"])(
			"reports the preparation outcome %s without losing batch completion",
			async (outcome) => {
				await fileWatcher.initialize()
				const path = "/mock/workspace/src/file.ts"
				const error = new Error("preparation failed")
				const prepared = await fileWatcher.processFile(path)
				const prepare = vi.spyOn(fileWatcher, "processFile")
				if (outcome === "throw") prepare.mockRejectedValue(error)
				else {
					const results: Record<string, FileProcessingResult> = {
						local_error: { path, status: "local_error", error },
						unexpected: { path, status: "success" },
						missing_points: { path, status: "processed_for_batching" },
						empty_points: { path, status: "processed_for_batching", pointsToUpsert: [] },
						no_hash: { ...prepared, newHash: undefined },
						empty_path: { ...prepared, path: "" },
					}
					prepare.mockResolvedValue(results[outcome])
				}
				const summary = waitForNextBatch()
				await mockOnDidCreate(vscode.Uri.file(path))
				await flushBatch()
				const status = outcome === "local_error" ? "local_error" : outcome === "no_hash" ? "success" : "error"
				expect(await summary).toEqual({
					processedFiles:
						outcome === "empty_points" || outcome === "empty_path"
							? []
							: [outcome === "no_hash" ? { path, status } : { path, status, error: expect.any(Error) }],
					batchError: undefined,
				})
				expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
				if (outcome !== "no_hash" && outcome !== "empty_path")
					expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
				else expect(mockVectorStore.upsertPoints).toHaveBeenCalledExactlyOnceWith(prepared.pointsToUpsert)
				prepare.mockRestore()
			},
		)

		it.each(["recovery", "exhaustion"])(
			"preserves cached hashes until upsert retry %s is resolved",
			async (outcome) => {
				await fileWatcher.initialize()
				const path = "/mock/workspace/src/file.ts"
				const error = new Error("upsert unavailable")
				if (outcome === "recovery") mockVectorStore.upsertPoints.mockRejectedValueOnce(error)
				else mockVectorStore.upsertPoints.mockRejectedValue(error)
				const finished = vi.fn()
				fileWatcher.onDidFinishBatchProcessing(finished)
				await mockOnDidCreate(vscode.Uri.file(path))
				await flushBatch()
				expect(mockVectorStore.upsertPoints).toHaveBeenCalledTimes(1)
				expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
				expect(finished).not.toHaveBeenCalled()
				const attempts = outcome === "recovery" ? 2 : MAX_BATCH_RETRIES
				for (let attempt = 1; attempt < attempts; attempt++) {
					await vi.advanceTimersByTimeAsync(INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1) - 1)
					expect(mockVectorStore.upsertPoints).toHaveBeenCalledTimes(attempt)
					expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
					await vi.advanceTimersByTimeAsync(1)
				}
				expect(mockVectorStore.upsertPoints).toHaveBeenCalledTimes(attempts)
				if (outcome === "recovery") {
					expect(finished).toHaveBeenCalledExactlyOnceWith({
						processedFiles: [{ path, status: "success" }],
						batchError: undefined,
					})
					expect(mockCacheManager.updateHash).toHaveBeenCalledExactlyOnceWith(path, expect.any(String))
				} else {
					expect(finished).toHaveBeenCalledExactlyOnceWith({
						processedFiles: [{ path, status: "error", error: expect.any(Error) }],
						batchError: expect.objectContaining({ message: expect.stringContaining("upsert unavailable") }),
					})
					expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
				}
			},
		)

		it("reports deletion failure without removing cached hashes and processes subsequent events", async () => {
			await fileWatcher.initialize()
			const path = "/mock/workspace/src/file.ts"
			const error = new Error("storage unavailable")
			mockVectorStore.deletePointsByMultipleFilePaths.mockRejectedValueOnce(error)
			const failed = waitForNextBatch()
			await mockOnDidDelete(vscode.Uri.file(path))
			await flushBatch()
			expect(await failed).toEqual({
				processedFiles: [{ path, status: "error", error }],
				batchError: error,
			})
			expect(mockCacheManager.deleteHash).not.toHaveBeenCalled()
			const recovered = waitForNextBatch()
			await mockOnDidDelete(vscode.Uri.file(path))
			await flushBatch()
			expect(await recovered).toEqual({ processedFiles: [{ path, status: "success" }], batchError: undefined })
			expect(mockCacheManager.deleteHash).toHaveBeenCalledExactlyOnceWith(path)
		})

		it("starts a later batch while earlier storage work is pending and keeps their results separate", async () => {
			await fileWatcher.initialize()
			const firstPath = "/mock/workspace/src/first.ts"
			const secondPath = "/mock/workspace/src/second.ts"
			let releaseDeletion!: () => void
			mockVectorStore.deletePointsByMultipleFilePaths.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						releaseDeletion = resolve
					}),
			)
			const started = vi.fn()
			const finished = vi.fn()
			fileWatcher.onDidStartBatchProcessing(started)
			fileWatcher.onDidFinishBatchProcessing(finished)
			await mockOnDidDelete(vscode.Uri.file(firstPath))
			await flushBatch()
			await mockOnDidDelete(vscode.Uri.file(secondPath))
			await flushBatch()
			expect(started.mock.calls).toEqual([[[firstPath]], [[secondPath]]])
			expect(finished).toHaveBeenCalledExactlyOnceWith({
				processedFiles: [{ path: secondPath, status: "success" }],
				batchError: undefined,
			})
			const firstSummary = waitForNextBatch()
			releaseDeletion()
			expect(await firstSummary).toEqual({
				processedFiles: [{ path: firstPath, status: "success" }],
				batchError: undefined,
			})
			expect(finished).toHaveBeenCalledTimes(2)
		})

		it("cancels pending work when disposed before the debounce window ends", async () => {
			await fileWatcher.initialize()
			const started = vi.fn()
			const progress = vi.fn()
			const finished = vi.fn()
			fileWatcher.onDidStartBatchProcessing(started)
			fileWatcher.onBatchProgressUpdate(progress)
			fileWatcher.onDidFinishBatchProcessing(finished)

			await mockOnDidCreate(vscode.Uri.file("/mock/workspace/src/created.ts"))
			await mockOnDidDelete(vscode.Uri.file("/mock/workspace/src/deleted.ts"))
			await vi.advanceTimersByTimeAsync(499)
			fileWatcher.dispose()
			await vi.advanceTimersByTimeAsync(1000)

			expect(mockWatcher.dispose).toHaveBeenCalledTimes(1)
			expect(started).not.toHaveBeenCalled()
			expect(progress).not.toHaveBeenCalled()
			expect(finished).not.toHaveBeenCalled()
			expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled()
			expect(mockVectorStore.deletePointsByMultipleFilePaths).not.toHaveBeenCalled()
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
			expect(mockCacheManager.deleteHash).not.toHaveBeenCalled()
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
		})

		it("keeps events received during processing in a separate batch without replaying the first batch", async () => {
			await fileWatcher.initialize()
			const firstPath = "/mock/workspace/src/first.ts"
			const nextPath = "/mock/workspace/src/next.ts"
			let releaseDeletion!: () => void
			mockVectorStore.deletePointsByMultipleFilePaths.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						releaseDeletion = resolve
					}),
			)
			const started = vi.fn()
			const finished = vi.fn()
			fileWatcher.onDidStartBatchProcessing(started)
			fileWatcher.onDidFinishBatchProcessing(finished)
			const firstSummary = waitForNextBatch()

			await mockOnDidDelete(vscode.Uri.file(firstPath))
			await flushBatch()
			expect(started).toHaveBeenCalledExactlyOnceWith([firstPath])
			expect(finished).not.toHaveBeenCalled()

			await mockOnDidDelete(vscode.Uri.file(nextPath))
			releaseDeletion()
			expect(await firstSummary).toEqual({
				processedFiles: [{ path: firstPath, status: "success" }],
				batchError: undefined,
			})
			expect(started).toHaveBeenCalledTimes(1)

			await flushBatch()
			expect(started.mock.calls).toEqual([[[firstPath]], [[nextPath]]])
			expect(finished).toHaveBeenCalledTimes(2)
			expect(finished).toHaveBeenLastCalledWith({
				processedFiles: [{ path: nextPath, status: "success" }],
				batchError: undefined,
			})
			expect(mockVectorStore.deletePointsByMultipleFilePaths.mock.calls).toEqual([[[firstPath]], [[nextPath]]])
			await flushBatch()
			expect(started).toHaveBeenCalledTimes(2)
		})

		it("waits 500 ms after the latest event and includes distinct paths in one batch", async () => {
			await fileWatcher.initialize()
			const firstPath = "/mock/workspace/src/first.ts"
			const secondPath = "/mock/workspace/src/second.ts"
			const started = vi.fn()
			const finished = vi.fn()
			fileWatcher.onDidStartBatchProcessing(started)
			fileWatcher.onDidFinishBatchProcessing(finished)

			await mockOnDidDelete(vscode.Uri.file(firstPath))
			await vi.advanceTimersByTimeAsync(400)
			await mockOnDidDelete(vscode.Uri.file(secondPath))
			await vi.advanceTimersByTimeAsync(499)
			expect(started).not.toHaveBeenCalled()
			expect(finished).not.toHaveBeenCalled()
			expect(mockVectorStore.deletePointsByMultipleFilePaths).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(1)
			expect(started).toHaveBeenCalledExactlyOnceWith([firstPath, secondPath])
			expect(mockVectorStore.deletePointsByMultipleFilePaths).toHaveBeenCalledExactlyOnceWith([
				firstPath,
				secondPath,
			])
			expect(finished).toHaveBeenCalledExactlyOnceWith({
				processedFiles: [
					{ path: firstPath, status: "success" },
					{ path: secondPath, status: "success" },
				],
				batchError: undefined,
			})
		})

		it("keeps only the final delete when a path is created, changed and deleted within the debounce window", async () => {
			await fileWatcher.initialize()
			const path = "/mock/workspace/src/file.ts"
			const uri = vscode.Uri.file(path)
			const started = vi.fn()
			fileWatcher.onDidStartBatchProcessing(started)
			const summary = waitForNextBatch()

			await mockOnDidCreate(uri)
			await mockOnDidChange(uri)
			await mockOnDidDelete(uri)
			await flushBatch()

			expect(started).toHaveBeenCalledExactlyOnceWith([path])
			expect(await summary).toEqual({ processedFiles: [{ path, status: "success" }], batchError: undefined })
			expect(mockVectorStore.deletePointsByMultipleFilePaths).toHaveBeenCalledExactlyOnceWith([path])
			expect(mockCacheManager.deleteHash).toHaveBeenCalledExactlyOnceWith(path)
			expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled()
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
		})
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

	describe("dispose", () => {
		it("should dispose of the watcher when disposed", async () => {
			await fileWatcher.initialize()
			fileWatcher.dispose()

			expect(mockWatcher.dispose).toHaveBeenCalled()
		})
	})
})
