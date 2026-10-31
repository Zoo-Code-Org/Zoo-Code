import { Task } from "../Task"

type QueueTaskTestAccess = {
	say: Task["say"]
	saveClineMessages: () => Promise<boolean>
	addToClineMessages: (message: import("@roo-code/types").ClineMessage) => Promise<void>
	lastMessageTs?: number
	abort: boolean
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
		task["pendingAskCount"] = 0
		task["drainRetainedQueuedMessageIds"] = new Set<string>()
		task["queuedFeedbackRowWritten"] = new Map<string, string>()
		return import("../../message-queue/MessageQueueService").then(({ MessageQueueService }) => {
			;(task as any).messageQueueService = new MessageQueueService()
			// Mirrors the real `addToClineMessages`: it stamps a messageId and pushes
			// synchronously before its own awaits, and the tests here depend on both.
			;(task as any).addToClineMessages = vi.fn(async (message: import("@roo-code/types").ClineMessage) => {
				message.messageId ??= crypto.randomUUID()
				task["clineMessages"].push(message)
			})
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

	it("does not auto-approve a protected command ask from a queued message", async () => {
		const task = await createTask({
			getState: async () => ({ autoApprovalEnabled: true, alwaysAllowExecute: true }),
		})
		task.messageQueueService.addMessage("run it anyway")

		const ask = task.ask("command", "rm -rf build", false, undefined, true)

		// The drain must not resolve the protected ask; only an explicit user
		// approval may.
		const premature = await Promise.race([
			ask,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
		])
		expect(premature).toBe("pending")
		expect(task.messageQueueService.isEmpty()).toBe(false)

		task.approveAsk()
		const result = await ask
		expect(result).toMatchObject({ response: "yesButtonClicked", text: undefined })
		// claimNextMessage only returns unclaimed messages: the queued message must
		// still be present and unclaimed after the protected ask resolved.
		expect(task.messageQueueService.claimNextMessage()?.text).toBe("run it anyway")
	})

	it("does not auto-approve a protected command ask when a message is queued mid-wait", async () => {
		const task = await createTask({
			getState: async () => ({ autoApprovalEnabled: true, alwaysAllowExecute: true }),
		})

		const ask = task.ask("command", "rm -rf build", false, undefined, true)
		task.messageQueueService.addMessage("mid-wait message")

		const premature = await Promise.race([
			ask,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
		])
		expect(premature).toBe("pending")
		expect(task.messageQueueService.isEmpty()).toBe(false)

		task.approveAsk()
		const result = await ask
		expect(result).toMatchObject({ response: "yesButtonClicked", text: undefined })
		// claimNextMessage only returns unclaimed messages: the queued message must
		// still be present and unclaimed after the protected ask resolved.
		expect(task.messageQueueService.claimNextMessage()?.text).toBe("mid-wait message")
	})

	// The drain guards key on the isProtected flag, so they also cover protected
	// write-tool asks (WriteToFileTool/EditTool/ApplyDiff/ApplyPatch mark blocked
	// writes protected via presentAssistantMessage). These mirror the command pair
	// above: alwaysAllowWrite covers the write, but without alwaysAllowWriteProtected
	// the protection keeps the ask pending, and a queued message must not stand in
	// for the explicit approval.
	it("does not auto-approve a protected write-tool ask from a queued message", async () => {
		const task = await createTask({
			getState: async () => ({ autoApprovalEnabled: true, alwaysAllowWrite: true }),
		})
		task.messageQueueService.addMessage("write it anyway")

		const ask = task.ask(
			"tool",
			JSON.stringify({ tool: "newFileCreated", path: "AGENTS.md" }),
			false,
			undefined,
			true,
		)

		// The drain must not resolve the protected ask; only an explicit user
		// approval may.
		const premature = await Promise.race([
			ask,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
		])
		expect(premature).toBe("pending")
		expect(task.messageQueueService.isEmpty()).toBe(false)

		task.approveAsk()
		const result = await ask
		expect(result).toMatchObject({ response: "yesButtonClicked", text: undefined })
		// claimNextMessage only returns unclaimed messages: the queued message must
		// still be present and unclaimed after the protected ask resolved.
		expect(task.messageQueueService.claimNextMessage()?.text).toBe("write it anyway")
	})

	it("does not auto-approve a protected write-tool ask when a message is queued mid-wait", async () => {
		const task = await createTask({
			getState: async () => ({ autoApprovalEnabled: true, alwaysAllowWrite: true }),
		})

		const ask = task.ask(
			"tool",
			JSON.stringify({ tool: "newFileCreated", path: "AGENTS.md" }),
			false,
			undefined,
			true,
		)
		task.messageQueueService.addMessage("mid-wait message")

		const premature = await Promise.race([
			ask,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
		])
		expect(premature).toBe("pending")
		expect(task.messageQueueService.isEmpty()).toBe(false)

		task.approveAsk()
		const result = await ask
		expect(result).toMatchObject({ response: "yesButtonClicked", text: undefined })
		// claimNextMessage only returns unclaimed messages: the queued message must
		// still be present and unclaimed after the protected ask resolved.
		expect(task.messageQueueService.claimNextMessage()?.text).toBe("mid-wait message")
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
			const say = vi.fn().mockResolvedValue(undefined)
			const taskAccess = getQueueTaskTestAccess(task)
			taskAccess.say = say
			taskAccess.saveClineMessages = saveClineMessages

			const persistence = task.persistQueuedFeedbackAndAcknowledge(
				result.queuedMessageId!,
				result.text,
				result.images,
			)
			await vi.advanceTimersByTimeAsync(250)
			await persistence

			expect(say).toHaveBeenCalledTimes(1)
			expect(saveClineMessages).toHaveBeenCalledTimes(2)
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
		access.addToClineMessages = vi.fn(() => addingAsk)
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
		access.addToClineMessages = vi.fn(() => addingAsk)
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

	it("keeps failed durable feedback out of the next command ask", async () => {
		const task = await createTask()
		// A drain submitted this message, so it is retained while it waits for a
		// conversational ask to consume it.
		task["drainRetainedQueuedMessageIds"].add(task.messageQueueService.addMessage("ship it")!.id)
		const result = await task.ask("tool", JSON.stringify({ tool: "finishTask" }), false)
		const access = getQueueTaskTestAccess(task)
		access.say = vi.fn().mockResolvedValue(undefined)
		access.saveClineMessages = vi.fn().mockResolvedValue(false)

		vi.useFakeTimers()
		try {
			const persistence = task.persistQueuedFeedbackAndAcknowledge(
				result.queuedMessageId!,
				result.text,
				result.images,
			)
			await vi.runAllTimersAsync()
			await expect(persistence).resolves.toBe(false)
		} finally {
			vi.useRealTimers()
		}

		// The consume was undone, so the message must stay retained: a command
		// ask that claimed it would skip checkAutoApproval and execute on text
		// never answered to that command.
		expect(task["drainRetainedQueuedMessageIds"].has(result.queuedMessageId!)).toBe(true)
		expect(task.messageQueueService.claimNextMessage(task["drainRetainedQueuedMessageIds"])).toBeUndefined()

		// A command ask gets a real prompt and leaves the message queued.
		const commandAsk = task.ask("command", "rm -rf build", false)
		setTimeout(() => task.denyAsk(), 0)
		const denied = await commandAsk
		expect(denied).toMatchObject({ response: "noButtonClicked" })
		expect(denied.queuedMessageId).toBeUndefined()
		expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["ship it"])
	})

	it("reports success when the durable save lands but the queue entry is gone", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("Deleted mid-ack")
		const result = await task.ask("completion_result", "Done", false)
		const access = getQueueTaskTestAccess(task)
		access.say = vi.fn().mockResolvedValue(undefined)
		access.saveClineMessages = vi.fn().mockResolvedValue(true)
		// The user removed the entry from the webview while the ack was in flight.
		task.messageQueueService.removeMessage(result.queuedMessageId!)

		await expect(
			task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).resolves.toBe(true)
		expect(task["drainRetainedQueuedMessageIds"].size).toBe(0)
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

	it("does not append a second user_feedback row when a reclaimed message is persisted again", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("Persist me twice")
		const result = await task.ask("completion_result", "Done", false)
		const access = getQueueTaskTestAccess(task)
		const rowsBefore = task["clineMessages"].length

		// First attempt appends the row, then fails every save and releases the
		// claim, so the message is reclaimed as fresh input for a later turn.
		access.saveClineMessages = vi.fn().mockResolvedValue(false)
		vi.useFakeTimers()
		try {
			const first = task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images)
			await vi.runAllTimersAsync()
			await expect(first).resolves.toBe(false)
		} finally {
			vi.useRealTimers()
		}
		expect(task["clineMessages"]).toHaveLength(rowsBefore + 1)

		// The retry succeeds, but the row it would append is already in history.
		access.saveClineMessages = vi.fn().mockResolvedValue(true)
		await expect(
			task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).resolves.toBe(true)
		expect(task["clineMessages"]).toHaveLength(rowsBefore + 1)
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("keeps a message reclaimable and appends once when say throws before the row lands", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("Row never landed")
		const result = await task.ask("completion_result", "Done", false)
		const access = getQueueTaskTestAccess(task)
		access.saveClineMessages = vi.fn().mockResolvedValue(true)
		// The ask above left its own row; only rows added from here count.
		const rowsBefore = task["clineMessages"].length

		// The real `say` guard rejects before `addToClineMessages` runs, so no row
		// exists and the message must stay reclaimable.
		access.abort = true
		await expect(
			task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).rejects.toThrow("aborted")
		expect(task["clineMessages"]).toHaveLength(rowsBefore)
		expect(task.messageQueueService.messages.map((message) => message.text)).toEqual(["Row never landed"])
		// Released, not left claimed: a later consumer can still claim it.
		expect(task.messageQueueService.claimNextMessage()?.text).toBe("Row never landed")
		task.messageQueueService.releaseMessage(result.queuedMessageId!)

		// A later reclaim appends exactly one row, because the failed attempt left
		// no record behind.
		access.abort = false
		await expect(
			task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).resolves.toBe(true)
		expect(task["clineMessages"]).toHaveLength(rowsBefore + 1)
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("re-appends the row when a rewind removed it before the reclaim", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("Rewound row")
		const result = await task.ask("completion_result", "Done", false)
		const access = getQueueTaskTestAccess(task)
		access.saveClineMessages = vi.fn().mockResolvedValue(false)
		const feedbackRows = () => task["clineMessages"].filter((message) => message.say === "user_feedback")

		// The row lands, then every save fails and the claim is released.
		vi.useFakeTimers()
		try {
			const first = task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images)
			await vi.runAllTimersAsync()
			await expect(first).resolves.toBe(false)
		} finally {
			vi.useRealTimers()
		}
		expect(feedbackRows()).toHaveLength(1)

		// A rewind truncates the conversation, so the recorded row is gone while
		// the message is still queued and reclaimable.
		task["clineMessages"] = task["clineMessages"].filter((message) => message.say !== "user_feedback")
		expect(feedbackRows()).toHaveLength(0)

		// The reclaim must re-append: consuming without the row would drop the
		// feedback from the conversation entirely.
		access.saveClineMessages = vi.fn().mockResolvedValue(true)
		await expect(
			task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).resolves.toBe(true)
		expect(feedbackRows()).toHaveLength(1)
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("keys the row record by message id, not by timestamp", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("Same millisecond")
		const result = await task.ask("completion_result", "Done", false)
		const access = getQueueTaskTestAccess(task)
		access.saveClineMessages = vi.fn().mockResolvedValue(false)
		const feedbackRows = () => task["clineMessages"].filter((message) => message.say === "user_feedback")

		vi.useFakeTimers()
		try {
			const first = task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images)
			await vi.runAllTimersAsync()
			await expect(first).resolves.toBe(false)
		} finally {
			vi.useRealTimers()
		}
		expect(feedbackRows()).toHaveLength(1)

		// A rewind drops the feedback row but leaves a different row carrying the
		// same `ts`: `say` stamps `Date.now()`, so two rows written in the same
		// millisecond collide. Keying the record by `ts` would read this survivor as
		// the feedback row and skip the re-append, dropping the text entirely.
		const feedbackTs = feedbackRows()[0]!.ts
		task["clineMessages"] = task["clineMessages"].filter((message) => message.say !== "user_feedback")
		task["clineMessages"].push({ ts: feedbackTs, type: "say", say: "text", text: "Unrelated row" })
		expect(feedbackRows()).toHaveLength(0)

		access.saveClineMessages = vi.fn().mockResolvedValue(true)
		await expect(
			task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).resolves.toBe(true)
		expect(feedbackRows()).toHaveLength(1)
		expect(feedbackRows()[0]!.text).toBe("Same millisecond")
	})

	it("does not double-append when say throws after the row landed", async () => {
		const task = await createTask()
		task.messageQueueService.addMessage("Row landed then threw")
		const result = await task.ask("completion_result", "Done", false)
		const access = getQueueTaskTestAccess(task)
		access.saveClineMessages = vi.fn().mockResolvedValue(true)
		const rowsBefore = task["clineMessages"].length
		// The row is pushed the way `addToClineMessages` pushes it (synchronously,
		// before its own awaits), then the call rejects the way a throwing
		// `Message` listener makes `say` reject.
		access.addToClineMessages = vi.fn(async (message: import("@roo-code/types").ClineMessage) => {
			message.messageId ??= crypto.randomUUID()
			task["clineMessages"].push(message)
			throw new Error("listener threw")
		})

		await expect(
			task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).rejects.toThrow("listener threw")
		expect(task["clineMessages"]).toHaveLength(rowsBefore + 1)

		// The row is retained in history, so the reclaim must not append a second
		// one, and the release must leave the message reclaimable rather than
		// leaked as claimed.
		await expect(
			task.persistQueuedFeedbackAndAcknowledge(result.queuedMessageId!, result.text, result.images),
		).resolves.toBe(true)
		expect(task["clineMessages"]).toHaveLength(rowsBefore + 1)
		expect(task.messageQueueService.isEmpty()).toBe(true)
		expect(task["drainRetainedQueuedMessageIds"].size).toBe(0)
	})
})
