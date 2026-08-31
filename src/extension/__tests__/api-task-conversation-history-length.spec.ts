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

	it("finds the expected persisted user and assistant turns in order", async () => {
		mockGetTaskWithId.mockResolvedValue({
			apiConversationHistory: [
				{ role: "user", content: [{ type: "text", text: "RESTART_PERSISTENCE_SMOKE" }] },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Finished" },
						{ type: "tool_use", id: "completion", name: "attempt_completion", input: { result: "done" } },
					],
				},
			],
		})

		await expect(
			api.hasTaskApiConversationHistorySequence("task-1", {
				userText: "RESTART_PERSISTENCE_SMOKE",
				assistantToolName: "attempt_completion",
				assistantToolInputText: "done",
			}),
		).resolves.toBe(true)
	})

	it("returns false when the expected persisted turns are unavailable", async () => {
		mockGetTaskWithId.mockRejectedValue(new Error("Task not found"))

		await expect(
			api.hasTaskApiConversationHistorySequence("missing-task", {
				userText: "RESTART_PERSISTENCE_SMOKE",
				assistantToolName: "attempt_completion",
				assistantToolInputText: "done",
			}),
		).resolves.toBe(false)
	})

	it("rejects an assistant completion that does not follow the expected user turn", async () => {
		mockGetTaskWithId.mockResolvedValue({
			apiConversationHistory: [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "early", name: "attempt_completion", input: { result: "done" } }],
				},
				{ role: "user", content: [{ type: "text", text: "RESTART_PERSISTENCE_SMOKE" }] },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "other", name: "attempt_completion", input: { result: "other" } },
					],
				},
			],
		})

		await expect(
			api.hasTaskApiConversationHistorySequence("task-1", {
				userText: "RESTART_PERSISTENCE_SMOKE",
				assistantToolName: "attempt_completion",
				assistantToolInputText: "done",
			}),
		).resolves.toBe(false)
	})
})
