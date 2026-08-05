import { Task } from "../Task"

// When the backend auto-resolves an interactive ask, isAnswered:true is stamped
// on the ClineMessage before it is added so the webview state snapshot already
// carries the resolved flag. This eliminates the race between showing approval
// buttons and the former separate clearApprovalButtons message.

type ProviderStub = {
	getState: () => Promise<any>
	postMessageToWebview: ReturnType<typeof vi.fn>
	handleModeSwitch?: ReturnType<typeof vi.fn>
	resolveTaskRunOverrides?: ReturnType<typeof vi.fn>
}

function buildTask(provider: ProviderStub | undefined) {
	const task = Object.create(Task.prototype) as Task
	;(task as any).abort = false
	;(task as any).clineMessages = []
	;(task as any).askResponse = undefined
	;(task as any).askResponseText = undefined
	;(task as any).askResponseImages = undefined
	;(task as any).lastMessageTs = undefined
	;(task as any).addToClineMessages = vi.fn(async () => {})
	;(task as any).saveClineMessages = vi.fn(async () => {})
	;(task as any).updateClineMessage = vi.fn(async () => {})
	;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
	;(task as any).checkpointSave = vi.fn(async () => {})
	;(task as any).emit = vi.fn()
	;(task as any).providerRef = { deref: () => provider }

	return task
}

async function attachQueue(task: Task) {
	const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
	;(task as any).messageQueueService = new MessageQueueService()
}

describe("Task.ask auto-approval stamping", () => {
	it("switches persistent and isolated task modes through their respective paths", async () => {
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const resolveTaskRunOverrides = vi.fn().mockResolvedValue({
			apiConfiguration: { apiProvider: "openrouter", openRouterModelId: "new-model" },
			profile: "ci",
		})
		const provider = {
			postMessageToWebview: vi.fn(),
			getState: async () => ({ mode: "code" }),
			handleModeSwitch,
			resolveTaskRunOverrides,
		}
		const task = buildTask(provider)
		Object.defineProperties(task, {
			taskId: { value: "task-1" },
			isolateRunConfiguration: { value: false, configurable: true },
			runOverrides: { value: { provider: "openrouter", model: "old-model", approval: "safe" } },
		})

		await task.switchMode("debug")
		expect(handleModeSwitch).toHaveBeenCalledWith("debug")

		Object.defineProperty(task, "isolateRunConfiguration", { value: true })
		task["apiConfiguration"] = { apiProvider: "openrouter", openRouterModelId: "old-model" }
		task["updateApiConfiguration"] = vi.fn()
		await task.switchMode("architect")

		expect(resolveTaskRunOverrides).toHaveBeenCalledWith(
			{ provider: "openrouter", model: "old-model", approval: "safe", mode: "architect" },
			{ apiProvider: "openrouter", openRouterModelId: "old-model" },
		)
		expect(task["updateApiConfiguration"]).toHaveBeenCalledWith({
			apiProvider: "openrouter",
			openRouterModelId: "new-model",
		})
		expect(task.taskMode).toBe("architect")
	})

	it("returns an independent delegated override set", () => {
		const task = buildTask(undefined)
		Object.defineProperty(task, "runOverrides", {
			value: { provider: "openrouter", model: "model-1", mode: "code", approval: "safe" },
		})

		const delegated = task.getDelegatedRunOverrides("debug")
		expect(delegated).toEqual({ provider: "openrouter", model: "model-1", mode: "debug", approval: "safe" })
		if (delegated) delegated.model = "changed"
		expect(task.getDelegatedRunOverrides("debug")?.model).toBe("model-1")

		const plainTask = buildTask(undefined)
		expect(plainTask.getDelegatedRunOverrides("debug")).toBeUndefined()
	})

	it.each([
		["interactive", { autoApprovalEnabled: false }],
		["safe", { autoApprovalEnabled: true, alwaysAllowReadOnly: true, alwaysAllowExecute: false }],
		["auto", { autoApprovalEnabled: true, alwaysAllowWrite: true, allowedCommands: ["*"] }],
	] as const)("applies the %s isolated approval policy", async (approval, expected) => {
		const task = buildTask({ postMessageToWebview: vi.fn(), getState: async () => ({ mode: "code" }) })
		Object.defineProperties(task, {
			isolateRunConfiguration: { value: true },
			runApprovalMode: { value: approval },
		})
		task["apiConfiguration"] = { apiProvider: "anthropic" }
		task.getTaskMode = vi.fn().mockResolvedValue("code")

		await expect(task["getEffectiveState"]()).resolves.toMatchObject(expected)
	})

	it("accepts a response only for the exact pending headless ask", () => {
		const task = buildTask(undefined)
		const handleWebviewAskResponse = vi.fn()
		task["pendingHeadlessAskId"] = 42
		task["handleWebviewAskResponse"] = handleWebviewAskResponse

		expect(task.pendingAskId).toBe(42)
		expect(task.respondToAsk(41, "messageResponse", "wrong")).toBe(false)
		expect(task.pendingAskId).toBe(42)
		expect(task.respondToAsk(42, "messageResponse", "answer", ["image"])).toBe(true)
		expect(handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "answer", ["image"])
		expect(task.pendingAskId).toBeUndefined()
		expect(task.respondToAsk(42, "messageResponse")).toBe(false)
	})

	it("stamps isAnswered:true on the message when a command ask is auto-approved", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const provider: ProviderStub = {
			postMessageToWebview,
			getState: async () => ({
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["echo"],
				deniedCommands: [],
			}),
		}

		const task = buildTask(provider)
		await attachQueue(task)

		const result = await task.ask("command", "echo hi", false)

		expect(result.response).toBe("yesButtonClicked")
		// The message must carry isAnswered:true so the webview never shows buttons.
		const addCall = (task as any).addToClineMessages.mock.calls[0][0]
		expect(addCall.isAnswered).toBe(true)
		// clearApprovalButtons is no longer sent as a separate message.
		expect(postMessageToWebview).not.toHaveBeenCalledWith({ type: "clearApprovalButtons" })
	})

	it("stamps isAnswered:true on the message when a command ask is auto-denied", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const provider: ProviderStub = {
			postMessageToWebview,
			getState: async () => ({
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: [],
				deniedCommands: ["echo"],
			}),
		}

		const task = buildTask(provider)
		await attachQueue(task)

		const result = await task.ask("command", "echo hi", false)

		expect(result.response).toBe("noButtonClicked")
		const addCall = (task as any).addToClineMessages.mock.calls[0][0]
		expect(addCall.isAnswered).toBe(true)
		expect(postMessageToWebview).not.toHaveBeenCalledWith({ type: "clearApprovalButtons" })
	})

	it("does not stamp isAnswered when the ask requires a manual decision", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const provider: ProviderStub = {
			postMessageToWebview,
			getState: async () => ({
				autoApprovalEnabled: false,
				alwaysAllowExecute: false,
				allowedCommands: [],
				deniedCommands: [],
			}),
		}

		const task = buildTask(provider)
		await attachQueue(task)

		const askPromise = task.ask("command", "echo hi", false)

		// Simulate the user clicking Run after the buttons are shown.
		setTimeout(() => {
			task.approveAsk()
		}, 0)

		await askPromise

		const addCall = (task as any).addToClineMessages.mock.calls[0][0]
		expect(addCall.isAnswered).toBeFalsy()
		expect(postMessageToWebview).not.toHaveBeenCalledWith({ type: "clearApprovalButtons" })
	})

	it("does not stamp isAnswered for the followup timeout branch", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const provider: ProviderStub = {
			postMessageToWebview,
			getState: async () => ({
				autoApprovalEnabled: true,
				alwaysAllowFollowupQuestions: true,
				followupAutoApproveTimeoutMs: 60_000,
			}),
		}

		const task = buildTask(provider)
		await attachQueue(task)

		const suggestions = JSON.stringify({ suggest: [{ answer: "yes" }] })
		const askPromise = task.ask("followup", suggestions, false)

		// Resolve the ask before the long timeout fires so the test completes.
		setTimeout(() => {
			task.approveAsk()
		}, 0)

		await askPromise

		const addCall = (task as any).addToClineMessages.mock.calls[0][0]
		expect(addCall.isAnswered).toBeFalsy()
		expect(postMessageToWebview).not.toHaveBeenCalledWith({ type: "clearApprovalButtons" })
	})
})
