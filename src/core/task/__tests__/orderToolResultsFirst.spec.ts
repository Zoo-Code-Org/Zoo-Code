// npx vitest run core/task/__tests__/orderToolResultsFirst.spec.ts

import type { Anthropic } from "@anthropic-ai/sdk"

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

describe("orderToolResultsFirst", () => {
	it("repairs the persisted #1774 shape so every tool_result leads the message", () => {
		// [tool_result, image, tool_result, text] as saved when read_file on an image ran
		// alongside another tool call in the same turn.
		const stuck: ApiMessage = {
			role: "user",
			ts: 16,
			content: [toolResult("read"), image("jpeg"), toolResult("cmd"), text("<environment_details>")],
		}

		const [repaired] = orderToolResultsFirst([stuck])

		// The image moves into the read_file result, the shape the Anthropic API expects.
		expect(repaired.content).toEqual([
			nested("read", [text("result read"), image("jpeg")]),
			toolResult("cmd"),
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
			nested("b", [text("result b"), image("1")]),
			nested("c", [text("result c"), image("2")]),
			text("t"),
		])
	})

	it("appends an image to a result whose content is already an array", () => {
		const withArray = nested("a", [text("first"), text("second")])

		const [repaired] = orderToolResultsFirst([{ role: "user", content: [withArray, image("1"), toolResult("b")] }])

		expect(repaired.content).toEqual([nested("a", [text("first"), text("second"), image("1")]), toolResult("b")])
		// The original result block is not mutated.
		expect(withArray.content).toEqual([text("first"), text("second")])
	})

	it("keeps an image standalone when no result directly precedes it", () => {
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
})
