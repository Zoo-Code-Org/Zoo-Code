import * as vscode from "vscode"
import { toolNamesSchema } from "@roo-code/types"
import type { Task } from "../../task/Task"
import type { ClineProvider } from "../../webview/ClineProvider"
import type { ToolCallbacks } from "../BaseTool"
import { CodebaseSearchTool } from "../CodebaseSearchTool"
import { CodeIndexManagerRegistry } from "../../../services/code-index/code-index-manager-registry"
import { CodeIndexManager } from "../../../services/code-index/manager"
import { getWorkspacePath } from "../../../utils/path"
import { makeExtensionContext, makeTextDocument, makeTextEditor, makeUri } from "../../../test-utils/vscode"

vi.mock("vscode", () => ({
	workspace: { workspaceFolders: undefined, getWorkspaceFolder: vi.fn(), asRelativePath: vi.fn() },
	window: { activeTextEditor: undefined },
	Uri: { file: vi.fn() },
}))
vi.mock("../../../utils/path", () => ({ getWorkspacePath: vi.fn() }))
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: vi.fn().mockImplementation(function (workspacePath: string) {
		let initialized = false
		return {
			get isInitialized() {
				return initialized
			},
			get isFeatureEnabled() {
				return initialized
			},
			get isFeatureConfigured() {
				return initialized
			},
			initialize: vi.fn<CodeIndexManager["initialize"]>().mockImplementation(async () => {
				initialized = true
				return { requiresRestart: false }
			}),
			searchIndex: vi.fn().mockResolvedValue([
				{
					score: 0.9,
					payload: {
						filePath: `${workspacePath}/src/result.ts`,
						startLine: 2,
						endLine: 4,
						codeChunk: " match ",
					},
				},
			]),
			dispose: vi.fn(),
		}
	}),
}))

describe("CodebaseSearchTool workspace selection", () => {
	const first = { uri: makeUri("/first"), name: "first", index: 0 }
	const second = { uri: makeUri("/second"), name: "second", index: 1 }
	let task: Task
	let callbacks: ToolCallbacks
	let provider: ClineProvider

	beforeEach(() => {
		vi.clearAllMocks()
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: [first, second] })
		Object.defineProperty(vscode.window, "activeTextEditor", {
			configurable: true,
			value: makeTextEditor({ document: makeTextDocument({ uri: makeUri("/first/editor.ts") }) }),
		})
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(first)
		vi.mocked(vscode.workspace.asRelativePath).mockImplementation((value) =>
			typeof value === "string" ? value : value.fsPath,
		)
		vi.mocked(vscode.Uri.file).mockImplementation((value) => makeUri(value))
		vi.mocked(getWorkspacePath).mockReturnValue(first.uri.fsPath)
		// Only the provider context and task members consumed by this tool are needed.
		provider = { context: makeExtensionContext(), contextProxy: {} } as ClineProvider
		const taskStub: Pick<Task, "cwd" | "providerRef" | "consecutiveMistakeCount" | "say"> = {
			cwd: second.uri.fsPath,
			providerRef: new WeakRef(provider),
			consecutiveMistakeCount: 0,
			say: vi.fn<Task["say"]>().mockResolvedValue(undefined),
		}
		task = taskStub as Task
		callbacks = {
			askApproval: vi.fn<ToolCallbacks["askApproval"]>().mockResolvedValue(true),
			handleError: vi.fn<ToolCallbacks["handleError"]>().mockResolvedValue(undefined),
			pushToolResult: vi.fn<ToolCallbacks["pushToolResult"]>(),
		}
	})

	afterEach(() => {
		CodeIndexManagerRegistry.disposeAll()
		vi.restoreAllMocks()
	})

	it("searches the task workspace despite an active editor in another root", async () => {
		const context = provider.context
		const editorManager = CodeIndexManagerRegistry.getOrCreate(context, first.uri.fsPath)!
		const taskManager = CodeIndexManagerRegistry.getOrCreate(context, second.uri.fsPath)!
		// Simulate initialization of open roots during extension activation.
		await taskManager.initialize(provider.contextProxy)
		vi.mocked(taskManager.initialize).mockClear()

		await new CodebaseSearchTool().execute({ query: "find match", path: "src" }, task, callbacks)

		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(taskManager.searchIndex).toHaveBeenCalledExactlyOnceWith("find match", "src")
		expect(taskManager.initialize).not.toHaveBeenCalled()
		expect(editorManager.searchIndex).not.toHaveBeenCalled()
		expect(getWorkspacePath).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("File path: /second/src/result.ts"),
		)
		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"codebase_search_result",
			JSON.stringify({
				tool: "codebaseSearch",
				content: {
					query: "find match",
					results: [
						{ filePath: "/second/src/result.ts", score: 0.9, startLine: 2, endLine: 4, codeChunk: "match" },
					],
				},
			}),
		)
	})

	it.each(["", "   "])("uses the resolved fallback workspace when task cwd is %j", async (cwd) => {
		Object.defineProperty(task, "cwd", { value: cwd })
		vi.mocked(getWorkspacePath).mockReturnValue(second.uri.fsPath)
		const editorManager = CodeIndexManagerRegistry.getOrCreate(provider.context, first.uri.fsPath)!
		const taskManager = CodeIndexManagerRegistry.getOrCreate(provider.context, second.uri.fsPath)!
		await taskManager.initialize(provider.contextProxy)

		await new CodebaseSearchTool().execute({ query: "fallback" }, task, callbacks)

		expect(getWorkspacePath).toHaveBeenCalledExactlyOnceWith()
		expect(taskManager.searchIndex).toHaveBeenCalledExactlyOnceWith("fallback", undefined)
		expect(editorManager.searchIndex).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("File path: /second/src/result.ts"),
		)
	})

	it("reports a missing workspace before requesting approval or creating a manager", async () => {
		Object.defineProperty(task, "cwd", { value: "" })
		vi.mocked(getWorkspacePath).mockReturnValue("")
		Object.defineProperty(vscode.workspace, "workspaceFolders", { value: undefined })
		Object.defineProperty(vscode.window, "activeTextEditor", { value: undefined })

		await new CodebaseSearchTool().execute({ query: "match" }, task, callbacks)

		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
			toolNamesSchema.enum.codebase_search,
			new Error("Could not determine workspace path."),
		)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([])
		expect(CodeIndexManager).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("keeps searching the task root as the active editor moves between workspaces", async () => {
		const editorManager = CodeIndexManagerRegistry.getOrCreate(provider.context, first.uri.fsPath)!
		const taskManager = CodeIndexManagerRegistry.getOrCreate(provider.context, second.uri.fsPath)!
		await taskManager.initialize(provider.contextProxy)
		const tool = new CodebaseSearchTool()

		await tool.execute({ query: "before editor switch" }, task, callbacks)
		Object.defineProperty(vscode.window, "activeTextEditor", {
			configurable: true,
			value: makeTextEditor({ document: makeTextDocument({ uri: makeUri("/second/editor.ts") }) }),
		})
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(second)
		await tool.execute({ query: "after editor switch" }, task, callbacks)
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: undefined })
		await tool.execute({ query: "without an editor" }, task, callbacks)

		expect(taskManager.searchIndex).toHaveBeenCalledTimes(3)
		expect(taskManager.searchIndex).toHaveBeenNthCalledWith(1, "before editor switch", undefined)
		expect(taskManager.searchIndex).toHaveBeenNthCalledWith(2, "after editor switch", undefined)
		expect(taskManager.searchIndex).toHaveBeenNthCalledWith(3, "without an editor", undefined)
		expect(editorManager.searchIndex).not.toHaveBeenCalled()
		expect(getWorkspacePath).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(3)
	})

	it("creates a manager for an external task path without initializing it", async () => {
		Object.defineProperty(task, "cwd", { value: "/external-task" })

		await new CodebaseSearchTool().execute({ query: "external match" }, task, callbacks)

		expect(CodeIndexManager).toHaveBeenCalledExactlyOnceWith(
			"/external-task",
			expect.objectContaining({ fsPath: "/external-task" }),
			provider.context,
		)
		expect(vscode.Uri.file).toHaveBeenCalledExactlyOnceWith("/external-task")
		const manager = CodeIndexManagerRegistry.getOrCreate(provider.context, "/external-task")!
		expect(manager.initialize).not.toHaveBeenCalled()
		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect(getWorkspacePath).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
			toolNamesSchema.enum.codebase_search,
			new Error("Code Indexing is disabled in the settings."),
		)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})
})
