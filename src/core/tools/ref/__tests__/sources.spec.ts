/**
 * Tests for CRT Source Resolvers — src/core/tools/ref/sources/
 *
 * Covers:
 * - resolveChatSource  (chat.ts)
 * - resolveFileSource  (file.ts)
 * - resolveTerminalSource (terminal.ts)
 * - resolveToolSource  (tool.ts)
 *
 * All tests use mocked Task objects and mocked external dependencies
 * (fs, storage, selector) to isolate each resolver.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock fs/promises before importing resolvers that use it
// ---------------------------------------------------------------------------
vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn(),
		readdir: vi.fn(),
	},
	readFile: vi.fn(),
	readdir: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock storage utility (getTaskDirectoryPath used by terminal resolver)
// ---------------------------------------------------------------------------
vi.mock("../../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock selector module (resolveContentRef used by all resolvers)
// ---------------------------------------------------------------------------
vi.mock("../selector", () => ({
	resolveContentRef: vi.fn((sourceId: string, source: string, ref: any, cwd?: string) =>
		Promise.resolve({
			sourceId,
			content: source,
			startOffset: 0,
			endOffset: source.length,
			confidence: 1.0,
			method: "exact" as const,
		}),
	),
}))

// ---------------------------------------------------------------------------
// Mock condense module (getEffectiveApiHistory used by resolveChatSource)
// ---------------------------------------------------------------------------
vi.mock("../../../condense/index", () => ({
	getEffectiveApiHistory: vi.fn((messages: any) => messages),
}))

// ---------------------------------------------------------------------------
// Imports after mocks are set up
// ---------------------------------------------------------------------------
import * as fs from "fs/promises"
import { getTaskDirectoryPath } from "../../../../utils/storage"
import { resolveContentRef } from "../selector"
import { resolveChatSource } from "../sources/chat"
import { resolveFileSource } from "../sources/file"
import { resolveTerminalSource } from "../sources/terminal"
import { resolveToolSource } from "../sources/tool"
import type { ContentRef } from "../../../../shared/tools"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock Task with sensible defaults */
function createMockTask(overrides: Partial<any> = {}): any {
	return {
		taskId: "test-task-001",
		cwd: "/workspace/project",
		providerRef: {
			deref: () => ({
				context: {
					globalStorageUri: {
						fsPath: "/tmp/global-storage",
					},
				},
			}),
		},
		assistantMessageContent: [],
		userMessageContent: [],
		apiConversationHistory: [],
		...overrides,
	}
}

/** Helper to build a ContentRef for chat source */
function makeChatRef(ref: string, extra: Partial<ContentRef> = {}): ContentRef {
	return {
		source: "chat",
		ref,
		...extra,
	}
}

/** Helper to build a ContentRef for file source */
function makeFileRef(ref: string, extra: Partial<ContentRef> = {}): ContentRef {
	return {
		source: "file",
		ref,
		...extra,
	}
}

/** Helper to build a ContentRef for terminal source */
function makeTerminalRef(ref: string, extra: Partial<ContentRef> = {}): ContentRef {
	return {
		source: "terminal",
		ref,
		...extra,
	}
}

/** Helper to build a ContentRef for tool source */
function makeToolRef(ref: string, extra: Partial<ContentRef> = {}): ContentRef {
	return {
		source: "tool",
		ref,
		...extra,
	}
}

// ===========================================================================
// resolveChatSource
// ===========================================================================

describe("resolveChatSource", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("successful resolution", () => {
		it("resolves the last message with index '-1'", async () => {
			const task = createMockTask({
				apiConversationHistory: [
					{ role: "assistant", content: [{ type: "text", text: "First message" }] },
					{ role: "assistant", content: [{ type: "text", text: "Last message" }] },
				],
			})

			const result = await resolveChatSource(makeChatRef("-1"), task)

			expect(result.content).toBe("Last message")
			expect(result.sourceId).toBe("chat:-1")
		})

		it("resolves the second-to-last message with index '-2'", async () => {
			const task = createMockTask({
				apiConversationHistory: [
					{ role: "assistant", content: [{ type: "text", text: "First message" }] },
					{ role: "assistant", content: [{ type: "text", text: "Second message" }] },
					{ role: "assistant", content: [{ type: "text", text: "Third message" }] },
				],
			})

			const result = await resolveChatSource(makeChatRef("-2"), task)

			expect(result.content).toBe("Second message")
			expect(result.sourceId).toBe("chat:-2")
		})

		it("resolves a TextContent message", async () => {
			const task = createMockTask({
				apiConversationHistory: [{ role: "assistant", content: [{ type: "text", text: "Hello, world!" }] }],
			})

			const result = await resolveChatSource(makeChatRef("-1"), task)

			expect(result.content).toBe("Hello, world!")
		})

		it("resolves a ToolUse message by stringifying nativeArgs", async () => {
			const task = createMockTask({
				apiConversationHistory: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								name: "read_file",
								id: "tool-1",
								nativeArgs: { path: "/src/index.ts" },
							} as any,
						],
					},
				],
			})

			const result = await resolveChatSource(makeChatRef("-1"), task)

			expect(result.content).toBe(JSON.stringify({ path: "/src/index.ts" }))
		})

		it("resolves a ToolUse message by falling back to params when nativeArgs is absent", async () => {
			const task = createMockTask({
				apiConversationHistory: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								name: "read_file",
								id: "tool-2",
								params: { path: "/src/app.ts" },
							} as any,
						],
					},
				],
			})

			const result = await resolveChatSource(makeChatRef("-1"), task)

			expect(result.content).toBe(JSON.stringify({ path: "/src/app.ts" }))
		})

		it("resolves a ToolUse message with empty object when both nativeArgs and params are absent", async () => {
			const task = createMockTask({
				apiConversationHistory: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								name: "read_file",
								id: "tool-3",
							} as any,
						],
					},
				],
			})

			const result = await resolveChatSource(makeChatRef("-1"), task)

			expect(result.content).toBe("{}")
		})

		it("resolves a McpToolUse message by stringifying arguments", async () => {
			const task = createMockTask({
				apiConversationHistory: [
					{
						role: "assistant",
						content: [
							{
								type: "mcp_tool_use",
								name: "mcp_server_tool",
								arguments: { key: "value" },
							} as any,
						],
					},
				],
			})

			const result = await resolveChatSource(makeChatRef("-1"), task)

			expect(result.content).toBe(JSON.stringify({ key: "value" }))
		})

		it("resolves a McpToolUse message with empty object when arguments is absent", async () => {
			const task = createMockTask({
				apiConversationHistory: [
					{
						role: "assistant",
						content: [
							{
								type: "mcp_tool_use",
								name: "mcp_server_tool",
								arguments: undefined,
							} as any,
						],
					},
				],
			})

			const result = await resolveChatSource(makeChatRef("-1"), task)

			expect(result.content).toBe("{}")
		})
	})

	describe("error cases", () => {
		it("throws on invalid index: 0", async () => {
			const task = createMockTask({
				apiConversationHistory: [{ role: "assistant", content: [{ type: "text", text: "msg" }] }],
			})

			await expect(resolveChatSource(makeChatRef("0"), task)).rejects.toThrow("Invalid chat ref index: 0")
		})

		it("throws on invalid index: positive number", async () => {
			const task = createMockTask({
				apiConversationHistory: [{ role: "assistant", content: [{ type: "text", text: "msg" }] }],
			})

			await expect(resolveChatSource(makeChatRef("1"), task)).rejects.toThrow("Invalid chat ref index: 1")
		})

		it("throws on invalid index: NaN (non-numeric string)", async () => {
			const task = createMockTask({
				apiConversationHistory: [{ role: "assistant", content: [{ type: "text", text: "msg" }] }],
			})

			await expect(resolveChatSource(makeChatRef("abc"), task)).rejects.toThrow("Invalid chat ref index: abc")
		})

		it("throws when index is out of bounds (too negative)", async () => {
			const task = createMockTask({
				apiConversationHistory: [{ role: "assistant", content: [{ type: "text", text: "only message" }] }],
			})

			await expect(resolveChatSource(makeChatRef("-5"), task)).rejects.toThrow(
				"Chat message index -5 out of bounds",
			)
		})

		it("throws when message is empty (text with empty content)", async () => {
			const task = createMockTask({
				apiConversationHistory: [{ role: "assistant", content: [{ type: "text", text: "" }] }],
			})

			await expect(resolveChatSource(makeChatRef("-1"), task)).rejects.toThrow(
				"Chat message at index -1 is empty or not text",
			)
		})

		it("throws when message content is undefined", async () => {
			const task = createMockTask({
				apiConversationHistory: [
					{ role: "assistant", content: [{ type: "text", text: undefined } as any] } as any,
				],
			})

			await expect(resolveChatSource(makeChatRef("-1"), task)).rejects.toThrow(
				"Chat message at index -1 is empty or not text",
			)
		})
	})
})

// ===========================================================================
// resolveFileSource
// ===========================================================================

describe("resolveFileSource", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("successful resolution", () => {
		it("reads a file and resolves content via resolveContentRef", async () => {
			const fileContent = "line1\nline2\nline3\n"
			vi.mocked(fs.readFile).mockResolvedValue(fileContent)

			const task = createMockTask({ cwd: "/workspace" })

			const result = await resolveFileSource(makeFileRef("test.txt"), task)

			expect(fs.readFile).toHaveBeenCalledWith("/workspace/test.txt", "utf-8")
			expect(resolveContentRef).toHaveBeenCalledWith(
				"file:///workspace/test.txt",
				fileContent,
				expect.objectContaining({ source: "file", ref: "test.txt" }),
				undefined,
				"/workspace",
			)
			expect(result.content).toBe(fileContent)
		})

		it("resolves with startLine/endLine (line range extraction)", async () => {
			const fileContent = "line1\nline2\nline3\nline4\nline5\n"
			vi.mocked(fs.readFile).mockResolvedValue(fileContent)

			const task = createMockTask({ cwd: "/workspace" })

			const result = await resolveFileSource(makeFileRef("test.txt", { startLine: 2, endLine: 4 }), task)

			// Lines 2-4: "line2\nline3\nline4"
			expect(result.content).toBe("line2\nline3\nline4")
			expect(result.sourceId).toBe("file:///workspace/test.txt:2-4")
			expect(result.startOffset).toBe(1) // 0-based line index for line 2
			expect(result.endOffset).toBe(4) // 0-based end line index
			expect(result.confidence).toBe(1.0)
			expect(result.method).toBe("exact")
		})

		it("resolves with startLine only (single line)", async () => {
			const fileContent = "line1\nline2\nline3\n"
			vi.mocked(fs.readFile).mockResolvedValue(fileContent)

			const task = createMockTask({ cwd: "/workspace" })

			const result = await resolveFileSource(makeFileRef("test.txt", { startLine: 3 }), task)

			expect(result.content).toBe("line3")
			expect(result.sourceId).toBe("file:///workspace/test.txt:3-3")
		})

		it("uses process.cwd() when task.cwd is empty", async () => {
			const fileContent = "content"
			vi.mocked(fs.readFile).mockResolvedValue(fileContent)

			const task = createMockTask({ cwd: "" })

			await resolveFileSource(makeFileRef("test.txt"), task)

			// path.resolve with empty string falls back to process.cwd()
			expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining("test.txt"), "utf-8")
		})
	})

	describe("error cases", () => {
		it("throws when file is not found", async () => {
			const error = new Error("ENOENT: no such file or directory")
			vi.mocked(fs.readFile).mockRejectedValue(error)

			const task = createMockTask({ cwd: "/workspace" })

			await expect(resolveFileSource(makeFileRef("nonexistent.txt"), task)).rejects.toThrow(
				"File not found or unreadable: nonexistent.txt",
			)
		})

		it("throws when file read fails with a generic error", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("EACCES: permission denied"))

			const task = createMockTask({ cwd: "/workspace" })

			await expect(resolveFileSource(makeFileRef("secret.txt"), task)).rejects.toThrow(
				"File not found or unreadable: secret.txt",
			)
		})
	})
})

// ===========================================================================
// resolveTerminalSource
// ===========================================================================

describe("resolveTerminalSource", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("successful resolution", () => {
		it("reads artifact by direct path", async () => {
			const artifactContent = "command output here"
			vi.mocked(getTaskDirectoryPath).mockResolvedValue("/tmp/tasks/task-001")
			vi.mocked(fs.readFile).mockResolvedValue(artifactContent)

			const task = createMockTask()

			const result = await resolveTerminalSource(makeTerminalRef("cmd-abc123.txt"), task)

			expect(getTaskDirectoryPath).toHaveBeenCalledWith("/tmp/global-storage", "test-task-001")
			expect(fs.readFile).toHaveBeenCalledWith("/tmp/tasks/task-001/command-output/cmd-abc123.txt", "utf-8")
			expect(result.sourceId).toBe("terminal://cmd-abc123.txt")
			expect(result.content).toBe(artifactContent)
		})

		it("resolves via content fingerprint matching (startAnchor)", async () => {
			vi.mocked(getTaskDirectoryPath).mockResolvedValue("/tmp/tasks/task-001")

			// First read (direct path) fails
			vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("ENOENT"))

			// readdir returns list of files (cast needed for TypeScript overload resolution)
			vi.mocked(fs.readdir).mockResolvedValue(["cmd-001.txt", "cmd-002.txt", "other-file.txt"] as any)

			// First cmd file doesn't match
			vi.mocked(fs.readFile).mockResolvedValueOnce("some other output")
			// Second cmd file matches
			vi.mocked(fs.readFile).mockResolvedValueOnce("output containing npm test results")

			const task = createMockTask()

			const result = await resolveTerminalSource(makeTerminalRef("", { startAnchor: "npm test" }), task)

			expect(result.sourceId).toBe("terminal://cmd-002.txt")
			expect(result.content).toBe("output containing npm test results")
		})
	})

	describe("error cases", () => {
		it("throws when global storage path is not available", async () => {
			const task = createMockTask({
				providerRef: {
					deref: () => ({
						context: {
							globalStorageUri: {
								fsPath: undefined,
							},
						},
					}),
				},
			})

			await expect(resolveTerminalSource(makeTerminalRef("cmd-abc.txt"), task)).rejects.toThrow(
				"Global storage path not available",
			)
		})

		it("throws when providerRef.deref() returns null", async () => {
			const task = createMockTask({
				providerRef: {
					deref: () => null,
				},
			})

			await expect(resolveTerminalSource(makeTerminalRef("cmd-abc.txt"), task)).rejects.toThrow(
				"Global storage path not available",
			)
		})

		it("throws when artifact is not found (direct path)", async () => {
			vi.mocked(getTaskDirectoryPath).mockResolvedValue("/tmp/tasks/task-001")
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))

			const task = createMockTask()

			await expect(resolveTerminalSource(makeTerminalRef("cmd-missing.txt"), task)).rejects.toThrow(
				"Terminal artifact not found: cmd-missing.txt",
			)
		})

		it("throws when command-output directory is not found during fingerprint matching", async () => {
			vi.mocked(getTaskDirectoryPath).mockResolvedValue("/tmp/tasks/task-001")

			// Direct path fails
			vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("ENOENT"))
			// readdir also fails
			vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"))

			const task = createMockTask()

			await expect(
				resolveTerminalSource(makeTerminalRef("", { startAnchor: "some command" }), task),
			).rejects.toThrow("Command output directory not found")
		})

		it("throws when no terminal output matches the startAnchor", async () => {
			vi.mocked(getTaskDirectoryPath).mockResolvedValue("/tmp/tasks/task-001")

			// Direct path fails
			vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("ENOENT"))
			// readdir returns files (cast needed for TypeScript overload resolution)
			vi.mocked(fs.readdir).mockResolvedValue(["cmd-001.txt", "cmd-002.txt"] as any)
			// Neither file contains the anchor
			vi.mocked(fs.readFile).mockResolvedValue("unrelated output")

			const task = createMockTask()

			await expect(
				resolveTerminalSource(makeTerminalRef("", { startAnchor: "nonexistent command" }), task),
			).rejects.toThrow("No terminal output found containing: nonexistent command")
		})
	})
})

// ===========================================================================
// resolveToolSource
// ===========================================================================

describe("resolveToolSource", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("successful resolution", () => {
		it("finds the last tool_result for the specified tool", async () => {
			const task = createMockTask({
				assistantMessageContent: [
					{
						type: "tool_use",
						name: "read_file",
						id: "tool-use-1",
						partial: false,
					} as any,
				],
				userMessageContent: [
					{
						type: "tool_result",
						tool_use_id: "tool-use-1",
						content: "file content here",
					},
				],
			})

			const result = await resolveToolSource(makeToolRef("read_file"), task)

			expect(result.sourceId).toBe("tool:read_file:tool-use-1")
			expect(result.content).toBe("file content here")
		})

		it("handles string content in tool_result", async () => {
			const task = createMockTask({
				assistantMessageContent: [
					{
						type: "tool_use",
						name: "execute_command",
						id: "tool-exec-1",
						partial: false,
					} as any,
				],
				userMessageContent: [
					{
						type: "tool_result",
						tool_use_id: "tool-exec-1",
						content: "stdout output",
					},
				],
			})

			const result = await resolveToolSource(makeToolRef("execute_command"), task)

			expect(result.content).toBe("stdout output")
		})

		it("handles array content in tool_result", async () => {
			const task = createMockTask({
				assistantMessageContent: [
					{
						type: "tool_use",
						name: "read_file",
						id: "tool-read-1",
						partial: false,
					} as any,
				],
				userMessageContent: [
					{
						type: "tool_result",
						tool_use_id: "tool-read-1",
						content: [
							{ type: "text", text: "line 1" },
							{ type: "text", text: "line 2" },
						],
					},
				],
			})

			const result = await resolveToolSource(makeToolRef("read_file"), task)

			expect(result.content).toBe("line 1\nline 2")
		})

		it("handles array content with non-text items (filters them out)", async () => {
			const task = createMockTask({
				assistantMessageContent: [
					{
						type: "tool_use",
						name: "read_file",
						id: "tool-read-2",
						partial: false,
					} as any,
				],
				userMessageContent: [
					{
						type: "tool_result",
						tool_use_id: "tool-read-2",
						content: [
							{ type: "text", text: "text content" },
							{ type: "image", data: "base64..." },
							{ type: "text", text: "more text" },
						],
					},
				],
			})

			const result = await resolveToolSource(makeToolRef("read_file"), task)

			expect(result.content).toBe("text content\nmore text")
		})

		it("finds the LAST matching tool_result when multiple exist", async () => {
			const task = createMockTask({
				assistantMessageContent: [
					{
						type: "tool_use",
						name: "read_file",
						id: "tool-first",
						partial: false,
					} as any,
					{
						type: "tool_use",
						name: "read_file",
						id: "tool-second",
						partial: false,
					} as any,
				],
				userMessageContent: [
					{
						type: "tool_result",
						tool_use_id: "tool-first",
						content: "first result",
					},
					{
						type: "tool_result",
						tool_use_id: "tool-second",
						content: "second result",
					},
				],
			})

			const result = await resolveToolSource(makeToolRef("read_file"), task)

			// Should find the last one (traverses backwards)
			expect(result.content).toBe("second result")
			expect(result.sourceId).toBe("tool:read_file:tool-second")
		})

		it("matches tool_use_id correctly across assistant and user messages", async () => {
			const task = createMockTask({
				assistantMessageContent: [
					{
						type: "tool_use",
						name: "execute_command",
						id: "exec-1",
						partial: false,
					} as any,
					{
						type: "tool_use",
						name: "read_file",
						id: "read-1",
						partial: false,
					} as any,
				],
				userMessageContent: [
					{
						type: "tool_result",
						tool_use_id: "exec-1",
						content: "command output",
					},
					{
						type: "tool_result",
						tool_use_id: "read-1",
						content: "file output",
					},
				],
			})

			// Request read_file — should match read-1, not exec-1
			const result = await resolveToolSource(makeToolRef("read_file"), task)

			expect(result.content).toBe("file output")
			expect(result.sourceId).toBe("tool:read_file:read-1")
		})

		it("matches mcp_tool_use in assistant messages", async () => {
			const task = createMockTask({
				assistantMessageContent: [
					{
						type: "mcp_tool_use",
						name: "mcp_server_search",
						id: "mcp-1",
						arguments: { query: "test" },
						partial: false,
					} as any,
				],
				userMessageContent: [
					{
						type: "tool_result",
						tool_use_id: "mcp-1",
						content: "search results",
					},
				],
			})

			const result = await resolveToolSource(makeToolRef("mcp_server_search"), task)

			expect(result.content).toBe("search results")
		})
	})

	describe("error cases", () => {
		it("throws when tool is not found", async () => {
			const task = createMockTask({
				assistantMessageContent: [
					{
						type: "tool_use",
						name: "read_file",
						id: "tool-1",
						partial: false,
					} as any,
				],
				userMessageContent: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: "some content",
					},
				],
			})

			await expect(resolveToolSource(makeToolRef("nonexistent_tool"), task)).rejects.toThrow(
				"No tool result found for tool: nonexistent_tool",
			)
		})

		it("throws when userMessageContent is empty", async () => {
			const task = createMockTask({
				assistantMessageContent: [],
				userMessageContent: [],
			})

			await expect(resolveToolSource(makeToolRef("read_file"), task)).rejects.toThrow(
				"No tool result found for tool: read_file",
			)
		})

		it("throws when tool_use_id does not match any assistant message", async () => {
			const task = createMockTask({
				assistantMessageContent: [
					{
						type: "tool_use",
						name: "read_file",
						id: "tool-1",
						partial: false,
					} as any,
				],
				userMessageContent: [
					{
						type: "tool_result",
						tool_use_id: "tool-different-id",
						content: "orphan result",
					},
				],
			})

			await expect(resolveToolSource(makeToolRef("read_file"), task)).rejects.toThrow(
				"No tool result found for tool: read_file",
			)
		})
	})
})
