import type { HistoryItem } from "@roo-code/types"
import { computeHistoryDelta, mergeHistoryDelta } from "../taskStoreConcurrency"

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

it("keeps only current generation names through every order of reset and delayed saves", () => {
	const base: HistoryItem = {
		id: "task",
		number: 1,
		ts: 1,
		task: "search",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		attachedMcpToolNames: ["mcp--catalog--old"],
	}
	const snapshots: HistoryItem[] = [
		{ ...base, mcpToolSelectionEpoch: 1, attachedMcpToolNames: undefined },
		{ ...base, mcpToolSelectionEpoch: 1, attachedMcpToolNames: ["mcp--catalog--new"] },
		{ ...base, attachedMcpToolNames: ["mcp--catalog--stale"] },
	]
	for (const first of snapshots)
		for (const second of snapshots)
			for (const third of snapshots) {
				let disk = base
				let epoch = 0
				let names = new Set(base.attachedMcpToolNames)
				for (const snapshot of [first, second, third]) {
					const nextEpoch = snapshot.mcpToolSelectionEpoch ?? 0
					if (nextEpoch > epoch) {
						epoch = nextEpoch
						names = new Set()
					}
					if (nextEpoch === epoch) for (const name of snapshot.attachedMcpToolNames ?? []) names.add(name)
					// Each host can retain the original cache after another host commits.
					disk = mergeHistoryDelta(disk, snapshot, computeHistoryDelta(base, snapshot))
					expect(disk.mcpToolSelectionEpoch ?? 0).toBe(epoch)
					expect(new Set(disk.attachedMcpToolNames)).toEqual(names)
				}
			}
})
