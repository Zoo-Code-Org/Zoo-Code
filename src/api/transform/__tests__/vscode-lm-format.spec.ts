// pnpm exec vitest run api/transform/__tests__/vscode-lm-format.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"

import {
	convertToVsCodeLmMessages,
	convertToAnthropicRole,
	extractTextCountFromMessage,
	sanitizeSurrogates,
	sanitizeIdentifierSurrogates,
	sanitizeSurrogatesDeep,
	sanitizeToolNameSurrogates,
	decodeToolNameSurrogates,
} from "../vscode-lm-format"

// Mock crypto using Vitest
vitest.stubGlobal("crypto", {
	randomUUID: () => "test-uuid",
})

// Define types for our mocked classes
interface MockLanguageModelTextPart {
	type: "text"
	value: string
}

type MockLanguageModelChatMessage = {
	role: string
	content: unknown
}

interface MockLanguageModelToolCallPart {
	type: "tool_call"
	callId: string
	name: string
	input: object
}

interface MockLanguageModelToolResultPart {
	type: "tool_result"
	callId: string
	content: MockLanguageModelTextPart[]
}

// Mock vscode namespace
vitest.mock("vscode", () => {
	const LanguageModelChatMessageRole = {
		Assistant: "assistant",
		User: "user",
	}

	class MockLanguageModelTextPart {
		type = "text"
		constructor(public value: string) {}
	}

	class MockLanguageModelToolCallPart {
		type = "tool_call"
		constructor(
			public callId: string,
			public name: string,
			public input: object,
		) {}
	}

	class MockLanguageModelToolResultPart {
		type = "tool_result"
		constructor(
			public callId: string,
			public content: MockLanguageModelTextPart[],
		) {}
	}

	return {
		LanguageModelChatMessage: {
			Assistant: vitest.fn(function (content) {
				return {
					role: LanguageModelChatMessageRole.Assistant,
					name: "assistant",
					content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
				}
			}),
			User: vitest.fn(function (content) {
				return {
					role: LanguageModelChatMessageRole.User,
					name: "user",
					content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
				}
			}),
		},
		LanguageModelChatMessageRole,
		LanguageModelTextPart: MockLanguageModelTextPart,
		LanguageModelToolCallPart: MockLanguageModelToolCallPart,
		LanguageModelToolResultPart: MockLanguageModelToolResultPart,
	}
})

describe("convertToVsCodeLmMessages", () => {
	it("should convert simple string messages", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there" },
		]

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(2)
		expect(result[0].role).toBe("user")
		expect((result[0].content[0] as MockLanguageModelTextPart).value).toBe("Hello")
		expect(result[1].role).toBe("assistant")
		expect((result[1].content[0] as MockLanguageModelTextPart).value).toBe("Hi there")
	})

	it("should handle complex user messages with tool results", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Here is the result:" },
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: "Tool output",
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(1)
		expect(result[0].role).toBe("user")
		expect(result[0].content).toHaveLength(2)
		const [toolResult, textContent] = result[0].content as [
			MockLanguageModelToolResultPart,
			MockLanguageModelTextPart,
		]
		expect(toolResult.type).toBe("tool_result")
		expect(textContent.type).toBe("text")
	})

	it("should handle complex assistant messages with tool calls", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me help you with that." },
					{
						type: "tool_use",
						id: "tool-1",
						name: "calculator",
						input: { operation: "add", numbers: [2, 2] },
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(1)
		expect(result[0].role).toBe("assistant")
		expect(result[0].content).toHaveLength(2)
		// Text must come before tool calls so that tool calls are at the end,
		// properly followed by user message with tool results
		const [textContent, toolCall] = result[0].content as [MockLanguageModelTextPart, MockLanguageModelToolCallPart]
		expect(textContent.type).toBe("text")
		expect(toolCall.type).toBe("tool_call")
	})

	it("should handle tool_use with non-object non-string input", () => {
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-num",
						name: "numericTool",
						input: 42 as unknown as object, // number is valid JSON
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(1)
		expect(result[0].role).toBe("assistant")
		// asObjectSafe returns {} for non-object/non-string, no console.warn triggered
		expect(consoleWarnSpy).not.toHaveBeenCalled()

		consoleWarnSpy.mockRestore()
	})

	it("should log Zoo Code branded warning when asObjectSafe fails to parse invalid JSON string", () => {
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-bad",
						name: "badJsonTool",
						input: "not-valid-json{{{",
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(1)
		expect(consoleWarnSpy).toHaveBeenCalledWith(
			"Zoo Code <Language Model API>: Failed to parse object:",
			expect.any(Error),
		)

		consoleWarnSpy.mockRestore()
	})

	it("should handle image blocks with appropriate placeholders", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Look at this:" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "base64data",
						},
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(1)
		const imagePlaceholder = result[0].content[1] as MockLanguageModelTextPart
		expect(imagePlaceholder.value).toContain("[Image (base64): image/png not supported by VSCode LM API]")
	})

	it("should produce correct placeholder for URL image in non-tool messages", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "url", url: "https://example.com/img.png" },
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const imagePlaceholder = result[0].content[0] as MockLanguageModelTextPart
		expect(imagePlaceholder.value).toContain("[Image (url): not supported by VSCode LM API]")
	})

	it("should produce correct placeholder for URL image inside tool result", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: [
							{
								type: "image",
								source: { type: "url", url: "https://example.com/img.png" },
							},
						],
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const toolResult = result[0].content[0] as MockLanguageModelToolResultPart
		expect(toolResult.content[0].value).toContain("[Image (url): not supported by VSCode LM API]")
	})

	it("should produce base64 image placeholder inside tool result", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: [
							{
								type: "image",
								source: { type: "base64", media_type: "image/jpeg", data: "abc" },
							},
						],
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const toolResult = result[0].content[0] as MockLanguageModelToolResultPart
		expect(toolResult.content[0].value).toBe("[Image (base64): image/jpeg not supported by VSCode LM API]")
	})

	it("should return empty string for unknown block types inside tool result", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: [{ type: "document" } as unknown as Anthropic.Messages.DocumentBlockParam],
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const toolResult = result[0].content[0] as MockLanguageModelToolResultPart
		expect(toolResult.content[0].value).toBe("")
	})
})

describe("sanitizeSurrogates", () => {
	it("leaves plain ASCII unchanged", () => {
		expect(sanitizeSurrogates("hello world")).toBe("hello world")
	})

	it("leaves valid surrogate pairs unchanged", () => {
		// 😀 U+1F600 and 𐀀 U+10000 are astral-plane code points encoded as surrogate pairs.
		expect(sanitizeSurrogates("a\uD83D\uDE00b\uD800\uDC00c")).toBe("a\uD83D\uDE00b\uD800\uDC00c")
	})

	it("replaces a lone high surrogate with U+FFFD", () => {
		expect(sanitizeSurrogates("a\uD800b")).toBe("a\uFFFDb")
	})

	it("replaces a lone low surrogate with U+FFFD", () => {
		expect(sanitizeSurrogates("a\uDC00b")).toBe("a\uFFFDb")
	})

	it("replaces a trailing lone high surrogate", () => {
		expect(sanitizeSurrogates("abc\uD800")).toBe("abc\uFFFD")
	})

	it("replaces a reversed (low-then-high) pair as two lone surrogates", () => {
		expect(sanitizeSurrogates("\uDC00\uD800")).toBe("\uFFFD\uFFFD")
	})

	it("returns empty input unchanged", () => {
		expect(sanitizeSurrogates("")).toBe("")
	})
})

describe("convertToVsCodeLmMessages surrogate sanitization", () => {
	const lone = "bad\uD800end"
	const sanitized = "bad\uFFFDend"

	const textValues = (message: { content: unknown }) =>
		(message.content as MockLanguageModelTextPart[]).map((part) => part.value)

	it("sanitizes a simple string message", () => {
		const result = convertToVsCodeLmMessages([{ role: "user", content: lone }])
		expect(textValues(result[0])).toEqual([sanitized])
	})

	it("sanitizes string tool_result content", () => {
		const result = convertToVsCodeLmMessages([
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: lone }] },
		])
		const toolResult = result[0].content[0] as MockLanguageModelToolResultPart
		expect(toolResult.content[0].value).toBe(sanitized)
	})

	it("sanitizes tool_result text blocks", () => {
		const result = convertToVsCodeLmMessages([
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: lone }] }],
			},
		])
		const toolResult = result[0].content[0] as MockLanguageModelToolResultPart
		expect(toolResult.content[0].value).toBe(sanitized)
	})

	it("sanitizes user text blocks", () => {
		const result = convertToVsCodeLmMessages([{ role: "user", content: [{ type: "text", text: lone }] }])
		expect(textValues(result[0])).toContain(sanitized)
	})

	it("sanitizes strings nested in tool_use input", () => {
		const result = convertToVsCodeLmMessages([
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "read_file",
						input: { path: lone, nested: { list: [lone] } },
					},
				],
			},
		])
		const toolCall = result[0].content[0] as MockLanguageModelToolCallPart
		expect(toolCall.input).toEqual({ path: sanitized, nested: { list: [sanitized] } })
	})

	it("sanitizes assistant text blocks", () => {
		const result = convertToVsCodeLmMessages([{ role: "assistant", content: [{ type: "text", text: lone }] }])
		expect(textValues(result[0])).toContain(sanitized)
	})
})

describe("convertToAnthropicRole", () => {
	it("should convert assistant role correctly", () => {
		const result = convertToAnthropicRole(vscode.LanguageModelChatMessageRole.Assistant)
		expect(result).toBe("assistant")
	})

	it("should convert user role correctly", () => {
		const result = convertToAnthropicRole(vscode.LanguageModelChatMessageRole.User)
		expect(result).toBe("user")
	})

	it("should return null for unknown roles", () => {
		const result = convertToAnthropicRole("unknown" as unknown as vscode.LanguageModelChatMessageRole)
		expect(result).toBeNull()
	})
})

describe("extractTextCountFromMessage", () => {
	it("should extract text from simple string content", () => {
		const message = {
			role: "user",
			content: "Hello world",
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("Hello world")
	})

	it("should extract text from LanguageModelTextPart", () => {
		const mockTextPart = new (vitest.mocked(vscode).LanguageModelTextPart)("Text content")
		const message = {
			role: "user",
			content: [mockTextPart],
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("Text content")
	})

	it("should extract text from multiple LanguageModelTextParts", () => {
		const mockTextPart1 = new (vitest.mocked(vscode).LanguageModelTextPart)("First part")
		const mockTextPart2 = new (vitest.mocked(vscode).LanguageModelTextPart)("Second part")
		const message = {
			role: "user",
			content: [mockTextPart1, mockTextPart2],
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("First partSecond part")
	})

	it("should extract text from LanguageModelToolResultPart", () => {
		const mockTextPart = new (vitest.mocked(vscode).LanguageModelTextPart)("Tool result content")
		const mockToolResultPart = new (vitest.mocked(vscode).LanguageModelToolResultPart)("tool-result-id", [
			mockTextPart,
		])
		const message = {
			role: "user",
			content: [mockToolResultPart],
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("tool-result-idTool result content")
	})

	it("should extract text from LanguageModelToolCallPart without input", () => {
		const mockToolCallPart = new (vitest.mocked(vscode).LanguageModelToolCallPart)("call-id", "tool-name", {})
		const message = {
			role: "assistant",
			content: [mockToolCallPart],
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("tool-namecall-id")
	})

	it("should extract text from LanguageModelToolCallPart with input", () => {
		const mockInput = { operation: "add", numbers: [1, 2, 3] }
		const mockToolCallPart = new (vitest.mocked(vscode).LanguageModelToolCallPart)(
			"call-id",
			"calculator",
			mockInput,
		)
		const message = {
			role: "assistant",
			content: [mockToolCallPart],
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe(`calculatorcall-id${JSON.stringify(mockInput)}`)
	})

	it("should extract text from LanguageModelToolCallPart with empty input", () => {
		const mockToolCallPart = new (vitest.mocked(vscode).LanguageModelToolCallPart)("call-id", "tool-name", {})
		const message = {
			role: "assistant",
			content: [mockToolCallPart],
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("tool-namecall-id")
	})

	it("should extract text from mixed content types", () => {
		const mockTextPart = new (vitest.mocked(vscode).LanguageModelTextPart)("Text content")
		const mockToolResultTextPart = new (vitest.mocked(vscode).LanguageModelTextPart)("Tool result")
		const mockToolResultPart = new (vitest.mocked(vscode).LanguageModelToolResultPart)("result-id", [
			mockToolResultTextPart,
		])
		const mockInput = { param: "value" }
		const mockToolCallPart = new (vitest.mocked(vscode).LanguageModelToolCallPart)("call-id", "tool", mockInput)

		const message = {
			role: "assistant",
			content: [mockTextPart, mockToolResultPart, mockToolCallPart],
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe(`Text contentresult-idTool resulttoolcall-id${JSON.stringify(mockInput)}`)
	})

	it("should handle empty array content", () => {
		const message = {
			role: "user",
			content: [],
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("")
	})

	it("should handle undefined content", () => {
		const message = {
			role: "user",
			content: undefined,
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("")
	})

	it("should handle ToolResultPart with multiple text parts", () => {
		const mockTextPart1 = new (vitest.mocked(vscode).LanguageModelTextPart)("Part 1")
		const mockTextPart2 = new (vitest.mocked(vscode).LanguageModelTextPart)("Part 2")
		const mockToolResultPart = new (vitest.mocked(vscode).LanguageModelToolResultPart)("result-id", [
			mockTextPart1,
			mockTextPart2,
		])

		const message = {
			role: "user",
			content: [mockToolResultPart],
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("result-idPart 1Part 2")
	})

	it("should handle ToolResultPart with empty parts array", () => {
		const mockToolResultPart = new (vitest.mocked(vscode).LanguageModelToolResultPart)("result-id", [])

		const message = {
			role: "user",
			content: [mockToolResultPart],
		} satisfies MockLanguageModelChatMessage as unknown as vscode.LanguageModelChatMessage

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("result-id")
	})

	it("should log Zoo Code branded warning when tool call input stringify fails", () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		// Create an object with a circular reference that will throw on JSON.stringify
		const circularInput: Record<string, unknown> = { name: "circular" }
		circularInput.self = circularInput

		const mockToolCallPart = new (vitest.mocked(vscode).LanguageModelToolCallPart)(
			"call-id",
			"broken-tool",
			circularInput,
		)

		const message: MockLanguageModelChatMessage = {
			role: "assistant",
			content: [mockToolCallPart],
		}

		const result = extractTextCountFromMessage(message as unknown as vscode.LanguageModelChatMessage)

		// Should still return the tool name and callId even when input stringify fails
		expect(result).toBe("broken-toolcall-id")
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Zoo Code <Language Model API>: Failed to stringify tool call input:",
			expect.any(Error),
		)

		consoleErrorSpy.mockRestore()
	})
})

describe("convertToVsCodeLmMessages surrogate-safe identifiers", () => {
	const LONE_HIGH = String.fromCharCode(0xd800)
	const LONE_LOW = String.fromCharCode(0xdc00)
	// U+1F600 GRINNING FACE as an explicit, well-formed surrogate pair.
	const VALID_PAIR = String.fromCharCode(0xd83d, 0xde00)

	// Index-based so a surrogate pair contributes BOTH of its code units to the assertion.
	const codeUnits = (value: string): number[] =>
		Array.from({ length: value.length }, (_, index) => value.charCodeAt(index))

	const expectNoLoneSurrogate = (value: string) => {
		const surrogates = codeUnits(value).filter((unit) => unit >= 0xd800 && unit <= 0xdfff)
		expect(surrogates).toEqual([])
	}

	it("sanitizes lone surrogates in tool_use id and name", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: `call${LONE_HIGH}1`,
						name: `tool${LONE_LOW}x`,
						input: { key: "value" },
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const toolCall = (result[0].content as unknown as MockLanguageModelToolCallPart[])[0]

		expect(toolCall.callId).toBe("call\uFFFDD8001")
		// Names use the declaration encoding so the replayed call matches a declared tool.
		expect(toolCall.name).toBe("tool_uDC00x")
		expect(codeUnits(toolCall.callId)).toContain(0xfffd)
		expect(toolCall.name).toMatch(/^[\w-]+$/)
		expectNoLoneSurrogate(toolCall.callId)
		expectNoLoneSurrogate(toolCall.name)
	})

	it("sanitizes a lone surrogate in tool_result tool_use_id", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: `result${LONE_HIGH}9`,
						content: [{ type: "text", text: "ok" }],
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const toolResult = (result[0].content as unknown as MockLanguageModelToolResultPart[])[0]

		expect(toolResult.callId).toBe("result\uFFFDD8009")
		expect(codeUnits(toolResult.callId)).toContain(0xfffd)
		expectNoLoneSurrogate(toolResult.callId)
	})

	it("keeps a tool call and its result associated after sanitizing", () => {
		const sharedId = `pair${LONE_HIGH}7`
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: sharedId, name: "tool", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: sharedId, content: [{ type: "text", text: "ok" }] }],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const callId = (result[0].content as unknown as MockLanguageModelToolCallPart[])[0].callId
		const resultId = (result[1].content as unknown as MockLanguageModelToolResultPart[])[0].callId

		expect(callId).toBe(resultId)
		expectNoLoneSurrogate(callId)
		expect(codeUnits(callId)).toContain(0xfffd)
	})

	it("leaves a valid surrogate pair in an id untouched", () => {
		const pairedId = `call-${VALID_PAIR}-ok`
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: pairedId, name: `tool-${VALID_PAIR}`, input: {} }],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const toolCall = (result[0].content as unknown as MockLanguageModelToolCallPart[])[0]

		expect(codeUnits(toolCall.callId)).toEqual(codeUnits(pairedId))
		expect(codeUnits(toolCall.name)).toEqual(codeUnits(`tool-${VALID_PAIR}`))
		expect(codeUnits(toolCall.callId)).not.toContain(0xfffd)
	})

	it("keeps ids differing only in their lone surrogate distinct", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: `call${LONE_HIGH}`, name: "tool", input: {} },
					{ type: "tool_use", id: `call${String.fromCharCode(0xd801)}`, name: "tool", input: {} },
					{ type: "tool_use", id: `call${LONE_LOW}`, name: "tool", input: {} },
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const calls = result[0].content as unknown as MockLanguageModelToolCallPart[]
		const ids = calls.map((call) => call.callId)

		expect(new Set(ids).size).toBe(3)
		for (const id of ids) {
			expectNoLoneSurrogate(id)
			expect(codeUnits(id)).toContain(0xfffd)
		}
	})

	it("keeps a call and its result paired when both ids carry the same lone surrogate", () => {
		const sharedId = `dup${LONE_LOW}id`
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: sharedId, name: "tool", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: sharedId, content: [{ type: "text", text: "ok" }] }],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const callId = (result[0].content as unknown as MockLanguageModelToolCallPart[])[0].callId
		const resultId = (result[1].content as unknown as MockLanguageModelToolResultPart[])[0].callId

		expect(codeUnits(callId)).toEqual(codeUnits(resultId))
		expectNoLoneSurrogate(callId)
		expect(codeUnits(callId)).toContain(0xfffd)
	})

	it("keeps a result id distinct from another result differing only by its lone surrogate", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: `r${LONE_HIGH}`, content: [{ type: "text", text: "a" }] },
					{ type: "tool_result", tool_use_id: `r${LONE_LOW}`, content: [{ type: "text", text: "b" }] },
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const results = result[0].content as unknown as MockLanguageModelToolResultPart[]

		expect(results[0].callId).not.toBe(results[1].callId)
		expectNoLoneSurrogate(results[0].callId)
		expectNoLoneSurrogate(results[1].callId)
	})

	it("leaves a valid surrogate pair in a tool_result id untouched", () => {
		const pairedId = `res-${VALID_PAIR}-ok`
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: pairedId, content: [{ type: "text", text: "ok" }] }],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const toolResult = (result[0].content as unknown as MockLanguageModelToolResultPart[])[0]

		expect(codeUnits(toolResult.callId)).toEqual(codeUnits(pairedId))
		expect(codeUnits(toolResult.callId)).not.toContain(0xfffd)
	})

	it("keeps a lone surrogate id distinct from its literal U+FFFD encoding", () => {
		const loneSurrogateId = `call${LONE_HIGH}`
		const literalMarkerId = `call\uFFFDD800`

		const plainId = `callD800`

		const sanitizedLone = sanitizeIdentifierSurrogates(loneSurrogateId)
		const sanitizedLiteral = sanitizeIdentifierSurrogates(literalMarkerId)
		const sanitizedPlain = sanitizeIdentifierSurrogates(plainId)

		const encoded = [sanitizedLone, sanitizedLiteral, sanitizedPlain].map((value) => codeUnits(value).join(","))
		expect(new Set(encoded).size).toBe(3)
		expectNoLoneSurrogate(sanitizedLone)
		expectNoLoneSurrogate(sanitizedLiteral)
		expect(codeUnits(sanitizeIdentifierSurrogates("toolu_01ABCDEF"))).toEqual(codeUnits("toolu_01ABCDEF"))
		expect(codeUnits(sanitizeIdentifierSurrogates(`call-${VALID_PAIR}`))).toEqual(codeUnits(`call-${VALID_PAIR}`))
	})

	it("encodes tool names within the permitted identifier character set without collisions", () => {
		const encoded = [`read${LONE_HIGH}file`, "read_uD800file", "readD800file", `read${LONE_LOW}file`].map((name) =>
			sanitizeToolNameSurrogates(name),
		)

		for (const name of encoded) {
			expect(name).toMatch(/^[\w-]+$/)
			expectNoLoneSurrogate(name)
		}
		expect(new Set(encoded).size).toBe(encoded.length)
		expect(codeUnits(sanitizeToolNameSurrogates(`read-${VALID_PAIR}`))).toEqual(codeUnits(`read-${VALID_PAIR}`))
	})

	it("leaves a valid tool name untouched so it still matches its registry entry", () => {
		for (const name of ["get_user", "read_file", "apply_diff", "update_todo_list"]) {
			expect(sanitizeToolNameSurrogates(name)).toBe(name)
			expect(decodeToolNameSurrogates(sanitizeToolNameSurrogates(name))).toBe(name)
		}
	})

	it("round-trips encoded tool names back to the original registry name", () => {
		for (const name of [`read${LONE_HIGH}file`, `read${LONE_LOW}file`, "a_uu_b", "x_uD800y", "get_user"]) {
			const declared = sanitizeToolNameSurrogates(name)
			expect(declared).toMatch(/^[\w-]+$/)
			expect(codeUnits(decodeToolNameSurrogates(declared))).toEqual(codeUnits(name))
		}
	})

	it("replays a tool call in history under the same name it was declared with", () => {
		const originalName = `read${LONE_HIGH}file`
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_1", name: originalName, input: {} }],
			},
		]

		const toolCall = (
			convertToVsCodeLmMessages(messages)[0].content as unknown as MockLanguageModelToolCallPart[]
		)[0]

		expect(toolCall.name).toBe(sanitizeToolNameSurrogates(originalName))
		expect(toolCall.name).toMatch(/^[\w-]+$/)
		expect(decodeToolNameSurrogates(toolCall.name)).toBe(originalName)
	})

	it("keeps a valid history tool name unchanged", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_1", name: "get_user", input: {} }],
			},
		]

		const toolCall = (
			convertToVsCodeLmMessages(messages)[0].content as unknown as MockLanguageModelToolCallPart[]
		)[0]

		expect(toolCall.name).toBe("get_user")
	})

	it("collapses argument keys differing only in their lone surrogate, last value winning", () => {
		// Pins the documented lossy-key limitation of sanitizeSurrogatesDeep.
		const collapsed = sanitizeSurrogatesDeep({ [`a${LONE_HIGH}`]: 1, [`a${LONE_LOW}`]: 2 }) as Record<
			string,
			unknown
		>

		expect(Object.keys(collapsed)).toEqual(["a\uFFFD"])
		expect(collapsed["a\uFFFD"]).toBe(2)
	})

	it("leaves an id with no surrogates byte-identical", () => {
		const plainId = "toolu_01ABCDEF"
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: plainId, name: "tool", input: {} }],
			},
		]

		const result = convertToVsCodeLmMessages(messages)
		const toolCall = (result[0].content as unknown as MockLanguageModelToolCallPart[])[0]

		expect(toolCall.callId).toBe(plainId)
	})
})
