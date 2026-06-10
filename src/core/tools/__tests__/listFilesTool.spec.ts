import { describe, it, expect, vi, beforeEach } from "vitest"
import * as path from "path"

import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"
import type { ToolCallbacks } from "../BaseTool"
import { ListFilesTool, listFilesTool } from "../ListFilesTool"

// Mock dependencies
vi.mock("../../../services/glob/list-files", () => ({
	listFiles: vi.fn(),
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn(),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn(),
}))

// Mock formatResponse inline
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		formatFilesList: vi.fn(),
	},
}))

import { listFiles } from "../../../services/glob/list-files"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { getReadablePath } from "../../../utils/path"
import { formatResponse } from "../../prompts/responses"

/**
 * Test suite for the ListFilesTool.
 *
 * Validates parameter handling, file listing behavior (recursive and non-recursive),
 * approval flows, path resolution, error handling, partial message streaming,
 * and edge cases. All paths are resolved using `path.resolve` / `path.join` to
 * ensure cross-platform compatibility (Windows CI support).
 */
describe("ListFilesTool", () => {
	let tool: ListFilesTool
	let mockTask: Task
	let mockCallbacks: ToolCallbacks

	/** Cross-platform workspace path used in mock task setup and assertions. */
	const TEST_WORKSPACE = path.resolve(path.sep, "test", "workspace")

	beforeEach(() => {
		vi.clearAllMocks()

		tool = new ListFilesTool()

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			cwd: TEST_WORKSPACE,
			rooIgnoreController: undefined,
			rooProtectedController: undefined,
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({ showRooIgnoredFiles: false }),
				}),
			},
			ask: vi.fn().mockResolvedValue(undefined),
		} as unknown as Task

		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}

		// Default mock implementations
		vi.mocked(listFiles).mockResolvedValue([[], false])
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)
		vi.mocked(getReadablePath).mockReturnValue("src")
		vi.mocked(formatResponse.formatFilesList).mockReturnValue("formatted file list")
	})

	/**
	 * Helper to construct a synthetic ToolUse block for testing.
	 *
	 * @param params - Tool parameters (path and recursive flag).
	 * @param partial - Whether the block represents a partial/streaming message.
	 * @returns A mock ToolUse object typed for the list_files tool.
	 */
	function createBlock(
		params: { path?: string; recursive?: boolean | string },
		partial = false,
	): ToolUse<"list_files"> {
		return {
			type: "tool_use" as const,
			name: "list_files" as const,
			params: params as any,
			partial,
		} as unknown as ToolUse<"list_files">
	}

	// ===== Parameter validation tests =====

	it("should handle missing path parameter (empty string)", async () => {
		const params = { path: "", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.recordToolError).toHaveBeenCalledWith("list_files")
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("list_files", "path")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
	})

	it("should handle missing path parameter (undefined)", async () => {
		const params = { path: undefined as any, recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.recordToolError).toHaveBeenCalledWith("list_files")
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("list_files", "path")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
	})

	// ===== Happy path tests =====

	it("should list files in a directory (non-recursive)", async () => {
		const params = { path: "src", recursive: false }
		vi.mocked(listFiles).mockResolvedValue([["file1.ts", "file2.ts"], false])
		vi.mocked(formatResponse.formatFilesList).mockReturnValue("src/\n  file1.ts\n  file2.ts")

		await tool.execute(params, mockTask, mockCallbacks)

		const expectedPath = path.resolve(mockTask.cwd, "src")
		expect(listFiles).toHaveBeenCalledWith(expectedPath, false, 200)
		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			expectedPath,
			["file1.ts", "file2.ts"],
			false,
			undefined,
			false,
			undefined,
		)
		expect(mockCallbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining("listFilesTopLevel"))
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("src/\n  file1.ts\n  file2.ts")
	})

	it("should list files recursively when recursive is true", async () => {
		const params = { path: "src", recursive: true }
		vi.mocked(listFiles).mockResolvedValue([["file1.ts", "dir/file2.ts"], false])
		vi.mocked(formatResponse.formatFilesList).mockReturnValue("formatted recursive list")

		await tool.execute(params, mockTask, mockCallbacks)

		expect(listFiles).toHaveBeenCalledWith(path.resolve(mockTask.cwd, "src"), true, 200)
		expect(mockCallbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining("listFilesRecursive"))
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("formatted recursive list")
	})

	it("should default recursive to false when not provided", async () => {
		const params = { path: "src" }
		vi.mocked(listFiles).mockResolvedValue([["file1.ts"], false])

		await tool.execute(params, mockTask, mockCallbacks)

		expect(listFiles).toHaveBeenCalledWith(path.resolve(mockTask.cwd, "src"), false, 200)
	})

	it("should reset consecutive mistake count on success", async () => {
		mockTask.consecutiveMistakeCount = 3
		const params = { path: "src", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	it("should include didHitLimit in formatted result", async () => {
		const params = { path: "src", recursive: false }
		vi.mocked(listFiles).mockResolvedValue([["file1.ts"], true])
		vi.mocked(formatResponse.formatFilesList).mockReturnValue("truncated list")

		await tool.execute(params, mockTask, mockCallbacks)

		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			path.resolve(mockTask.cwd, "src"),
			["file1.ts"],
			true,
			undefined,
			false,
			undefined,
		)
	})

	it("should pass showRooIgnoredFiles from provider state", async () => {
		vi.mocked(mockTask.providerRef.deref).mockReturnValue({
			getState: vi.fn().mockResolvedValue({ showRooIgnoredFiles: true }),
		} as any)
		const params = { path: "src", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			undefined,
			true,
			undefined,
		)
	})

	it("should handle providerRef returning undefined", async () => {
		vi.mocked(mockTask.providerRef.deref).mockReturnValue(undefined)
		const params = { path: "src", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			undefined,
			false,
			undefined,
		)
	})

	it("should handle providerRef getState returning undefined", async () => {
		vi.mocked(mockTask.providerRef.deref).mockReturnValue({
			getState: vi.fn().mockResolvedValue(undefined),
		} as any)
		const params = { path: "src", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			undefined,
			false,
			undefined,
		)
	})

	// ===== Approval flow tests =====

	it("should not push result when user rejects approval", async () => {
		vi.mocked(mockCallbacks.askApproval).mockResolvedValue(false)
		const params = { path: "src", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalled()
		expect(mockCallbacks.askApproval).toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
		expect(mockCallbacks.handleError).not.toHaveBeenCalled()
	})

	it("should push result when user approves", async () => {
		vi.mocked(mockCallbacks.askApproval).mockResolvedValue(true)
		const params = { path: "src", recursive: false }
		vi.mocked(formatResponse.formatFilesList).mockReturnValue("approved result")

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("approved result")
	})

	// ===== Path handling tests =====

	it("should resolve relative path against task.cwd", async () => {
		const params = { path: "relative/path", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(listFiles).toHaveBeenCalledWith(path.resolve(mockTask.cwd, "relative/path"), false, 200)
	})

	it("should pass rooIgnoreController and rooProtectedController to formatFilesList", async () => {
		const mockIgnoreController = { someMethod: vi.fn() }
		const mockProtectedController = { someMethod: vi.fn() }
		mockTask.rooIgnoreController = mockIgnoreController as any
		mockTask.rooProtectedController = mockProtectedController as any
		const params = { path: "src", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			mockIgnoreController,
			false,
			mockProtectedController,
		)
	})

	it("should set isOutsideWorkspace to true when path is outside", async () => {
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(true)
		const params = { path: "../outside", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			expect.stringContaining('"isOutsideWorkspace":true'),
		)
	})

	it("should set isOutsideWorkspace to false when path is inside", async () => {
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)
		const params = { path: "src", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			expect.stringContaining('"isOutsideWorkspace":false'),
		)
	})

	it("should use getReadablePath for the message path", async () => {
		vi.mocked(getReadablePath).mockReturnValue("src/utils")
		const params = { path: "src/utils", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(getReadablePath).toHaveBeenCalledWith(TEST_WORKSPACE, "src/utils")
		expect(mockCallbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining('"path":"src/utils"'))
	})

	// ===== Message structure tests =====

	it("should construct correct shared message props for non-recursive listing", async () => {
		vi.mocked(getReadablePath).mockReturnValue("src")
		const params = { path: "src", recursive: false }
		vi.mocked(formatResponse.formatFilesList).mockReturnValue("content")

		await tool.execute(params, mockTask, mockCallbacks)

		const callArgs = vi.mocked(mockCallbacks.askApproval).mock.calls[0]
		const message = JSON.parse(callArgs[1] as string)
		expect(message).toEqual({
			tool: "listFilesTopLevel",
			path: "src",
			isOutsideWorkspace: false,
			content: "content",
		})
	})

	it("should construct correct shared message props for recursive listing", async () => {
		vi.mocked(getReadablePath).mockReturnValue("src")
		const params = { path: "src", recursive: true }
		vi.mocked(formatResponse.formatFilesList).mockReturnValue("recursive content")

		await tool.execute(params, mockTask, mockCallbacks)

		const callArgs = vi.mocked(mockCallbacks.askApproval).mock.calls[0]
		const message = JSON.parse(callArgs[1] as string)
		expect(message).toEqual({
			tool: "listFilesRecursive",
			path: "src",
			isOutsideWorkspace: false,
			content: "recursive content",
		})
	})

	// ===== Error handling tests =====

	it("should call handleError when listFiles throws", async () => {
		const error = new Error("Filesystem error")
		vi.mocked(listFiles).mockRejectedValue(error)
		const params = { path: "src", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockCallbacks.handleError).toHaveBeenCalledWith("listing files", error)
		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("should call handleError when formatFilesList throws", async () => {
		const error = new Error("Format error")
		vi.mocked(formatResponse.formatFilesList).mockImplementation(() => {
			throw error
		})
		const params = { path: "src", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(mockCallbacks.handleError).toHaveBeenCalledWith("listing files", error)
	})

	it("should reset consecutive mistake count after successful validation even when listing fails", async () => {
		mockTask.consecutiveMistakeCount = 2
		vi.mocked(listFiles).mockRejectedValue(new Error("fail"))
		const params = { path: "src", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		// Validation passes (path is present), so the tool resets the count to 0 before
		// calling listFiles. listFiles then throws and is handled in the catch block,
		// which does not touch the count again — so it stays at 0, not the original 2.
		expect(mockCallbacks.handleError).toHaveBeenCalled()
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// ===== handlePartial tests =====

	it("should handle partial message with path and recursive=false", async () => {
		vi.mocked(getReadablePath).mockReturnValue("src")
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)
		// handlePartial reads recursive from block.params as string (from AI streaming)
		const block = createBlock({ path: "src", recursive: "false" as any }, true)

		await tool.handlePartial(mockTask, block)

		expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.stringContaining("listFilesTopLevel"), true)
	})

	it("should handle partial message with recursive=true", async () => {
		vi.mocked(getReadablePath).mockReturnValue("src")
		// handlePartial reads recursive from block.params as string (from AI streaming)
		const block = createBlock({ path: "src", recursive: "true" as any }, true)

		await tool.handlePartial(mockTask, block)

		expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.stringContaining("listFilesRecursive"), true)
	})

	it("should handle partial message with no path (defaults to task.cwd)", async () => {
		vi.mocked(getReadablePath).mockReturnValue("")
		const block = createBlock({}, true)

		await tool.handlePartial(mockTask, block)

		expect(getReadablePath).toHaveBeenCalledWith(TEST_WORKSPACE, "")
		expect(mockTask.ask).toHaveBeenCalled()
	})

	it("should handle partial message with path as undefined", async () => {
		vi.mocked(getReadablePath).mockReturnValue("")
		const block = createBlock({ path: undefined }, true)

		await tool.handlePartial(mockTask, block)

		expect(getReadablePath).toHaveBeenCalledWith(TEST_WORKSPACE, "")
	})

	it("should handle partial message with recursive as string 'TRUE' (case-insensitive)", async () => {
		vi.mocked(getReadablePath).mockReturnValue("src")
		const block = createBlock({ path: "src", recursive: "TRUE" as any }, true)

		await tool.handlePartial(mockTask, block)

		expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.stringContaining("listFilesRecursive"), true)
	})

	it("should treat recursive string 'false' as non-recursive", async () => {
		vi.mocked(getReadablePath).mockReturnValue("src")
		const block = createBlock({ path: "src", recursive: "false" as any }, true)

		await tool.handlePartial(mockTask, block)

		expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.stringContaining("listFilesTopLevel"), true)
	})

	it("should propagate errors thrown before task.ask in handlePartial", async () => {
		vi.mocked(getReadablePath).mockImplementation(() => {
			throw new Error("path error")
		})
		const block = createBlock({ path: "src" }, true)

		// The .catch(() => {}) only wraps task.ask, so errors before it propagate
		await expect(tool.handlePartial(mockTask, block)).rejects.toThrow("path error")
	})

	it("should silently catch task.ask rejection in handlePartial", async () => {
		vi.mocked(mockTask.ask).mockRejectedValue(new Error("ask failed"))
		const block = createBlock({ path: "src" }, true)

		// Should not throw due to .catch(() => {})
		await expect(tool.handlePartial(mockTask, block)).resolves.toBeUndefined()
	})

	it("should pass partial flag from block to task.ask", async () => {
		const block = createBlock({ path: "src" }, false)

		await tool.handlePartial(mockTask, block)

		expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.any(String), false)
	})

	it("should resolve path relative to task.cwd in handlePartial", async () => {
		vi.mocked(getReadablePath).mockReturnValue("nested/dir")
		const block = createBlock({ path: "nested/dir" }, true)

		await tool.handlePartial(mockTask, block)

		expect(getReadablePath).toHaveBeenCalledWith(TEST_WORKSPACE, "nested/dir")
	})

	it("should check isPathOutsideWorkspace in handlePartial", async () => {
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(true)
		const block = createBlock({ path: "../outside" }, true)

		await tool.handlePartial(mockTask, block)

		const callArgs = vi.mocked(mockTask.ask).mock.calls[0]
		const message = JSON.parse(callArgs[1] as string)
		expect(message.isOutsideWorkspace).toBe(true)
	})

	it("should include empty content in partial message", async () => {
		const block = createBlock({ path: "src" }, true)

		await tool.handlePartial(mockTask, block)

		const callArgs = vi.mocked(mockTask.ask).mock.calls[0]
		const message = JSON.parse(callArgs[1] as string)
		expect(message.content).toBe("")
	})

	// ===== Edge case tests =====

	it("should handle empty file list result", async () => {
		vi.mocked(listFiles).mockResolvedValue([[], false])
		vi.mocked(formatResponse.formatFilesList).mockReturnValue("No files found.")
		const params = { path: "empty-dir", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			path.resolve(mockTask.cwd, "empty-dir"),
			[],
			false,
			undefined,
			false,
			undefined,
		)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("No files found.")
	})

	it("should handle large file list with limit hit", async () => {
		const manyFiles = Array.from({ length: 200 }, (_, i) => `file${i}.ts`)
		vi.mocked(listFiles).mockResolvedValue([manyFiles, true])
		vi.mocked(formatResponse.formatFilesList).mockReturnValue("truncated list")
		const params = { path: "huge-dir", recursive: true }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			path.resolve(mockTask.cwd, "huge-dir"),
			manyFiles,
			true,
			undefined,
			false,
			undefined,
		)
	})

	it("should handle root directory path", async () => {
		vi.mocked(listFiles).mockResolvedValue([["/"], false])
		const params = { path: "/", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(listFiles).toHaveBeenCalledWith(path.resolve(mockTask.cwd, "/"), false, 200)
	})

	it("should handle dot path (current directory)", async () => {
		const params = { path: ".", recursive: false }

		await tool.execute(params, mockTask, mockCallbacks)

		expect(listFiles).toHaveBeenCalledWith(path.resolve(mockTask.cwd, "."), false, 200)
	})

	// ===== Singleton instance test =====

	it("should export a singleton instance", () => {
		expect(listFilesTool).toBeInstanceOf(ListFilesTool)
		expect(listFilesTool.name).toBe("list_files")
	})

	it("should have correct name property", () => {
		expect(tool.name).toBe("list_files")
	})
})
