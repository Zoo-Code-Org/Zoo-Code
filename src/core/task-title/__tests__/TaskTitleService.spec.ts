import { providerIdentifiers, type HistoryItem, type ProviderSettings } from "@roo-code/types"

import { generateTaskTitle, type GenerateTaskTitleOptions } from "../generateTaskTitle"
import {
	TASK_TITLE_MAX_CONCURRENT,
	TaskTitleService,
	type TaskTitleServiceDeps,
	type TaskTitleSettings,
	type TaskTitleTask,
} from "../TaskTitleService"

const LONG_PROMPT = "Please refactor the authentication module so that it supports refresh tokens"
const FALLBACK = "Please refactor the authentication module"
const USED = { totalTokensIn: 10 }

const taskProfile: ProviderSettings = { apiProvider: providerIdentifiers.anthropic }

interface Deferred {
	options: GenerateTaskTitleOptions
	resolve(value: string | undefined): void
	reject(error: Error): void
}

function historyItem(id: string, overrides: Partial<HistoryItem> = {}): HistoryItem {
	return { id, number: 1, ts: 1, task: LONG_PROMPT, tokensIn: 0, tokensOut: 0, totalCost: 0, ...overrides }
}

function createHarness(
	options: {
		settings?: Partial<TaskTitleSettings>
		items?: HistoryItem[]
		deps?: Partial<Pick<TaskTitleServiceDeps, "resolveProfile" | "isProfileAllowed">>
		/** Keep a request pending after abort, like a provider that ignores the signal. */
		ignoreAbort?: boolean
	} = {},
) {
	const items = new Map((options.items ?? []).map((item) => [item.id, item]))
	const settings: TaskTitleSettings = { enabled: true, ...options.settings }
	const written: Array<{ taskId: string; title: string }> = []
	const requests: Deferred[] = []
	const profiles = new Map<string, ProviderSettings>()
	const prohibited = new Set<ProviderSettings>()

	const service = new TaskTitleService({
		getHistoryItem: (taskId) => items.get(taskId),
		setAutoTitle: async (taskId, title) => {
			written.push({ taskId, title })
		},
		getSettings: async () => settings,
		resolveProfile: async (id) => profiles.get(id),
		isProfileAllowed: async (profile) => !prohibited.has(profile),
		generate: (generateOptions) =>
			new Promise<string | undefined>((resolve, reject) => {
				requests.push({ options: generateOptions, resolve, reject })
				if (!options.ignoreAbort) {
					generateOptions.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					})
				}
			}),
		...options.deps,
	})

	const task = (taskId: string, overrides: Partial<TaskTitleTask> = {}): TaskTitleTask => ({
		taskId,
		apiConfiguration: taskProfile,
		...overrides,
	})

	/** Create a task whose history item exists only after creation, as for a brand-new root task. */
	const startTask = (taskId: string, overrides: Partial<TaskTitleTask> = {}, item?: Partial<HistoryItem>) => {
		service.onTaskCreated(task(taskId, overrides))
		items.set(taskId, historyItem(taskId, item))
	}

	return { service, items, settings, written, requests, profiles, prohibited, task, startTask }
}

/** Node's native AbortSignal.timeout ignores fake timers; route it through setTimeout instead. */
function useFakeAbortSignalTimeout() {
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
		const controller = new AbortController()
		setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), ms)
		return controller.signal
	})
}

const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe("TaskTitleService", () => {
	describe("what gets a request", () => {
		it("generates and records a title after the first API usage", async () => {
			const h = createHarness()
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()
			expect(h.requests).toHaveLength(1)
			expect(h.requests[0]!.options).toMatchObject({ prompt: LONG_PROMPT, profile: taskProfile })

			h.requests[0]!.resolve("Refactor auth module")
			await flush()

			expect(h.written).toEqual([{ taskId: "t1", title: "Refactor auth module" }])
		})

		it("ignores usage updates before any input tokens were used", async () => {
			const h = createHarness()
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", { totalTokensIn: 0 })
			await flush()
			expect(h.requests).toHaveLength(0)

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()
			expect(h.requests).toHaveLength(1)
		})

		it("runs once per task however many usage updates arrive", async () => {
			const h = createHarness()
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", USED)
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()
			h.requests[0]!.resolve("Title")
			await flush()
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests).toHaveLength(1)
			expect(h.written).toHaveLength(1)
		})

		it("uses the configured title profile instead of the task profile", async () => {
			const h = createHarness({ settings: { apiConfigId: "light" } })
			const lightProfile: ProviderSettings = { apiProvider: providerIdentifiers.openai }
			h.profiles.set("light", lightProfile)
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests[0]!.options.profile).toBe(lightProfile)
		})

		it("falls back to the task profile when the configured profile no longer exists", async () => {
			const h = createHarness({ settings: { apiConfigId: "gone" } })
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests[0]!.options.profile).toBe(taskProfile)
		})

		it("generates a title for a prompt of 42 characters or fewer", async () => {
			const h = createHarness()
			h.startTask("t1", {}, { task: "Fix the login bug" })

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()
			h.requests[0]!.resolve("Login bug fix")
			await flush()

			expect(h.requests[0]!.options.prompt).toBe("Fix the login bug")
			expect(h.written).toEqual([{ taskId: "t1", title: "Login bug fix" }])
		})

		it("passes custom support prompts to the generator", async () => {
			const h = createHarness({ settings: { customSupportPrompts: { TASK_TITLE: "x ${userInput}" } } })
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests[0]!.options.customSupportPrompts).toEqual({ TASK_TITLE: "x ${userInput}" })
		})
	})

	describe("exclusions", () => {
		const cases: Array<{
			name: string
			setup(h: ReturnType<typeof createHarness>): void
			expectFallback: boolean
		}> = [
			{
				name: "a subtask",
				setup: (h) => h.startTask("t1", { parentTaskId: "parent" }),
				expectFallback: false,
			},
			{
				name: "a resumed task (history item already exists)",
				setup: (h) => {
					h.items.set("t1", historyItem("t1"))
					h.service.onTaskCreated(h.task("t1"))
				},
				expectFallback: false,
			},
			{
				name: "generation disabled",
				setup: (h) => {
					h.settings.enabled = false
					h.startTask("t1")
				},
				expectFallback: false,
			},
			{
				name: "an existing manual title",
				setup: (h) => h.startTask("t1", {}, { title: "Mine" }),
				expectFallback: false,
			},
			{
				name: "an existing auto title",
				setup: (h) => h.startTask("t1", {}, { autoTitle: "Already" }),
				expectFallback: false,
			},
			{
				name: "a task profile with a rate limit",
				setup: (h) => h.startTask("t1", { apiConfiguration: { ...taskProfile, rateLimitSeconds: 5 } }),
				expectFallback: true,
			},
		]

		it.each(cases)("sends no request for $name", async ({ setup, expectFallback }) => {
			const h = createHarness()
			setup(h)

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests).toHaveLength(0)
			expect(h.written).toEqual(expectFallback ? [{ taskId: "t1", title: FALLBACK }] : [])
		})

		it("records only the fallback when the title profile has a rate limit", async () => {
			const h = createHarness({ settings: { apiConfigId: "limited" } })
			h.profiles.set("limited", { apiProvider: providerIdentifiers.openai, rateLimitSeconds: 1 })
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests).toHaveLength(0)
			expect(h.written).toEqual([{ taskId: "t1", title: FALLBACK }])
		})
	})

	describe("organization allow-list", () => {
		it("records only the fallback when the title profile is prohibited", async () => {
			const h = createHarness({ settings: { apiConfigId: "blocked" } })
			const blocked: ProviderSettings = { apiProvider: providerIdentifiers.openai }
			h.profiles.set("blocked", blocked)
			h.prohibited.add(blocked)
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests).toHaveLength(0)
			expect(h.written).toEqual([{ taskId: "t1", title: FALLBACK }])
		})

		it("does not switch to the task profile when the title profile is prohibited", async () => {
			const h = createHarness({ settings: { apiConfigId: "blocked" } })
			const blocked: ProviderSettings = { apiProvider: providerIdentifiers.openai }
			h.profiles.set("blocked", blocked)
			h.prohibited.add(blocked)
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests.some((r) => r.options.profile === taskProfile)).toBe(false)
		})

		it("checks the policy at request time, after the task was created", async () => {
			const h = createHarness()
			h.startTask("t1")
			// The task profile became prohibited after the task started.
			h.prohibited.add(taskProfile)

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests).toHaveLength(0)
			expect(h.written).toEqual([{ taskId: "t1", title: FALLBACK }])
		})

		it("still requests when the effective profile is allowed", async () => {
			const h = createHarness()
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests).toHaveLength(1)
		})

		it.each([
			{ name: "profile lookup", deps: { resolveProfile: () => Promise.reject(new Error("profile removed")) } },
			{ name: "policy check", deps: { isProfileAllowed: () => Promise.reject(new Error("state unavailable")) } },
		])("records only the fallback when the $name rejects", async ({ deps }) => {
			const h = createHarness({ settings: { apiConfigId: "light" }, deps })
			h.profiles.set("light", { apiProvider: providerIdentifiers.openai })
			h.startTask("t1")

			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests).toHaveLength(0)
			expect(h.written).toEqual([{ taskId: "t1", title: FALLBACK }])
		})
	})

	describe("results", () => {
		it.each([
			["a provider failure", (d: Deferred) => d.reject(new Error("boom"))],
			["an unusable result", (d: Deferred) => d.resolve(undefined)],
		])("records the fallback title after %s", async (_label, settle) => {
			const h = createHarness()
			h.startTask("t1")
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			settle(h.requests[0]!)
			await flush()

			expect(h.written).toEqual([{ taskId: "t1", title: FALLBACK }])
		})

		it("still hands the generated title to setAutoTitle when the item vanished meanwhile", async () => {
			const h = createHarness()
			h.startTask("t1")
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()
			h.items.delete("t1")

			h.requests[0]!.resolve("Title")
			await flush()

			// The service delegates the final decision to setAutoTitle (store lock); it still attempts the write.
			expect(h.written).toEqual([{ taskId: "t1", title: "Title" }])
		})
	})

	describe("concurrency", () => {
		it("runs at most two requests at once and starts queued ones as slots free up", async () => {
			const h = createHarness()
			for (const id of ["a", "b", "c"]) {
				h.startTask(id)
				h.service.onTokenUsageUpdated(id, USED)
			}
			await flush()

			expect(TASK_TITLE_MAX_CONCURRENT).toBe(2)
			expect(h.requests).toHaveLength(2)

			h.requests[0]!.resolve("First")
			await flush()

			expect(h.requests).toHaveLength(3)
			expect(h.requests.map((r) => r.options.prompt)).toEqual([LONG_PROMPT, LONG_PROMPT, LONG_PROMPT])
		})
	})

	describe("cancellation", () => {
		it("aborts a running request on user cancel and records the fallback", async () => {
			const h = createHarness()
			h.startTask("t1")
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			h.service.cancel("t1", "user")
			await flush()

			expect(h.requests[0]!.options.signal?.aborted).toBe(true)
			expect(h.written).toEqual([{ taskId: "t1", title: FALLBACK }])
		})

		it("discards a late generated title after a user cancel", async () => {
			const h = createHarness({ ignoreAbort: true })
			h.startTask("t1")
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			h.service.cancel("t1", "user")
			h.requests[0]!.resolve("Too late")
			await flush()

			expect(h.requests[0]!.options.signal?.aborted).toBe(true)
			expect(h.written).toEqual([{ taskId: "t1", title: FALLBACK }])
		})

		it("aborts a running request on delete and records nothing", async () => {
			const h = createHarness()
			h.startTask("t1")
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			h.service.cancel("t1", "deleted")
			h.requests[0]!.resolve("Late")
			await flush()

			expect(h.requests[0]!.options.signal?.aborted).toBe(true)
			expect(h.written).toEqual([])
		})

		it.each([
			{ reason: "user" as const, written: [{ taskId: "t1", title: FALLBACK }] },
			{ reason: "deleted" as const, written: [] },
		])("sends no request when cancelled ($reason) during the policy check", async ({ reason, written }) => {
			let allow: (allowed: boolean) => void = () => {}
			const h = createHarness({
				deps: { isProfileAllowed: () => new Promise<boolean>((resolve) => (allow = resolve)) },
			})
			h.startTask("t1")
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			h.service.cancel("t1", reason)
			allow(true)
			await flush()

			expect(h.requests).toHaveLength(0)
			expect(h.written).toEqual(written)
		})

		it("records the fallback for a queued task cancelled by the user without a request", async () => {
			const h = createHarness()
			for (const id of ["a", "b", "c"]) {
				h.startTask(id)
				h.service.onTokenUsageUpdated(id, USED)
			}
			await flush()

			h.service.cancel("c", "user")
			await flush()

			expect(h.requests).toHaveLength(2)
			expect(h.written).toEqual([{ taskId: "c", title: FALLBACK }])

			h.requests[0]!.resolve("A")
			await flush()
			expect(h.requests).toHaveLength(2)
		})

		it("records nothing for a queued task that is deleted", async () => {
			const h = createHarness()
			for (const id of ["a", "b", "c"]) {
				h.startTask(id)
				h.service.onTokenUsageUpdated(id, USED)
			}
			await flush()

			h.service.cancel("c", "deleted")
			h.requests[0]!.resolve("A")
			h.requests[1]!.resolve("B")
			await flush()

			expect(h.requests).toHaveLength(2)
			expect(h.written.map((w) => w.taskId).sort()).toEqual(["a", "b"])
		})

		it("never schedules a task cancelled by the user before its first API usage", async () => {
			const h = createHarness()
			h.startTask("t1")

			h.service.cancel("t1", "user")
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests).toHaveLength(0)
			expect(h.written).toEqual([])
		})

		it("keeps running when the task is merely switched away (no cancel call)", async () => {
			const h = createHarness()
			h.startTask("t1")
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			// A TaskAborted caused by a task switch or stack removal does not call cancel().
			h.requests[0]!.resolve("Still generated")
			await flush()

			expect(h.requests[0]!.options.signal?.aborted).toBe(false)
			expect(h.written).toEqual([{ taskId: "t1", title: "Still generated" }])
		})

		it("drops an unscheduled task that leaves the stack before its first API usage", async () => {
			const h = createHarness()
			h.startTask("t1")

			h.service.forget("t1")
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			expect(h.requests).toHaveLength(0)
			expect(h.written).toEqual([])
		})

		it("keeps a scheduled request running when the task leaves the stack", async () => {
			const h = createHarness()
			h.startTask("t1")
			h.service.onTokenUsageUpdated("t1", USED)
			await flush()

			h.service.forget("t1")
			h.requests[0]!.resolve("Still generated")
			await flush()

			expect(h.requests[0]!.options.signal?.aborted).toBe(false)
			expect(h.written).toEqual([{ taskId: "t1", title: "Still generated" }])
		})

		it("does not retain the live task object for an unscheduled candidate", () => {
			const h = createHarness()
			const live = { ...h.task("t1"), extra: "live task state" }
			h.service.onTaskCreated(live)

			const stored = h.service["candidates"].get("t1")
			expect(stored).not.toBe(live)
			expect(stored).toEqual({ taskId: "t1", parentTaskId: undefined, apiConfiguration: taskProfile })
		})

		it("aborts everything and writes nothing after dispose", async () => {
			const h = createHarness()
			for (const id of ["a", "b", "c"]) {
				h.startTask(id)
				h.service.onTokenUsageUpdated(id, USED)
			}
			await flush()

			h.service.dispose()
			h.requests[0]!.resolve("A")
			await flush()

			expect(h.requests.every((r) => r.options.signal?.aborted)).toBe(true)
			expect(h.requests).toHaveLength(2)
			expect(h.written).toEqual([])
		})
	})

	describe("a provider that ignores the abort signal", () => {
		beforeEach(() => {
			vi.useFakeTimers()
			useFakeAbortSignalTimeout()
		})
		afterEach(() => {
			vi.restoreAllMocks()
			vi.useRealTimers()
		})

		it("records the fallback once the 15 second limit passes", async () => {
			const written: string[] = []
			const items = new Map<string, HistoryItem>()
			const service = new TaskTitleService({
				getHistoryItem: (taskId) => items.get(taskId),
				setAutoTitle: async (_taskId, title) => {
					written.push(title)
				},
				getSettings: async () => ({ enabled: true }),
				resolveProfile: async () => undefined,
				isProfileAllowed: async () => true,
				generate: (options) => generateTaskTitle({ ...options, complete: () => new Promise<string>(() => {}) }),
			})
			service.onTaskCreated({ taskId: "t1", apiConfiguration: taskProfile })
			items.set("t1", historyItem("t1"))
			service.onTokenUsageUpdated("t1", USED)

			await vi.advanceTimersByTimeAsync(14_000)
			expect(written).toEqual([])

			await vi.advanceTimersByTimeAsync(2_000)
			expect(written).toEqual([FALLBACK])
		})
	})
})
