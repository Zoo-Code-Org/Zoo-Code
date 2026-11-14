import OpenAI from "openai"

import { sanitizeOpenAiCallId } from "../../../../utils/tool-id"
import { signedAssistantMessage, TEST_THOUGHT_SIGNATURE as signature } from "../../../../test-utils/thought-signature"
import { applyThoughtSignatures, readThoughtSignature, thoughtSignatureOrigin } from "../thought-signature"

const origin = "litellm|http://localhost:4000|gemini-3-pro"
const bypass = "bypass"

function toolCall(id: string): OpenAI.Chat.ChatCompletionMessageFunctionToolCall {
	return { id, type: "function", function: { name: "read_file", arguments: "{}" } }
}

function signed(id: string, value: string) {
	return { ...toolCall(id), provider_specific_fields: { thought_signature: value } }
}

function assistantWith(...ids: string[]): OpenAI.Chat.ChatCompletionMessageParam {
	return { role: "assistant", content: null, tool_calls: ids.map(toolCall) }
}

describe("readThoughtSignature", () => {
	it("returns the first signature in provider_specific_fields", () => {
		const toolCalls = [
			{ index: 0, provider_specific_fields: {} },
			{ index: 1, provider_specific_fields: { thought_signature: signature } },
			{ index: 2, provider_specific_fields: { thought_signature: "later" } },
		]

		expect(readThoughtSignature(toolCalls)).toBe(signature)
	})

	it.each([
		["no tool calls", undefined],
		["null tool calls", null],
		["no provider_specific_fields", [{ index: 0 }]],
		["an empty signature", [{ index: 0, provider_specific_fields: { thought_signature: "" } }]],
		["a non-string signature", [{ index: 0, provider_specific_fields: { thought_signature: 42 } }]],
	])("returns undefined for %s", (_case, toolCalls) => {
		expect(readThoughtSignature(toolCalls)).toBeUndefined()
	})
})

describe("thoughtSignatureOrigin", () => {
	const origin = thoughtSignatureOrigin("http://localhost:4000", "gemini-3-pro")

	it("ignores a trailing slash on the base URL", () => {
		expect(thoughtSignatureOrigin("http://localhost:4000/", "gemini-3-pro")).toBe(origin)
	})

	it.each([
		["model", "http://localhost:4000", "gemini-3-pro-preview"],
		["base URL", "http://other:4000", "gemini-3-pro"],
	])("differs for another %s", (_case, baseUrl, modelId) => {
		expect(thoughtSignatureOrigin(baseUrl, modelId)).not.toBe(origin)
	})

	it("does not contain the base URL", () => {
		expect(origin).toMatch(/^[0-9a-f]{16}$/)
	})
})

describe("applyThoughtSignatures", () => {
	it("puts a stored signature with the same origin on the first tool call of its message", () => {
		const history = [signedAssistantMessage(["call_1", "call_2"], { origin })]

		const result = applyThoughtSignatures(history, [assistantWith("call_1", "call_2")], { origin })

		expect(result).toEqual([
			{ role: "assistant", content: null, tool_calls: [signed("call_1", signature), toolCall("call_2")] },
		])
	})

	it("sends each signed turn its own signature", () => {
		const history = [
			signedAssistantMessage(["call_1"], { origin, signature: "first" }),
			signedAssistantMessage(["call_2"], { origin, signature: "second" }),
		]

		const result = applyThoughtSignatures(history, [assistantWith("call_1"), assistantWith("call_2")], { origin })

		expect(result).toEqual([
			{ role: "assistant", content: null, tool_calls: [signed("call_1", "first")] },
			{ role: "assistant", content: null, tool_calls: [signed("call_2", "second")] },
		])
	})

	it.each([
		["another backend", "litellm|http://other:4000|gemini-3-pro"],
		["native Gemini (no origin)", undefined],
		["an origin that is a prefix of this one", "litellm|http://localhost:4000|gemini-3"],
		["an origin that extends this one", "litellm|http://localhost:4000|gemini-3-pro-preview"],
	])("does not send a signature minted by %s", (_case, storedOrigin) => {
		const history = [signedAssistantMessage(["call_1"], { origin: storedOrigin })]
		const fallback = vi.fn(() => bypass)

		const result = applyThoughtSignatures(history, [assistantWith("call_1")], { origin, fallback })

		expect(result).toEqual([{ role: "assistant", content: null, tool_calls: [signed("call_1", bypass)] }])
		expect(fallback).toHaveBeenCalledWith("call_1")
	})

	it("matches tool calls by the normalized id", () => {
		const longId = "call_" + "x".repeat(100)
		const history = [signedAssistantMessage([longId], { origin })]

		const result = applyThoughtSignatures(history, [assistantWith(sanitizeOpenAiCallId(longId))], {
			origin,
			normalizeToolCallId: sanitizeOpenAiCallId,
		})

		expect(result).toEqual([
			{ role: "assistant", content: null, tool_calls: [signed(sanitizeOpenAiCallId(longId), signature)] },
		])
	})

	it("uses the fallback for every tool call without a stored signature", () => {
		const fallback = (id: string) => (id === "call_2" ? bypass : undefined)

		const result = applyThoughtSignatures([], [assistantWith("call_1", "call_2")], { origin, fallback })

		expect(result).toEqual([
			{ role: "assistant", content: null, tool_calls: [toolCall("call_1"), signed("call_2", bypass)] },
		])
	})

	it("leaves messages without tool calls unchanged", () => {
		const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi" },
		]

		expect(applyThoughtSignatures([], messages, { origin, fallback: () => bypass })).toEqual(messages)
	})
})
