import { EventEmitter } from "events"

import { describe, expect, it, vi, beforeEach, type Mock } from "vitest"
import * as vscode from "vscode"

import { RooCodeEventName, type ModeConfig, type RooCodeSettings } from "@roo-code/types"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"

const { openClineInNewTabMock } = vi.hoisted(() => ({
	openClineInNewTabMock: vi.fn(),
}))

vi.mock("vscode", () => ({
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
}))

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {},
}))

vi.mock("../../activate/registerCommands", () => ({
	openClineInNewTab: openClineInNewTabMock,
}))

vi.mock("../../integrations/terminal/Terminal", () => ({
	Terminal: {
		getTerminalProfile: vi.fn(),
		setTerminalProfile: vi.fn(),
	},
}))

vi.mock("../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		closeIdleTerminals: vi.fn(),
	},
}))

type CreatedTask = {
	taskId: string
}

type ProviderDouble = EventEmitter & {
	context: vscode.ExtensionContext
	evictCurrentTask: Mock<() => Promise<void>>
	postStateToWebview: Mock<() => Promise<void>>
	postMessageToWebview: Mock<(message: unknown) => Promise<void>>
	createTask: Mock<(...args: unknown[]) => Promise<CreatedTask>>
	getCurrentTaskStack: Mock<() => string[]>
	getCurrentTask: Mock<() => undefined>
	getState: Mock<() => Promise<{ customModes?: ModeConfig[] }>>
	handleModeSwitch: Mock<(mode: string, targetTask?: unknown) => Promise<void>>
	viewLaunched: boolean
}

type TaskDouble = EventEmitter & {
	taskId: string
	parentTaskId?: string
	approveAsk: Mock<() => void>
	handleWebviewAskResponse: Mock<(response: "messageResponse", text?: string, images?: string[]) => void>
}

const configuration: RooCodeSettings = {}

function asClineProvider(provider: ProviderDouble): ClineProvider {
	// ClineProvider has private members, so a structural test double requires an unknown bridge.
	return provider as unknown as ClineProvider
}

function createProvider(taskId = "task-1"): ProviderDouble {
	const provider = new EventEmitter() as ProviderDouble
	provider.context = {} as vscode.ExtensionContext
	provider.evictCurrentTask = vi.fn().mockResolvedValue(undefined)
	provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
	provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
	provider.createTask = vi.fn().mockResolvedValue({ taskId })
	provider.getCurrentTaskStack = vi.fn().mockReturnValue([])
	provider.getCurrentTask = vi.fn().mockReturnValue(undefined)
	provider.getState = vi.fn().mockResolvedValue({ customModes: [] })
	provider.handleModeSwitch = vi.fn().mockResolvedValue(undefined)
	provider.viewLaunched = true
	return provider
}

function createTask(taskId: string): TaskDouble {
	const task = new EventEmitter() as TaskDouble
	task.taskId = taskId
	task.approveAsk = vi.fn()
	task.handleWebviewAskResponse = vi.fn()
	return task
}

describe("API task controls", () => {
	let outputChannel: vscode.OutputChannel
	let sidebarProvider: ProviderDouble
	let api: API

	beforeEach(() => {
		vi.clearAllMocks()
		outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		sidebarProvider = createProvider("sidebar-task")
		api = new API(outputChannel, asClineProvider(sidebarProvider))
	})

	describe("startNewTask", () => {
		it("reverts and closes existing editors before opening a new tab unless preserveOpenTabs is true", async () => {
			const newTabProvider = createProvider("new-tab-task")
			openClineInNewTabMock.mockResolvedValue(newTabProvider)

			const taskId = await api.startNewTask({ configuration, text: "new task", newTab: true })

			expect(taskId).toBe("new-tab-task")
			expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(1, "workbench.action.files.revert")
			expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2, "workbench.action.closeAllEditors")
			expect(openClineInNewTabMock).toHaveBeenCalledWith({
				context: sidebarProvider.context,
				outputChannel,
			})
			expect(newTabProvider.evictCurrentTask).toHaveBeenCalledOnce()
			expect(newTabProvider.createTask).toHaveBeenCalledWith(
				"new task",
				undefined,
				undefined,
				{ consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER },
				configuration,
			)
		})

		it("opens a new tab without revert or close commands when preserveOpenTabs is true", async () => {
			const newTabProvider = createProvider("preserved-tab-task")
			openClineInNewTabMock.mockResolvedValue(newTabProvider)

			const taskId = await api.startNewTask({
				configuration,
				text: "keep editors",
				newTab: true,
				preserveOpenTabs: true,
			})

			expect(taskId).toBe("preserved-tab-task")
			expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
			expect(openClineInNewTabMock).toHaveBeenCalledWith({
				context: sidebarProvider.context,
				outputChannel,
			})
			expect(newTabProvider.createTask).toHaveBeenCalledWith(
				"keep editors",
				undefined,
				undefined,
				{ consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER },
				configuration,
			)
		})
	})

	describe("task ask registry", () => {
		it("returns false when approving an unknown task", async () => {
			await expect(api.approveTaskAsk("missing-task")).resolves.toBe(false)
		})

		it("registers tasks on TaskCreated and approves a task by id", async () => {
			const task = createTask("task-to-approve")

			sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

			await expect(api.approveTaskAsk(task.taskId)).resolves.toBe(true)
			expect(task.approveAsk).toHaveBeenCalledOnce()
		})

		it("removes completed, aborted, and unfocused tasks from the registry", async () => {
			const completedTask = createTask("completed-task")
			sidebarProvider.emit(RooCodeEventName.TaskCreated, completedTask)
			completedTask.emit(RooCodeEventName.TaskCompleted, completedTask.taskId, {}, {})

			await expect(api.approveTaskAsk(completedTask.taskId)).resolves.toBe(false)

			const abortedTask = createTask("aborted-task")
			sidebarProvider.emit(RooCodeEventName.TaskCreated, abortedTask)
			abortedTask.emit(RooCodeEventName.TaskAborted)

			await expect(api.approveTaskAsk(abortedTask.taskId)).resolves.toBe(false)

			const unfocusedTask = createTask("unfocused-task")
			sidebarProvider.emit(RooCodeEventName.TaskCreated, unfocusedTask)
			unfocusedTask.emit(RooCodeEventName.TaskUnfocused)

			await expect(api.approveTaskAsk(unfocusedTask.taskId)).resolves.toBe(false)
		})

		it("ignores a late teardown event after the registry entry was already removed", async () => {
			const task = createTask("late-teardown-task")
			sidebarProvider.emit(RooCodeEventName.TaskCreated, task)
			task.emit(RooCodeEventName.TaskCompleted, task.taskId, {}, {})

			// The completed event already removed the entry. A late duplicate teardown event
			// must be a silent no-op, not a crash on the missing entry.
			expect(() => task.emit(RooCodeEventName.TaskAborted)).not.toThrow()
			await expect(api.approveTaskAsk(task.taskId)).resolves.toBe(false)
		})
	})

	describe("selectTaskFollowupSuggestion", () => {
		it("returns false when the task is unknown", async () => {
			await expect(
				api.selectTaskFollowupSuggestion({ taskId: "missing-task", answer: "Use this" }),
			).resolves.toBe(false)
		})

		it("responds to the task without switching modes when no mode is provided", async () => {
			const task = createTask("task-without-mode")
			sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

			await expect(api.selectTaskFollowupSuggestion({ taskId: task.taskId, answer: "Continue" })).resolves.toBe(
				true,
			)

			expect(sidebarProvider.getState).not.toHaveBeenCalled()
			expect(sidebarProvider.handleModeSwitch).not.toHaveBeenCalled()
			expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "Continue")
		})

		it("switches to a valid built-in mode before responding", async () => {
			const task = createTask("task-built-in-mode")
			sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

			await expect(
				api.selectTaskFollowupSuggestion({ taskId: task.taskId, answer: "Use architect", mode: "architect" }),
			).resolves.toBe(true)

			expect(sidebarProvider.getState).toHaveBeenCalledOnce()
			expect(sidebarProvider.handleModeSwitch).toHaveBeenCalledWith("architect", task)
			expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "Use architect")
		})

		it("responds without switching modes and logs when the requested mode is invalid", async () => {
			const task = createTask("task-invalid-mode")
			api = new API(outputChannel, asClineProvider(sidebarProvider), undefined, true)
			sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

			await expect(
				api.selectTaskFollowupSuggestion({ taskId: task.taskId, answer: "Use invalid", mode: "not-a-mode" }),
			).resolves.toBe(true)

			expect(sidebarProvider.getState).toHaveBeenCalledOnce()
			expect(sidebarProvider.handleModeSwitch).not.toHaveBeenCalled()
			expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "Use invalid")
			expect(outputChannel.appendLine).toHaveBeenCalledWith(
				'[API#selectTaskFollowupSuggestion] ignoring unknown mode "not-a-mode" for task task-invalid-mode',
			)
		})

		it("treats custom modes from the task provider state as valid", async () => {
			const task = createTask("task-custom-mode")
			const customMode: ModeConfig = {
				slug: "custom-review",
				name: "Custom Review",
				roleDefinition: "Review the implementation",
				groups: ["read"],
			}
			sidebarProvider.getState.mockResolvedValue({ customModes: [customMode] })
			sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

			await expect(
				api.selectTaskFollowupSuggestion({ taskId: task.taskId, answer: "Review it", mode: customMode.slug }),
			).resolves.toBe(true)

			expect(sidebarProvider.handleModeSwitch).toHaveBeenCalledWith(customMode.slug, task)
			expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "Review it")
		})
	})
})

describe("API task controls - per-view review fixes", () => {
	let outputChannel: vscode.OutputChannel
	let sidebarProvider: ProviderDouble
	let api: API

	beforeEach(() => {
		vi.clearAllMocks()
		outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		sidebarProvider = createProvider("sidebar-task")
		api = new API(outputChannel, asClineProvider(sidebarProvider))
	})

	it("keeps the new registration when a replaced task instance tears down", async () => {
		const staleTask = createTask("replaced-task")
		sidebarProvider.emit(RooCodeEventName.TaskCreated, staleTask)

		// A new instance reusing the same taskId replaces the stale registration.
		const freshTask = createTask("replaced-task")
		sidebarProvider.emit(RooCodeEventName.TaskCreated, freshTask)

		// The stale instance teardown must not drop the new registration.
		staleTask.emit(RooCodeEventName.TaskAborted)
		await expect(api.approveTaskAsk("replaced-task")).resolves.toBe(true)

		freshTask.emit(RooCodeEventName.TaskUnfocused)
		await expect(api.approveTaskAsk("replaced-task")).resolves.toBe(false)
	})

	it("still delivers the follow-up answer when the mode switch fails", async () => {
		const task = createTask("task-failing-switch")
		api = new API(outputChannel, asClineProvider(sidebarProvider), undefined, true)
		sidebarProvider.handleModeSwitch.mockRejectedValueOnce(new Error("persist failed"))
		sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

		await expect(
			api.selectTaskFollowupSuggestion({ taskId: task.taskId, answer: "Deliver anyway", mode: "architect" }),
		).resolves.toBe(true)

		expect(sidebarProvider.handleModeSwitch).toHaveBeenCalledWith("architect", task)
		expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "Deliver anyway")
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[API#selectTaskFollowupSuggestion] mode switch failed for task task-failing-switch: persist failed",
		)
	})
})
