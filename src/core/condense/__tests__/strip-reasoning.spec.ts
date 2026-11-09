import { describe, it, expect } from "vitest"
import { stripReasoningForCondensing } from "../index"
import type { ApiMessage } from "../../task-persistence/apiMessages"

describe("stripReasoningForCondensing", () => {
	it("removes plain-text and encrypted reasoning blocks but keeps other content", () => {
		const messages = [
			{ role: "user", content: "hello", ts: 1 },
			{
				role: "assistant",
				ts: 2,
				content: [
					{ type: "reasoning", text: "long private thinking" },
					{ type: "text", text: "answer" },
				],
			},
			{
				role: "assistant",
				ts: 3,
				content: [{ type: "reasoning", encrypted_content: "opaque" }],
			},
		] as unknown as ApiMessage[]

		const result = stripReasoningForCondensing(messages)

		expect(result).toHaveLength(2)
		expect(result[0].content).toBe("hello")
		expect(result[1].content).toEqual([{ type: "text", text: "answer" }])
	})

	it("drops standalone reasoning items", () => {
		const messages = [
			{ role: "user", content: "question", ts: 1 },
			{ type: "reasoning", text: "thinking", ts: 2 },
		] as unknown as ApiMessage[]

		const result = stripReasoningForCondensing(messages)

		expect(result).toHaveLength(1)
		expect(result[0].content).toBe("question")
	})

	it("leaves messages without reasoning unchanged", () => {
		const message = {
			role: "assistant",
			ts: 1,
			content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }],
		} as unknown as ApiMessage

		const result = stripReasoningForCondensing([message])

		expect(result[0]).toBe(message)
	})
})
