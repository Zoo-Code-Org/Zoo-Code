import { RooCodeEventName } from "@roo-code/types"

import { Task } from "../Task"

type QueueTaskTestAccess = {
	say: Task["say"]
	saveClineMessages: () => Promise<boolean>
	addToClineMessages: (message?: unknown) => Promise<void>
	clineMessages: unknown[]
	taskId: string
	emit: (event: string, ...args: unknown[]) => boolean
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

	describe("API-origin queued input", () => {
		it.each([
			["command", "npm publish"],
			["use_mcp_server", '{"server_name":"fs","tool_name":"write_file"}'],
			["tool", JSON.stringify({ tool: "readFile", path: "src/a.ts" })],
			["tool", "not-json"],
		] as const)(
			"does not approve a protected %s ask from API-origin input queued before the ask",
			async (type, text) => {
				const task = await createTask()
				task.messageQueueService.addMessage("Steer the next turn", undefined, { origin: "api" })

				const askPromise = task.ask(type, text, false)
				setTimeout(() => task.denyAsk(), 0)
				const result = await askPromise

				expect(result.response).not.toBe("yesButtonClicked")
				expect(result.response).toBe("noButtonClicked")
				expect(task.messageQueueService.messages).toHaveLength(1)
				expect(task.messageQueueService.claimNextMessage()?.text).toBe("Steer the next turn")
			},
		)

		it("does not approve a protected ask from API-origin input arriving while the ask waits", async () => {
			const task = await createTask()
			const askPromise = task.ask("command", "npm publish", false)
			await vi.waitFor(() => expect(getQueueTaskTestAccess(task).lastMessageTs).toBeDefined())

			task.messageQueueService.addMessage("Late steering", undefined, { origin: "api" })
			setTimeout(() => task.denyAsk(), 150)
			const result = await askPromise

			expect(result.response).toBe("noButtonClicked")
			expect(task.messageQueueService.messages).toHaveLength(1)
			expect(task.messageQueueService.claimNextMessage()?.text).toBe("Late steering")
		})

		it("still answers conversational asks from API-origin input", async () => {
			const task = await createTask()
			task.messageQueueService.addMessage("Use the queue module", undefined, { origin: "api" })

			const result = await task.ask("followup", "Where should this go?", false)

			expect(result).toMatchObject({ response: "messageResponse", text: "Use the queue module" })
			expect(task.messageQueueService.isEmpty()).toBe(true)
		})

		it("emits TaskInteractive after the status delay when API-origin input cannot answer a protected ask", async () => {
			vi.useFakeTimers()
			try {
				const task = await createTask()
				const access = getQueueTaskTestAccess(task)
				const taskId = "status-regression"
				access.taskId = taskId
				access.addToClineMessages = vi.fn(async (message: unknown) => {
					access.clineMessages.push(message)
				})
				const emit = access.emit
				task.messageQueueService.addMessage("Steer the next turn", undefined, { origin: "api" })

				const askPromise = task.ask("command", "npm publish", false)
				await vi.advanceTimersByTimeAsync(2_000)

				expect(emit).toHaveBeenCalledTimes(1)
				expect(emit).toHaveBeenCalledWith(RooCodeEventName.TaskInteractive, taskId)
				expect(task.messageQueueService.messages).toMatchObject([
					{ text: "Steer the next turn", origin: "api" },
				])

				task.denyAsk()
				await vi.advanceTimersByTimeAsync(1_000)
				const result = await askPromise

				expect(result.response).toBe("noButtonClicked")
				expect(result.text).toBeUndefined()
				expect(task.messageQueueService.messages).toMatchObject([
					{ text: "Steer the next turn", origin: "api" },
				])
			} finally {
				vi.useRealTimers()
			}
		})

		it("emits TaskInteractive when API-origin input precedes a webview message that could answer", async () => {
			vi.useFakeTimers()
			try {
				const task = await createTask()
				const access = getQueueTaskTestAccess(task)
				const taskId = "status-regression-fifo"
				access.taskId = taskId
				access.addToClineMessages = vi.fn(async (message: unknown) => {
					access.clineMessages.push(message)
				})
				const emit = access.emit
				task.messageQueueService.addMessage("Steer the next turn", undefined, { origin: "api" })
				task.messageQueueService.addMessage("Approve this one")

				const askPromise = task.ask("command", "npm publish", false)
				await vi.advanceTimersByTimeAsync(2_000)

				expect(emit).toHaveBeenCalledWith(RooCodeEventName.TaskInteractive, taskId)

				task.denyAsk()
				await vi.advanceTimersByTimeAsync(1_000)
				const result = await askPromise

				expect(result.response).toBe("noButtonClicked")
				expect(task.messageQueueService.messages.map((message) => message.text)).toEqual([
					"Steer the next turn",
					"Approve this one",
				])
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not emit TaskInteractive when webview-origin input answers the protected ask", async () => {
			const task = await createTask()
			const access = getQueueTaskTestAccess(task)
			const taskId = "status-drained"
			access.taskId = taskId
			const emit = access.emit
			task.messageQueueService.addMessage("Approval context")

			const result = await task.ask("command", "npm publish", false)

			expect(result).toMatchObject({ response: "yesButtonClicked", text: "Approval context" })
			expect(task.messageQueueService.isEmpty()).toBe(true)
			expect(emit).not.toHaveBeenCalledWith(RooCodeEventName.TaskInteractive, taskId)
		})

		it.each([
			["resume_task", RooCodeEventName.TaskResumable],
			["completion_result", RooCodeEventName.TaskIdle],
		] as const)(
			"still answers %s from API-origin input without emitting its status event",
			async (type, statusEvent) => {
				const task = await createTask()
				const access = getQueueTaskTestAccess(task)
				const taskId = "status-mapping"
				access.taskId = taskId
				const emit = access.emit
				task.messageQueueService.addMessage("Continue with this", undefined, { origin: "api" })

				const result = await task.ask(type, "Done", false)

				expect(result).toMatchObject({ response: "messageResponse", text: "Continue with this" })
				expect(emit).not.toHaveBeenCalledWith(statusEvent, taskId)
				if (result.queuedMessageId) {
					task.messageQueueService.removeMessage(result.queuedMessageId)
				}
				expect(task.messageQueueService.isEmpty()).toBe(true)
			},
		)
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
