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

describe("command-ask marking across a mixed history (#998 review)", () => {
	// The marking predicate must find the newest UNANSWERED command ask, not
	// the newest command ask and not the newest message. A snapshot from a
	// resumed task interleaves says, tool asks, and command asks.
	type MarkingStub = {
		updateClineMessage: ReturnType<typeof vi.fn>
		saveClineMessages: ReturnType<typeof vi.fn>
	}

	const say = (ts: number, text: string): ClineMessage => ({ ts, type: "say", say: "text", text })
	const toolAsk = (ts: number): ClineMessage => ({
		ts,
		type: "ask",
		ask: "tool",
		text: "readFile",
		partial: false,
	})
	const commandAsk = (ts: number, answered = false): ClineMessage => ({
		ts,
		type: "ask",
		ask: "command",
		text: "git status --porcelain",
		partial: false,
		...(answered ? { isAnswered: true } : {}),
	})

	it("marks the newest unanswered command ask in a mixed history and leaves every other entry untouched", () => {
		const task = buildTask(undefined)
		const taskSay = say(1, "Initial task")
		const tool = toolAsk(2)
		const olderCommand = commandAsk(3)
		const interleavedSay = say(4, "thinking")
		const answeredCommand = commandAsk(5, true)
		const tailSay = say(6, "command output")
		task.clineMessages.push(taskSay, tool, olderCommand, interleavedSay, answeredCommand, tailSay)

		task.handleWebviewAskResponse("noButtonClicked")

		// The full resulting history: only the newest unanswered command ask
		// gains isAnswered. A newer ANSWERED command ask, says, and tool asks
		// must all stay untouched.
		expect(olderCommand.isAnswered).toBe(true)
		expect(taskSay.isAnswered).toBeUndefined()
		expect(tool.isAnswered).toBeUndefined()
		expect(interleavedSay.isAnswered).toBeUndefined()
		expect(answeredCommand.isAnswered).toBe(true)
		expect(tailSay.isAnswered).toBeUndefined()

		// The exact message passed to updateClineMessage is the marked ask.
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).toHaveBeenCalledTimes(1)
		expect(stub.updateClineMessage.mock.calls[0][0]).toBe(olderCommand)
		expect(stub.saveClineMessages).toHaveBeenCalledTimes(1)
	})

	it("marks nothing and neither updates nor saves when the history holds no command ask", () => {
		const task = buildTask(undefined)
		const taskSay = say(1, "Initial task")
		const tool = toolAsk(2)
		const tailSay = say(3, "command output")
		task.clineMessages.push(taskSay, tool, tailSay)

		task.handleWebviewAskResponse("noButtonClicked")

		expect(taskSay.isAnswered).toBeUndefined()
		expect(tool.isAnswered).toBeUndefined()
		expect(tailSay.isAnswered).toBeUndefined()
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).not.toHaveBeenCalled()
		expect(stub.saveClineMessages).not.toHaveBeenCalled()
	})

	it("marks the latest unanswered command ask when the user replies with text (messageResponse)", () => {
		const task = buildTask(undefined)
		const older = commandAsk(Date.now() - 2)
		const latest = commandAsk(Date.now() - 1)
		task.clineMessages.push(older, latest)

		task.handleWebviewAskResponse("messageResponse", "use flags, not rm")

		expect(latest.isAnswered).toBe(true)
		expect(older.isAnswered).toBeUndefined()
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).toHaveBeenCalledTimes(1)
		expect(stub.updateClineMessage.mock.calls[0][0]).toBe(latest)
		expect(stub.saveClineMessages).toHaveBeenCalledTimes(1)
	})

	it("leaves the command ask unmarked for an objectResponse", () => {
		const task = buildTask(undefined)
		const command = commandAsk(Date.now() - 1)
		task.clineMessages.push(command)

		task.handleWebviewAskResponse("objectResponse")

		expect(command.isAnswered).toBeUndefined()
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).not.toHaveBeenCalled()
		expect(stub.saveClineMessages).not.toHaveBeenCalled()
	})

	it("logs without throwing when updateClineMessage rejects", async () => {
		const task = buildTask(undefined)
		const command = commandAsk(Date.now() - 1)
		task.clineMessages.push(command)
		const failure = new Error("update failed")
		;(task as unknown as { updateClineMessage: ReturnType<typeof vi.fn> }).updateClineMessage = vi.fn(async () => {
			throw failure
		})
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		expect(() => task.handleWebviewAskResponse("noButtonClicked")).not.toThrow()
		// Let the rejected promise reach its catch handler.
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(errorSpy).toHaveBeenCalledWith("[Task#handleWebviewAskResponse] updateClineMessage failed:", failure)
		expect(command.isAnswered).toBe(true)
		errorSpy.mockRestore()
	})

	it("logs without throwing when saveClineMessages rejects", async () => {
		const task = buildTask(undefined)
		const command = commandAsk(Date.now() - 1)
		task.clineMessages.push(command)
		const failure = new Error("save failed")
		;(task as unknown as { saveClineMessages: ReturnType<typeof vi.fn> }).saveClineMessages = vi.fn(async () => {
			throw failure
		})
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		expect(() => task.handleWebviewAskResponse("noButtonClicked")).not.toThrow()
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(errorSpy).toHaveBeenCalledWith("Failed to save answered command-ask state:", failure)
		expect(command.isAnswered).toBe(true)
		errorSpy.mockRestore()
	})
})
