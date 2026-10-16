import * as vscode from "vscode"

import type { HistoryItem } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"

const historyItem = {
	id: "task-1602",
	number: 1,
	ts: 1,
	task: "Resume task",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
} satisfies HistoryItem

describe("API.resumeTask", () => {
	it.each([false, true])("resumes only with the prepared history item (accepted: %s)", async (accepted) => {
		const prepared = accepted ? { ...historyItem, workspace: "/selected/workspace" } : undefined
		// API uses only this provider surface; constructing a full provider starts unrelated services.
		const provider = {
			viewLaunched: true,
			context: {},
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem }),
			prepareHistoryItemForResume: vi.fn().mockResolvedValue(prepared),
			createTaskWithHistoryItem: vi.fn(),
			postMessageToWebview: vi.fn().mockResolvedValue(true),
			on: vi.fn(),
		} as unknown as ClineProvider
		// Only appendLine is used by this API test.
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider)

		await api.resumeTask(historyItem.id)

		expect(provider.prepareHistoryItemForResume).toHaveBeenCalledWith(historyItem)
		if (accepted) expect(provider.createTaskWithHistoryItem).toHaveBeenCalledExactlyOnceWith(prepared)
		else expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})
})
