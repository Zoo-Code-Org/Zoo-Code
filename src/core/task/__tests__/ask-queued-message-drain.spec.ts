import { Task } from "../Task"
import { setAbortLatch } from "../../../test-utils/run-state"

type QueueTaskTestAccess = {
	say: Task["say"]
	saveClineMessages: () => Promise<boolean>
	addToClineMessages: () => Promise<void>
	lastMessageTs?: number
}

const getQueueTaskTestAccess = (task: Task) => task as unknown as QueueTaskTestAccess

// Keep this test focused: if a queued message arrives while Task.ask() is blocked,
// it should be consumed and used to fulfill the ask.

describe("Task.ask queued message drain", () => {
	function createTask(provider?: { getState: () => Promise<Record<string, boolean>> }) {
		// Distinct task and instance ids, so an abort assertion can name this task instead of
		// accepting whatever the fixture left unset.
		const task = Object.create(Task.prototype, {
			taskId: { value: "task-ask-drain", enumerable: true },
			instanceId: { value: "instance-ask-drain", enumerable: true },
		}) as Task
		setAbortLatch(task, false)
		;(task as any).clineMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined
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

	// Mirrors the release protocol in condenseContextWithLease's finally: clear
	// the field, then settle the promise it handed to waiters.
	function installCondenseBarrier(task: Task): () => void {
		let settle!: () => void
		task["condenseHistoryBarrier"] = new Promise<void>((resolve) => {
			settle = resolve
		})
		return () => {
			task["condenseHistoryBarrier"] = undefined
			settle()
		}
	}

	it("holds the queued-message drain while a condense holds the history", async () => {
		const task = await createTask()

		// Stand in for condenseContextWithLease summarizing: it replaces the API
		// history from a pre-condense snapshot, so the drain must not claim a
		// queued message whose follow-up request would append turns the summary
		// overwrites.
		const releaseBarrier = installCondenseBarrier(task)
		task.messageQueueService.addMessage("picked answer")

		const askPromise = task.ask("followup", "Q?", false)

		const premature = await Promise.race([
			askPromise,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
		])
		expect(premature).toBe("pending")
		// Not even claimed: the message is intact for the post-settle drain.
		expect(task.messageQueueService.messages[0]?.text).toBe("picked answer")
		expect(task.messageQueueService.hasUnclaimed()).toBe(true)

		releaseBarrier()
		const result = await askPromise
		expect(result).toMatchObject({ response: "messageResponse", text: "picked answer" })
	})

	it("holds a direct ask response while a condense holds the history", async () => {
		const task = await createTask()

		const releaseBarrier = installCondenseBarrier(task)

		const askPromise = task.ask("followup", "Q?", false)

		// The user resumes mid-summarize once the ask is waiting (the same
		// deferred-delivery timing the other tests use). The response lands but
		// stays pending: delivering it would let the follow-up request append
		// turns the in-flight summary then overwrites.
		await new Promise((resolve) => setTimeout(resolve, 50))
		task.handleWebviewAskResponse("messageResponse", "answered mid-condense")

		const premature = await Promise.race([
			askPromise,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
		])
		expect(premature).toBe("pending")
		// The response did land — only its delivery is held.
		expect(task["askResponse"]).toBe("messageResponse")

		releaseBarrier()
		const result = await askPromise
		expect(result).toMatchObject({ response: "messageResponse", text: "answered mid-condense" })
	})

	it("delivers a held direct response instead of draining a queued message", async () => {
		const task = await createTask()

		const releaseBarrier = installCondenseBarrier(task)
		// A queued message lands while the condense holds the history.
		task.messageQueueService.addMessage("queued while condensing")

		const askPromise = task.ask("followup", "Q?", false)

		// The user resumes directly mid-summarize. The drain gate must prefer
		// the landed response: claiming the queued message now would overwrite
		// the pending direct response the user is waiting on.
		await new Promise((resolve) => setTimeout(resolve, 50))
		task.handleWebviewAskResponse("messageResponse", "answered mid-condense")

		const premature = await Promise.race([
			askPromise,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
		])
		expect(premature).toBe("pending")
		expect(task["askResponse"]).toBe("messageResponse")

		releaseBarrier()
		const result = await askPromise
		// The direct response wins the ask...
		expect(result).toMatchObject({ response: "messageResponse", text: "answered mid-condense" })
		// ...and the queued message survives unclaimed for a later turn.
		expect(task.messageQueueService.claimNextMessage()?.text).toBe("queued while condensing")
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
		setAbortLatch(task, true)
		finishAddingAsk()

		// The abort must name this task and this instance: a regex that accepts any id would also
		// pass for another task's abort or a different prefix.
		await expect(ask).rejects.toMatchObject({
			message: `[ZooCode#ask] task ${task.taskId}.${task.instanceId} aborted`,
		})
		await expect(ask).rejects.toMatchObject({
			message: "[ZooCode#ask] task task-ask-drain.instance-ask-drain aborted",
		})
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

			setAbortLatch(task, true)
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
