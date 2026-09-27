// npx vitest run core/tools/__tests__/applyDiffTool.spec.ts

import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import type { Task } from "../../task/Task"
import { ApplyDiffTool } from "../ApplyDiffTool"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("original file content\n"),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

describe("ApplyDiffTool.execute - queued message drain failures", () => {
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>

	let tool: ApplyDiffTool
	let mockTask: Pick<
		Task,
		| "cwd"
		| "api"
		| "consecutiveMistakeCount"
		| "consecutiveMistakeCountForApplyDiff"
		| "recordToolError"
		| "rooIgnoreController"
		| "rooProtectedController"
		| "say"
		| "sayAndCreateMissingParamError"
		| "processQueuedMessages"
		| "didEditFile"
		| "providerRef"
		| "diffViewProvider"
		| "diffStrategy"
		| "fileContextTracker"
	>
	let mockProcessQueuedMessages: MockedFunction<() => Promise<boolean>>
	let mockAskApproval: MockedFunction<(...args: unknown[]) => Promise<boolean>>
	let mockHandleError: MockedFunction<(...args: unknown[]) => Promise<void>>
	let mockPushToolResult: MockedFunction<(...args: unknown[]) => void>

	beforeEach(() => {
		vi.clearAllMocks()

		mockedFileExistsAtPath.mockResolvedValue(true)
		mockProcessQueuedMessages = vi.fn().mockResolvedValue(true)

		mockTask = {
			cwd: "/workspace/project",
			api: {
				getModel: vi.fn().mockReturnValue({ id: "claude-3" }),
			} as unknown as Task["api"],
			consecutiveMistakeCount: 0,
			consecutiveMistakeCountForApplyDiff: new Map(),
			recordToolError: vi.fn(),
			rooIgnoreController: {
				validateAccess: vi.fn().mockReturnValue(true),
			} as unknown as Task["rooIgnoreController"],
			rooProtectedController: {
				isWriteProtected: vi.fn().mockReturnValue(false),
			} as unknown as Task["rooProtectedController"],
			say: vi.fn().mockResolvedValue(undefined),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing param error"),
			processQueuedMessages: mockProcessQueuedMessages,
			didEditFile: false,
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						diagnosticsEnabled: true,
						writeDelayMs: 1000,
						experiments: {},
					}),
				}),
			} as unknown as Task["providerRef"],
			diffViewProvider: {
				editType: undefined,
				isEditing: false,
				originalContent: "",
				open: vi.fn().mockResolvedValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				reset: vi.fn().mockResolvedValue(undefined),
				revertChanges: vi.fn().mockResolvedValue(undefined),
				saveChanges: vi.fn().mockResolvedValue({
					newProblemsMessage: "",
					userEdits: null,
					finalContent: "final content",
				}),
				saveDirectly: vi.fn().mockResolvedValue(undefined),
				scrollToFirstDiff: vi.fn(),
				pushToolWriteResult: vi.fn().mockResolvedValue("Tool result message"),
			} as unknown as Task["diffViewProvider"],
			diffStrategy: {
				applyDiff: vi.fn().mockResolvedValue({ success: true, content: "updated file content" }),
			} as unknown as Task["diffStrategy"],
			fileContextTracker: {
				trackFileContext: vi.fn().mockResolvedValue(undefined),
			} as unknown as Task["fileContextTracker"],
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)
		mockPushToolResult = vi.fn()

		tool = new ApplyDiffTool()
	})

	it("logs a drain failure when the user rejects the diff", async () => {
		mockAskApproval.mockResolvedValue(false)
		const drainError = new Error("queued submission failed")
		mockProcessQueuedMessages.mockRejectedValue(drainError)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await tool.execute({ path: "src/existing.ts", diff: "updated file content" }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Flush the fire-and-forget drain promise so its rejection is logged.
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockTask.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
			expect(mockPushToolResult).not.toHaveBeenCalled()
			expect(mockHandleError).not.toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[ApplyDiffTool] Failed to process queued messages:",
				drainError,
			)
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("logs a drain failure after a successful diff edit without changing the tool result", async () => {
		const drainError = new Error("queued submission failed")
		mockProcessQueuedMessages.mockRejectedValue(drainError)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await tool.execute({ path: "src/existing.ts", diff: "updated file content" }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Flush the fire-and-forget drain promise so its rejection is logged.
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockPushToolResult).toHaveBeenCalledWith("Tool result message")
			expect(mockTask.didEditFile).toBe(true)
			expect(mockHandleError).not.toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[ApplyDiffTool] Failed to process queued messages:",
				drainError,
			)
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("logs a drain failure when the edit fails after the diff view reset", async () => {
		const saveError = new Error("save failed")
		;(
			mockTask.diffViewProvider.saveChanges as MockedFunction<(...args: unknown[]) => Promise<unknown>>
		).mockRejectedValue(saveError)
		const drainError = new Error("queued submission failed")
		mockProcessQueuedMessages.mockRejectedValue(drainError)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await tool.execute({ path: "src/existing.ts", diff: "updated file content" }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Flush the fire-and-forget drain promise so its rejection is logged.
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockHandleError).toHaveBeenCalledWith("applying diff", saveError)
			expect(mockTask.diffViewProvider.reset).toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[ApplyDiffTool] Failed to process queued messages:",
				drainError,
			)
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})
})
