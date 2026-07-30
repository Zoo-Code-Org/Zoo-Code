import { EventEmitter } from "events"

import { describe, expect, it, vi, beforeEach, type Mock } from "vitest"
import * as vscode from "vscode"

import { RooCodeEventName } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"

type ProviderDouble = EventEmitter & {
	context: vscode.ExtensionContext
	getCurrentTaskStack: Mock<() => string[]>
	on: EventEmitter["on"]
}

type TaskDouble = EventEmitter & {
	taskId: string
	parentTaskId?: string
	approveAsk: Mock<() => void>
	handleWebviewAskResponse: Mock<(response: "messageResponse", text?: string, images?: string[]) => void>
}

function asClineProvider(provider: ProviderDouble): ClineProvider {
	// ClineProvider has private members, so a structural test double requires an unknown bridge.
	return provider as unknown as ClineProvider
}

function createProvider(): ProviderDouble {
	const provider = new EventEmitter() as ProviderDouble
	provider.context = {} as vscode.ExtensionContext
	provider.getCurrentTaskStack = vi.fn().mockReturnValue([])
	return provider
}

function createTask(taskId: string): TaskDouble {
	const task = new EventEmitter() as TaskDouble
	task.taskId = taskId
	task.approveAsk = vi.fn()
	task.handleWebviewAskResponse = vi.fn()
	return task
}

describe("API#getResourceDiagnostics", () => {
	let api: API
	let sidebarProvider: ProviderDouble

	beforeEach(() => {
		sidebarProvider = createProvider()
		api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, asClineProvider(sidebarProvider))
	})

	it("returns initial resource counters and lifecycle listener counts", () => {
		sidebarProvider.getCurrentTaskStack.mockReturnValue(["root-task", "child-task"])

		expect(api.getResourceDiagnostics()).toEqual({
			registeredTaskCount: 0,
			currentTaskStackLength: 2,
			listenerCounts: {
				[RooCodeEventName.Message]: 0,
				[RooCodeEventName.TaskCreated]: 0,
				[RooCodeEventName.TaskStarted]: 0,
				[RooCodeEventName.TaskCompleted]: 0,
				[RooCodeEventName.TaskAborted]: 0,
				[RooCodeEventName.TaskDelegationCompleted]: 0,
				[RooCodeEventName.TaskDelegationResumed]: 0,
				[RooCodeEventName.TaskModeSwitched]: 0,
			},
		})
	})

	it("reflects API lifecycle listener counts after on and off", () => {
		const messageListener = () => undefined
		const completedListener = () => undefined

		api.on(RooCodeEventName.Message, messageListener)
		api.on(RooCodeEventName.TaskCompleted, completedListener)

		expect(api.getResourceDiagnostics().listenerCounts).toMatchObject({
			[RooCodeEventName.Message]: 1,
			[RooCodeEventName.TaskCompleted]: 1,
		})

		api.off(RooCodeEventName.Message, messageListener)

		expect(api.getResourceDiagnostics().listenerCounts).toMatchObject({
			[RooCodeEventName.Message]: 0,
			[RooCodeEventName.TaskCompleted]: 1,
		})
	})

	it("tracks registered task count across task creation, completion, and abortion", () => {
		const completedTask = createTask("completed-task")
		sidebarProvider.getCurrentTaskStack.mockReturnValue([completedTask.taskId])
		sidebarProvider.emit(RooCodeEventName.TaskCreated, completedTask)

		expect(api.getResourceDiagnostics().registeredTaskCount).toBe(1)

		completedTask.emit(RooCodeEventName.TaskCompleted, completedTask.taskId, {}, {})

		expect(api.getResourceDiagnostics().registeredTaskCount).toBe(0)

		const abortedTask = createTask("aborted-task")
		sidebarProvider.getCurrentTaskStack.mockReturnValue([abortedTask.taskId])
		sidebarProvider.emit(RooCodeEventName.TaskCreated, abortedTask)

		expect(api.getResourceDiagnostics().registeredTaskCount).toBe(1)

		abortedTask.emit(RooCodeEventName.TaskAborted)

		expect(api.getResourceDiagnostics().registeredTaskCount).toBe(0)
	})

	it("prunes registered tasks that are no longer in the provider task stack", () => {
		const evictedTask = createTask("evicted-task")
		sidebarProvider.getCurrentTaskStack.mockReturnValue([evictedTask.taskId])
		sidebarProvider.emit(RooCodeEventName.TaskCreated, evictedTask)

		expect(api.getResourceDiagnostics().registeredTaskCount).toBe(1)

		sidebarProvider.getCurrentTaskStack.mockReturnValue([])

		expect(api.getResourceDiagnostics().registeredTaskCount).toBe(0)
	})
})
