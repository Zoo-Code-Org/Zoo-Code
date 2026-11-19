// npx vitest run core/task/__tests__/background-mistake-limit.spec.ts

import { type ExtensionState, providerIdentifiers } from "@roo-code/types"

import { Task } from "../Task"
import { setAbortLatch } from "../../../test-utils/run-state"

// F-08 regression: a background (read-only) child that reaches the consecutive
// mistake limit must end its run loop instead of auto-answering the
// mistake_limit_reached ask, resetting the counter, and looping forever while
// holding a scheduler permit. The ask resolves by policy (D4), then
// requestAbort(true) + throw terminates the run. The throw lands OUTSIDE the
// didEndLoop try, so it is swallowed by startTask's abandoned/abort catch (not
// the didEndLoop catch), run() settles, and the host's run-settled catch-all
// settles the child handle.

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

/** The parts of the provider that `Task.ask` reaches for. */
type ProviderStub = {
	getState: () => Promise<Partial<ExtensionState>>
	postMessageToWebview: ReturnType<typeof vi.fn>
	postStateToWebviewWithoutTaskHistory: ReturnType<typeof vi.fn>
	getSkillsManager: () => undefined
	cwd: string
}

const TASK_CWD = "/path/to/task-workspace"

function buildTask(provider: ProviderStub, isBackgroundChild: boolean) {
	const task = Object.create(Task.prototype) as Task
	setAbortLatch(task, false)
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
	// driveRunEvent's reducer inputs; divergence reporting stays disabled.
	// (Both fields are readonly at compile time; defineProperty assigns them.)
	Object.defineProperty(task, "runRejections", { value: new Set() })
	Object.defineProperty(task, "reportedDivergences", { value: new Set() })
	task["consecutiveMistakeLimit"] = 3
	task["consecutiveMistakeCount"] = 3
	// A double assertion is unavoidable here: `providerRef` is a `WeakRef<ClineProvider>`,
	// and the stub is neither a `WeakRef` nor a whole `ClineProvider`. Constructing
	// either would drag in the extension host, when these seams only ever call
	// `deref()`, `getState()` and `postMessageToWebview()` on it.
	task["providerRef"] = { deref: () => provider } as unknown as Task["providerRef"]
	Object.defineProperty(task, "workspacePath", { value: TASK_CWD })
	Object.defineProperty(task, "isBackgroundSubtaskChild", { value: isBackgroundChild })
	return task
}

async function attachQueue(task: Task) {
	const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
	const queue = new MessageQueueService()
	Object.defineProperty(task, "messageQueueService", { value: queue })
	return queue
}

describe("background child mistake limit is terminal (F-08)", () => {
	let provider: ProviderStub

	beforeEach(() => {
		// Auto-approval off: the mistake_limit_reached ask resolves `ask`, which
		// is exactly the decision the D4 seam intercepts for a background child.
		provider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			getSkillsManager: () => undefined,
			cwd: TASK_CWD,
			getState: async () => ({ autoApprovalEnabled: false }),
		}
	})

	it("ends the run loop instead of resetting the counter and retrying", async () => {
		const task = buildTask(provider, true)
		await attachQueue(task)

		// The throw rejects the run promise; startTask's catch swallows it
		// because requestAbort(true) already set the abandoned/abort latches
		// (the same idiom as the loop's own abort guard), so run() settles
		// instead of looping. Pre-F-08 the iteration continued: the counter was
		// reset and a fresh API request started, forever.
		await expect(task.recursivelyMakeClineRequests([{ type: "text", text: "keep going" }])).rejects.toThrow(
			"reached the consecutive mistake limit",
		)
		// The loop was terminated, not merely breakable: the abort latch is set
		// (requestAbort(true)) so no further iteration can start.
		expect(task.abandoned).toBe(true)
		expect(task.abort).toBe(true)
		// Terminal without any user-visible row: the ask resolved by policy.
		expect(task["addToClineMessages"]).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		// The counter reset below the limit check never ran.
		expect(task["consecutiveMistakeCount"]).toBe(3)
	})

	it("never reaches the next API request seam", async () => {
		const task = buildTask(provider, true)
		await attachQueue(task)
		task["maybeWaitForProviderRateLimit"] = vi.fn(async () => {})

		await expect(task.recursivelyMakeClineRequests([{ type: "text", text: "keep going" }])).rejects.toThrow(
			"reached the consecutive mistake limit",
		)

		expect(task["maybeWaitForProviderRateLimit"]).not.toHaveBeenCalled()
	})

	it("does not engage for a non-background task", async () => {
		const task = buildTask(provider, false)
		await attachQueue(task)
		task["apiConfiguration"] = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
		} as Task["apiConfiguration"]
		// A non-background task blocks on the real ask; stand in the user's
		// decline so the flow reaches the counter reset, then blow up at the
		// next seam to prove execution continued past the limit check.
		task.ask = vi.fn(async () => ({ response: "noButtonClicked" as const }))
		task["requestAbort"] = vi.fn()
		const sentinel = new Error("sentinel: reached the post-limit request path")
		task["maybeWaitForProviderRateLimit"] = vi.fn(async () => {
			throw sentinel
		})

		// The sentinel propagates the same way the terminal throw does (both
		// land outside the didEndLoop try) — but no abort was requested and the
		// counter was reset, i.e. the non-background flow is untouched.
		await expect(task.recursivelyMakeClineRequests([{ type: "text", text: "keep going" }])).rejects.toThrow(
			"sentinel: reached the post-limit request path",
		)
		expect(task["requestAbort"]).not.toHaveBeenCalled()
		expect(task.abandoned).not.toBe(true)
		expect(task["consecutiveMistakeCount"]).toBe(0)
		expect(task["maybeWaitForProviderRateLimit"]).toHaveBeenCalledTimes(1)
	})
})
