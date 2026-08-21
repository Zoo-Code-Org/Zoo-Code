import { Task } from "../Task"

type QueueTaskTestAccess = {
	say: Task["say"]
	saveClineMessages: () => Promise<boolean>
}

const getQueueTaskTestAccess = (task: Task) => task as unknown as QueueTaskTestAccess

// Keep this test focused: if a queued message arrives while Task.ask() is blocked,
// it should be consumed and used to fulfill the ask.

describe("Task.ask queued message drain", () => {
	function createTask(provider?: { getState: () => Promise<Record<string, boolean>> }) {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).clineMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined
		;(task as any).queuedFeedbackRows = new Set<string>()
		;(task as any).queuedFeedbackRetryTimers = new Map<string, NodeJS.Timeout>()

		return import("../../message-queue/MessageQueueService").then(({ MessageQueueService }) => {
			;(task as any).messageQueueService = new MessageQueueService()
			;(task as any).addToClineMessages = vi.fn(async () => {})
			;(task as any).saveClineMessages = vi.fn(async () => {})
			;(task as any).updateClineMessage = vi.fn(async () => {})
			;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
			;(task as any).checkpointSave = vi.fn(async () => {})
			;(task as any).emit = vi.fn()
			;(task as any).providerRef = { deref: () => provider }
			return task
		})
	}

	it("consumes queued message while blocked on followup ask", async () => {
		const task = await createTask()

		const askPromise = task.ask("followup", "Q?", false)

		// Simulate webview queuing the user's selection text while the ask is pending.
		;(task as any).messageQueueService.addMessage("picked answer")

		const result = await askPromise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("picked answer")
	})

	it("does not consume queued messages for command_output asks", async () => {
		const task = await createTask()

		const askPromise = task.ask("command_output", "command is still running...", false)
		;(task as any).messageQueueService.addMessage("1+1=?")

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect((task as any).messageQueueService.isEmpty()).toBe(false)
		expect((task as any).messageQueueService.messages[0]?.text).toBe("1+1=?")
	})

	it.each(["finishTask", "newTask"])("queued feedback overrides auto-approval for %s", async (tool) => {
		const task = await createTask({
			getState: async () => ({ autoApprovalEnabled: true, alwaysAllowSubtasks: true }),
		})
		task.messageQueueService.addMessage("Please revise this first")

		const result = await task.ask("tool", JSON.stringify({ tool }), false)

		expect(result).toMatchObject({
			response: "messageResponse",
			text: "Please revise this first",
			images: undefined,
		})
		expect(result.queuedMessageId).toBe(task.messageQueueService.messages[0]?.id)
		expect(task.messageQueueService.isEmpty()).toBe(false)
		expect(task.acknowledgeQueuedMessage(result.queuedMessageId!)).toBe(true)
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("preserves approve-with-feedback behavior for ordinary tool asks", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("Use this context")

		const result = await task.ask("tool", JSON.stringify({ tool: "readFile" }), false)

		expect(result).toMatchObject({ response: "yesButtonClicked", text: "Use this context" })
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it.each([
		["command", "npm test"],
		["use_mcp_server", "{}"],
		["tool", "not-json"],
	] as const)("preserves approve-with-feedback behavior for %s asks", async (type, text) => {
		const task = await createTask()
		task.messageQueueService.addMessage("Approval context")

		const result = await task.ask(type, text, false)

		expect(result).toMatchObject({ response: "yesButtonClicked", text: "Approval context" })
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("claims lifecycle feedback that arrives while an ask is waiting", async () => {
		const task = await createTask()
		const ask = task.ask("tool", JSON.stringify({ tool: "finishTask" }), false)
		task.messageQueueService.addMessage("Late feedback")

		const result = await ask

		expect(result).toMatchObject({ response: "messageResponse", text: "Late feedback" })
		expect(result.queuedMessageId).toBe(task.messageQueueService.messages[0]?.id)
		expect(task.messageQueueService.peekMessage()).toBeUndefined()
	})

	it("uses queued feedback instead of accepting a completion result", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("One more change")

		const result = await task.ask("completion_result", "Done", false)

		expect(result).toMatchObject({ response: "messageResponse", text: "One more change" })
		expect(task.messageQueueService.isEmpty()).toBe(false)
		task.acknowledgeQueuedMessage(result.queuedMessageId!)
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("retains lifecycle feedback until its history write succeeds", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("Keep this message")
		const result = await task.ask("tool", JSON.stringify({ tool: "finishTask" }), false)
		const saveClineMessages = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
		const taskAccess = getQueueTaskTestAccess(task)
		taskAccess.say = vi.fn().mockResolvedValue(undefined)
		taskAccess.saveClineMessages = saveClineMessages

		expect(
			await task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).toBe(false)
		expect(task.messageQueueService.isEmpty()).toBe(false)

		const ordinaryAsk = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		setTimeout(() => task.approveAsk(), 0)
		const ordinaryResult = await ordinaryAsk
		expect(ordinaryResult.text).toBeUndefined()
		expect(task.messageQueueService.isEmpty()).toBe(false)

		expect(
			await task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).toBe(true)
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("retries a failed feedback write without duplicating the history row", async () => {
		vi.useFakeTimers()
		try {
			const task = await createTask()
			task.messageQueueService.addMessage("Retry feedback")
			const result = await task.ask("tool", JSON.stringify({ tool: "finishTask" }), false)
			const saveClineMessages = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
			const say = vi.fn().mockResolvedValue(undefined)
			const taskAccess = getQueueTaskTestAccess(task)
			taskAccess.say = say
			taskAccess.saveClineMessages = saveClineMessages

			await task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images)
			await vi.advanceTimersByTimeAsync(250)

			expect(say).toHaveBeenCalledTimes(1)
			expect(saveClineMessages).toHaveBeenCalledTimes(2)
			expect(task.messageQueueService.isEmpty()).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})
})
