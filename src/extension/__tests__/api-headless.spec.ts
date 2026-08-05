import { EventEmitter } from "events"

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import { RooCodeEventName } from "@roo-code/types"

import { ClineProvider } from "../../core/webview/ClineProvider"
import { API } from "../api"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")
vi.mock("p-wait-for", () => ({
	default: vi.fn(async (condition: () => boolean) => {
		if (!condition()) throw new Error("condition not met")
	}),
}))

type FakeTask = EventEmitter & {
	taskId: string
	rootTaskId?: string
	parentTaskId?: string
	pendingAskId?: number
	respondToAsk: ReturnType<typeof vi.fn>
}

function createTask(taskId: string, options: { rootTaskId?: string; parentTaskId?: string } = {}): FakeTask {
	return Object.assign(new EventEmitter(), {
		taskId,
		...options,
		respondToAsk: vi.fn().mockReturnValue(true),
	})
}

describe("API headless facade", () => {
	let api: API
	let providerEvents: EventEmitter
	let history: Map<string, { status?: string }>
	let provider: ClineProvider
	let rootTask: FakeTask
	let currentTask: FakeTask | undefined
	let createTaskMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		providerEvents = new EventEmitter()
		history = new Map()
		rootTask = createTask("root-1")
		currentTask = rootTask
		createTaskMock = vi.fn().mockImplementation(async () => {
			providerEvents.emit(RooCodeEventName.TaskCreated, rootTask)
			return rootTask
		})

		const fakeProvider = {
			context: {},
			on: providerEvents.on.bind(providerEvents),
			waitUntilReady: vi.fn().mockResolvedValue(undefined),
			createTask: createTaskMock,
			createTaskWithHistoryItem: vi.fn(),
			getTaskWithId: vi.fn(),
			getTaskById: vi.fn((taskId: string) => (taskId === currentTask?.taskId ? currentTask : undefined)),
			getCurrentTask: vi.fn(() => currentTask),
			cancelTask: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
			taskHistoryStore: { get: (taskId: string) => history.get(taskId) },
		}
		// ClineProvider is concrete and has private state; this precise fake exercises only the API boundary above.
		provider = fakeProvider as unknown as ClineProvider
		api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, provider)
	})

	it("starts directly without invoking VS Code or a webview", async () => {
		await expect(api.startHeadlessTask({ text: "  preserve whitespace  " })).resolves.toEqual({
			taskId: "root-1",
			rootTaskId: "root-1",
		})
		expect(createTaskMock).toHaveBeenCalledWith("  preserve whitespace  ", undefined, undefined, {}, undefined)
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
	})

	it("validates initialization and active-run boundaries", async () => {
		await expect(api.startHeadlessTask({ text: "   " })).rejects.toThrow("must not be blank")
		await api.startHeadlessTask({ text: "active" })
		await expect(api.startHeadlessTask({ text: "second" })).rejects.toThrow("already active")
		await expect(api.resumeHeadlessTask("other")).rejects.toThrow("already active")
		await expect(api.waitForHeadlessTaskResult("missing")).rejects.toThrow("Unknown headless root task")
		await api.shutdownHeadless()
		await expect(api.initializeHeadless()).rejects.toThrow("shut down")
	})

	it("resumes history directly and preserves its root identity", async () => {
		const historyItem = { id: "child-1", rootTaskId: "root-1", status: "interrupted" }
		const resumedTask = createTask("child-1", { rootTaskId: "root-1", parentTaskId: "root-1" })
		vi.mocked(provider.getTaskWithId).mockResolvedValue({ historyItem } as never)
		vi.mocked(provider.createTaskWithHistoryItem).mockResolvedValue(resumedTask as never)

		await expect(api.resumeHeadlessTask("child-1")).resolves.toEqual({
			taskId: "child-1",
			rootTaskId: "root-1",
		})
		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledWith(historyItem)
	})

	it("routes a response only to the matching task and ask", async () => {
		await api.startHeadlessTask({ text: "task" })
		await api.respondToHeadlessAsk({ taskId: "root-1", askId: "42", response: { response: "reject" } })
		expect(rootTask.respondToAsk).toHaveBeenCalledWith(42, "noButtonClicked", undefined, undefined)
		await api.respondToHeadlessAsk({ taskId: "root-1", askId: "43", response: { response: "approve" } })
		expect(rootTask.respondToAsk).toHaveBeenCalledWith(43, "yesButtonClicked", undefined, undefined)
		await api.respondToHeadlessAsk({
			taskId: "root-1",
			askId: "44",
			response: { response: "message", text: "answer", images: ["image"] },
		})
		expect(rootTask.respondToAsk).toHaveBeenCalledWith(44, "messageResponse", "answer", ["image"])
		await expect(
			api.respondToHeadlessAsk({ taskId: "root-1", askId: "unsafe", response: { response: "approve" } }),
		).rejects.toThrow("Invalid ask ID")
		rootTask.respondToAsk.mockReturnValueOnce(false)
		await expect(
			api.respondToHeadlessAsk({ taskId: "root-1", askId: "45", response: { response: "approve" } }),
		).rejects.toThrow("is not pending")
		await expect(
			api.respondToHeadlessAsk({ taskId: "other", askId: "42", response: { response: "approve" } }),
		).rejects.toThrow("not active")
	})

	it("ignores child completion and waits for persisted root completion", async () => {
		await api.startHeadlessTask({ text: "delegate" })
		const child = createTask("child-1", { rootTaskId: "root-1", parentTaskId: "root-1" })
		providerEvents.emit(RooCodeEventName.TaskCreated, child)
		child.emit(RooCodeEventName.TaskCompleted, "child-1", {}, {})
		expect(await api.getHeadlessTaskResult("root-1")).toBeUndefined()
		rootTask.emit(RooCodeEventName.Message, {
			message: {
				ts: 41,
				type: "say",
				say: "completion_result",
				text: "final answer",
				partial: false,
			},
		})

		history.set("root-1", { status: "completed" })
		rootTask.emit(RooCodeEventName.TaskCompleted, "root-1", { totalTokensIn: 1 }, {})
		await expect(api.waitForHeadlessTaskResult("root-1")).resolves.toMatchObject({
			outcome: "completed",
			rootTaskId: "root-1",
			content: "final answer",
		})
	})

	it("projects pending asks and settles an unexpected root abort", async () => {
		const askListener = vi.fn()
		const failureListener = vi.fn()
		api.on(RooCodeEventName.HeadlessAsk, askListener)
		api.on(RooCodeEventName.HeadlessTerminalFailure, failureListener)
		await api.startHeadlessTask({ text: "abort" })

		rootTask.emit(RooCodeEventName.Message, {
			message: {
				ts: 42,
				type: "ask",
				ask: "followup",
				text: "Continue?",
				partial: false,
				isAnswered: false,
			},
		})
		expect(askListener).toHaveBeenCalledWith({
			taskId: "root-1",
			rootTaskId: "root-1",
			askId: "42",
			ask: "followup",
			text: "Continue?",
			isProtected: undefined,
		})

		rootTask.emit(RooCodeEventName.TaskAborted)
		await expect(api.waitForHeadlessTaskResult("root-1")).resolves.toMatchObject({
			outcome: "failed",
			error: { code: "task_failed", message: "Root task aborted unexpectedly" },
		})
		expect(failureListener).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "root-1", rootTaskId: "root-1", code: "task_failed" }),
		)
	})

	it("reports completion that was not persisted as a terminal failure", async () => {
		const failureListener = vi.fn()
		api.on(RooCodeEventName.HeadlessTerminalFailure, failureListener)
		await api.startHeadlessTask({ text: "complete" })

		rootTask.emit(RooCodeEventName.TaskCompleted, "root-1", {}, {})
		await expect(api.waitForHeadlessTaskResult("root-1")).resolves.toMatchObject({
			outcome: "failed",
			error: { code: "task_failed", message: "Root completion was not persisted" },
		})
		expect(failureListener).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "root-1", rootTaskId: "root-1", code: "task_failed" }),
		)
	})

	it("settles cancellation only after canonical cancellation returns", async () => {
		await api.startHeadlessTask({ text: "cancel" })
		history.set("root-1", { status: "interrupted" })
		const settlement = await api.cancelHeadlessTask({ rootTaskId: "root-1", reason: "signal" })
		expect(provider.cancelTask).toHaveBeenCalledWith({ rehydrate: false })
		expect(settlement).toEqual({ rootTaskId: "root-1", resumable: true, status: "interrupted" })
		await expect(api.waitForHeadlessTaskResult("root-1")).resolves.toMatchObject({ outcome: "cancelled" })
	})

	it("settles cancellation failures without leaving the run pending", async () => {
		await api.startHeadlessTask({ text: "cancel" })
		vi.mocked(provider.cancelTask).mockRejectedValueOnce(new Error("cancel exploded"))

		await expect(api.cancelHeadlessTask({ rootTaskId: "root-1", reason: "user" })).resolves.toEqual({
			rootTaskId: "root-1",
			resumable: false,
			status: "failed",
		})
		await expect(api.waitForHeadlessTaskResult("root-1")).resolves.toMatchObject({
			outcome: "failed",
			error: { code: "cancel_failed", message: "cancel exploded" },
		})
	})

	it("rejects cancellation when the requested root is not current", async () => {
		await api.startHeadlessTask({ text: "cancel" })
		currentTask = createTask("other-root")

		await expect(api.cancelHeadlessTask({ rootTaskId: "root-1", reason: "timeout" })).rejects.toThrow(
			"is not current",
		)
	})

	it("settles pending runs and disposes exactly once on shutdown", async () => {
		await api.startHeadlessTask({ text: "pending" })
		await expect(api.shutdownHeadless()).resolves.toEqual({ settledRuns: 1, pendingRuns: 1 })
		await expect(api.waitForHeadlessTaskResult("root-1")).resolves.toMatchObject({
			outcome: "failed",
			error: { code: "shutdown" },
		})
		await api.shutdownHeadless()
		expect(provider.dispose).toHaveBeenCalledTimes(1)
	})
})
