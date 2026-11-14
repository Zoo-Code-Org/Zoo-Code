// npx vitest services/code-index/processors/__tests__/scanner.spec.ts

import { DirectoryScanner } from "../scanner"
import { ParserLoadError } from "../parser"
import { FileFailureRegistry } from "../../file-failure-registry"
import { ProviderPacerRegistry } from "../../provider-pacer"
import { stat } from "fs/promises"
import { createHash } from "crypto"
import nodePath from "path"
import * as vscode from "vscode"

// Mock TelemetryService
vi.mock("../../../../../packages/telemetry/src/TelemetryService", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
		access: vi.fn(),
		rename: vi.fn(),
		constants: {},
	},
	stat: vi.fn(),
}))

// Create a simple mock for vscode since we can't access the real one
vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [
			{
				uri: {
					fsPath: "/mock/workspace",
				},
			},
		],
		getWorkspaceFolder: vi.fn().mockReturnValue({
			uri: {
				fsPath: "/mock/workspace",
			},
		}),
		fs: {
			readFile: vi.fn().mockResolvedValue(Buffer.from("test content")),
		},
	},
	Uri: {
		file: vi.fn().mockImplementation((path) => {
			return path
		}),
	},
	window: {
		activeTextEditor: {
			document: {
				uri: {
					fsPath: "/mock/workspace",
				},
			},
		},
	},
}))

vi.mock("../../../../core/ignore/RooIgnoreController")
vi.mock("ignore")

// Override the Jest-based mock with a vitest-compatible version
vi.mock("../../../glob/list-files", () => ({
	listFiles: vi.fn(),
}))

describe("DirectoryScanner", () => {
	let scanner: DirectoryScanner
	let mockEmbedder: any
	let mockVectorStore: any
	let mockCodeParser: any
	let mockCacheManager: any
	let mockIgnoreInstance: any
	let mockStats: any

	beforeEach(async () => {
		mockEmbedder = {
			rateLimitScope: "openai:1",
			createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] }),
			embedderInfo: { name: "mock-embedder", dimensions: 384 },
		}
		mockVectorStore = {
			rateLimitScope: "qdrant:1",
			upsertPoints: vi.fn().mockResolvedValue(undefined),
			deletePointsByFilePath: vi.fn().mockResolvedValue(undefined),
			deletePointsByMultipleFilePaths: vi.fn().mockResolvedValue(undefined),
			initialize: vi.fn().mockResolvedValue(true),
			search: vi.fn().mockResolvedValue([]),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			deleteCollection: vi.fn().mockResolvedValue(undefined),
			collectionExists: vi.fn().mockResolvedValue(true),
		}
		mockCodeParser = {
			parseFile: vi.fn().mockResolvedValue([]),
		}
		mockCacheManager = {
			getHash: vi.fn().mockReturnValue(undefined),
			getAllHashes: vi.fn().mockReturnValue({}),
			updateHash: vi.fn().mockResolvedValue(undefined),
			deleteHash: vi.fn().mockResolvedValue(undefined),
			initialize: vi.fn().mockResolvedValue(undefined),
			clearCacheFile: vi.fn().mockResolvedValue(undefined),
		}
		mockIgnoreInstance = {
			ignores: vi.fn().mockReturnValue(false),
		}

		scanner = new DirectoryScanner(
			mockEmbedder,
			mockVectorStore,
			mockCodeParser,
			mockCacheManager,
			mockIgnoreInstance,
			undefined,
			new FileFailureRegistry(),
			new ProviderPacerRegistry(),
		)

		// Mock default implementations - create proper Stats object
		mockStats = {
			size: 1024,
			isFile: () => true,
			isDirectory: () => false,
			isBlockDevice: () => false,
			isCharacterDevice: () => false,
			isSymbolicLink: () => false,
			isFIFO: () => false,
			isSocket: () => false,
			dev: 0,
			ino: 0,
			mode: 0,
			nlink: 0,
			uid: 0,
			gid: 0,
			rdev: 0,
			blksize: 0,
			blocks: 0,
			atimeMs: 0,
			mtimeMs: 0,
			ctimeMs: 0,
			birthtimeMs: 0,
			atime: new Date(),
			mtime: new Date(),
			ctime: new Date(),
			birthtime: new Date(),
			atimeNs: BigInt(0),
			mtimeNs: BigInt(0),
			ctimeNs: BigInt(0),
			birthtimeNs: BigInt(0),
		}
		vi.mocked(stat).mockResolvedValue(mockStats)

		// Get and mock the listFiles function
		const { listFiles } = await import("../../../glob/list-files")
		vi.mocked(listFiles).mockResolvedValue([["test/file1.js", "test/file2.js"], false])
	})

	describe("scanDirectory", () => {
		it("should skip files larger than MAX_FILE_SIZE_BYTES", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js"], false])

			// Create large file mock stats
			const largeFileStats = {
				...mockStats,
				size: 2 * 1024 * 1024, // 2MB > 1MB limit
			}
			vi.mocked(stat).mockResolvedValueOnce(largeFileStats)

			const result = await scanner.scanDirectory("/test")
			expect(result.stats.skipped).toBe(1)
			expect(mockCodeParser.parseFile).not.toHaveBeenCalled()
		})

		it("should parse changed files and return empty codeBlocks array", async () => {
			// Create scanner without embedder to test the non-embedding path
			const scannerNoEmbeddings = new DirectoryScanner(
				null as any, // No embedder
				null as any, // No vector store
				mockCodeParser,
				mockCacheManager,
				mockIgnoreInstance,
				undefined,
				new FileFailureRegistry(),
				new ProviderPacerRegistry(),
			)

			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js"], false])
			const mockBlocks: any[] = [
				{
					file_path: "test/file1.js",
					content: "test content",
					start_line: 1,
					end_line: 5,
					identifier: "test",
					type: "function",
					fileHash: "hash",
					segmentHash: "segment-hash",
				},
			]
			;(mockCodeParser.parseFile as any).mockResolvedValue(mockBlocks)

			const result = await scannerNoEmbeddings.scanDirectory("/test")
			expect(result.stats.processed).toBe(1)
		})

		it("should process embeddings for new/changed files", async () => {
			const mockBlocks: any[] = [
				{
					file_path: "test/file1.js",
					content: "test content",
					start_line: 1,
					end_line: 5,
					identifier: "test",
					type: "function",
					fileHash: "hash",
					segmentHash: "segment-hash",
				},
			]
			;(mockCodeParser.parseFile as any).mockResolvedValue(mockBlocks)

			await scanner.scanDirectory("/test")
			expect(mockEmbedder.createEmbeddings).toHaveBeenCalled()
			expect(mockVectorStore.upsertPoints).toHaveBeenCalled()
		})

		it("should clean up a threshold-triggered batch", async () => {
			const thresholdScanner = new DirectoryScanner(
				mockEmbedder,
				mockVectorStore,
				mockCodeParser,
				mockCacheManager,
				mockIgnoreInstance,
				1,
				new FileFailureRegistry(),
				new ProviderPacerRegistry(),
			)
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js"], false])
			mockCodeParser.parseFile.mockResolvedValue([
				{
					file_path: "test/file1.js",
					content: "test content",
					start_line: 1,
					end_line: 5,
					identifier: "test",
					type: "function",
					fileHash: "hash",
					segmentHash: "threshold-segment",
				},
			])

			await thresholdScanner.scanDirectory("/test")

			expect(mockEmbedder.createEmbeddings).toHaveBeenCalledTimes(1)
			expect(mockVectorStore.upsertPoints).toHaveBeenCalledTimes(1)
		})

		it("should delete points for removed files", async () => {
			;(mockCacheManager.getAllHashes as any).mockReturnValue({ "old/file.js": "old-hash" })

			await scanner.scanDirectory("/test")
			expect(mockVectorStore.deletePointsByFilePath).toHaveBeenCalledWith("old/file.js")
			expect(mockCacheManager.deleteHash).toHaveBeenCalledWith("old/file.js")
		})

		it("should filter out files in hidden directories", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			// Mock listFiles to return files including some in hidden directories
			vi.mocked(listFiles).mockResolvedValue([
				[
					"test/file1.js",
					"test/.hidden/file2.js",
					".git/config",
					"src/.next/static/file3.js",
					"normal/file4.js",
				],
				false,
			])

			// Mock parseFile to track which files are actually processed
			const processedFiles: string[] = []
			;(mockCodeParser.parseFile as any).mockImplementation((filePath: string) => {
				processedFiles.push(filePath)
				return []
			})

			await scanner.scanDirectory("/test")

			// Verify that only non-hidden files were processed
			expect(processedFiles).toEqual(["test/file1.js", "normal/file4.js"])
			expect(processedFiles).not.toContain("test/.hidden/file2.js")
			expect(processedFiles).not.toContain(".git/config")
			expect(processedFiles).not.toContain("src/.next/static/file3.js")

			// Verify the stats
			expect(mockCodeParser.parseFile).toHaveBeenCalledTimes(2)
		})

		it("should process markdown files alongside code files", async () => {
			// Create scanner without embedder to test the non-embedding path
			const scannerNoEmbeddings = new DirectoryScanner(
				null as any, // No embedder
				null as any, // No vector store
				mockCodeParser,
				mockCacheManager,
				mockIgnoreInstance,
				undefined,
				new FileFailureRegistry(),
				new ProviderPacerRegistry(),
			)

			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/README.md", "test/app.js", "docs/guide.markdown"], false])

			const mockMarkdownBlocks: any[] = [
				{
					file_path: "test/README.md",
					content: "# Introduction\nThis is a comprehensive guide...",
					start_line: 1,
					end_line: 10,
					identifier: "Introduction",
					type: "markdown_header_h1",
					fileHash: "md-hash",
					segmentHash: "md-segment-hash",
				},
			]

			const mockJsBlocks: any[] = [
				{
					file_path: "test/app.js",
					content: "function main() { return 'hello'; }",
					start_line: 1,
					end_line: 3,
					identifier: "main",
					type: "function",
					fileHash: "js-hash",
					segmentHash: "js-segment-hash",
				},
			]

			const mockMarkdownBlocks2: any[] = [
				{
					file_path: "docs/guide.markdown",
					content: "## Getting Started\nFollow these steps...",
					start_line: 1,
					end_line: 8,
					identifier: "Getting Started",
					type: "markdown_header_h2",
					fileHash: "markdown-hash",
					segmentHash: "markdown-segment-hash",
				},
			]

			// Mock parseFile to return different blocks based on file extension
			;(mockCodeParser.parseFile as any).mockImplementation((filePath: string) => {
				if (filePath.endsWith(".md")) {
					return mockMarkdownBlocks
				} else if (filePath.endsWith(".markdown")) {
					return mockMarkdownBlocks2
				} else if (filePath.endsWith(".js")) {
					return mockJsBlocks
				}
				return []
			})

			const result = await scannerNoEmbeddings.scanDirectory("/test")

			// Verify all files were processed
			expect(mockCodeParser.parseFile).toHaveBeenCalledTimes(3)
			expect(mockCodeParser.parseFile).toHaveBeenCalledWith("test/README.md", expect.any(Object))
			expect(mockCodeParser.parseFile).toHaveBeenCalledWith("test/app.js", expect.any(Object))
			expect(mockCodeParser.parseFile).toHaveBeenCalledWith("docs/guide.markdown", expect.any(Object))

			// Verify processing still works without codeBlocks accumulation
			expect(result.stats.processed).toBe(3)
		})

		it("should generate unique point IDs for each block from the same file", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/large-doc.md"], false])

			// Mock multiple blocks from the same file with different segmentHash values
			const mockBlocks: any[] = [
				{
					file_path: "test/large-doc.md",
					content: "# Introduction\nThis is the intro section...",
					start_line: 1,
					end_line: 10,
					identifier: "Introduction",
					type: "markdown_header_h1",
					fileHash: "same-file-hash",
					segmentHash: "unique-segment-hash-1",
				},
				{
					file_path: "test/large-doc.md",
					content: "## Getting Started\nHere's how to begin...",
					start_line: 11,
					end_line: 20,
					identifier: "Getting Started",
					type: "markdown_header_h2",
					fileHash: "same-file-hash",
					segmentHash: "unique-segment-hash-2",
				},
				{
					file_path: "test/large-doc.md",
					content: "## Advanced Topics\nFor advanced users...",
					start_line: 21,
					end_line: 30,
					identifier: "Advanced Topics",
					type: "markdown_header_h2",
					fileHash: "same-file-hash",
					segmentHash: "unique-segment-hash-3",
				},
			]

			;(mockCodeParser.parseFile as any).mockResolvedValue(mockBlocks)

			await scanner.scanDirectory("/test")

			// Verify that upsertPoints was called with unique IDs for each block
			expect(mockVectorStore.upsertPoints).toHaveBeenCalledTimes(1)
			const upsertCall = mockVectorStore.upsertPoints.mock.calls[0]
			const points = upsertCall[0]

			// Extract the IDs from the points
			const pointIds = points.map((point: any) => point.id)

			// Verify all IDs are unique
			expect(pointIds).toHaveLength(3)
			expect(new Set(pointIds).size).toBe(3) // All IDs should be unique

			// Verify that each point has the correct payload
			expect(points[0].payload.segmentHash).toBe("unique-segment-hash-1")
			expect(points[1].payload.segmentHash).toBe("unique-segment-hash-2")
			expect(points[2].payload.segmentHash).toBe("unique-segment-hash-3")
		})

		it("should stop processing files when signal is aborted", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js", "test/file2.js", "test/file3.js"], false])

			// Create an already-aborted signal
			const controller = new AbortController()
			controller.abort()

			const result = await scanner.scanDirectory("/test", undefined, undefined, undefined, controller.signal)

			// No files should have been processed since signal was already aborted
			expect(mockCodeParser.parseFile).not.toHaveBeenCalled()
			expect(result.stats.processed).toBe(0)
		})

		it("should not write once the signal aborts mid-scan", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js", "test/file2.js"], false])

			const controller = new AbortController()

			const mockBlocks: any[] = [
				{
					file_path: "test/file1.js",
					content: "function hello() {}",
					start_line: 1,
					end_line: 3,
					identifier: "hello",
					type: "function",
					fileHash: "hash1",
					segmentHash: "seg-hash-1",
				},
			]

			// Abort after first file is parsed
			;(mockCodeParser.parseFile as any).mockImplementation(async () => {
				controller.abort()
				return mockBlocks
			})

			await scanner.scanDirectory("/test", undefined, undefined, undefined, controller.signal)
			expect(mockEmbedder.createEmbeddings).not.toHaveBeenCalled()
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
		})

		it.each(["stat", "read"] as const)(
			"CI-SC-01: a file missing at %s is dropped and its old entries deleted without a failure",
			async (stage) => {
				const failures = new FileFailureRegistry()
				const missingScanner = new DirectoryScanner(
					mockEmbedder,
					mockVectorStore,
					mockCodeParser,
					mockCacheManager,
					mockIgnoreInstance,
					undefined,
					failures,
					new ProviderPacerRegistry(),
				)
				const { listFiles } = await import("../../../glob/list-files")
				vi.mocked(listFiles).mockResolvedValue([["test/gone.js"], false])
				mockCacheManager.getAllHashes.mockReturnValue({ "test/gone.js": "old-hash" })
				const missing = Object.assign(new Error("gone"), { code: "ENOENT" })
				if (stage === "stat") vi.mocked(stat).mockRejectedValueOnce(missing)
				else vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(missing)

				await missingScanner.scanDirectory("/test")

				expect(mockCodeParser.parseFile).not.toHaveBeenCalled()
				expect(mockVectorStore.deletePointsByFilePath).toHaveBeenCalledWith("test/gone.js")
				expect(mockCacheManager.deleteHash).toHaveBeenCalledWith("test/gone.js")
				expect(failures.list()).toEqual([])
			},
		)

		it("records a non-missing read error as a read failure", async () => {
			const failures = new FileFailureRegistry()
			const readScanner = new DirectoryScanner(
				mockEmbedder,
				mockVectorStore,
				mockCodeParser,
				mockCacheManager,
				mockIgnoreInstance,
				undefined,
				failures,
				new ProviderPacerRegistry(),
			)
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/denied.js"], false])
			vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))

			await readScanner.scanDirectory("/test")

			expect(failures.list()).toEqual([expect.objectContaining({ activity: "read", reason: "denied" })])
			expect(mockVectorStore.deletePointsByFilePath).not.toHaveBeenCalled()
		})

		it("clears a read failure once the read succeeds with unchanged content", async () => {
			const failures = new FileFailureRegistry()
			const recoveryScanner = new DirectoryScanner(
				mockEmbedder,
				mockVectorStore,
				mockCodeParser,
				mockCacheManager,
				mockIgnoreInstance,
				undefined,
				failures,
				new ProviderPacerRegistry(),
			)
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/cached.js"], false])
			mockCacheManager.getHash.mockReturnValue(createHash("sha256").update("test content").digest("hex"))
			vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))

			await recoveryScanner.scanDirectory("/test")
			expect(failures.list()).toEqual([expect.objectContaining({ activity: "read" })])

			const result = await recoveryScanner.scanDirectory("/test")
			expect(result.stats.skipped).toBe(1)
			expect(failures.list()).toEqual([])
		})

		it.each([
			["parser load", new ParserLoadError(".js", new Error("wasm"))],
			["parse", new Error("syntax")],
		])(
			"CI-SC-02: a %s failure is recorded, the hash is not stored and other files continue",
			async (_label, error) => {
				const failures = new FileFailureRegistry()
				const parseScanner = new DirectoryScanner(
					mockEmbedder,
					mockVectorStore,
					mockCodeParser,
					mockCacheManager,
					mockIgnoreInstance,
					undefined,
					failures,
					new ProviderPacerRegistry(),
				)
				const block = {
					file_path: "test/file2.js",
					content: "ok",
					start_line: 1,
					end_line: 1,
					identifier: null,
					type: "function",
					fileHash: "h",
					segmentHash: "s",
				}
				mockCodeParser.parseFile.mockImplementation(async (filePath: string) => {
					if (filePath === "test/file1.js") throw error
					return [block]
				})

				await parseScanner.scanDirectory("/test")

				expect(failures.list()).toEqual([
					expect.objectContaining({ path: nodePath.normalize("test/file1.js"), activity: "parse" }),
				])
				expect(mockCacheManager.updateHash).not.toHaveBeenCalledWith("test/file1.js", expect.anything())
				expect(mockCacheManager.updateHash).toHaveBeenCalledWith("test/file2.js", expect.any(String))
			},
		)

		it("should not process deleted files when signal is aborted", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([[], false])

			// Set up cached files that would normally be detected as deleted
			;(mockCacheManager.getAllHashes as any).mockReturnValue({ "old/file.js": "old-hash" })

			// Create an already-aborted signal
			const controller = new AbortController()
			controller.abort()

			await scanner.scanDirectory("/test", undefined, undefined, undefined, controller.signal)

			// Deleted file cleanup should not have run
			expect(mockVectorStore.deletePointsByFilePath).not.toHaveBeenCalled()
		})
	})
})
