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
	const condense = vi.fn(async (): Promise<CondenseStubResult> => ({
		condensed: true,
		newContextTokens: 100,
		prevContextTokens: contextTokens,
	}))

	const postMessageToWebview = vi.fn(async (_message: { type: string; text?: string }) => {})
	const getState = vi.fn(async () => state)
	const getCurrentTask = vi.fn(() => (isCurrentTask ? { taskId: "task-1" } : undefined))
	const provider = { getState, getCurrentTask, postMessageToWebview }

	task["abort"] = false
	task["abandoned"] = false
	task["activeApiWork"] = 0
	// Object.create skips constructor field initialisers; mirror the default.
	task["lastActionWasCondense"] = false
	task["clineMessages"] = []
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
		task["abort"] = true

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
		const maybeStart = vi.fn(async () => {})
		task["maybeStartIdleCondenseTimer"] = maybeStart

		task.resetIdleCondenseTimer()

		expect(maybeStart).not.toHaveBeenCalled()
	})

	test("reset re-arms the countdown only while a timer is armed", async () => {
		const { task } = buildTask()
		task["idleCondenseTimeoutRef"] = setTimeout(() => {}, 30_000)
		const maybeStart = vi.fn(async () => {})
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
		condense.mockResolvedValue({ condensed: false, prevContextTokens: 600, error: "summarize failed" })

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
		condense.mockRejectedValue(new Error("summarize exploded"))
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
		condense.mockImplementation(
			() =>
				new Promise<CondenseStubResult>((resolve) => {
					release = resolve
				}),
		)

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

	// Arm the timer for the pending follow-up, then let it expire while the
	// task still has a request in flight, so the expiry discards the timer.
	async function discardTimerDuringApiWork(task: Task) {
		const endApiWork = task["beginApiWork"]()
		await task["maybeStartIdleCondenseTimer"]()
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
		["a different pending ask", () => "resume_task" as ClineAsk],
		["a partial follow-up ask", () => "followup" as ClineAsk],
	])(
		"does not re-arm when the stream ends with %s",
		async (_label, pickAsk) => {
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
})

describe("Task idle condensing — re-evaluation after settings save", () => {
	// Saving idle-condense settings re-evaluates the waiting task: enabling
	// the feature (or loosening a threshold) while the task is already idle
	// above the threshold must start a countdown that nothing else armed.
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

	test("keeps an already-armed countdown untouched", async () => {
		const { task } = buildTask()
		task["idleCondenseTimeoutRef"] = setTimeout(() => {}, 30_000)

		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)

		// maybeStartIdleCondenseTimer no-ops while a timer is armed: still one,
		// and the fake clock never reached its deadline.
		expect(task["idleCondenseTimeoutRef"]).toBeDefined()
		expect(vi.getTimerCount()).toBe(1)
	})

	test("a save that disables the feature does not arm a countdown", async () => {
		const { task } = buildTask({ state: baseState({ idleCondenseContext: false }) })

		task.reevaluateIdleCondenseAfterSettingsSave()
		await vi.advanceTimersByTimeAsync(0)

		expect(task["idleCondenseTimeoutRef"]).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
	})
})
