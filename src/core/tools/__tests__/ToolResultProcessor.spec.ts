// Run: cd src && npx vitest run core/tools/__tests__/ToolResultProcessor.spec.ts

import { ToolResultProcessor } from "../ToolResultProcessor"
import type { ToolResultProcessorConfig } from "../ToolResultProcessorConfig"
import { DEFAULT_PROCESSOR_CONFIG } from "../ToolResultProcessorConfig"

// ── helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ToolResultProcessorConfig> = {}): ToolResultProcessorConfig {
	return {
		...DEFAULT_PROCESSOR_CONFIG,
		...overrides,
		thresholds: {
			...DEFAULT_PROCESSOR_CONFIG.thresholds,
			...(overrides.thresholds ?? {}),
		},
	}
}

/** Generates a string of `n` repeated characters */
function repeat(char: string, n: number): string {
	return char.repeat(n)
}

/** Generates a list of `n` file paths (one per line) */
function makePathList(n: number): string {
	return Array.from({ length: n }, (_, i) => `src/file${i}.ts`).join("\n")
}

/** Generates a list of `n` non-empty search-result lines */
function makeMatchList(n: number): string {
	return Array.from({ length: n }, (_, i) => `src/foo.ts:${i + 1}: match line ${i + 1}`).join("\n")
}

// ── shouldCompress ────────────────────────────────────────────────────────────

describe("ToolResultProcessor.shouldCompress", () => {
	const processor = new ToolResultProcessor(null)

	it("returns false when config.enabled is false", () => {
		const config = makeConfig({ enabled: false, isSubscriber: true })
		const bigResult = repeat("x", 2000)
		expect(processor.shouldCompress("read_file", bigResult, config)).toBe(false)
	})

	it("returns false when config.isSubscriber is false", () => {
		const config = makeConfig({ enabled: true, isSubscriber: false })
		const bigResult = repeat("x", 2000)
		expect(processor.shouldCompress("read_file", bigResult, config)).toBe(false)
	})

	it("returns false for unsupported tool names", () => {
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const bigResult = repeat("x", 2000)
		expect(processor.shouldCompress("attempt_completion", bigResult, config)).toBe(false)
		expect(processor.shouldCompress("write_to_file", bigResult, config)).toBe(false)
		expect(processor.shouldCompress("apply_diff", bigResult, config)).toBe(false)
		expect(processor.shouldCompress("unknown_tool", bigResult, config)).toBe(false)
	})

	it("returns true for read_file when result exceeds threshold", () => {
		const config = makeConfig({
			enabled: true,
			isSubscriber: true,
			thresholds: {
				readFileCharsAbove: 1500,
				searchMatchesAbove: 20,
				listFilesCountAbove: 100,
				executeCommandCharsAbove: 1500,
			},
		})
		const bigResult = repeat("x", 1501)
		expect(processor.shouldCompress("read_file", bigResult, config)).toBe(true)
	})

	it("returns false for read_file when result is below threshold", () => {
		const config = makeConfig({
			enabled: true,
			isSubscriber: true,
			thresholds: {
				readFileCharsAbove: 1500,
				searchMatchesAbove: 20,
				listFilesCountAbove: 100,
				executeCommandCharsAbove: 1500,
			},
		})
		const smallResult = repeat("x", 1000)
		expect(processor.shouldCompress("read_file", smallResult, config)).toBe(false)
	})

	it("returns false for read_file when result is exactly at threshold", () => {
		const config = makeConfig({
			enabled: true,
			isSubscriber: true,
			thresholds: {
				readFileCharsAbove: 1500,
				searchMatchesAbove: 20,
				listFilesCountAbove: 100,
				executeCommandCharsAbove: 1500,
			},
		})
		const exactResult = repeat("x", 1500)
		expect(processor.shouldCompress("read_file", exactResult, config)).toBe(false)
	})

	it("returns true for search_files with many matches", () => {
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const manyMatches = makeMatchList(21)
		expect(processor.shouldCompress("search_files", manyMatches, config)).toBe(true)
	})

	it("returns false for search_files with few matches", () => {
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const fewMatches = makeMatchList(10)
		expect(processor.shouldCompress("search_files", fewMatches, config)).toBe(false)
	})

	it("returns true for codebase_search with many matches", () => {
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const manyMatches = makeMatchList(21)
		expect(processor.shouldCompress("codebase_search", manyMatches, config)).toBe(true)
	})

	it("returns true for list_files with many paths", () => {
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const manyPaths = makePathList(101)
		expect(processor.shouldCompress("list_files", manyPaths, config)).toBe(true)
	})

	it("returns false for list_files with few paths", () => {
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const fewPaths = makePathList(50)
		expect(processor.shouldCompress("list_files", fewPaths, config)).toBe(false)
	})

	it("returns true for execute_command with large output", () => {
		const config = makeConfig({
			enabled: true,
			isSubscriber: true,
			thresholds: {
				readFileCharsAbove: 1500,
				searchMatchesAbove: 20,
				listFilesCountAbove: 100,
				executeCommandCharsAbove: 1500,
			},
		})
		const bigOutput = repeat("x", 1501)
		expect(processor.shouldCompress("execute_command", bigOutput, config)).toBe(true)
	})

	it("returns false for execute_command with small output", () => {
		const config = makeConfig({
			enabled: true,
			isSubscriber: true,
			thresholds: {
				readFileCharsAbove: 1500,
				searchMatchesAbove: 20,
				listFilesCountAbove: 100,
				executeCommandCharsAbove: 1500,
			},
		})
		const smallOutput = repeat("x", 100)
		expect(processor.shouldCompress("execute_command", smallOutput, config)).toBe(false)
	})
})

// ── compress ──────────────────────────────────────────────────────────────────

describe("ToolResultProcessor.compress", () => {
	it("returns raw result when no API handler is provided", async () => {
		const processor = new ToolResultProcessor(null)
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const rawResult = repeat("x", 2000)
		const result = await processor.compress("read_file", rawResult, "find the main function", config)
		expect(result).toBe(rawResult)
	})

	it("returns raw result when shouldCompress would return false (disabled)", async () => {
		const mockHandler = {
			createMessage: vi.fn(),
			getModel: vi.fn(),
			countTokens: vi.fn(),
		}
		const processor = new ToolResultProcessor(mockHandler as any)
		const config = makeConfig({ enabled: false, isSubscriber: true })
		const rawResult = repeat("x", 2000)
		const result = await processor.compress("read_file", rawResult, "find the main function", config)
		expect(result).toBe(rawResult)
		expect(mockHandler.createMessage).not.toHaveBeenCalled()
	})

	it("returns raw result when shouldCompress would return false (not subscriber)", async () => {
		const mockHandler = {
			createMessage: vi.fn(),
			getModel: vi.fn(),
			countTokens: vi.fn(),
		}
		const processor = new ToolResultProcessor(mockHandler as any)
		const config = makeConfig({ enabled: true, isSubscriber: false })
		const rawResult = repeat("x", 2000)
		const result = await processor.compress("read_file", rawResult, "find the main function", config)
		expect(result).toBe(rawResult)
		expect(mockHandler.createMessage).not.toHaveBeenCalled()
	})

	it("calls the compression API handler when conditions are met", async () => {
		const compressed = "compressed result"

		async function* fakeStream() {
			yield { type: "text", text: compressed }
		}

		const mockHandler = {
			createMessage: vi.fn().mockReturnValue(fakeStream()),
			getModel: vi.fn(),
			countTokens: vi.fn(),
		}
		const processor = new ToolResultProcessor(mockHandler as any)
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const rawResult = repeat("x", 2000)

		const result = await processor.compress("read_file", rawResult, "find the main function", config)

		expect(mockHandler.createMessage).toHaveBeenCalledTimes(1)
		expect(result).toBe(compressed)
	})

	it("accumulates multiple text chunks from the API stream", async () => {
		async function* fakeStream() {
			yield { type: "text", text: "part1 " }
			yield { type: "usage", inputTokens: 10, outputTokens: 5 } // non-text chunk
			yield { type: "text", text: "part2" }
		}

		const mockHandler = {
			createMessage: vi.fn().mockReturnValue(fakeStream()),
			getModel: vi.fn(),
			countTokens: vi.fn(),
		}
		const processor = new ToolResultProcessor(mockHandler as any)
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const rawResult = repeat("x", 2000)

		const result = await processor.compress("read_file", rawResult, "context", config)
		expect(result).toBe("part1 part2")
	})

	it("returns raw result on API error (graceful degradation)", async () => {
		const mockHandler = {
			createMessage: vi.fn().mockImplementation(() => {
				throw new Error("API unavailable")
			}),
			getModel: vi.fn(),
			countTokens: vi.fn(),
		}
		const processor = new ToolResultProcessor(mockHandler as any)
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const rawResult = repeat("x", 2000)

		const result = await processor.compress("read_file", rawResult, "find the main function", config)
		expect(result).toBe(rawResult)
	})

	it("returns raw result on async iteration error (graceful degradation)", async () => {
		async function* failingStream() {
			yield { type: "text", text: "partial" }
			throw new Error("stream error")
		}

		const mockHandler = {
			createMessage: vi.fn().mockReturnValue(failingStream()),
			getModel: vi.fn(),
			countTokens: vi.fn(),
		}
		const processor = new ToolResultProcessor(mockHandler as any)
		const config = makeConfig({ enabled: true, isSubscriber: true })
		const rawResult = repeat("x", 2000)

		const result = await processor.compress("read_file", rawResult, "context", config)
		expect(result).toBe(rawResult)
	})
})

// ── getCompressionPrompt ──────────────────────────────────────────────────────

describe("ToolResultProcessor.getCompressionPrompt", () => {
	const processor = new ToolResultProcessor(null)
	const rawResult = "some raw content"
	const context = "find the authentication logic"

	it("returns a read_file-specific prompt that includes the context", () => {
		const prompt = processor.getCompressionPrompt("read_file", rawResult, context)
		expect(prompt).toContain(context)
		expect(prompt).toContain("Extract")
		expect(prompt).toContain("line numbers")
	})

	it("returns a search_files-specific prompt that includes the context", () => {
		const prompt = processor.getCompressionPrompt("search_files", rawResult, context)
		expect(prompt).toContain(context)
		expect(prompt).toContain("top 5")
	})

	it("returns the same search prompt for codebase_search as for search_files", () => {
		const searchPrompt = processor.getCompressionPrompt("search_files", rawResult, context)
		const codebasePrompt = processor.getCompressionPrompt("codebase_search", rawResult, context)
		expect(codebasePrompt).toBe(searchPrompt)
	})

	it("returns a list_files-specific prompt that includes the context", () => {
		const prompt = processor.getCompressionPrompt("list_files", rawResult, context)
		expect(prompt).toContain(context)
		expect(prompt).toContain("directory listing")
	})

	it("returns an execute_command-specific prompt that includes the context", () => {
		const prompt = processor.getCompressionPrompt("execute_command", rawResult, context)
		expect(prompt).toContain(context)
		expect(prompt).toContain("errors")
		expect(prompt).toContain("warnings")
	})

	it("returns a generic prompt for unknown tool types", () => {
		const prompt = processor.getCompressionPrompt("unknown_tool", rawResult, context)
		expect(prompt).toContain(context)
		expect(typeof prompt).toBe("string")
		expect(prompt.length).toBeGreaterThan(0)
	})

	it("includes the context parameter in every supported tool prompt", () => {
		const tools = ["read_file", "search_files", "list_files", "codebase_search", "execute_command"]
		for (const tool of tools) {
			const prompt = processor.getCompressionPrompt(tool, rawResult, context)
			expect(prompt).toContain(context)
		}
	})
})
