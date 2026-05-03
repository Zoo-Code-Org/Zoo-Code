import { CompletionPostProcessor } from "../CompletionPostProcessor"
import type { ApiHandler } from "../../../api/index"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandler(chunks: string[], shouldThrow = false): ApiHandler {
	return {
		createMessage: (_systemPrompt: string, _messages: unknown) => {
			if (shouldThrow) {
				throw new Error("API error")
			}
			// Return an async iterable that yields text chunks
			return (async function* () {
				for (const text of chunks) {
					yield { type: "text" as const, text }
				}
			})() as any
		},
	} as unknown as ApiHandler
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CompletionPostProcessor", () => {
	describe("isAvailable", () => {
		it("returns false when handler is null", () => {
			const processor = new CompletionPostProcessor(null)
			expect(processor.isAvailable).toBe(false)
		})

		it("returns true when handler is provided", () => {
			const processor = new CompletionPostProcessor(makeHandler(["ok"]))
			expect(processor.isAvailable).toBe(true)
		})
	})

	describe("postProcess", () => {
		it("returns original text when handler is null", async () => {
			const processor = new CompletionPostProcessor(null)
			const text = "A".repeat(300)
			const result = await processor.postProcess(text)
			expect(result).toBe(text)
		})

		it("returns original text when result is short (< 200 chars)", async () => {
			const shortText = "Short result."
			const processor = new CompletionPostProcessor(makeHandler(["reformatted"]))
			const result = await processor.postProcess(shortText)
			expect(result).toBe(shortText)
		})

		it("calls handler and returns reformatted text on success", async () => {
			const longText = "A".repeat(200)
			const processor = new CompletionPostProcessor(makeHandler(["**File created.** All tests pass."]))
			const result = await processor.postProcess(longText)
			expect(result).toBe("**File created.** All tests pass.")
		})

		it("concatenates multiple text chunks from stream", async () => {
			const longText = "B".repeat(200)
			const processor = new CompletionPostProcessor(makeHandler(["chunk1 ", "chunk2 ", "chunk3"]))
			const result = await processor.postProcess(longText)
			expect(result).toBe("chunk1 chunk2 chunk3")
		})

		it("returns original text on handler error (graceful degradation)", async () => {
			const longText = "C".repeat(200)
			const processor = new CompletionPostProcessor(makeHandler([], true))
			const result = await processor.postProcess(longText)
			expect(result).toBe(longText)
		})
	})
})
