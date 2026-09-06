import { describe, it, expect, vi, beforeEach } from "vitest"

import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"
import type { ToolCallbacks } from "../BaseTool"
import { switchModeTool } from "../SwitchModeTool"
import { formatResponse } from "../../prompts/responses"

// Mock delay to avoid actual waits in tests
vi.mock("delay", () => ({
	default: vi.fn().mockResolvedValue(undefined),
}))

// Mock the modes module
vi.mock("../../../shared/modes", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../shared/modes")>()
	return {
		...actual,
		defaultModeSlug: "code",
		getModeBySlug: vi.fn((slug: string, customModes?: Array<{ slug: string; name: string }>) => {
			const builtInModes: Record<string, { slug: string; name: string }> = {
				code: { slug: "code", name: "Code" },
				architect: { slug: "architect", name: "Architect" },
				ask: { slug: "ask", name: "Ask" },
			}
			return customModes?.find((mode) => mode.slug === slug) ?? builtInModes[slug]
		}),
	}
})

describe("SwitchModeTool", () => {
	let mockTask: Task
	let mockCallbacks: ToolCallbacks
	let mockHandleModeSwitch: ReturnType<typeof vi.fn>
	let mockGetState: ReturnType<typeof vi.fn>
	let mockGetTaskMode: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.clearAllMocks()

		mockHandleModeSwitch = vi.fn().mockResolvedValue(undefined)
		mockGetState = vi.fn().mockResolvedValue({ mode: "code", customModes: [] })
		mockGetTaskMode = vi.fn().mockResolvedValue("code")

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			ask: vi.fn().mockResolvedValue({}),
			getTaskMode: mockGetTaskMode,
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: mockGetState,
					handleModeSwitch: mockHandleModeSwitch,
				}),
			},
		} as unknown as Task

		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	function createBlock(params: { mode_slug?: string; reason?: string }, partial = false): ToolUse<"switch_mode"> {
		return {
			type: "tool_use" as const,
			name: "switch_mode" as const,
			params,
			partial,
			nativeArgs: {
				mode_slug: params.mode_slug ?? "",
				reason: params.reason ?? "",
			},
		} as unknown as ToolUse<"switch_mode">
	}

	// ===== Parameter validation tests =====

	it("should handle missing mode_slug parameter", async () => {
		const block = createBlock({ mode_slug: "" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.recordToolError).toHaveBeenCalledWith("switch_mode")
		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("switch_mode", "mode_slug")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
	})

	it("should handle missing reason parameter without error (reason is optional)", async () => {
		const block = createBlock({ mode_slug: "architect", reason: "" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		// Should not treat missing reason as an error — it's optional
		expect(mockTask.sayAndCreateMissingParamError).not.toHaveBeenCalled()
	})

	// ===== Invalid mode tests =====

	it("should handle invalid mode slug", async () => {
		const block = createBlock({ mode_slug: "nonexistent-mode", reason: "testing" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		expect(mockTask.recordToolError).toHaveBeenCalledWith("switch_mode")
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Invalid mode: nonexistent-mode"),
		)
		// Should NOT attempt to switch or ask approval
		expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		expect(mockHandleModeSwitch).not.toHaveBeenCalled()
	})

	// ===== Already in mode tests =====

	it("should handle switching to the same mode", async () => {
		// Current mode is "code" (from mockGetState)
		const block = createBlock({ mode_slug: "code", reason: "already here" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		expect(mockTask.recordToolError).toHaveBeenCalledWith("switch_mode")
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Already in Code mode.")
		// Should NOT ask approval or switch
		expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		expect(mockHandleModeSwitch).not.toHaveBeenCalled()
	})

	// ===== Approval denial tests =====

	it("should handle user denying the approval", async () => {
		;(mockCallbacks.askApproval as ReturnType<typeof vi.fn>).mockResolvedValue(false)

		const block = createBlock({ mode_slug: "architect", reason: "need architecture view" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		// Should have asked for approval
		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({ tool: "switchMode", mode: "architect", reason: "need architecture view" }),
		)
		// But should NOT switch mode or push result
		expect(mockHandleModeSwitch).not.toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	// ===== Happy path tests =====

	it("should successfully switch mode with reason", async () => {
		const block = createBlock({ mode_slug: "architect", reason: "need to plan architecture" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		// Should have asked for approval with correct message
		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "switchMode",
				mode: "architect",
				reason: "need to plan architecture",
			}),
		)

		// Should have called handleModeSwitch with the target slug and the task
		expect(mockHandleModeSwitch).toHaveBeenCalledWith("architect", mockTask)

		// Should have pushed success result
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			"Successfully switched from Code mode to Architect mode because: need to plan architecture.",
		)
	})

	it("should successfully switch mode without reason", async () => {
		const block = createBlock({ mode_slug: "ask", reason: "" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({ tool: "switchMode", mode: "ask", reason: "" }),
		)

		expect(mockHandleModeSwitch).toHaveBeenCalledWith("ask", mockTask)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Successfully switched from Code mode to Ask mode.")
	})

	it("should reset consecutive mistake count on success", async () => {
		mockTask.consecutiveMistakeCount = 3

		const block = createBlock({ mode_slug: "architect", reason: "test" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// ===== Edge case: getState throws an error =====

	it("should handle getState throwing an error", async () => {
		const stateError = new Error("Provider state unavailable")
		mockGetState.mockRejectedValue(stateError)

		const block = createBlock({ mode_slug: "architect", reason: "test" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		// The error should be caught by the try/catch and reported via handleError
		expect(mockCallbacks.handleError).toHaveBeenCalledWith("switching mode", stateError)
		// Should NOT have asked for approval or attempted switch
		expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		expect(mockHandleModeSwitch).not.toHaveBeenCalled()
	})

	// ===== Edge case: getState returns null =====

	it("should use defaultModeSlug when getState returns null", async () => {
		mockGetState.mockResolvedValue(null)

		const block = createBlock({ mode_slug: "architect", reason: "test" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		// Should fall back to defaultModeSlug ("code") and succeed
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			"Successfully switched from Code mode to Architect mode because: test.",
		)
	})

	// ===== handleModeSwitch failure =====

	it("should handle handleModeSwitch throwing an error", async () => {
		const switchError = new Error("Failed to switch mode")
		mockHandleModeSwitch.mockRejectedValue(switchError)

		const block = createBlock({ mode_slug: "architect", reason: "test" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		// Should have asked for approval first
		expect(mockCallbacks.askApproval).toHaveBeenCalled()
		// Should have called handleModeSwitch (which throws)
		expect(mockHandleModeSwitch).toHaveBeenCalledWith("architect", mockTask)
		// Error should be caught and reported
		expect(mockCallbacks.handleError).toHaveBeenCalledWith("switching mode", switchError)
	})

	// ===== Partial message handling =====

	it("should handle partial messages during streaming", async () => {
		const block = createBlock({ mode_slug: "architect", reason: "streaming test" }, true)

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		// Should send partial message via task.ask
		expect(mockTask.ask).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "switchMode",
				mode: "architect",
				reason: "streaming test",
			}),
			true,
		)
		// Should NOT execute the actual switch
		expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		expect(mockHandleModeSwitch).not.toHaveBeenCalled()
	})

	it("should handle partial messages with empty parameters", async () => {
		const block = createBlock(
			{ mode_slug: undefined as unknown as string, reason: undefined as unknown as string },
			true,
		)

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		expect(mockTask.ask).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "switchMode",
				mode: "",
				reason: "",
			}),
			true,
		)
	})

	// ===== Custom mode support =====

	it("should switch to a custom mode", async () => {
		mockGetState.mockResolvedValue({
			mode: "code",
			customModes: [{ slug: "custom-mode", name: "Custom Mode" }],
		})

		const block = createBlock({ mode_slug: "custom-mode", reason: "testing custom modes" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalled()
		expect(mockHandleModeSwitch).toHaveBeenCalledWith("custom-mode", mockTask)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			"Successfully switched from Code mode to Custom Mode mode because: testing custom modes.",
		)
	})

	// ===== Message format tests =====

	it("should format the approval message correctly", async () => {
		const block = createBlock({ mode_slug: "ask", reason: "quick question" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		const expectedMessage = JSON.stringify({
			tool: "switchMode",
			mode: "ask",
			reason: "quick question",
		})

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith("tool", expectedMessage)
	})

	// ===== current mode source =====

	it("should read the current mode from task.getTaskMode, not provider state", async () => {
		// The provider state still reports the stale "code" mode while the task is actually in
		// "architect". The switch report must use the task's own mode.
		mockGetState.mockResolvedValue({ mode: "code", customModes: [] })
		mockGetTaskMode.mockResolvedValue("architect")

		const block = createBlock({ mode_slug: "code", reason: "switching back" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		expect(mockGetTaskMode).toHaveBeenCalledTimes(1)
		expect(mockHandleModeSwitch).toHaveBeenCalledWith("code", mockTask)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			"Successfully switched from Architect mode to Code mode because: switching back.",
		)
	})

	it("should use the default slug reported by task.getTaskMode when no mode is active", async () => {
		// task.getTaskMode applies the default slug when the task has no explicit mode, so the
		// tool reports switching from the default (Code) mode.
		mockGetState.mockResolvedValue({ customModes: [] })
		mockGetTaskMode.mockResolvedValue("code")

		const block = createBlock({ mode_slug: "ask", reason: "test" })

		await switchModeTool.handle(mockTask, block, mockCallbacks)

		expect(mockGetTaskMode).toHaveBeenCalledTimes(1)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			"Successfully switched from Code mode to Ask mode because: test.",
		)
	})
})
