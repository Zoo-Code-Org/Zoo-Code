// npx vitest run core/task/__tests__/orderToolResultsFirst.spec.ts

import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiHandler } from "../../../api"
import { OpenAiCodexHandler } from "../../../api/providers/openai-codex"
import { convertToAiSdkMessages } from "../../../api/transform/ai-sdk"
import { maybeRemoveImageBlocks } from "../../../api/transform/image-cleaning"
import { convertToOpenAiMessages } from "../../../api/transform/openai-format"
import type { ApiMessage } from "../../task-persistence"
import { mergeConsecutiveApiMessages } from "../mergeConsecutiveApiMessages"
import { orderToolResultsFirst } from "../orderToolResultsFirst"

const toolResult = (id: string, content = `result ${id}`): Anthropic.Messages.ToolResultBlockParam => ({
	type: "tool_result",
	tool_use_id: id,
	content,
})
const image = (data: string): Anthropic.Messages.ImageBlockParam => ({
	type: "image",
	source: { type: "base64", media_type: "image/jpeg", data },
})
const text = (value: string): Anthropic.Messages.TextBlockParam => ({ type: "text", text: value })
const nested = (id: string, content: Anthropic.Messages.ToolResultBlockParam["content"]) => ({
	type: "tool_result" as const,
	tool_use_id: id,
	content,
})

// [tool_result, image, tool_result, text] as saved when read_file on an image ran alongside
// another tool call in the same turn (#1774).
const stuckTurn = (): ApiMessage[] => [
	{
		role: "assistant",
		content: [
			{ type: "tool_use", id: "read", name: "read_file", input: { path: "logo.jpg" } },
			{ type: "tool_use", id: "cmd", name: "execute_command", input: { command: "ls" } },
		],
	},
	{
		role: "user",
		content: [toolResult("read"), image("jpeg"), toolResult("cmd"), text("<environment_details>")],
	},
]

describe("orderToolResultsFirst", () => {
	it("repairs the persisted #1774 shape so every tool_result leads the message", () => {
		const stuck: ApiMessage = {
			role: "user",
			ts: 16,
			content: [toolResult("read"), image("jpeg"), toolResult("cmd"), text("<environment_details>")],
		}

		const [repaired] = orderToolResultsFirst([stuck])

		// The results lead; the image stays a top-level block, as live turns store it (#1307).
		expect(repaired.content).toEqual([
			toolResult("read"),
			toolResult("cmd"),
			image("jpeg"),
			text("<environment_details>"),
		])
		expect(repaired.ts).toBe(16)
		// Stored history is untouched.
		expect(stuck.content).toEqual([
			toolResult("read"),
			image("jpeg"),
			toolResult("cmd"),
			text("<environment_details>"),
		])
	})

	it("keeps the order of results and of other blocks with several interleaved images", () => {
		const [repaired] = orderToolResultsFirst([
			{
				role: "user",
				content: [toolResult("a"), toolResult("b"), image("1"), toolResult("c"), image("2"), text("t")],
			},
		])

		expect(repaired.content).toEqual([
			toolResult("a"),
			toolResult("b"),
			toolResult("c"),
			image("1"),
			image("2"),
			text("t"),
		])
	})

	it("leaves the content of every result block untouched", () => {
		const withArray = nested("a", [text("first"), text("second")])

		const [repaired] = orderToolResultsFirst([{ role: "user", content: [withArray, image("1"), toolResult("b")] }])

		expect(repaired.content).toEqual([withArray, toolResult("b"), image("1")])
		expect(withArray.content).toEqual([text("first"), text("second")])
	})

	it("moves leading and mid-message blocks after the results in their original order", () => {
		const [repaired] = orderToolResultsFirst([
			{
				role: "user",
				content: [image("lead"), toolResult("a"), text("note"), image("after-text"), toolResult("b")],
			},
		])

		expect(repaired.content).toEqual([
			toolResult("a"),
			toolResult("b"),
			image("lead"),
			text("note"),
			image("after-text"),
		])
	})

	it("repairs interleaving introduced by merging consecutive user messages", () => {
		const merged = mergeConsecutiveApiMessages([
			{ role: "user", content: [toolResult("a"), text("note")] },
			{ role: "user", content: [toolResult("b")] },
		])

		expect(orderToolResultsFirst(merged)[0].content).toEqual([toolResult("a"), toolResult("b"), text("note")])
	})

	it("returns already-ordered, string, and assistant messages unchanged", () => {
		const ordered: ApiMessage = { role: "user", content: [toolResult("a"), image("1"), text("t")] }
		const plain: ApiMessage = { role: "user", content: "hello" }
		const noResults: ApiMessage = { role: "user", content: [text("a"), image("1")] }
		const assistant: ApiMessage = { role: "assistant", content: [text("a")] }

		const out = orderToolResultsFirst([ordered, plain, noResults, assistant])

		out.forEach((message, index) => expect(message).toBe([ordered, plain, noResults, assistant][index]))
	})

	describe("repaired images reach the provider request", () => {
		const dataUrl = "data:image/jpeg;base64,jpeg"

		it("OpenAI chat format sends the image as an image_url part", () => {
			const converted = convertToOpenAiMessages(orderToolResultsFirst(stuckTurn()))

			expect(converted.map((message) => message.role)).toEqual(["assistant", "tool", "tool", "user"])
			expect(converted.at(-1)?.content).toContainEqual({ type: "image_url", image_url: { url: dataUrl } })
		})

		it("AI SDK format sends the image as an image part", () => {
			const converted = convertToAiSdkMessages(orderToolResultsFirst(stuckTurn()))
			const user = converted.find((message) => message.role === "user")

			expect(user?.content).toContainEqual({ type: "image", image: dataUrl, mimeType: "image/jpeg" })
		})

		it("OpenAI Codex Responses input sends the image as an input_image part", () => {
			const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })
			const input: unknown[] = handler["formatFullConversation"]("", orderToolResultsFirst(stuckTurn()))

			expect(input).toContainEqual({
				role: "user",
				content: [
					{ type: "input_image", image_url: dataUrl },
					{ type: "input_text", text: "<environment_details>" },
				],
			})
		})

		it("a model without image support gets no image block anywhere in the request", () => {
			const textOnly: ApiHandler = {
				getModel: vi.fn().mockReturnValue({ id: "text-only", info: { supportsImages: false } }),
				createMessage: vi.fn(),
				countTokens: vi.fn(),
				getModelCacheScope: vi.fn(),
			}
			const [, user] = maybeRemoveImageBlocks(orderToolResultsFirst(stuckTurn()), textOnly)

			expect(user.content).toEqual([
				toolResult("read"),
				toolResult("cmd"),
				text("[Referenced image in conversation]"),
				text("<environment_details>"),
			])
		})
	})
})
