// npx vitest run core/tools/__tests__/applyPatchTool.execute.spec.ts

import type { MockedFunction } from "vitest"

import fs from "fs/promises"

import { fileExistsAtPath } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import type { Task } from "../../task/Task"
import { ApplyPatchTool } from "../ApplyPatchTool"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("original file content\n"),
		unlink: vi.fn().mockResolvedValue(undefined),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
}))

describe("ApplyPatchTool.execute - delete file success path", () => {
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockedIsPathOutsideWorkspace = isPathOutsideWorkspace as MockedFunction<typeof isPathOutsideWorkspace>

	let tool: ApplyPatchTool
	let mockTask: Pick<
		Task,
		| "cwd"
		| "consecutiveMistakeCount"
		| "recordToolUsage"
		| "recordToolError"
		| "rooIgnoreController"
		| "rooProtectedController"
		| "say"
		| "processQueuedMessages"
		| "didEditFile"
	>
	let mockAskApproval: MockedFunction<(...args: unknown[]) => Promise<boolean>>
	let mockHandleError: MockedFunction<(...args: unknown[]) => Promise<void>>
	let mockPushToolResult: MockedFunction<(...args: unknown[]) => void>

	beforeEach(() => {
		vi.clearAllMocks()

		mockedFileExistsAtPath.mockResolvedValue(true)
		mockedIsPathOutsideWorkspace.mockReturnValue(false)

		mockTask = {
			cwd: "/workspace/project",
			consecutiveMistakeCount: 0,
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			rooIgnoreController: {
				validateAccess: vi.fn().mockReturnValue(true),
			} as unknown as Task["rooIgnoreController"],
			rooProtectedController: {
				isWriteProtected: vi.fn().mockReturnValue(false),
			} as unknown as Task["rooProtectedController"],
			say: vi.fn().mockResolvedValue(undefined),
			processQueuedMessages: vi.fn().mockResolvedValue(true),
			didEditFile: false,
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)
		mockPushToolResult = vi.fn()

		tool = new ApplyPatchTool()
	})

	it("deletes the file and records no local tool usage on success", async () => {
		const patch = `*** Begin Patch
*** Delete File: src/obsolete.ts
*** End Patch`

		await tool.execute({ patch }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockAskApproval).toHaveBeenCalled()
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Successfully deleted"))
		expect(mockTask.didEditFile).toBe(true)
		expect(mockHandleError).not.toHaveBeenCalled()

		// Usage is recorded once at the central presentAssistantMessage
		// attribution point, not locally by the handler.
		expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
		expect(mockTask.recordToolError).not.toHaveBeenCalled()
	})
})

describe("ApplyPatchTool.execute - queued message drain failures", () => {
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockedIsPathOutsideWorkspace = isPathOutsideWorkspace as MockedFunction<typeof isPathOutsideWorkspace>
	const mockedReadFile = fs.readFile as MockedFunction<typeof fs.readFile>

	let tool: ApplyPatchTool
	let mockTask: Pick<
		Task,
		| "cwd"
		| "consecutiveMistakeCount"
		| "recordToolUsage"
		| "recordToolError"
		| "rooIgnoreController"
		| "rooProtectedController"
		| "say"
		| "processQueuedMessages"
		| "didEditFile"
		| "providerRef"
		| "diffViewProvider"
		| "fileContextTracker"
	>
	let mockProcessQueuedMessages: MockedFunction<() => Promise<boolean>>
	let mockAskApproval: MockedFunction<(...args: unknown[]) => Promise<boolean>>
	let mockHandleError: MockedFunction<(...args: unknown[]) => Promise<void>>
	let mockPushToolResult: MockedFunction<(...args: unknown[]) => void>

	beforeEach(() => {
		vi.clearAllMocks()

		mockedFileExistsAtPath.mockResolvedValue(true)
		mockedIsPathOutsideWorkspace.mockReturnValue(false)
		mockedReadFile.mockResolvedValue("original file content\n")
		mockProcessQueuedMessages = vi.fn().mockResolvedValue(true)

		mockTask = {
			cwd: "/workspace/project",
			consecutiveMistakeCount: 0,
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			rooIgnoreController: {
				validateAccess: vi.fn().mockReturnValue(true),
			} as unknown as Task["rooIgnoreController"],
			rooProtectedController: {
				isWriteProtected: vi.fn().mockReturnValue(false),
			} as unknown as Task["rooProtectedController"],
			say: vi.fn().mockResolvedValue(undefined),
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
			fileContextTracker: {
				trackFileContext: vi.fn().mockResolvedValue(undefined),
			} as unknown as Task["fileContextTracker"],
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)
		mockPushToolResult = vi.fn()

		tool = new ApplyPatchTool()
	})

	it("logs a drain failure after deleting a file without changing the tool result", async () => {
		const drainError = new Error("queued submission failed")
		mockProcessQueuedMessages.mockRejectedValue(drainError)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const patch = `*** Begin Patch
*** Delete File: src/obsolete.ts
*** End Patch`

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// Flush the fire-and-forget drain promise so its rejection is logged.
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Successfully deleted"))
			expect(mockHandleError).not.toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[ApplyPatchTool] Failed to process queued messages:",
				drainError,
			)
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("logs a drain failure after writing a new file without changing the tool result", async () => {
		mockedFileExistsAtPath.mockResolvedValue(false)
		const drainError = new Error("queued submission failed")
		mockProcessQueuedMessages.mockRejectedValue(drainError)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const patch = `*** Begin Patch
*** Add File: src/created.ts
+created content
*** End Patch`

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// Flush the fire-and-forget drain promise so its rejection is logged.
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockPushToolResult).toHaveBeenCalledWith("Tool result message")
			expect(mockTask.didEditFile).toBe(true)
			expect(mockHandleError).not.toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[ApplyPatchTool] Failed to process queued messages:",
				drainError,
			)
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})

	it("logs a drain failure after updating a file without changing the tool result", async () => {
		const drainError = new Error("queued submission failed")
		mockProcessQueuedMessages.mockRejectedValue(drainError)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const patch = `*** Begin Patch
*** Update File: src/existing.ts
@@
-original file content
+updated file content
*** End Patch`

			await tool.execute({ patch }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "test-tool-call-id",
			})

			// Flush the fire-and-forget drain promise so its rejection is logged.
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockPushToolResult).toHaveBeenCalledWith("Tool result message")
			expect(mockTask.didEditFile).toBe(true)
			expect(mockHandleError).not.toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[ApplyPatchTool] Failed to process queued messages:",
				drainError,
			)
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})
})
