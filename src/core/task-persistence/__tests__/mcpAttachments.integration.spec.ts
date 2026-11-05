import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { taskMetadata } from "../taskMetadata"

describe("MCP attachment history round trip", () => {
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
