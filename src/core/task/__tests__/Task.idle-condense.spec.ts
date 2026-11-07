// pnpm --dir src exec vitest run core/task/__tests__/Task.idle-condense.spec.ts
import type { ModelInfo, TokenUsage } from "@roo-code/types"

import type { ContextManagementResult } from "../../context-management"

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
		// No listApiConfigMeta => getCurrentProfileId() resolves to "default".
		const { task } = buildTask({ state: baseState({ profileIdleThresholds: { default: 20 } }) })

		const gate = await task["evaluateIdleCondense"]()

		expect(gate?.idlePercent).toBe(20)
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
