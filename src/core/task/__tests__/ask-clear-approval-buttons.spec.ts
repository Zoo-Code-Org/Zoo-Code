import { Task } from "../Task"
import type { ClineMessage } from "@roo-code/types"
import { setAbortLatch } from "../../../test-utils/run-state"

// When the backend auto-resolves an interactive ask, isAnswered:true is stamped
// on the ClineMessage before it is added so the webview state snapshot already
// carries the resolved flag. This eliminates the race between showing approval
// buttons and the former separate clearApprovalButtons message.

type ProviderStub = {
	getState: () => Promise<any>
	postMessageToWebview: ReturnType<typeof vi.fn>
}

function buildTask(provider: ProviderStub | undefined) {
	const task = Object.create(Task.prototype) as Task
	setAbortLatch(task, false)
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

describe("manual command-ask marking (#998)", () => {
	// A full-state snapshot can mask an unanswered command ask behind a say
	// (webview reload). The webview re-derives the buttons from the latest
	// unanswered ask, so a manual click must stamp isAnswered on it. Without
	// the stamp, a reload re-shows Run/Deny for a settled ask.
	type MarkingStub = {
		updateClineMessage: ReturnType<typeof vi.fn>
		saveClineMessages: ReturnType<typeof vi.fn>
	}

	const buildMarkingTask = () => {
		const task = buildTask(undefined)
		const older: ClineMessage = {
			ts: Date.now() - 2,
			type: "ask",
			ask: "command",
			text: "git status --porcelain",
			partial: false,
		}
		const latest: ClineMessage = {
			ts: Date.now() - 1,
			type: "ask",
			ask: "command",
			text: "git ls-files -u",
			partial: false,
		}
		task.clineMessages.push(older, latest)
		return { task, older, latest }
	}

	it("marks the latest unanswered command ask when the user approves", () => {
		const { task, older, latest } = buildMarkingTask()

		task.handleWebviewAskResponse("yesButtonClicked")

		expect(latest.isAnswered).toBe(true)
		expect(older.isAnswered).toBeUndefined()
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).toHaveBeenCalledWith(latest)
		expect(stub.saveClineMessages).toHaveBeenCalled()
	})

	it("marks the latest unanswered command ask when the user denies", () => {
		const { task, older, latest } = buildMarkingTask()

		task.handleWebviewAskResponse("noButtonClicked")

		expect(latest.isAnswered).toBe(true)
		expect(older.isAnswered).toBeUndefined()
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).toHaveBeenCalledWith(latest)
		expect(stub.saveClineMessages).toHaveBeenCalled()
	})

	it("leaves tool asks unmarked when the user denies", () => {
		const task = buildTask(undefined)
		const toolAsk: ClineMessage = {
			ts: Date.now() - 1,
			type: "ask",
			ask: "tool",
			text: "readFile",
			partial: false,
		}
		task.clineMessages.push(toolAsk)

		task.handleWebviewAskResponse("noButtonClicked")

		expect(toolAsk.isAnswered).toBeUndefined()
	})
})
