import type { ClineMessage } from "@roo-code/types"

import { Task } from "../Task"

type QueueTaskTestAccess = {
	say: Task["say"]
	saveClineMessages: () => Promise<boolean>
	addToClineMessages: (message?: ClineMessage) => Promise<boolean>
	updateClineMessage: (message?: ClineMessage) => Promise<void>
	clineMessages: ClineMessage[]
	queuedFeedbackRows: Map<string, ClineMessage>
	lastMessageTs?: number
	abort: boolean
	abandoned: boolean
	queuedMessageDrainChain: Promise<unknown>
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
		return import("../../message-queue/MessageQueueService").then(({ MessageQueueService }) => {
			;(task as any).messageQueueService = new MessageQueueService()
			// Object.create skips field initializers; the drain chain must exist
			// for processQueuedMessages to schedule behind it.
			getQueueTaskTestAccess(task).queuedMessageDrainChain = Promise.resolve()
			// Object.create skips field initializers; the drain chain and the
			// feedback-row association map must exist for their paths.
			getQueueTaskTestAccess(task).queuedFeedbackRows = new Map()
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

	it("acks a drained padded message through the consuming ask", async () => {
		const task = await createTask({ getState: async () => ({}) })

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		await new Promise((resolve) => setTimeout(resolve, 150))

		// editQueuedMessage saves untrimmed text; submitUserMessage trims before
		// posting, so the drained submission is the trimmed text.
		task.messageQueueService.addMessage("  padded correction  ")
		const drain = task.processQueuedMessages()

		const result = await askPromise
		await drain

		expect(result).toMatchObject({ response: "messageResponse", text: "padded correction" })
		// Interception is consumption, but removal is deferred to the durable
		// ack: the entry stays queued until the history write succeeds.
		expect(result.queuedMessageId).toBe(task.messageQueueService.messages[0]?.id)
		expect(task.messageQueueService.isEmpty()).toBe(false)

		getQueueTaskTestAccess(task).saveClineMessages = vi.fn(async () => true)
		await expect(
			task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).resolves.toBe(true)
		expect(task.messageQueueService.isEmpty()).toBe(true)

		setTimeout(() => task.approveAsk(), 0)
		const nextResult = await task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		expect(nextResult).toMatchObject({ response: "yesButtonClicked", text: undefined })
	})

	it("acks an intercepted drained message through the consuming ask", async () => {
		const task = await createTask({ getState: async () => ({}) })

		// Park a tool ask in the real pWaitFor: no auto-approval and nothing
		// queued at ask start, so it blocks.
		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		// Let the ask reach its pWaitFor before the drain runs.
		await new Promise((resolve) => setTimeout(resolve, 150))

		// Background-completion style drain while the ask is blocked: the real
		// submit posts the message into the pending ask-response slot.
		task.messageQueueService.addMessage("queued correction")
		const drain = task.processQueuedMessages()

		const result = await askPromise
		await drain

		// Interception: the blocked tool ask is answered with the submitted
		// message (the claim path would have answered yesButtonClicked).
		expect(result).toMatchObject({ response: "messageResponse", text: "queued correction" })
		// The entry stays queued until the consuming ask's durable ack removes it.
		expect(result.queuedMessageId).toBe(task.messageQueueService.messages[0]?.id)
		expect(task.messageQueueService.isEmpty()).toBe(false)

		getQueueTaskTestAccess(task).saveClineMessages = vi.fn(async () => true)
		await expect(
			task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).resolves.toBe(true)
		expect(task.messageQueueService.isEmpty()).toBe(true)

		setTimeout(() => task.approveAsk(), 0)
		const nextResult = await task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		expect(nextResult).toMatchObject({ response: "yesButtonClicked", text: undefined })
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("retains a drained message when a user response overwrites it before consumption", async () => {
		const task = await createTask({ getState: async () => ({}) })

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		await new Promise((resolve) => setTimeout(resolve, 150))

		// The drain posts the message into the pending slot, but the user
		// answers the blocked ask directly before any ask consumed it.
		task.messageQueueService.addMessage("queued correction")
		await task.processQueuedMessages()
		setTimeout(() => task.approveAsk(), 0)

		const result = await askPromise

		expect(result).toMatchObject({ response: "yesButtonClicked", text: undefined })
		// The overwritten submission was not consumed, so the message stays
		// queued for a later ask instead of being removed or lost.
		expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["queued correction"])

		const nextResult = await task.ask("followup", "Q?", false)
		expect(nextResult).toMatchObject({ response: "messageResponse", text: "queued correction" })
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("does not consume a drained message when a direct response has identical text and images", async () => {
		const task = await createTask({ getState: async () => ({}) })

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		await new Promise((resolve) => setTimeout(resolve, 150))

		task.messageQueueService.addMessage("same words", ["img.png"])
		await task.processQueuedMessages()

		// A direct user response with the exact same trimmed text and images
		// lands before the ask observes the pending slot; identity, not
		// content, decides consumption.
		task.handleWebviewAskResponse("messageResponse", "same words", ["img.png"])

		const result = await askPromise

		expect(result).toMatchObject({ response: "messageResponse", text: "same words", images: ["img.png"] })
		expect(result.queuedMessageId).toBeUndefined()
		// The direct response did not consume the queue entry.
		expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["same words"])
	})

	it("does not resubmit a drained message that is still pending consumption", async () => {
		const task = await createTask({ getState: async () => ({}) })
		const submitSpy = vi.spyOn(task, "submitUserMessage")

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		await new Promise((resolve) => setTimeout(resolve, 150))

		task.messageQueueService.addMessage("queued correction")
		await task.processQueuedMessages()

		// A direct response lands before the ask observes the pending slot.
		task.handleWebviewAskResponse("yesButtonClicked")

		// The second drain (background-completion + post-result orchestration)
		// must not re-post the retained message over the direct response.
		const secondDrain = task.processQueuedMessages()

		const result = await askPromise
		await secondDrain

		expect(submitSpy).toHaveBeenCalledTimes(1)
		expect(result).toMatchObject({ response: "yesButtonClicked", text: undefined })
		expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["queued correction"])

		// The retained message is still deliverable to a later ask.
		const nextResult = await task.ask("followup", "Q?", false)
		expect(nextResult).toMatchObject({ response: "messageResponse", text: "queued correction" })
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("retains an intercepted drained message until its history write succeeds", async () => {
		const task = await createTask({ getState: async () => ({}) })

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		await new Promise((resolve) => setTimeout(resolve, 150))

		task.messageQueueService.addMessage("Keep this correction")
		const drain = task.processQueuedMessages()

		const result = await askPromise
		await drain

		expect(result).toMatchObject({ response: "messageResponse", text: "Keep this correction" })
		expect(result.queuedMessageId).toBe(task.messageQueueService.messages[0]?.id)

		// A failed history write must keep the message queued; the ack retries
		// and removes the entry only after the save succeeds.
		const taskAccess = getQueueTaskTestAccess(task)
		taskAccess.say = vi.fn().mockResolvedValue(true)
		taskAccess.saveClineMessages = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)

		vi.useFakeTimers()
		try {
			const persistence = task.persistQueuedFeedbackAndAcknowledge(
				result.queuedMessageId!,
				result.text,
				result.images,
			)
			await vi.advanceTimersByTimeAsync(0)
			expect(task.messageQueueService.isEmpty()).toBe(false)
			expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["Keep this correction"])

			await vi.advanceTimersByTimeAsync(250)
			await expect(persistence).resolves.toBe(true)
			expect(task.messageQueueService.isEmpty()).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	it("re-queues an intercepted drained message when its history write keeps failing", async () => {
		const task = await createTask({ getState: async () => ({}) })

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		await new Promise((resolve) => setTimeout(resolve, 150))

		task.messageQueueService.addMessage("Do not lose me")
		const drain = task.processQueuedMessages()

		const result = await askPromise
		await drain
		expect(result.queuedMessageId).toBe(task.messageQueueService.messages[0]?.id)

		const taskAccess = getQueueTaskTestAccess(task)
		taskAccess.say = vi.fn().mockResolvedValue(true)
		taskAccess.saveClineMessages = vi.fn().mockResolvedValue(false)

		vi.useFakeTimers()
		try {
			const persistence = task.persistQueuedFeedbackAndAcknowledge(
				result.queuedMessageId!,
				result.text,
				result.images,
			)
			await vi.runAllTimersAsync()

			await expect(persistence).resolves.toBe(false)
			expect(taskAccess.saveClineMessages).toHaveBeenCalledTimes(4)
			// The message is released back to the queue for a later drain.
			expect(task.messageQueueService.messages).toHaveLength(1)
			expect(task.messageQueueService.claimNextMessage()?.text).toBe("Do not lose me")
		} finally {
			vi.useRealTimers()
		}
	})

	it("delivers an intercepted message exactly once when a consumer acks through the durable helper", async () => {
		const task = await createTask({ getState: async () => ({}) })
		const submitSpy = vi.spyOn(task, "submitUserMessage")

		// ReadFileTool-style blocked approval ask: the queue is empty at ask
		// start, so a drain that posts mid-block intercepts the ask.
		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		await new Promise((resolve) => setTimeout(resolve, 150))

		task.messageQueueService.addMessage("user correction")
		const drain = task.processQueuedMessages()

		const result = await askPromise
		await drain

		expect(result).toMatchObject({ response: "messageResponse", text: "user correction" })
		expect(result.queuedMessageId).toBe(task.messageQueueService.messages[0]?.id)

		// The consumer persists the feedback through the acking helper, which
		// removes the queue entry only after the history write succeeds.
		getQueueTaskTestAccess(task).saveClineMessages = vi.fn(async () => true)
		await task.sayUserFeedbackAndAckQueued(result.text, result.images, result.queuedMessageId)
		expect(task.messageQueueService.isEmpty()).toBe(true)

		// No later drain or claim may redeliver the consumed message.
		await expect(task.processQueuedMessages()).resolves.toBe(false)
		expect(submitSpy).toHaveBeenCalledTimes(1)
	})

	it("drops an intercepted message consumed without persisting feedback", async () => {
		const task = await createTask({ getState: async () => ({}) })
		const submitSpy = vi.spyOn(task, "submitUserMessage")

		// api_req_failed-style gate: the consumer only inspects the button
		// response, so the intercepted queued message is discarded, not acked.
		const askPromise = task.ask("api_req_failed", "The model returned no assistant messages.", false)
		await new Promise((resolve) => setTimeout(resolve, 150))

		task.messageQueueService.addMessage("queued note")
		const drain = task.processQueuedMessages()

		const result = await askPromise
		await drain

		expect(result).toMatchObject({ response: "messageResponse", text: "queued note" })
		expect(result.queuedMessageId).toBe(task.messageQueueService.messages[0]?.id)

		task.discardConsumedQueuedMessage(result.queuedMessageId)
		expect(task.messageQueueService.isEmpty()).toBe(true)

		// No redelivery: the next drain finds an empty queue.
		await expect(task.processQueuedMessages()).resolves.toBe(false)
		expect(submitSpy).toHaveBeenCalledTimes(1)
	})

	it("keeps exactly one feedback row when a redelivery follows a partial save failure", async () => {
		const task = await createTask({ getState: async () => ({}) })

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		await new Promise((resolve) => setTimeout(resolve, 150))

		task.messageQueueService.addMessage("dedupe me")
		const drain = task.processQueuedMessages()

		const result = await askPromise
		await drain
		const messageId = result.queuedMessageId!

		const taskAccess = getQueueTaskTestAccess(task)
		taskAccess.addToClineMessages = async (message) => {
			taskAccess.clineMessages.push(message!)
			return true
		}
		// The messages-file write succeeds but metadata persistence fails, so
		// saveClineMessages reports false and the entry is released queued.
		const saveClineMessages = vi.fn().mockResolvedValue(false)
		taskAccess.saveClineMessages = saveClineMessages

		vi.useFakeTimers()
		try {
			const first = task.persistQueuedFeedbackAndAcknowledge(messageId, result.text, result.images)
			await vi.runAllTimersAsync()
			await expect(first).resolves.toBe(false)
		} finally {
			vi.useRealTimers()
		}
		expect(task.messageQueueService.messages).toHaveLength(1)
		expect(taskAccess.clineMessages.filter((message) => message.say === "user_feedback")).toHaveLength(1)

		// Redelivery: the retained entry is acked again and the reconciled
		// attempt must update the same row instead of appending a duplicate.
		saveClineMessages.mockResolvedValue(true)
		await expect(task.persistQueuedFeedbackAndAcknowledge(messageId, result.text, result.images)).resolves.toBe(
			true,
		)
		const rows = taskAccess.clineMessages.filter((message) => message.say === "user_feedback")
		expect(rows).toHaveLength(1)
		expect(rows[0].text).toBe("dedupe me")
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("does not submit queued messages once the task is aborted", async () => {
		const task = await createTask({ getState: async () => ({}) })
		const submitSpy = vi.spyOn(task, "submitUserMessage")
		task.messageQueueService.addMessage("too late")
		getQueueTaskTestAccess(task).abort = true

		await expect(task.processQueuedMessages()).resolves.toBe(false)

		expect(submitSpy).not.toHaveBeenCalled()
		expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["too late"])
		// The ask-response slot stays empty: no emission, no checkpoint.
		expect(task["askResponse"]).toBeUndefined()
	})

	it("drops the drain quietly when abort lands mid-submission", async () => {
		const task = await createTask({ getState: async () => ({}) })
		task.messageQueueService.addMessage("too late")
		const realSubmit = task.submitUserMessage.bind(task)
		vi.spyOn(task, "submitUserMessage").mockImplementation((...args) => {
			getQueueTaskTestAccess(task).abort = true
			return realSubmit(...args)
		})

		await expect(task.processQueuedMessages()).resolves.toBe(false)

		expect(task.messageQueueService.messages).toHaveLength(1)
		expect(task["askResponse"]).toBeUndefined()
	})

	it("does not submit queued messages once the task is abandoned", async () => {
		const task = await createTask({ getState: async () => ({}) })
		const submitSpy = vi.spyOn(task, "submitUserMessage")
		task.messageQueueService.addMessage("too late")
		getQueueTaskTestAccess(task).abandoned = true

		await expect(task.processQueuedMessages()).resolves.toBe(false)

		expect(submitSpy).not.toHaveBeenCalled()
		expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["too late"])
		expect(task["askResponse"]).toBeUndefined()
	})

	it("drops the drain quietly when abandonment lands mid-submission", async () => {
		const task = await createTask({ getState: async () => ({}) })
		task.messageQueueService.addMessage("too late")
		const realSubmit = task.submitUserMessage.bind(task)
		vi.spyOn(task, "submitUserMessage").mockImplementation((...args) => {
			getQueueTaskTestAccess(task).abandoned = true
			return realSubmit(...args)
		})

		await expect(task.processQueuedMessages()).resolves.toBe(false)

		expect(task.messageQueueService.messages).toHaveLength(1)
		expect(task["askResponse"]).toBeUndefined()
	})

	describe("sayUserFeedbackAndAckQueued", () => {
		it("delegates to the durable ack when a queued message was consumed", async () => {
			const task = await createTask()
			const persist = vi.spyOn(task, "persistQueuedFeedbackAndAcknowledge").mockResolvedValue(true)
			const say = vi.spyOn(task, "say")

			await task.sayUserFeedbackAndAckQueued("words", ["img.png"], "queued-1")

			expect(persist).toHaveBeenCalledExactlyOnceWith("queued-1", "words", ["img.png"])
			expect(say).not.toHaveBeenCalled()
		})

		it("throws when the durable ack fails", async () => {
			const task = await createTask()
			vi.spyOn(task, "persistQueuedFeedbackAndAcknowledge").mockResolvedValue(false)

			await expect(task.sayUserFeedbackAndAckQueued("words", undefined, "queued-1")).rejects.toThrow(
				"Failed to persist queued feedback queued-1",
			)
		})

		it("says user feedback without a queued message", async () => {
			const task = await createTask()
			const say = vi.spyOn(task, "say").mockResolvedValue(true)

			await task.sayUserFeedbackAndAckQueued("direct words", undefined, undefined)

			expect(say).toHaveBeenCalledExactlyOnceWith("user_feedback", "direct words", undefined)
		})

		it("skips saying when there is no feedback content and no queued message", async () => {
			const task = await createTask()
			const say = vi.spyOn(task, "say")

			await task.sayUserFeedbackAndAckQueued(undefined, undefined, undefined)

			expect(say).not.toHaveBeenCalled()
		})
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

	it("does not consume a message already queued before a command_output ask", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("queued before output")

		const askPromise = task.ask("command_output", "command is still running...", false)
		setTimeout(() => task.approveAsk(), 0)
		const result = await askPromise

		expect(result).toMatchObject({ response: "yesButtonClicked", text: undefined })
		expect(task.messageQueueService.messages).toHaveLength(1)
		expect(task.messageQueueService.claimNextMessage()?.text).toBe("queued before output")
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
		expect(task.messageQueueService.removeMessage(result.queuedMessageId!)).toBe(true)
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("does not consume a queued message as a tool approval; it stays queued for a conversational turn", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("Use this context")

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		await new Promise((resolve) => setTimeout(resolve, 150))
		// The conversational message must not approve the tool: the ask is
		// still blocked waiting for an explicit user response.
		let settled = false
		void askPromise.then(() => {
			settled = true
		})
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(settled).toBe(false)

		setTimeout(() => task.approveAsk(), 0)
		const result = await askPromise
		expect(result).toMatchObject({ response: "yesButtonClicked", text: undefined })
		// The message is retained for a conversational ask, not consumed here.
		expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["Use this context"])

		const nextResult = await task.ask("followup", "Q?", false)
		expect(nextResult).toMatchObject({ response: "messageResponse", text: "Use this context" })
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it.each([
		["command", "npm test"],
		["use_mcp_server", "{}"],
		["tool", "not-json"],
	] as const)("leaves queued conversational text out of %s approvals", async (type, text) => {
		const task = await createTask()
		task.messageQueueService.addMessage("Approval context")

		const askPromise = task.ask(type, text, false)
		await new Promise((resolve) => setTimeout(resolve, 150))
		let settled = false
		void askPromise.then(() => {
			settled = true
		})
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(settled).toBe(false)

		setTimeout(() => task.approveAsk(), 0)
		const result = await askPromise
		expect(result).toMatchObject({ response: "yesButtonClicked", text: undefined })
		expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["Approval context"])
	})

	it("never lets a drained queued message approve a later command ask", async () => {
		const task = await createTask({ getState: async () => ({}) }) // auto-approval disabled
		const submitSpy = vi.spyOn(task, "submitUserMessage")

		// The user queues conversational feedback while command A runs.
		task.messageQueueService.addMessage("also fix the tests")
		// Command A finishes: the drain submits the feedback (conversational
		// delivery) and retains the entry until an ask consumes it.
		await expect(task.processQueuedMessages()).resolves.toBe(true)
		expect(submitSpy).toHaveBeenCalledTimes(1)

		// The model now requests command B. The retained entry must not be
		// claimed as an approval: the ask keeps waiting for the user.
		const askPromise = task.ask("command", "git push --force", false)
		let settled = false
		void askPromise.then(() => {
			settled = true
		})
		await new Promise((resolve) => setTimeout(resolve, 200))
		expect(settled).toBe(false)

		// Explicit approval executes B; the feedback is still delivered later.
		setTimeout(() => task.approveAsk(), 0)
		const result = await askPromise
		expect(result).toMatchObject({ response: "yesButtonClicked", text: undefined })
		expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["also fix the tests"])

		const followup = await task.ask("followup", "anything else?", false)
		expect(followup).toMatchObject({ response: "messageResponse", text: "also fix the tests" })
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("claims lifecycle feedback that arrives while an ask is waiting", async () => {
		const task = await createTask()
		const ask = task.ask("tool", JSON.stringify({ tool: "finishTask" }), false)
		task.messageQueueService.addMessage("Late feedback")

		const result = await ask

		expect(result).toMatchObject({ response: "messageResponse", text: "Late feedback" })
		expect(result.queuedMessageId).toBe(task.messageQueueService.messages[0]?.id)
		expect(task.messageQueueService.claimNextMessage()).toBeUndefined()
	})

	it("uses queued feedback instead of accepting a completion result", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("One more change")

		const result = await task.ask("completion_result", "Done", false)

		expect(result).toMatchObject({ response: "messageResponse", text: "One more change" })
		expect(task.messageQueueService.isEmpty()).toBe(false)
		task.messageQueueService.removeMessage(result.queuedMessageId!)
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("retains lifecycle feedback until its history write succeeds", async () => {
		vi.useFakeTimers()
		try {
			const task = await createTask()
			task.messageQueueService.addMessage("Keep this message")
			const result = await task.ask("tool", JSON.stringify({ tool: "finishTask" }), false)
			const saveClineMessages = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
			const taskAccess = getQueueTaskTestAccess(task)
			taskAccess.say = vi.fn().mockResolvedValue(undefined)
			taskAccess.saveClineMessages = saveClineMessages

			const persistence = task.persistQueuedFeedbackAndAcknowledge(
				result.queuedMessageId!,
				result.text,
				result.images,
			)
			await vi.advanceTimersByTimeAsync(0)
			expect(task.messageQueueService.isEmpty()).toBe(false)
			expect(task.messageQueueService.claimNextMessage()).toBeUndefined()

			await vi.advanceTimersByTimeAsync(250)
			expect(await persistence).toBe(true)
			expect(task.messageQueueService.isEmpty()).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	it("retries a failed feedback write without duplicating the history row", async () => {
		vi.useFakeTimers()
		try {
			const task = await createTask()
			task.messageQueueService.addMessage("Retry feedback")
			const result = await task.ask("tool", JSON.stringify({ tool: "finishTask" }), false)
			const saveClineMessages = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
			const taskAccess = getQueueTaskTestAccess(task)
			const addToClineMessages = vi.fn(async (message?: ClineMessage) => {
				taskAccess.clineMessages.push(message!)
				return true
			})
			taskAccess.addToClineMessages = addToClineMessages
			taskAccess.saveClineMessages = saveClineMessages

			const persistence = task.persistQueuedFeedbackAndAcknowledge(
				result.queuedMessageId!,
				result.text,
				result.images,
			)
			await vi.advanceTimersByTimeAsync(250)
			await persistence

			expect(addToClineMessages).toHaveBeenCalledTimes(1)
			expect(saveClineMessages).toHaveBeenCalledTimes(2)
			expect(taskAccess.clineMessages.filter((message) => message.say === "user_feedback")).toHaveLength(1)
			expect(task.messageQueueService.isEmpty()).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	it("releases durable queued feedback when its ask is superseded", async () => {
		const task = await createTask()
		let finishAddingAsk!: () => void
		const addingAsk = new Promise<void>((resolve) => {
			finishAddingAsk = resolve
		})
		const access = getQueueTaskTestAccess(task)
		access.addToClineMessages = vi.fn(() => addingAsk.then(() => true))
		task.messageQueueService.addMessage("Still durable")
		const ask = task.ask("tool", JSON.stringify({ tool: "finishTask" }), false)
		await Promise.resolve()
		access.lastMessageTs = Date.now() + 1
		finishAddingAsk()

		await expect(ask).rejects.toThrow("superseded")
		expect(task.messageQueueService.messages).toHaveLength(1)
		expect(task.messageQueueService.claimNextMessage()?.text).toBe("Still durable")
	})

	it("releases durable queued feedback when its ask is aborted", async () => {
		const task = await createTask()
		let finishAddingAsk!: () => void
		const addingAsk = new Promise<void>((resolve) => {
			finishAddingAsk = resolve
		})
		const access = getQueueTaskTestAccess(task)
		access.addToClineMessages = vi.fn(() => addingAsk.then(() => true))
		task.messageQueueService.addMessage("Persist me later")
		const ask = task.ask("completion_result", "Done", false)
		await Promise.resolve()
		access.abort = true
		finishAddingAsk()

		await expect(ask).rejects.toThrow("aborted")
		expect(task.messageQueueService.messages).toHaveLength(1)
		expect(task.messageQueueService.claimNextMessage()?.text).toBe("Persist me later")
	})

	it("bounds durable feedback retries and releases the claim after persistent failure", async () => {
		vi.useFakeTimers()
		try {
			const task = await createTask()
			task.messageQueueService.addMessage("Do not spin")
			const result = await task.ask("completion_result", "Done", false)
			const access = getQueueTaskTestAccess(task)
			access.say = vi.fn().mockResolvedValue(undefined)
			access.saveClineMessages = vi.fn().mockResolvedValue(false)

			const persistence = task.persistQueuedFeedbackAndAcknowledge(
				result.queuedMessageId!,
				result.text,
				result.images,
			)
			await vi.runAllTimersAsync()

			await expect(persistence).resolves.toBe(false)
			expect(access.saveClineMessages).toHaveBeenCalledTimes(4)
			expect(task.messageQueueService.messages).toHaveLength(1)
			expect(task.messageQueueService.claimNextMessage()?.text).toBe("Do not spin")
		} finally {
			vi.useRealTimers()
		}
	})

	it("releases durable queued feedback when the task aborts during retry backoff", async () => {
		vi.useFakeTimers()
		try {
			const task = await createTask()
			task.messageQueueService.addMessage("Retry after abort")
			const result = await task.ask("completion_result", "Done", false)
			const access = getQueueTaskTestAccess(task)
			access.say = vi.fn().mockResolvedValue(undefined)
			access.saveClineMessages = vi.fn().mockResolvedValue(false)

			const persistence = task.persistQueuedFeedbackAndAcknowledge(
				result.queuedMessageId!,
				result.text,
				result.images,
			)
			await vi.advanceTimersByTimeAsync(0)
			expect(access.saveClineMessages).toHaveBeenCalledTimes(1)

			access.abort = true
			await vi.advanceTimersByTimeAsync(250)

			await expect(persistence).resolves.toBe(false)
			expect(access.saveClineMessages).toHaveBeenCalledTimes(1)
			expect(task.messageQueueService.messages).toHaveLength(1)
			expect(task.messageQueueService.claimNextMessage()?.text).toBe("Retry after abort")
		} finally {
			vi.useRealTimers()
		}
	})
})
