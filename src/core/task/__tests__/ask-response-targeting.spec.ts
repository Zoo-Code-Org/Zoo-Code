import { Task } from "../Task"
import { RooCodeEventName } from "@roo-code/types"
import { setAbortLatch } from "../../../test-utils/run-state"

// A response event must answer only the ask that is armed when it arrives.
// Arrivals while no ask awaits (an orphan click between asks) are discarded by
// the entry reset. An arrival during the ask's own row publication carries the
// ask's token, because the ask arms before it publishes, and resolves it.

type ProviderStub = {
	getState: () => Promise<{
		autoApprovalEnabled: boolean
		alwaysAllowExecute: boolean
		allowedCommands: string[]
		deniedCommands: string[]
	}>
	postMessageToWebview: ReturnType<typeof vi.fn>
	postStateToWebviewThrottled: ReturnType<typeof vi.fn>
	flushPostStateToWebviewThrottled: ReturnType<typeof vi.fn>
}

type AskRow = {
	type: string
	ask?: string
	partial?: boolean
	text?: string
	isAnswered?: boolean
	ts: number
}

type AskTargetingTaskAccess = {
	clineMessages: AskRow[]
	askResponse: string | undefined
	askResponseTarget: number | undefined
	askResponseTargetRowTs: number | undefined
	awaitingAskTarget: number | undefined
	awaitingAskTargetRowTs: number | undefined
	askResponseTargetSeq: number
	lastMessageTs: number | undefined
	addToClineMessages: (message: unknown, beforeEmit?: () => void) => Promise<unknown>
	saveClineMessages: () => Promise<unknown>
	updateClineMessage: () => Promise<unknown>
	cancelAutoApprovalTimeout: () => void
	checkpointSave: () => Promise<unknown>
	emit: (event: string, ...args: unknown[]) => void
	providerRef: { deref: () => ProviderStub | undefined }
	messageQueueService?: { isEmpty: () => boolean }
	nextAskTarget: () => number
}

const trackedTasks: Task[] = []
const trackedAsks: Promise<unknown>[] = []

function buildTask(provider: ProviderStub | undefined) {
	const task = Object.create(Task.prototype) as Task
	trackedTasks.push(task)
	setAbortLatch(task, false)
	const access = task as unknown as AskTargetingTaskAccess
	// Object.create skips class-field initializers, so the response-slot fields
	// must be seeded here.
	access.askResponseTargetSeq = 0
	access.awaitingAskTarget = undefined
	access.awaitingAskTargetRowTs = undefined
	access.askResponseTarget = undefined
	access.askResponseTargetRowTs = undefined
	access.clineMessages = []
	access.askResponse = undefined
	access.lastMessageTs = undefined
	access.addToClineMessages = vi.fn(async (_message: unknown, beforeEmit?: () => void) => {
		// The mock stands in for the publication boundary, so it must run the
		// arm hook the real method runs just before its Message event.
		beforeEmit?.()
	})
	access.saveClineMessages = vi.fn(async () => {})
	access.updateClineMessage = vi.fn(async () => {})
	access.cancelAutoApprovalTimeout = vi.fn(() => {})
	access.checkpointSave = vi.fn(async () => {})
	access.emit = vi.fn()
	access.providerRef = { deref: () => provider }

	// Track every ask promise so the afterEach can settle a poll that a
	// failed assertion leaves waiting.
	const realAsk = task.ask.bind(task)
	;(
		task as unknown as {
			ask: (...args: Parameters<Task["ask"]>) => ReturnType<Task["ask"]>
		}
	).ask = (...args) => {
		const promise = realAsk(...args)
		trackedAsks.push(promise.catch(() => undefined))
		return promise
	}

	return task
}

async function attachQueue(task: Task) {
	const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
	;(task as unknown as AskTargetingTaskAccess).messageQueueService = new MessageQueueService()
}

function stubProvider(): ProviderStub {
	return {
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
		flushPostStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
		getState: async () => ({
			autoApprovalEnabled: false,
			alwaysAllowExecute: false,
			allowedCommands: [],
			deniedCommands: [],
		}),
	}
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("ask response targeting", () => {
	// A failed assertion leaves the ask's poll running: the wait returns only
	// on abort, a moved ts, or a matching response. Abort every tracked task
	// and settle every ask promise so a pending ask does not outlive its
	// test, even on a failing run (review 6084536709).
	afterEach(async () => {
		for (const task of trackedTasks.splice(0)) {
			setAbortLatch(task, true)
		}
		await Promise.allSettled(trackedAsks.splice(0))
	})

	it("resolves an ask answered by a created Message listener during publication", async () => {
		const provider = stubProvider()
		const task = buildTask(provider)
		await attachQueue(task)
		const access = task as unknown as AskTargetingTaskAccess

		// The row's publication boundary: addToClineMessages flushes the row to
		// the webview, arms the ask's token (the beforeEmit hook), then emits
		// the `created` Message event. A listener that answers at that event
		// tags with this ask's token and must resolve it. The wrapper binds the
		// real publication so the beforeEmit hook actually runs.
		const realAdd = (
			Task.prototype as unknown as {
				addToClineMessages: (message: unknown, beforeEmit?: () => void) => Promise<unknown>
			}
		).addToClineMessages.bind(task)
		access.addToClineMessages = (message: unknown, beforeEmit?: () => void) =>
			realAdd(message, () => {
				beforeEmit?.()
				task.handleWebviewAskResponse("yesButtonClicked")
			})

		const askPromise = task.ask("command", "echo hi", false)
		const answered = askPromise.then(
			() => "answered" as const,
			() => "thrown" as const,
		)
		const outcome = await Promise.race([
			answered,
			tick()
				.then(() => tick())
				.then(() => tick())
				.then(() => tick())
				.then(() => "waiting" as const),
		])

		expect(outcome).toBe("answered")

		const result = await askPromise
		expect(result.response).toBe("yesButtonClicked")
	})

	it("does not answer the next ask with an orphan left by the previous one", async () => {
		const provider = stubProvider()
		const task = buildTask(provider)
		await attachQueue(task)

		const firstAsk = task.ask("command", "echo one", false)
		setTimeout(() => {
			task.approveAsk()
		}, 0)
		await firstAsk

		// The duplicate click event of the same physical action delivers now:
		// the previous ask already consumed its response and nothing awaits.
		task.handleWebviewAskResponse("yesButtonClicked")

		const secondAsk = task.ask("command", "echo two", false)
		let answeredEarly = false
		const answered = secondAsk
			.then(() => {
				answeredEarly = true
				return "answered"
			})
			.catch(() => "thrown")
		const outcome = await Promise.race([
			answered,
			tick().then(() => tick().then(() => tick().then(() => "waiting"))),
		])

		// The entry reset already discards the orphan when the next ask starts,
		// so this holds on the unfixed code too. It pins the contract end to end.
		expect(outcome).toBe("waiting")
		expect(answeredEarly).toBe(false)

		setTimeout(() => {
			task.approveAsk()
		}, 0)
		await secondAsk
	})

	it("keeps a newer ask's armed token when a superseded ask cleans up", async () => {
		const provider = stubProvider()
		const task = buildTask(provider)
		await attachQueue(task)
		const access = task as unknown as AskTargetingTaskAccess

		const firstAsk = task
			.ask("command", "echo one", false)
			.catch((error: unknown) => (String(error).includes("superseded") ? "superseded" : `other:${String(error)}`))

		// Ask 1 is armed once its token is minted and its wait runs.
		await vi.waitFor(() => {
			if (access.awaitingAskTarget === undefined) {
				throw new Error("ask 1 not armed yet")
			}
		})

		// A superseding ask 2 races in: its entry reset bumps lastMessageTs and
		// its arm lands while ask 1 is still winding down, because both sides
		// await. This is the exact interleaving under review; both effects are
		// applied here so the poll scheduling cannot dodge them.
		access.lastMessageTs = Date.now()
		const secondToken = access.nextAskTarget()
		access.awaitingAskTarget = secondToken

		// Ask 1's poll observes the supersession and runs its superseded-ask
		// cleanup. That cleanup must clear only a token that still belongs to
		// ask 1, never the newer ask's arm. The window spans one 100ms poll
		// interval, so a 400ms cap settles it deterministically.
		const outcome = await Promise.race([
			firstAsk,
			new Promise((resolve) => setTimeout(resolve, 400)).then(() => "pending" as const),
		])
		expect(outcome).toBe("superseded")
		expect(access.awaitingAskTarget).toBe(secondToken)
	})

	it("does not stamp the command ask answered when the arrival is an orphan", async () => {
		const provider = stubProvider()
		const task = buildTask(provider)
		await attachQueue(task)
		const access = task as unknown as AskTargetingTaskAccess

		access.clineMessages = [{ type: "ask", ask: "command", ts: 1, isAnswered: undefined, partial: undefined }]
		// Nothing is armed: the arrival tags as an orphan that the pending ask's
		// wait will discard, so the row must keep its Run/Deny controls.
		access.awaitingAskTarget = undefined

		task.handleWebviewAskResponse("yesButtonClicked")

		expect(access.clineMessages[0]!.isAnswered).toBeUndefined()
		expect(access.updateClineMessage).not.toHaveBeenCalled()
		expect(access.saveClineMessages).not.toHaveBeenCalled()
	})

	it("stamps the command ask answered when the arrival carries the armed token", async () => {
		const provider = stubProvider()
		const task = buildTask(provider)
		await attachQueue(task)
		const access = task as unknown as AskTargetingTaskAccess

		access.clineMessages = [{ type: "ask", ask: "command", ts: 1, isAnswered: undefined, partial: undefined }]
		access.awaitingAskTarget = 7
		// The arm records the owning row; the stamp settles that row.
		access.awaitingAskTargetRowTs = 1

		task.handleWebviewAskResponse("yesButtonClicked")

		expect(access.clineMessages[0]!.isAnswered).toBe(true)
	})

	it("stamps only the command row that owns the arrival's target", async () => {
		const provider = stubProvider()
		const task = buildTask(provider)
		await attachQueue(task)
		const access = task as unknown as AskTargetingTaskAccess

		// Ask A is armed; a newer command ask B's row already sits unanswered
		// in the history while B is inside its publication. A recency
		// predicate would settle B and hide its Run/Deny with no resolution
		// coming; ownership settles A.
		const olderRow = { type: "ask", ask: "command", ts: 1, isAnswered: undefined, partial: undefined }
		const newerRow = { type: "ask", ask: "command", ts: 2, isAnswered: undefined, partial: undefined }
		access.clineMessages = [olderRow, newerRow]
		access.awaitingAskTarget = 7
		access.awaitingAskTargetRowTs = 1

		task.handleWebviewAskResponse("yesButtonClicked")

		expect(olderRow.isAnswered).toBe(true)
		expect(newerRow.isAnswered).toBeUndefined()
		expect(access.updateClineMessage).toHaveBeenCalledTimes(1)
		expect(access.updateClineMessage).toHaveBeenCalledWith(olderRow)
	})

	it("does not resolve the completed partial ask from a response that lands during its save", async () => {
		const provider = stubProvider()
		const task = buildTask(provider)
		await attachQueue(task)
		const access = task as unknown as AskTargetingTaskAccess

		// The streaming partial row the completion path updates in place.
		access.clineMessages = [{ type: "ask", ask: "command", ts: 11, partial: true, text: "ec" }]
		// Park the completion path inside its save await: the window where a
		// delayed previous-command approval would be processed.
		let releaseSave: (() => void) | undefined
		access.saveClineMessages = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseSave = resolve
				}),
		)

		const askPromise = task.ask("command", "echo hi", false)
		const settled = askPromise.then(
			() => "answered" as const,
			() => "thrown" as const,
		)
		await vi.waitFor(() => {
			if (!releaseSave) {
				throw new Error("save not parked yet")
			}
		})

		// The previous command's approval is processed inside the save window.
		task.handleWebviewAskResponse("yesButtonClicked")
		releaseSave!()

		// The completed ask must not consume it: the ask arms only after its
		// publication, so the save-window arrival is an orphan.
		const raced = await Promise.race([
			settled,
			tick()
				.then(() => tick())
				.then(() => tick())
				.then(() => "waiting" as const),
		])
		expect(raced).toBe("waiting")

		// A separate approval after the publication resolves the ask and
		// stamps the row it owns.
		setTimeout(() => {
			task.approveAsk()
		}, 0)
		expect(await askPromise).toMatchObject({ response: "yesButtonClicked" })
		expect(access.clineMessages[0]!.isAnswered).toBe(true)
	})

	it("keeps the newer ask's armed token when an older publication completes late", async () => {
		const provider = stubProvider()
		const task = buildTask(provider)
		await attachQueue(task)
		const access = task as unknown as AskTargetingTaskAccess

		// Park the first ask inside its publication: its beforeEmit arm hook
		// has not run yet.
		let releaseFirstPublication: (() => void) | undefined
		let firstPublicationParked = false
		access.addToClineMessages = async (_message: unknown, beforeEmit?: () => void) => {
			if (!firstPublicationParked) {
				firstPublicationParked = true
				await new Promise<void>((resolve) => {
					releaseFirstPublication = resolve
				})
			}
			beforeEmit?.()
		}

		const firstAsk = task.ask("command", "echo one", false).then(
			() => "answered" as const,
			() => "thrown" as const,
		)
		try {
			await vi.waitFor(() => {
				if (!releaseFirstPublication) {
					throw new Error("first publication not parked yet")
				}
			})

			// A newer ask races in and completes its publication: its token is
			// armed and lastMessageTs has moved to the newer ask.
			const secondAsk = task.ask("command", "echo two", false)
			await vi.waitFor(() => {
				if (access.awaitingAskTarget === undefined) {
					throw new Error("second ask not armed yet")
				}
			})
			const secondToken = access.awaitingAskTarget

			// The older publication resumes. Its arm must be skipped (the ask is
			// superseded), or it would steal the newer arm and the superseded
			// cleanup would wipe it, leaving the newer ask with no armed target.
			releaseFirstPublication!()
			const firstOutcome = await Promise.race([
				firstAsk,
				new Promise((resolve) => setTimeout(resolve, 400)).then(() => "pending" as const),
			])
			expect(firstOutcome).toBe("thrown")
			expect(access.awaitingAskTarget).toBe(secondToken)

			// The newer ask still answers with its own approval.
			setTimeout(() => {
				task.approveAsk()
			}, 0)
			expect(await secondAsk).toMatchObject({ response: "yesButtonClicked" })
		} finally {
			// The afterEach abort latch cannot unblock a publication parked on
			// this deferred: release it here so cleanup can settle the tracked
			// asks even when an earlier assertion fails (review 6087624965).
			releaseFirstPublication?.()
		}
	})

	it("emits TaskInteractive when the ask stays pending past the two-second delay", async () => {
		const provider = stubProvider()
		const task = buildTask(provider)
		await attachQueue(task)
		const access = task as unknown as AskTargetingTaskAccess & {
			findMessageByTimestamp: ReturnType<typeof vi.fn>
		}
		access.findMessageByTimestamp = vi.fn((ts: number) => ({ ts, type: "ask", ask: "command", text: "echo hi" }))
		const events: string[] = []
		access.emit = vi.fn((event: string) => {
			events.push(event)
		})

		const askPromise = task.ask("command", "echo hi", false)
		await vi.waitFor(() => {
			if (access.awaitingAskTarget === undefined) {
				throw new Error("ask not armed yet")
			}
		})

		// The interactive notification arms 2s after the ask blocks; the ask
		// stays pending across that delay here.
		await new Promise((resolve) => setTimeout(resolve, 2300))

		expect(events).toContain(RooCodeEventName.TaskInteractive)

		setTimeout(() => {
			task.approveAsk()
		}, 0)
		await askPromise
	}, 15000)
})
