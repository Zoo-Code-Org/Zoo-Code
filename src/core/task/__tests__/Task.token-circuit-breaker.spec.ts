import type { Anthropic } from "@anthropic-ai/sdk"

import { Task } from "../Task"

describe("Task Token Circuit Breaker", () => {
	function createTestTask(tokenCircuitBreakerLimit: number, totalTokens: number) {
		const task = Object.create(Task.prototype) as Task
		const stopError = new Error("STOP_AFTER_CIRCUIT_BREAKER")

		Object.assign(task, {
			taskId: "task-test-cb",
			instanceId: "inst-test-cb",
			tokenCircuitBreakerLimit,
			consecutiveMistakeLimit: 0,
			consecutiveMistakeCount: 0,
			abort: false,
			getTokenUsage: vi.fn().mockReturnValue({
				totalTokensIn: totalTokens,
				totalTokensOut: 0,
			}),
			ask: vi.fn(),
			maybeWaitForProviderRateLimit: vi.fn().mockRejectedValue(stopError),
		})

		return { task, stopError }
	}

	it("treats yesButtonClicked as approval, advances the threshold, and appends approval text", async () => {
		const initialLimit = 50_000
		const currentTokens = 60_000
		const { task, stopError } = createTestTask(initialLimit, currentTokens)
		task.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })

		const userContent: Anthropic.Messages.ContentBlockParam[] = []

		await expect(task.recursivelyMakeClineRequests(userContent)).rejects.toThrow(stopError)

		expect(task.ask).toHaveBeenCalledWith(
			"mistake_limit_reached",
			expect.stringContaining("Token circuit breaker tripped: cumulative token limit reached (60,000 / 50,000 tokens)"),
		)
		// Advanced threshold: currentTokens (60k) + initialLimit (50k) = 110k
		expect(task.tokenCircuitBreakerLimit).toBe(110_000)
		expect(userContent).toContainEqual({
			type: "text",
			text: "User approved continuing beyond token circuit breaker limit.",
		})
	})

	it("treats messageResponse as approval with custom feedback text", async () => {
		const initialLimit = 50_000
		const currentTokens = 60_000
		const { task, stopError } = createTestTask(initialLimit, currentTokens)
		task.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "Authorized an additional 50k tokens",
		})

		const userContent: Anthropic.Messages.ContentBlockParam[] = []

		await expect(task.recursivelyMakeClineRequests(userContent)).rejects.toThrow(stopError)

		expect(task.tokenCircuitBreakerLimit).toBe(110_000)
		expect(userContent).toContainEqual({
			type: "text",
			text: "User approved exceeding token budget: Authorized an additional 50k tokens",
		})
	})

	it("rejects and pauses task when user declines approval", async () => {
		const initialLimit = 50_000
		const currentTokens = 60_000
		const { task } = createTestTask(initialLimit, currentTokens)
		task.ask = vi.fn().mockResolvedValue({ response: "noButtonClicked" })

		const userContent: Anthropic.Messages.ContentBlockParam[] = []

		await expect(task.recursivelyMakeClineRequests(userContent)).rejects.toThrow(
			"[TokenCircuitBreaker] Cumulative token limit of 50,000 tokens exceeded. Task paused.",
		)

		// Limit remains unchanged
		expect(task.tokenCircuitBreakerLimit).toBe(50_000)
		expect(userContent).toHaveLength(0)
	})
})
