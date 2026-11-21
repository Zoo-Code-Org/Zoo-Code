import { describe, it, expect, vi } from "vitest"
import { stripReasoningForCondensing, summarizeConversation } from "../index"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import type { ApiHandler } from "../../../api"

vi.mock("../../../api/transform/image-cleaning", () => ({
	maybeRemoveImageBlocks: vi.fn((messages: ApiMessage[]) => [...messages]),
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureContextCondensed: vi.fn(),
		},
	},
}))

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
		] as unknown as ApiMessage[]

		const result = stripReasoningForCondensing(messages)

		expect(result).toHaveLength(2)
		expect(result[0].content).toBe("hello")
		expect(result[1].content).toEqual([{ type: "text", text: "answer" }])
	})

	it("keeps a reasoning-only assistant turn with a placeholder so turns still alternate", () => {
		const messages = [
			{ role: "user", content: "question", ts: 1 },
			{
				role: "assistant",
				ts: 2,
				content: [{ type: "reasoning", encrypted_content: "opaque" }],
			},
			{ role: "user", content: "follow-up", ts: 3 },
		] as unknown as ApiMessage[]

		const result = stripReasoningForCondensing(messages)

		expect(result.map((m) => m.role)).toEqual(["user", "assistant", "user"])
		expect(result[1].content).toEqual([{ type: "text", text: "[Reasoning omitted]" }])
	})

	it("removes Anthropic-style thinking and redacted_thinking blocks", () => {
		const messages = [
			{ role: "user", content: "question", ts: 1 },
			{
				role: "assistant",
				ts: 2,
				content: [
					{ type: "thinking", thinking: "thoughts", signature: "sig" },
					{ type: "redacted_thinking", data: "opaque" },
					{ type: "text", text: "answer" },
				],
			},
			{
				role: "assistant",
				ts: 3,
				content: [{ type: "redacted_thinking", data: "opaque-only" }],
			},
		] as unknown as ApiMessage[]

		const result = stripReasoningForCondensing(messages)

		expect(result).toHaveLength(3)
		expect(result[1].content).toEqual([{ type: "text", text: "answer" }])
		expect(result[2].content).toEqual([{ type: "text", text: "[Reasoning omitted]" }])
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

describe("summarizeConversation reasoning handling", () => {
	it("sends the summarization request without reasoning and with tool use preserved", async () => {
		const createMessage = vi.fn((_systemPrompt: string, _messages: unknown[]) =>
			(async function* () {
				yield { type: "text" as const, text: "summary" }
			})(),
		)
		const apiHandler = {
			createMessage,
			countTokens: vi.fn(() => Promise.resolve(100)),
			getModel: vi.fn(() => ({ id: "test-model", info: { contextWindow: 8000, maxTokens: 4000 } })),
		} as unknown as ApiHandler

		const messages = [
			{ role: "user", content: "Read the config", ts: 1 },
			{
				role: "assistant",
				ts: 2,
				content: [
					{ type: "reasoning", text: "private chain of thought that must not be sent" },
					{ type: "tool_use", id: "t1", name: "read_file", input: { path: "config.json" } },
				],
			},
			{
				role: "user",
				ts: 3,
				content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }],
			},
			{ role: "assistant", ts: 4, content: [{ type: "reasoning", text: "more thinking" }] },
			{ role: "user", ts: 5, content: "Now summarize" },
		] as unknown as ApiMessage[]

		const inputSnapshot = structuredClone(messages)

		const result = await summarizeConversation({
			messages,
			apiHandler,
			systemPrompt: "system",
			taskId: "task-1",
		})

		expect(result.error).toBeUndefined()
		// The stored history keeps its reasoning; only the request copy is filtered.
		expect(JSON.stringify(result.messages)).toContain("private chain of thought that must not be sent")
		// The caller's input is not mutated.
		expect(messages).toEqual(inputSnapshot)
		expect(createMessage).toHaveBeenCalledTimes(1)
		const requestMessages = createMessage.mock.calls[0][1] as Array<{ role: string; content: unknown }>
		const serialized = JSON.stringify(requestMessages)

		expect(serialized).not.toContain("private chain of thought")
		expect(serialized).not.toContain("more thinking")
		expect(serialized).toContain("read_file")
		expect(serialized).toContain("config.json")
		expect(requestMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "user"])
	})
})
