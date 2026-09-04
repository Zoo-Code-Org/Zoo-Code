import type { PendingTaskAction } from "@roo-code/types"

import { Task } from "../Task"

type PendingActionAccess = {
	resumePendingTaskAction(action: PendingTaskAction): Promise<void>
}

const getPendingActionAccess = (task: Task) => task as unknown as PendingActionAccess

function createTask(provider?: object) {
	const task = Object.create(Task.prototype) as Task
	Object.assign(task, {
		taskId: "task-1",
		providerRef: { deref: () => provider },
		ask: vi.fn(),
		say: vi.fn().mockResolvedValue(undefined),
		initiateTaskLoop: vi.fn().mockResolvedValue(undefined),
		persistQueuedFeedbackAndAcknowledge: vi.fn().mockResolvedValue(true),
		pendingAction: finishAction,
	})
	return task
}

const createAction: PendingTaskAction = {
	kind: "create_subtask",
	actionId: "create-action",
	approvalText: JSON.stringify({ tool: "newTask" }),
	mode: "ask",
	message: "Child task",
	todos: [],
}

const finishAction: PendingTaskAction = {
	kind: "finish_subtask",
	actionId: "finish-action",
	approvalText: JSON.stringify({ tool: "finishTask" }),
	parentTaskId: "parent-1",
	result: "Done",
}

describe("Task pending action replay", () => {
	it("executes an approved create-subtask action", async () => {
		const provider = { delegateParentAndOpenChild: vi.fn().mockResolvedValue({ taskId: "child-1" }) }
		const task = createTask(provider)
		task.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })

		await getPendingActionAccess(task).resumePendingTaskAction(createAction)

		expect(provider.delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "task-1",
			message: "Child task",
			initialTodos: [],
			mode: "ask",
			pendingActionId: "create-action",
		})
	})

	it("executes an approved finish-subtask action", async () => {
		const provider = { reopenParentFromDelegation: vi.fn().mockResolvedValue(true) }
		const task = createTask(provider)
		task.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })

		await getPendingActionAccess(task).resumePendingTaskAction(finishAction)

		expect(provider.reopenParentFromDelegation).toHaveBeenCalledWith({
			parentTaskId: "parent-1",
			childTaskId: "task-1",
			completionResultSummary: "Done",
			pendingActionId: "finish-action",
		})
	})

	it("falls back to a fresh completion ask when approved finish delegation is stale", async () => {
		const provider = {
			reopenParentFromDelegation: vi.fn().mockResolvedValue(false),
			clearPendingTaskAction: vi.fn().mockResolvedValue(true),
		}
		const task = createTask(provider)
		task.ask = vi
			.fn()
			.mockResolvedValueOnce({ response: "yesButtonClicked" })
			.mockResolvedValueOnce({ response: "yesButtonClicked" })
		const initiateTaskLoop = (task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop

		await getPendingActionAccess(task).resumePendingTaskAction(finishAction)

		expect(provider.clearPendingTaskAction).toHaveBeenCalledWith("task-1", "finish-action")
		expect(task.ask).toHaveBeenNthCalledWith(2, "completion_result", "", false)
		expect(initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("adopts and resumes a newer persisted action at the stale-action recursion boundary", async () => {
		const newerAction: PendingTaskAction = {
			...createAction,
			actionId: "newer-action",
			approvalText: JSON.stringify({ tool: "newTask", action: "newer" }),
		}
		const provider = {
			reopenParentFromDelegation: vi.fn().mockResolvedValue(false),
			clearPendingTaskAction: vi.fn().mockResolvedValue(false),
			taskHistoryStore: { get: vi.fn().mockReturnValue({ pendingAction: newerAction }) },
			delegateParentAndOpenChild: vi.fn().mockResolvedValue({ taskId: "child-2" }),
		}
		const task = createTask(provider)
		task.ask = vi
			.fn()
			.mockResolvedValueOnce({ response: "yesButtonClicked" })
			.mockResolvedValueOnce({ response: "yesButtonClicked" })
		const initiateTaskLoop = (task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop

		await getPendingActionAccess(task).resumePendingTaskAction(finishAction)

		expect(task.ask).toHaveBeenCalledTimes(2)
		expect(task.ask).toHaveBeenNthCalledWith(1, "tool", finishAction.approvalText, false)
		expect(task.ask).toHaveBeenNthCalledWith(2, "tool", newerAction.approvalText, false)
		expect(task.ask).not.toHaveBeenCalledWith("completion_result", "", false)
		expect(provider.reopenParentFromDelegation).toHaveBeenCalledTimes(1)
		expect(provider.reopenParentFromDelegation).toHaveBeenCalledWith(
			expect.objectContaining({ pendingActionId: "finish-action" }),
		)
		expect(provider.clearPendingTaskAction).toHaveBeenCalledTimes(1)
		expect(provider.clearPendingTaskAction).toHaveBeenCalledWith("task-1", "finish-action")
		expect(provider.taskHistoryStore.get).toHaveBeenCalledTimes(1)
		expect(provider.taskHistoryStore.get).toHaveBeenCalledWith("task-1")
		expect(provider.delegateParentAndOpenChild).toHaveBeenCalledTimes(1)
		expect(provider.delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "task-1",
			message: newerAction.message,
			initialTodos: newerAction.todos,
			mode: newerAction.mode,
			pendingActionId: "newer-action",
		})
		expect(provider.clearPendingTaskAction.mock.invocationCallOrder[0]).toBeLessThan(
			provider.taskHistoryStore.get.mock.invocationCallOrder[0],
		)
		expect(provider.taskHistoryStore.get.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(task.ask).mock.invocationCallOrder[1],
		)
		expect(vi.mocked(task.ask).mock.invocationCallOrder[1]).toBeLessThan(
			provider.delegateParentAndOpenChild.mock.invocationCallOrder[0],
		)
		expect((task as unknown as { pendingAction?: PendingTaskAction }).pendingAction).toEqual(newerAction)
		expect(initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("continues with denied queued feedback after durable persistence", async () => {
		const provider = { reopenParentFromDelegation: vi.fn().mockResolvedValue(false) }
		const task = createTask(provider)
		task.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "Revise this",
			queuedMessageId: "queued-1",
		})

		await getPendingActionAccess(task).resumePendingTaskAction(finishAction)

		expect(task.persistQueuedFeedbackAndAcknowledge).toHaveBeenCalledWith("queued-1", "Revise this", undefined)
		const initiateTaskLoop = (task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop
		expect(initiateTaskLoop).toHaveBeenCalledWith([
			expect.objectContaining({ type: "tool_result", tool_use_id: "finish-action" }),
		])
		const persist = vi.mocked(task.persistQueuedFeedbackAndAcknowledge)
		expect(persist.mock.invocationCallOrder[0]).toBeLessThan(initiateTaskLoop.mock.invocationCallOrder[0])
	})

	it("does not continue when durable queued feedback persistence fails", async () => {
		const task = createTask({})
		task.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "Revise this",
			queuedMessageId: "queued-1",
		})
		task.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(false)
		const initiateTaskLoop = (task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop

		await expect(getPendingActionAccess(task).resumePendingTaskAction(createAction)).rejects.toThrow(
			"task loop was not resumed",
		)
		expect(initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("records ordinary feedback when a restored action is denied", async () => {
		const task = createTask({})
		task.ask = vi.fn().mockResolvedValue({ response: "messageResponse", text: "No" })

		await getPendingActionAccess(task).resumePendingTaskAction(createAction)

		expect(task.say).toHaveBeenCalledWith("user_feedback", "No", undefined)
	})

	it("continues with a textless denial when the user clicks the deny button", async () => {
		const provider = {
			delegateParentAndOpenChild: vi.fn(),
			reopenParentFromDelegation: vi.fn(),
		}
		const task = createTask(provider)
		task.ask = vi.fn().mockResolvedValue({ response: "noButtonClicked" })
		const initiateTaskLoop = (task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop

		await getPendingActionAccess(task).resumePendingTaskAction(createAction)

		expect(provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
		expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(initiateTaskLoop).toHaveBeenCalledWith([
			{
				type: "tool_result",
				tool_use_id: "create-action",
				content: JSON.stringify({ status: "denied", message: "The user denied this operation." }),
			},
		])
	})

	it("fails clearly when the provider is unavailable", async () => {
		const task = createTask()

		await expect(getPendingActionAccess(task).resumePendingTaskAction(createAction)).rejects.toThrow(
			"Provider unavailable",
		)
	})
})
