// npx vitest run core/task/__tests__/mergeConsecutiveApiMessages.spec.ts

import type { Anthropic } from "@anthropic-ai/sdk"

import { mergeConsecutiveApiMessages } from "../mergeConsecutiveApiMessages"

describe("mergeConsecutiveApiMessages", () => {
	it("merges consecutive user messages by default", () => {
		const { messages: merged } = mergeConsecutiveApiMessages([
			{ role: "user", content: "A", ts: 1 },
			{ role: "user", content: [{ type: "text", text: "B" }], ts: 2 },
			{ role: "assistant", content: "C", ts: 3 },
		])

		expect(merged).toHaveLength(2)
		expect(merged[0].role).toBe("user")
		expect(merged[0].content).toEqual([
			{ type: "text", text: "A" },
			{ type: "text", text: "B" },
		])
		expect(merged[1].role).toBe("assistant")
	})

	it("merges regular user message into a summary (API shaping only)", () => {
		const { messages: merged } = mergeConsecutiveApiMessages([
			{ role: "user", content: [{ type: "text", text: "Summary" }], ts: 1, isSummary: true, condenseId: "s" },
			{ role: "user", content: [{ type: "text", text: "After" }], ts: 2 },
		])

		expect(merged).toHaveLength(1)
		expect(merged[0].isSummary).toBe(true)
		expect(merged[0].content).toEqual([
			{ type: "text", text: "Summary" },
			{ type: "text", text: "After" },
		])
	})

	it("does not merge a summary into a preceding message", () => {
		const { messages: merged } = mergeConsecutiveApiMessages([
			{ role: "user", content: [{ type: "text", text: "Before" }], ts: 1 },
			{ role: "user", content: [{ type: "text", text: "Summary" }], ts: 2, isSummary: true, condenseId: "s" },
		])

		expect(merged).toHaveLength(2)
		expect(merged[0].isSummary).toBeUndefined()
		expect(merged[1].isSummary).toBe(true)
	})

	describe("duplicate tool_result ids", () => {
		const toolResult = (
			toolUseId: string,
			content: string,
		): Anthropic.Messages.ToolResultBlockParam & { type: "tool_result" } => ({
			type: "tool_result",
			tool_use_id: toolUseId,
			content,
		})

		it("keeps the first tool_result when merging two messages with the same id", () => {
			const { messages: merged, droppedDuplicateToolUseIds } = mergeConsecutiveApiMessages([
				{ role: "user", content: [toolResult("tooluse_abc", "first")], ts: 1 },
				{ role: "user", content: [toolResult("tooluse_abc", "second")], ts: 2 },
			])

			expect(merged).toHaveLength(1)
			expect(merged[0].content).toEqual([toolResult("tooluse_abc", "first")])
			expect(droppedDuplicateToolUseIds).toEqual(["tooluse_abc"])
		})

		it("dedupes the reported regression shape and keeps every text block", () => {
			// Three consecutive user messages, each [tool_result(same id), text(environment_details)].
			const { messages: merged, droppedDuplicateToolUseIds } = mergeConsecutiveApiMessages([
				{
					role: "user",
					content: [
						toolResult("tooluse_uKXYIhSQhgVZjm3uJ1YkAT", "todo updated"),
						{ type: "text", text: "env1" },
					],
					ts: 1790181940014,
				},
				{
					role: "user",
					content: [
						toolResult("tooluse_uKXYIhSQhgVZjm3uJ1YkAT", "todo updated"),
						{ type: "text", text: "env2" },
					],
					ts: 1790182055052,
				},
				{
					role: "user",
					content: [
						toolResult("tooluse_uKXYIhSQhgVZjm3uJ1YkAT", "todo updated"),
						{ type: "text", text: "env3" },
					],
					ts: 1790182172842,
				},
			])

			expect(merged).toHaveLength(1)
			expect(merged[0].content).toEqual([
				toolResult("tooluse_uKXYIhSQhgVZjm3uJ1YkAT", "todo updated"),
				{ type: "text", text: "env1" },
				{ type: "text", text: "env2" },
				{ type: "text", text: "env3" },
			])
			expect(merged[0].ts).toBe(1790182172842)
			// One entry per dropped block, so the count reflects both duplicates.
			expect(droppedDuplicateToolUseIds).toEqual([
				"tooluse_uKXYIhSQhgVZjm3uJ1YkAT",
				"tooluse_uKXYIhSQhgVZjm3uJ1YkAT",
			])
		})

		it("preserves distinct tool_result ids across merged messages", () => {
			const { messages: merged, droppedDuplicateToolUseIds } = mergeConsecutiveApiMessages([
				{ role: "user", content: [toolResult("tooluse_a", "a")], ts: 1 },
				{ role: "user", content: [toolResult("tooluse_b", "b")], ts: 2 },
			])

			expect(merged).toHaveLength(1)
			expect(merged[0].content).toEqual([toolResult("tooluse_a", "a"), toolResult("tooluse_b", "b")])
			expect(droppedDuplicateToolUseIds).toEqual([])
		})

		it("leaves a single unmerged message with duplicate ids untouched", () => {
			const duplicateContent = [toolResult("tooluse_abc", "first"), toolResult("tooluse_abc", "second")]

			const { messages: merged, droppedDuplicateToolUseIds } = mergeConsecutiveApiMessages([
				{ role: "user", content: duplicateContent, ts: 1 },
				{ role: "assistant", content: [{ type: "text", text: "reply" }], ts: 2 },
			])

			expect(merged).toHaveLength(2)
			expect(merged[0].content).toEqual(duplicateContent)
			expect(droppedDuplicateToolUseIds).toEqual([])
		})

		it("never dedupes non-tool_result blocks", () => {
			const { messages: merged, droppedDuplicateToolUseIds } = mergeConsecutiveApiMessages([
				{ role: "user", content: [{ type: "text", text: "same" }], ts: 1 },
				{ role: "user", content: [{ type: "text", text: "same" }], ts: 2 },
			])

			expect(merged).toHaveLength(1)
			expect(merged[0].content).toEqual([
				{ type: "text", text: "same" },
				{ type: "text", text: "same" },
			])
			expect(droppedDuplicateToolUseIds).toEqual([])
		})

		it("reports every dropped id, across separate merge groups", () => {
			const { messages: merged, droppedDuplicateToolUseIds } = mergeConsecutiveApiMessages([
				{ role: "user", content: [toolResult("tooluse_a", "a1")], ts: 1 },
				{ role: "user", content: [toolResult("tooluse_a", "a2")], ts: 2 },
				{ role: "assistant", content: [{ type: "text", text: "reply" }], ts: 3 },
				{ role: "user", content: [toolResult("tooluse_b", "b1")], ts: 4 },
				{ role: "user", content: [toolResult("tooluse_b", "b2")], ts: 5 },
			])

			expect(merged).toHaveLength(3)
			expect(merged[0].content).toEqual([toolResult("tooluse_a", "a1")])
			expect(merged[2].content).toEqual([toolResult("tooluse_b", "b1")])
			expect(droppedDuplicateToolUseIds).toEqual(["tooluse_a", "tooluse_b"])
		})
	})
})
