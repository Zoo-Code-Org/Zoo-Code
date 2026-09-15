import * as vscode from "vscode"
import type { Task } from "../../task/Task"
import type { ClineProvider } from "../../webview/ClineProvider"
import type { ToolCallbacks } from "../BaseTool"
import { CodebaseSearchTool } from "../CodebaseSearchTool"
import { CodeIndexManagerRegistry } from "../../../services/code-index/code-index-manager-registry"
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
		return {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
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
		const provider = { context: makeExtensionContext() } as ClineProvider
		const taskStub: Pick<Task, "cwd" | "providerRef" | "consecutiveMistakeCount" | "say"> = {
			cwd: second.uri.fsPath,
			providerRef: new WeakRef(provider),
			consecutiveMistakeCount: 0,
			say: vi.fn().mockResolvedValue(undefined),
		}
		task = taskStub as Task
		callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn().mockResolvedValue(undefined),
			pushToolResult: vi.fn(),
		}
	})

	afterEach(() => {
		CodeIndexManagerRegistry.disposeAll()
		vi.restoreAllMocks()
	})

	it("searches the task workspace despite an active editor in another root", async () => {
		const context = task.providerRef.deref()!.context
		const editorManager = CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)!
		const taskManager = CodeIndexManagerRegistry.getInstance(context, second.uri.fsPath)!

		await new CodebaseSearchTool().execute({ query: "find match", path: "src" }, task, callbacks)

		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(taskManager.searchIndex).toHaveBeenCalledWith("find match", "src")
		expect(editorManager.searchIndex).not.toHaveBeenCalled()
		expect(getWorkspacePath).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("File path: /second/src/result.ts"),
		)
		expect(task.say).toHaveBeenCalledWith(
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

		await new CodebaseSearchTool().execute({ query: "fallback" }, task, callbacks)

		expect(getWorkspacePath).toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("File path: /second/src/result.ts"),
		)
	})

	it("reports a missing workspace before requesting approval or creating a manager", async () => {
		Object.defineProperty(task, "cwd", { value: "" })
		vi.mocked(getWorkspacePath).mockReturnValue("")
		Object.defineProperty(vscode.workspace, "workspaceFolders", { value: undefined })
		Object.defineProperty(vscode.window, "activeTextEditor", { value: undefined })

		await new CodebaseSearchTool().execute({ query: "match" }, task, callbacks)

		expect(callbacks.handleError).toHaveBeenCalledWith(
			"codebase_search",
			new Error("Could not determine workspace path."),
		)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([])
	})
})
