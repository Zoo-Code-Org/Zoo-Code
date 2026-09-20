import * as vscode from "vscode"

import { CodebaseSearchTool } from "../CodebaseSearchTool"
import type { ToolCallbacks } from "../BaseTool"
import type { Task } from "../../task/Task"
import type { ClineProvider } from "../../webview/ClineProvider"
import { CodeIndexManager } from "../../../services/code-index/manager"
import { codeIndexWorkspaceScopeRegistry as registry } from "../../../services/code-index/code-index-workspace-scope-registry"
import { getWorkspacePath } from "../../../utils/path"
import { makeExtensionContext, makeTextEditor, makeUri } from "../../../test-utils/vscode"

vi.mock("../../../services/code-index/manager", () => ({ CodeIndexManager: vi.fn() }))
vi.mock("../../../utils/path", () => ({ getWorkspacePath: vi.fn() }))
vi.mock("vscode", () => ({
	workspace: { getWorkspaceFolder: vi.fn(), asRelativePath: vi.fn() },
	window: {},
}))

describe("CodebaseSearchTool workspace-scope consumer", () => {
	const first = { name: "first", index: 0, uri: makeUri("/first") }
	const second = { name: "second", index: 1, uri: makeUri("/second") }
	const context = makeExtensionContext()
	let task: { cwd: string } & Pick<Task, "providerRef" | "consecutiveMistakeCount" | "say">
	let callbacks: ToolCallbacks
	let manager: Pick<CodeIndexManager, "isFeatureEnabled" | "isFeatureConfigured" | "searchIndex" | "dispose">

	beforeEach(() => {
		vi.clearAllMocks()
		manager = {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			searchIndex: vi.fn().mockResolvedValue([]),
			dispose: vi.fn(),
		}
		vi.mocked(CodeIndexManager).mockImplementation(function () {
			// Only the search/disposal boundary is exercised; no indexing infrastructure is constructed.
			return manager as CodeIndexManager
		})
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: [first, second] })
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: makeTextEditor() })
		vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue(first)
		vi.mocked(getWorkspacePath).mockReturnValue(first.uri.fsPath)
		// The tool needs only task cwd, provider context, mistake count and result reporting.
		task = {
			cwd: second.uri.fsPath,
			providerRef: new WeakRef({ context } as ClineProvider),
			consecutiveMistakeCount: 2,
			say: vi.fn().mockResolvedValue(undefined),
		}
		callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn().mockResolvedValue(undefined),
			pushToolResult: vi.fn(),
		}
	})

	afterEach(async () => {
		await registry.disposeAll()
		vi.restoreAllMocks()
	})

	it("forwards the task workspace instead of selecting the active editor's root and searches its manager", async () => {
		const resolve = vi.spyOn(registry, "getScope")
		await new CodebaseSearchTool().execute({ query: "scope lookup", path: "src/services" }, task as Task, callbacks)

		expect(resolve).toHaveBeenCalledWith(context, second.uri.fsPath)
		expect(CodeIndexManager).toHaveBeenCalledWith(second.uri.fsPath, second.uri, context)
		expect(getWorkspacePath).not.toHaveBeenCalled()
		expect(manager.searchIndex).toHaveBeenCalledWith("scope lookup", "src/services")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			'No relevant code snippets found for the query: "scope lookup"',
		)
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(0)
	})

	it.each(["", "   "])("forwards the fallback workspace when task cwd is %j", async (cwd) => {
		task.cwd = cwd
		vi.mocked(getWorkspacePath).mockReturnValue(second.uri.fsPath)
		const resolve = vi.spyOn(registry, "getScope")

		await new CodebaseSearchTool().execute({ query: "fallback" }, task as Task, callbacks)

		expect(resolve).toHaveBeenCalledWith(context, second.uri.fsPath)
		expect(CodeIndexManager).toHaveBeenCalledWith(second.uri.fsPath, second.uri, context)
		expect(manager.searchIndex).toHaveBeenCalledWith("fallback", undefined)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("reports an unavailable scope without searching or emitting a successful result", async () => {
		vi.spyOn(registry, "getScope").mockReturnValue(undefined)

		await new CodebaseSearchTool().execute({ query: "missing scope" }, task as Task, callbacks)

		expect(callbacks.handleError).toHaveBeenCalledWith(
			"codebase_search",
			new Error("CodeIndexManager is not available."),
		)
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("publishes populated results returned by the selected workspace manager", async () => {
		vi.mocked(manager.searchIndex).mockResolvedValue([
			{
				id: "snippet",
				score: 0.9,
				payload: {
					filePath: "/second/src/search.ts",
					startLine: 3,
					endLine: 5,
					codeChunk: "  selected workspace code  ",
				},
			},
		])
		vi.spyOn(vscode.workspace, "asRelativePath").mockReturnValue("src/search.ts")

		await new CodebaseSearchTool().execute({ query: "healthy search", path: "src" }, task as Task, callbacks)

		expect(manager.searchIndex).toHaveBeenCalledWith("healthy search", "src")
		expect(task.say).toHaveBeenCalledWith(
			"codebase_search_result",
			JSON.stringify({
				tool: "codebaseSearch",
				content: {
					query: "healthy search",
					results: [
						{
							filePath: "src/search.ts",
							score: 0.9,
							startLine: 3,
							endLine: 5,
							codeChunk: "selected workspace code",
						},
					],
				},
			}),
		)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			"Query: healthy search\nResults:\n\nFile path: src/search.ts\nScore: 0.9\nLines: 3-5\nCode Chunk: selected workspace code\n",
		)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("reports a missing workspace before approval or scope resolution", async () => {
		task.cwd = ""
		vi.mocked(getWorkspacePath).mockReturnValue("")
		const resolve = vi.spyOn(registry, "getScope")

		await new CodebaseSearchTool().execute({ query: "no workspace" }, task as Task, callbacks)

		expect(callbacks.handleError).toHaveBeenCalledWith(
			"codebase_search",
			new Error("Could not determine workspace path."),
		)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(resolve).not.toHaveBeenCalled()
	})
})
