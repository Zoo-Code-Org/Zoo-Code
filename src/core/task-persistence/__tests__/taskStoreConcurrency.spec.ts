import type { HistoryItem } from "@roo-code/types"

import { DeltaRejectedError, mergeHistoryDelta } from "../taskStoreConcurrency"

function item(status: HistoryItem["status"]): HistoryItem {
	return {
		id: "task",
		number: 1,
		ts: 1,
		task: "task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status,
	}
}

describe("mergeHistoryDelta", () => {
	it("rejects an explicit undefined status that would revive a completed task", () => {
		const disk = item("completed")
		const incoming = { ...disk, status: undefined, mode: "must-not-commit" }

		expect(() =>
			mergeHistoryDelta(disk, incoming, { id: disk.id, status: undefined, mode: "must-not-commit" }),
		).toThrow(DeltaRejectedError)
		expect(disk.status).toBe("completed")
		expect("mode" in disk).toBe(false)
	})

	it("normalizes a legacy undefined disk status to explicit active", () => {
		const disk = item(undefined)
		const incoming = { ...disk, status: undefined }

		expect(mergeHistoryDelta(disk, incoming, { id: disk.id, status: undefined }).status).toBe("active")
	})
})

describe("MCP attachment delta normalization", () => {
	it.each([null, 42, {}, "abc", [42], ["invalid"], ["mcp--catalog--old", 42]])(
		"normalizes malformed on-disk attachments %j before unioning",
		(value) => {
			const disk = { ...item("active"), attachedMcpToolNames: value }
			const incoming = { ...item("active"), attachedMcpToolNames: ["mcp--catalog--new"] }
			expect(mergeHistoryDelta(disk, incoming, incoming).attachedMcpToolNames).toEqual(
				Array.isArray(value) && value.includes("mcp--catalog--old")
					? ["mcp--catalog--old", "mcp--catalog--new"]
					: ["mcp--catalog--new"],
			)
		},
	)
})
