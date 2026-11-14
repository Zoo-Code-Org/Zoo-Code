// pnpm --dir src exec vitest run core/task/__tests__/Task.idle-condense.spec.ts
import type { ClineAsk, ClineMessage, ModelInfo, TokenUsage } from "@roo-code/types"

import type { ContextManagementResult } from "../../context-management"
import type { ApiMessage } from "../../task-persistence/apiMessages"

import { Task } from "../Task"

const MODEL_INFO: ModelInfo = {
	contextWindow: 1_000,
	supportsImages: false,
	supportsPromptCache: false,
	inputPrice: 0,
	outputPrice: 0,
}

type StateStub = Partial<{
	idleCondenseContext: boolean
	idleCondenseContextPercent: number
	idleCondenseTimeInSeconds: number
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	profileThresholds: Record<string, number>
	profileIdleThresholds: Record<string, number>
	profileIdleCondenseTimes: Record<string, number>
	currentApiConfigName: string
	listApiConfigMeta: Array<{ id: string; name: string }>
}>

const baseState = (overrides: StateStub = {}): StateStub => ({
	idleCondenseContext: true,
	idleCondenseContextPercent: 50,
	idleCondenseTimeInSeconds: 30,
	autoCondenseContext: true,
	autoCondenseContextPercent: 100,
	profileThresholds: {},
	profileIdleThresholds: {},
	profileIdleCondenseTimes: {},
	...overrides,
})

const tokenUsage = (contextTokens: number): TokenUsage => ({
	totalTokensIn: 0,
	totalTokensOut: 0,
	totalCost: 0,
	contextTokens,
})

// Mirrors the private CondenseContextResult shape returned by condenseContextWithLease.
type CondenseStubResult = {
	condensed: boolean
	error?: string
	newContextTokens?: number
	prevContextTokens: number
}

// Timestamp of the follow-up ask buildTask seeds so the task is idle-eligible.
const PENDING_ASK_TS = 1

function buildTask({
	state = baseState(),
	contextTokens = 600,
	modelInfo = MODEL_INFO,
	isCurrentTask = true,
	providerExists = true,
}: {
	state?: StateStub
	contextTokens?: number
	modelInfo?: ModelInfo
	isCurrentTask?: boolean
	providerExists?: boolean
} = {}) {
	const task = Object.create(Task.prototype) as Task

	// Context window is 1_000, so contextTokens 600 => 60% full.
	// Mirrors condenseContextWithLease: the idle caller passes an
	// onLeaseAcquired callback (it posts the in-progress cue and re-checks
	// staleness), and a false verdict aborts before any summarization.
	const condense = vi.fn(async (onLeaseAcquired?: () => Promise<boolean>): Promise<CondenseStubResult> => {
		if (onLeaseAcquired && !(await onLeaseAcquired())) {
			return { condensed: false, prevContextTokens: contextTokens }
		}
		return { condensed: true, newContextTokens: 100, prevContextTokens: contextTokens }
	})

	const postMessageToWebview = vi.fn(async (_message: { type: string; text?: string }) => {})
	const getState = vi.fn(async () => state)
	const getCurrentTask = vi.fn(() => (isCurrentTask ? { taskId: "task-1" } : undefined))
	const provider = { getState, getCurrentTask, postMessageToWebview }

	// `abort` may be a prototype accessor, so assign defines an own writable
	// data property that shadows it instead of throwing on a getter-only set.
	Object.defineProperty(task, "abort", { value: false, configurable: true, writable: true })
	task["abandoned"] = false
	task["activeApiWork"] = 0
	// Object.create skips constructor field initialisers; mirror the defaults.
	task["lastActionWasCondense"] = false
	task["idleCondenseActivitySeq"] = 0
	task["idleCondenseExpiryEvaluating"] = false
	// The shared arming path only arms while an idle-eligible ask is pending,
	// so every task defaults to waiting on a complete follow-up. Tests that
	// need a different waiting state replace clineMessages/askResponse.
	task["lastMessageTs"] = PENDING_ASK_TS
	task["askResponse"] = undefined
	task["clineMessages"] = [
		{ ts: PENDING_ASK_TS, type: "ask", ask: "followup", text: "What should I do next?" } as ClineMessage,
	]
	// handleWebviewAskResponse marks the seeded follow-up answered and
	// persists; the harness must never touch real storage.
	task["saveClineMessages"] = vi.fn(async () => true)
	task["updateClineMessage"] = vi.fn(async () => {})
	Object.defineProperty(task, "taskId", { value: "task-1" })
	// Double providing only the provider members the idle-condense gate touches
	// (getCurrentTask and getState); the real ClineProvider surface is irrelevant here.
	task["providerRef"] = { deref: () => (providerExists ? provider : undefined) } as unknown as Task["providerRef"]
	task["getTokenUsage"] = vi.fn((): TokenUsage => tokenUsage(contextTokens))
	task["safeEnsureModelFetched"] = vi.fn(async (): Promise<ModelInfo> => modelInfo)
	// No getCondenseContextWindow on the stub: the gate uses the model's raw
	// contextWindow, so percent = 100 * contextTokens / 1000.
	Object.defineProperty(task, "api", {
		value: { getModel: () => ({ id: "test-model" }) },
	})
	task["apiConfiguration"] = {}
	task["condenseContextWithLease"] = condense

	return { task, getState, getCurrentTask, condense, postMessageToWebview }
}

// Ordered webview message types the idle condense emits for the in-progress cue.
const postedCueTypes = (postMessageToWebview: {
	mock: { calls: Array<[{ type: string; text?: string }]> }
}): string[] => postMessageToWebview.mock.calls.map(([message]) => message.type)

// Lease stub override: honors the onLeaseAcquired gate before returning `result`.
const leaseGated =
	(result: CondenseStubResult) =>
	async (onLeaseAcquired?: () => Promise<boolean>): Promise<CondenseStubResult> => {
		if (onLeaseAcquired && !(await onLeaseAcquired())) {
			return { condensed: false, prevContextTokens: 600 }
		}
		return result
	}

describe("Task idle condensing — evaluateIdleCondense", () => {
	test("builds the gate and clamps the idle threshold to the main threshold", async () => {
		const { task } = buildTask({
			state: baseState({ idleCondenseContextPercent: 90, autoCondenseContextPercent: 80 }),
		})

		const gate = await task["evaluateIdleCondense"]()

		expect(gate).toBeDefined()
		expect(gate?.idlePercent).toBe(80)
		expect(gate?.contextPercent).toBe(60)
		expect(gate?.idleSeconds).toBe(30)
	})

	test("returns undefined when the last action was a condense", async () => {
		const { task } = buildTask()
		task["lastActionWasCondense"] = true

		await expect(task["evaluateIdleCondense"]()).resolves.toBeUndefined()
	})

	test("defaults the idle threshold to 50 when unset", async () => {
		const { task } = buildTask({ state: baseState({ idleCondenseContextPercent: undefined }) })

		const gate = await task["evaluateIdleCondense"]()

		expect(gate?.idlePercent).toBe(50)
	})

	test("uses the profile idle threshold override for the current profile", async () => {
		// No listApiConfigMeta => the task profile id resolves to "default".
		const { task } = buildTask({ state: baseState({ profileIdleThresholds: { default: 20 } }) })

		const gate = await task["evaluateIdleCondense"]()

		expect(gate?.idlePercent).toBe(20)
	})

	// Two profiles whose idle threshold/delay overrides differ from each other
	// and from the global values, so a gate built from the wrong one is visible.
	const twoProfileState = () =>
		baseState({
			currentApiConfigName: "global-profile",
			listApiConfigMeta: [
				{ id: "profile-global", name: "global-profile" },
				{ id: "profile-child", name: "child-profile" },
			],
			profileThresholds: { "profile-global": 30, "profile-child": 70 },
			profileIdleThresholds: { "profile-global": 20, "profile-child": 40 },
			profileIdleCondenseTimes: { "profile-global": 5, "profile-child": 15 },
		})

	test("uses the task-local profile overrides when the task keeps another profile", async () => {
		const { task } = buildTask({ state: twoProfileState() })
		// A delegated child keeps the profile it was created with even though the
		// user has since switched the provider's current profile.
		task["taskApiConfigReady"] = Promise.resolve()
		task["_taskApiConfigName"] = "child-profile"

		const gate = await task["evaluateIdleCondense"]()

		// Threshold and delay come from profile-child (clamped by its own main
		// threshold 70), not the global profile's values.
		expect(gate?.idlePercent).toBe(40)
		expect(gate?.idleSeconds).toBe(15)
	})

	test("falls back to the provider's current profile when the task has none", async () => {
		const { task } = buildTask({ state: twoProfileState() })

		const gate = await task["evaluateIdleCondense"]()

		// No task-local profile name: the provider's current selection wins.
		expect(gate?.idlePercent).toBe(20)
		expect(gate?.idleSeconds).toBe(5)
	})

	test("returns undefined when the provider is gone", async () => {
		const { task } = buildTask({ providerExists: false })

		await expect(task["evaluateIdleCondense"]()).resolves.toBeUndefined()
	})

	test("returns undefined when the task is not the active task", async () => {
		const { task } = buildTask({ isCurrentTask: false })

		await expect(task["evaluateIdleCondense"]()).resolves.toBeUndefined()
	})

	test("returns undefined when idle condensing is disabled", async () => {
		const { task } = buildTask({ state: baseState({ idleCondenseContext: false }) })

		await expect(task["evaluateIdleCondense"]()).resolves.toBeUndefined()
	})

	test("returns undefined when auto condensing is disabled", async () => {
		// Idle condensing is a sub-feature of auto condensing: disabling auto
		// condensing disables idle condensing even when idle is still checked.
		const { task } = buildTask({ state: baseState({ autoCondenseContext: false }) })

		await expect(task["evaluateIdleCondense"]()).resolves.toBeUndefined()
	})

	test("returns undefined when there are no context tokens yet", async () => {
		const { task } = buildTask({ contextTokens: 0 })

		await expect(task["evaluateIdleCondense"]()).resolves.toBeUndefined()
	})

	test("returns undefined when the model has no context window", async () => {
		const noWindow: ModelInfo = { ...MODEL_INFO }
		delete (noWindow as { contextWindow?: number }).contextWindow
		const { task } = buildTask({ modelInfo: noWindow })

		await expect(task["evaluateIdleCondense"]()).resolves.toBeUndefined()
	})
})

describe("Task idle condensing — resolveIdleCondenseTimeInSeconds", () => {
	let warn: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		warn.mockRestore()
	})

	const resolve = (state: {
		idleCondenseTimeInSeconds?: number
		profileIdleCondenseTimes?: Record<string, number>
	}) => buildTask().task["resolveIdleCondenseTimeInSeconds"](state, "profile-1")

	test("uses the global value when the profile has no entry", () => {
		expect(resolve({ idleCondenseTimeInSeconds: 45 })).toBe(45)
	})

	test("uses the default 180s when the global value is unset", () => {
		expect(resolve({})).toBe(180)
	})

	test("profile -1 inherits the global value", () => {
		expect(resolve({ idleCondenseTimeInSeconds: 45, profileIdleCondenseTimes: { "profile-1": -1 } })).toBe(45)
	})

	test("a non-negative profile value overrides the global value", () => {
		expect(resolve({ idleCondenseTimeInSeconds: 45, profileIdleCondenseTimes: { "profile-1": 10 } })).toBe(10)
	})

	test("a zero profile value overrides the global value", () => {
		expect(resolve({ idleCondenseTimeInSeconds: 45, profileIdleCondenseTimes: { "profile-1": 0 } })).toBe(0)
	})

	test("falls back to the global value with a warning for an invalid profile value", () => {
		expect(resolve({ idleCondenseTimeInSeconds: 45, profileIdleCondenseTimes: { "profile-1": -7 } })).toBe(45)
		expect(warn).toHaveBeenCalledTimes(1)
	})

	test("clamps a negative global value to zero", () => {
		expect(resolve({ idleCondenseTimeInSeconds: -5 })).toBe(0)
	})
})

describe("Task idle condensing — arming the timer", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test("arms the idle timer when the context is above the idle threshold", async () => {
		const { task } = buildTask()

		await task["maybeStartIdleCondenseTimer"]()

		expect(vi.getTimerCount()).toBe(1)
	})

	test("does not arm when the context is below the idle threshold", async () => {
		const { task } = buildTask({ contextTokens: 100 })

		await task["maybeStartIdleCondenseTimer"]()

		expect(vi.getTimerCount()).toBe(0)
	})

	test("does not arm for an aborted task", async () => {
		const { task } = buildTask()
		// Redefine rather than assign: `abort` may be a getter-only accessor,
		// and the shadowing own property from buildTask is writable at runtime.
		Object.defineProperty(task, "abort", { value: true, configurable: true, writable: true })

		await task["maybeStartIdleCondenseTimer"]()

		expect(vi.getTimerCount()).toBe(0)
	})

	test("does not arm when a timer is already armed", async () => {
		const { task } = buildTask()
		const evaluate = vi.fn(async () => undefined)
		task["evaluateIdleCondense"] = evaluate
		task["idleCondenseTimeoutRef"] = setTimeout(() => {}, 10_000_000)

		await task["maybeStartIdleCondenseTimer"]()

		expect(evaluate).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(1)
	})

	test("does not arm while an idle condense is in flight", async () => {
		const { task } = buildTask()
		task["idleCondenseInFlight"] = true

		await task["maybeStartIdleCondenseTimer"]()

		expect(vi.getTimerCount()).toBe(0)
	})

	test("does not arm when the last action was a condense", async () => {
		const { task } = buildTask()
		task["lastActionWasCondense"] = true

		await task["maybeStartIdleCondenseTimer"]()

		expect(vi.getTimerCount()).toBe(0)
	})

	// Idle condensing only makes sense while the task genuinely waits on the
	// user: the shared arming path rejects tasks with nothing pending, tasks
	// mid-approval (command/tool/MCP asks), and answered asks.
	test("does not arm when no ask is pending", async () => {
		const { task } = buildTask()
		task["clineMessages"] = []

		await task["maybeStartIdleCondenseTimer"]()

		expect(vi.getTimerCount()).toBe(0)
	})

	test.each(["command", "tool", "use_mcp_server"] as const)(
		"does not arm while a %s approval ask is pending",
		async (ask) => {
			const { task } = buildTask()
			task["clineMessages"] = [{ ts: PENDING_ASK_TS, type: "ask", ask } as ClineMessage]

			await task["maybeStartIdleCondenseTimer"]()

			expect(vi.getTimerCount()).toBe(0)
		},
	)

	test("does not arm once the pending ask has been answered", async () => {
		const { task } = buildTask()
		task["askResponse"] = "messageResponse"

		await task["maybeStartIdleCondenseTimer"]()

		expect(vi.getTimerCount()).toBe(0)
	})

	// The eligible set mirrors the ask categories that arm on a status
	// transition: follow-up plus the idle and resumable asks.
	test.each(["followup", "completion_result", "resume_task"] as const)(
		"arms while a %s ask is pending",
		async (ask) => {
			const { task } = buildTask()
			task["clineMessages"] = [{ ts: PENDING_ASK_TS, type: "ask", ask } as ClineMessage]

			await task["maybeStartIdleCondenseTimer"]()

			expect(vi.getTimerCount()).toBe(1)
		},
	)

	// The tests above call the scheduler directly; these drive the real ask()
	// so the two-second status-transition hooks — the only places a waiting
	// ask schedules idle condensing — are covered end to end.
	function buildAskTask() {
		const built = buildTask()
		const { task } = built

		task["emit"] = vi.fn()
		task["saveClineMessages"] = vi.fn(async () => true)
		// The status-timer callbacks resolve the pending ask via
		// findMessageByTimestamp, so the stub has to land the message.
		task["addToClineMessages"] = vi.fn(async (message: ClineMessage) => {
			task["clineMessages"].push(message)
		})
		// Empty, never-claimable queue: the ask stays pending for the user.
		// defineProperty because messageQueueService is readonly on the class.
		Object.defineProperty(task, "messageQueueService", {
			value: {
				isEmpty: () => true,
				hasUnclaimed: () => false,
				claimNextMessage: () => undefined,
				releaseMessage: () => {},
			},
		})

		return built
	}

	// Starts a blocking ask and advances the fake clock just past the
	// two-second status transition, asserting nothing is scheduled before it.
	async function startAskAcrossStatusTransition(askType: ClineAsk) {
		const { task } = buildAskTask()
		const askPromise = task.ask(askType, "waiting on the user", false)

		await vi.advanceTimersByTimeAsync(1_999)
		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		// Cross the boundary by 11ms — short enough to skip a pWaitFor poll tick.
		await vi.advanceTimersByTimeAsync(11)

		return { task, askPromise }
	}

	async function resolveAsk(task: Task, askPromise: ReturnType<Task["ask"]>) {
		// Deliberately not handleWebviewAskResponse: it cancels the idle timer,
		// which is the very thing the assertions above depend on.
		task["askResponse"] = "yesButtonClicked"
		await vi.advanceTimersByTimeAsync(100)
		await expect(askPromise).resolves.toMatchObject({ response: "yesButtonClicked" })
	}

	test("a pending followup ask schedules idle condensing on the interactive transition", async () => {
		const { task, askPromise } = await startAskAcrossStatusTransition("followup")

		expect(task["interactiveAsk"]).toBeDefined()
		expect(task["idleCondenseTimeoutRef"]).toBeDefined()

		await resolveAsk(task, askPromise)
	})

	test("a pending resume_task ask schedules idle condensing on the resumable transition", async () => {
		const { task, askPromise } = await startAskAcrossStatusTransition("resume_task")

		expect(task["resumableAsk"]).toBeDefined()
		expect(task["idleCondenseTimeoutRef"]).toBeDefined()

		await resolveAsk(task, askPromise)
	})

	test("a pending idle ask schedules idle condensing on the idle transition", async () => {
		const { task, askPromise } = await startAskAcrossStatusTransition("completion_result")

		expect(task["idleAsk"]).toBeDefined()
		expect(task["idleCondenseTimeoutRef"]).toBeDefined()

		await resolveAsk(task, askPromise)
	})

	// Tool and command asks are interactive, so they take the same two-second
	// transition — but they are mid-response, so only the status change fires
	// and idle condensing stays unscheduled.
	test.each(["tool", "command"] as const)(
		"a pending %s ask crosses the interactive transition without scheduling idle condensing",
		async (askType) => {
			const { task, askPromise } = await startAskAcrossStatusTransition(askType)

			expect(task["interactiveAsk"]).toBeDefined()
			expect(task["idleCondenseTimeoutRef"]).toBeUndefined()

			await resolveAsk(task, askPromise)
		},
	)
})

describe("Task idle condensing — reset and cancel", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test("reset is a no-op while no timer is armed", () => {
		const { task } = buildTask()
		// "declined" keeps the stub compatible with the arming-outcome
		// signature without arming anything.
		const maybeStart = vi.fn(async (): Promise<"declined"> => "declined")
		task["maybeStartIdleCondenseTimer"] = maybeStart

		task.resetIdleCondenseTimer()

		expect(maybeStart).not.toHaveBeenCalled()
	})

	test("reset re-arms the countdown only while a timer is armed", async () => {
		const { task } = buildTask()
		task["idleCondenseTimeoutRef"] = setTimeout(() => {}, 30_000)
		const maybeStart = vi.fn(async (): Promise<"declined"> => "declined")
		task["maybeStartIdleCondenseTimer"] = maybeStart

		task.resetIdleCondenseTimer()
		await vi.runOnlyPendingTimersAsync().catch(() => {})

		expect(maybeStart).toHaveBeenCalledTimes(1)
		// The old countdown was cleared and the stub does not re-arm.
		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
	})

	test("cancel clears the armed countdown", () => {
		const { task } = buildTask()
		task["idleCondenseTimeoutRef"] = setTimeout(() => {}, 30_000)

		task.cancelIdleCondenseTimer()

		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
	})

	test("sending a prompt from the webview cancels the countdown", () => {
		const { task } = buildTask()
		task["checkpointSave"] = vi.fn(async () => {})
		task["idleCondenseTimeoutRef"] = setTimeout(() => {}, 30_000)
		task["lastActionWasCondense"] = true

		task.handleWebviewAskResponse("messageResponse", "new prompt")

		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
		// The user sent a prompt: the condense is no longer the last action.
		expect(task["lastActionWasCondense"]).toBe(false)
	})
})

describe("Task idle condensing — timer expiry", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test("condenses once the idle wait elapses and then stops", async () => {
		const { task, condense, postMessageToWebview } = buildTask()

		await task["maybeStartIdleCondenseTimer"]()

		await vi.advanceTimersByTimeAsync(29_999)
		expect(condense).not.toHaveBeenCalled()
		expect(postMessageToWebview).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		// A condense was the last action: the timer is never re-armed.
		expect(condense).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
		// Same in-progress cue as a manual condense, in order, for this task.
		expect(postedCueTypes(postMessageToWebview)).toEqual([
			"condenseTaskContextStarted",
			"condenseTaskContextResponse",
		])
		expect(postMessageToWebview.mock.calls.every(([message]) => message.text === "task-1")).toBe(true)
	})

	test("does not re-arm after a condense even when still above the idle threshold", async () => {
		const { task, condense } = buildTask()
		condense.mockResolvedValue({ condensed: true, newContextTokens: 600, prevContextTokens: 600 })

		await task["maybeStartIdleCondenseTimer"]()
		await vi.advanceTimersByTimeAsync(30_000)
		expect(condense).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)

		await vi.advanceTimersByTimeAsync(60_000)
		expect(condense).toHaveBeenCalledTimes(1)
	})

	test("does not condense when work started while the countdown ran", async () => {
		const { task, condense, postMessageToWebview } = buildTask()

		await task["maybeStartIdleCondenseTimer"]()
		task["activeApiWork"] = 1
		await vi.advanceTimersByTimeAsync(30_000)

		expect(condense).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
		expect(postMessageToWebview).not.toHaveBeenCalled()
	})

	test("re-checks the gate at expiry and skips condensing when disabled meanwhile", async () => {
		const { task, condense, getState, postMessageToWebview } = buildTask()

		await task["maybeStartIdleCondenseTimer"]()
		getState.mockResolvedValue(baseState({ idleCondenseContext: false }))
		await vi.advanceTimersByTimeAsync(30_000)

		expect(condense).not.toHaveBeenCalled()
		expect(postMessageToWebview).not.toHaveBeenCalled()
	})

	test("a zero idle wait fires immediately but never spins a second condense", async () => {
		const { task, condense } = buildTask({ state: baseState({ idleCondenseTimeInSeconds: 0 }) })
		condense.mockResolvedValue({ condensed: true, newContextTokens: 600, prevContextTokens: 600 })

		await task["maybeStartIdleCondenseTimer"]()
		await vi.advanceTimersByTimeAsync(0)

		expect(condense).toHaveBeenCalledTimes(1)
		// No re-arm at all after a condense, so a zero-wait setting cannot spin.
		await vi.advanceTimersByTimeAsync(60_000)
		expect(condense).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	test("a condense that did not shrink the context does not re-arm", async () => {
		const { task, condense, postMessageToWebview } = buildTask()
		condense.mockImplementation(leaseGated({ condensed: false, prevContextTokens: 600, error: "summarize failed" }))

		await task["maybeStartIdleCondenseTimer"]()
		await vi.advanceTimersByTimeAsync(30_000)

		expect(condense).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
		// The cue still opens and closes even when the condense failed.
		expect(postedCueTypes(postMessageToWebview)).toEqual([
			"condenseTaskContextStarted",
			"condenseTaskContextResponse",
		])
	})

	test("a condense that throws still closes the in-progress cue", async () => {
		const { task, condense, postMessageToWebview } = buildTask()
		condense.mockImplementation(async (onLeaseAcquired?: () => Promise<boolean>) => {
			if (onLeaseAcquired && !(await onLeaseAcquired())) {
				return { condensed: false, prevContextTokens: 600 }
			}
			throw new Error("summarize exploded")
		})
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		try {
			await task["maybeStartIdleCondenseTimer"]()
			await vi.advanceTimersByTimeAsync(30_000)

			expect(condense).toHaveBeenCalledTimes(1)
			expect(postedCueTypes(postMessageToWebview)).toEqual([
				"condenseTaskContextStarted",
				"condenseTaskContextResponse",
			])
			expect(consoleError).toHaveBeenCalled()
		} finally {
			consoleError.mockRestore()
		}
	})

	test("an in-flight condense blocks a second expiry pass", async () => {
		const { task, condense, postMessageToWebview } = buildTask()
		let release: (result: CondenseStubResult) => void = () => {}
		condense.mockImplementation(async (onLeaseAcquired?: () => Promise<boolean>) => {
			if (onLeaseAcquired && !(await onLeaseAcquired())) {
				return { condensed: false, prevContextTokens: 600 }
			}
			return new Promise<CondenseStubResult>((resolve) => {
				release = resolve
			})
		})

		await task["maybeStartIdleCondenseTimer"]()
		await vi.advanceTimersByTimeAsync(30_000)
		expect(condense).toHaveBeenCalledTimes(1)
		expect(task["idleCondenseInFlight"]).toBe(true)

		// A manual expiry attempt while the condense is still running must bail.
		await task["onIdleCondenseTimerFired"]()
		expect(condense).toHaveBeenCalledTimes(1)
		// Only the first pass has opened the cue so far.
		expect(postedCueTypes(postMessageToWebview)).toEqual(["condenseTaskContextStarted"])

		release({ condensed: true, newContextTokens: 100, prevContextTokens: 600 })
		await vi.advanceTimersByTimeAsync(0)
		expect(task["idleCondenseInFlight"]).toBe(false)
		expect(postedCueTypes(postMessageToWebview)).toEqual([
			"condenseTaskContextStarted",
			"condenseTaskContextResponse",
		])
	})

	test("a cancel aborts the in-flight idle summarization request", async () => {
		// The idle path runs without the request loop, so its summarization call
		// has no request-scoped controller: the expiry run hands the lease a
		// task-owned signal, and `cancelCurrentRequest` (user cancel or disposal)
		// aborts the in-flight HTTP call through it.
		const { task } = buildTask()
		let summarySignal: AbortSignal | undefined
		let release: (result: CondenseStubResult) => void = () => {}
		task["condenseContextWithLease"] = vi.fn(
			async (onLeaseAcquired?: () => Promise<boolean>, signal?: AbortSignal): Promise<CondenseStubResult> => {
				summarySignal = signal
				if (onLeaseAcquired && !(await onLeaseAcquired())) {
					return { condensed: false, prevContextTokens: 600 }
				}
				return new Promise<CondenseStubResult>((resolve) => {
					release = resolve
				})
			},
		)

		await task["maybeStartIdleCondenseTimer"]()
		await vi.advanceTimersByTimeAsync(30_000)
		expect(task["idleCondenseInFlight"]).toBe(true)
		expect(summarySignal).toBeDefined()
		expect(summarySignal?.aborted).toBe(false)

		task.cancelCurrentRequest()
		expect(summarySignal?.aborted).toBe(true)
		// The cancel owns the abort; the finishing run just finds the field clear.
		expect(task["idleCondenseAbortController"]).toBeUndefined()

		release({ condensed: false, prevContextTokens: 600 })
		await vi.advanceTimersByTimeAsync(0)
		expect(task["idleCondenseInFlight"]).toBe(false)
		expect(task["idleCondenseAbortController"]).toBeUndefined()
	})

	test("an idle wait beyond the maximum timer delay waits the full duration", async () => {
		const { task, condense } = buildTask({
			state: baseState({ idleCondenseTimeInSeconds: 2_147_484 }),
		})
		// Node silently clamps setTimeout delays above 2,147,483,647 ms to
		// 1 ms, so a raw delay for 2,147,484 s would condense a task that just
		// went idle. Fake timers do not emulate that clamp, so pin the exact
		// scheduled delays as well as the elapsed behavior.
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
		const scheduledDelays = () =>
			setTimeoutSpy.mock.calls
				.map((call) => call[1])
				.filter((delay): delay is number => typeof delay === "number")

		try {
			await task["maybeStartIdleCondenseTimer"]()
			// The first slice never exceeds the maximum Node supports.
			expect(scheduledDelays()).toEqual([2_147_483_647])

			await vi.advanceTimersByTimeAsync(2_147_483_647)
			expect(condense).not.toHaveBeenCalled()
			// The remainder is 2,147,484,000 - 2,147,483,647 = 353 ms.
			expect(scheduledDelays()).toEqual([2_147_483_647, 353])

			await vi.advanceTimersByTimeAsync(353)
			expect(condense).toHaveBeenCalledTimes(1)
		} finally {
			setTimeoutSpy.mockRestore()
		}
	})
})

describe("Task idle condensing — activity invalidates a pending expiry evaluation", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// Arms the timer with the real gate (first getState call), then defers the
	// next one so the expiry's re-evaluation stalls mid-flight, modelling
	// activity landing while the async gate evaluation is still running.
	function buildPendingGateTask() {
		const built = buildTask()
		// Object.create skips constructor field initialisers; the discarded
		// evaluation must never touch this flag, so mirror the default.
		built.task["idleCondenseInFlight"] = false
		let resolveState: (state: StateStub) => void = () => {}
		const pendingGate = new Promise<StateStub>((resolve) => {
			resolveState = resolve
		})
		let gateCalls = 0
		built.getState.mockImplementation(() => {
			gateCalls++
			return gateCalls === 1 ? Promise.resolve(baseState()) : pendingGate
		})
		const settleGate = () => {
			resolveState(baseState())
		}
		return { ...built, settleGate }
	}

	// Arm and expire the timer so onIdleCondenseTimerFired is now awaiting the
	// deferred gate.
	async function expireIntoPendingGate(task: Task) {
		await task["maybeStartIdleCondenseTimer"]()
		await vi.advanceTimersByTimeAsync(30_000)
		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
	}

	test("an answer landing during the gate evaluation cancels the condense", async () => {
		const { task, condense, settleGate, postMessageToWebview } = buildPendingGateTask()
		task["checkpointSave"] = vi.fn(async () => {})

		await expireIntoPendingGate(task)

		// The user answers the follow-up while the expiry is still evaluating its gate.
		task.handleWebviewAskResponse("messageResponse", "new prompt")
		settleGate()
		await vi.advanceTimersByTimeAsync(0)

		// The stale evaluation was discarded: no condense, no in-progress cue.
		expect(condense).not.toHaveBeenCalled()
		expect(postMessageToWebview).not.toHaveBeenCalled()
		expect(task["idleCondenseInFlight"]).toBe(false)
	})

	test("work starting during the gate evaluation cancels the condense", async () => {
		const { task, condense, settleGate, postMessageToWebview } = buildPendingGateTask()

		await expireIntoPendingGate(task)

		// A new request starts while the expiry is still evaluating its gate.
		task["activeApiWork"] = 1
		settleGate()
		await vi.advanceTimersByTimeAsync(0)

		expect(condense).not.toHaveBeenCalled()
		expect(postMessageToWebview).not.toHaveBeenCalled()
		expect(task["idleCondenseInFlight"]).toBe(false)
	})

	test("condenses normally when no activity lands during the gate evaluation", async () => {
		const { task, condense, settleGate } = buildPendingGateTask()

		await expireIntoPendingGate(task)

		// The gate resolves while the task is still idle: the condense proceeds.
		settleGate()
		await vi.advanceTimersByTimeAsync(0)

		expect(condense).toHaveBeenCalledTimes(1)
	})

	// A typing signal arrives after the countdown expired but while its
	// evaluation still awaits: no timer is armed, so without the
	// expiry-evaluating flag the reset would silently no-op and the stale
	// evaluation would condense over the conversation being edited.
	test("typing during the gate evaluation discards it and restarts the countdown", async () => {
		const { task, condense, settleGate, postMessageToWebview } = buildPendingGateTask()

		await expireIntoPendingGate(task)
		expect(task["idleCondenseExpiryEvaluating"]).toBe(true)

		// The user types in the prompt area while the expiry is evaluating.
		task.resetIdleCondenseTimer()
		settleGate()
		await vi.advanceTimersByTimeAsync(0)

		// The stale evaluation was discarded: no condense, no in-progress cue.
		expect(condense).not.toHaveBeenCalled()
		expect(postMessageToWebview).not.toHaveBeenCalled()
		// A fresh countdown replaced it, and the evaluation flag was cleared.
		expect(task["idleCondenseTimeoutRef"]).toBeDefined()
		expect(task["idleCondenseExpiryEvaluating"]).toBe(false)

		// The restarted countdown runs the condense normally.
		await vi.advanceTimersByTimeAsync(30_000)
		expect(condense).toHaveBeenCalledTimes(1)
	})

	// A settings save during the expiry evaluation means the evaluation
	// measured against pre-save settings: it must be discarded, and the
	// re-armed evaluation must apply the newly saved thresholds instead.
	test("a settings save during the gate evaluation discards it and re-arms", async () => {
		const { task, condense, settleGate, postMessageToWebview } = buildPendingGateTask()

		await expireIntoPendingGate(task)

		task.reevaluateIdleCondenseAfterSettingsSave()
		settleGate()
		await vi.advanceTimersByTimeAsync(0)

		// The pre-save evaluation was discarded: no condense, no cue.
		expect(condense).not.toHaveBeenCalled()
		expect(postMessageToWebview).not.toHaveBeenCalled()
		// The post-save evaluation armed a fresh countdown.
		expect(task["idleCondenseTimeoutRef"]).toBeDefined()
		expect(task["idleCondenseExpiryEvaluating"]).toBe(false)
		task["cancelIdleCondenseTimer"]()
	})
})

describe("Task idle condensing — activity invalidates a pending arming evaluation", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// Defers the arming gate's provider state read so activity can land while
	// maybeStartIdleCondenseTimer is still awaiting evaluateIdleCondense.
	function buildPendingArmTask() {
		const built = buildTask()
		let resolveState: (state: StateStub) => void = () => {}
		const pendingGate = new Promise<StateStub>((resolve) => {
			resolveState = resolve
		})
		built.getState.mockImplementation(() => pendingGate)
		return { ...built, settleGate: () => resolveState(baseState()) }
	}

	test("an answer landing during the arming evaluation discards the pending arm", async () => {
		const { task, settleGate } = buildPendingArmTask()
		task["checkpointSave"] = vi.fn(async () => {})

		const arming = task["maybeStartIdleCondenseTimer"]()
		await vi.advanceTimersByTimeAsync(0)

		// The user answers the pending ask while the arming gate still runs.
		task.handleWebviewAskResponse("messageResponse", "new prompt")
		settleGate()
		await arming

		// The stale evaluation was discarded: no countdown for a task that is
		// no longer waiting on the user.
		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
	})

	test("arming proceeds when no activity lands during the gate evaluation", async () => {
		const { task, settleGate } = buildPendingArmTask()

		const arming = task["maybeStartIdleCondenseTimer"]()
		await vi.advanceTimersByTimeAsync(0)

		// The gate resolves while the task is still idle: the countdown arms.
		settleGate()
		await arming

		expect(task["idleCondenseTimeoutRef"]).toBeDefined()
		task["cancelIdleCondenseTimer"]()
	})
})

describe("Task idle condensing — last-action-was-a-condense suppression", () => {
	// Uses the real condenseContextWithLease (the harness stub replaces it) by
	// restoring the prototype method on the instance and doubling the lease's
	// two collaborators.
	function buildLeaseTask(condensed: boolean) {
		const { task } = buildTask()
		task["condenseContextWithLease"] = Task.prototype["condenseContextWithLease"].bind(task)
		const endApiWork = vi.fn()
		task["beginApiWork"] = vi.fn(() => endApiWork)
		task["condenseContextWithActiveApi"] = vi.fn(async () => ({
			condensed,
			newContextTokens: condensed ? 100 : undefined,
			prevContextTokens: 600,
		}))
		return { task, endApiWork }
	}

	test("a successful lease condense marks the condense as the last action", async () => {
		const { task, endApiWork } = buildLeaseTask(true)

		await task["condenseContextWithLease"]()

		expect(task["lastActionWasCondense"]).toBe(true)
		expect(endApiWork).toHaveBeenCalledTimes(1)
	})

	test("a failed lease condense does not mark the last action", async () => {
		const { task } = buildLeaseTask(false)

		await task["condenseContextWithLease"]()

		expect(task["lastActionWasCondense"]).toBe(false)
	})

	test("reporting a condense summary marks the condense as the last action", async () => {
		const { task } = buildTask()
		const say = vi.fn(async (): Promise<undefined> => {})
		task["say"] = say
		const result: ContextManagementResult = {
			messages: [],
			summary: "a summary",
			cost: 0,
			newContextTokens: 100,
			prevContextTokens: 600,
			condenseId: "condense-1",
		}

		await task["reportContextManagementResult"](result)

		expect(task["lastActionWasCondense"]).toBe(true)
	})

	test("reporting sliding-window truncation does not mark the last action", async () => {
		const { task } = buildTask()
		const say = vi.fn(async (): Promise<undefined> => {})
		task["say"] = say
		const result: ContextManagementResult = {
			messages: [],
			summary: "",
			cost: 0,
			prevContextTokens: 600,
			truncationId: "truncation-1",
		}

		await task["reportContextManagementResult"](result)

		expect(task["lastActionWasCondense"]).toBe(false)
	})

	test("a successful expiry condense suppresses arming until a prompt clears the flag", async () => {
		vi.useFakeTimers()
		try {
			const { task, condense } = buildTask()
			// The harness stubs the lease, so mirror the flag the real lease sets.
			condense.mockImplementation(async () => {
				task["lastActionWasCondense"] = true
				return { condensed: true, newContextTokens: 600, prevContextTokens: 600 }
			})

			await task["maybeStartIdleCondenseTimer"]()
			await vi.advanceTimersByTimeAsync(30_000)
			expect(condense).toHaveBeenCalledTimes(1)
			expect(vi.getTimerCount()).toBe(0)

			// Idle again after the condense: the gate stays closed.
			await task["maybeStartIdleCondenseTimer"]()
			expect(vi.getTimerCount()).toBe(0)

			// The user sends a prompt: idle condensing becomes eligible again.
			task["checkpointSave"] = vi.fn(async () => {})
			task.handleWebviewAskResponse("messageResponse", "new prompt")
			// The prompt is consumed by a new request cycle that ends with a
			// fresh follow-up ask, so the task is waiting on the user again.
			task["askResponse"] = undefined
			task["lastMessageTs"] = PENDING_ASK_TS + 1
			task["clineMessages"].push({
				ts: PENDING_ASK_TS + 1,
				type: "ask",
				ask: "followup",
			} as ClineMessage)
			await task["maybeStartIdleCondenseTimer"]()
			expect(vi.getTimerCount()).toBe(1)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("Task idle condensing — restoring last-action-was-a-condense on reopen", () => {
	// Drives the real resumeTaskFromHistory through to the resume ask. Persistence
	// reads, the webview ask (which arms the idle timer in production), the
	// initialization bookkeeping (run-state transitions are covered elsewhere),
	// and the task-loop handoff are stubbed; hydration stays real.
	function buildResumeTask(savedApiConversationHistory: ApiMessage[]) {
		const { task } = buildTask()
		// Object.create skips constructor field initialisers; message hydration needs this Set.
		task["cloudSyncedMessageTimestamps"] = new Set<number>()

		task["getSavedClineMessages"] = vi.fn(async () => [])
		task["getSavedApiConversationHistory"] = vi.fn(async () => savedApiConversationHistory)
		task["markInitialized"] = vi.fn()

		let lastActionWasCondenseAtAsk: boolean | undefined
		// Capturing the flag inside the ask stub proves the restore lands before the
		// resume ask arms the idle condense timer.
		task["ask"] = vi.fn(async (_askType: ClineAsk) => {
			lastActionWasCondenseAtAsk = task["lastActionWasCondense"]
			return { response: "yesButtonClicked" as const }
		})
		task["overwriteApiConversationHistory"] = vi.fn(async (_history: ApiMessage[]) => {})
		const initiateTaskLoop = vi.fn(async (_content: unknown[]) => {})
		task["initiateTaskLoop"] = initiateTaskLoop

		return { task, initiateTaskLoop, flagAtAsk: () => lastActionWasCondenseAtAsk }
	}

	test("reopening a task whose history ends in a condense summary marks the last action", async () => {
		const { task, initiateTaskLoop, flagAtAsk } = buildResumeTask([
			{ role: "user", content: [{ type: "text", text: "do the thing" }] },
			{ role: "assistant", content: [{ type: "text", text: "all set" }] },
			{
				role: "user",
				content: [{ type: "text", text: "Summary of the condensed conversation..." }],
				isSummary: true,
				condenseId: "condense-1",
			},
		])

		await task["resumeTaskFromHistory"]()

		expect(flagAtAsk()).toBe(true)
		expect(task["lastActionWasCondense"]).toBe(true)
		expect(initiateTaskLoop).toHaveBeenCalledTimes(1)
	})

	test("reopening a task with a plain history leaves the flag cleared", async () => {
		const { task, initiateTaskLoop, flagAtAsk } = buildResumeTask([
			{ role: "user", content: [{ type: "text", text: "do the thing" }] },
			{ role: "assistant", content: [{ type: "text", text: "still working on it" }] },
		])

		await task["resumeTaskFromHistory"]()

		expect(flagAtAsk()).toBe(false)
		expect(task["lastActionWasCondense"]).toBe(false)
		expect(initiateTaskLoop).toHaveBeenCalledTimes(1)
	})
})

describe("Task idle condensing — reconciling last-action-was-a-condense on history replacement", () => {
	// Rewinds, checkpoint restores, and message deletes/edits replace the API
	// history wholesale via overwriteApiConversationHistory. The suppression
	// flag must follow the new history: without reconciliation a rewind that
	// truncates past the condense summary would keep suppressing idle
	// condensing until the next prompt, even though the last action is gone.
	function buildFlaggedTask() {
		const { task } = buildTask()
		const history: ApiMessage[] = [
			{ role: "user", content: [{ type: "text", text: "do the thing" }] },
			{ role: "assistant", content: [{ type: "text", text: "all set" }] },
			{
				role: "user",
				content: [{ type: "text", text: "Summary of the condensed conversation..." }],
				isSummary: true,
				condenseId: "condense-1",
			},
		]
		task["apiConversationHistory"] = history
		task["lastActionWasCondense"] = true
		return { task, history }
	}

	test("a rewind that truncates past the summary clears the flag", async () => {
		const { task, history } = buildFlaggedTask()

		// Checkpoint restore keeps only the messages before the rewind point,
		// dropping the trailing condense summary.
		await task.overwriteApiConversationHistory(history.slice(0, 2), false)

		expect(task["lastActionWasCondense"]).toBe(false)
	})

	test("a replacement that keeps the trailing summary keeps the flag", async () => {
		const { task, history } = buildFlaggedTask()

		await task.overwriteApiConversationHistory(history, false)

		expect(task["lastActionWasCondense"]).toBe(true)
	})

	test("replacing history with an empty list clears the flag", async () => {
		const { task } = buildFlaggedTask()

		await task.overwriteApiConversationHistory([], false)

		expect(task["lastActionWasCondense"]).toBe(false)
	})
})

describe("Task idle condensing — re-arm after API work discards the timer", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const FOLLOWUP_TS = 1_000

	// A task waiting on a follow-up ask while a response stream is still active.
	function buildApiWorkTask(ask: ClineAsk = "followup") {
		const built = buildTask()
		const { task } = built
		// Object.create skips constructor field initialisers; beginApiWork
		// flushes the retired-handler set when the last request finishes.
		task["retiredApis"] = new Set()
		task["lastMessageTs"] = FOLLOWUP_TS
		task["askResponse"] = undefined
		const pendingAsk: ClineMessage = { ts: FOLLOWUP_TS, type: "ask", ask, text: "What should I do next?" }
		task["clineMessages"] = [pendingAsk]
		return built
	}

	// Arm the countdown directly, then let it expire while the task still has
	// a request in flight, so the expiry discards the timer. Direct arming
	// (bypassing the eligibility-gated shared path, covered by its own tests)
	// keeps the helper usable for asks that must not arm on their own.
	async function discardTimerDuringApiWork(task: Task) {
		const endApiWork = task["beginApiWork"]()
		task["armIdleCondenseTimeout"](30)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(vi.getTimerCount()).toBe(0)
		expect(task["idleCondenseRearmAfterApiWork"]).toBe(true)
		return endApiWork
	}

	test("re-arms the timer when the last request finishes with the follow-up still pending", async () => {
		const { task, condense } = buildApiWorkTask()
		const endApiWork = await discardTimerDuringApiWork(task)
		expect(condense).not.toHaveBeenCalled()

		endApiWork()
		// Flush the microtasks of the re-arm kicked off by the work completion.
		await vi.advanceTimersByTimeAsync(0)

		// The timer was re-armed once, and the flag was consumed.
		expect(task["idleCondenseRearmAfterApiWork"]).toBe(false)
		expect(vi.getTimerCount()).toBe(1)

		await vi.advanceTimersByTimeAsync(30_000)
		expect(condense).toHaveBeenCalledTimes(1)
		// A successful condense is now the last action: no further re-arm.
		expect(vi.getTimerCount()).toBe(0)
	})

	test("does not re-arm once the follow-up has been answered", async () => {
		const { task, condense } = buildApiWorkTask()
		const endApiWork = await discardTimerDuringApiWork(task)

		task["askResponse"] = "messageResponse"
		endApiWork()
		await vi.advanceTimersByTimeAsync(0)

		expect(vi.getTimerCount()).toBe(0)
		expect(task["idleCondenseRearmAfterApiWork"]).toBe(false)

		await vi.advanceTimersByTimeAsync(60_000)
		expect(condense).not.toHaveBeenCalled()
	})

	test.each([
		["an approval ask", () => "command" as ClineAsk],
		["a partial follow-up ask", () => "followup" as ClineAsk],
	])("does not re-arm when the stream ends with %s", async (_label, pickAsk) => {
		const ask = pickAsk()
		const { task, condense } = buildApiWorkTask(ask)
		if (ask === "followup") {
			// Only a complete follow-up counts as pending.
			;(task["clineMessages"][0] as ClineMessage).partial = true
		}
		const endApiWork = await discardTimerDuringApiWork(task)

		endApiWork()
		await vi.advanceTimersByTimeAsync(0)

		expect(vi.getTimerCount()).toBe(0)
		expect(task["idleCondenseRearmAfterApiWork"]).toBe(false)

		await vi.advanceTimersByTimeAsync(60_000)
		expect(condense).not.toHaveBeenCalled()
	})

	// The idle-eligible set (idle and resumable asks) re-arms too: they wait
	// on the user just like a follow-up, so a discarded timer must return.
	test.each(["completion_result", "resume_task"] as const)(
		"re-arms the timer when the last request finishes with a %s ask still pending",
		async (ask) => {
			const { task, condense } = buildApiWorkTask(ask)
			const endApiWork = await discardTimerDuringApiWork(task)
			expect(condense).not.toHaveBeenCalled()

			endApiWork()
			// Flush the microtasks of the re-arm kicked off by the completion.
			await vi.advanceTimersByTimeAsync(0)

			expect(task["idleCondenseRearmAfterApiWork"]).toBe(false)
			expect(vi.getTimerCount()).toBe(1)

			await vi.advanceTimersByTimeAsync(30_000)
			expect(condense).toHaveBeenCalledTimes(1)
		},
	)
})

describe("Task idle condensing — history barrier serializes ask responses", () => {
	// The lease sets condenseHistoryBarrier so a pending ask holds a landing
	// response and the queue drain stays blocked while the summary replaces the
	// API history. The barrier must settle on both the success and failure
	// paths so waiting responses never remain blocked.
	function buildBarrierTask(summarize: () => Promise<CondenseStubResult>) {
		const { task } = buildTask()
		task["condenseContextWithLease"] = Task.prototype["condenseContextWithLease"].bind(task)
		task["beginApiWork"] = vi.fn(() => vi.fn())
		task["condenseContextWithActiveApi"] = vi.fn(summarize)
		return task
	}

	test("the barrier is held while the summary runs and released once it succeeds", async () => {
		let barrierDuringSummarize: Promise<void> | undefined
		const task = buildBarrierTask(async () => {
			barrierDuringSummarize = task["condenseHistoryBarrier"]
			return { condensed: true, newContextTokens: 100, prevContextTokens: 600 }
		})
		expect(task["condenseHistoryBarrier"]).toBeUndefined()

		await task["condenseContextWithLease"]()

		expect(barrierDuringSummarize).toBeInstanceOf(Promise)
		expect(task["condenseHistoryBarrier"]).toBeUndefined()
	})

	test("a condense that throws releases the barrier so responses are not blocked", async () => {
		let barrierDuringSummarize: Promise<void> | undefined
		const task = buildBarrierTask(async () => {
			barrierDuringSummarize = task["condenseHistoryBarrier"]
			throw new Error("summarize failed")
		})

		await expect(task["condenseContextWithLease"]()).rejects.toThrow("summarize failed")

		expect(barrierDuringSummarize).toBeInstanceOf(Promise)
		expect(task["condenseHistoryBarrier"]).toBeUndefined()
	})

	test("concurrent leases serialize: the second summary waits for the first", async () => {
		// A manual condense and an idle condense must never overlap: the second
		// lease chains behind the first via condenseLeaseTail, so it cannot
		// install its barrier or summarize while the first still holds history.
		let releaseFirst!: () => void
		const firstSummaryDone = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const { task } = buildTask()
		task["condenseContextWithLease"] = Task.prototype["condenseContextWithLease"].bind(task)
		task["beginApiWork"] = vi.fn(() => vi.fn())
		const seenBarriers: Array<Promise<void> | undefined> = []
		let calls = 0
		const summarize = vi.fn(async () => {
			calls += 1
			seenBarriers.push(task["condenseHistoryBarrier"])
			if (calls === 1) {
				await firstSummaryDone
			}
			return { condensed: true, newContextTokens: 100, prevContextTokens: 600 }
		})
		task["condenseContextWithActiveApi"] = summarize

		const first = task["condenseContextWithLease"]()
		const second = task["condenseContextWithLease"]()

		// The first summary is in flight while the second must still be chained
		// behind it: no second summarize, and the field still holds the first barrier.
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(summarize).toHaveBeenCalledTimes(1)
		expect(task["condenseHistoryBarrier"]).toBe(seenBarriers[0])

		releaseFirst()
		await Promise.all([first, second])

		expect(summarize).toHaveBeenCalledTimes(2)
		// Each lease ran under its own barrier, and both settled.
		expect(seenBarriers[0]).toBeInstanceOf(Promise)
		expect(seenBarriers[1]).toBeInstanceOf(Promise)
		expect(seenBarriers[1]).not.toBe(seenBarriers[0])
		expect(task["condenseHistoryBarrier"]).toBeUndefined()
	})

	test("the idle callback runs under the barrier before the condense counts as API work", async () => {
		// The in-progress cue and the staleness re-check run inside the lease's
		// barrier: a response landing while the cue is posted must stay held.
		// beginApiWork runs only after the callback passes, so the lease's own
		// API-work count cannot make the callback see activeApiWork > 0 and
		// cancel every idle condense.
		const { task } = buildTask()
		task["condenseContextWithLease"] = Task.prototype["condenseContextWithLease"].bind(task)
		const beginApiWork = vi.fn(() => vi.fn())
		task["beginApiWork"] = beginApiWork
		task["condenseContextWithActiveApi"] = vi.fn(async () => ({
			condensed: true,
			newContextTokens: 100,
			prevContextTokens: 600,
		}))

		let barrierDuringCue: Promise<void> | undefined
		let apiWorkDuringCue = -1
		const result = await task["condenseContextWithLease"](async () => {
			barrierDuringCue = task["condenseHistoryBarrier"]
			apiWorkDuringCue = task["activeApiWork"]
			return true
		})

		expect(result.condensed).toBe(true)
		expect(barrierDuringCue).toBeInstanceOf(Promise)
		expect(apiWorkDuringCue).toBe(0)
		expect(beginApiWork).toHaveBeenCalledTimes(1)
		expect(task["lastActionWasCondense"]).toBe(true)
		expect(task["condenseHistoryBarrier"]).toBeUndefined()
	})

	test("the lease forwards the summary signal to the summarization call", async () => {
		// The idle run's task-owned controller signal must reach the summarize
		// call, which threads it into the API metadata as `abortSignal`.
		const { task } = buildTask()
		task["condenseContextWithLease"] = Task.prototype["condenseContextWithLease"].bind(task)
		task["beginApiWork"] = vi.fn(() => vi.fn())
		let summarySignal: AbortSignal | undefined
		task["condenseContextWithActiveApi"] = vi.fn(async (signal?: AbortSignal) => {
			summarySignal = signal
			return { condensed: true, newContextTokens: 100, prevContextTokens: 600 }
		})
		const controller = new AbortController()

		const result = await task["condenseContextWithLease"](async () => true, controller.signal)

		expect(result.condensed).toBe(true)
		expect(summarySignal).toBe(controller.signal)
	})

	test("a manual condense forwards no summary signal", async () => {
		// Manual condensing keeps the current request's signal semantics inside
		// condenseContextWithActiveApi; the lease passes no idle signal through.
		const { task } = buildTask()
		task["condenseContextWithLease"] = Task.prototype["condenseContextWithLease"].bind(task)
		task["beginApiWork"] = vi.fn(() => vi.fn())
		let summarySignal: AbortSignal | undefined
		task["condenseContextWithActiveApi"] = vi.fn(async (signal?: AbortSignal) => {
			summarySignal = signal
			return { condensed: true, newContextTokens: 100, prevContextTokens: 600 }
		})

		await task["condenseContextWithLease"]()

		expect(summarySignal).toBeUndefined()
	})

	test("a false onLeaseAcquired verdict aborts without touching history", async () => {
		// The idle caller aborts when the user engaged during the cue's await:
		// no summarize call, no API-work count, and the last action is not
		// marked as a condense, so the next idle wait can re-arm normally.
		const { task } = buildTask()
		task["condenseContextWithLease"] = Task.prototype["condenseContextWithLease"].bind(task)
		const beginApiWork = vi.fn(() => vi.fn())
		task["beginApiWork"] = beginApiWork
		const summarize = vi.fn()
		task["condenseContextWithActiveApi"] = summarize

		const result = await task["condenseContextWithLease"](async () => false)

		expect(result).toEqual({ condensed: false, prevContextTokens: 600 })
		expect(summarize).not.toHaveBeenCalled()
		expect(beginApiWork).not.toHaveBeenCalled()
		expect(task["lastActionWasCondense"]).toBe(false)
		expect(task["condenseHistoryBarrier"]).toBeUndefined()
	})
})

describe("Task idle condensing — re-evaluation after settings save", () => {
	// Saving idle-condense settings re-evaluates the waiting task: enabling
	// the feature (or loosening a threshold) while the task is already idle
	// above the threshold must start a countdown that nothing else armed, and
	// an already-armed countdown must be replaced so it honours the newly
	// saved wait instead of firing on the stale deadline.
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test("arms a countdown for a task already idle above a newly enabled threshold", async () => {
		// Idle condensing off: no countdown was ever armed for this waiting task.
		const state = baseState({ idleCondenseContext: false })
		const { task } = buildTask({ state })
		expect(vi.getTimerCount()).toBe(0)

		// The save lands, then the handler re-evaluates the waiting task.
		state.idleCondenseContext = true
		task.reevaluateIdleCondenseAfterSettingsSave()
		// Flush the eligibility check's resolved-promise chain without moving
		// the fake clock, so the freshly armed countdown is not fired.
		await vi.advanceTimersByTimeAsync(0)

		expect(task["idleCondenseTimeoutRef"]).toBeDefined()
		expect(vi.getTimerCount()).toBe(1)
	})

	test("keeps a task with API work in flight ineligible", async () => {
		const { task } = buildTask()
		task["activeApiWork"] = 1

		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)

		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
	})

	test("re-arms an already-armed countdown with the newly saved longer delay", async () => {
		const state = baseState()
		const { task, condense } = buildTask({ state })
		await task["maybeStartIdleCondenseTimer"]()
		const originalRef = task["idleCondenseTimeoutRef"]
		expect(originalRef).toBeDefined()

		// The user saves a longer idle delay while the countdown is armed.
		state.idleCondenseTimeInSeconds = 300
		task.reevaluateIdleCondenseAfterSettingsSave()
		// Flush the re-evaluation's promise chain so the new countdown is armed.
		await vi.advanceTimersByTimeAsync(0)

		expect(task["idleCondenseTimeoutRef"]).toBeDefined()
		expect(task["idleCondenseTimeoutRef"]).not.toBe(originalRef)
		expect(vi.getTimerCount()).toBe(1)

		// The stale 30s deadline no longer fires.
		await vi.advanceTimersByTimeAsync(30_000)
		expect(condense).not.toHaveBeenCalled()
		// The full newly saved 300s wait elapses.
		await vi.advanceTimersByTimeAsync(270_000)
		expect(condense).toHaveBeenCalledTimes(1)
	})

	test("re-arms an already-armed countdown with the newly saved shorter delay", async () => {
		const state = baseState({ idleCondenseTimeInSeconds: 300 })
		const { task, condense } = buildTask({ state })
		await task["maybeStartIdleCondenseTimer"]()

		// The user saves a shorter idle delay while the countdown is armed.
		state.idleCondenseTimeInSeconds = 30
		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)

		expect(vi.getTimerCount()).toBe(1)

		await vi.advanceTimersByTimeAsync(29_999)
		expect(condense).not.toHaveBeenCalled()
		// The shortened saved wait fires well before the stale 300s deadline.
		await vi.advanceTimersByTimeAsync(1)
		expect(condense).toHaveBeenCalledTimes(1)
	})

	test("a save that disables the feature cancels an already-armed countdown", async () => {
		const state = baseState()
		const { task, condense } = buildTask({ state })
		await task["maybeStartIdleCondenseTimer"]()
		expect(vi.getTimerCount()).toBe(1)

		state.idleCondenseContext = false
		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)

		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)

		await vi.advanceTimersByTimeAsync(300_000)
		expect(condense).not.toHaveBeenCalled()
	})

	test("a save that disables the feature does not arm a countdown", async () => {
		const { task } = buildTask({ state: baseState({ idleCondenseContext: false }) })

		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)

		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
	})

	test("a transient state-read failure arms no countdown, then retries and condenses", async () => {
		// The settings-save re-evaluation races a provider whose state is
		// transiently unreadable. The failed pass must leave no countdown
		// armed (the save's cancel already consumed the old one), but it must
		// not strand an eligible task forever either: the gate is retried
		// briefly, and once the read recovers the full saved delay still
		// applies before condensing.
		const { task, getState, condense } = buildTask()
		getState.mockRejectedValueOnce(new Error("storage unavailable"))

		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)

		// No countdown armed; only the bounded retry is pending.
		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		expect(task["idleCondenseSettingsRetryRef"]).toBeDefined()

		// The first retry fires once the state read works again and arms the
		// countdown from scratch.
		await vi.advanceTimersByTimeAsync(1_000)
		expect(task["idleCondenseSettingsRetryRef"]).toBeUndefined()
		expect(task["idleCondenseTimeoutRef"]).toBeDefined()

		// Condensing still waits out the full saved idle delay.
		await vi.advanceTimersByTimeAsync(29_999)
		expect(condense).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(condense).toHaveBeenCalledTimes(1)
	})

	test("a persisting state-read failure retries a bounded number of times", async () => {
		const { task, getState, condense } = buildTask()
		getState.mockRejectedValue(new Error("storage unavailable"))

		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)
		expect(task["idleCondenseSettingsRetryRef"]).toBeDefined()

		// 1s + 5s + 15s of backoff; the fourth attempt is out of retries and
		// the chain stops instead of spinning forever.
		await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 15_000)
		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		expect(task["idleCondenseSettingsRetryRef"]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)

		await vi.advanceTimersByTimeAsync(600_000)
		expect(condense).not.toHaveBeenCalled()
	})

	test("a cancel while a retry is pending stops the retry", async () => {
		const { task, getState, condense } = buildTask()
		getState.mockRejectedValueOnce(new Error("storage unavailable"))

		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)
		expect(task["idleCondenseSettingsRetryRef"]).toBeDefined()

		// The task is cancelled before the retry fires: the retry must not
		// resurrect a countdown for a dead task.
		task.cancelIdleCondenseTimer()
		await vi.advanceTimersByTimeAsync(60_000)

		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
		expect(condense).not.toHaveBeenCalled()
	})

	test("a later settings save supersedes a pending retry", async () => {
		const state = baseState()
		const { task, getState, condense } = buildTask({ state })
		getState.mockRejectedValueOnce(new Error("storage unavailable"))

		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)
		expect(task["idleCondenseSettingsRetryRef"]).toBeDefined()

		// A second save lands while the first pass' retry is pending, this
		// one disabling the feature. It clears the stale retry and runs its
		// own (now declined) evaluation; the superseded pass must never arm.
		state.idleCondenseContext = false
		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)
		expect(task["idleCondenseSettingsRetryRef"]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)

		await vi.advanceTimersByTimeAsync(600_000)
		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		expect(condense).not.toHaveBeenCalled()
	})
})
