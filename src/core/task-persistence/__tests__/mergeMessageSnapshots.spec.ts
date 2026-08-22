import { mergeApiMessageSnapshots, mergeClineMessageSnapshots } from "../mergeMessageSnapshots"

describe("mergeClineMessageSnapshots", () => {
	it("preserves disk-only messages and applies incoming updates in timestamp order", () => {
		const result = mergeClineMessageSnapshots(
			[
				{ ts: 1, type: "say", say: "text", text: "old" },
				{ ts: 3, type: "say", say: "text", text: "newer disk suffix" },
			],
			[
				{ ts: 1, type: "say", say: "text", text: "updated" },
				{ ts: 2, type: "say", say: "text", text: "incoming" },
			],
		)

		expect(result).toEqual([
			expect.objectContaining({ ts: 1, text: "updated" }),
			expect.objectContaining({ ts: 2, text: "incoming" }),
			expect.objectContaining({ ts: 3, text: "newer disk suffix" }),
		])
	})

	it("does not regress completed or answered message state", () => {
		const result = mergeClineMessageSnapshots(
			[{ ts: 1, type: "ask", ask: "tool", partial: false, isAnswered: true }],
			[{ ts: 1, type: "ask", ask: "tool", partial: true, isAnswered: false }],
		)

		expect(result).toEqual([expect.objectContaining({ ts: 1, partial: false, isAnswered: true })])
	})

	it("uses the incoming message when a timestamp is reused for a different message identity", () => {
		expect(
			mergeClineMessageSnapshots(
				[{ ts: 1, type: "say", say: "text", text: "old" }],
				[{ ts: 1, type: "ask", ask: "followup", text: "new" }],
			),
		).toEqual([{ ts: 1, type: "ask", ask: "followup", text: "new" }])
	})

	it("returns incoming data when either snapshot is not an array", () => {
		expect(mergeClineMessageSnapshots(null, [{ ts: 1 }])).toEqual([{ ts: 1 }])
		expect(mergeClineMessageSnapshots([], "invalid")).toBe("invalid")
	})
})

describe("mergeApiMessageSnapshots", () => {
	it("retains equal-timestamp records and keeps tool calls before their results", () => {
		const result = mergeApiMessageSnapshots(
			[
				{ role: "assistant", content: "old", ts: 1 },
				{ role: "user", content: "same timestamp sibling", ts: 1 },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }], ts: 3 },
			],
			[
				{ role: "assistant", content: "updated", ts: 1 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }],
					ts: 2,
				},
			],
		)

		expect(result).toEqual([
			expect.objectContaining({ role: "assistant", content: "updated", ts: 1 }),
			expect.objectContaining({ role: "user", content: "same timestamp sibling", ts: 1 }),
			expect.objectContaining({ role: "assistant", ts: 2 }),
			expect.objectContaining({ role: "user", ts: 3 }),
		])
	})

	it("preserves only the unmatched legacy disk tail", () => {
		const result = mergeApiMessageSnapshots(
			[
				{ role: "user", content: "old prefix" },
				{ role: "assistant", content: "disk tail" },
			],
			[{ role: "user", content: "updated prefix" }],
		)

		expect(result).toEqual([
			{ role: "user", content: "updated prefix" },
			{ role: "assistant", content: "disk tail" },
		])
	})

	it("keeps legacy prefixes ahead of newer timestamped messages", () => {
		const result = mergeApiMessageSnapshots(
			[
				{ role: "user", content: "legacy prefix" },
				{ role: "assistant", content: "disk suffix", ts: 3 },
			],
			[
				{ role: "user", content: "updated legacy prefix" },
				{ role: "assistant", content: "incoming", ts: 2 },
			],
		)

		expect(result).toEqual([
			{ role: "user", content: "updated legacy prefix" },
			expect.objectContaining({ content: "incoming", ts: 2 }),
			expect.objectContaining({ content: "disk suffix", ts: 3 }),
		])
	})
})
