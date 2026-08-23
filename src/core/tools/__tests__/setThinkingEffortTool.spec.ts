// npx vitest run src/core/tools/__tests__/setThinkingEffortTool.spec.ts
//
// DTE series 3/5 — set_thinking_effort executor: clamp, escalation cap,
// oscillation, no-op, no-approval, and one-line chat display.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"

import { setThinkingEffortTool, MAX_UPWARD_CHANGES } from "../SetThinkingEffortTool"
import { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"

type Capability = string[] | true | false | undefined

/** Structural double covering every Task surface this tool touches. */
interface TaskDouble {
	taskId: string
	consecutiveMistakeCount: number
	didToolFailInCurrentTurn: boolean
	recordToolError: Mock
	sayAndCreateMissingParamError: Mock
	say: Mock
	setRuntimeThinkingEffort: Mock
	getRuntimeThinkingEffort: Mock
	apiConfiguration: { reasoningEffort?: string }
	api: { getModel: () => { id: string; info: { supportsReasoningEffort: Capability } } }
	providerRef: {
		deref: () => {
			getState: () => Promise<{ experiments?: Record<string, boolean> }>
		}
	}
}

interface CallbackDoubles {
	askApproval: Mock
	handleError: Mock
	pushToolResult: Mock
}

function makeTask(
	overrides: { capability?: Capability; experimentsOn?: boolean; settingsEffort?: string } = {},
): TaskDouble {
	const { capability = ["low", "medium", "high", "max"], experimentsOn = true, settingsEffort } = overrides
	// Mirrors the real Task API: getRuntimeThinkingEffort() reflects only the
	// task-local override (undefined until setRuntimeThinkingEffort is called);
	// the settings baseline is read separately from apiConfiguration.
	let override: string | undefined = undefined
	return {
		taskId: "task-1",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing parameter error"),
		say: vi.fn().mockResolvedValue(undefined),
		setRuntimeThinkingEffort: vi.fn((effort: string | undefined) => {
			override = effort
		}),
		getRuntimeThinkingEffort: vi.fn().mockImplementation(() => ({
			effort: override,
			source: override === undefined ? undefined : "model",
		})),
		apiConfiguration: { reasoningEffort: settingsEffort },
		api: { getModel: () => ({ id: "test-model", info: { supportsReasoningEffort: capability } }) },
		providerRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					experiments: { dynamicThinkingEffort: experimentsOn },
				}),
			}),
		},
	}
}

function sayPayloads(double: TaskDouble): unknown[] {
	return double.say.mock.calls.filter((call) => call[0] === "tool").map((call) => JSON.parse(call[1] as string))
}

describe("setThinkingEffortTool", () => {
	let double: TaskDouble
	let task: Task
	let callbacks: CallbackDoubles

	// Rebuild the double and bind it to the Task-typed reference the tool
	// expects. The structural double covers every Task surface this unit
	// exercises, so a full Task construction is unnecessary here.
	function use(overrides?: { capability?: Capability; experimentsOn?: boolean; settingsEffort?: string }) {
		double = makeTask(overrides)
		task = double as unknown as Task
	}

	beforeEach(() => {
		vi.clearAllMocks()
		use()
		callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn().mockResolvedValue(undefined),
			pushToolResult: vi.fn(),
		}
	})

	describe("parameter validation", () => {
		it("reports a missing effort parameter and records a tool error", async () => {
			await setThinkingEffortTool.execute({ effort: "", reason: "because" }, task, callbacks)

			expect(double.consecutiveMistakeCount).toBe(1)
			expect(double.recordToolError).toHaveBeenCalledWith("set_thinking_effort")
			expect(double.sayAndCreateMissingParamError).toHaveBeenCalledWith("set_thinking_effort", "effort")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith("missing parameter error")
			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
			expect(double.say).not.toHaveBeenCalled()
		})

		it("reports a missing reason parameter and records a tool error", async () => {
			await setThinkingEffortTool.execute({ effort: "high", reason: "" }, task, callbacks)

			expect(double.consecutiveMistakeCount).toBe(1)
			expect(double.sayAndCreateMissingParamError).toHaveBeenCalledWith("set_thinking_effort", "reason")
			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
		})
	})

	describe("defense-in-depth gating", () => {
		it("rejects when the experiment is off", async () => {
			use({ experimentsOn: false })
			await setThinkingEffortTool.execute({ effort: "high", reason: "because" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
			expect(double.say).not.toHaveBeenCalled()
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("experiment")
			expect(result).toContain("error")
		})

		it("rejects when the model does not support per-request effort", async () => {
			use({ capability: false })
			await setThinkingEffortTool.execute({ effort: "high", reason: "because" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
			expect(double.say).not.toHaveBeenCalled()
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("does not support")
		})

		it("rejects an empty capability array", async () => {
			use({ capability: [] })
			await setThinkingEffortTool.execute({ effort: "high", reason: "because" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("does not support")
		})

		it("rejects when the provider state carries no experiment flags", async () => {
			use()
			double.providerRef.deref().getState = vi.fn().mockResolvedValue({})

			await setThinkingEffortTool.execute({ effort: "high", reason: "because" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("experiment")
		})
	})

	describe("clamp to model capability", () => {
		it("rejects an unknown effort level", async () => {
			await setThinkingEffortTool.execute({ effort: "ultra", reason: "because" }, task, callbacks)

			expect(double.consecutiveMistakeCount).toBe(1)
			expect(double.recordToolError).toHaveBeenCalledWith("set_thinking_effort")
			expect(double.didToolFailInCurrentTurn).toBe(true)
			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("Invalid thinking effort")
			expect(result).toContain("ultra")
		})

		it("rejects 'disable' (a UI off-switch the tool cannot set)", async () => {
			await setThinkingEffortTool.execute({ effort: "disable", reason: "because" }, task, callbacks)

			expect(double.consecutiveMistakeCount).toBe(1)
			expect(double.didToolFailInCurrentTurn).toBe(true)
			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("Invalid thinking effort")
		})

		it("clamps an out-of-array request to the nearest supported level", async () => {
			use({ capability: ["low", "medium", "high"], settingsEffort: "low" })
			await setThinkingEffortTool.execute({ effort: "max", reason: "deeper reasoning" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledWith("high", "model")
			const display = sayPayloads(double)[0]
			expect(display).toEqual({ tool: "thinkingEffort", effort: "high", reason: "deeper reasoning" })
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("clamped to 'high'")
			expect(result).toContain("deeper reasoning")
		})

		it("resolves nearest-level ties toward the lower level", async () => {
			use({ capability: ["high", "low"], settingsEffort: "high" })
			await setThinkingEffortTool.execute({ effort: "medium", reason: "tie-break" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledWith("low", "model")
			const display = sayPayloads(double)[0]
			expect(display).toEqual({ tool: "thinkingEffort", effort: "low", reason: "tie-break" })
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("clamped to 'low'")
		})

		it("resolves nearest-level ties toward the lower level regardless of array order", async () => {
			use({ capability: ["low", "high"], settingsEffort: "high" })
			await setThinkingEffortTool.execute({ effort: "medium", reason: "tie-break order" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledWith("low", "model")
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("clamped to 'low'")
		})

		it("clamps robustly when the capability array contains an unknown level", async () => {
			use({ capability: ["weird", "low"], settingsEffort: "high" })
			await setThinkingEffortTool.execute({ effort: "max", reason: "robust clamp" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledWith("low", "model")
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("clamped to 'low'")
		})

		it("rejects a request that clamps to 'disable' (capability without settable levels)", async () => {
			use({ capability: ["disable"], settingsEffort: "disable" })
			await setThinkingEffortTool.execute({ effort: "low", reason: "some reasoning" }, task, callbacks)

			expect(double.consecutiveMistakeCount).toBe(1)
			expect(double.didToolFailInCurrentTurn).toBe(true)
			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("not supported by the current model")
		})
	})

	describe("successful application (no approval gate)", () => {
		it("applies the effort, notifies with a one-line say, and never asks for approval", async () => {
			use({ settingsEffort: "low" })
			await setThinkingEffortTool.execute({ effort: "high", reason: "deep analysis" }, task, callbacks)

			expect(callbacks.askApproval).not.toHaveBeenCalled()
			expect(double.consecutiveMistakeCount).toBe(0)
			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledWith("high", "model")
			const display = sayPayloads(double)[0]
			expect(display).toEqual({ tool: "thinkingEffort", effort: "high", reason: "deep analysis" })
			expect(double.say).toHaveBeenCalledWith("tool", JSON.stringify(display), undefined, false)
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("high")
			expect(result).toContain("deep analysis")
		})

		it("passes through unchanged for a boolean-capability model (all levels supported)", async () => {
			use({ capability: true, settingsEffort: "low" })
			await setThinkingEffortTool.execute({ effort: "xhigh", reason: "all levels" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledWith("xhigh", "model")
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("xhigh")
			expect(result).not.toContain("clamped")
		})
		it("is a no-op (without a chat line) when already at the requested level", async () => {
			use({ settingsEffort: "medium" })
			await setThinkingEffortTool.execute({ effort: "medium", reason: "confirm" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
			expect(double.say).not.toHaveBeenCalled()
			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("already")
		})

		it("applies normally when the task has no settings baseline (undefined current)", async () => {
			use()
			await setThinkingEffortTool.execute({ effort: "high", reason: "no baseline" }, task, callbacks)

			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledWith("high", "model")
			expect(sayPayloads(double).some((p) => (p as Record<string, unknown>).refusal !== undefined)).toBe(false)
		})
	})

	describe("escalation cap", () => {
		it("allows up to MAX_UPWARD_CHANGES upward changes and refuses the next", async () => {
			use({ capability: ["low", "medium", "high", "xhigh", "max"], settingsEffort: "low" })
			const step = (effort: string) => setThinkingEffortTool.execute({ effort, reason: "up" }, task, callbacks)

			await step("medium")
			await step("high")
			await step("xhigh")
			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledTimes(MAX_UPWARD_CHANGES)

			await step("max") // 4th upward change: refused
			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledTimes(MAX_UPWARD_CHANGES)
			const refusal = sayPayloads(double).at(-1)
			expect(refusal).toEqual({ tool: "thinkingEffort", refusal: "escalation_cap" })
			const result = callbacks.pushToolResult.mock.calls.at(-1)?.[0] as string
			expect(result).toContain("escalation limit")
		})

		it("does not count downward changes toward the cap", async () => {
			use({ capability: ["none", "low", "medium", "high", "xhigh", "max"], settingsEffort: "max" })
			const step = (effort: string) => setThinkingEffortTool.execute({ effort, reason: "x" }, task, callbacks)

			await step("none") // downward: not counted
			await step("medium") // upward 1
			await step("high") // upward 2
			await step("xhigh") // upward 3
			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledTimes(4)

			await step("max") // 4th upward change: refused
			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledTimes(4)
			const refusal = sayPayloads(double).at(-1)
			expect(refusal).toEqual({ tool: "thinkingEffort", refusal: "escalation_cap" })
		})
	})

	describe("oscillation detection", () => {
		it("refuses an A -> B -> A ping-pong within the task", async () => {
			use({ capability: ["low", "medium", "high"], settingsEffort: "high" })
			const step = (effort: string) => setThinkingEffortTool.execute({ effort, reason: "x" }, task, callbacks)

			await step("low") // downward from the baseline, allowed
			await step("medium") // upward
			await step("low") // ping-pong back: refused

			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledTimes(2)
			const refusal = sayPayloads(double).at(-1)
			expect(refusal).toEqual({ tool: "thinkingEffort", refusal: "oscillation" })
			const result = callbacks.pushToolResult.mock.calls.at(-1)?.[0] as string
			expect(result).toContain("oscillation")
			expect(result).toContain("'medium'")
			expect(result).toContain("'low'")
		})

		it("refuses a return to the task baseline (baseline oscillation)", async () => {
			use({ capability: ["low", "medium"], settingsEffort: "low" })
			const step = (effort: string) => setThinkingEffortTool.execute({ effort, reason: "x" }, task, callbacks)

			await step("low") // at the baseline: no-op, not a change
			expect(callbacks.pushToolResult).toHaveBeenLastCalledWith("Thinking effort is already 'low'.")

			await step("medium") // move away from the baseline
			await step("low") // return to the baseline: refused as oscillation

			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledTimes(1)
			const refusal = sayPayloads(double).at(-1)
			expect(refusal).toEqual({ tool: "thinkingEffort", refusal: "oscillation" })
			const result = callbacks.pushToolResult.mock.calls.at(-1)?.[0] as string
			expect(result).toContain("oscillation")
		})

		it("does not refuse the same level twice in a row (no-op path instead)", async () => {
			use({ settingsEffort: "low" })
			const step = (effort: string) => setThinkingEffortTool.execute({ effort, reason: "x" }, task, callbacks)

			await step("medium")
			await step("medium") // identical level: no-op, not oscillation

			expect(double.setRuntimeThinkingEffort).toHaveBeenCalledTimes(1)
			expect(sayPayloads(double).some((p) => (p as Record<string, unknown>).refusal !== undefined)).toBe(false)
		})
	})

	describe("error handling", () => {
		it("routes unexpected errors to handleError", async () => {
			use({ settingsEffort: "low" })
			double.setRuntimeThinkingEffort = vi.fn().mockImplementation(() => {
				throw new Error("boom")
			})

			await setThinkingEffortTool.execute({ effort: "high", reason: "x" }, task, callbacks)

			expect(callbacks.handleError).toHaveBeenCalledWith("setting thinking effort", expect.any(Error))
		})
	})

	describe("handle() entry point", () => {
		it("emits a partial say with the streamed effort and reason", async () => {
			const block: ToolUse<"set_thinking_effort"> = {
				type: "tool_use" as const,
				name: "set_thinking_effort" as const,
				params: { effort: "high", reason: "deep" },
				partial: true,
				nativeArgs: { effort: "high", reason: "deep" },
			}

			await setThinkingEffortTool.handle(task, block, callbacks)

			expect(double.say).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({ tool: "thinkingEffort", effort: "high", reason: "deep" }),
				undefined,
				true,
			)
			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
		})

		it("emits a partial say with the streamed effort when the reason is not streamed yet", async () => {
			const block: ToolUse<"set_thinking_effort"> = {
				type: "tool_use" as const,
				name: "set_thinking_effort" as const,
				params: { effort: "high" },
				partial: true,
			}

			await setThinkingEffortTool.handle(task, block, callbacks)

			expect(double.say).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({ tool: "thinkingEffort", effort: "high", reason: "" }),
				undefined,
				true,
			)
			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
		})

		it("emits a partial say with the streamed reason when the effort is not streamed yet", async () => {
			const block: ToolUse<"set_thinking_effort"> = {
				type: "tool_use" as const,
				name: "set_thinking_effort" as const,
				params: { reason: "deep" },
				partial: true,
			}

			await setThinkingEffortTool.handle(task, block, callbacks)

			expect(double.say).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({ tool: "thinkingEffort", effort: "", reason: "deep" }),
				undefined,
				true,
			)
			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
		})

		it("ignores a partial block with no args yet", async () => {
			const block: ToolUse<"set_thinking_effort"> = {
				type: "tool_use" as const,
				name: "set_thinking_effort" as const,
				params: {},
				partial: true,
			}

			await setThinkingEffortTool.handle(task, block, callbacks)

			expect(double.say).not.toHaveBeenCalled()
			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
		})

		it("reports a parse error when a complete block carries no native args", async () => {
			const block: ToolUse<"set_thinking_effort"> = {
				type: "tool_use" as const,
				name: "set_thinking_effort" as const,
				params: {},
				partial: false,
			}

			await setThinkingEffortTool.handle(task, block, callbacks)

			expect(callbacks.handleError).toHaveBeenCalledWith(
				"parsing set_thinking_effort args",
				expect.objectContaining({ message: expect.stringContaining("missing native arguments") }),
			)
			expect(double.setRuntimeThinkingEffort).not.toHaveBeenCalled()
		})
	})
})
