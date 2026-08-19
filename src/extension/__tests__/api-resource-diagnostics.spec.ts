import { EventEmitter } from "events"

import { describe, expect, it, vi, beforeEach, type Mock } from "vitest"
import * as vscode from "vscode"

import { RooCodeEventName } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"

type ProviderDouble = EventEmitter & {
	context: vscode.ExtensionContext
	getCurrentTaskStack: Mock<() => string[]>
	getTaskStackSize: Mock<() => number>
	getLiveTasks: Mock<() => TaskDouble[]>
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
	provider.getTaskStackSize = vi.fn().mockReturnValue(0)
	provider.getLiveTasks = vi.fn().mockReturnValue([])
	return provider
}

function createTask(taskId: string): TaskDouble {
	const task = new EventEmitter() as TaskDouble
	task.taskId = taskId
	task.approveAsk = vi.fn()
	task.handleWebviewAskResponse = vi.fn()
	return task
}

/**
 * After the API constructor runs, the rebroadcast wiring has already attached
 * one provider-level listener per provider-scoped diagnostic event (TaskCreated,
 * TaskDelegationCompleted, TaskDelegationResumed). Task-scoped events have no
 * provider wiring, so they start at zero.
 */
const PROVIDER_WIRING_BASELINE: Record<string, number> = {
	[RooCodeEventName.Message]: 0,
	[RooCodeEventName.TaskCreated]: 1,
	[RooCodeEventName.TaskStarted]: 0,
	[RooCodeEventName.TaskCompleted]: 0,
	[RooCodeEventName.TaskAborted]: 0,
	[RooCodeEventName.TaskDelegationCompleted]: 1,
	[RooCodeEventName.TaskDelegationResumed]: 1,
	[RooCodeEventName.TaskModeSwitched]: 0,
}

describe("API#getResourceDiagnostics", () => {
	let api: API
	let sidebarProvider: ProviderDouble

	beforeEach(() => {
		sidebarProvider = createProvider()
		api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, asClineProvider(sidebarProvider))
	})

	it("returns zero task counters and the provider wiring baseline from an empty registry", () => {
		expect(api.getResourceDiagnostics()).toEqual({
			registeredTaskCount: 0,
			currentTaskStackLength: 0,
			listenerCounts: { ...PROVIDER_WIRING_BASELINE },
		})
	})

	it("sources registeredTaskCount from the provider task registry rather than a second registry", () => {
		const taskA = createTask("task-a")
		const taskB = createTask("task-b")
		sidebarProvider.getTaskStackSize.mockReturnValue(2)
		sidebarProvider.getCurrentTaskStack.mockReturnValue([taskA.taskId, taskB.taskId])
		sidebarProvider.getLiveTasks.mockReturnValue([taskA, taskB])

		const diagnostics = api.getResourceDiagnostics()

		expect(diagnostics.registeredTaskCount).toBe(2)
		expect(diagnostics.currentTaskStackLength).toBe(2)
	})

	it("counts the internal per-task and provider listeners attached by the rebroadcast wiring", () => {
		const task = createTask("internal-task")
		sidebarProvider.getTaskStackSize.mockReturnValue(1)
		sidebarProvider.getCurrentTaskStack.mockReturnValue([task.taskId])
		sidebarProvider.getLiveTasks.mockReturnValue([task])
		sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

		// TaskCreated on the provider triggers the wiring: one listener per
		// task-scoped diagnostic event on the task, on top of the provider baseline.
		// The delegation events are subscribed on both scopes, so they count twice.
		expect(api.getResourceDiagnostics().listenerCounts).toEqual({
			...PROVIDER_WIRING_BASELINE,
			[RooCodeEventName.Message]: 1,
			[RooCodeEventName.TaskStarted]: 1,
			[RooCodeEventName.TaskCompleted]: 1,
			[RooCodeEventName.TaskAborted]: 1,
			[RooCodeEventName.TaskDelegationCompleted]: 2,
			[RooCodeEventName.TaskDelegationResumed]: 2,
			[RooCodeEventName.TaskModeSwitched]: 1,
		})
	})

	it("excludes external API emitter consumers from the internal listener counts", () => {
		const task = createTask("internal-task")
		sidebarProvider.getTaskStackSize.mockReturnValue(1)
		sidebarProvider.getCurrentTaskStack.mockReturnValue([task.taskId])
		sidebarProvider.getLiveTasks.mockReturnValue([task])
		sidebarProvider.emit(RooCodeEventName.TaskCreated, task)

		const externalMessage = () => undefined
		api.on(RooCodeEventName.Message, externalMessage)
		const externalCompleted = () => undefined
		api.on(RooCodeEventName.TaskCompleted, externalCompleted)

		const listenerCounts = api.getResourceDiagnostics().listenerCounts
		expect(listenerCounts[RooCodeEventName.Message]).toBe(1)
		expect(listenerCounts[RooCodeEventName.TaskCompleted]).toBe(1)

		api.off(RooCodeEventName.Message, externalMessage)
		api.off(RooCodeEventName.TaskCompleted, externalCompleted)
	})

	it("keeps a leaked task visible in the registered count and listener sums after it leaves the stack", () => {
		const leakedTask = createTask("leaked-task")
		sidebarProvider.getTaskStackSize.mockReturnValue(1)
		sidebarProvider.getCurrentTaskStack.mockReturnValue([leakedTask.taskId])
		sidebarProvider.getLiveTasks.mockReturnValue([leakedTask])
		sidebarProvider.emit(RooCodeEventName.TaskCreated, leakedTask)

		// The task is evicted from the task stack but never removed from the registry.
		sidebarProvider.getCurrentTaskStack.mockReturnValue([])

		const diagnostics = api.getResourceDiagnostics()
		expect(diagnostics.currentTaskStackLength).toBe(0)
		expect(diagnostics.registeredTaskCount).toBe(1)
		expect(diagnostics.listenerCounts[RooCodeEventName.TaskCompleted]).toBe(1)
	})
})
