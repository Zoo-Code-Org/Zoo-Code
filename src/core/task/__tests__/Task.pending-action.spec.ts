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
		expect(
			(task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop,
		).toHaveBeenCalledWith([expect.objectContaining({ type: "tool_result", tool_use_id: "finish-action" })])
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
