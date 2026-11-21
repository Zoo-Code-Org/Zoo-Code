// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage.spec.ts

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { DispatchState, transitionDispatch } from "../../task/dispatchState"
import type { Task } from "../../task/Task"
import type { RequestPolicySnapshot } from "../../prompts/tools/effective-tool-policy"
import { writeToFileTool } from "../../tools/WriteToFileTool"

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
describe("a dropped tool call still runs the parse-failure teardown", () => {
	// The dropped call is answered before the tool is dispatched, so this is the only
	// point where the per-task state a streaming delta registered outside execute()
	// can still be torn down.
	let task: Task
	let pushToolResultToUserContent: Mock

	beforeEach(() => {
		pushToolResultToUserContent = vi.fn().mockReturnValue(true)
		task = {
			taskId: "task-id",
			instanceId: "instance-id",
			abort: false,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			consecutiveMistakeLimit: 3,
			dispatchState: DispatchState.IDLE,
			pendingWork: null,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [
				{ type: "tool_use", id: "call-1", name: "write_to_file", params: {}, partial: false },
			] as unknown as Task["assistantMessageContent"],
			userMessageContent: [],
			didCompleteReadingStream: false,
			activeToolContexts: new Map(),
			say: vi.fn().mockResolvedValue(undefined),
			recordToolError: vi.fn(),
			pushToolResultToUserContent,
			getTaskMode: vi.fn().mockResolvedValue("code"),
		} as unknown as Task
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("runs the teardown for the dropped call and keeps the generic error when it reports nothing", async () => {
		const teardownSpy = vi.spyOn(writeToFileTool, "onParameterParseFailure").mockResolvedValue(false)

		await presentAssistantMessage(task, snapshot)

		expect(teardownSpy).toHaveBeenCalledTimes(1)
		expect(teardownSpy).toHaveBeenCalledWith(
			task,
			expect.objectContaining({ toolCallId: "call-1" }),
			expect.objectContaining({ message: expect.stringContaining("missing nativeArgs") }),
		)
		expect(pushToolResultToUserContent).toHaveBeenCalledTimes(1)
		expect(pushToolResultToUserContent.mock.calls[0][0]).toEqual(
			expect.objectContaining({ type: "tool_result", tool_use_id: "call-1", is_error: true }),
		)
		expect(String(pushToolResultToUserContent.mock.calls[0][0].content)).toContain("missing nativeArgs")
	})

	it("puts the reported streaming error in the one tool_result instead of the generic text", async () => {
		const teardownSpy = vi
			.spyOn(writeToFileTool, "onParameterParseFailure")
			.mockImplementationOnce(async (_task, callbacks, _parseError) => {
				await callbacks.handleError("writing file", new Error("ENOSPC: no space left on device, write"))
				return true
			})

		await presentAssistantMessage(task, snapshot)

		expect(teardownSpy).toHaveBeenCalledTimes(1)
		expect(pushToolResultToUserContent).toHaveBeenCalledTimes(1)
		const payload = pushToolResultToUserContent.mock.calls[0][0]
		expect(String(payload.content)).toContain("ENOSPC: no space left on device, write")
		expect(String(payload.content)).not.toContain("missing nativeArgs")
		expect(payload.tool_use_id).toBe("call-1")
	})
})
