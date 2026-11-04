import * as vscode from "vscode"
import type { HistoryItem } from "@roo-code/types"

import { Task } from "../../task/Task"
import { ClineProvider } from "../ClineProvider"
import { handleCheckpointRestoreOperation, type CheckpointRestoreConfig } from "../checkpointRestoreHandler"
import { PendingEditOperationStore } from "../PendingEditOperationStore"
import { saveTaskMessages } from "../../task-persistence"
import { t } from "../../../i18n"

const { constructTask, showWarningMessage } = vi.hoisted(() => ({
	constructTask: vi.fn<(...arguments_: unknown[]) => object>(),
	showWarningMessage: vi.fn<(message: string, ...items: string[]) => Promise<string | undefined>>(),
}))
vi.mock("../../task/Task", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task/Task")>()),
	Task: vi.fn(function (...arguments_: unknown[]) {
		return constructTask(...arguments_)
	}),
}))
vi.mock("../../task-persistence", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task-persistence")>()),
	saveTaskMessages: vi.fn(),
}))
vi.mock("p-wait-for", () => ({
	default: vi.fn(async (condition: () => boolean | PromiseLike<boolean>) => {
		if (!(await condition())) throw new Error("condition not met")
	}),
}))
vi.mock("vscode", async (importOriginal) => {
	const actual = await importOriginal<typeof import("vscode")>()
	return {
		...actual,
		window: { ...actual.window, showErrorMessage: vi.fn(), showWarningMessage },
	}
})
vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, options?: { error?: string }) =>
		options?.error === undefined ? key : `${key}: ${options.error}`,
	),
}))

function createFixture() {
	const taskDouble = {
		taskId: "test-task-123",
		abort: false,
		clineMessages: [
			{ ts: 1, type: "say", say: "text", text: "Initial task" },
			{ ts: 3, type: "say", say: "user_feedback", text: "Original prompt" },
			{ ts: 4, type: "say", say: "checkpoint_saved", text: "abc123" },
		] satisfies Task["clineMessages"],
		apiConversationHistory: [
			{ ts: 3, role: "user", content: [{ type: "text", text: "Original prompt" }] },
		] satisfies Task["apiConversationHistory"],
		abortTask: vi.fn<Task["abortTask"]>(async () => {
			taskDouble.abort = true
		}),
		checkpointRestore: vi.fn<Task["checkpointRestore"]>(),
		overwriteClineMessages: vi.fn<Task["overwriteClineMessages"]>(),
		overwriteApiConversationHistory: vi.fn<Task["overwriteApiConversationHistory"]>(),
		handleWebviewAskResponse: vi.fn<Task["handleWebviewAskResponse"]>(),
		emit: vi.fn<Task["emit"]>(),
	}
	// Supplies restore, abort, history, and pending-edit application APIs without a running request loop.
	const task = taskDouble as unknown as Task
	constructTask.mockReturnValue(task)
	const historyItem: HistoryItem = {
		id: task.taskId,
		number: 1,
		ts: 1,
		task: "Initial task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	}
	const store = new PendingEditOperationStore(60_000, vi.fn())
	const providerDouble = {
		pendingEditOperations: store,
		taskRegistry: { current: task as Pick<Task, "taskId" | "abortTask"> | undefined, replace: vi.fn() },
		taskEventListeners: new Map<Task, Array<() => void>>(),
		performPreparationTasks: vi.fn<(task: Task) => Promise<void>>(),
		log: vi.fn<(message: string) => void>(),
		getCurrentTask: vi.fn<ClineProvider["getCurrentTask"]>(() => task),
		getTaskWithId: vi.fn<ClineProvider["getTaskWithId"]>().mockResolvedValue({
			historyItem,
			taskDirPath: "/test/task",
			apiConversationHistoryFilePath: "/test/api.json",
			uiMessagesFilePath: "/test/messages.json",
			apiConversationHistory: [],
		}),
		createTaskWithHistoryItem: vi.fn<ClineProvider["createTaskWithHistoryItem"]>().mockResolvedValue(task),
		restartTaskIfCurrent: vi.fn<ClineProvider["restartTaskIfCurrent"]>(),
		setPendingEditOperation: vi.fn<ClineProvider["setPendingEditOperation"]>(),
		clearPendingEditOperation: vi.fn<ClineProvider["clearPendingEditOperation"]>(),
		getPendingEditOperation: ClineProvider.prototype["getPendingEditOperation"],
		getState: vi.fn(async () => ({ apiConfiguration: {} })),
		contextProxy: { globalStorageUri: { fsPath: "/test/storage" } },
		taskScheduler: { schedule: vi.fn<(task: Task, run: () => Promise<void>) => Promise<void>>(async () => {}) },
	}
	// Supplies restore/rehydration dependencies and the real store; scheduling is disabled in the rehydration test.
	const provider = providerDouble as unknown as ClineProvider
	providerDouble.setPendingEditOperation.mockImplementation((operationId, editData) =>
		ClineProvider.prototype.setPendingEditOperation.call(provider, operationId, editData),
	)
	providerDouble.clearPendingEditOperation.mockImplementation((operationId, owner) =>
		ClineProvider.prototype.clearPendingEditOperation.call(provider, operationId, owner),
	)
	providerDouble.restartTaskIfCurrent.mockImplementation((restartTask) =>
		ClineProvider.prototype.restartTaskIfCurrent.call(provider, restartTask),
	)
	const config: CheckpointRestoreConfig = {
		provider,
		currentCline: task,
		messageTs: 3,
		messageIndex: 1,
		checkpoint: { hash: "abc123" },
		operation: "delete",
	}
	const failure = new Error("Disk full")
	return { task, taskDouble, provider, providerDouble, historyItem, store, config, failure }
}

describe("checkpointRestoreHandler", () => {
	let fixture: ReturnType<typeof createFixture>
	beforeEach(() => {
		vi.clearAllMocks()
		showWarningMessage.mockResolvedValue(undefined)
		fixture = createFixture()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})
	afterEach(() => {
		fixture.store.clearAll()
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it.each([false, true])("successful delete saves and rehydrates, already aborted: %s", async (aborted) => {
		fixture.taskDouble.abort = aborted
		fixture.taskDouble.checkpointRestore.mockImplementationOnce(async () => {
			fixture.task.clineMessages = fixture.task.clineMessages.slice(0, 1)
		})
		await handleCheckpointRestoreOperation(fixture.config)
		expect(fixture.taskDouble.abortTask).toHaveBeenCalledTimes(aborted ? 0 : 1)
		expect(fixture.taskDouble.checkpointRestore).toHaveBeenCalledExactlyOnceWith({
			ts: 3,
			commitHash: "abc123",
			mode: "restore",
			operation: "delete",
		})
		expect(saveTaskMessages).toHaveBeenCalledExactlyOnceWith({
			messages: fixture.task.clineMessages,
			taskId: fixture.task.taskId,
			globalStoragePath: "/test/storage",
		})
		expect(fixture.providerDouble.getTaskWithId).toHaveBeenCalledExactlyOnceWith(fixture.task.taskId)
		expect(fixture.providerDouble.createTaskWithHistoryItem).toHaveBeenCalledExactlyOnceWith(fixture.historyItem)
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("successful edit retains pending data for automatic rehydration, without saving or aborting", async () => {
		await handleCheckpointRestoreOperation({
			...fixture.config,
			operation: "edit",
			editData: { editedContent: "Edited prompt", images: ["image.png"], apiConversationHistoryIndex: 0 },
		})
		expect(fixture.store.get(`task-${fixture.task.taskId}`)).toEqual({
			messageTs: 3,
			editedContent: "Edited prompt",
			images: ["image.png"],
			messageIndex: 1,
			apiConversationHistoryIndex: 0,
		})
		expect(fixture.taskDouble.checkpointRestore).toHaveBeenCalledWith({
			ts: 3,
			commitHash: "abc123",
			mode: "restore",
			operation: "edit",
		})
		expect(fixture.taskDouble.abortTask).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
		expect(fixture.providerDouble.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(fixture.providerDouble.clearPendingEditOperation).not.toHaveBeenCalled()
	})

	it.each([
		{ operation: "delete", failure: new Error("Missing commit"), reason: "Missing commit" },
		{ operation: "delete", failure: "Invalid reference", reason: "Invalid reference" },
		{ operation: "edit", failure: new Error("Missing commit"), reason: "Missing commit" },
		{ operation: "edit", failure: "Invalid reference", reason: "Invalid reference" },
	] as const)(
		"$operation reports and rethrows the original failure: $reason",
		async ({ operation, failure, reason }) => {
			const messages = structuredClone(fixture.task.clineMessages)
			const history = structuredClone(fixture.task.apiConversationHistory)
			fixture.taskDouble.checkpointRestore.mockRejectedValueOnce(failure)
			await expect(
				handleCheckpointRestoreOperation({
					...fixture.config,
					operation,
					editData: { editedContent: "Edited prompt", apiConversationHistoryIndex: 0 },
				}),
			).rejects.toBe(failure)

			expect(t).toHaveBeenCalledWith("common:errors.checkpoint_restore_failed", { error: reason })
			expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
				`common:errors.checkpoint_restore_failed: ${reason}`,
			)
			expect(console.error).toHaveBeenCalledWith(`Error in checkpoint restore (${operation}):`, failure)
			expect(fixture.task.clineMessages).toEqual(messages)
			expect(fixture.task.apiConversationHistory).toEqual(history)
			expect(saveTaskMessages).not.toHaveBeenCalled()
			expect(fixture.providerDouble.getTaskWithId).not.toHaveBeenCalled()
			expect(fixture.providerDouble.createTaskWithHistoryItem).not.toHaveBeenCalled()
			expect(fixture.store.get(`task-${fixture.task.taskId}`)).toBeUndefined()
			if (operation === "delete") {
				expect(showWarningMessage).toHaveBeenCalledWith(
					"common:checkpoints.restart_after_restore_failure",
					"common:checkpoints.restart",
				)
			} else {
				expect(showWarningMessage).not.toHaveBeenCalled()
				expect(fixture.providerDouble.clearPendingEditOperation).toHaveBeenCalledWith(
					`task-${fixture.task.taskId}`,
					expect.any(Object),
				)
			}
		},
	)

	it.each([
		{
			step: "saving messages",
			fail: (f: typeof fixture) => vi.mocked(saveTaskMessages).mockRejectedValueOnce(f.failure),
		},
		{
			step: "loading history",
			fail: (f: typeof fixture) => f.providerDouble.getTaskWithId.mockRejectedValueOnce(f.failure),
		},
		{
			step: "rehydrating the task",
			fail: (f: typeof fixture) => f.providerDouble.createTaskWithHistoryItem.mockRejectedValueOnce(f.failure),
		},
	])(
		"delete restore that succeeds then fails while $step surfaces the error without a restart prompt",
		async ({ fail }) => {
			fail(fixture)
			await expect(handleCheckpointRestoreOperation(fixture.config)).rejects.toBe(fixture.failure)
			expect(fixture.taskDouble.checkpointRestore).toHaveBeenCalledOnce()
			expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
				"common:errors.checkpoint_restore_failed: Disk full",
			)
			expect(console.error).toHaveBeenCalledWith("Error in checkpoint restore (delete):", fixture.failure)
			expect(showWarningMessage).not.toHaveBeenCalled()
			expect(fixture.providerDouble.restartTaskIfCurrent).not.toHaveBeenCalled()
		},
	)

	it("restarts the failed task when it is still current and the user accepts", async () => {
		fixture.taskDouble.checkpointRestore.mockRejectedValueOnce(new Error("Missing commit"))
		showWarningMessage.mockResolvedValueOnce("common:checkpoints.restart")
		await expect(handleCheckpointRestoreOperation(fixture.config)).rejects.toThrow("Missing commit")
		expect(fixture.providerDouble.getTaskWithId).toHaveBeenCalledExactlyOnceWith(fixture.task.taskId)
		expect(Task).toHaveBeenCalledOnce()
		expect(fixture.providerDouble.taskScheduler.schedule).toHaveBeenCalledExactlyOnceWith(
			fixture.task,
			expect.any(Function),
		)
		expect(console.error).not.toHaveBeenCalledWith(
			"Failed to restart task after checkpoint restore failure:",
			expect.anything(),
		)
	})

	it.each([
		{ name: "a different task became current", replacement: "newer" },
		{ name: "a newer instance with the same id became current", replacement: "sameId" },
		{ name: "no task remains current", replacement: "none" },
	] as const)("restart skips replacement and scheduling when $name during setup", async ({ replacement }) => {
		const newerTask = {
			taskId: replacement === "sameId" ? fixture.task.taskId : "newer-task",
			abortTask: vi.fn<Task["abortTask"]>(),
		}
		const constructedTask = { taskId: fixture.task.taskId, abortTask: vi.fn<Task["abortTask"]>(async () => {}) }
		constructTask.mockReturnValueOnce(constructedTask)
		const listenerCleanup = vi.fn()
		const orphanTask = constructedTask as unknown as Task // Map key only; identity is what matters.
		fixture.providerDouble.taskEventListeners.set(orphanTask, [listenerCleanup])
		const registry = fixture.providerDouble.taskRegistry
		fixture.taskDouble.checkpointRestore.mockRejectedValueOnce(new Error("Missing commit"))
		showWarningMessage.mockResolvedValueOnce("common:checkpoints.restart")
		fixture.providerDouble.getState.mockImplementationOnce(async () => {
			registry.current = replacement === "none" ? undefined : newerTask
			return { apiConfiguration: {} }
		})
		await expect(handleCheckpointRestoreOperation(fixture.config)).rejects.toThrow("Missing commit")
		expect(Task).toHaveBeenCalledOnce()
		expect(constructedTask.abortTask).toHaveBeenCalledExactlyOnceWith(true)
		expect(fixture.taskDouble.abortTask).not.toHaveBeenCalledWith(true)
		expect(newerTask.abortTask).not.toHaveBeenCalled()
		expect(registry.replace).not.toHaveBeenCalled()
		expect(fixture.providerDouble.taskScheduler.schedule).not.toHaveBeenCalled()
		expect(listenerCleanup).toHaveBeenCalledOnce()
		expect(fixture.providerDouble.taskEventListeners.has(orphanTask)).toBe(false)
	})

	it.each([
		{
			name: "before the restart is queued",
			setup: (current: ReturnType<typeof createFixture>) =>
				showWarningMessage.mockImplementationOnce(async () => {
					current.providerDouble.getCurrentTask.mockReturnValue(undefined)
					return "common:checkpoints.restart"
				}),
			loadsHistory: false,
		},
		{
			name: "while history is loading",
			setup: (current: ReturnType<typeof createFixture>) => {
				showWarningMessage.mockResolvedValueOnce("common:checkpoints.restart")
				current.providerDouble.getTaskWithId.mockImplementationOnce(async () => {
					current.providerDouble.getCurrentTask.mockReturnValue(undefined)
					return { historyItem: current.historyItem } as Awaited<ReturnType<ClineProvider["getTaskWithId"]>>
				})
			},
			loadsHistory: true,
		},
		{
			name: "by a navigation queued first",
			setup: (current: ReturnType<typeof createFixture>) =>
				showWarningMessage.mockImplementationOnce(async () => {
					void ClineProvider.prototype["enqueueHistoryTaskTransition"].call(current.provider, async () => {
						current.providerDouble.getCurrentTask.mockReturnValue(undefined)
					})
					return "common:checkpoints.restart"
				}),
			loadsHistory: false,
		},
	])("does not restart when another task becomes current $name", async ({ setup, loadsHistory }) => {
		fixture.taskDouble.checkpointRestore.mockRejectedValueOnce(new Error("Missing commit"))
		setup(fixture)
		await expect(handleCheckpointRestoreOperation(fixture.config)).rejects.toThrow("Missing commit")
		expect(fixture.providerDouble.getTaskWithId).toHaveBeenCalledTimes(loadsHistory ? 1 : 0)
		expect(Task).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
	})

	it("a failed older edit keeps a newer edit staged during its restore", async () => {
		const operationId = `task-${fixture.task.taskId}`
		fixture.taskDouble.checkpointRestore.mockImplementationOnce(async () => {
			fixture.provider.setPendingEditOperation(operationId, {
				messageTs: 3,
				editedContent: "Newer edit",
				messageIndex: 1,
				apiConversationHistoryIndex: 0,
			})
			throw new Error("Missing commit")
		})
		await expect(
			handleCheckpointRestoreOperation({
				...fixture.config,
				operation: "edit",
				editData: { editedContent: "Older edit", apiConversationHistoryIndex: 0 },
			}),
		).rejects.toThrow("Missing commit")
		expect(fixture.store.get(operationId)?.editedContent).toBe("Newer edit")
	})

	it("does not apply a failed pending edit on later real provider rehydration", async () => {
		vi.useFakeTimers()
		const messages = structuredClone(fixture.task.clineMessages)
		const history = structuredClone(fixture.task.apiConversationHistory)
		fixture.taskDouble.checkpointRestore.mockRejectedValueOnce(new Error("Missing commit"))
		await expect(
			handleCheckpointRestoreOperation({
				...fixture.config,
				operation: "edit",
				editData: { editedContent: "Must not be applied", apiConversationHistoryIndex: 0 },
			}),
		).rejects.toThrow("Missing commit")
		expect(fixture.store.get(`task-${fixture.task.taskId}`)).toBeUndefined()

		await ClineProvider.prototype.createTaskWithHistoryItem.call(fixture.provider, fixture.historyItem, {
			startTask: false,
		})
		await vi.advanceTimersByTimeAsync(100)
		expect(Task).toHaveBeenCalledOnce()
		expect(fixture.providerDouble.performPreparationTasks).toHaveBeenCalledWith(fixture.task)
		expect(fixture.taskDouble.overwriteClineMessages).not.toHaveBeenCalled()
		expect(fixture.taskDouble.overwriteApiConversationHistory).not.toHaveBeenCalled()
		expect(fixture.taskDouble.handleWebviewAskResponse).not.toHaveBeenCalled()
		expect(fixture.task.clineMessages).toEqual(messages)
		expect(fixture.task.apiConversationHistory).toEqual(history)
		expect(saveTaskMessages).not.toHaveBeenCalled()
	})

	it("applies a successful pending edit through the same real provider rehydration path", async () => {
		vi.useFakeTimers()
		await handleCheckpointRestoreOperation({
			...fixture.config,
			operation: "edit",
			editData: { editedContent: "Accepted edit", images: [], apiConversationHistoryIndex: 0 },
		})
		await ClineProvider.prototype.createTaskWithHistoryItem.call(fixture.provider, fixture.historyItem, {
			startTask: false,
		})
		await vi.advanceTimersByTimeAsync(100)
		expect(fixture.taskDouble.overwriteClineMessages).toHaveBeenCalledWith(fixture.task.clineMessages.slice(0, 1))
		expect(fixture.taskDouble.overwriteApiConversationHistory).toHaveBeenCalledWith([])
		expect(fixture.taskDouble.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "Accepted edit", [])
		expect(fixture.store.get(`task-${fixture.task.taskId}`)).toBeUndefined()
	})
})
