// npx vitest run core/task/__tests__/ask-auto-deny.spec.ts

import { type ClineMessage, type ExtensionState, RooCodeEventName } from "@roo-code/types"

import * as autoApprovalModule from "../../auto-approval"
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

/**
 * Swaps the no-op `addToClineMessages` stub for a recording one, so the 2 s
 * status timers' `findMessageByTimestamp(askTs)` lookup finds the pending ask
 * row and the interactive emit can actually run.
 */
function recordClineMessages(task: Task) {
	const addToClineMessages = vi.fn(async (message: ClineMessage) => {
		task["clineMessages"].push(message)
	})
	task["addToClineMessages"] = addToClineMessages
	return addToClineMessages
}

/**
 * Installs a fresh `emit` recorder (replacing `buildTask`'s no-op stub) and
 * returns a counter of this task's `TaskInteractive` emissions.
 */
function installInteractiveEmitRecorder(task: Task) {
	const emit = vi.fn()
	task["emit"] = emit
	return () => emit.mock.calls.filter(([event]) => event === RooCodeEventName.TaskInteractive).length
}

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

	it("the user's Deny landing while the drain-site re-check awaits is not overwritten", async () => {
		// Distinct from the immediate-site supersede case: the message arrives
		// during the prompt dwell, so the claim and the policy re-check run
		// inside the pWaitFor predicate's drain closure. The Deny lands while
		// that re-check awaits; without the closure's bail-out guard the drained
		// message would answer the ask over the user's decision.
		state.alwaysDenyUnapprovedCommands = false
		const task = buildTask(provider, TASK_CWD)
		let getStateCalls = 0
		provider.getState = async () => {
			getStateCalls++
			if (getStateCalls === 2) {
				// The Deny lands while the drain closure's fresh policy read is
				// pending (first call is the ask's snapshot).
				task.handleWebviewAskResponse("noButtonClicked")
			}
			return state
		}
		const queue = await attachQueue(task)
		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>

		const askPromise = task.ask("command", "rm x", false)
		// Past the snapshot read, into the dwell; the message arriving now
		// forces the drain site rather than the immediate consume path.
		await vi.waitFor(() => expect(addToClineMessages).toHaveBeenCalledTimes(1))
		queue.addMessage("queued during the dwell, superseded by the user's Deny")

		const result = await askPromise

		expect(result.response).toBe("noButtonClicked")
		expect(result.text).toBeUndefined()
		expect(result.queuedMessageId).toBeUndefined()
		// The provisional claim was released, not consumed: the message
		// survives for the next consumer.
		expect(queue.messages).toHaveLength(1)
		expect(queue.hasUnclaimed()).toBe(true)
	})

	it("latches the turn when the denial fires at the drain site and the latch blocks the follow-up ask", async () => {
		// The drain-site denial takes the same latch path as the immediate site
		// (the deny branch of `applyQueuedCommandPolicyAction`); the follow-up
		// ask proves the latch — not just this ask's denial result — keeps
		// queue messages from standing in as approval for the rest of the turn.
		state.alwaysDenyUnapprovedCommands = false

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>

		const askPromise = task.ask("command", "rm x", false)
		// Past the snapshot read, into the prompt dwell: the flip and the
		// message arrival both land during the dwell, so the denial is produced
		// by the drain site's re-check rather than the frozen snapshot gate.
		await vi.waitFor(() => expect(addToClineMessages).toHaveBeenCalledTimes(1))
		state.alwaysDenyUnapprovedCommands = true
		queue.addMessage("queued during the dwell")

		const denied = await askPromise
		expect(denied.response).toBe("noButtonClicked")
		expect(denied.autoDenyDetail?.kind).toBe("not_allowlisted")
		// The latch set is the drain-site path's, not the main ask path's: the
		// snapshot saw the blanket setting off, so `checkAutoApproval` asked.
		expect(task["blanketDeniedCommandThisTurn"]).toBe(true)

		// Same turn: with the latch set, `mayDrainQueuedMessageForAsk` gates the
		// claim itself at both consume sites, so the follow-up ask never claims
		// either queued message — no message may answer it as approval.
		let settled: Awaited<ReturnType<Task["ask"]>> | undefined
		const toolAsk = task
			.ask("tool", JSON.stringify({ tool: "write_to_file", path: "a.txt" }), false)
			.then((result) => {
				settled = result
				return result
			})
		await vi.waitFor(() => expect(addToClineMessages).toHaveBeenCalledTimes(2))
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

	it("arms the interactive status timer when the latch gate leaves the ask pending", async () => {
		// A gated claim keeps the queue non-empty, so `isStatusMutable` is false
		// for the whole dwell and the 2 s interactive arm is skipped unless the
		// gate branch arms it: without that, hands-free/API consumers see
		// `Running` with no `TaskInteractive` for a prompt that is waiting on
		// the user.
		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		recordClineMessages(task)
		const interactive = installInteractiveEmitRecorder(task)
		queue.addMessage("feedback on the denied command")

		const denied = await task.ask("command", "rm x", false)
		expect(denied.response).toBe("noButtonClicked")
		// The denial resolved on its own: no interactive state was ever entered.
		expect(interactive()).toBe(0)

		const toolAsk = task.ask("tool", JSON.stringify({ tool: "write_to_file", path: "a.txt" }), false)
		await vi.waitFor(() => expect(interactive()).toBe(1), { timeout: 6_000 })
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "interactionRequired" })

		task.approveAsk()
		const result = await toolAsk
		expect(result.response).toBe("yesButtonClicked")
		expect(queue.messages).toHaveLength(1)
	})

	it("arms the interactive status timer when a throwing re-check releases the prompt pending", async () => {
		// A rejected policy read leaves the prompt pending for the user, so the
		// catch's claim release must arm the 2 s interactive timer: with the
		// queue non-empty, `isStatusMutable` — computed once, before the claim — never armed.
		state.alwaysDenyUnapprovedCommands = false
		let getStateCalls = 0
		provider.getState = async () => {
			getStateCalls++
			if (getStateCalls >= 2) {
				throw new Error("policy read failed")
			}
			return state
		}

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		recordClineMessages(task)
		const interactive = installInteractiveEmitRecorder(task)
		queue.addMessage("queued feedback with a failing policy read")

		const askPromise = task.ask("command", "rm x", false)
		await vi.waitFor(() => expect(queue.hasUnclaimed()).toBe(true))
		await vi.waitFor(() => expect(interactive()).toBe(1), { timeout: 6_000 })

		task.approveAsk()
		const result = await askPromise
		expect(result.response).toBe("yesButtonClicked")
		expect(queue.messages).toHaveLength(1)
	})

	it("emits exactly one TaskInteractive when back-to-back policy releases leave the prompt pending", async () => {
		// Two release branches run for one prompt: the immediate-site fresh
		// read answers `release` (blanket engages at the re-read, and the
		// protected prompt survives it), which arms the interactive timer even
		// though the non-empty queue skipped the `isStatusMutable`-gated arm
		// (computed once, before the claim); the predicate then re-claims the
		// released message and the drain
		// release re-arms. The idempotence guard must make that second (and
		// every later) arm a no-op: without it, one prompt emits
		// `TaskInteractive`/`interactionRequired` more than once.
		state.alwaysDenyUnapprovedCommands = false
		let getStateCalls = 0
		provider.getState = async () => {
			getStateCalls++
			if (getStateCalls === 2) {
				// The flip lands at the immediate-site fresh read: the frozen
				// snapshot let the message be claimed, the fresh check must now
				// neither consume it nor let it answer the ask.
				state.alwaysDenyUnapprovedCommands = true
			}
			return state
		}

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		recordClineMessages(task)
		const interactive = installInteractiveEmitRecorder(task)
		queue.addMessage("queued feedback facing the engaged blanket deny")

		const askPromise = task.ask("command", "some-unknown-command", false, undefined, true)

		const armedAt = Date.now()
		await vi.waitFor(() => expect(interactive()).toBe(1), { timeout: 6_000 })
		// Wait past the window in which a second (drain-site) arm would also
		// fire, then assert the total: the first timer can show up alone
		// briefly before a hypothetical second one, so the count is only
		// meaningful after both would have expired.
		await vi.waitFor(() => expect(Date.now() - armedAt).toBeGreaterThan(2_600), { timeout: 5_000 })
		expect(interactive()).toBe(1)
		expect(
			provider.postMessageToWebview.mock.calls.filter(([message]) => message?.type === "interactionRequired"),
		).toHaveLength(1)

		task.approveAsk()
		const result = await askPromise
		expect(result.response).toBe("yesButtonClicked")
		expect(queue.messages).toHaveLength(1)
		expect(queue.hasUnclaimed()).toBe(true)
	})

	it("settles ask() and releases the claim when the task aborts while the drain re-check is pending", async () => {
		// The drain's fresh policy read ends in an uncancellable
		// `provider.getState()`. With that read pending, an abort must not
		// leave `ask()` riding it: the abort race settles the re-check, the
		// re-check's finally releases the claim, and `ask()` rejects at the
		// post-abort throw.
		state.alwaysDenyUnapprovedCommands = false

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		const addToClineMessages = recordClineMessages(task)

		let getStateCalls = 0
		provider.getState = () => {
			getStateCalls++
			if (getStateCalls >= 2) {
				// The drain-site re-check never settles: nothing resolves it,
				// only the abort race ends the ask's dependence on it.
				return new Promise<Partial<ExtensionState>>(() => {})
			}
			return Promise.resolve(state)
		}

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval")

		const askPromise = task.ask("command", "rm x", false)
		await vi.waitFor(() => expect(addToClineMessages).toHaveBeenCalledTimes(1))
		// The message arriving during the dwell routes the re-check through the
		// drain site, where the provisional claim and the pending read live.
		queue.addMessage("queued during the dwell")
		await vi.waitFor(() => expect(getStateCalls).toBe(2))
		expect(queue.hasUnclaimed()).toBe(false)

		task["abort"] = true

		// `ask()` must reject on abort; racing a deadline distinguishes a wrong
		// settle from a hang on the pending read.
		const outcome = await Promise.race([
			askPromise.then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("deadline-exceeded"), 3_000)),
		])
		expect(outcome).toContain("aborted")

		// The claim releases from the re-check's finally once the abort race
		// settles it, so a later consumer can take the message.
		await vi.waitFor(() => expect(queue.hasUnclaimed()).toBe(true))

		// The abort watcher must not keep polling past the settle.
		const intervals = setIntervalSpy.mock.results.map((result) => result.value)
		expect(intervals.length).toBeGreaterThan(0)
		for (const interval of intervals) {
			expect(clearIntervalSpy.mock.calls.some(([cleared]) => cleared === interval)).toBe(true)
		}
		setIntervalSpy.mockRestore()
		clearIntervalSpy.mockRestore()
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

	it("does not emit TaskInteractive or retain the armed timer when the task aborts during the 2 s window", async () => {
		// A status timer armed for 2 s can outlive an abort that lands inside
		// its window: the ask then throws without ever reaching the response
		// handling, and a live webview would still receive
		// `interactionRequired` for a task that no longer runs. Two independent
		// defenses are pinned: the callbacks' fire-time liveness check, exercised
		// by invoking the captured callback after the rejection (the sub-tick
		// race where an already-due timer fires before the teardown sweep cannot
		// be interleaved deterministically on the real clock), and the
		// `finally`-sweep, exercised by the clearTimeout handle inventory.
		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		recordClineMessages(task)
		const interactive = installInteractiveEmitRecorder(task)
		queue.addMessage("feedback on the denied command")

		const denied = await task.ask("command", "rm x", false)
		expect(denied.response).toBe("noButtonClicked")

		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")

		const toolAsk = task.ask("tool", JSON.stringify({ tool: "write_to_file", path: "a.txt" }), false)
		// The latch-release arm is the only >= 2 s timer this ask can create
		// (the wait's own poller schedules 100 ms handles), so the exact-delay
		// filter isolates the status-timer handle without fake timers.
		const armedArms = () =>
			setTimeoutSpy.mock.calls
				.map(([callback, delay], i) => ({ callback, delay, handle: setTimeoutSpy.mock.results[i].value }))
				.filter((entry) => entry.delay === 2_000)
		await vi.waitFor(() => expect(armedArms().length).toBe(1), { timeout: 6_000 })
		const armedAt = Date.now()

		// Abort while the window is still open, shortly after the arm: the
		// longer this wait runs, the less event-loop-stall slack is left before
		// the 2 s timer could legitimately fire while the task is still live.
		await vi.waitFor(() => expect(Date.now() - armedAt).toBeGreaterThanOrEqual(300), { timeout: 2_000 })
		task["abort"] = true

		const outcome = await toolAsk.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		)
		expect(outcome).toContain("aborted")

		// Fire-time guard pin: the captured armed callback, invoked synchronously
		// after the rejection, must decline on its own — clearing covers only
		// timers that had not fired yet when the sweep ran.
		const [armed] = armedArms()
		armed.callback()
		expect(interactive()).toBe(0)
		expect(
			provider.postMessageToWebview.mock.calls.filter(([message]) => message?.type === "interactionRequired"),
		).toHaveLength(0)

		// Behavior pin: past the window the timer would have needed, nothing
		// fires on its own either.
		await vi.waitFor(() => expect(Date.now() - armedAt).toBeGreaterThan(2_500), { timeout: 6_000 })
		expect(interactive()).toBe(0)
		expect(
			provider.postMessageToWebview.mock.calls.filter(([message]) => message?.type === "interactionRequired"),
		).toHaveLength(0)

		// Ledger pin: every status-timer handle this ask armed was cleared, on
		// the throw path included.
		const clearedHandles = clearTimeoutSpy.mock.calls.map(([cleared]) => cleared)
		for (const { handle } of armedArms()) {
			expect(clearedHandles).toContain(handle)
		}

		setTimeoutSpy.mockRestore()
		clearTimeoutSpy.mockRestore()
	})

	it("auto-approves a policy-approved tool ask while the latch leaves the queue for later", async () => {
		// The latch is a reason not to claim, not a reason to claim-and-release:
		// a claim forces the `ask` decision before the policy runs, so a
		// `read_file` that `alwaysAllowReadOnly` auto-approves would sit waiting
		// for a user who has nothing to decide, stalling a hands-free session.
		// The policy must decide as if the queue were empty, and the message the
		// denial left behind must stay unclaimed for a later turn.
		state.alwaysAllowReadOnly = true

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		queue.addMessage("feedback on the denied command")

		const denied = await task.ask("command", "rm x", false)
		expect(denied.response).toBe("noButtonClicked")
		expect(task["blanketDeniedCommandThisTurn"]).toBe(true)

		// Race a deadline against the ask: with a claim-forced prompt the ask
		// stays pending forever, and a hang must read as a failure, not a pass.
		const outcome = await Promise.race([
			task.ask("tool", JSON.stringify({ tool: "readFile", path: "a.txt" }), false),
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 1_500)),
		])
		expect(outcome).not.toBe("pending")
		const result = outcome as Awaited<ReturnType<Task["ask"]>>
		// Approved through policy, not through the queued message: the result
		// carries no feedback text, and the message survives unclaimed.
		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect(result.queuedMessageId).toBeUndefined()
		expect(queue.messages).toHaveLength(1)
		expect(queue.hasUnclaimed()).toBe(true)
	})

	it("settles ask() and releases the claim when the task aborts while the immediate re-check is pending", async () => {
		// The immediate site's fresh policy read ends in the same uncancellable
		// `provider.getState()` as the drain site's. With the claim held and the
		// read pending before the wait even starts, an abort must settle the
		// re-check through the abort race, release the claim from its `finally`,
		// tear the watcher down, and reject `ask()`.
		state.alwaysDenyUnapprovedCommands = false

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		queue.addMessage("queued before the ask begins")

		let getStateCalls = 0
		provider.getState = () => {
			getStateCalls++
			if (getStateCalls >= 2) {
				// The immediate-site re-check never settles: nothing resolves it,
				// only the abort race ends the ask's dependence on it.
				return new Promise<Partial<ExtensionState>>(() => {})
			}
			return Promise.resolve(state)
		}

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval")

		const askPromise = task.ask("command", "rm x", false)
		await vi.waitFor(() => expect(getStateCalls).toBe(2))
		expect(queue.hasUnclaimed()).toBe(false)

		task["abort"] = true

		// `ask()` must reject on abort; racing a deadline distinguishes a wrong
		// settle from a hang on the pending read.
		const outcome = await Promise.race([
			askPromise.then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("deadline-exceeded"), 3_000)),
		])
		expect(outcome).toContain("aborted")

		// The claim releases from the re-check's finally once the abort race
		// settles it, so a later consumer can take the message.
		await vi.waitFor(() => expect(queue.hasUnclaimed()).toBe(true))

		// The abort watcher must not keep polling past the settle.
		const intervals = setIntervalSpy.mock.results.map((result) => result.value)
		expect(intervals.length).toBeGreaterThan(0)
		for (const interval of intervals) {
			expect(clearIntervalSpy.mock.calls.some(([cleared]) => cleared === interval)).toBe(true)
		}
		setIntervalSpy.mockRestore()
		clearIntervalSpy.mockRestore()
	})

	it("never consults the policy when the fresh-state read lands after the abort", async () => {
		// An abort must settle the re-check itself, not merely win a race against
		// it: a re-check left pending on the uncancellable read retains the task
		// and, when the read finally lands with the blanket deny engaged, runs
		// `checkAutoApproval` post-abort. Here the read resolves only after the
		// abort, with deny now ON — the settled re-check must not take it
		// through the policy, and the claimed message must stay unconsumed.
		state.alwaysDenyUnapprovedCommands = false
		const checkAutoApprovalSpy = vi.spyOn(autoApprovalModule, "checkAutoApproval")

		let resolveLateState: (() => void) | undefined
		let getStateCalls = 0
		provider.getState = () => {
			getStateCalls++
			if (getStateCalls >= 2) {
				// The immediate-site re-check's fresh read stays pending until the
				// test releases it, past the abort, with the policy engaged.
				return new Promise<Partial<ExtensionState>>((resolve) => {
					resolveLateState = () => {
						state.alwaysDenyUnapprovedCommands = true
						resolve(state)
					}
				})
			}
			return Promise.resolve(state)
		}

		const task = buildTask(provider, TASK_CWD)
		const queue = await attachQueue(task)
		queue.addMessage("queued before the ask begins")

		const askPromise = task.ask("command", "rm x", false)
		await vi.waitFor(() => expect(getStateCalls).toBe(2))
		expect(queue.hasUnclaimed()).toBe(false)

		task["abort"] = true

		// `ask()` must reject on abort; racing a deadline distinguishes a wrong
		// settle from a hang on the pending read.
		const outcome = await Promise.race([
			askPromise.then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("deadline-exceeded"), 3_000)),
		])
		expect(outcome).toContain("aborted")

		// The uncancellable read lands only now — the settled re-check must have
		// detached from it, so its continuation never reaches the policy.
		resolveLateState!()
		await vi.waitFor(() => expect(queue.hasUnclaimed()).toBe(true))
		// Past a full abort-watcher poll: enough for any retained continuation
		// of the late read to have run and been caught by the spy.
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(checkAutoApprovalSpy).not.toHaveBeenCalled()
		// No post-abort consume: the message survives, unclaimed, for a later
		// consumer.
		expect(queue.messages).toHaveLength(1)
		expect(queue.hasUnclaimed()).toBe(true)
		checkAutoApprovalSpy.mockRestore()
	})
})
