import { EventEmitter } from "events"
import type { OutputChannel } from "vscode"
import { describe, expect, it, vi } from "vitest"

import { RooCodeEventName, type TaskEvents, type TaskProviderEvents } from "@roo-code/types"

import type { Task } from "../../core/task/Task"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import { makeClineProviderFactory } from "../../test-utils/provider"
import { API } from "../api"

vi.mock("vscode")
vi.mock("@roo-code/ipc", () => ({ IpcServer: vi.fn() }))

function setup() {
	const provider = new EventEmitter<TaskProviderEvents>()
	const output: OutputChannel = {
		name: "test",
		append: vi.fn(),
		appendLine: vi.fn(),
		replace: vi.fn(),
		clear: vi.fn(),
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn(),
	}
	// The provider double supplies the typed event subscription API used by the constructor.
	const api = new API(output, provider as unknown as ClineProvider, makeClineProviderFactory())
	return { api, provider }
}

describe("API delegation event forwarding", () => {
	it.each([
		RooCodeEventName.TaskDelegated,
		RooCodeEventName.TaskDelegationCompleted,
		RooCodeEventName.TaskDelegationResumed,
	])("forwards %s from tasks with the owning task ID", (event) => {
		const { api, provider } = setup()
		const listener = vi.fn()
		api.on(event, listener)
		const task = Object.assign(new EventEmitter<TaskEvents>(), { taskId: "parent-task" })
		// The task double supplies taskId and typed event subscriptions for TaskCreated wiring.
		provider.emit(RooCodeEventName.TaskCreated, task as unknown as Task)

		if (event === RooCodeEventName.TaskDelegationCompleted) {
			task.emit(event, "child-task", "Child finished successfully")
			expect(listener).toHaveBeenCalledExactlyOnceWith("parent-task", "child-task", "Child finished successfully")
		} else {
			if (event === RooCodeEventName.TaskDelegated) {
				task.emit(RooCodeEventName.TaskDelegated, "child-task")
			} else {
				task.emit(RooCodeEventName.TaskDelegationResumed, "child-task")
			}
			expect(listener).toHaveBeenCalledExactlyOnceWith("parent-task", "child-task")
		}
	})

	it.each([
		RooCodeEventName.TaskDelegated,
		RooCodeEventName.TaskDelegationCompleted,
		RooCodeEventName.TaskDelegationResumed,
	])("forwards %s from providers with the supplied parent ID", (event) => {
		const { api, provider } = setup()
		const listener = vi.fn()
		api.on(event, listener)

		if (event === RooCodeEventName.TaskDelegationCompleted) {
			provider.emit(event, "other-parent", "child-task", "Child finished successfully")
			expect(listener).toHaveBeenCalledExactlyOnceWith(
				"other-parent",
				"child-task",
				"Child finished successfully",
			)
		} else {
			if (event === RooCodeEventName.TaskDelegated) {
				provider.emit(RooCodeEventName.TaskDelegated, "other-parent", "child-task")
			} else {
				provider.emit(RooCodeEventName.TaskDelegationResumed, "other-parent", "child-task")
			}
			expect(listener).toHaveBeenCalledExactlyOnceWith("other-parent", "child-task")
		}
	})
})
