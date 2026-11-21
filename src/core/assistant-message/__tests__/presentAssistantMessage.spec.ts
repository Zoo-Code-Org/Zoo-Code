// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage.spec.ts

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { DispatchState, transitionDispatch } from "../../task/dispatchState"
import type { Task } from "../../task/Task"
import type { RequestPolicySnapshot } from "../../prompts/tools/effective-tool-policy"

vi.mock("../../task/Task")
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

const snapshot: RequestPolicySnapshot = { disabledTools: [], customModes: [] }

describe("presentAssistantMessage dispatch re-entrancy", () => {
	let task: Task
	let say: Mock

	beforeEach(() => {
		say = vi.fn().mockResolvedValue(undefined)
		// Double provides only the members the text-block path reads.
		task = {
			taskId: "task-id",
			instanceId: "instance-id",
			abort: false,
			dispatchState: DispatchState.IDLE,
			pendingWork: null,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [{ type: "text", content: "partial", partial: true }],
			userMessageContent: [],
			didCompleteReadingStream: false,
			activeToolContexts: new Map(),
			say,
		} as unknown as Task
	})

	it.each([DispatchState.SERIAL, DispatchState.PARALLEL])("queues pending work while %s", async (state) => {
		task.dispatchState = state

		await presentAssistantMessage(task, snapshot)

		expect(task.pendingWork).toEqual({ mode: "serial" })
		expect(task.dispatchState).toBe(state)
		expect(say).not.toHaveBeenCalled()
	})

	it("drains pending work once after the first call completes", async () => {
		say.mockImplementationOnce(async () => {
			expect(task.dispatchState).toBe(DispatchState.SERIAL)
			await presentAssistantMessage(task, snapshot)
			expect(task.pendingWork).toEqual({ mode: "serial" })
		})

		await presentAssistantMessage(task, snapshot)

		expect(say).toHaveBeenCalledTimes(2)
		expect(task.pendingWork).toBeNull()
		expect(task.dispatchState).toBe(DispatchState.IDLE)
	})

	it("runs at most twice for N rapid re-entrant calls", async () => {
		say.mockImplementationOnce(async () => {
			await Promise.all(Array.from({ length: 10 }, () => presentAssistantMessage(task, snapshot)))
		})

		await presentAssistantMessage(task, snapshot)

		expect(say).toHaveBeenCalledTimes(2)
		expect(task.dispatchState).toBe(DispatchState.IDLE)
	})

	it("returns to IDLE when the presenter throws", async () => {
		say.mockRejectedValueOnce(new Error("boom"))

		await expect(presentAssistantMessage(task, snapshot)).rejects.toThrow("boom")

		expect(task.dispatchState).toBe(DispatchState.IDLE)
	})
})

describe("transitionDispatch", () => {
	const { IDLE, SERIAL, PARALLEL } = DispatchState

	it.each([
		[IDLE, SERIAL],
		[IDLE, PARALLEL],
		[SERIAL, IDLE],
		[PARALLEL, IDLE],
	])("accepts %s -> %s", (from, to) => {
		expect(transitionDispatch(from, to)).toBe(to)
	})

	it.each([
		[IDLE, IDLE],
		[SERIAL, SERIAL],
		[SERIAL, PARALLEL],
		[PARALLEL, SERIAL],
		[PARALLEL, PARALLEL],
	])("rejects %s -> %s", (from, to) => {
		expect(() => transitionDispatch(from, to)).toThrow("invalid transition")
	})
})
