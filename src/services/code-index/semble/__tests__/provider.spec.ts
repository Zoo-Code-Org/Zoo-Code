import { describe, it, expect, vi, beforeEach } from "vitest"
import { SembleProvider } from "../provider"
import { SembleCLI } from "../semble-cli"
import { SEMBLE_DEFAULTS } from "../types"

// Mock SembleCLI
vi.mock("../semble-cli", () => ({
	SembleCLI: vi.fn().mockImplementation(() => ({
		checkInstalled: vi.fn(),
		search: vi.fn(),
		findRelated: vi.fn(),
	})),
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

describe("SembleProvider", () => {
	let provider: SembleProvider
	let mockCli: any
	let mockStateManager: any
	let mockContext: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockStateManager = {
			setSystemState: vi.fn(),
		}

		mockContext = {}

		provider = new SembleProvider("/workspace", mockContext, mockStateManager, "semble")
		mockCli = (SembleCLI as any).mock.results[0].value
	})

	describe("constructor", () => {
		it("should create provider with default options", () => {
			const p = new SembleProvider("/workspace", mockContext, mockStateManager)
			expect(p).toBeDefined()
			expect(p.state).toBe("Standby")
		})

		it("should create provider with custom semble path", () => {
			const p = new SembleProvider("/workspace", mockContext, mockStateManager, "/usr/local/bin/semble")
			expect(p).toBeDefined()
		})

		it("should create provider with custom topK and content", () => {
			const p = new SembleProvider("/workspace", mockContext, mockStateManager, "semble", {
				topK: 5,
				content: "all",
			})
			expect(p).toBeDefined()
		})
	})

	describe("initialize", () => {
		it("should set state to Indexed when semble is installed", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true, version: "unknown" })

			await provider.initialize()

			expect(provider.state).toBe("Indexed")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Indexed",
				"Semble is ready. Searches index on-the-fly.",
			)
		})

		it("should set state to Error when semble is not installed", async () => {
			mockCli.checkInstalled.mockResolvedValue({
				installed: false,
				error: "semble: command not found",
			})

			await provider.initialize()

			expect(provider.state).toBe("Error")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Error",
				expect.stringContaining("semble: command not found"),
			)
		})

		it("should not re-initialize if already initialized", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true, version: "unknown" })

			await provider.initialize()
			await provider.initialize()

			expect(mockCli.checkInstalled).toHaveBeenCalledTimes(1)
		})
	})

	describe("startIndexing", () => {
		it("should initialize if not already initialized", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true, version: "unknown" })

			await provider.startIndexing()

			expect(provider.state).toBe("Indexed")
		})

		it("should not change state if in Error state", async () => {
			mockCli.checkInstalled.mockResolvedValue({
				installed: false,
				error: "not found",
			})

			await provider.initialize()
			await provider.startIndexing()

			expect(provider.state).toBe("Error")
		})

		it("should mark as Indexed when already initialized", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true, version: "unknown" })

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
			mockCli.checkInstalled.mockResolvedValue({ installed: true, version: "unknown" })
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

		it("should use directoryPrefix when provided", async () => {
			mockCli.search.mockResolvedValue([])

			await provider.searchIndex("test", "/custom/path")

			expect(mockCli.search).toHaveBeenCalledWith("test", "/custom/path", {
				topK: SEMBLE_DEFAULTS.DEFAULT_TOP_K,
				content: SEMBLE_DEFAULTS.DEFAULT_CONTENT,
			})
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
			const errorProvider = new SembleProvider("/workspace", mockContext, mockStateManager)
			const errorCli = (SembleCLI as any).mock.results[(SembleCLI as any).mock.results.length - 1].value
			errorCli.checkInstalled.mockResolvedValue({
				installed: false,
				error: "not found",
			})
			await errorProvider.initialize()

			const results = await errorProvider.searchIndex("test")
			expect(results).toEqual([])
		})
	})

	describe("clearIndexData", () => {
		it("should reset state to Standby", async () => {
			mockCli.checkInstalled.mockResolvedValue({ installed: true, version: "unknown" })
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
			mockCli.checkInstalled.mockResolvedValue({ installed: true, version: "unknown" })
			await provider.initialize()

			provider.dispose()

			// After dispose, searchIndex should return empty array
			const results = await provider.searchIndex("test")
			expect(results).toEqual([])
		})
	})
})