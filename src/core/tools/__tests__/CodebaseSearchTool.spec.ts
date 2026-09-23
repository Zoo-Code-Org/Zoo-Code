import * as vscode from "vscode"
import { toolNamesSchema } from "@roo-code/types"

import type { Task } from "../../task/Task"
import type { ClineProvider } from "../../webview/ClineProvider"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import type { VectorStoreSearchResult } from "../../../services/code-index/interfaces"
import type { ToolUse } from "../../../shared/tools"
import { CodeIndexManagerRegistry } from "../../../services/code-index/code-index-manager-registry"
import { makeExtensionContext } from "../../../test-utils/vscode"
import { getWorkspacePath } from "../../../utils/path"
import { formatResponse } from "../../prompts/responses"
import type { ToolCallbacks } from "../BaseTool"
import { CodebaseSearchTool, codebaseSearchTool } from "../CodebaseSearchTool"

vi.mock("vscode", () => ({ workspace: { asRelativePath: vi.fn() } }))
vi.mock("../../../utils/path", () => ({ getWorkspacePath: vi.fn() }))
vi.mock("../../../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: { getOrCreate: vi.fn() },
}))

describe("CodebaseSearchTool", () => {
	const query = "find handlers"
	let tool: CodebaseSearchTool
	let task: Task
	let context: vscode.ExtensionContext
	let callbacks: ToolCallbacks
	let manager: Pick<CodeIndexManager, "isFeatureEnabled" | "isFeatureConfigured" | "searchIndex">
	let deref: ReturnType<typeof vi.fn<Task["providerRef"]["deref"]>>

	beforeEach(() => {
		vi.resetAllMocks()
		tool = new CodebaseSearchTool()
		context = makeExtensionContext()
		// Structural doubles expose only the provider/task/manager members consumed by the tool.
		deref = vi.fn<Task["providerRef"]["deref"]>().mockReturnValue({ context } as ClineProvider)
		const taskStub: Pick<
			Task,
			| "cwd"
			| "providerRef"
			| "consecutiveMistakeCount"
			| "didToolFailInCurrentTurn"
			| "sayAndCreateMissingParamError"
			| "say"
			| "ask"
		> = {
			cwd: "/task",
			providerRef: { deref, [Symbol.toStringTag]: "WeakRef" },
			consecutiveMistakeCount: 3,
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi
				.fn<Task["sayAndCreateMissingParamError"]>()
				.mockResolvedValue("missing query"),
			say: vi.fn<Task["say"]>().mockResolvedValue(undefined),
			ask: vi.fn<Task["ask"]>().mockResolvedValue({ response: "yesButtonClicked" }),
		}
		task = taskStub as Task
		callbacks = {
			askApproval: vi.fn<ToolCallbacks["askApproval"]>().mockResolvedValue(true),
			handleError: vi.fn<ToolCallbacks["handleError"]>().mockResolvedValue(undefined),
			pushToolResult: vi.fn<ToolCallbacks["pushToolResult"]>(),
		}
		manager = {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			searchIndex: vi.fn<CodeIndexManager["searchIndex"]>().mockResolvedValue([]),
		}
		vi.mocked(CodeIndexManagerRegistry.getOrCreate).mockReturnValue(manager as CodeIndexManager)
		vi.mocked(getWorkspacePath).mockReturnValue("/fallback")
		vi.mocked(vscode.workspace.asRelativePath).mockReturnValue("src/result.ts")
	})

	afterEach(() => vi.restoreAllMocks())

	function result(overrides: Partial<VectorStoreSearchResult> = {}): VectorStoreSearchResult {
		return {
			id: "first",
			score: 0.9,
			payload: { filePath: "/task/src/result.ts", startLine: 2, endLine: 4, codeChunk: " \n first\n  second \t" },
			...overrides,
		}
	}

	it("exports a named tool instance", () => {
		expect(codebaseSearchTool).toBeInstanceOf(CodebaseSearchTool)
		expect(codebaseSearchTool.name).toBe(toolNamesSchema.enum.codebase_search)
	})

	it("reports missing workspace before even validating the query", async () => {
		Object.defineProperty(task, "cwd", { value: "" })
		vi.mocked(getWorkspacePath).mockReturnValue("")
		await tool.execute({ query: "" }, task, callbacks)
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
			toolNamesSchema.enum.codebase_search,
			new Error("Could not determine workspace path."),
		)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(task.sayAndCreateMissingParamError).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(3)
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(deref).not.toHaveBeenCalled()
		expect(CodeIndexManagerRegistry.getOrCreate).not.toHaveBeenCalled()
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("counts a missing query as a failed tool and forwards the missing-parameter response", async () => {
		await tool.execute({ query: "" }, task, callbacks)
		expect(task.consecutiveMistakeCount).toBe(4)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledExactlyOnceWith(
			toolNamesSchema.enum.codebase_search,
			"query",
		)
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith("missing query")
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(deref).not.toHaveBeenCalled()
		expect(CodeIndexManagerRegistry.getOrCreate).not.toHaveBeenCalled()
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it.each([undefined, "src", ""])("does not search after denied approval with path %j", async (path) => {
		vi.mocked(callbacks.askApproval).mockResolvedValue(false)
		await tool.execute({ query, path }, task, callbacks)
		expect(callbacks.askApproval).toHaveBeenCalledExactlyOnceWith(
			"tool",
			JSON.stringify({ tool: "codebaseSearch", query, path, isOutsideWorkspace: false }),
		)
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(formatResponse.toolDenied())
		expect(task.consecutiveMistakeCount).toBe(3)
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(deref).not.toHaveBeenCalled()
		expect(CodeIndexManagerRegistry.getOrCreate).not.toHaveBeenCalled()
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it.each(["provider", "context"])("reports a missing %s after approval", async (missing) => {
		deref.mockReturnValue(missing === "provider" ? undefined : ({} as ClineProvider))
		await tool.execute({ query }, task, callbacks)
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
			toolNamesSchema.enum.codebase_search,
			new Error("Extension context is not available."),
		)
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(CodeIndexManagerRegistry.getOrCreate).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("reports a missing manager without searching", async () => {
		vi.mocked(CodeIndexManagerRegistry.getOrCreate).mockReturnValue(undefined)

		await tool.execute({ query }, task, callbacks)

		expect(CodeIndexManagerRegistry.getOrCreate).toHaveBeenCalledExactlyOnceWith(context, "/task")
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
			toolNamesSchema.enum.codebase_search,
			new Error("CodeIndexManager is not available."),
		)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("reports disabled indexing without searching", async () => {
		Object.defineProperty(manager, "isFeatureEnabled", { value: false })

		await tool.execute({ query }, task, callbacks)

		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
			toolNamesSchema.enum.codebase_search,
			new Error("Code Indexing is disabled in the settings."),
		)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("reports missing index configuration without searching", async () => {
		Object.defineProperty(manager, "isFeatureConfigured", { value: false })

		await tool.execute({ query }, task, callbacks)

		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
			toolNamesSchema.enum.codebase_search,
			new Error("Code Indexing is not configured (Missing OpenAI Key or Qdrant URL)."),
		)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it.each([undefined, "src", ""])(
		"forwards directory prefix %j and resets mistakes before searching",
		async (path) => {
			vi.mocked(manager.searchIndex).mockImplementation(async () => {
				expect(task.consecutiveMistakeCount).toBe(0)
				return []
			})
			await tool.execute({ query, path }, task, callbacks)
			expect(manager.searchIndex).toHaveBeenCalledExactlyOnceWith(query, path)
			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				`No relevant code snippets found for the query: "${query}"`,
			)
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(task.say).not.toHaveBeenCalled()
			expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
			expect(getWorkspacePath).not.toHaveBeenCalled()
		},
	)

	it.each([null, undefined, false, 0, ""])(
		"defensively handles a runtime-invalid falsy search response %j",
		async (value) => {
			// The manager promises an array. Deliberately violate that boundary to exercise the existing falsy guard.
			vi.mocked(manager.searchIndex).mockResolvedValue(value as unknown as VectorStoreSearchResult[])
			await tool.execute({ query }, task, callbacks)
			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				`No relevant code snippets found for the query: "${query}"`,
			)
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(task.say).not.toHaveBeenCalled()
			expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		},
	)

	it("preserves result order and metadata, relativizes paths without workspace prefixes and trims chunks", async () => {
		vi.mocked(manager.searchIndex).mockResolvedValue([
			result(),
			result({
				id: "second",
				score: 0.5,
				payload: { filePath: "/task/lib/other.ts", startLine: 10, endLine: 10, codeChunk: " \t " },
			}),
		])
		vi.mocked(vscode.workspace.asRelativePath)
			.mockReturnValueOnce("src/result.ts")
			.mockReturnValueOnce("lib/other.ts")
		await tool.execute({ query }, task, callbacks)
		expect(vscode.workspace.asRelativePath).toHaveBeenCalledTimes(2)
		expect(vscode.workspace.asRelativePath).toHaveBeenNthCalledWith(1, "/task/src/result.ts", false)
		expect(vscode.workspace.asRelativePath).toHaveBeenNthCalledWith(2, "/task/lib/other.ts", false)
		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"codebase_search_result",
			JSON.stringify({
				tool: "codebaseSearch",
				content: {
					query,
					results: [
						{
							filePath: "src/result.ts",
							score: 0.9,
							startLine: 2,
							endLine: 4,
							codeChunk: "first\n  second",
						},
						{ filePath: "lib/other.ts", score: 0.5, startLine: 10, endLine: 10, codeChunk: "" },
					],
				},
			}),
		)
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			`Query: ${query}\nResults:\n\nFile path: src/result.ts\nScore: 0.9\nLines: 2-4\nCode Chunk: first\n  second\n\nFile path: lib/other.ts\nScore: 0.5\nLines: 10-10\nCode Chunk: \n`,
		)
		expect(task.say).toHaveBeenCalledBefore(vi.mocked(callbacks.pushToolResult))
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("skips malformed entries while preserving a valid result", async () => {
		// Missing filePath is invalid under Payload's type but explicitly guarded against at runtime.
		const missingPath = { id: "malformed", score: 1, payload: { codeChunk: "ignored" } } as VectorStoreSearchResult
		vi.mocked(manager.searchIndex).mockResolvedValue([
			result({ payload: undefined }),
			result({ payload: null }),
			missingPath,
			result(),
		])
		await tool.execute({ query }, task, callbacks)
		expect(vscode.workspace.asRelativePath).toHaveBeenCalledExactlyOnceWith("/task/src/result.ts", false)
		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"codebase_search_result",
			JSON.stringify({
				tool: "codebaseSearch",
				content: {
					query,
					results: [
						{
							filePath: "src/result.ts",
							score: 0.9,
							startLine: 2,
							endLine: 4,
							codeChunk: "first\n  second",
						},
					],
				},
			}),
		)
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			`Query: ${query}\nResults:\n\nFile path: src/result.ts\nScore: 0.9\nLines: 2-4\nCode Chunk: first\n  second\n`,
		)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("preserves the existing empty-header response when every entry is skipped", async () => {
		// Missing filePath deliberately violates the backend payload contract.
		const missingPath = { id: "malformed", score: 1, payload: { codeChunk: "ignored" } } as VectorStoreSearchResult
		vi.mocked(manager.searchIndex).mockResolvedValue([
			result({ payload: undefined }),
			result({ payload: null }),
			missingPath,
		])

		await tool.execute({ query }, task, callbacks)

		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"codebase_search_result",
			JSON.stringify({ tool: "codebaseSearch", content: { query, results: [] } }),
		)
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(`Query: ${query}\nResults:\n\n`)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("forwards a registry error without attempting search", async () => {
		const error = new Error("registry failed")
		vi.mocked(CodeIndexManagerRegistry.getOrCreate).mockImplementation(() => {
			throw error
		})

		await tool.execute({ query }, task, callbacks)

		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(toolNamesSchema.enum.codebase_search, error)
		expect(vi.mocked(callbacks.handleError).mock.calls[0][1]).toBe(error)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("forwards a search rejection without publishing results", async () => {
		const error = new Error("search failed")
		vi.mocked(manager.searchIndex).mockRejectedValue(error)

		await tool.execute({ query }, task, callbacks)

		expect(manager.searchIndex).toHaveBeenCalledExactlyOnceWith(query, undefined)
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(toolNamesSchema.enum.codebase_search, error)
		expect(vi.mocked(callbacks.handleError).mock.calls[0][1]).toBe(error)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("forwards a result-message rejection without publishing a text result", async () => {
		const error = new Error("say failed")
		vi.mocked(manager.searchIndex).mockResolvedValue([result()])
		vi.mocked(task.say).mockRejectedValue(error)

		await tool.execute({ query }, task, callbacks)

		expect(task.say).toHaveBeenCalledOnce()
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(toolNamesSchema.enum.codebase_search, error)
		expect(vi.mocked(callbacks.handleError).mock.calls[0][1]).toBe(error)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("does not access the provider or search while approval is pending", async () => {
		let approve: (value: boolean) => void = () => {
			throw new Error("Approval resolver not initialized")
		}
		const approval = new Promise<boolean>((resolve) => {
			approve = resolve
		})
		vi.mocked(callbacks.askApproval).mockReturnValue(approval)

		const execution = tool.execute({ query, path: "src" }, task, callbacks)
		try {
			expect(callbacks.askApproval).toHaveBeenCalledExactlyOnceWith(
				"tool",
				JSON.stringify({ tool: "codebaseSearch", query, path: "src", isOutsideWorkspace: false }),
			)
			expect(deref).not.toHaveBeenCalled()
			expect(CodeIndexManagerRegistry.getOrCreate).not.toHaveBeenCalled()
			expect(manager.searchIndex).not.toHaveBeenCalled()
			expect(task.consecutiveMistakeCount).toBe(3)
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		} finally {
			approve(true)
			await execution
		}

		expect(CodeIndexManagerRegistry.getOrCreate).toHaveBeenCalledExactlyOnceWith(context, "/task")
		expect(manager.searchIndex).toHaveBeenCalledExactlyOnceWith(query, "src")
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	describe("handlePartial", () => {
		it.each([
			{ params: {}, partial: true },
			{ params: { query }, partial: true },
			{ params: { path: "src" }, partial: false },
			{ params: { query, path: "src" }, partial: true },
			{ params: { query: "", path: "" }, partial: false },
		])("sends the supplied optional fields and partial flag: %j", async ({ params, partial }) => {
			const block: ToolUse<typeof toolNamesSchema.enum.codebase_search> = {
				type: "tool_use",
				name: toolNamesSchema.enum.codebase_search,
				params,
				partial,
			}
			await tool.handlePartial(task, block)
			expect(task.ask).toHaveBeenCalledExactlyOnceWith(
				"tool",
				JSON.stringify({
					tool: "codebaseSearch",
					...params,
					isOutsideWorkspace: false,
				}),
				partial,
			)
			expect(deref).not.toHaveBeenCalled()
			expect(CodeIndexManagerRegistry.getOrCreate).not.toHaveBeenCalled()
			expect(manager.searchIndex).not.toHaveBeenCalled()
			expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
			expect(task.say).not.toHaveBeenCalled()
			expect(callbacks.askApproval).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(task.consecutiveMistakeCount).toBe(3)
		})

		it("swallows a rejected partial ask without searching or reporting a tool error", async () => {
			vi.mocked(task.ask).mockRejectedValue(new Error("superseded partial message"))
			await expect(
				tool.handlePartial(task, {
					type: "tool_use",
					name: toolNamesSchema.enum.codebase_search,
					params: { query },
					partial: true,
				}),
			).resolves.toBeUndefined()
			expect(task.ask).toHaveBeenCalledOnce()
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(deref).not.toHaveBeenCalled()
			expect(CodeIndexManagerRegistry.getOrCreate).not.toHaveBeenCalled()
			expect(manager.searchIndex).not.toHaveBeenCalled()
			expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
			expect(task.say).not.toHaveBeenCalled()
		})
	})
})
