import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { McpToolSelection } from "../../task/mcpToolSelection"
import { taskMetadata } from "../taskMetadata"

describe("MCP attachment history round trip", () => {
	it("persists a reset through restart and ignores an old generation save", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-reset-"))
		const store = new TaskHistoryStore(directory)
		const peer = new TaskHistoryStore(directory)
		const restored = new TaskHistoryStore(directory)
		try {
			const selection = new McpToolSelection(["mcp--catalog--initial"])
			const snapshot = () =>
				taskMetadata({
					taskId: "reset-task",
					taskNumber: 1,
					messages: [],
					workspace: directory,
					globalStoragePath: directory,
					attachedMcpToolNames: selection.initialized ? [...selection.names] : undefined,
					mcpToolSelectionEpoch: selection.epoch,
				})
			const old = (await snapshot()).historyItem
			await store.initialize()
			await store.upsert(old)
			await peer.initialize()
			selection.reset()
			await store.upsert((await snapshot()).historyItem)
			await peer.upsert({ ...old, attachedMcpToolNames: ["mcp--catalog--stale"] })
			await restored.initialize()
			const saved = restored.get(old.id)
			expect(saved?.attachedMcpToolNames).toBeUndefined()
			expect(saved?.mcpToolSelectionEpoch).toBe(1)
			const rank = vi.fn(async () => ["mcp--catalog--new"])
			const resumed = new McpToolSelection(saved?.attachedMcpToolNames, rank, saved?.mcpToolSelectionEpoch)
			await resumed.initialize(
				["initial", "new"].map((toolName) => ({ serverName: "catalog", toolName, description: toolName })),
				{ initialK: 1, searchTurns: 7 },
				"new topic",
				[],
				async () => {},
			)
			expect(rank).toHaveBeenCalledTimes(1)
			expect([...resumed.names]).toEqual(["mcp--catalog--new"])
		} finally {
			store.dispose()
			peer.dispose()
			restored.dispose()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it.each([false, true])(
		"retains historical names after a delayed stale save (separate store: %s)",
		async (separateStore) => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-attachments-race-"))
			const store = new TaskHistoryStore(directory)
			const peer = new TaskHistoryStore(directory)
			const restored = new TaskHistoryStore(directory)
			try {
				const { historyItem } = await taskMetadata({
					taskId: "attachment-task",
					taskNumber: 1,
					messages: [],
					workspace: directory,
					globalStoragePath: directory,
					attachedMcpToolNames: ["mcp--catalog--initial"],
				})
				await store.initialize()
				await store.upsert(historyItem)
				await peer.initialize()
				let release = () => {}
				const gate = new Promise<void>((resolve) => {
					release = resolve
				})
				const olderSave = gate.then(() =>
					(separateStore ? peer : store).upsert({
						...historyItem,
						attachedMcpToolNames: separateStore ? [] : historyItem.attachedMcpToolNames,
					}),
				)
				await store.upsert({
					...historyItem,
					attachedMcpToolNames: ["mcp--catalog--initial", "mcp--catalog--historical"],
				})
				release()
				await olderSave
				await restored.initialize()
				expect(restored.get(historyItem.id)?.attachedMcpToolNames).toEqual([
					"mcp--catalog--initial",
					"mcp--catalog--historical",
				])
			} finally {
				store.dispose()
				peer.dispose()
				restored.dispose()
				await fs.rm(directory, { recursive: true, force: true })
			}
		},
	)

	it.each([{ names: undefined }, { names: [] }, { names: ["mcp--github--issues"] }])(
		"preserves $names across a store restart",
		async ({ names }) => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-attachments-"))
			const store = new TaskHistoryStore(directory)
			const restored = new TaskHistoryStore(directory)
			try {
				const { historyItem } = await taskMetadata({
					taskId: "attachment-task",
					taskNumber: 1,
					messages: [],
					workspace: directory,
					globalStoragePath: directory,
					attachedMcpToolNames: names,
				})
				await store.initialize()
				await store.upsert(historyItem)
				store.dispose()
				await restored.initialize()
				expect(restored.get(historyItem.id)?.attachedMcpToolNames).toEqual(names)
			} finally {
				store.dispose()
				restored.dispose()
				await fs.rm(directory, { recursive: true, force: true })
			}
		},
	)
})
