// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-parallel-subtasks.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

import { DispatchState } from "../../task/dispatchState"
import type { Task } from "../../task/Task"
import type { RequestPolicySnapshot } from "../../prompts/tools/effective-tool-policy"
import { clearAllMocks } from "../../../test-utils/reset"

import { presentAssistantMessage } from "../presentAssistantMessage"
import { validateToolUse } from "../../tools/validateToolUse"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../tools/validateToolUse")>()
	return {
		...actual,
		// Keep the real validator: it enforces the parallelSubtasks experiment
		// gate, so a presenter that stops forwarding the request's experiments
		// fails here instead of silently dispatching and spawning.
		validateToolUse: vi.fn(actual.validateToolUse),
		// The presenter maps a validated tool name to its telemetry key through this
		// predicate, so the double must know the tool it is asked about.
		isValidToolName: vi.fn((toolName: string) => toolName === "parallel_subtasks"),
	}
})
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		has: vi.fn(),
		get: vi.fn(),
	},
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

const baseSnapshot: RequestPolicySnapshot = {
	disabledTools: [],
	customModes: [],
	experiments: { customTools: false },
}

/**
 * The members `presentAssistantMessage` reads on the block and tool paths these
 * tests exercise. A real `Task` needs the extension host.
 */
interface TaskDouble {
	taskId: string
	instanceId: string
	abort: boolean
	dispatchState: DispatchState
	pendingWork: { mode: "serial" } | null
	currentStreamingContentIndex: number
	assistantMessageContent: unknown[]
	userMessageContent: unknown[]
	didCompleteReadingStream: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	activeToolContexts: Map<string, unknown>
	consecutiveMistakeCount: number
	consecutiveMistakeLimit: number
	userMessageContentReady: boolean
	getTaskMode: () => Promise<string>
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	recordToolUsage: (toolName: string) => void
	recordToolError: (toolName: string, error?: string) => void
	toolRepetitionDetector: { check: (block: unknown) => { action: string } }
	providerRef: {
		deref: () => {
			getState: () => Promise<Record<string, unknown>>
			spawnBackgroundChildren: (
				parent: unknown,
				specs: Array<{ label: string; mode: string; message: string }>,
			) => Promise<{ children: unknown[]; started: boolean }>
			abortBackgroundChildren: (parentTaskId: string) => Promise<void>
		}
	}
	providerDouble: {
		getState: ReturnType<typeof vi.fn>
		spawnBackgroundChildren: ReturnType<typeof vi.fn>
		abortBackgroundChildren: ReturnType<typeof vi.fn>
	}
	once: (event: string, listener: () => void) => void
	off: (event: string, listener: () => void) => void
	say: (type: string, text?: string, images?: unknown, partial?: boolean) => Promise<void>
	ask: (type: string, text?: string) => Promise<{ response: string; text?: string; images?: unknown[] }>
	pushToolResultToUserContent: (block: unknown) => boolean
	persistQueuedFeedbackAndAcknowledge: () => Promise<void>
	finalizePartialToolAsk: () => Promise<void>
}

function createTaskDouble(): TaskDouble {
	const providerDouble = {
		getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }),
		spawnBackgroundChildren: vi.fn().mockResolvedValue({ children: [], started: false }),
		abortBackgroundChildren: vi.fn().mockResolvedValue(undefined),
	}
	return {
		taskId: "test-task-id",
		instanceId: "test-instance",
		abort: false,
		dispatchState: DispatchState.IDLE,
		pendingWork: null,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [],
		userMessageContent: [],
		didCompleteReadingStream: true,
		didRejectTool: false,
		didAlreadyUseTool: false,
		activeToolContexts: new Map(),
		consecutiveMistakeCount: 0,
		consecutiveMistakeLimit: 3,
		userMessageContentReady: false,
		getTaskMode: vi.fn().mockResolvedValue("code"),
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: { check: vi.fn().mockReturnValue({ action: "allow" }) },
		providerDouble,
		providerRef: { deref: () => providerDouble },
		once: vi.fn(),
		off: vi.fn(),
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		pushToolResultToUserContent: vi.fn().mockReturnValue(true),
		persistQueuedFeedbackAndAcknowledge: vi.fn().mockResolvedValue(undefined),
		finalizePartialToolAsk: vi.fn().mockResolvedValue(undefined),
	}
}

function parallelSubtasksBlock(nativeArgs: unknown) {
	return {
		type: "tool_use",
		id: "tool_call_parallel",
		name: "parallel_subtasks",
		params: {},
		nativeArgs,
		partial: false,
	}
}

describe("presentAssistantMessage - parallel_subtasks", () => {
	let taskDouble: TaskDouble
	let task: Task

	beforeEach(() => {
		clearAllMocks()
		taskDouble = createTaskDouble()
		// The double stands in for a Task on the paths under test only.
		task = taskDouble as unknown as Task
	})

	describe("tool description", () => {
		it.each([
			[
				"two investigations",
				{
					tasks: [
						{ label: "api", mode: "code", message: "Map it." },
						{ mode: "debug", message: "Check it." },
					],
				},
				"2",
			],
			["no parsed tasks yet", undefined, "0"],
		])("names the child count for %s", async (_case, nativeArgs, expectedCount) => {
			taskDouble.assistantMessageContent = [parallelSubtasksBlock(nativeArgs)]
			// The rejected-tool path is the presenter's description surface: it
			// reports the skipped tool with the same string the approval row uses.
			taskDouble.didRejectTool = true

			await presentAssistantMessage(task, baseSnapshot)

			expect(taskDouble.pushToolResultToUserContent).toHaveBeenCalledWith(
				expect.objectContaining({
					content: `Skipping tool [parallel_subtasks for ${expectedCount} read-only investigation(s)] due to user rejecting a previous tool.`,
				}),
			)
		})
	})

	describe("execution dispatch", () => {
		it("routes a complete block out of validation and into the handler", async () => {
			taskDouble.assistantMessageContent = [
				parallelSubtasksBlock({ tasks: [{ label: "api", mode: "code", message: "Map it." }] }),
			]
			// The real validator rejects parallel_subtasks unless the request's
			// experiment snapshot enables it — the snapshot attemptApiRequest
			// publishes when the host flag is on.
			const snapshot: RequestPolicySnapshot = {
				...baseSnapshot,
				experiments: { ...baseSnapshot.experiments, parallelSubtasks: true },
			}

			await presentAssistantMessage(task, snapshot)

			const validateToolUseMock = vi.mocked(validateToolUse)
			expect(validateToolUseMock).toHaveBeenCalledOnce()
			expect(validateToolUseMock.mock.calls[0][0]).toBe("parallel_subtasks")
			// The presenter must forward the request's experiment gate to the
			// validator; without it the real validator rejects the dispatch this
			// test asserts on.
			expect(validateToolUseMock.mock.calls[0][5]).toEqual(snapshot.experiments)
			expect(taskDouble.recordToolUsage).toHaveBeenCalledWith("parallel_subtasks")
			expect(taskDouble.recordToolError).not.toHaveBeenCalled()
			expect(taskDouble.consecutiveMistakeCount).toBe(0)
			// The handler itself ran with the presenter's four callbacks: it asked
			// for approval, spawned zero children for the block, and pushed its
			// tool result back through the presenter.
			expect(taskDouble.providerDouble.spawnBackgroundChildren).toHaveBeenCalledOnce()
			expect(taskDouble.pushToolResultToUserContent).toHaveBeenCalled()
		})

		it.each([
			["false", { ...baseSnapshot.experiments, parallelSubtasks: false }],
			["absent", baseSnapshot.experiments],
		])("rejects the block and spawns nothing when the experiment flag is %s", async (_case, experiments) => {
			taskDouble.assistantMessageContent = [
				parallelSubtasksBlock({ tasks: [{ label: "api", mode: "code", message: "Map it." }] }),
			]
			const snapshot: RequestPolicySnapshot = { ...baseSnapshot, experiments }

			await presentAssistantMessage(task, snapshot)

			// The real validator enforces the gate: an absent flag reads as off,
			// same as false, so the block fails before any handler runs. The
			// message is JSON-encoded inside the tool_result, so match a
			// quote-free fragment.
			expect(taskDouble.pushToolResultToUserContent).toHaveBeenCalledWith(
				expect.objectContaining({
					is_error: true,
					content: expect.stringContaining("not allowed in code mode"),
				}),
			)
			expect(taskDouble.recordToolError).toHaveBeenCalledWith(
				"parallel_subtasks",
				'Tool "parallel_subtasks" is not allowed in code mode.',
			)
			expect(taskDouble.consecutiveMistakeCount).toBe(1)
			// Gate closed: no usage recorded, no approval asked, no children spawned.
			expect(taskDouble.recordToolUsage).not.toHaveBeenCalled()
			expect(taskDouble.ask).not.toHaveBeenCalled()
			expect(taskDouble.providerDouble.spawnBackgroundChildren).not.toHaveBeenCalled()
		})
	})
})
