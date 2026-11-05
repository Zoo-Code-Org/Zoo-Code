import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { readTaskMessages, TaskMessagesReadError } from "../../core/task-persistence/taskMessages"
import { makeClineProviderFactory } from "../../test-utils/provider"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")
vi.mock("../../core/task-persistence/taskMessages", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../core/task-persistence/taskMessages")>()),
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
			getTaskWithId: vi.fn().mockResolvedValue({}),
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

	it("finds the text in a later message and skips messages without text", async () => {
		vi.mocked(readTaskMessages).mockResolvedValue([
			{ ts: 1, type: "say", say: "api_req_started" },
			{ ts: 2, type: "say", say: "text", text: "unrelated" },
			{ ts: 3, type: "say", say: "completion_result", text: "done RESTART_PERSISTENCE_MARKER" },
		])

		await expect(api.hasTaskUiMessageText("task-1", "RESTART_PERSISTENCE_MARKER")).resolves.toBe(true)
	})

	it("returns false when only messages without text exist", async () => {
		vi.mocked(readTaskMessages).mockResolvedValue([{ ts: 1, type: "say", say: "api_req_started" }])

		await expect(api.hasTaskUiMessageText("task-1", "RESTART_PERSISTENCE_MARKER")).resolves.toBe(false)
	})

	it.each(["not_found", "invalid", "io_error"] as const)(
		"returns false instead of throwing on a %s read failure",
		async (kind) => {
			// The completion write may not have landed yet; callers poll until it does.
			vi.mocked(readTaskMessages).mockRejectedValue(new TaskMessagesReadError(kind, `read failed: ${kind}`))

			await expect(api.hasTaskUiMessageText("task-1", "RESTART_PERSISTENCE_MARKER")).resolves.toBe(false)
		},
	)

	it("returns false without reading disk for a task id that is not in history", async () => {
		vi.mocked(mockProvider.getTaskWithId).mockRejectedValue(new Error("Task not found"))

		await expect(api.hasTaskUiMessageText("../../escape", "RESTART_PERSISTENCE_MARKER")).resolves.toBe(false)
		expect(readTaskMessages).not.toHaveBeenCalled()
	})
})
