import type { HistoryItem } from "@roo-code/types"
import { mergeHistoryDelta } from "../taskStoreConcurrency"

it("never removes a committed MCP name through any pair of delayed snapshots", () => {
	// MCP attachment union in check-task-store-concurrency.ts: late successful writes retain
	// every name already committed under the disk lock.
	const subsets = [[], ["mcp--catalog--a"], ["mcp--catalog--b"], ["mcp--catalog--a", "mcp--catalog--b"]]
	const base: HistoryItem = { id: "task", number: 1, ts: 1, task: "search", tokensIn: 0, tokensOut: 0, totalCost: 0 }
	for (const first of subsets) {
		for (const second of subsets) {
			let disk = base
			const committed = new Set<string>()
			for (const snapshot of [first, second]) {
				const incoming = { ...base, attachedMcpToolNames: snapshot }
				disk = mergeHistoryDelta(disk, incoming, { attachedMcpToolNames: snapshot })
				for (const name of snapshot) committed.add(name)
				expect(new Set(disk.attachedMcpToolNames)).toEqual(committed)
			}
		}
	}
})
