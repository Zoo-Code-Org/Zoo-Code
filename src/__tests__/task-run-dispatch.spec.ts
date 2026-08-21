// npx vitest run __tests__/task-run-dispatch.spec.ts
//
// Tests Task#run() dispatch logic in isolation by calling the method on a
// minimal stand-in object that mirrors only the private fields run() reads.
// This avoids the cost of constructing a real Task (which pulls in VSCode APIs,
// RooIgnoreController, FileContextTracker, etc.).

import { describe, it, expect, vi } from "vitest"
import { Task } from "../core/task/Task"

// Access private fields at runtime — TypeScript enforces visibility at
// compile time only; at runtime they're plain properties on the instance.
type Runnable = {
	_started: boolean
	_runPromise: Promise<void> | undefined
	_isHistoryTask: boolean
	metadata: { task?: string | null; images?: string[] | null }
	resumeTaskFromHistory: () => Promise<void>
	startTask: (task?: string, images?: string[]) => Promise<void>
	startIdleTelemetryCheck: () => void
}

function makeRunnable(overrides: Partial<Runnable> = {}): Runnable & { run(): Promise<void> } {
	const obj: Runnable = {
		_started: false,
		_runPromise: undefined,
		_isHistoryTask: false,
		metadata: { task: undefined, images: undefined },
		resumeTaskFromHistory: vi.fn().mockResolvedValue(undefined),
		startTask: vi.fn().mockResolvedValue(undefined),
		startIdleTelemetryCheck: vi.fn(),
		...overrides,
	}
	// Bind the real run() implementation from Task.prototype to our stand-in.
	const runnable = obj as Runnable & { run(): Promise<void> }
	runnable.run = Task.prototype.run.bind(obj)
	return runnable
}

describe("Task#run() dispatch", () => {
	it("returns the existing _runPromise when already set", async () => {
		const sentinel = Promise.resolve()
		const obj = makeRunnable({ _runPromise: sentinel })
		expect(obj.run()).toBe(sentinel)
	})

	it("returns Promise.resolve() and skips dispatch when _started is true", async () => {
		const obj = makeRunnable({ _started: true })
		const result = obj.run()
		await expect(result).resolves.toBeUndefined()
		expect(obj.resumeTaskFromHistory).not.toHaveBeenCalled()
		expect(obj.startTask).not.toHaveBeenCalled()
	})

	it("calls resumeTaskFromHistory() when _isHistoryTask is true", async () => {
		const obj = makeRunnable({ _isHistoryTask: true })
		await obj.run()
		expect(obj.resumeTaskFromHistory).toHaveBeenCalledTimes(1)
		expect(obj.startTask).not.toHaveBeenCalled()
	})

	it("calls startTask() when _isHistoryTask is false and task text is set", async () => {
		const obj = makeRunnable({ _isHistoryTask: false, metadata: { task: "do something" } })
		await obj.run()
		expect(obj.startTask).toHaveBeenCalledWith("do something", undefined)
		expect(obj.resumeTaskFromHistory).not.toHaveBeenCalled()
	})

	it("returns Promise.resolve() when _isHistoryTask is false and no task/images", async () => {
		const obj = makeRunnable({ _isHistoryTask: false, metadata: { task: undefined, images: undefined } })
		await obj.run()
		expect(obj.startTask).not.toHaveBeenCalled()
		expect(obj.resumeTaskFromHistory).not.toHaveBeenCalled()
	})

	it("returns the same promise on repeated calls (idempotent via _runPromise)", async () => {
		const obj = makeRunnable({ _isHistoryTask: true })
		const p1 = obj.run()
		const p2 = obj.run()
		expect(p1).toBe(p2)
		await p1
		expect(obj.resumeTaskFromHistory).toHaveBeenCalledTimes(1)
	})
})
