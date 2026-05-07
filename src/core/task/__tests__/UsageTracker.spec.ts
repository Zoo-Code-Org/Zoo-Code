import { afterEach, describe, expect, it, vi } from "vitest"
import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { UsageTracker } from "../UsageTracker.js"

const createUsageMessage = (text: string, ts = 1000): ClineMessage => ({
	type: "say",
	say: "api_req_started",
	text,
	ts,
})

describe("UsageTracker", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("recomputes tokenUsage on each read after an emitted snapshot exists", () => {
		const messages: ClineMessage[] = [
			{ type: "say", say: "text", text: "task", ts: 1 },
			createUsageMessage('{"tokensIn":100,"tokensOut":50,"cost":0.01}', 1000),
		]
		const tracker = new UsageTracker({
			taskId: "task-id",
			getMessages: () => messages,
			emit: vi.fn(),
		})

		tracker.emitTokenUsageUpdate(tracker.getTokenUsage())
		expect(tracker.tokenUsage.totalTokensIn).toBe(100)

		messages[1] = createUsageMessage('{"tokensIn":250,"tokensOut":50,"cost":0.02}', 1000)

		expect(tracker.tokenUsage.totalTokensIn).toBe(250)
		expect(tracker.tokenUsage.totalCost).toBe(0.02)
	})

	it("keeps emitted snapshots for change comparisons", () => {
		const emit = vi.fn()
		const messages: ClineMessage[] = [
			{ type: "say", say: "text", text: "task", ts: 1 },
			createUsageMessage('{"tokensIn":100,"tokensOut":50,"cost":0.01}', 1000),
		]
		const tracker = new UsageTracker({
			taskId: "task-id",
			getMessages: () => messages,
			emit,
		})

		tracker.emitTokenUsageUpdate(tracker.getTokenUsage())

		expect(emit).toHaveBeenCalledWith(
			RooCodeEventName.TaskTokenUsageUpdated,
			"task-id",
			expect.objectContaining({ totalTokensIn: 100 }),
			{},
		)
		expect((tracker as any).tokenUsageSnapshot.totalTokensIn).toBe(100)
	})

	it("cancels pending debounced token usage emissions on dispose", () => {
		vi.useFakeTimers()

		const emit = vi.fn()
		const messages: ClineMessage[] = [
			{ type: "say", say: "text", text: "task", ts: 1 },
			createUsageMessage('{"tokensIn":100,"tokensOut":50,"cost":0.01}', 1000),
		]
		const tracker = new UsageTracker({
			taskId: "task-id",
			getMessages: () => messages,
			emit,
			emitIntervalMs: 1000,
		})

		tracker.emitTokenUsageUpdate(tracker.getTokenUsage())
		messages[1] = createUsageMessage('{"tokensIn":250,"tokensOut":50,"cost":0.02}', 1000)
		tracker.emitTokenUsageUpdate(tracker.getTokenUsage())

		expect(emit).toHaveBeenCalledTimes(1)

		tracker.dispose()
		vi.advanceTimersByTime(1000)

		expect(emit).toHaveBeenCalledTimes(1)
	})
})
