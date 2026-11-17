// npx vitest run __tests__/new-task-delegation.spec.ts

import { describe, it, expect, vi } from "vitest"
import { RooCodeEventName } from "@roo-code/types"
import { Task } from "../core/task/Task"
import type { ClineProvider } from "../core/webview/ClineProvider"

describe("Task.startSubtask() metadata-driven delegation", () => {
	it("Routes to provider.delegateParentAndOpenChild without pausing parent", async () => {
		// This double provides the state, delegation, task creation, and mode-switch members used here.
		const provider = {
			getState: vi.fn().mockResolvedValue({
				experiments: {},
			}),
			delegateParentAndOpenChild: vi.fn().mockResolvedValue({ taskId: "child-1" }),
			createTask: vi.fn(),
			handleModeSwitch: vi.fn(),
		} as unknown as ClineProvider

		// Create a minimal Task-like instance with only fields used by startSubtask
		const emitMock = vi.fn<Task["emit"]>()
		const parent = Object.create(Task.prototype) as Task
		Object.assign(parent, {
			taskId: "parent-1",
			providerRef: { deref: () => provider },
			emit: emitMock,
		})

		const child = await Task.prototype.startSubtask.call(parent, "Do something", [], "code")

		expect(provider.delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		expect(child.taskId).toBe("child-1")

		// No paused/unpaused events should be emitted
		expect(parent.childTaskId).toBeUndefined()
		const emittedEvents = emitMock.mock.calls.map((c) => c[0])
		expect(emittedEvents).not.toContain(RooCodeEventName.TaskPaused)
		expect(emittedEvents).not.toContain(RooCodeEventName.TaskUnpaused)

		// Legacy path not used
		expect(provider.createTask).not.toHaveBeenCalled()
	})
})
