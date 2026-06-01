import { describe, it, expect, vi, beforeEach } from "vitest"
import * as path from "path"
import { SembleProvider } from "../provider"
import { SembleCLI } from "../semble-cli"
import { SEMBLE_DEFAULTS } from "../types"

// Mock SembleCLI - use a shared mock instance
const sharedMockCli = {
	checkInstalled: vi.fn(),
	search: vi.fn(),
	findRelated: vi.fn(),
}

vi.mock("../semble-cli", () => ({
	SembleCLI: vi.fn().mockImplementation(() => sharedMockCli),
}))

// Mock semble-downloader
vi.mock("../semble-downloader", () => ({
	isSembleSupportedPlatform: vi.fn().mockReturnValue(true),
	downloadSemble: vi.fn().mockResolvedValue("/mock/storage/semble/semble"),
}))

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

// Mock vscode
vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
}))

import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { isSembleSupportedPlatform, downloadSemble } from "../semble-downloader"

describe("SembleProvider", () => {
	let provider: SembleProvider
	let mockCli: any
	let mockStateManager: any
	let mockContext: any

	beforeEach(() => {
		vi.clearAllMocks()
		;(isSembleSupportedPlatform as any).mockReturnValue(true)
		;(downloadSemble as any).mockResolvedValue("/mock/storage/semble/semble")

		mockStateManager = {
			setSystemState: vi.fn(),
		}

		mockContext = {
			globalStorageUri: { fsPath: "/mock/storage" },
		}

		provider = new SembleProvider("/workspace", mockContext, mockStateManager)
		mockCli = sharedMockCli
	})

	describe("constructor", () => {
		it("should create provider with default options", () => {
			const p = new SembleProvider("/workspace", mockContext, mockStateManager)
			expect(p).toBeDefined()
			expect(p.state).toBe("Standby")
		})

		it("should create provider with custom topK and content", () => {
			const p = new SembleProvider("/workspace", mockContext, mockStateManager, {
				topK: 5,
				content: "all",
			})
			expect(p).toBeDefined()
		})
	})

	describe("initialize", () => {
		it("should auto-download and set state to Indexed when semble works", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true })

			await provider.initialize()

			expect(downloadSemble).toHaveBeenCalledWith("/mock/storage")
			expect(provider.state).toBe("Indexed")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Indexed",
				"Semble is ready. Searches index on-the-fly.",
			)
		})

		it("should set state to Error when platform is unsupported", async () => {
			;(isSembleSupportedPlatform as any).mockReturnValue(false)

			await provider.initialize()

			expect(provider.state).toBe("Error")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Error",
				expect.stringContaining("not supported on this platform"),
			)
		})

		it("should set state to Error when download fails", async () => {
			;(downloadSemble as any).mockRejectedValue(new Error("network error"))

			await provider.initialize()

			expect(provider.state).toBe("Error")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Error",
				expect.stringContaining("Failed to download semble"),
			)
		})

		it("should set state to Error when semble check fails after download", async () => {
			mockCli.checkInstalled.mockResolvedValue({
				installed: false,
				error: "binary not functional",
			})

			await provider.initialize()

			expect(provider.state).toBe("Error")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Error",
				expect.stringContaining("binary not functional"),
			)
		})

		it("should not re-initialize if already initialized", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true })

			await provider.initialize()
			await provider.initialize()

			expect(mockCli.checkInstalled).toHaveBeenCalledTimes(1)
		})
	})

	describe("startIndexing", () => {
		it("should initialize if not already initialized", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true })

			await provider.startIndexing()

			expect(provider.state).toBe("Indexed")
		})

		it("should not change state if in Error state", async () => {
			;(isSembleSupportedPlatform as any).mockReturnValue(false)

			await provider.initialize()
			await provider.startIndexing()

			expect(provider.state).toBe("Error")
		})

		it("should mark as Indexed when already initialized", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true })

			await provider.initialize()
			await provider.startIndexing()

			expect(provider.state).toBe("Indexed")
		})
	})

	describe("stopIndexing", () => {
		it("should be a no-op", () => {
			provider.stopIndexing()
			// No error thrown, no state change
			expect(provider.state).toBe("Standby")
		})
	})

	describe("searchIndex", () => {
		beforeEach(async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true })
			await provider.initialize()
		})

		it("should return empty array when not initialized", async () => {
			const uninitializedProvider = new SembleProvider("/workspace", mockContext, mockStateManager)
			const results = await uninitializedProvider.searchIndex("test query")
			expect(results).toEqual([])
		})

		it("should search using CLI and convert results", async () => {
			const mockResults = [
				{
					chunk: {
						content: "function authenticate() {}",
						file_path: "src/auth.ts",
						start_line: 10,
						end_line: 25,
						language: "typescript",
						location: "src/auth.ts:10-25",
					},
					score: 0.92,
				},
				{
					chunk: {
						content: "export function login() {}",
						file_path: "src/login.ts",
						start_line: 5,
						end_line: 15,
						language: "typescript",
						location: "src/login.ts:5-15",
					},
					score: 0.78,
				},
			]

			mockCli.search.mockResolvedValue(mockResults)

			const results = await provider.searchIndex("authentication")

			expect(mockCli.search).toHaveBeenCalledWith("authentication", "/workspace", {
				topK: SEMBLE_DEFAULTS.DEFAULT_TOP_K,
				content: SEMBLE_DEFAULTS.DEFAULT_CONTENT,
			})

			expect(results).toHaveLength(2)
			expect(results[0]).toEqual({
				id: "semble-0",
				score: 0.92,
				payload: {
					filePath: "/workspace/src/auth.ts",
					codeChunk: "function authenticate() {}",
					startLine: 10,
					endLine: 25,
				},
			})
			expect(results[1]).toEqual({
				id: "semble-1",
				score: 0.78,
				payload: {
					filePath: "/workspace/src/login.ts",
					codeChunk: "export function login() {}",
					startLine: 5,
					endLine: 15,
				},
			})
		})

		it("should filter out results with missing file_path", async () => {
			const mockResults = [
				{
					chunk: {
						content: "good result",
						file_path: "src/good.ts",
						start_line: 1,
						end_line: 10,
						language: "typescript",
						location: "src/good.ts:1-10",
					},
					score: 0.8,
				},
				{
					chunk: {
						content: "no file path result",
						file_path: "",
						start_line: 1,
						end_line: 5,
						language: "typescript",
						location: "",
					},
					score: 0.5,
				},
				{
					chunk: {
						content: "null file path result",
						file_path: null,
						start_line: 1,
						end_line: 5,
						language: null,
						location: "",
					},
					score: 0.3,
				},
			]

			mockCli.search.mockResolvedValue(mockResults)

			const results = await provider.searchIndex("test")

			expect(results).toHaveLength(1)
			expect(results[0].payload?.filePath).toBe("/workspace/src/good.ts")
		})

		it("should always search workspace root regardless of directoryPrefix", async () => {
			mockCli.search.mockResolvedValue([])

			await provider.searchIndex("test", "/custom/path")

			// Should always pass workspace root to semble, not the directoryPrefix
			expect(mockCli.search).toHaveBeenCalledWith("test", "/workspace", {
				topK: SEMBLE_DEFAULTS.DEFAULT_TOP_K,
				content: SEMBLE_DEFAULTS.DEFAULT_CONTENT,
			})
		})

		it("should always search workspace root with relative directoryPrefix", async () => {
			mockCli.search.mockResolvedValue([])

			await provider.searchIndex("test", "src/subdir")

			// Should always pass workspace root to semble
			expect(mockCli.search).toHaveBeenCalledWith("test", "/workspace", {
				topK: SEMBLE_DEFAULTS.DEFAULT_TOP_K,
				content: SEMBLE_DEFAULTS.DEFAULT_CONTENT,
			})
		})

		it("should filter results by directoryPrefix when provided", async () => {
			const mockResults = [
				{
					chunk: {
						content: "code in src/auth",
						file_path: "src/auth/login.ts",
						start_line: 1,
						end_line: 10,
						language: "typescript",
						location: "src/auth/login.ts:1-10",
					},
					score: 0.95,
				},
				{
					chunk: {
						content: "code in src/utils",
						file_path: "src/utils/helper.ts",
						start_line: 5,
						end_line: 15,
						language: "typescript",
						location: "src/utils/helper.ts:5-15",
					},
					score: 0.8,
				},
				{
					chunk: {
						content: "code in root",
						file_path: "README.md",
						start_line: 1,
						end_line: 5,
						language: "markdown",
						location: "README.md:1-5",
					},
					score: 0.6,
				},
			]

			mockCli.search.mockResolvedValue(mockResults)

			const results = await provider.searchIndex("test", "src/auth")

			// Only the src/auth result should pass the filter
			expect(results).toHaveLength(1)
			expect(results[0].payload?.filePath).toBe("/workspace/src/auth/login.ts")
		})

		it("should not filter results when no directoryPrefix is provided", async () => {
			const mockResults = [
				{
					chunk: {
						content: "code in src/auth",
						file_path: "src/auth/login.ts",
						start_line: 1,
						end_line: 10,
						language: "typescript",
						location: "src/auth/login.ts:1-10",
					},
					score: 0.95,
				},
				{
					chunk: {
						content: "code in src/utils",
						file_path: "src/utils/helper.ts",
						start_line: 5,
						end_line: 15,
						language: "typescript",
						location: "src/utils/helper.ts:5-15",
					},
					score: 0.8,
				},
			]

			mockCli.search.mockResolvedValue(mockResults)

			const results = await provider.searchIndex("test")

			// All results should be returned
			expect(results).toHaveLength(2)
		})

		it("should return empty array on search error and log telemetry", async () => {
			mockCli.search.mockRejectedValue(new Error("Search failed"))

			const results = await provider.searchIndex("test")

			expect(results).toEqual([])
			expect(TelemetryService.instance.captureEvent).toHaveBeenCalledWith(
				TelemetryEventName.CODE_INDEX_ERROR,
				expect.objectContaining({
					location: "SembleProvider.searchIndex",
				}),
			)
		})

		it("should return empty array when in Error state", async () => {
			;(isSembleSupportedPlatform as any).mockReturnValue(false)
			const errorProvider = new SembleProvider("/workspace", mockContext, mockStateManager)
			await errorProvider.initialize()
			;(isSembleSupportedPlatform as any).mockReturnValue(true) // reset for other tests
			const results = await errorProvider.searchIndex("test")
			expect(results).toEqual([])
		})
	})

	describe("clearIndexData", () => {
		it("should reset state to Standby", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true })
			await provider.initialize()

			await provider.clearIndexData()

			expect(provider.state).toBe("Standby")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Standby",
				"Semble provider reset. On-disk cache remains until next rebuild.",
			)
		})
	})

	describe("dispose", () => {
		it("should reset initialization state", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true })
			await provider.initialize()

			provider.dispose()

			// After dispose, searchIndex should return empty array
			const results = await provider.searchIndex("test")
			expect(results).toEqual([])
		})
	})

	describe("_convertResults edge cases", () => {
		beforeEach(async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true })
			await provider.initialize()
		})

		it("should handle results with null content using empty string fallback", async () => {
			const mockResults = [
				{
					chunk: {
						content: null,
						file_path: "src/file.ts",
						start_line: null,
						end_line: null,
						language: null,
						location: "",
					},
					score: 0.6,
				},
			]

			mockCli.search.mockResolvedValue(mockResults)

			const results = await provider.searchIndex("test")

			expect(results).toHaveLength(1)
			expect(results[0].payload?.codeChunk).toBe("")
			expect(results[0].payload?.startLine).toBe(0)
			expect(results[0].payload?.endLine).toBe(0)
		})

		it("should handle results with undefined content fields", async () => {
			const mockResults = [
				{
					chunk: {
						content: undefined,
						file_path: "src/file.ts",
						start_line: undefined,
						end_line: undefined,
						language: undefined,
						location: "",
					},
					score: 0.5,
				},
			]

			mockCli.search.mockResolvedValue(mockResults)

			const results = await provider.searchIndex("test")

			expect(results).toHaveLength(1)
			expect(results[0].payload?.codeChunk).toBe("")
			expect(results[0].payload?.startLine).toBe(0)
			expect(results[0].payload?.endLine).toBe(0)
		})

		it("should normalize backslashes in file paths", async () => {
			const mockResults = [
				{
					chunk: {
						content: "code",
						file_path: "src\\nested\\file.ts",
						start_line: 1,
						end_line: 10,
						language: "typescript",
						location: "",
					},
					score: 0.8,
				},
			]

			mockCli.search.mockResolvedValue(mockResults)

			const results = await provider.searchIndex("test")

			expect(results).toHaveLength(1)
			expect(results[0].payload?.filePath).not.toContain("\\")
			expect(results[0].payload?.filePath).toContain("/")
		})

		it("should always join file paths against workspace root, even with directoryPrefix", async () => {
			const mockResults = [
				{
					chunk: {
						content: "code",
						file_path: "src/file.ts",
						start_line: 1,
						end_line: 5,
						language: "typescript",
						location: "",
					},
					score: 0.9,
				},
			]

			mockCli.search.mockResolvedValue(mockResults)

			// Even with a directoryPrefix, file paths are joined against workspace root
			const results = await provider.searchIndex("test", "src")

			expect(results[0].payload?.filePath).toBe("/workspace/src/file.ts")
		})

		it("should assign sequential semble-N IDs to results", async () => {
			const mockResults = [
				{
					chunk: {
						content: "a",
						file_path: "a.ts",
						start_line: 1,
						end_line: 2,
						language: "ts",
						location: "",
					},
					score: 0.9,
				},
				{
					chunk: {
						content: "b",
						file_path: "b.ts",
						start_line: 1,
						end_line: 2,
						language: "ts",
						location: "",
					},
					score: 0.8,
				},
				{
					chunk: {
						content: "c",
						file_path: "c.ts",
						start_line: 1,
						end_line: 2,
						language: "ts",
						location: "",
					},
					score: 0.7,
				},
			]

			mockCli.search.mockResolvedValue(mockResults)

			const results = await provider.searchIndex("test")

			expect(results[0].id).toBe("semble-0")
			expect(results[1].id).toBe("semble-1")
			expect(results[2].id).toBe("semble-2")
		})
	})

	describe("initialize error edge cases", () => {
		it("should set Error state when download returns no path (undefined)", async () => {
			;(downloadSemble as any).mockResolvedValue(undefined)

			await provider.initialize()

			expect(provider.state).toBe("Error")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Error",
				expect.stringContaining("Failed to download semble"),
			)
		})

		it("should set Error state with default message when checkInstalled returns no error string", async () => {
			mockCli.checkInstalled.mockResolvedValue({
				installed: false,
				error: undefined,
			})

			await provider.initialize()

			expect(provider.state).toBe("Error")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Error",
				expect.stringContaining("Semble binary is not functional"),
			)
		})
	})

	describe("custom config options", () => {
		it("should pass custom topK to CLI search", async () => {
			const customProvider = new SembleProvider("/workspace", mockContext, mockStateManager, {
				topK: 5,
			})

			mockCli.checkInstalled.mockResolvedValue({ installed: true })
			await customProvider.initialize()
			mockCli.search.mockResolvedValue([])

			await customProvider.searchIndex("test")

			expect(mockCli.search).toHaveBeenCalledWith("test", "/workspace", {
				topK: 5,
				content: "code",
			})
		})

		it("should pass custom content type to CLI search", async () => {
			const customProvider = new SembleProvider("/workspace", mockContext, mockStateManager, {
				content: "all",
			})

			mockCli.checkInstalled.mockResolvedValue({ installed: true })
			await customProvider.initialize()
			mockCli.search.mockResolvedValue([])

			await customProvider.searchIndex("test")

			expect(mockCli.search).toHaveBeenCalledWith("test", "/workspace", {
				topK: 10,
				content: "all",
			})
		})
	})
})
