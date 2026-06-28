// pnpm exec vitest run api/transform/__tests__/zai-format.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import { convertToZAiFormat } from "../zai-format"

describe("convertToZAiFormat", () => {
	it("should convert simple user text messages", () => {
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

		const result = convertToZAiFormat(messages)
		expect(result).toHaveLength(1)
		expect(result[0]).toEqual({ role: "user", content: "Hello" })
	})

	it("should handle base64 image in user message", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe this:" },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "abc123" },
					},
				],
			},
		]

		const result = convertToZAiFormat(messages)
		expect(result).toHaveLength(1)
		const content = (result[0] as any).content as Array<{
			type: string
			image_url?: { url: string }
			text?: string
		}>
		expect(content[0]).toEqual({ type: "text", text: "Describe this:" })
		expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,abc123" } })
	})

	it("should skip non-base64 images in user messages", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Hello" },
					{
						type: "image",
						source: { type: "url", url: "https://example.com/img.png" } as any,
					},
				],
			},
		]

		const result = convertToZAiFormat(messages)
		expect(result).toHaveLength(1)
		// URL image is skipped — only text remains, so content is a plain string
		expect((result[0] as any).content).toBe("Hello")
	})

	it("should convert tool_result content", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Result text" }],
			},
		]

		const result = convertToZAiFormat(messages)
		expect(result[0]).toEqual({ role: "tool", tool_call_id: "tool-1", content: "Result text" })
	})

	it("should convert assistant messages with text", () => {
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "assistant", content: "I can help with that." }]

		const result = convertToZAiFormat(messages)
		expect(result[0]).toEqual({ role: "assistant", content: "I can help with that." })
	})
})
