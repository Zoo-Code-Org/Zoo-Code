import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types"

import { Task } from "../Task"
import * as taskTitleGen from "../taskTitleGenerator"
import { createRateLimitClock, type RateLimitClock } from "../RateLimitClock"
import { setAbortLatch } from "../../../test-utils/run-state"

// Keep the real constants and the fallback helper; only the LLM call is mocked
// so `generateTitleInBackground` exercises the real fallback/retry decisions.
vi.mock("../taskTitleGenerator", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../taskTitleGenerator")>()
	return {
		...actual,
		generateTaskTitle: vi.fn(),
	}
})

// Mock delay so the title request's rate-limit wait can be observed without
// real timers (same pattern as the rate-limit tests in Task.spec).
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

import delay from "delay"

type TaskTitleAccess = {
	generateTitleInBackground(taskText: string): Promise<void>
	startTask(task?: string, images?: string[]): Promise<void>
	cancelCurrentRequest(): void
	requestAbort(isAbandoned: boolean): void
	titleAbortController?: AbortController
	abort: boolean
	abandoned: boolean
	taskId: string
	instanceId: string
	apiConfiguration: ProviderSettings
	parentTask?: Task
	metadata: { task?: string; images?: string[] }
	initiateTaskLoop: ReturnType<typeof vi.fn>
}

const getTaskTitleAccess = (task: Task) => task as unknown as TaskTitleAccess

describe("Task title generation", () => {
	const mockApiConfig: ProviderSettings = {
		apiProvider: providerIdentifiers.anthropic,
		apiKey: "test-key",
	}

	let mockSetGeneratedTaskTitle: ReturnType<typeof vi.fn>
	let mockProvider: {
		setGeneratedTaskTitle: ReturnType<typeof vi.fn>
		postStateToWebviewWithoutTaskHistory: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockSetGeneratedTaskTitle = vi.fn().mockResolvedValue(true)
		mockProvider = {
			setGeneratedTaskTitle: mockSetGeneratedTaskTitle,
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		}
	})

	function createTestTask(
		options: {
			parentTask?: Task
			rateLimitClock?: RateLimitClock
			apiConfiguration?: ProviderSettings
		} = {},
	) {
		const task = Object.create(Task.prototype) as Task
		setAbortLatch(task, false)
		const taskId = "task-title-1"

		Object.assign(task, {
			taskId,
			instanceId: "inst-1",
			apiConfiguration: options.apiConfiguration ?? mockApiConfig,
			providerRef: { deref: () => mockProvider },
			abandoned: false,
			parentTask: options.parentTask,
			rateLimitClock: options.rateLimitClock ?? createRateLimitClock(),
			metadata: { task: "Initial prompt message" },
			say: vi.fn().mockResolvedValue(undefined),
			getEnabledMcpToolsCount: vi.fn().mockResolvedValue({ enabledToolCount: 0, enabledServerCount: 0 }),
			markInitialized: vi.fn(),
			initiateTaskLoop: vi.fn().mockResolvedValue(undefined),
			driveRunEvent: vi.fn(),
		})

		return task
	}

	describe("generateTitleInBackground", () => {
		it("applies the generated title through the atomic conditional write", async () => {
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")
			const task = createTestTask()

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(taskTitleGen.generateTaskTitle).toHaveBeenCalledWith(
				"Initial prompt message",
				mockApiConfig,
				expect.objectContaining({
					taskId: "task-title-1",
					timeoutMs: taskTitleGen.DEFAULT_TITLE_TIMEOUT_MS,
				}),
			)
			// Issue #2333: the model request is limited to 15 seconds.
			expect(taskTitleGen.DEFAULT_TITLE_TIMEOUT_MS).toBe(15000)
			expect(mockSetGeneratedTaskTitle).toHaveBeenCalledTimes(1)
			expect(mockSetGeneratedTaskTitle).toHaveBeenCalledWith("task-title-1", "Summarized Title")
		})

		it("falls back to the first 42 characters of the prompt when generation fails (issue #2333)", async () => {
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce(undefined)
			const longPrompt = "Please fix the login page button alignment issue on mobile devices"
			const task = createTestTask()

			await getTaskTitleAccess(task).generateTitleInBackground(longPrompt)

			const expectedFallback = taskTitleGen.fallbackTaskTitle(longPrompt)
			expect(expectedFallback).toHaveLength(42)
			expect(mockSetGeneratedTaskTitle).toHaveBeenCalledTimes(1)
			expect(mockSetGeneratedTaskTitle).toHaveBeenCalledWith("task-title-1", expectedFallback)
		})

		it("keeps an existing title instead of overwriting it (manual rename wins)", async () => {
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")
			mockSetGeneratedTaskTitle.mockResolvedValueOnce(false)
			const task = createTestTask()

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			// `false` means the item already had a title: no retry, no overwrite.
			expect(mockSetGeneratedTaskTitle).toHaveBeenCalledTimes(1)
		})

		it("retries the atomic write when the task is not yet recorded in the store", async () => {
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")
			mockSetGeneratedTaskTitle
				.mockRejectedValueOnce(new Error("task not found in cache"))
				.mockResolvedValueOnce(true)
			const task = createTestTask()

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(mockSetGeneratedTaskTitle).toHaveBeenCalledTimes(2)
			expect(mockSetGeneratedTaskTitle).toHaveBeenLastCalledWith("task-title-1", "Summarized Title")
		})

		it("applies the truncated-prompt fallback title after the write retries are exhausted (issue #2333)", async () => {
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")
			mockSetGeneratedTaskTitle
				.mockRejectedValueOnce(new Error("task not found in cache"))
				.mockRejectedValueOnce(new Error("task not found in cache"))
				.mockRejectedValueOnce(new Error("task not found in cache"))
				.mockResolvedValueOnce(true)
			const task = createTestTask()

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			// Three attempts with the generated title, then one with the fallback.
			expect(mockSetGeneratedTaskTitle).toHaveBeenCalledTimes(4)
			expect(mockSetGeneratedTaskTitle).toHaveBeenNthCalledWith(1, "task-title-1", "Summarized Title")
			expect(mockSetGeneratedTaskTitle).toHaveBeenNthCalledWith(3, "task-title-1", "Summarized Title")
			expect(mockSetGeneratedTaskTitle).toHaveBeenLastCalledWith(
				"task-title-1",
				taskTitleGen.fallbackTaskTitle("Initial prompt message"),
			)
		})

		it("does not call setGeneratedTaskTitle if task is aborted during generation", async () => {
			const task = createTestTask()
			vi.mocked(taskTitleGen.generateTaskTitle).mockImplementationOnce(async () => {
				setAbortLatch(task, true)
				return "Summarized Title"
			})

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(mockSetGeneratedTaskTitle).not.toHaveBeenCalled()
		})

		it("does not call setGeneratedTaskTitle if task is abandoned during generation", async () => {
			const task = createTestTask()
			vi.mocked(taskTitleGen.generateTaskTitle).mockImplementationOnce(async () => {
				task.abandoned = true
				return "Summarized Title"
			})

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(mockSetGeneratedTaskTitle).not.toHaveBeenCalled()
		})

		it("cleans up titleAbortController when finished", async () => {
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")
			const task = createTestTask()

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(getTaskTitleAccess(task).titleAbortController).toBeUndefined()
		})
	})

	describe("generateTitleInBackground rate-limit coordination", () => {
		it("waits out the remaining provider rate-limit window before the title request", async () => {
			const clock = createRateLimitClock()
			const task = createTestTask({
				rateLimitClock: clock,
				apiConfiguration: { ...mockApiConfig, rateLimitSeconds: 10 },
			})
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")
			const mockDelay = vi.mocked(delay)
			// Record the wait options while the controller still exists; it is
			// cleaned up in the method's `finally` block.
			let observedSignal: unknown
			mockDelay.mockImplementationOnce((_ms: number, opts?: { signal?: AbortSignal }) => {
				observedSignal = opts?.signal
				return Promise.resolve(undefined)
			})

			// A prior request (e.g. the previous task's) leaves a timestamp on the
			// shared clock, so the title request must not bypass the window.
			clock.recordRequest()

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(mockDelay).toHaveBeenCalledTimes(1)
			const waitedMs = mockDelay.mock.calls[0]?.[0]
			expect(waitedMs).toBeGreaterThan(0)
			expect(waitedMs).toBeLessThanOrEqual(10_000)
			// The wait is abort-aware so cancellation can interrupt it.
			expect(observedSignal).toBeInstanceOf(AbortSignal)
			// The wait happens before the provider request is issued.
			expect(mockDelay.mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(taskTitleGen.generateTaskTitle).mock.invocationCallOrder[0],
			)
		})

		it("records the title request on the shared rate-limit clock", async () => {
			const clock = createRateLimitClock()
			const task = createTestTask({ rateLimitClock: clock })
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")

			expect(clock.getLastRequestTime()).toBeUndefined()

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			// Subsequent task/subtask requests see this timestamp and honour it.
			expect(clock.getLastRequestTime()).toBeDefined()
		})

		it("does not wait when no rate limit is configured or the clock is empty", async () => {
			const task = createTestTask({ apiConfiguration: { ...mockApiConfig, rateLimitSeconds: 10 } })
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")
			const mockDelay = vi.mocked(delay)

			// rateLimitSeconds is set, but the shared clock has no recorded
			// request yet — nothing to wait for.
			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(mockDelay).not.toHaveBeenCalled()
			expect(taskTitleGen.generateTaskTitle).toHaveBeenCalledTimes(1)
		})

		it("skips the title request when the task is aborted during the rate-limit wait", async () => {
			const clock = createRateLimitClock()
			const task = createTestTask({
				rateLimitClock: clock,
				apiConfiguration: { ...mockApiConfig, rateLimitSeconds: 10 },
			})
			const access = getTaskTitleAccess(task)
			clock.recordRequest()
			const timestampBeforeWait = clock.getLastRequestTime()
			// Simulate the wait being interrupted by cancellation: the delay
			// promise rejects like `delay` does on an aborted signal.
			vi.mocked(delay).mockImplementationOnce(() => {
				access.titleAbortController?.abort()
				return Promise.reject(new Error("The operation was aborted"))
			})

			await access.generateTitleInBackground("Initial prompt message")

			// No provider request, no phantom clock timestamp that would delay
			// the next request.
			expect(taskTitleGen.generateTaskTitle).not.toHaveBeenCalled()
			expect(clock.getLastRequestTime()).toBe(timestampBeforeWait)
			expect(mockSetGeneratedTaskTitle).not.toHaveBeenCalled()
		})
	})

	describe("cancellation and abort handling", () => {
		it("aborts titleAbortController in cancelCurrentRequest", () => {
			const task = createTestTask()
			const access = getTaskTitleAccess(task)
			const controller = new AbortController()
			const abortSpy = vi.spyOn(controller, "abort")
			access.titleAbortController = controller

			access.cancelCurrentRequest()

			expect(abortSpy).toHaveBeenCalled()
			expect(access.titleAbortController).toBeUndefined()
		})

		it("aborts titleAbortController in requestAbort", () => {
			const task = createTestTask()
			const access = getTaskTitleAccess(task)
			const controller = new AbortController()
			const abortSpy = vi.spyOn(controller, "abort")
			access.titleAbortController = controller

			access.requestAbort(false)

			expect(abortSpy).toHaveBeenCalled()
			expect(access.titleAbortController).toBeUndefined()
		})
	})

	describe("startTask background trigger", () => {
		it("starts background title generation for top-level task with prompt", async () => {
			const task = createTestTask()
			const access = getTaskTitleAccess(task)
			const titleBgSpy = vi.spyOn(access, "generateTitleInBackground").mockResolvedValue(undefined)

			await access.startTask("Initial prompt message")

			expect(titleBgSpy).toHaveBeenCalledWith("Initial prompt message")
		})

		it("does not start title generation for child/subtasks", async () => {
			const parent = createTestTask()
			const child = createTestTask({ parentTask: parent })
			const access = getTaskTitleAccess(child)
			const titleBgSpy = vi.spyOn(access, "generateTitleInBackground").mockResolvedValue(undefined)

			await access.startTask("Child subtask prompt")

			expect(titleBgSpy).not.toHaveBeenCalled()
		})

		it("does not start title generation when prompt is omitted", async () => {
			const task = createTestTask()
			const access = getTaskTitleAccess(task)
			const titleBgSpy = vi.spyOn(access, "generateTitleInBackground").mockResolvedValue(undefined)

			await access.startTask(undefined)

			expect(titleBgSpy).not.toHaveBeenCalled()
		})

		it("starts the task loop without waiting for title generation to settle", async () => {
			// Regression evidence: the background generation must never block the
			// task loop. Keep generation pending and verify the loop already ran.
			let resolveGeneration!: (title: string | undefined) => void
			vi.mocked(taskTitleGen.generateTaskTitle).mockImplementationOnce(
				() =>
					new Promise<string | undefined>((resolve) => {
						resolveGeneration = resolve
					}),
			)
			const task = createTestTask()
			const access = getTaskTitleAccess(task)

			const started = access.startTask("Initial prompt message")

			// Generation is still pending here; the task loop must have started.
			await vi.waitFor(() => expect(access.initiateTaskLoop).toHaveBeenCalled())

			resolveGeneration("Summarized Title")
			await started
			await vi.waitFor(() => expect(mockSetGeneratedTaskTitle).toHaveBeenCalled())
			expect(mockSetGeneratedTaskTitle).toHaveBeenCalledWith("task-title-1", "Summarized Title")
		})
	})
})
