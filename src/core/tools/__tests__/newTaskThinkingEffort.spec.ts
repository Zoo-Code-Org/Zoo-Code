// npx vitest core/tools/__tests__/newTaskThinkingEffort.spec.ts
//
// DTE series 5/5 — orchestrator new_task thinking_effort:
// - the tool schema exposes the optional thinking_effort param
// - a model-specified effort is validated against the target model's
//   capability array (the child starts with the parent's model)
// - the ask payload pre-fills the effort and lists the supported levels
//   ("disable" is a settings off-switch, never a start level)
// - the ask-block selection (carried by the ask response) wins over the
//   model-specified value, which wins over the parent's effective effort

import type { AskApproval, HandleError, NativeToolArgs, PushToolResult, ToolUse } from "../../../shared/tools"

// Mock the vscode module
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn(() => false),
		})),
	},
}))

// Mock Package module
vi.mock("../../../shared/package", () => ({
	Package: {
		name: "zoo-code",
		publisher: "ZooCodeOrganization",
		version: "1.0.0",
		outputChannel: "Zoo-Code",
	},
}))

vi.mock("../../../shared/modes", () => ({
	getModeBySlug: vi.fn(),
	defaultModeSlug: "ask",
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Tool Error: ${msg}`),
	},
}))

vi.mock("../updateTodoListTool", () => ({
	parseMarkdownChecklist: vi.fn().mockReturnValue([]),
}))

import { newTaskTool } from "../NewTaskTool"
import { getModeBySlug } from "../../../shared/modes"
import newTaskSchema from "../../prompts/tools/native-tools/new_task"
import type { Task } from "../../task/Task"

interface RunOptions {
	/** Target model capability: array = allow-list; true = full level set; false/undefined = unsupported. */
	supportsReasoningEffort?: boolean | string[]
	/** Effort the user chose in the ask block (carried by the ask response). */
	askEffort?: string
	/** Parent's current effective effort (Task.resolveNewTaskEffectiveEffort). */
	parentEffort?: string
}

/**
 * Task double with the members new_task reads: the API handler (target model
 * lookup), the PR-2/5/5 Task effort methods, and the provider delegation hook.
 */
function makeTask(options: RunOptions = {}) {
	const delegateParentAndOpenChild = vi.fn().mockResolvedValue({ taskId: "child-1" })
	const resolveNewTaskEffectiveEffort = vi.fn().mockReturnValue(options.parentEffort)
	const takeNewTaskAskThinkingEffort = vi.fn().mockReturnValue(options.askEffort)
	// Structural double; the cast documents that handle() expects a real Task.
	const task = {
		taskId: "parent-1",
		ask: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing param error"),
		emit: vi.fn(),
		recordToolError: vi.fn(),
		consecutiveMistakeCount: 0,
		isPaused: false,
		pausedModeSlug: "ask",
		enableCheckpoints: false,
		checkpointSave: vi.fn(),
		startSubtask: vi.fn(),
		api: {
			getModel: () => ({
				id: "test-model",
				info: {
					supportsReasoningEffort: options.supportsReasoningEffort,
					reasoningEffort: undefined,
				},
			}),
		},
		resolveNewTaskEffectiveEffort,
		takeNewTaskAskThinkingEffort,
		providerRef: {
			deref: vi.fn(() => ({
				getState: vi.fn().mockResolvedValue({ mode: "ask", customModes: [], experiments: {} }),
				delegateParentAndOpenChild,
			})),
		},
	} as unknown as Task

	return {
		task,
		delegateParentAndOpenChild,
		resolveNewTaskEffectiveEffort,
		takeNewTaskAskThinkingEffort,
	}
}

const makeCallbacks = () => ({
	askApproval: vi.fn<AskApproval>().mockResolvedValue(true),
	handleError: vi.fn<HandleError>(),
	pushToolResult: vi.fn<PushToolResult>(),
})

const runNewTask = async (
	task: Task,
	params: { mode?: string; message?: string; todos?: string; thinking_effort?: string },
	callbacks: ReturnType<typeof makeCallbacks>,
) => {
	const args = {
		mode: params.mode ?? "code",
		message: params.message ?? "Do the delegated work",
		todos: params.todos,
		thinking_effort: params.thinking_effort,
	}
	// Native tool calling: nativeArgs is the source of truth for execution; the
	// resolved defaults land on both surfaces so missing mode/message fall back
	// identically instead of tripping the missing-param guard.
	const block: ToolUse<"new_task"> = {
		type: "tool_use",
		name: "new_task",
		params: {
			mode: args.mode,
			message: args.message,
			todos: args.todos,
			thinking_effort: args.thinking_effort,
		},
		partial: false,
		nativeArgs: {
			mode: args.mode,
			message: args.message,
			todos: args.todos,
			thinking_effort: args.thinking_effort,
		} as unknown as NativeToolArgs["new_task"],
	}
	await newTaskTool.handle(task, block, callbacks)
}

describe("new_task thinking_effort schema (DTE series 5/5)", () => {
	it("exposes an optional thinking_effort string parameter", () => {
		const parameters = newTaskSchema.function.parameters

		expect(parameters.properties.thinking_effort).toEqual({
			type: "string",
			description: expect.stringContaining("thinking effort"),
		})
		// Optional: omitting it makes the child start with the parent's current
		// effective effort. additionalProperties stays closed.
		expect(parameters.required).toEqual(["mode", "message", "todos"])
		expect(parameters.additionalProperties).toBe(false)
	})
})

describe("new_task thinking_effort validation (DTE series 5/5)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getModeBySlug).mockReturnValue({
			slug: "code",
			name: "Code Mode",
			roleDefinition: "Test role definition",
			groups: ["command", "read", "edit"],
		})
	})

	it("delegates with the model-specified effort when the target model supports it", async () => {
		const { task, delegateParentAndOpenChild } = makeTask({
			supportsReasoningEffort: ["low", "medium", "high"],
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, { thinking_effort: "medium" }, callbacks)

		expect(delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "parent-1",
			message: "Do the delegated work",
			initialTodos: [],
			mode: "code",
			thinkingEffort: "medium",
		})
	})

	it("rejects a value that is not a reasoning effort level", async () => {
		const { task, delegateParentAndOpenChild } = makeTask({
			supportsReasoningEffort: ["low", "medium"],
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, { thinking_effort: "ultra" }, callbacks)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Invalid thinking_effort 'ultra'"),
		)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("must be one of"))
		expect(delegateParentAndOpenChild).not.toHaveBeenCalled()
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("rejects a level the target model does not support", async () => {
		const { task, delegateParentAndOpenChild } = makeTask({
			supportsReasoningEffort: ["low"],
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, { thinking_effort: "high" }, callbacks)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("the target model only supports: low"),
		)
		expect(delegateParentAndOpenChild).not.toHaveBeenCalled()
	})

	it("reports 'none' when the target model's only capability is 'disable' (DTE series 5/5)", async () => {
		const { task, delegateParentAndOpenChild } = makeTask({
			supportsReasoningEffort: ["disable"],
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, { thinking_effort: "low" }, callbacks)

		// 'disable' is a settings off-switch, never a start level: it is filtered
		// from the error hint, leaving an empty list — the message falls back to
		// 'none' instead of trailing a dangling colon.
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("the target model only supports: none"),
		)
		expect(delegateParentAndOpenChild).not.toHaveBeenCalled()
	})

	it("rejects an effort when the target model exposes no capability array", async () => {
		const { task, delegateParentAndOpenChild } = makeTask({
			supportsReasoningEffort: undefined,
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, { thinking_effort: "low" }, callbacks)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("does not support thinking_effort"),
		)
		expect(delegateParentAndOpenChild).not.toHaveBeenCalled()
	})

	it("pre-fills the ask payload with the effort and the supported levels, filtering 'disable'", async () => {
		const { task } = makeTask({
			supportsReasoningEffort: ["disable", "low", "medium"],
			parentEffort: "low",
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, { thinking_effort: "low" }, callbacks)

		expect(callbacks.askApproval).toHaveBeenCalledTimes(1)
		const [askType, toolMessage] = vi.mocked(callbacks.askApproval).mock.calls[0]
		expect(askType).toBe("tool")
		const payload = JSON.parse(toolMessage as string) as {
			tool: string
			thinkingEffort?: string
			supportedThinkingEfforts?: string[]
		}
		expect(payload.tool).toBe("newTask")
		expect(payload.thinkingEffort).toBe("low")
		expect(payload.supportedThinkingEfforts).toEqual(["low", "medium"])
	})

	it("falls back to the parent's effective effort when no effort is specified", async () => {
		const { task, delegateParentAndOpenChild, resolveNewTaskEffectiveEffort } = makeTask({
			supportsReasoningEffort: ["low", "medium"],
			parentEffort: "medium",
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, {}, callbacks)

		expect(resolveNewTaskEffectiveEffort).toHaveBeenCalled()
		expect(delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "parent-1",
			message: "Do the delegated work",
			initialTodos: [],
			mode: "code",
			thinkingEffort: "medium",
		})
	})

	it("prefers the ask-block selection over the model-specified effort", async () => {
		const { task, delegateParentAndOpenChild } = makeTask({
			supportsReasoningEffort: ["low", "medium", "high"],
			askEffort: "high",
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, { thinking_effort: "low" }, callbacks)

		expect(delegateParentAndOpenChild).toHaveBeenCalledWith(expect.objectContaining({ thinkingEffort: "high" }))
	})

	it("ignores an ask-block selection the target model does not support", async () => {
		const { task, delegateParentAndOpenChild } = makeTask({
			supportsReasoningEffort: ["low"],
			askEffort: "high",
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, { thinking_effort: "low" }, callbacks)

		expect(delegateParentAndOpenChild).toHaveBeenCalledWith(expect.objectContaining({ thinkingEffort: "low" }))
	})

	it("falls back to the parent's effective effort when the ask selection is unsupported and no model effort was given", async () => {
		const { task, delegateParentAndOpenChild } = makeTask({
			supportsReasoningEffort: undefined,
			askEffort: "high",
			parentEffort: "low",
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, {}, callbacks)

		expect(delegateParentAndOpenChild).toHaveBeenCalledWith(expect.objectContaining({ thinkingEffort: "low" }))
	})

	it("accepts a valid level when the capability is boolean true (full level set)", async () => {
		const { task, delegateParentAndOpenChild } = makeTask({
			supportsReasoningEffort: true,
		})
		const callbacks = makeCallbacks()

		// xhigh is a valid level but is not in any provider allow-list today: only the
		// boolean-true normalization (full level set) accepts it.
		await runNewTask(task, { thinking_effort: "xhigh" }, callbacks)

		expect(delegateParentAndOpenChild).toHaveBeenCalledWith(expect.objectContaining({ thinkingEffort: "xhigh" }))

		// The ask payload lists the full level set for a boolean-true capability.
		const [, toolMessage] = vi.mocked(callbacks.askApproval).mock.calls[0]
		const payload = JSON.parse(toolMessage as string) as { supportedThinkingEfforts?: string[] }
		expect(payload.supportedThinkingEfforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
	})

	it("rejects an effort when the capability is boolean false", async () => {
		const { task, delegateParentAndOpenChild } = makeTask({
			supportsReasoningEffort: false,
		})
		const callbacks = makeCallbacks()

		await runNewTask(task, { thinking_effort: "low" }, callbacks)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("does not support thinking_effort"),
		)
		expect(delegateParentAndOpenChild).not.toHaveBeenCalled()
	})
})
