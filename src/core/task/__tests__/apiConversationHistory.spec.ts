import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { prepareApiConversationMessage } from "../apiConversationHistory.js"

describe("prepareApiConversationMessage", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("prepends Anthropic thinking blocks with thought signatures", () => {
		const result = prepareApiConversationMessage({
			message: { role: "assistant", content: "answer" },
			reasoning: "private reasoning",
			api: {
				getResponseId: () => "response-1",
				getThoughtSignature: () => "signature-1",
			} as any,
			apiConfiguration: { apiProvider: "anthropic", apiModelId: "claude-3-5-sonnet" } as any,
			apiConversationHistory: [],
		}) as any

		expect(result).toMatchObject({
			role: "assistant",
			id: "response-1",
			ts: Date.now(),
		})
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "private reasoning", signature: "signature-1" },
			{ type: "text", text: "answer" },
		])
	})

	it("preserves non-Anthropic reasoning block shape", () => {
		const result = prepareApiConversationMessage({
			message: { role: "assistant", content: "answer" },
			reasoning: "visible reasoning",
			api: {} as any,
			apiConfiguration: { apiProvider: "openrouter", openRouterModelId: "openai/gpt-4" } as any,
			apiConversationHistory: [],
		}) as any

		expect(result.content).toEqual([
			{ type: "reasoning", text: "visible reasoning", summary: [] },
			{ type: "text", text: "answer" },
		])
	})

	it("falls back to generic reasoning blocks for Anthropic messages without thought signatures", () => {
		const result = prepareApiConversationMessage({
			message: { role: "assistant", content: "answer" },
			reasoning: "private reasoning",
			api: {} as any,
			apiConfiguration: { apiProvider: "anthropic", apiModelId: "claude-3-5-sonnet" } as any,
			apiConversationHistory: [],
		}) as any

		expect(result.content).toEqual([
			{ type: "reasoning", text: "private reasoning", summary: [] },
			{ type: "text", text: "answer" },
		])
		expect(result.ts).toBe(Date.now())
	})

	it("preserves encrypted reasoning content", () => {
		const result = prepareApiConversationMessage({
			message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
			api: {
				getEncryptedContent: () => ({ encrypted_content: "encrypted", id: "reasoning-1" }),
			} as any,
			apiConfiguration: { apiProvider: "openrouter", openRouterModelId: "openai/gpt-4" } as any,
			apiConversationHistory: [],
		}) as any

		expect(result.content).toEqual([
			{ type: "reasoning", summary: [], encrypted_content: "encrypted", id: "reasoning-1" },
			{ type: "text", text: "answer" },
		])
	})

	it("appends thought signatures for non-Anthropic protocols", () => {
		const result = prepareApiConversationMessage({
			message: { role: "assistant", content: "answer" },
			api: {
				getThoughtSignature: () => "signature-1",
				getReasoningDetails: () => [{ type: "reasoning", text: "detail" }],
			} as any,
			apiConfiguration: { apiProvider: "openrouter", openRouterModelId: "openai/gpt-4" } as any,
			apiConversationHistory: [],
		}) as any

		expect(result.reasoning_details).toEqual([{ type: "reasoning", text: "detail" }])
		expect(result.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thoughtSignature", thoughtSignature: "signature-1" },
		])
	})

	it("validates user tool_result blocks against the last effective assistant message", () => {
		const result = prepareApiConversationMessage({
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "wrong-id", content: "done" }],
			},
			api: {} as any,
			apiConfiguration: { apiProvider: "openrouter", openRouterModelId: "openai/gpt-4" } as any,
			apiConversationHistory: [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: {} }],
				} as any,
			],
		}) as any

		expect(result.content).toEqual([{ type: "tool_result", tool_use_id: "tool-1", content: "done" }])
		expect(result.ts).toBe(Date.now())
	})

	it("converts user tool_result blocks to text when the last effective message is not assistant", () => {
		const result = prepareApiConversationMessage({
			message: {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "tool-1", content: "done" },
					{ type: "text", text: "next step" },
				],
			},
			api: {} as any,
			apiConfiguration: { apiProvider: "openrouter", openRouterModelId: "openai/gpt-4" } as any,
			apiConversationHistory: [{ role: "user", content: "previous user message" } as any],
		}) as any

		expect(result.content).toEqual([
			{ type: "text", text: "Tool result:\ndone" },
			{ type: "text", text: "next step" },
		])
		expect(result.ts).toBe(Date.now())
	})
})
