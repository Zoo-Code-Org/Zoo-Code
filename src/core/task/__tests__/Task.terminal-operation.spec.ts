import { Task } from "../Task"

function buildTask() {
	const task = Object.create(Task.prototype) as Task
	task.terminalProcesses = new Map()
	return task
}

function stubProcess() {
	return { continue: vi.fn(), abort: vi.fn() }
}

describe("Task.handleTerminalOperation", () => {
	it.each([
		["continue", "abort"],
		["abort", "continue"],
	] as const)("%s reaches every running terminal process exactly once", async (operation, other) => {
		const task = buildTask()
		const first = stubProcess()
		const second = stubProcess()
		task.terminalProcesses.set("call_a", first as never)
		task.terminalProcesses.set("call_b", second as never)

		await task.handleTerminalOperation(operation)

		expect(first[operation]).toHaveBeenCalledTimes(1)
		expect(second[operation]).toHaveBeenCalledTimes(1)
		expect(first[other]).not.toHaveBeenCalled()
		expect(second[other]).not.toHaveBeenCalled()
	})

	it.each(["continue", "abort"] as const)(
		"%s does nothing when no terminal process is running",
		async (operation) => {
			await expect(buildTask().handleTerminalOperation(operation)).resolves.toBeUndefined()
		},
	)
})
