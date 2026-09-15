import * as vscode from "vscode"

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
	CodeIndexManagerRegistry: { getInstance: vi.fn() },
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
		vi.mocked(CodeIndexManagerRegistry.getInstance).mockReturnValue(manager as CodeIndexManager)
		vi.mocked(getWorkspacePath).mockReturnValue("/fallback")
		vi.mocked(vscode.workspace.asRelativePath).mockReturnValue("src/result.ts")
	})

	afterEach(() => vi.restoreAllMocks())

	function expectNoSearch() {
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	}

	function expectNoProviderAccess() {
		expect(deref).not.toHaveBeenCalled()
		expect(CodeIndexManagerRegistry.getInstance).not.toHaveBeenCalled()
		expectNoSearch()
	}

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
		expect(codebaseSearchTool.name).toBe("codebase_search")
	})

	it("reports missing workspace before even validating the query", async () => {
		Object.defineProperty(task, "cwd", { value: "" })
		vi.mocked(getWorkspacePath).mockReturnValue("")
		await tool.execute({ query: "" }, task, callbacks)
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
			"codebase_search",
			new Error("Could not determine workspace path."),
		)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(task.sayAndCreateMissingParamError).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(3)
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expectNoProviderAccess()
	})

	it("counts a missing query as a failed tool and forwards the missing-parameter response", async () => {
		await tool.execute({ query: "" }, task, callbacks)
		expect(task.consecutiveMistakeCount).toBe(4)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledExactlyOnceWith("codebase_search", "query")
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith("missing query")
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expectNoProviderAccess()
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
		expectNoProviderAccess()
	})

	it.each(["provider", "context"])("reports a missing %s after approval", async (missing) => {
		deref.mockReturnValue(missing === "provider" ? undefined : ({} as ClineProvider))
		await tool.execute({ query }, task, callbacks)
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
			"codebase_search",
			new Error("Extension context is not available."),
		)
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(CodeIndexManagerRegistry.getInstance).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expectNoSearch()
	})

	it.each([
		["missing", "CodeIndexManager is not available."],
		["disabled", "Code Indexing is disabled in the settings."],
		["unconfigured", "Code Indexing is not configured (Missing OpenAI Key or Qdrant URL)."],
	])("reports a %s manager without searching", async (state, message) => {
		if (state === "missing") vi.mocked(CodeIndexManagerRegistry.getInstance).mockReturnValue(undefined)
		if (state === "disabled") Object.defineProperty(manager, "isFeatureEnabled", { value: false })
		if (state === "unconfigured") Object.defineProperty(manager, "isFeatureConfigured", { value: false })
		await tool.execute({ query }, task, callbacks)
		expect(CodeIndexManagerRegistry.getInstance).toHaveBeenCalledExactlyOnceWith(context, "/task")
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith("codebase_search", new Error(message))
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(0)
		expectNoSearch()
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

	it.each([false, true])("skips absent payloads/file paths (include a valid result: %s)", async (includeValid) => {
		// Missing filePath is invalid under Payload's type but explicitly guarded against at runtime.
		const missingPath = { id: "malformed", score: 1, payload: { codeChunk: "ignored" } } as VectorStoreSearchResult
		vi.mocked(manager.searchIndex).mockResolvedValue([
			result({ payload: undefined }),
			result({ payload: null }),
			missingPath,
			...(includeValid ? [result()] : []),
		])
		await tool.execute({ query }, task, callbacks)
		expect(vscode.workspace.asRelativePath).toHaveBeenCalledTimes(includeValid ? 1 : 0)
		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"codebase_search_result",
			JSON.stringify({
				tool: "codebaseSearch",
				content: {
					query,
					results: includeValid
						? [
								{
									filePath: "src/result.ts",
									score: 0.9,
									startLine: 2,
									endLine: 4,
									codeChunk: "first\n  second",
								},
							]
						: [],
				},
			}),
		)
		// A nonempty response whose entries are all skipped still emits an empty result header, not "No relevant...".
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			`Query: ${query}\nResults:\n\n${includeValid ? "File path: src/result.ts\nScore: 0.9\nLines: 2-4\nCode Chunk: first\n  second\n" : ""}`,
		)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it.each(["registry", "search", "say"])("forwards the original %s error without a tool result", async (source) => {
		const error = new Error(`${source} failed`)
		if (source === "registry")
			vi.mocked(CodeIndexManagerRegistry.getInstance).mockImplementation(() => {
				throw error
			})
		if (source === "search") vi.mocked(manager.searchIndex).mockRejectedValue(error)
		if (source === "say") {
			vi.mocked(manager.searchIndex).mockResolvedValue([result()])
			vi.mocked(task.say).mockRejectedValue(error)
		}
		await tool.execute({ query }, task, callbacks)
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith("codebase_search", error)
		expect(vi.mocked(callbacks.handleError).mock.calls[0][1]).toBe(error)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		if (source === "registry") expectNoSearch()
		if (source === "search") expect(task.say).not.toHaveBeenCalled()
	})

	describe("handlePartial", () => {
		it.each([
			{ params: {}, partial: true },
			{ params: { query }, partial: true },
			{ params: { path: "src" }, partial: false },
			{ params: { query, path: "src" }, partial: true },
			{ params: { query: "", path: "" }, partial: false },
		])("sends the supplied optional fields and partial flag: %j", async ({ params, partial }) => {
			const block: ToolUse<"codebase_search"> = { type: "tool_use", name: "codebase_search", params, partial }
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
			expectNoProviderAccess()
			expect(callbacks.askApproval).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(task.consecutiveMistakeCount).toBe(3)
		})

		it("swallows a rejected partial ask without searching or reporting a tool error", async () => {
			vi.mocked(task.ask).mockRejectedValue(new Error("superseded partial message"))
			await expect(
				tool.handlePartial(task, {
					type: "tool_use",
					name: "codebase_search",
					params: { query },
					partial: true,
				}),
			).resolves.toBeUndefined()
			expect(task.ask).toHaveBeenCalledOnce()
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
			expectNoProviderAccess()
		})
	})
})
