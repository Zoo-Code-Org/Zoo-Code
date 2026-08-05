// npx vitest run api/providers/utils/__tests__/reasoning-history-guard.spec.ts

import { historyHasToolCallsWithoutReasoning } from "../reasoning-history-guard"

describe("historyHasToolCallsWithoutReasoning", () => {
	it("returns false for empty messages", () => {
		expect(historyHasToolCallsWithoutReasoning([])).toBe(false)
	})

	it("returns false when no assistant messages have tool_calls", () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		]
		expect(historyHasToolCallsWithoutReasoning(messages)).toBe(false)
	})

	it("returns false when assistant messages have tool_calls with reasoning_content", () => {
		const messages = [
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "call_1", function: { name: "test" } }],
				reasoning_content: "I should call test because...",
			},
		]
		expect(historyHasToolCallsWithoutReasoning(messages)).toBe(false)
	})

	it("returns true when assistant messages have tool_calls but no reasoning_content field", () => {
		const messages = [
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "call_1", function: { name: "test" } }],
			},
		]
		expect(historyHasToolCallsWithoutReasoning(messages)).toBe(true)
	})

	it("returns true when assistant messages have tool_calls with empty reasoning_content", () => {
		const messages = [
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "call_1", function: { name: "test" } }],
				reasoning_content: "",
			},
		]
		expect(historyHasToolCallsWithoutReasoning(messages)).toBe(true)
	})

	it("returns true when assistant messages have empty tool_calls array", () => {
		const messages = [
			{
				role: "assistant",
				content: "hello",
				tool_calls: [],
			},
		]
		expect(historyHasToolCallsWithoutReasoning(messages)).toBe(false)
	})

	it("returns false for non-assistant messages with tool_calls", () => {
		const messages = [
			{
				role: "user",
				content: "hello",
				tool_calls: [{ id: "call_1" }],
			},
		]
		expect(historyHasToolCallsWithoutReasoning(messages)).toBe(false)
	})

	it("returns true when at least one assistant message is missing reasoning_content despite tool_calls", () => {
		const messages = [
			{
				role: "assistant",
				content: "Let me think...",
				reasoning_content: "thinking step 1",
			},
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "call_1", function: { name: "read_file" } }],
				// no reasoning_content — this is the problematic message
			},
			{
				role: "tool",
				content: "file content",
				tool_call_id: "call_1",
			},
		]
		expect(historyHasToolCallsWithoutReasoning(messages)).toBe(true)
	})

	it("handles non-array tool_calls gracefully", () => {
		const messages = [
			{
				role: "assistant",
				content: null,
				tool_calls: "not-an-array" as unknown as unknown[],
			},
		]
		expect(historyHasToolCallsWithoutReasoning(messages)).toBe(false)
	})
})
