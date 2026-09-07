import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"
import { RooCodeEventName } from "@roo-code/types"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

describe("API#getTaskApiConversationHistoryLength", () => {
	const expectedSequence = {
		userText: "RESTART_PERSISTENCE_SMOKE",
		assistantToolName: "attempt_completion",
		assistantToolInputText: "done",
	}
	let api: API
	let mockOutputChannel: vscode.OutputChannel
	let mockProvider: ClineProvider
	let mockGetTaskWithId: ReturnType<typeof vi.fn>
	let providerListeners: Map<string, (...args: unknown[]) => unknown>

	beforeEach(() => {
		// API logging only needs appendLine in this suite; a full OutputChannel fake would obscure the tested contract.
		mockOutputChannel = {
			appendLine: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockGetTaskWithId = vi.fn()
		providerListeners = new Map()

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			getTaskWithId: mockGetTaskWithId,
			taskHistoryStore: { get: vi.fn() },
			on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
				providerListeners.set(event, listener)
			}),
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

	it("forwards provider completion exactly once after a delegated child is disposed", async () => {
		vi.mocked(mockProvider.taskHistoryStore.get).mockReturnValue({ parentTaskId: "parent-1" } as never)
		const listener = vi.fn()
		const fileLog = vi
			.spyOn(api as unknown as { fileLog: (message: string) => Promise<void> }, "fileLog")
			.mockResolvedValue(undefined)
		api.on(RooCodeEventName.TaskCompleted, listener)

		await providerListeners.get(RooCodeEventName.TaskCompleted)?.("child-1", {}, {})

		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledWith("child-1", {}, {}, { isSubtask: true })
		expect(fileLog).toHaveBeenCalledWith(expect.stringContaining("taskCompleted -> child-1"))
	})

	it("forwards provider completion for a task absent from local history", async () => {
		vi.mocked(mockProvider.taskHistoryStore.get).mockReturnValue(undefined)
		const listener = vi.fn()
		api.on(RooCodeEventName.TaskCompleted, listener)

		await providerListeners.get(RooCodeEventName.TaskCompleted)?.("task-1", {}, {})

		expect(listener).toHaveBeenCalledWith("task-1", {}, {}, { isSubtask: false })
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

	it.each([
		["has no matching user text", [{ role: "user", content: [{ type: "text", text: "different" }] }]],
		[
			"finds the text on an assistant turn",
			[{ role: "assistant", content: [{ type: "text", text: "RESTART_PERSISTENCE_SMOKE" }] }],
		],
		["stores non-array user content", [{ role: "user", content: "RESTART_PERSISTENCE_SMOKE" }]],
	] as const)("returns false when history %s", async (_name, apiConversationHistory) => {
		mockGetTaskWithId.mockResolvedValue({ apiConversationHistory })

		await expect(api.hasTaskApiConversationHistorySequence("task-1", expectedSequence)).resolves.toBe(false)
	})

	it.each([
		[
			"matching text belongs to an assistant",
			{ role: "assistant", content: [{ type: "text", text: "RESTART_PERSISTENCE_SMOKE" }] },
		],
		["the user text does not match", { role: "user", content: [{ type: "text", text: "different" }] }],
		[
			"matching text is on a non-text user block",
			{ role: "user", content: [{ type: "image", text: "RESTART_PERSISTENCE_SMOKE" }] },
		],
	] as const)("does not use a false user match when %s", async (_name, invalidUserCandidate) => {
		mockGetTaskWithId.mockResolvedValue({
			apiConversationHistory: [
				invalidUserCandidate,
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "completion", name: "attempt_completion", input: { result: "done" } },
					],
				},
			],
		})

		await expect(api.hasTaskApiConversationHistorySequence("task-1", expectedSequence)).resolves.toBe(false)
	})

	it("accepts matching text among mixed user blocks", async () => {
		mockGetTaskWithId.mockResolvedValue({
			apiConversationHistory: [
				{
					role: "user",
					content: [
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "data" } },
						{ type: "text", text: "RESTART_PERSISTENCE_SMOKE" },
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "completion", name: "attempt_completion", input: { result: "done" } },
					],
				},
			],
		})

		await expect(api.hasTaskApiConversationHistorySequence("task-1", expectedSequence)).resolves.toBe(true)
	})

	it.each([
		[
			"matching tool data on a user turn",
			{
				role: "user",
				content: [
					{ type: "tool_use", id: "completion", name: "attempt_completion", input: { result: "done" } },
				],
			},
		],
		["non-array assistant content", { role: "assistant", content: "attempt_completion done" }],
		[
			"matching fields on a non-tool block",
			{ role: "assistant", content: [{ type: "text", text: "done", name: "attempt_completion", input: "done" }] },
		],
		[
			"the wrong tool name",
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "completion", name: "other", input: { result: "done" } }],
			},
		],
		[
			"the wrong tool input",
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "completion", name: "attempt_completion", input: { result: "other" } },
				],
			},
		],
	] as const)("returns false for %s after the expected user turn", async (_name, assistantCandidate) => {
		mockGetTaskWithId.mockResolvedValue({
			apiConversationHistory: [
				{ role: "user", content: [{ type: "text", text: "RESTART_PERSISTENCE_SMOKE" }] },
				assistantCandidate,
			],
		})

		await expect(api.hasTaskApiConversationHistorySequence("task-1", expectedSequence)).resolves.toBe(false)
	})

	it("accepts a later matching assistant turn after unrelated history", async () => {
		mockGetTaskWithId.mockResolvedValue({
			apiConversationHistory: [
				{ role: "user", content: [{ type: "text", text: "RESTART_PERSISTENCE_SMOKE" }] },
				{ role: "assistant", content: [{ type: "text", text: "working" }] },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "completion", name: "attempt_completion", input: { result: "done" } },
					],
				},
			],
		})

		await expect(api.hasTaskApiConversationHistorySequence("task-1", expectedSequence)).resolves.toBe(true)
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
