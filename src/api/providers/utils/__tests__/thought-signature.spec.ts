import OpenAI from "openai"

import { convertToR1Format } from "../../../transform/r1-format"
import { convertToOpenAiMessages } from "../../../transform/openai-format"
import { sanitizeToolUseId } from "../../../../utils/tool-id"
import { toolResultsMessage } from "../../../../test-utils/thought-signature"
import { sanitizeOpenAiCallId } from "../../../../utils/tool-id"
import { signedAssistantMessage, TEST_THOUGHT_SIGNATURE as signature } from "../../../../test-utils/thought-signature"
import { applyThoughtSignatures, thoughtSignatureOrigin, ThoughtSignatureReader } from "../thought-signature"

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

function readThoughtSignature(toolCalls: readonly unknown[] | null | undefined): string | undefined {
	const reader = new ThoughtSignatureReader()
	reader.update(toolCalls)
	return reader.signature
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

	it.each([64, 200, 2000])("preserves an ID-only signature of length %i", (length) => {
		const signature = "+/Aa".repeat(length / 4) + "=="
		expect(readThoughtSignature([{ id: `call_1__thought__${signature}` }])).toBe(signature)
	})

	it("prefers explicit fields over the encoded ID", () => {
		expect(
			readThoughtSignature([
				{ id: "call_1__thought__old", provider_specific_fields: { thought_signature: "real" } },
			]),
		).toBe("real")
	})

	it.each([
		{
			calls: [
				{ id: "call_1__thought__encoded" },
				{ provider_specific_fields: { thought_signature: "explicit" } },
			],
			expected: "explicit",
		},
		{ calls: [{ id: "call_1__thought__first" }, { id: "call_2__thought__second" }], expected: "first" },
		{ calls: [{ id: "call_1__thought__" }, { id: "call_2__thought__second" }], expected: "second" },
	])("selects $expected from ordered signature sources", ({ calls, expected }) => {
		expect(readThoughtSignature(calls)).toBe(expected)
	})

	it.each([
		["no tool calls", undefined],
		["a null call", [null]],
		["a non-string ID", [{ id: 42 }]],
		["an unsigned ID", [{ id: "call_1" }]],
		["an empty encoded signature", [{ id: "call_1__thought__" }]],
		["null tool calls", null],
		["no provider_specific_fields", [{ index: 0 }]],
		["an empty signature", [{ index: 0, provider_specific_fields: { thought_signature: "" } }]],
		["a non-string signature", [{ index: 0, provider_specific_fields: { thought_signature: 42 } }]],
	])("returns undefined for %s", (_case, toolCalls) => {
		expect(readThoughtSignature(toolCalls)).toBeUndefined()
	})
})

describe("ThoughtSignatureReader stream priority property", () => {
	// Mirrors StreamSignaturePriority: the first explicit field wins, or the first ID if no field exists.
	const candidates = [
		{ source: "none", value: undefined, call: {} },
		...["a", "b"].flatMap((value) => [
			{ source: "encoded", value, call: { id: `call_1__thought__${value}` } },
			{ source: "explicit", value, call: { provider_specific_fields: { thought_signature: value } } },
		]),
	]
	const streams = candidates.flatMap((a) =>
		candidates.flatMap((b) => candidates.map((c) => ({ sources: [a, b, c] }))),
	)

	it.each(streams)("selects by source priority for $sources", ({ sources }) => {
		const reader = new ThoughtSignatureReader()
		reader.update(undefined)
		expect(reader.signature).toBeUndefined()
		for (let count = 1; count <= sources.length; count++) {
			const prefix = sources.slice(0, count)
			const expected =
				prefix.find((candidate) => candidate.source === "explicit")?.value ??
				prefix.find((candidate) => candidate.source === "encoded")?.value
			reader.update([sources[count - 1].call])
			expect(reader.signature).toBe(expected)
			reader.update(null)
			expect(reader.signature).toBe(expected)
		}
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

	it("ignores a signed message without tool calls", () => {
		const history = [signedAssistantMessage([], { origin, leadingBlocks: [{ type: "text", text: "Done." }] })]

		const result = applyThoughtSignatures(history, [assistantWith("call_1")], {
			origin,
			normalizeToolCallId: sanitizeOpenAiCallId,
		})

		expect(result).toEqual([assistantWith("call_1")])
	})

	it("puts the signature on the tool call, not on a reasoning block with an id", () => {
		// The history stores reasoning blocks with the Responses API item id.
		const reasoning = { type: "reasoning" as const, text: "Thinking.", id: "rs_1" }
		const history = [signedAssistantMessage(["call_1"], { origin, leadingBlocks: [reasoning] })]

		const result = applyThoughtSignatures(history, [assistantWith("call_1")], { origin })

		expect(result).toEqual([{ role: "assistant", content: null, tool_calls: [signed("call_1", signature)] }])
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

describe("proxy signature round trip property", () => {
	const cases = [1, 16, 64, 200, 2000].flatMap((length) =>
		[false, true].flatMap((explicit) =>
			[false, true].flatMap((truncate) => [false, true].map((r1) => ({ length, explicit, truncate, r1 }))),
		),
	)
	it.each(cases)(
		"delivers signature length=$length explicit=$explicit truncate=$truncate r1=$r1",
		({ length, explicit, truncate, r1 }) => {
			const normalizeToolCallId = truncate ? sanitizeOpenAiCallId : (id: string) => id
			const signature = "+/Aa".repeat(length) + "=="
			const id = `call_1__thought__${signature}`
			const received = readThoughtSignature([
				{ id, ...(explicit ? { provider_specific_fields: { thought_signature: signature } } : {}) },
			])
			expect(received).toBe(signature)
			const storedId = sanitizeToolUseId(id)
			const history = [
				signedAssistantMessage([storedId], {
					signature: received,
					origin,
					leadingBlocks: [{ type: "reasoning", text: "unsigned" }],
				}),
				toolResultsMessage([storedId]),
			]
			const request = applyThoughtSignatures(
				history,
				(r1 ? convertToR1Format : convertToOpenAiMessages)(history, { normalizeToolCallId }),
				{
					origin,
					normalizeToolCallId,
				},
			)
			expect(request[0]).toMatchObject({ tool_calls: [signed(normalizeToolCallId(storedId), signature)] })
			expect(request[0]).not.toHaveProperty("reasoning_content")
			expect(request[1]).toMatchObject({ tool_call_id: normalizeToolCallId(storedId) })
		},
	)

	it("keeps unsigned provider reasoning", () => {
		const message = {
			role: "assistant" as const,
			content: "",
			tool_calls: [toolCall("call_1")],
			reasoning_content: "DeepSeek reasoning",
		}
		expect(applyThoughtSignatures([], [message], { origin })).toEqual([message])
	})
})

// NoForeignEncodedSignature: foreign signature bytes must leave neither through fields nor through IDs.
describe("origin isolation property", () => {
	const cases = [undefined, origin, "foreign"].flatMap((storedOrigin) =>
		[1, 100].flatMap((prefixLength) =>
			[false, true].flatMap((truncate) =>
				[false, true].flatMap((r1) =>
					[false, true].map((useFallback) => ({ storedOrigin, prefixLength, truncate, r1, useFallback })),
				),
			),
		),
	)
	it.each(cases)(
		"isolates $storedOrigin with prefix=$prefixLength truncate=$truncate r1=$r1 fallback=$useFallback",
		({ storedOrigin, prefixLength, truncate, r1, useFallback }) => {
			const prefix = "call_" + "x".repeat(prefixLength)
			const ids = [signature, signature + "second"].map((value) =>
				sanitizeToolUseId(`${prefix}__thought__${value}`),
			)
			const history = [signedAssistantMessage(ids, { origin: storedOrigin }), toolResultsMessage(ids)]
			const normalizeToolCallId = truncate ? sanitizeOpenAiCallId : (id: string) => id
			const converted = r1
				? convertToR1Format(history, { normalizeToolCallId })
				: convertToOpenAiMessages(history, { normalizeToolCallId })
			const before = structuredClone(converted)
			const result = applyThoughtSignatures(history, converted, {
				origin,
				normalizeToolCallId,
				fallback: useFallback ? () => bypass : undefined,
			})
			const assistant = result.find((message) => message.role === "assistant")
			const calls = assistant?.role === "assistant" ? (assistant.tool_calls ?? []) : []
			expect(calls).toHaveLength(2)
			expect(new Set(calls.map((call) => call.id)).size).toBe(2)
			expect(result.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(
				calls.map((call) => call.id),
			)
			if (storedOrigin === origin) {
				expect(calls.map((call) => call.id)).toEqual(ids.map((id) => normalizeToolCallId(id)))
				expect(calls[0]).toMatchObject({ provider_specific_fields: { thought_signature: signature } })
			} else {
				expect(JSON.stringify(result)).not.toContain("__thought__")
				expect(JSON.stringify(result)).not.toContain(signature)
				for (const call of calls) {
					if (useFallback)
						expect(call).toMatchObject({ provider_specific_fields: { thought_signature: bypass } })
					else expect(call).not.toHaveProperty("provider_specific_fields")
				}
			}
			expect(converted).toEqual(before)
		},
	)
})
