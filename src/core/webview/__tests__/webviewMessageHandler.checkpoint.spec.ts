import pWaitFor from "p-wait-for"
import * as vscode from "vscode"
import type { HistoryItem, WebviewMessage } from "@roo-code/types"

import type { Task } from "../../task/Task"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { ClineProvider } from "../ClineProvider"
import { PendingEditOperationStore } from "../PendingEditOperationStore"
import { saveTaskMessages } from "../../task-persistence"
import { MessageManager } from "../../message-manager"
import { t } from "../../../i18n"

const { showWarningMessage } = vi.hoisted(() => ({
	showWarningMessage: vi.fn<(message: string, ...items: string[]) => Promise<string | undefined>>(),
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

const LATEST_CHECKPOINT = "b".repeat(40)

function createFixture() {
	const taskDouble = {
		taskId: "test-task-123",
		isInitialized: true,
		abort: false,
		clineMessages: [
			{ ts: 1, type: "say", say: "text", text: "Initial task" },
			{ ts: 2, type: "say", say: "checkpoint_saved", text: "initial-checkpoint" },
			{ ts: 3, type: "say", say: "user_feedback", text: "Latest prompt" },
			{ ts: 4, type: "say", say: "checkpoint_saved", text: LATEST_CHECKPOINT },
			{ ts: 5, type: "say", say: "completion_result", text: "Task complete" },
			{ ts: 6, type: "ask", ask: "completion_result", text: "", partial: false },
		] satisfies Task["clineMessages"],
		apiConversationHistory: [
			{ ts: 1, role: "user", content: [{ type: "text", text: "Initial task" }] },
			{ ts: 3, role: "user", content: [{ type: "text", text: "Latest prompt" }] },
			{ ts: 5, role: "assistant", content: [{ type: "text", text: "Task complete" }] },
		] satisfies Task["apiConversationHistory"],
		abortTask: vi.fn<Task["abortTask"]>(async () => {
			taskDouble.abort = true
		}),
		checkpointDiff: vi.fn<Task["checkpointDiff"]>(),
		checkpointRestore: vi.fn<Task["checkpointRestore"]>(),
		overwriteClineMessages: vi.fn<Task["overwriteClineMessages"]>(),
		overwriteApiConversationHistory: vi.fn<Task["overwriteApiConversationHistory"]>(),
		handleWebviewAskResponse: vi.fn<Task["handleWebviewAskResponse"]>(),
	}
	// Supplies checkpoint, abort, message/history, and overwrite APIs without starting a real task.
	const task = taskDouble as unknown as Task
	Object.defineProperty(task, "messageManager", { value: new MessageManager(task) })
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
		getState: vi.fn(
			async () =>
				({
					maxImageFileSize: 5,
					maxTotalImageSize: 20,
				}) satisfies Pick<
					Awaited<ReturnType<ClineProvider["getState"]>>,
					"maxImageFileSize" | "maxTotalImageSize"
				>,
		),
		getCurrentTask: vi.fn<ClineProvider["getCurrentTask"]>(() => task),
		postMessageToWebview: vi.fn<ClineProvider["postMessageToWebview"]>(),
		postStateToWebview: vi.fn<ClineProvider["postStateToWebview"]>(),
		getTaskWithId: vi.fn<ClineProvider["getTaskWithId"]>().mockResolvedValue({
			historyItem,
			taskDirPath: "/test/task",
			apiConversationHistoryFilePath: "/test/api.json",
			uiMessagesFilePath: "/test/messages.json",
			apiConversationHistory: [],
		}),
		createTaskWithHistoryItem: vi.fn<ClineProvider["createTaskWithHistoryItem"]>().mockResolvedValue(task),
		restartTaskIfCurrent: vi.fn<ClineProvider["restartTaskIfCurrent"]>().mockResolvedValue(true),
		setPendingEditOperation: vi.fn<ClineProvider["setPendingEditOperation"]>(),
		clearPendingEditOperation: vi.fn<ClineProvider["clearPendingEditOperation"]>(),
		cancelTask: vi.fn<ClineProvider["cancelTask"]>(),
		contextProxy: { globalStorageUri: { fsPath: "/test/storage" } },
	}
	// Supplies the handler's provider APIs and the real pending-edit store, without extension activation.
	const provider = providerDouble as unknown as ClineProvider
	providerDouble.setPendingEditOperation.mockImplementation((operationId, editData) =>
		ClineProvider.prototype.setPendingEditOperation.call(provider, operationId, editData),
	)
	providerDouble.clearPendingEditOperation.mockImplementation((operationId, owner) =>
		ClineProvider.prototype.clearPendingEditOperation.call(provider, operationId, owner),
	)
	return { task, taskDouble, provider, providerDouble, historyItem, store }
}

describe("webviewMessageHandler - checkpoint operations", () => {
	let fixture: ReturnType<typeof createFixture>

	beforeEach(() => {
		vi.clearAllMocks()
		fixture = createFixture()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		fixture.store.clearAll()
		vi.restoreAllMocks()
	})

	function expectUnchanged(messages: Task["clineMessages"], history: Task["apiConversationHistory"]) {
		expect(fixture.task.clineMessages).toEqual(messages)
		expect(fixture.task.apiConversationHistory).toEqual(history)
		expect(fixture.taskDouble.overwriteClineMessages).not.toHaveBeenCalled()
		expect(fixture.taskDouble.overwriteApiConversationHistory).not.toHaveBeenCalled()
		expect(fixture.taskDouble.handleWebviewAskResponse).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
	}

	it.each([true, false])("failed delete restarts only after accepting the prompt: %s", async (accept) => {
		const { task, taskDouble, provider, providerDouble } = fixture
		const messages = structuredClone(task.clineMessages)
		const history = structuredClone(task.apiConversationHistory)
		const restoreError = new Error("Checkpoint commit is missing")
		taskDouble.checkpointRestore.mockRejectedValueOnce(restoreError)
		let answerPrompt: (answer: string | undefined) => void = () => {
			throw new Error("Prompt not shown")
		}
		const promptShown = new Promise<void>((resolve) => {
			showWarningMessage.mockImplementationOnce(
				() =>
					new Promise<string | undefined>((answer) => {
						answerPrompt = answer
						resolve()
					}),
			)
		})
		const operation = webviewMessageHandler(provider, {
			type: "deleteMessageConfirm",
			messageTs: 3,
			restoreCheckpoint: true,
		})
		await promptShown

		expect(taskDouble.abortTask).toHaveBeenCalledOnce()
		expect(taskDouble.checkpointRestore).toHaveBeenCalledWith({
			ts: 3,
			commitHash: LATEST_CHECKPOINT,
			mode: "restore",
			operation: "delete",
		})
		expect(taskDouble.abortTask.mock.invocationCallOrder[0]).toBeLessThan(
			taskDouble.checkpointRestore.mock.invocationCallOrder[0],
		)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"common:errors.checkpoint_restore_failed: Checkpoint commit is missing",
		)
		expect(t).toHaveBeenCalledWith("common:errors.checkpoint_restore_failed", { error: restoreError.message })
		expect(t).toHaveBeenCalledWith("common:checkpoints.restart_after_restore_failure")
		expect(t).toHaveBeenCalledWith("common:checkpoints.restart")
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			"common:checkpoints.restart_after_restore_failure",
			"common:checkpoints.restart",
		)
		expect(providerDouble.getTaskWithId).not.toHaveBeenCalled()
		expect(providerDouble.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expectUnchanged(messages, history)

		answerPrompt(accept ? "common:checkpoints.restart" : undefined)
		await operation
		if (accept) {
			expect(providerDouble.restartTaskIfCurrent).toHaveBeenCalledExactlyOnceWith(task)
		} else {
			expect(providerDouble.restartTaskIfCurrent).not.toHaveBeenCalled()
		}
		expect(providerDouble.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expectUnchanged(messages, history)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2)
		expect(vscode.window.showErrorMessage).toHaveBeenLastCalledWith(
			"common:errors.message.error_deleting_message: Checkpoint commit is missing",
		)
	})

	it("failed edit clears the real pending operation without applying or saving the edit", async () => {
		const { task, taskDouble, provider, providerDouble, store } = fixture
		const messages = structuredClone(task.clineMessages)
		const history = structuredClone(task.apiConversationHistory)
		const operationId = `task-${task.taskId}`
		taskDouble.checkpointRestore.mockImplementationOnce(async () => {
			expect(store.get(operationId)).toEqual({
				messageTs: 3,
				editedContent: "Edited prompt",
				images: [],
				messageIndex: 2,
				apiConversationHistoryIndex: 1,
			})
			throw new Error("Checkpoint belongs to another task")
		})
		await webviewMessageHandler(provider, {
			type: "editMessageConfirm",
			messageTs: 3,
			text: "Edited prompt",
			restoreCheckpoint: true,
		})

		expect(taskDouble.checkpointRestore).toHaveBeenCalledExactlyOnceWith({
			ts: 3,
			commitHash: LATEST_CHECKPOINT,
			mode: "restore",
			operation: "edit",
		})
		expect(t).toHaveBeenCalledWith("common:errors.checkpoint_restore_failed", {
			error: "Checkpoint belongs to another task",
		})
		expect(providerDouble.getTaskWithId).not.toHaveBeenCalled()
		expect(providerDouble.clearPendingEditOperation).toHaveBeenCalledExactlyOnceWith(
			operationId,
			expect.any(Object),
		)
		expect(store.get(operationId)).toBeUndefined()
		expect(taskDouble.abortTask).not.toHaveBeenCalled()
		expect(providerDouble.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"common:errors.checkpoint_restore_failed: Checkpoint belongs to another task",
		)
		expect(vscode.window.showErrorMessage).toHaveBeenLastCalledWith(
			"common:errors.message.error_editing_message: Checkpoint belongs to another task",
		)
		expectUnchanged(messages, history)
	})

	it("saves non-checkpoint deletes without restoring", async () => {
		await webviewMessageHandler(fixture.provider, {
			type: "deleteMessageConfirm",
			messageTs: 3,
			restoreCheckpoint: false,
		})
		expect(saveTaskMessages).toHaveBeenCalledWith({
			messages: expect.any(Array),
			taskId: fixture.task.taskId,
			globalStoragePath: "/test/storage",
		})
		expect(fixture.taskDouble.checkpointRestore).not.toHaveBeenCalled()
	})

	it.each([
		{
			type: "checkpointRestore",
			failure: new Error("Missing checkpoint commit"),
			reason: "Missing checkpoint commit",
		},
		{ type: "checkpointRestore", failure: "Invalid checkpoint reference", reason: "Invalid checkpoint reference" },
		{
			type: "completionCheckpointRestore",
			failure: new Error("Missing checkpoint commit"),
			reason: "Missing checkpoint commit",
		},
		{
			type: "completionCheckpointRestore",
			failure: "Invalid checkpoint reference",
			reason: "Invalid checkpoint reference",
		},
	] as const)("$type localizes the specific restore failure: $reason", async ({ type, failure, reason }) => {
		const messages = structuredClone(fixture.task.clineMessages)
		const history = structuredClone(fixture.task.apiConversationHistory)
		fixture.taskDouble.checkpointRestore.mockRejectedValueOnce(failure)
		const message: WebviewMessage =
			type === "checkpointRestore"
				? { type, payload: { ts: 4, commitHash: LATEST_CHECKPOINT, mode: "restore" } }
				: { type }
		await webviewMessageHandler(fixture.provider, message)

		expect(fixture.providerDouble.cancelTask).toHaveBeenCalledOnce()
		expect(fixture.taskDouble.checkpointRestore).toHaveBeenCalledWith({
			ts: 4,
			commitHash: LATEST_CHECKPOINT,
			mode: "restore",
		})
		expect(console.error).toHaveBeenCalledWith(`[${type}] checkpointRestore failed:`, failure)
		expect(t).toHaveBeenCalledExactlyOnceWith("common:errors.checkpoint_restore_failed", { error: reason })
		expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
			`common:errors.checkpoint_restore_failed: ${reason}`,
		)
		expect(fixture.providerDouble.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expectUnchanged(messages, history)
	})

	it.each([
		{ name: "malformed", commitHash: "HEAD~1" },
		{ name: "unrecorded", commitHash: "c".repeat(40) },
	])("checkpointRestore rejects a $name hash without cancelling the task", async ({ commitHash }) => {
		const messages = structuredClone(fixture.task.clineMessages)
		const history = structuredClone(fixture.task.apiConversationHistory)
		await webviewMessageHandler(fixture.provider, {
			type: "checkpointRestore",
			payload: { ts: 4, commitHash, mode: "restore" },
		})

		expect(fixture.providerDouble.cancelTask).not.toHaveBeenCalled()
		expect(fixture.taskDouble.checkpointRestore).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
			"common:errors.checkpoint_restore_failed: common:errors.checkpoint_invalid_hash",
		)
		expectUnchanged(messages, history)
	})

	it("checkpointRestore cancels before restoring a recorded hash", async () => {
		await webviewMessageHandler(fixture.provider, {
			type: "checkpointRestore",
			payload: { ts: 4, commitHash: LATEST_CHECKPOINT, mode: "restore" },
		})
		expect(fixture.providerDouble.cancelTask.mock.invocationCallOrder[0]).toBeLessThan(
			fixture.taskDouble.checkpointRestore.mock.invocationCallOrder[0],
		)
	})

	describe("completion checkpoint actions", () => {
		it("diffs the checkpoint created after the latest prompt", async () => {
			await webviewMessageHandler(fixture.provider, { type: "completionCheckpointDiff" })
			expect(fixture.taskDouble.checkpointDiff).toHaveBeenCalledWith({
				ts: 4,
				commitHash: LATEST_CHECKPOINT,
				mode: "to-current",
			})
		})

		it("cancels before restoring the latest prompt checkpoint", async () => {
			await webviewMessageHandler(fixture.provider, { type: "completionCheckpointRestore" })
			expect(fixture.taskDouble.checkpointRestore).toHaveBeenCalledWith({
				ts: 4,
				commitHash: LATEST_CHECKPOINT,
				mode: "restore",
			})
			expect(fixture.providerDouble.cancelTask.mock.invocationCallOrder[0]).toBeLessThan(
				fixture.taskDouble.checkpointRestore.mock.invocationCallOrder[0],
			)
		})

		it("does not diff or restore without a latest-prompt checkpoint", async () => {
			fixture.task.clineMessages = fixture.task.clineMessages.filter((message) => message.ts !== 4)
			await webviewMessageHandler(fixture.provider, { type: "completionCheckpointDiff" })
			await webviewMessageHandler(fixture.provider, { type: "completionCheckpointRestore" })
			expect(fixture.taskDouble.checkpointDiff).not.toHaveBeenCalled()
			expect(fixture.taskDouble.checkpointRestore).not.toHaveBeenCalled()
			expect(fixture.providerDouble.cancelTask).not.toHaveBeenCalled()
		})

		it("does not restore when initialization times out", async () => {
			vi.mocked(pWaitFor).mockRejectedValueOnce(new Error("timed out"))
			await webviewMessageHandler(fixture.provider, { type: "completionCheckpointRestore" })
			expect(fixture.taskDouble.checkpointRestore).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.checkpoint_timeout")
		})

		it("does not restore when task identity changes during cancellation", async () => {
			const replacement = createFixture()
			replacement.taskDouble.taskId = "different-task-id"
			fixture.providerDouble.getCurrentTask.mockReturnValueOnce(fixture.task).mockReturnValue(replacement.task)
			await webviewMessageHandler(fixture.provider, { type: "completionCheckpointRestore" })
			expect(fixture.taskDouble.checkpointRestore).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.checkpoint_failed")
			replacement.store.clearAll()
		})
	})
})
