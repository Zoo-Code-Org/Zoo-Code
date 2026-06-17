// npx vitest services/code-index/processors/__tests__/file-watcher.spec.ts

import * as vscode from "vscode"

import { FileWatcher } from "../file-watcher"

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
		vi.clearAllMocks()
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
