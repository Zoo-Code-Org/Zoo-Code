import * as vscode from "vscode"

import type { HistoryItem } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"

const historyItem = {
	id: "task-1602",
	task: "Resume task",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
} as HistoryItem

describe("API.resumeTask", () => {
	it("does not restore a task when workspace selection is cancelled", async () => {
		const provider = {
			viewLaunched: true,
			context: {},
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem }),
			prepareHistoryItemForResume: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn(),
			on: vi.fn(),
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider)

		await api.resumeTask(historyItem.id)

		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})
})
