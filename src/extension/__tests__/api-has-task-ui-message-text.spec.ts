import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { readTaskMessages } from "../../core/task-persistence/taskMessages"
import { makeClineProviderFactory } from "../../test-utils/provider"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")
vi.mock("../../core/task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn(),
}))

describe("API#hasTaskUiMessageText", () => {
	let api: API
	let mockProvider: ClineProvider

	beforeEach(() => {
		vi.mocked(readTaskMessages).mockReset()

		// API logging only needs appendLine in this suite; a full OutputChannel fake would obscure the tested contract.
		const mockOutputChannel = {
			appendLine: vi.fn(),
		} as unknown as vscode.OutputChannel

		// The method under test only reads contextProxy.globalStorageUri; the
		// remaining members exist so the API constructor's listener wiring works.
		mockProvider = {
			context: {} as vscode.ExtensionContext,
			contextProxy: { globalStorageUri: { fsPath: "/mock/global/storage" } },
			taskHistoryStore: { get: vi.fn() },
			on: vi.fn(),
		} as unknown as ClineProvider

		api = new API(mockOutputChannel, mockProvider, makeClineProviderFactory())
	})

	it("returns true when a persisted ui message contains the text", async () => {
		vi.mocked(readTaskMessages).mockResolvedValue([
			{ ts: 1, type: "say", say: "text", text: "done RESTART_PERSISTENCE_MARKER" },
		])

		await expect(api.hasTaskUiMessageText("task-1", "RESTART_PERSISTENCE_MARKER")).resolves.toBe(true)
		expect(readTaskMessages).toHaveBeenCalledWith({ taskId: "task-1", globalStoragePath: "/mock/global/storage" })
	})

	it("returns false when no persisted ui message contains the text", async () => {
		vi.mocked(readTaskMessages).mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "unrelated" }])

		await expect(api.hasTaskUiMessageText("task-1", "RESTART_PERSISTENCE_MARKER")).resolves.toBe(false)
	})

	it("returns false instead of throwing while ui_messages.json is missing or unreadable", async () => {
		// The completion write may not have landed yet; callers poll until it does.
		vi.mocked(readTaskMessages).mockRejectedValue(new Error("Failed to read task messages (code: ENOENT)"))

		await expect(api.hasTaskUiMessageText("task-1", "RESTART_PERSISTENCE_MARKER")).resolves.toBe(false)
	})
})
