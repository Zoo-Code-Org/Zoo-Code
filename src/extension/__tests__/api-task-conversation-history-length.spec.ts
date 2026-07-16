import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

describe("API#getTaskApiConversationHistoryLength", () => {
	let api: API
	let mockOutputChannel: vscode.OutputChannel
	let mockProvider: ClineProvider
	let mockGetTaskWithId: ReturnType<typeof vi.fn>

	beforeEach(() => {
		mockOutputChannel = {
			appendLine: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockGetTaskWithId = vi.fn()

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			getTaskWithId: mockGetTaskWithId,
			on: vi.fn(),
		} as unknown as ClineProvider

		api = new API(mockOutputChannel, mockProvider, undefined, true)
	})

	it("returns the persisted api conversation history length", async () => {
		mockGetTaskWithId.mockResolvedValue({
			apiConversationHistory: [{ role: "user" }, { role: "assistant" }],
		})

		await expect(api.getTaskApiConversationHistoryLength("task-1")).resolves.toBe(2)
	})

	it("returns 0 instead of throwing when the task is unavailable", async () => {
		mockGetTaskWithId.mockRejectedValue(new Error("Task not found"))

		await expect(api.getTaskApiConversationHistoryLength("missing-task")).resolves.toBe(0)
	})
})
