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
		dispose: vi.fn<ClineProvider["dispose"]>().mockResolvedValue(undefined),
		// Plain property, not the real getter: ClineProvider is mocked in this file, so the
		// prototype carries no accessor to shadow. startNewTask's teardown guard reads this.
		isDisposed: false,
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
			{ consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER, toolRepetitionSoftLimit: 0 },
			configuration,
		)
		expect(taskId).toBe(newTab ? "editor-task" : "sidebar-task")
		expect(other.evictCurrentTask).not.toHaveBeenCalled()
		expect(other.postStateToWebview).not.toHaveBeenCalled()
		expect(other.postMessageToWebview).not.toHaveBeenCalled()
		expect(other.createTask).not.toHaveBeenCalled()
	})

	it("creates a task without a configuration without writing settings", async () => {
		const taskId = await api.startNewTask({ text: "no configuration" })

		// Omitted configuration means "use whatever the provider already has": no settings
		// write, and the provider receives undefined so it cannot overwrite defaults.
		expect(sidebar.createTask).toHaveBeenCalledExactlyOnceWith(
			"no configuration",
			undefined,
			undefined,
			{ consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER, toolRepetitionSoftLimit: 0 },
			undefined,
		)
		expect(taskId).toBe("sidebar-task")
	})

	it("disposes only the provider it created when the new-tab task creation fails", async () => {
		editor.createTask.mockRejectedValueOnce(new Error("task creation failed"))

		await expect(api.startNewTask({ text: "new task", newTab: true })).rejects.toThrow("task creation failed")

		// The provider this call created must not linger in the active-instance list; the
		// pre-existing sidebar provider is not this call's to tear down.
		expect(editor.dispose).toHaveBeenCalledOnce()
		expect(sidebar.dispose).not.toHaveBeenCalled()
	})

	it("rethrows the startup error when tearing down the aborted new tab fails", async () => {
		const startupError = new Error("webview post failed")
		const teardownError = new Error("provider teardown failed")
		editor.postMessageToWebview.mockRejectedValueOnce(startupError)
		editor.dispose.mockRejectedValueOnce(teardownError)
		// enableLogging is what routes API logging to the output channel; the teardown failure
		// has to stay visible there.
		const loggingApi = new API(outputChannel, sidebar, providerFactory, undefined, true)

		const thrown = await loggingApi
			.startNewTask({ text: "new task", newTab: true })
			.catch((error: unknown) => error)

		// The teardown failure is logged beside the startup error and never substituted for
		// it: the caller has to see why the task never started, not why cleanup failed.
		expect(thrown).toBe(startupError)
		expect(String(thrown)).not.toContain("provider teardown failed")
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining(
				"[API#startNewTask] failed to dispose the aborted new-tab provider: provider teardown failed",
			),
		)
		expect(editor.dispose).toHaveBeenCalledOnce()
		expect(sidebar.dispose).not.toHaveBeenCalled()
	})

	it("does not dispose an already disposed new-tab provider when the call fails", async () => {
		// Disposal can win the race against the call - a tab the user closed mid-flight - and
		// the flag is consulted twice: before starting the task, and again by the teardown
		// guard. A second dispose would re-enter teardown on a provider that already tore its
		// state down.
		editor.isDisposed = true

		await expect(api.startNewTask({ text: "new task", newTab: true })).rejects.toThrow("The provider was disposed")

		expect(editor.createTask).not.toHaveBeenCalled()
		expect(editor.dispose).not.toHaveBeenCalled()
		expect(sidebar.dispose).not.toHaveBeenCalled()
	})

	it("disposes the created new-tab provider when a post fails before the task starts", async () => {
		editor.postMessageToWebview.mockRejectedValueOnce(new Error("webview post failed"))

		await expect(api.startNewTask({ text: "new task", newTab: true })).rejects.toThrow("webview post failed")

		expect(editor.dispose).toHaveBeenCalledOnce()
		expect(sidebar.dispose).not.toHaveBeenCalled()
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
