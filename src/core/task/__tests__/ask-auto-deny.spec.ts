// npx vitest run core/task/__tests__/ask-auto-deny.spec.ts

import type { ExtensionState } from "@roo-code/types"

import { createRateLimitClock } from "../RateLimitClock"
import { Task } from "../Task"

// The streaming-loop drive below never asserts on environment details; the
// real collector reaches into the VS Code window API, which this file's
// lightweight task stub does not model.
vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

// Blanket auto-deny (`alwaysDenyUnapprovedCommands`) at the Task level: a
// command ask that policy denies must resolve immediately with the structured
// `autoDenyDetail` (so presentAssistantMessage can distinguish it from a user
// rejection), and the chat row must carry the auto-deny chip
// (`autoApprovalDecision: "deny"` + `isAnswered`). A subsequent ask must never
// see a stale detail from a previous denial.

/** The parts of the provider that `Task.ask` and the streaming-loop drive reach for. */
type ProviderStub = {
	getState: () => Promise<Partial<ExtensionState>>
	postMessageToWebview: ReturnType<typeof vi.fn>
	postStateToWebviewWithoutTaskHistory: ReturnType<typeof vi.fn>
	getSkillsManager: () => undefined
	cwd: string
}

function buildTask(provider: ProviderStub, taskCwd: string) {
	const task = Object.create(Task.prototype) as Task
	task["abort"] = false
	task["clineMessages"] = []
	task["askResponse"] = undefined
	task["askResponseText"] = undefined
	task["askResponseImages"] = undefined
	task["lastMessageTs"] = undefined
	task["addToClineMessages"] = vi.fn(async () => {})
	task["saveClineMessages"] = vi.fn(async () => true)
	task["updateClineMessage"] = vi.fn(async () => {})
	task["cancelAutoApprovalTimeout"] = vi.fn(() => {})
	task["checkpointSave"] = vi.fn(async () => {})
	task["emit"] = vi.fn()
	// A double assertion is unavoidable here: `providerRef` is a `WeakRef<ClineProvider>`,
	// and the stub is neither a `WeakRef` nor a whole `ClineProvider`. Constructing
	// either would drag in the extension host, when `Task.ask` only ever calls
	// `deref()`, `getState()` and `postMessageToWebview()` on it.
	task["providerRef"] = { deref: () => provider } as unknown as Task["providerRef"]
	Object.defineProperty(task, "workspacePath", { value: taskCwd })

	return task
}

async function attachQueue(task: Task) {
	const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
	const queue = new MessageQueueService()
	Object.defineProperty(task, "messageQueueService", { value: queue })
	return queue
}

/**
 * Adds the fields `recursivelyMakeClineRequests` touches before its per-turn
 * reset, so a test can drive one assistant turn without the full provider
 * harness. The stubbed `attemptApiRequest` streams a single text chunk;
 * `abandoned` ends the loop right after the stream via the loop's
 * abort/abandoned exit, so the drive stops before any post-stream tool
 * presentation and never reaches the retry/backoff paths.
 */
function attachTurnHarness(task: Task) {
	task.messageCounts = { user: 0, assistant: 0 }
	task.apiConversationHistory = []
	task["abandoned"] = true
	Object.defineProperty(task, "api", {
		value: { getModel: () => ({ id: "gpt-4.1", info: {} }) },
	})
	Object.defineProperty(task, "apiConfiguration", { value: { apiProvider: undefined } })
	Object.defineProperty(task, "rateLimitClock", { value: createRateLimitClock() })
	Object.defineProperty(task, "diffViewProvider", { value: { isEditing: false, reset: async () => {} } })
	Object.defineProperty(task, "streamingToolCallIndices", { value: new Map() })
	task["saveApiConversationHistory"] = vi.fn(async () => true)
	task["say"] = vi.fn(async () => undefined)
	// The loop rewrites the newest api_req_started row with cost data; the
	// no-op `say` stub above never adds one itself.
	task["clineMessages"].push({ type: "say", say: "api_req_started", text: "{}", ts: Date.now() })
	task["attemptApiRequest"] = vi.fn().mockImplementation(() =>
		(async function* () {
			yield { type: "text" as const, text: "next turn reply" }
		})(),
	)
}

const TASK_CWD = "/path/to/task-workspace"

describe("Task.ask resolves blanket command denials with structured detail", () => {
	// Mutable state so a test can flip the policy between consecutive asks on
	// the same task (mirrors the live per-ask `provider.getState()` read).
	let state: Partial<ExtensionState>
	let provider: ProviderStub

	beforeEach(() => {
		state = {
			autoApprovalEnabled: true,
			alwaysAllowExecute: true,
			alwaysDenyUnapprovedCommands: true,
			allowedCommands: [],
			deniedCommands: [],
			destructiveCommandGuardEnabled: false,
		}
		provider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			getSkillsManager: () => undefined,
			cwd: TASK_CWD,
			getState: async () => state,
		}
	})

	it("auto-denies an unallowlisted command and stamps the deny chip on the chat row", async () => {
		const task = buildTask(provider, TASK_CWD)
		await attachQueue(task)

		const result = await task.ask("command", "rm x", false)

		// Policy denial: resolves without user interaction, carrying the reason.
		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail).toBeDefined()
		expect(result.autoDenyDetail?.kind).toBe("not_allowlisted")
		expect(result.autoDenyDetail?.command).toBe("rm x")

		// Chat row: the existing auto-deny chip (answered + deny decision), so no
		// approval buttons ever appear.
		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>
		expect(addToClineMessages).toHaveBeenCalledTimes(1)
		const message = addToClineMessages.mock.calls[0][0]
		expect(message.type).toBe("ask")
		expect(message.ask).toBe("command")
		expect(message.isAnswered).toBe(true)
		expect(message.autoApprovalDecision).toBe("deny")
	})

	it("a following approved ask does not leak the previous denial's detail", async () => {
		const task = buildTask(provider, TASK_CWD)
		await attachQueue(task)

		const denied = await task.ask("command", "rm x", false)
		expect(denied.autoDenyDetail?.kind).toBe("not_allowlisted")

		// Approve the next command via the allowlist: the denial detail from the
		// previous ask must not ride along into this result.
		state.allowedCommands = ["git"]
		const approved = await task.ask("command", "git status", false)

		expect(approved.response).toBe("yesButtonClicked")
		expect(approved.autoDenyDetail).toBeUndefined()

		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>
		expect(addToClineMessages).toHaveBeenCalledTimes(2)
		expect(addToClineMessages.mock.calls[1][0].autoApprovalDecision).toBe("approve")
	})

	it("carries a denylist denial's detail even with the blanket setting off", async () => {
		// Denylist denials were never user rejections: they carry structured
		// detail regardless of the blanket flag (unified vocabulary).
		state.alwaysDenyUnapprovedCommands = false
		state.deniedCommands = ["rm"]

		const task = buildTask(provider, TASK_CWD)
		await attachQueue(task)

		const result = await task.ask("command", "rm -rf build", false)

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("denylist")
		expect(result.autoDenyDetail?.command).toBe("rm -rf build")
		expect(result.autoDenyDetail?.pattern).toBe("rm")

		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>
		expect(addToClineMessages.mock.calls[0][0].autoApprovalDecision).toBe("deny")
	})

	it("routes a forwarded DCG verdict into the policy decision", async () => {
		// The seam: Task.ask must hand the tool-supplied verdict to
		// checkAutoApproval. Without the forwarding this DCG-enabled ask
		// (verdict-less from checkAutoApproval's view) approves instead of
		// carrying the guard's structured denial.
		state.destructiveCommandGuardEnabled = true
		const task = buildTask(provider, TASK_CWD)
		await attachQueue(task)

		const result = await task.ask("command", "rm x", false, undefined, false, {
			dcgDecision: { decision: "deny", reason: "matches a destructive pattern" },
		})

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("dcg")
		expect(result.autoDenyDetail?.command).toBe("rm x")
		expect(result.autoDenyDetail?.dcgReason).toBe("matches a destructive pattern")
	})

	it("flips to the retryable guard-state deny mid-session and heals once the retried ask carries a verdict", async () => {
		// Simulates the guard setting flipping on between consecutive asks at
		// the decision-bearing boundary (Task.ask reads provider state per ask,
		// then checkAutoApproval sees no verdict for the newly-enabled guard).
		// The sub-microsecond tool-vs-setting window itself is only reachable
		// end-to-end; what is provable here is that the verdictless arrival
		// denies with the retryable detail and that a re-issue carrying a
		// verdict is approved again.
		const task = buildTask(provider, TASK_CWD)
		await attachQueue(task)

		// ask 1: guard off — the ordinary blanket path.
		const before = await task.ask("command", "echo hi", false)
		expect(before.response).toBe("noButtonClicked")
		expect(before.autoDenyDetail?.kind).toBe("not_allowlisted")

		// The flip: the guard setting turns on, but this ask arrives without a
		// verdict — an inconsistent guard state, denied retryably, not approved.
		state.destructiveCommandGuardEnabled = true
		const flipped = await task.ask("command", "rm x", false)
		expect(flipped.response).toBe("noButtonClicked")
		expect(flipped.autoDenyDetail?.kind).toBe("guard_unavailable")
		expect(flipped.autoDenyDetail?.command).toBe("rm x")

		// The retry heals: the re-issued ask carries the guard's allow verdict
		// and approves.
		const healed = await task.ask("command", "rm x", false, undefined, false, {
			dcgDecision: { decision: "allow" },
		})
		expect(healed.response).toBe("yesButtonClicked")
		expect(healed.autoDenyDetail).toBeUndefined()
	})
})

describe("Task.ask queue path cannot bypass blanket deny", () => {
	let state: Partial<ExtensionState>
	let provider: ProviderStub

	beforeEach(() => {
		state = {
			autoApprovalEnabled: true,
			alwaysAllowExecute: true,
			alwaysDenyUnapprovedCommands: true,
			allowedCommands: [],
			deniedCommands: [],
			destructiveCommandGuardEnabled: false,
		}
		provider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			getSkillsManager: () => undefined,
			cwd: TASK_CWD,
			getState: async () => state,
		}
	})

	it("denies a blanket-denied command ask even when a queued message would auto-approve it", async () => {
		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		// A queued message answers command asks with an unconditional
		// yesButtonClicked — exactly the shortcut that must never stand in for
		// approval while blanket deny is engaged. The policy denial must win,
		// and it must carry the same structured detail as the main path.
		queue.addMessage("queued feedback arriving while blanket deny is engaged")

		const result = await task.ask("command", "rm x", false)

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail).toBeDefined()
		expect(result.autoDenyDetail?.kind).toBe("not_allowlisted")
		expect(result.autoDenyDetail?.command).toBe("rm x")
		// The queued message was not consumed as a fake approval: it stays in the
		// queue for a later conversational turn.
		expect(result.queuedMessageId).toBeUndefined()
		expect(queue.messages).toHaveLength(1)
	})

	it("still lets a queued message answer a command ask when blanket deny is off", async () => {
		// Behavior unchanged while the blanket configuration is disengaged: the
		// queued-message auto-approval shortcut keeps working.
		state.alwaysDenyUnapprovedCommands = false

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		queue.addMessage("queued feedback with blanket deny off")

		const result = await task.ask("command", "rm x", false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
		// Non-durable resolution consumed the queued message.
		expect(queue.messages).toHaveLength(0)
	})

	it("keeps the queue gate open (queued message answers the command ask) while autoApprovalEnabled is false", async () => {
		// The blanket gate is a conjunction of three settings; each false member
		// alone must disengage it, so the queued shortcut stays live.
		state.autoApprovalEnabled = false

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		queue.addMessage("queued feedback with the conjunction incomplete")

		const result = await task.ask("command", "rm x", false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBe("queued feedback with the conjunction incomplete")
		expect(queue.messages).toHaveLength(0)
	})

	it("keeps the queue gate open (queued message answers the command ask) while alwaysAllowExecute is false", async () => {
		state.alwaysAllowExecute = false

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		queue.addMessage("queued feedback with the conjunction incomplete")

		const result = await task.ask("command", "rm x", false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBe("queued feedback with the conjunction incomplete")
		expect(queue.messages).toHaveLength(0)
	})

	it("denies the command ask when blanket deny engages between the snapshot and the immediate queued consume", async () => {
		// The ask-time snapshot must not be the last word: the queued shortcut
		// skips checkAutoApproval, so a blanket-deny engagement landing after the
		// snapshot is invisible to it and would auto-approve an unallowlisted
		// command. Interleaving here: first getState = snapshot (deny OFF, so the
		// message is claimed); second getState = the consume-site re-check, at
		// which the settings save has landed (deny ON).
		state.alwaysDenyUnapprovedCommands = false
		let getStateCalls = 0
		provider.getState = async () => {
			getStateCalls++
			if (getStateCalls >= 2) {
				state.alwaysDenyUnapprovedCommands = true
			}
			return state
		}

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		queue.addMessage("queued feedback arriving during the flip window")

		const result = await task.ask("command", "rm x", false)

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("not_allowlisted")
		// The claimed message was released, not consumed as a fake approval.
		expect(result.queuedMessageId).toBeUndefined()
		expect(queue.messages).toHaveLength(1)
		expect(queue.hasUnclaimed()).toBe(true)
	})

	it("the user's Deny during the immediate re-check await is not overwritten", async () => {
		// The Deny lands while the fresh policy read is pending (queued behind
		// the backlog). The re-check itself still resolves `consume` — applying
		// that outcome would answer the ask with the queued message's
		// yesButtonClicked over the user's decision.
		state.alwaysDenyUnapprovedCommands = false
		const task = buildTask(provider, TASK_CWD)
		let getStateCalls = 0
		provider.getState = async () => {
			getStateCalls++
			if (getStateCalls === 2) {
				task.handleWebviewAskResponse("noButtonClicked")
			}
			return state
		}
		const queue = await attachQueue(task)
		queue.addMessage("queued feedback arriving behind the user's Deny")

		const result = await task.ask("command", "rm x", false)

		expect(result.response).toBe("noButtonClicked")
		expect(result.text).toBeUndefined()
		expect(result.queuedMessageId).toBeUndefined()
		// The claim was released, not consumed: the message survives for the
		// next consumer.
		expect(queue.messages).toHaveLength(1)
		expect(queue.hasUnclaimed()).toBe(true)
	})

	it("a throwing re-check at the immediate site releases the claim and leaves the prompt pending", async () => {
		// A rejected policy read must neither reject ask() nor strand the claim:
		// the prompt stays pending for the user and the message survives for a
		// later consumer.
		state.alwaysDenyUnapprovedCommands = false
		let getStateCalls = 0
		// Sticky: every read after the snapshot fails, so the drain site's
		// re-check also fails and the released claim survives for the assertion
		// poll instead of being re-claimed and legitimately consumed.
		provider.getState = async () => {
			getStateCalls++
			if (getStateCalls >= 2) {
				throw new Error("policy read failed")
			}
			return state
		}

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		queue.addMessage("queued feedback with a failing policy read")
		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>

		const askPromise = task.ask("command", "rm x", false)
		// Past the prompt post, into the re-check await; then poll for the
		// catch-arm's claim release (no fixed sleep).
		await vi.waitFor(() => expect(addToClineMessages).toHaveBeenCalledTimes(1))
		await vi.waitFor(() => expect(queue.hasUnclaimed()).toBe(true))

		task.approveAsk()
		const result = await askPromise
		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect(result.queuedMessageId).toBeUndefined()
		expect(queue.messages).toHaveLength(1)
	})

	it("denies the command ask when blanket deny engages during the prompt dwell and the drain claims a message", async () => {
		// The seconds-wide fail-open window: the flip and the queue arrival both
		// land during the pWaitFor dwell, after the frozen snapshot gate opened.
		state.alwaysDenyUnapprovedCommands = false

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>

		const askPromise = task.ask("command", "rm x", false)
		// Past the snapshot read, into the prompt dwell.
		await vi.waitFor(() => expect(addToClineMessages).toHaveBeenCalledTimes(1))
		state.alwaysDenyUnapprovedCommands = true
		queue.addMessage("queued during the dwell")

		const result = await askPromise

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("not_allowlisted")
		expect(result.queuedMessageId).toBeUndefined()
		expect(queue.messages).toHaveLength(1)
		expect(queue.hasUnclaimed()).toBe(true)
	})

	it("a tool ask after a blanket-denied command leaves both queued messages for the user instead of self-approving", async () => {
		// A message left in the queue by a blanket denial answers that denial, not
		// whatever ask runs next in the same turn; consuming it as
		// yesButtonClicked would silently approve (and suppress the prompt for)
		// the next ask.
		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>
		queue.addMessage("feedback on the denied command")

		const denied = await task.ask("command", "rm x", false)
		expect(denied.response).toBe("noButtonClicked")
		expect(task["blanketDeniedCommandThisTurn"]).toBe(true)

		// Same turn: a non-command ask may claim the surviving message; the latch
		// must stop it from being consumed as approval.
		let settled: Awaited<ReturnType<Task["ask"]>> | undefined
		const toolAsk = task
			.ask("tool", JSON.stringify({ tool: "write_to_file", path: "a.txt" }), false)
			.then((result) => {
				settled = result
				return result
			})
		await vi.waitFor(() => expect(addToClineMessages).toHaveBeenCalledTimes(2))
		// A second message arriving during the dwell exercises the drain site's
		// latch guard, not just the immediate-consume guard.
		queue.addMessage("second message during the tool-ask dwell")
		// Poll with a deadline for the failure mode (ask self-resolving via the
		// queue); a correctly latched ask stays pending for the user.
		await vi.waitFor(() => expect(settled).toBeDefined(), { timeout: 350, interval: 25 }).catch(() => undefined)
		expect(settled).toBeUndefined()
		expect(queue.messages).toHaveLength(2)

		// The user answers the prompt themselves; neither queued message rides along.
		task.approveAsk()
		const result = await toolAsk
		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect(result.queuedMessageId).toBeUndefined()
		expect(queue.messages).toHaveLength(2)
		expect(queue.hasUnclaimed()).toBe(true)
	})

	it("the next turn's tool ask consumes the queued message once the latch reset clears it", async () => {
		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		attachTurnHarness(task)
		queue.addMessage("queued feedback")

		const denied = await task.ask("command", "rm x", false)
		expect(denied.response).toBe("noButtonClicked")
		expect(task["blanketDeniedCommandThisTurn"]).toBe(true)

		// The only production clear is the per-turn reset inside the streaming
		// loop (beside didToolFailInCurrentTurn), so the latch is released by
		// driving a real assistant turn — a hand-set flag would not pin it.
		await task.recursivelyMakeClineRequests([{ type: "text", text: "next turn" }], false)
		expect(task["blanketDeniedCommandThisTurn"]).toBe(false)

		const result = await task.ask("tool", JSON.stringify({ tool: "readFile", path: "a.txt" }), false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBe("queued feedback")
		expect(queue.messages).toHaveLength(0)
	})
})
