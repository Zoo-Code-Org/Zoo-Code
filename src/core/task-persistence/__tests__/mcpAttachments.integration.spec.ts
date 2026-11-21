import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { taskMetadata } from "../taskMetadata"

describe("MCP attachment history round trip", () => {
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
