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
	// The marking tests answer the ask directly, so seed an armed target: a
	// real arrival would carry this ask's token (only orphans skip the stamp).
	;(task as unknown as { awaitingAskTarget: number }).awaitingAskTarget = 1
	;(task as any).addToClineMessages = vi.fn(async (_message: unknown, beforeEmit?: () => void) => {
		beforeEmit?.()
	})
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

	it("waits for its own approval for each command in a multi-command request (#998)", async () => {
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

		// True when the promise settles on its own within the window.
		const settledWithoutResponse = (p: Promise<unknown>) =>
			Promise.race([p.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))])

		// One prompt per command, asserted BEFORE each approval so the count
		// cannot pass vacuously on post-approval recording.
		const harness = task as unknown as {
			addToClineMessages: { mock: { calls: Array<[ClineMessage]> } }
		}
		const commandAsks = () =>
			harness.addToClineMessages.mock.calls
				.map(([message]) => message)
				.filter((message) => message.type === "ask" && message.ask === "command")
		const commandAskCount = () => commandAsks().length

		// Command #1: prompts and waits for the user's approval.
		const ask1 = task.ask("command", 'echo "cmd1"', false)
		expect(await settledWithoutResponse(ask1)).toBe(false)
		// The prompt recorded so far is exactly command #1, still unanswered.
		const prompt1 = commandAsks()[0]
		expect(prompt1.text).toBe('echo "cmd1"')
		expect(prompt1.isAnswered).not.toBe(true)
		expect(commandAskCount()).toBe(1)
		task.approveAsk()
		expect((await ask1).response).toBe("yesButtonClicked")

		// Command #2: must not inherit command #1's approval. It stays
		// pending until its own response arrives — no execution before
		// each approval.
		const ask2 = task.ask("command", 'echo "cmd2"', false)
		expect(await settledWithoutResponse(ask2)).toBe(false)
		const prompt2 = commandAsks()[1]
		expect(prompt2.text).toBe('echo "cmd2"')
		expect(prompt2.isAnswered).not.toBe(true)
		expect(commandAskCount()).toBe(2)
		task.approveAsk()
		expect((await ask2).response).toBe("yesButtonClicked")

		// Command #3: same — one prompt per command.
		const ask3 = task.ask("command", 'echo "cmd3"', false)
		expect(await settledWithoutResponse(ask3)).toBe(false)
		const prompt3 = commandAsks()[2]
		expect(prompt3.text).toBe('echo "cmd3"')
		expect(prompt3.isAnswered).not.toBe(true)
		expect(commandAskCount()).toBe(3)
		task.approveAsk()
		expect((await ask3).response).toBe("yesButtonClicked")

		expect(commandAskCount()).toBe(3)
	})

	it("keeps a partial command ask answerable when a text reply lands before its completion (#998 review)", async () => {
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

		// The real flow records the partial ask in the history. The default
		// harness stub does not push, so give this task a recording stub.
		;(task as unknown as { addToClineMessages: ReturnType<typeof vi.fn> }).addToClineMessages = vi.fn(
			async (message: ClineMessage) => {
				task.clineMessages.push(message)
			},
		)

		// True when the promise settles on its own within the window.
		const settledWithoutResponse = (p: Promise<unknown>) =>
			Promise.race([p.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))])

		// The stream opens a partial command ask. It throws by design: the
		// complete ask has not arrived yet, so nothing waits for a response.
		await expect(task.ask("command", "git push", true)).rejects.toThrow()
		const partialAsk = task.clineMessages.at(-1)
		expect(partialAsk?.partial).toBe(true)

		// A text reply lands while the partial ask is still streaming in. It
		// must not stamp the partial ask: the completed ask has to stay
		// answerable, or it waits forever with no Run/Deny to answer it.
		task.handleWebviewAskResponse("messageResponse", "hold on")
		expect(partialAsk?.isAnswered).toBeUndefined()

		// The stream completes the same message. The ask must stay pending
		// and answerable: no stamp, and a manual approval resolves it.
		const askPromise = task.ask("command", "git push", false)
		expect(await settledWithoutResponse(askPromise)).toBe(false)
		const completedAsk = task.clineMessages.at(-1)
		expect(completedAsk?.isAnswered).toBeUndefined()
		task.approveAsk()
		expect((await askPromise).response).toBe("yesButtonClicked")
		// The manual approval stamps the completed ask, as every complete
		// command ask still must be stamped.
		expect(completedAsk?.isAnswered).toBe(true)
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
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = latest.ts

		task.handleWebviewAskResponse("yesButtonClicked")

		expect(latest.isAnswered).toBe(true)
		expect(older.isAnswered).toBeUndefined()
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).toHaveBeenCalledWith(latest)
		expect(stub.saveClineMessages).toHaveBeenCalled()
	})

	it("marks the latest unanswered command ask when the user denies", () => {
		const { task, older, latest } = buildMarkingTask()
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = latest.ts

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
		// The armed ask owns the unanswered command row.
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = olderCommand.ts

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
		// The armed ask's owning row is not in this history.
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = 999

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
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = latest.ts

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
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = command.ts
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
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = command.ts
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

describe("command-ask marking guards (#998 review)", () => {
	type MarkingStub = {
		updateClineMessage: ReturnType<typeof vi.fn>
		saveClineMessages: ReturnType<typeof vi.fn>
	}

	const say = (ts: number, text: string): ClineMessage => ({ ts, type: "say", say: "text", text })
	const toolAsk = (ts: number): ClineMessage => ({
		ts,
		type: "ask",
		ask: "tool",
		text: '{"tool":"readFile"}',
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

	it("marks the newest unanswered command ask, not a newer unanswered tool ask", () => {
		const task = buildTask(undefined)
		const olderCommand = commandAsk(3)
		const newerToolAsk = toolAsk(4)
		const tailSay = say(5, "thinking")
		task.clineMessages.push(say(1, "Initial task"), olderCommand, newerToolAsk, tailSay)
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = olderCommand.ts

		task.handleWebviewAskResponse("noButtonClicked")

		expect(olderCommand.isAnswered).toBe(true)
		expect(newerToolAsk.isAnswered).toBeUndefined()
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).toHaveBeenCalledTimes(1)
		expect(stub.updateClineMessage.mock.calls[0][0]).toBe(olderCommand)
		expect(stub.saveClineMessages).toHaveBeenCalledTimes(1)
	})

	it("ignores a say record that carries an ask field", () => {
		const task = buildTask(undefined)
		// A legacy record can carry both a say and an ask field. The parser
		// allows it; the marking predicate must not treat it as an ask.
		const legacySay: ClineMessage = { ts: 3, type: "say", say: "text", text: "legacy record", ask: "command" }
		task.clineMessages.push(say(1, "Initial task"), legacySay)
		// The owning ts matches the legacy record; the type guard must reject it.
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = legacySay.ts

		task.handleWebviewAskResponse("noButtonClicked")

		expect(legacySay.isAnswered).toBeUndefined()
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).not.toHaveBeenCalled()
		expect(stub.saveClineMessages).not.toHaveBeenCalled()
	})

	it("does not stamp a partial command ask on a text reply (#998 review)", () => {
		const task = buildTask(undefined)
		const partial: ClineMessage = {
			ts: 2,
			type: "ask",
			ask: "command",
			text: "git push",
			partial: true,
		}
		task.clineMessages.push(say(1, "Initial task"), partial)
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = partial.ts

		task.handleWebviewAskResponse("messageResponse", "use flags, not rm")

		// The ask is still streaming in. A stamp would leave the completed
		// ask waiting forever with no Run/Deny to answer it.
		expect(partial.isAnswered).toBeUndefined()
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).not.toHaveBeenCalled()
		expect(stub.saveClineMessages).not.toHaveBeenCalled()
	})

	it("still stamps a complete command ask on a text reply after a partial one completed (#998 review)", () => {
		const task = buildTask(undefined)
		const partial: ClineMessage = {
			ts: 2,
			type: "ask",
			ask: "command",
			text: "git push",
			partial: true,
		}
		task.clineMessages.push(say(1, "Initial task"), partial)

		// The stream completes the same message, then a text reply settles
		// the completed ask. It must be stamped like every complete ask.
		partial.partial = false
		;(task as unknown as { awaitingAskTargetRowTs?: number }).awaitingAskTargetRowTs = partial.ts
		task.handleWebviewAskResponse("messageResponse", "use flags, not rm")

		expect(partial.isAnswered).toBe(true)
		const stub = task as unknown as MarkingStub
		expect(stub.updateClineMessage).toHaveBeenCalledWith(partial)
		expect(stub.saveClineMessages).toHaveBeenCalled()
	})
})
