import { describe, it, expect, vi, beforeEach } from "vitest"
import { CodeIndexAdapter } from "../CodeIndexAdapter"
import type { CodeIndexManager } from "../../code-index/manager"
import type { VectorStoreSearchResult } from "../../code-index/interfaces/vector-store"

describe("CodeIndexAdapter", () => {
	let adapter: CodeIndexAdapter
	let mockManager: CodeIndexManager

	beforeEach(() => {
		mockManager = {
			getCurrentStatus: vi.fn().mockReturnValue({
				systemStatus: "Indexed",
				fileStatuses: {},
			}),
			searchIndex: vi.fn().mockResolvedValue([]),
		} as unknown as CodeIndexManager

		adapter = new CodeIndexAdapter(undefined, mockManager)
	})

	describe("searchVectorStore", () => {
		it("returns empty array when manager is not set", async () => {
			const adapterWithoutManager = new CodeIndexAdapter()
			const result = await adapterWithoutManager.searchVectorStore("test query")
			expect(result).toEqual([])
		})

		it("returns search results from manager", async () => {
			const mockResults: VectorStoreSearchResult[] = [
				{
					id: "file1",
					score: 0.95,
					payload: {
						filePath: "src/test.ts",
						startLine: 1,
						endLine: 10,
						codeChunk: "console.log('hello')",
					},
				},
			]
			vi.mocked(mockManager.searchIndex).mockResolvedValue(mockResults)

			const result = await adapter.searchVectorStore("test query")
			expect(result).toEqual(mockResults)
			expect(mockManager.searchIndex).toHaveBeenCalledWith("test query", undefined)
		})

		it("passes directoryPrefix to manager", async () => {
			vi.mocked(mockManager.searchIndex).mockResolvedValue([])

			await adapter.searchVectorStore("test query", "src/utils")
			expect(mockManager.searchIndex).toHaveBeenCalledWith("test query", "src/utils")
		})

		it("returns empty array on search error", async () => {
			vi.mocked(mockManager.searchIndex).mockRejectedValue(new Error("search failed"))

			const result = await adapter.searchVectorStore("test query")
			expect(result).toEqual([])
		})

		it("returns empty array when manager is set via setCodeIndexManager", async () => {
			const freshAdapter = new CodeIndexAdapter()
			freshAdapter.setCodeIndexManager(mockManager)
			vi.mocked(mockManager.searchIndex).mockResolvedValue([])

			const result = await freshAdapter.searchVectorStore("test query")
			expect(result).toEqual([])
			expect(mockManager.searchIndex).toHaveBeenCalledWith("test query", undefined)
		})
	})
})
