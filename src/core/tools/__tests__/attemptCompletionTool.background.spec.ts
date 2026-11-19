import { RooCodeEventName } from "@roo-code/types"

import { ToolUse } from "../../../shared/tools"

// Mock the formatResponse module before importing the tool
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
		toolResult: vi.fn((msg: string) => `Result: ${msg}`),
		toolDenied: vi.fn(() => "Denied"),
	},
}))

// Mock vscode module (the tool reads the preventCompletionWithOpenTodos setting;
// the default mock returns undefined for every key, which keeps the guard off)
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
		})),
	},
}))

// Mock Package module
vi.mock("../../../shared/package", () => ({
	Package: {
		name: "zoo-code",
	},
}))

import { attemptCompletionTool, AttemptCompletionCallbacks } from "../AttemptCompletionTool"
import { Task } from "../../task/Task"
import type { BackgroundSubtaskHost } from "../../background-subtasks/types"
import { AskApproval, HandleError, PushToolResult } from "../../../shared/tools"

// D5: a background (read-only) child reports its findings through
// attempt_completion and the host collects them. The tool must settle the
// parent's promise and return WITHOUT ever asking the user, and the branch
// must run before the parentTaskId delegation state machine (a background
// child carries parentTaskId for lineage but is not an interactive delegate).

function makeBlock(result: string | undefined): ToolUse<"attempt_completion"> {
	return {
		type: "tool_use",
		name: "attempt_completion",
		params: { result: result ?? "" },
		nativeArgs: { result: result ?? "" },
		partial: false,
	}
}

describe("attemptCompletionTool background child branch (D5)", () => {
	let mockPushToolResult: ReturnType<typeof vi.fn<PushToolResult>>
	let mockAskApproval: ReturnType<typeof vi.fn<AskApproval>>
	let mockHandleError: ReturnType<typeof vi.fn<HandleError>>
	let mockToolDescription: ReturnType<typeof vi.fn<() => string>>
	let mockAskFinishSubTaskApproval: ReturnType<typeof vi.fn<() => Promise<boolean>>>
	let warnSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		mockPushToolResult = vi.fn<PushToolResult>()
		mockAskApproval = vi.fn<AskApproval>()
		mockHandleError = vi.fn<HandleError>()
		mockToolDescription = vi.fn<() => string>()
		mockAskFinishSubTaskApproval = vi.fn<() => Promise<boolean>>()
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		warnSpy.mockRestore()
	})

	function makeCallbacks(): AttemptCompletionCallbacks {
		return {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "call-background-completion",
			askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
			toolDescription: mockToolDescription,
		}
	}

	function makeBackgroundTask(overrides: Partial<Task> = {}): Partial<Task> {
		return {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			todoList: undefined,
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
			emitFinalTokenUsageUpdate: vi.fn(),
			requestAbort: vi.fn(),
			emit: vi.fn(),
			getTokenUsage: vi.fn().mockReturnValue({}),
			toolUsage: {},
			messageCounts: { user: 0, assistant: 0 },
			taskId: "bg-child-1",
			parentTaskId: "parent-1",
			isBackgroundSubtaskChild: true,
			flushTelemetryInstallment: vi.fn(),
			setPendingTaskAction: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing result param"),
			persistQueuedFeedbackAndAcknowledge: vi.fn().mockResolvedValue(true),
			waitForCurrentAssistantMessagePersistence: vi.fn().mockResolvedValue(true),
			...overrides,
		}
	}

	it("collects the result, settles the host promise, and never asks the user", async () => {
		const host: BackgroundSubtaskHost = {
			resolveBackgroundChild: vi.fn(),
			failBackgroundChild: vi.fn(),
		}
		const task = makeBackgroundTask()
		Object.assign(task, { providerRef: { deref: () => host } })

		await attemptCompletionTool.handle(task as Task, makeBlock("findings report"), makeCallbacks())

		expect(task.say).toHaveBeenCalledWith("completion_result", "findings report", undefined, false)
		expect(host.resolveBackgroundChild).toHaveBeenCalledWith("bg-child-1", "findings report")
		expect(host.failBackgroundChild).not.toHaveBeenCalled()
		expect(mockPushToolResult).toHaveBeenCalledWith("")
		expect(task.ask).not.toHaveBeenCalled()
		expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
		expect(mockHandleError).not.toHaveBeenCalled()
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("ends the child's own run loop after the host collects the result", async () => {
		// The scheduler permit is released only when run() settles, so the D5
		// branch must terminate the loop itself: the host settle alone leaves
		// run() pending forever and starves every later background child once
		// DEFAULT_MAX_PARALLEL_SUBTASKS children have completed in the session.
		const resolveBackgroundChild = vi.fn()
		const requestAbort = vi.fn()
		const host: BackgroundSubtaskHost = {
			resolveBackgroundChild,
			failBackgroundChild: vi.fn(),
		}
		const task = makeBackgroundTask({ requestAbort })
		Object.assign(task, { providerRef: { deref: () => host } })

		await attemptCompletionTool.handle(task as Task, makeBlock("findings report"), makeCallbacks())

		// The run ends only after the result is collected, so the "completed"
		// persist can never be overwritten by an abort-driven terminal write.
		expect(requestAbort).toHaveBeenCalledTimes(1)
		expect(requestAbort).toHaveBeenCalledWith(true)
		expect(requestAbort.mock.invocationCallOrder[0]).toBeGreaterThan(
			resolveBackgroundChild.mock.invocationCallOrder[0],
		)
		// The tool result still feeds the loop's history before the run ends.
		expect(mockPushToolResult).toHaveBeenCalledWith("")
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("flushes the attempt_completion telemetry installment exactly once", async () => {
		const host: BackgroundSubtaskHost = {
			resolveBackgroundChild: vi.fn(),
			failBackgroundChild: vi.fn(),
		}
		const task = makeBackgroundTask()
		Object.assign(task, { providerRef: { deref: () => host } })

		await attemptCompletionTool.handle(task as Task, makeBlock("usage report"), makeCallbacks())

		expect(task.emitFinalTokenUsageUpdate).toHaveBeenCalledTimes(1)
		expect(task.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
		expect(task.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
	})

	it("runs before the parentTaskId delegation branch even though the child carries parentTaskId", async () => {
		// The provider offers BOTH the delegation surface and the background host;
		// entering the delegation state machine would call getTaskWithId.
		const provider = {
			log: vi.fn(),
			getTaskWithId: vi.fn(),
			setPendingTaskAction: vi.fn(),
			clearPendingTaskAction: vi.fn(),
			emitDelegatedTaskCompleted: vi.fn(),
			reopenParentFromDelegation: vi.fn(),
			resolveBackgroundChild: vi.fn(),
			failBackgroundChild: vi.fn(),
		}
		const task = makeBackgroundTask()
		Object.assign(task, { providerRef: { deref: () => provider } })

		await attemptCompletionTool.handle(task as Task, makeBlock("ordering report"), makeCallbacks())

		expect(provider.resolveBackgroundChild).toHaveBeenCalledWith("bg-child-1", "ordering report")
		expect(provider.getTaskWithId).not.toHaveBeenCalled()
		expect(provider.setPendingTaskAction).not.toHaveBeenCalled()
		expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
		expect(provider.emitDelegatedTaskCompleted).not.toHaveBeenCalled()
		expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(mockPushToolResult).toHaveBeenCalledWith("")
	})

	it("aborts the child when no BackgroundSubtaskHost is registered so its handle can settle", async () => {
		const requestAbort = vi.fn()
		const task = makeBackgroundTask({ requestAbort })
		// A live provider object that does not implement the host interface.
		Object.assign(task, { providerRef: { deref: () => ({}) } })

		await attemptCompletionTool.handle(task as Task, makeBlock("orphan report"), makeCallbacks())

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no BackgroundSubtaskHost is registered"))
		// F-03: no host can settle the handle, so the child ends its own run
		// loop; the spawn-time run-settled catch-all then fails the handle.
		expect(requestAbort).toHaveBeenCalledTimes(1)
		expect(requestAbort).toHaveBeenCalledWith(true)
		expect(mockPushToolResult).toHaveBeenCalledWith("")
		expect(task.ask).not.toHaveBeenCalled()
		expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
	})

	it("aborts the child when the provider is gone", async () => {
		const requestAbort = vi.fn()
		const task = makeBackgroundTask({ requestAbort })
		Object.assign(task, { providerRef: { deref: () => undefined } })

		await attemptCompletionTool.handle(task as Task, makeBlock("disposed report"), makeCallbacks())

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no BackgroundSubtaskHost is registered"))
		expect(requestAbort).toHaveBeenCalledTimes(1)
		expect(requestAbort).toHaveBeenCalledWith(true)
		expect(mockPushToolResult).toHaveBeenCalledWith("")
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("still treats a missing result param as a mistake instead of a silent completion", async () => {
		const host: BackgroundSubtaskHost = {
			resolveBackgroundChild: vi.fn(),
			failBackgroundChild: vi.fn(),
		}
		const task = makeBackgroundTask()
		Object.assign(task, { providerRef: { deref: () => host } })

		const block: ToolUse<"attempt_completion"> = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "" },
			nativeArgs: { result: "" },
			partial: false,
		}

		await attemptCompletionTool.handle(task as Task, block, makeCallbacks())

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.recordToolError).toHaveBeenCalledWith("attempt_completion")
		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("attempt_completion", "result")
		expect(mockPushToolResult).toHaveBeenCalledWith("missing result param")
		// The D5 branch must not run for a malformed call: nothing was collected.
		expect(host.resolveBackgroundChild).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalledWith(
			"completion_result",
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
		expect(task.flushTelemetryInstallment).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("leaves the interactive delegation branch untouched for a non-background child", async () => {
		const provider = {
			log: vi.fn(),
			getTaskWithId: vi.fn().mockImplementation((id: string) => {
				if (id === "delegate-child-1") {
					return Promise.resolve({ historyItem: { id, status: "active" } })
				}
				if (id === "parent-1") {
					return Promise.resolve({
						historyItem: { id, status: "delegated", awaitingChildId: "delegate-child-1" },
					})
				}
				throw new Error(`unexpected task id ${id}`)
			}),
			setPendingTaskAction: vi.fn().mockResolvedValue(undefined),
			clearPendingTaskAction: vi.fn().mockResolvedValue(true),
			emitDelegatedTaskCompleted: vi.fn(),
			reopenParentFromDelegation: vi.fn().mockResolvedValue(true),
			// Host methods exist on the provider but must NOT be consulted for a
			// serially delegated child.
			resolveBackgroundChild: vi.fn(),
			failBackgroundChild: vi.fn(),
		}
		const task = makeBackgroundTask({
			taskId: "delegate-child-1",
			isBackgroundSubtaskChild: false,
		})
		Object.assign(task, { providerRef: { deref: () => provider } })
		mockAskFinishSubTaskApproval.mockResolvedValue(true)

		await attemptCompletionTool.handle(task as Task, makeBlock("delegated report"), makeCallbacks())

		expect(provider.getTaskWithId).toHaveBeenCalled()
		expect(mockAskFinishSubTaskApproval).toHaveBeenCalled()
		expect(provider.reopenParentFromDelegation).toHaveBeenCalledWith({
			parentTaskId: "parent-1",
			childTaskId: "delegate-child-1",
			completionResultSummary: "delegated report",
			pendingActionId: "call-background-completion",
		})
		expect(provider.resolveBackgroundChild).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(mockPushToolResult).toHaveBeenCalledWith("")
		// Only the D5 branch may end the run loop; the delegation state machine
		// hands control back to the parent and must not touch the latches.
		expect(task.requestAbort).not.toHaveBeenCalled()
	})

	it("leaves the top-level completion ask untouched for a non-background task", async () => {
		const task = makeBackgroundTask({
			taskId: "top-level-1",
			parentTaskId: undefined,
			isBackgroundSubtaskChild: false,
		})

		await attemptCompletionTool.handle(task as Task, makeBlock("top-level report"), makeCallbacks())

		expect(task.ask).toHaveBeenCalledWith("completion_result", "", false)
		expect(mockPushToolResult).not.toHaveBeenCalledWith("")
		// The pre-existing top-level path flushes once here and again inside
		// emitPublicTaskCompleted when the user accepts; the invariant is that
		// the installment itself reports exactly once.
		expect(task.emitFinalTokenUsageUpdate).toHaveBeenCalled()
		expect(task.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
		expect(task.emit).toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			"top-level-1",
			expect.anything(),
			expect.anything(),
		)
	})
})
