import { EventEmitter } from "events"

import { describe, expect, it, vi, beforeEach, type Mock } from "vitest"
import * as vscode from "vscode"

import { RooCodeEventName, type ModeConfig, type RooCodeSettings } from "@roo-code/types"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
// The merged API constructor requires a ClineProviderFactory; these specs drive
// tab creation through the mocked createClineTabPanel, so the factory must never
// be called. Cast structurally: the class type carries private members.
const makeUnusedTabFactory = () =>
	({
		createInNewTab: vi.fn().mockRejectedValue(new Error("Unexpected editor-tab creation in this test")),
	}) as unknown as ConstructorParameters<typeof API>[2]

const { createClineTabPanelMock } = vi.hoisted(() => ({
	createClineTabPanelMock: vi.fn(),
}))

vi.mock("vscode", () => ({
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	ExtensionMode: {
		Development: 1,
		ExtensionDevelopment: 2,
		Test: 3,
		Production: 4,
	},
}))

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {},
}))

vi.mock("../../activate/registerCommands", () => ({
	createClineTabPanel: createClineTabPanelMock,
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
	// Minimal context surface exercised by the task-control tests: the mode guard
	// reads extensionMode and getGlobalState/setGlobalState read/update globalState.
	context: {
		extensionMode: vscode.ExtensionMode
		globalState: {
			get: (key: string) => unknown
			update?: (key: string, value: unknown) => Promise<void>
		}
	}
	evictCurrentTask: Mock<() => Promise<void>>
	postStateToWebview: Mock<() => Promise<void>>
	postMessageToWebview: Mock<(message: unknown) => Promise<void>>
	createTask: Mock<(...args: unknown[]) => Promise<CreatedTask>>
	getCurrentTaskStack: Mock<() => string[]>
	getCurrentTask: Mock<() => undefined>
	getState: Mock<() => Promise<{ customModes?: ModeConfig[] }>>
	handleModeSwitch: Mock<(mode: string, targetTask?: unknown) => Promise<void>>
	viewLaunched: boolean
	isDisposed: boolean
	viewStateReadiness: Promise<void>
	taskHistoryStore: Map<string, unknown>
	webviewFocusTracker: typeof focusTrackerDouble
}

type TaskDouble = EventEmitter & {
	taskId: string
	parentTaskId?: string
	approveAsk: Mock<() => void>
	denyAsk: Mock<() => void>
	handleWebviewAskResponse: Mock<(response: "messageResponse", text?: string, images?: string[]) => void>
}

// Sentinel double: the API must forward the source provider's focus tracker to
// newly created tab providers, so the tests assert this exact object arrives.
const focusTrackerDouble = { kind: "focus-tracker-double" }

const configuration: RooCodeSettings = {}

function asClineProvider(provider: ProviderDouble): ClineProvider {
	// ClineProvider has private members, so a structural test double requires an unknown bridge.
	return provider as unknown as ClineProvider
}

function createProvider(taskId = "task-1"): ProviderDouble {
	const provider = new EventEmitter() as ProviderDouble
	// The default double leaves extensionMode unset (never Production), so the test-only
	// guard stays inert for the task-control tests.
	provider.context = {} as ProviderDouble["context"]
	provider.evictCurrentTask = vi.fn().mockResolvedValue(undefined)
	provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
	provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
	provider.createTask = vi.fn().mockResolvedValue({ taskId })
	provider.getCurrentTaskStack = vi.fn().mockReturnValue([])
	provider.getCurrentTask = vi.fn().mockReturnValue(undefined)
	provider.getState = vi.fn().mockResolvedValue({ customModes: [] })
	provider.handleModeSwitch = vi.fn().mockResolvedValue(undefined)
	provider.viewLaunched = true
	provider.isDisposed = false
	provider.viewStateReadiness = Promise.resolve()
	provider.taskHistoryStore = new Map()
	provider.webviewFocusTracker = focusTrackerDouble
	return provider
}

function createTask(taskId: string): TaskDouble {
	const task = new EventEmitter() as TaskDouble
	task.taskId = taskId
	task.approveAsk = vi.fn()
	task.denyAsk = vi.fn()
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
		api = new API(outputChannel, asClineProvider(sidebarProvider), makeUnusedTabFactory())
	})

	describe("startNewTask", () => {
		it("reverts and closes existing editors before opening a new tab unless preserveOpenTabs is true", async () => {
			const newTabProvider = createProvider("new-tab-task")
			createClineTabPanelMock.mockResolvedValue(newTabProvider)

			const taskId = await api.startNewTask({ configuration, text: "new task", newTab: true })

			expect(taskId).toBe("new-tab-task")
			expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(1, "workbench.action.files.revert")
			expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2, "workbench.action.closeAllEditors")
			expect(createClineTabPanelMock).toHaveBeenCalledWith({
				context: sidebarProvider.context,
				outputChannel,
				webviewFocusTracker: focusTrackerDouble,
			})
			expect(newTabProvider.evictCurrentTask).toHaveBeenCalledOnce()
			expect(newTabProvider.createTask).toHaveBeenCalledWith(
				"new task",
				undefined,
				undefined,
				{ consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER, toolRepetitionSoftLimit: 0 },
				configuration,
			)
		})

		it("opens a new tab without revert or close commands when preserveOpenTabs is true", async () => {
			const newTabProvider = createProvider("preserved-tab-task")
			createClineTabPanelMock.mockResolvedValue(newTabProvider)

			const taskId = await api.startNewTask({
				configuration,
				text: "keep editors",
				newTab: true,
				preserveOpenTabs: true,
			})

			expect(taskId).toBe("preserved-tab-task")
			expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
			expect(createClineTabPanelMock).toHaveBeenCalledWith({
				context: sidebarProvider.context,
				outputChannel,
				webviewFocusTracker: focusTrackerDouble,
			})
			expect(newTabProvider.createTask).toHaveBeenCalledWith(
				"keep editors",
				undefined,
				undefined,
				{ consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER, toolRepetitionSoftLimit: 0 },
				configuration,
			)
		})

		it("fails task creation when the view state is not ready within the readiness bound", async () => {
			// A readiness promise that never settles: the bound must reject task creation
			// instead of letting createTask run against stale shared defaults.
			sidebarProvider.viewStateReadiness = new Promise<void>(() => {})

			await expect(api.startNewTask({ configuration, text: "new task" })).rejects.toThrow(
				"Timed out waiting for the view state to become ready",
			)
			expect(sidebarProvider.createTask).not.toHaveBeenCalled()
		})

		it("cancels the readiness timeout when the view becomes ready within the bound", async () => {
			// Fake timers pin the exact timer surface: a global clearTimeout spy would
			// also fire for the flush sleep and library internals, so it could not
			// prove the readiness bound's own timer was cancelled.
			vi.useFakeTimers()
			let resolveReady!: () => void
			sidebarProvider.viewStateReadiness = new Promise<void>((resolve) => {
				resolveReady = resolve
			})

			const started = api.startNewTask({ configuration, text: "ready task" })
			await vi.advanceTimersByTimeAsync(50)
			resolveReady()

			try {
				await expect(started).resolves.toBe("sidebar-task")
				// The readiness bound's timer must be gone once readiness wins: a live
				// timer would later reject an unawaited promise and surface as an
				// unhandled rejection.
				expect(vi.getTimerCount()).toBe(0)
				// No late rejection can fire after the bound either.
				await vi.advanceTimersByTimeAsync(3000)
			} finally {
				vi.useRealTimers()
			}
		})

		it("continues with the shared-state fallback when the webview never launches", async () => {
			// Headless API callers create tasks without ever launching a webview: the
			// readiness bound expiring must not reject them - the pre-existing
			// shared-state fallback still applies.
			vi.useFakeTimers()
			sidebarProvider.viewLaunched = false
			sidebarProvider.viewStateReadiness = new Promise<void>(() => {})

			const started = api.startNewTask({ configuration, text: "headless task" })
			await vi.advanceTimersByTimeAsync(3000)

			try {
				await expect(started).resolves.toBe("sidebar-task")
			} finally {
				vi.useRealTimers()
			}
		})

		it("still rejects when the webview launched but the readiness bound expires", async () => {
			// A launched view whose readiness never settles is a real failure: the
			// task must not consume shared defaults behind a live view.
			vi.useFakeTimers()
			sidebarProvider.viewStateReadiness = new Promise<void>(() => {})

			const started = api.startNewTask({ configuration, text: "stuck view task" })
			// Attach the rejection handler before advancing: with fake timers the
			// bound fires during the advance, and a handler attached afterwards would
			// see the rejection briefly unhandled.
			const settled = expect(started).rejects.toThrow("Timed out waiting for the view state to become ready")
			await vi.advanceTimersByTimeAsync(3000)

			try {
				await settled
			} finally {
				vi.useRealTimers()
			}
		})

		it("fails task creation when the provider is disposed while the readiness wait is pending", async () => {
			// Disposal resolves viewStateReadiness to release waiters (see ClineProvider.dispose)
			// and marks the provider disposed first: the wait must then fail instead of
			// creating a task against the disposed view.
			let resolveReady!: () => void
			sidebarProvider.viewStateReadiness = new Promise<void>((resolve) => {
				resolveReady = resolve
			})

			const started = api.startNewTask({ configuration, text: "new task" })
			await new Promise((resolve) => setTimeout(resolve, 50))
			sidebarProvider.isDisposed = true
			resolveReady()

			await expect(started).rejects.toThrow(
				"The provider was disposed while waiting for the view state to become ready",
			)
			expect(sidebarProvider.createTask).not.toHaveBeenCalled()
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
		it("denies a registered task by id", async () => {
			const task = createTask("task-to-deny")

			sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

			await expect(api.denyTaskAsk(task.taskId)).resolves.toBe(true)
			expect(task.denyAsk).toHaveBeenCalledOnce()
		})

		it("returns false when denying an unknown or de-registered task", async () => {
			const task = createTask("task-denied-lifecycle")
			sidebarProvider.emit(RooCodeEventName.TaskCreated, task)
			task.emit(RooCodeEventName.TaskCompleted, task.taskId, {}, {})

			// Unknown id, and an id whose registry entry was removed on completion.
			await expect(api.denyTaskAsk("missing-task")).resolves.toBe(false)
			await expect(api.denyTaskAsk(task.taskId)).resolves.toBe(false)
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

		it("re-emits TaskStarted and records it in the message log for a registered task", async () => {
			// The per-task TaskStarted listener re-emits the event on the API and records it
			// through fileLog: spy on the prototype so the message content is observable
			// (fileLog is a no-op without the enableLogging flag).
			const fileLogSpy = vi.spyOn(API.prototype, "fileLog" as keyof API).mockResolvedValue(undefined)
			const task = createTask("task-to-start")
			sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

			const started = new Promise<string>((resolve) => {
				api.once(RooCodeEventName.TaskStarted, (taskId: string) => resolve(taskId))
			})
			task.emit(RooCodeEventName.TaskStarted)

			await expect(started).resolves.toBe("task-to-start")
			expect(fileLogSpy).toHaveBeenCalledWith(expect.stringContaining("taskStarted -> task-to-start"))
			fileLogSpy.mockRestore()
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
			// Deferred mode switch: the follow-up answer must stay pending while the
			// switch is, so the assertion below can observe the in-between state.
			let releaseModeSwitch: () => void = () => {}
			const modeSwitchSettled = new Promise<void>((resolve) => {
				releaseModeSwitch = resolve
			})
			sidebarProvider.handleModeSwitch.mockImplementation(() => modeSwitchSettled)
			sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

			const selecting = api.selectTaskFollowupSuggestion({
				taskId: task.taskId,
				answer: "Use architect",
				mode: "architect",
			})

			// Flush microtasks so the flow reaches the (still pending) mode-switch await.
			for (let i = 0; i < 8; i++) {
				await Promise.resolve()
			}

			expect(sidebarProvider.getState).toHaveBeenCalledOnce()
			expect(sidebarProvider.handleModeSwitch).toHaveBeenCalledWith("architect", task)
			// The mode switch must be awaited before answering: while it is still
			// pending, the task's ask stays unanswered.
			expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()

			releaseModeSwitch()
			await expect(selecting).resolves.toBe(true)
			expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "Use architect")
		})

		it("responds without switching modes and logs when the requested mode is invalid", async () => {
			const task = createTask("task-invalid-mode")
			api = new API(outputChannel, asClineProvider(sidebarProvider), makeUnusedTabFactory(), undefined, true)
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
		api = new API(outputChannel, asClineProvider(sidebarProvider), makeUnusedTabFactory())
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
		api = new API(outputChannel, asClineProvider(sidebarProvider), makeUnusedTabFactory(), undefined, true)
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

	it("wires a provider's task events exactly once when the same provider is reused for a new tab", async () => {
		// A second new-tab task resolving the SAME provider (an existing tab panel returns
		// its live provider) must not re-register its listeners: a duplicate copy would
		// re-emit every task event once per registered handler.
		const newTabProvider = createProvider("reused-tab-task")
		createClineTabPanelMock.mockResolvedValue(newTabProvider)

		await api.startNewTask({ configuration, text: "first", newTab: true })
		await api.startNewTask({ configuration, text: "second", newTab: true })

		const seen: string[] = []
		api.on(RooCodeEventName.TaskCompleted, (taskId: string) => {
			seen.push(taskId)
		})

		newTabProvider.emit(RooCodeEventName.TaskCompleted, "reused-tab-task", {}, {})
		// The provider-side handler is async (file logging after the re-emit); let it settle
		// before asserting on the emission count.
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(seen).toEqual(["reused-tab-task"])
	})

	describe("test-only API production guard", () => {
		function withProductionContext() {
			return {
				extensionMode: vscode.ExtensionMode.Production,
				globalState: { get: vi.fn() },
			}
		}

		it("rejects the task ask and global-state surface in production mode", async () => {
			sidebarProvider.context = withProductionContext()
			api = new API(outputChannel, asClineProvider(sidebarProvider), makeUnusedTabFactory())

			// Pin the method name in each message: the guard builds the error from the
			// method argument, and a partial match would leave the argument untested.
			await expect(api.approveTaskAsk("task-1")).rejects.toThrow("approveTaskAsk is a test-only API")
			await expect(api.denyTaskAsk("task-1")).rejects.toThrow("denyTaskAsk is a test-only API")
			await expect(api.selectTaskFollowupSuggestion({ taskId: "task-1", answer: "yes" })).rejects.toThrow(
				"selectTaskFollowupSuggestion is a test-only API",
			)
			expect(() => api.getGlobalState("mode")).toThrow("getGlobalState is a test-only API")
			// setGlobalState is async: the guard rejects instead of throwing synchronously.
			await expect(api.setGlobalState("mode", "ask")).rejects.toThrow("setGlobalState is a test-only API")
		})

		it("keeps the task ask and global-state surface available outside production mode", async () => {
			const get = vi.fn().mockReturnValue("code")
			const update = vi.fn().mockResolvedValue(undefined)
			sidebarProvider.context = {
				extensionMode: vscode.ExtensionMode.Test,
				globalState: { get, update },
			}
			api = new API(outputChannel, asClineProvider(sidebarProvider), makeUnusedTabFactory())

			expect(api.getGlobalState("mode")).toBe("code")
			expect(get).toHaveBeenCalledWith("mode")
			await api.setGlobalState("mode", "ask")
			expect(update).toHaveBeenCalledWith("mode", "ask")
			await expect(api.approveTaskAsk("missing-task")).resolves.toBe(false)
		})

		it("rejects runtime keys outside the settings schema before touching storage", async () => {
			const get = vi.fn()
			const update = vi.fn().mockResolvedValue(undefined)
			sidebarProvider.context = {
				extensionMode: vscode.ExtensionMode.Test,
				globalState: { get, update },
			}
			api = new API(outputChannel, asClineProvider(sidebarProvider), makeUnusedTabFactory())

			// The generic only constrains typed callers; a crafted runtime key must
			// be refused by the schema check before it reaches globalState storage.
			expect(() => api.getGlobalState("bogusKey" as never)).toThrow("outside the settings schema")
			expect(get).not.toHaveBeenCalled()
			await expect(api.setGlobalState("bogusKey" as never, 1 as never)).rejects.toThrow(
				"outside the settings schema",
			)
			expect(update).not.toHaveBeenCalled()

			// A schema key still passes through.
			expect(api.getGlobalState("mode")).toBeUndefined()
			expect(get).toHaveBeenCalledWith("mode")
		})

		it("rejects credential-bearing keys before touching storage", async () => {
			const get = vi.fn()
			const update = vi.fn().mockResolvedValue(undefined)
			sidebarProvider.context = {
				extensionMode: vscode.ExtensionMode.Test,
				globalState: { get, update },
			}
			api = new API(outputChannel, asClineProvider(sidebarProvider), makeUnusedTabFactory())

			// mimoApiKey and openAiHeaders are schema keys but carry credentials; the
			// test-only API must refuse them before storage access, both directions.
			expect(() => api.getGlobalState("mimoApiKey" as never)).toThrow("credential-bearing key")
			expect(() => api.getGlobalState("openAiHeaders" as never)).toThrow("credential-bearing key")
			expect(get).not.toHaveBeenCalled()
			await expect(api.setGlobalState("mimoApiKey" as never, "sk-test" as never)).rejects.toThrow(
				"credential-bearing key",
			)
			expect(update).not.toHaveBeenCalled()

			// A non-credential schema key still passes through.
			expect(api.getGlobalState("mode")).toBeUndefined()
			expect(get).toHaveBeenCalledWith("mode")
		})

		it("rejects PII keys and malformed values before touching global-state storage", async () => {
			const get = vi.fn().mockReturnValue("stored")
			const update = vi.fn().mockResolvedValue(undefined)
			sidebarProvider.context = {
				extensionMode: vscode.ExtensionMode.Test,
				globalState: { get, update },
			}
			api = new API(outputChannel, asClineProvider(sidebarProvider), makeUnusedTabFactory())

			// Task history carries user PII and stays unreachable even though it is a
			// plain GlobalState key.
			expect(() => api.getGlobalState("taskHistory")).toThrow("PII-bearing key")
			await expect(api.setGlobalState("taskHistory", [])).rejects.toThrow("PII-bearing key")
			// Values are runtime data: a malformed value is rejected before storage.
			await expect(api.setGlobalState("alwaysAllowWrite", {} as never)).rejects.toThrow("invalid value for key")
			// Provider-settings keys have no global-settings schema entry.
			await expect(api.setGlobalState("apiModelId", "x")).rejects.toThrow("without a value schema")
			expect(update).not.toHaveBeenCalled()
			expect(get).not.toHaveBeenCalled()
			// An allowed key with a valid value still works.
			await api.setGlobalState("mode", "ask")
			expect(update).toHaveBeenCalledWith("mode", "ask")
			// Non-strict object schemas strip unknown fields only in the parsed
			// value: the API must persist the parsed data, not the raw payload.
			await api.setGlobalState("viewStates", {
				"view-a": { mode: "debug", apiKey: "stray-secret" },
			} as never)
			expect(update).toHaveBeenLastCalledWith("viewStates", { "view-a": { mode: "debug" } })
		})
	})

	describe("startNewTask view-state readiness", () => {
		it("waits for the provider view state to load before creating the task", async () => {
			let resolveReadiness: () => void = () => {}
			const readiness = new Promise<void>((resolve) => {
				resolveReadiness = resolve
			})
			const newTabProvider = createProvider("new-tab-task")
			newTabProvider.viewStateReadiness = readiness
			createClineTabPanelMock.mockResolvedValue(newTabProvider)

			const started = api.startNewTask({ configuration, text: "wait for view state", newTab: true })

			// The task must not start while the view persisted state is still loading.
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(newTabProvider.createTask).not.toHaveBeenCalled()

			resolveReadiness()

			await expect(started).resolves.toBe("new-tab-task")
			expect(newTabProvider.createTask).toHaveBeenCalled()
		})
	})

	describe("startNewTask listener idempotency", () => {
		it("registers provider listeners once when the same provider is reused", async () => {
			const sharedProvider = createProvider("shared-task")
			createClineTabPanelMock.mockResolvedValue(sharedProvider)

			await api.startNewTask({ configuration, text: "one", newTab: true })
			await api.startNewTask({ configuration, text: "two", newTab: true })

			// Re-registering the same provider must not stack duplicate listeners.
			expect(sharedProvider.listenerCount(RooCodeEventName.TaskCompleted)).toBe(1)

			let completions = 0
			api.on(RooCodeEventName.TaskCompleted, () => {
				completions++
			})
			sharedProvider.emit(RooCodeEventName.TaskCompleted, "shared-task")

			expect(completions).toBe(1)
		})
	})
})
