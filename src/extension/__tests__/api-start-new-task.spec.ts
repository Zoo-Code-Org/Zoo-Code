import * as vscode from "vscode"
import { RooCodeEventName } from "@roo-code/types"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
import type { ClineProviderFactory } from "../../core/webview/ClineProviderFactory"
import type { Task } from "../../core/task/Task"
import { Package } from "../../shared/package"
import { makeClineProviderFactory } from "../../test-utils/provider"

vi.mock("vscode", () => ({ commands: { executeCommand: vi.fn().mockResolvedValue(undefined) } }))
vi.mock("@roo-code/ipc", () => ({ IpcServer: class {} }))
vi.mock("../../core/webview/ClineProvider", () => ({ ClineProvider: class {} }))

function createProvider(taskId: string) {
	// Only the task identity is consumed by this API path; task execution is outside this test's scope.
	const task = { taskId } as Task
	return Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, {
		on: vi.fn<ClineProvider["on"]>(),
		evictCurrentTask: vi.fn<ClineProvider["evictCurrentTask"]>().mockResolvedValue(undefined),
		postStateToWebview: vi.fn<ClineProvider["postStateToWebview"]>().mockResolvedValue(undefined),
		postMessageToWebview: vi.fn<ClineProvider["postMessageToWebview"]>().mockResolvedValue(undefined),
		createTask: vi.fn<ClineProvider["createTask"]>().mockResolvedValue(task),
	})
}

describe("API - startNewTask routing", () => {
	let sidebar: ReturnType<typeof createProvider>
	let editor: ReturnType<typeof createProvider>
	let outputChannel: vscode.OutputChannel
	let api: API
	let providerFactory: ClineProviderFactory

	beforeEach(() => {
		vi.clearAllMocks()
		sidebar = createProvider("sidebar-task")
		editor = createProvider("editor-task")
		outputChannel = {
			name: "test-output",
			append: vi.fn(),
			appendLine: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}
		providerFactory = makeClineProviderFactory()
		vi.mocked(providerFactory.createInNewTab).mockResolvedValue(editor)
		api = new API(outputChannel, sidebar, providerFactory)
	})

	it.each([true, false, undefined])("routes a task with newTab=%s to the requested provider", async (newTab) => {
		const configuration = { currentApiConfigName: "test-profile" }
		const images = ["data:image/png;base64,test"]
		const target = newTab ? editor : sidebar
		const other = newTab ? sidebar : editor

		const taskId = await api.startNewTask({ configuration, text: "new task", images, newTab })

		if (newTab) {
			expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(1, "workbench.action.files.revert")
			expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2, "workbench.action.closeAllEditors")
			expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2)
			expect(providerFactory.createInNewTab).toHaveBeenCalledExactlyOnceWith()
			expect(vi.mocked(providerFactory.createInNewTab).mock.contexts[0]).toBe(providerFactory)
			expect(editor.on).toHaveBeenCalledWith(RooCodeEventName.TaskCreated, expect.any(Function))
			expect(editor.on).toHaveBeenCalledWith(RooCodeEventName.TaskCompleted, expect.any(Function))
		} else {
			expect(vscode.commands.executeCommand).toHaveBeenCalledExactlyOnceWith(
				`${Package.name}.SidebarProvider.focus`,
			)
			expect(providerFactory.createInNewTab).not.toHaveBeenCalled()
			expect(editor.on).not.toHaveBeenCalled()
		}
		expect(target.evictCurrentTask).toHaveBeenCalledOnce()
		expect(target.postStateToWebview).toHaveBeenCalledOnce()
		expect(target.postMessageToWebview).toHaveBeenNthCalledWith(1, { type: "action", action: "chatButtonClicked" })
		expect(target.postMessageToWebview).toHaveBeenNthCalledWith(2, {
			type: "invoke",
			invoke: "newChat",
			text: "new task",
			images,
		})
		expect(target.createTask).toHaveBeenCalledExactlyOnceWith(
			"new task",
			images,
			undefined,
			{ consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER },
			configuration,
		)
		expect(taskId).toBe(newTab ? "editor-task" : "sidebar-task")
		expect(other.evictCurrentTask).not.toHaveBeenCalled()
		expect(other.postStateToWebview).not.toHaveBeenCalled()
		expect(other.postMessageToWebview).not.toHaveBeenCalled()
		expect(other.createTask).not.toHaveBeenCalled()
	})

	it("propagates tab-opening failures without starting a task in another chat", async () => {
		const error = new Error("Cannot open editor chat")
		vi.mocked(providerFactory.createInNewTab).mockRejectedValueOnce(error)

		await expect(api.startNewTask({ configuration: {}, newTab: true })).rejects.toBe(error)

		expect(sidebar.evictCurrentTask).not.toHaveBeenCalled()
		expect(editor.evictCurrentTask).not.toHaveBeenCalled()
		expect(sidebar.createTask).not.toHaveBeenCalled()
		expect(editor.createTask).not.toHaveBeenCalled()
		expect(editor.on).not.toHaveBeenCalled()
	})

	it.each([true, false])("propagates task-creation failures without falling back with newTab=%s", async (newTab) => {
		const target = newTab ? editor : sidebar
		const other = newTab ? sidebar : editor
		const error = new Error("Task creation rejected")
		target.createTask.mockRejectedValueOnce(error)

		await expect(api.startNewTask({ configuration: {}, text: "blocked task", newTab })).rejects.toBe(error)

		expect(target.createTask).toHaveBeenCalledOnce()
		expect(other.createTask).not.toHaveBeenCalled()
	})
})
