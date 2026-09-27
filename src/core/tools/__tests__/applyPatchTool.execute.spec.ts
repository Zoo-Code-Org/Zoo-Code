// npx vitest run core/tools/__tests__/applyPatchTool.execute.spec.ts

import type { MockedFunction } from "vitest"

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
			processQueuedMessages: vi.fn(),
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
