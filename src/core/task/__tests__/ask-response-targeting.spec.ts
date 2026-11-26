import { Task } from "../Task"
import { setAbortLatch } from "../../../test-utils/run-state"

// A response event that arrives while no ask is awaiting (an orphan click between
// asks, or during the ask's entry window after the slot reset and before the wait
// is armed) must never answer that ask. Each blocking ask waits for a response
// that arrives while the ask itself is the awaiting one.

type ProviderStub = {
	getState: () => Promise<{
		autoApprovalEnabled: boolean
		alwaysAllowExecute: boolean
		allowedCommands: string[]
		deniedCommands: string[]
	}>
	postMessageToWebview: ReturnType<typeof vi.fn>
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
	awaitingAskTarget: number | undefined
	askResponseTargetSeq: number
	lastMessageTs: number | undefined
	addToClineMessages: ReturnType<typeof vi.fn>
	saveClineMessages: () => Promise<unknown>
	updateClineMessage: () => Promise<unknown>
	cancelAutoApprovalTimeout: () => void
	checkpointSave: () => Promise<unknown>
	emit: (event: string, ...args: unknown[]) => void
	providerRef: { deref: () => ProviderStub | undefined }
	messageQueueService?: { isEmpty: () => boolean }
}

function buildTask(provider: ProviderStub | undefined) {
	const task = Object.create(Task.prototype) as Task
	setAbortLatch(task, false)
	const access = task as unknown as AskTargetingTaskAccess
	// Object.create skips class-field initializers, so the response-slot fields
	// must be seeded here.
	access.askResponseTargetSeq = 0
	access.awaitingAskTarget = undefined
	access.askResponseTarget = undefined
	access.clineMessages = []
	access.askResponse = undefined
	access.lastMessageTs = undefined
	access.addToClineMessages = vi.fn(async () => {})
	access.saveClineMessages = vi.fn(async () => {})
	access.updateClineMessage = vi.fn(async () => {})
	access.cancelAutoApprovalTimeout = vi.fn(() => {})
	access.checkpointSave = vi.fn(async () => {})
	access.emit = vi.fn()
	access.providerRef = { deref: () => provider }

	return task
}

async function attachQueue(task: Task) {
	const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
	;(task as unknown as AskTargetingTaskAccess).messageQueueService = new MessageQueueService()
}

function stubProvider(): ProviderStub {
	return {
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
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
	it("does not answer an ask with a response that arrived during its entry window", async () => {
		const provider = stubProvider()
		const task = buildTask(provider)
		await attachQueue(task)
		const access = task as unknown as AskTargetingTaskAccess

		// The message-add await is the ask's entry window: the slot reset already
		// ran, the wait is not armed yet, and no prompt is visible to answer.
		let releaseEntry: (() => void) | undefined
		access.addToClineMessages = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseEntry = resolve
				}),
		)

		const askPromise = task.ask("command", "echo hi", false)

		// Wait until the ask is inside its entry window (the message-add await).
		await vi.waitFor(() => {
			if (access.addToClineMessages.mock.calls.length === 0) {
				throw new Error("entry await not reached")
			}
		})

		// A stale duplicate click fires while the ask is between reset and arm.
		task.handleWebviewAskResponse("yesButtonClicked")
		releaseEntry!()

		// Give the machinery several wait polls. The ask must still be waiting:
		// the orphan response must not satisfy it.
		let answeredEarly = false
		const answered = askPromise
			.then(() => {
				answeredEarly = true
				return "answered"
			})
			.catch(() => "thrown")
		const outcome = await Promise.race([answered, tick().then(() => tick().then(() => "waiting"))])

		expect(outcome).toBe("waiting")
		expect(answeredEarly).toBe(false)

		// The ask settles only on a response that arrives while it is the awaiting one.
		setTimeout(() => {
			task.approveAsk()
		}, 0)
		await askPromise
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
})
