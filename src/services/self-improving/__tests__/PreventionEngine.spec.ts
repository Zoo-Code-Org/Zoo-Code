import { describe, it, expect, vi, beforeEach } from "vitest"
import { PreventionEngine } from "../PreventionEngine"
import type { CodeIndexAdapter } from "../CodeIndexAdapter"
import type { VectorStoreSearchResult } from "../../code-index/interfaces/vector-store"

describe("PreventionEngine", () => {
	let engine: PreventionEngine
	let mockAdapter: CodeIndexAdapter

	beforeEach(() => {
		mockAdapter = {
			isAvailable: vi.fn().mockReturnValue(true),
			searchVectorStore: vi.fn().mockResolvedValue([]),
			getInfo: vi.fn().mockReturnValue({ available: true, hits: 1 }),
			setCodeIndexManager: vi.fn(),
			search: vi.fn().mockResolvedValue([]),
			startIndexing: vi.fn().mockResolvedValue(undefined),
			stopIndexing: vi.fn(),
			clearIndex: vi.fn().mockResolvedValue(undefined),
		} as unknown as CodeIndexAdapter

		engine = new PreventionEngine(mockAdapter)
	})

	describe("enrichContextWithCodeIndex", () => {
		it("returns original message when adapter is not available", async () => {
			vi.mocked(mockAdapter.isAvailable).mockReturnValue(false)
			const result = await engine.enrichContextWithCodeIndex("write a function")
			expect(result).toBe("write a function")
		})

		it("returns original message when adapter returns empty results", async () => {
			vi.mocked(mockAdapter.searchVectorStore).mockResolvedValue([])
			const result = await engine.enrichContextWithCodeIndex("write a function")
			expect(result).toBe("write a function")
		})

		it("enriches message with search results", async () => {
			const mockResults: VectorStoreSearchResult[] = [
				{
					id: "file1",
					score: 0.95,
					payload: {
						filePath: "src/utils/helper.ts",
						startLine: 10,
						endLine: 20,
						codeChunk: "export function helper() { return 42 }",
					},
				},
			]
			vi.mocked(mockAdapter.searchVectorStore).mockResolvedValue(mockResults)

			const result = await engine.enrichContextWithCodeIndex("write a helper function")
			expect(result).toContain("write a helper function")
			expect(result).toContain("Relevant existing code from codebase:")
			expect(result).toContain("src/utils/helper.ts")
			expect(result).toContain("lines 10-20")
			expect(result).toContain("export function helper() { return 42 }")
		})

		it("handles search results without line numbers", async () => {
			const mockResults: VectorStoreSearchResult[] = [
				{
					id: "file2",
					score: 0.85,
					payload: {
						filePath: "src/config.ts",
						codeChunk: "const API_URL = 'https://api.example.com'",
						startLine: 10,
						endLine: 10,
					},
				},
			]
			vi.mocked(mockAdapter.searchVectorStore).mockResolvedValue(mockResults)

			const result = await engine.enrichContextWithCodeIndex("find API URL")
			expect(result).toContain("src/config.ts")
			expect(result).not.toContain("lines")
		})

		it("gracefully falls back on search error", async () => {
			vi.mocked(mockAdapter.searchVectorStore).mockRejectedValue(new Error("search failed"))
			const result = await engine.enrichContextWithCodeIndex("write a function")
			expect(result).toBe("write a function")
		})

		it("returns original message when adapter is undefined", async () => {
			const engineWithoutAdapter = new PreventionEngine()
			const result = await engineWithoutAdapter.enrichContextWithCodeIndex("write a function")
			expect(result).toBe("write a function")
		})

		it("truncates long code snippets to 200 chars", async () => {
			const longSnippet = "x".repeat(500)
			const mockResults: VectorStoreSearchResult[] = [
				{
					id: "file3",
					score: 0.9,
					payload: {
						filePath: "src/long.ts",
						startLine: 1,
						endLine: 100,
						codeChunk: longSnippet,
					},
				},
			]
			vi.mocked(mockAdapter.searchVectorStore).mockResolvedValue(mockResults)

			const result = await engine.enrichContextWithCodeIndex("find long file")
			// Should contain truncated snippet (200 chars with newlines replaced)
			expect(result).toContain("src/long.ts")
			expect(result).toContain("lines 1-100")
		})
	})

	describe("getPreventionContext", () => {
		it("returns prevention context without code index enrichment", () => {
			const context = engine.getPreventionContext("write_to_file", { path: "/test.ts" })
			expect(context).toHaveProperty("preValidation")
			expect(context).toHaveProperty("cascadeWarning")
			expect(context).toHaveProperty("preventionHints")
			expect(context).toHaveProperty("recentErrors")
		})
	})
})
