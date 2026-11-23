import { act, renderHook } from "@testing-library/react"

import { isMessageForCurrentTask, useManualCondenseWait } from "../useManualCondenseWait"

type WaitProps = { taskId: string | undefined }

function renderWait() {
	return renderHook(({ taskId }: WaitProps) => useManualCondenseWait(taskId), {
		initialProps: { taskId: "task-a" } as WaitProps,
	})
}

describe("isMessageForCurrentTask", () => {
	it.each([
		["matching id", "task-a", "task-a", true],
		["other task's id", "task-b", "task-a", false],
		["missing message id", undefined, "task-a", false],
		["empty message id", "", "task-a", false],
		["no current task", "task-a", undefined, false],
	])("%s", (_case, messageTaskId, currentTaskId, expected) => {
		expect(isMessageForCurrentTask(messageTaskId, currentTaskId)).toBe(expected)
	})
})

describe("useManualCondenseWait", () => {
	it("ends only on the matching task's response (FR11)", () => {
		const view = renderWait()
		act(() => view.result.current.startWait("task-a"))
		expect(view.result.current.waitingTaskId).toBe("task-a")

		act(() => view.result.current.finishWait("task-b"))
		expect(view.result.current.waitingTaskId).toBe("task-a")

		view.rerender({ taskId: "task-a" })
		expect(view.result.current.waitingTaskId).toBe("task-a")

		act(() => view.result.current.finishWait("task-a"))
		expect(view.result.current.waitingTaskId).toBeUndefined()
	})

	it.each([
		["another task is selected", "task-b"],
		["no task is selected (view close)", undefined],
	])("clears the wait when %s (FR12)", (_case, nextTaskId) => {
		const view = renderWait()
		act(() => view.result.current.startWait("task-a"))

		view.rerender({ taskId: nextTaskId })

		expect(view.result.current.waitingTaskId).toBeUndefined()
	})

	it("ignores a late response from the previous task after the new task starts its own wait (FR12)", () => {
		const view = renderWait()
		act(() => view.result.current.startWait("task-a"))
		view.rerender({ taskId: "task-b" })
		act(() => view.result.current.startWait("task-b"))

		act(() => view.result.current.finishWait("task-a"))
		expect(view.result.current.waitingTaskId).toBe("task-b")

		act(() => view.result.current.finishWait("task-b"))
		expect(view.result.current.waitingTaskId).toBeUndefined()
	})
})
