import type { Event } from "vscode"
import type { BatchProcessingSummary, IFileWatcher } from "../interfaces"
import { CodeIndexStateManager } from "../state-manager"
import { CodeIndexWatcherSession } from "../code-index-watcher-session"

vi.mock("vscode", async () => {
	const { makeEventEmitter } = await import("../../../test-utils/vscode")
	return {
		EventEmitter: vi.fn().mockImplementation(function () {
			return makeEventEmitter()
		}),
	}
})

function eventSource<T>() {
	const listeners = new Set<(value: T) => void>()
	const dispose = vi.fn(() => listeners.clear())
	const event: Event<T> = (listener) => {
		listeners.add(listener)
		return { dispose }
	}
	return { event: vi.fn(event), fire: (value: T) => listeners.forEach((listener) => listener(value)), dispose }
}

function setup() {
	const start = eventSource<string[]>()
	const progress = eventSource<{ processedInBatch: number; totalInBatch: number; currentFile?: string }>()
	const finish = eventSource<BatchProcessingSummary>()
	const watcher = {
		initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		dispose: vi.fn(),
		processFile: vi.fn<IFileWatcher["processFile"]>(),
		onDidStartBatchProcessing: start.event,
		onBatchProgressUpdate: progress.event,
		onDidFinishBatchProcessing: finish.event,
	} satisfies IFileWatcher
	const state = new CodeIndexStateManager()
	const factory = { create: vi.fn(() => watcher) }
	const session = new CodeIndexWatcherSession(factory, state)
	return { start, progress, finish, watcher, state, session, factory }
}

describe("CodeIndexWatcherSession", () => {
	it("allows startup after stopping an idle owner without allocating resources", async () => {
		const { session, watcher, factory } = setup()
		session.stop()
		expect(factory.create).not.toHaveBeenCalled()
		expect(watcher.dispose).not.toHaveBeenCalled()
		await session.start()
		expect(watcher.initialize).toHaveBeenCalledTimes(1)
	})

	it("reuses pending and active sessions without duplicating subscriptions", async () => {
		const { session, watcher, start } = setup()
		const pending = session.start()
		expect(session.start()).toBe(pending)
		await pending
		await session.start()
		expect(watcher.initialize).toHaveBeenCalledTimes(1)
		expect(start.event).toHaveBeenCalledTimes(1)
	})

	it.each(["initialize", "progress", "finish"])("cleans partial startup when %s fails", async (stage) => {
		const { session, watcher, start, progress, finish } = setup()
		const error = new Error("startup failed")
		if (stage === "initialize") watcher.initialize.mockRejectedValue(error)
		else
			(stage === "progress" ? progress : finish).event.mockImplementation(() => {
				throw error
			})
		await expect(session.start()).rejects.toBe(error)
		expect(watcher.dispose).toHaveBeenCalledTimes(1)
		if (stage !== "initialize") expect(start.dispose).toHaveBeenCalledTimes(1)
		if (stage === "finish") expect(progress.dispose).toHaveBeenCalledTimes(1)
		session.stop()
		expect(watcher.dispose).toHaveBeenCalledTimes(1)
	})

	it("does not revive initialization stopped while pending", async () => {
		const { session, watcher, start } = setup()
		let resolve!: () => void
		watcher.initialize.mockReturnValue(
			new Promise<void>((done) => {
				resolve = done
			}),
		)
		const pending = session.start()
		session.stop()
		resolve()
		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		expect(start.event).not.toHaveBeenCalled()
		expect(watcher.dispose).toHaveBeenCalledTimes(2)
		expect(watcher.initialize).toHaveBeenCalledTimes(1)
	})

	it("unsubscribes once and ignores retained callbacks after stop", async () => {
		const { session, watcher, start, progress, finish, state } = setup()
		await session.start()
		const callback = finish.event.mock.calls[0][0]
		session.stop()
		session.stop()
		callback({ processedFiles: [], batchError: new Error("late") })
		expect(state.state).toBe("Standby")
		for (const source of [start, progress, finish]) expect(source.dispose).toHaveBeenCalledTimes(1)
		expect(watcher.dispose).toHaveBeenCalledTimes(1)
	})

	it.each(["stop", "failure"])("creates a working replacement after %s", async (reason) => {
		const first = setup()
		const next = setup()
		first.factory.create.mockReturnValueOnce(first.watcher).mockReturnValue(next.watcher)
		if (reason === "failure") {
			first.watcher.initialize.mockRejectedValueOnce(new Error("startup failed"))
			await expect(first.session.start()).rejects.toThrow("startup failed")
		} else {
			await first.session.start()
			first.session.stop()
		}
		await first.session.start()
		expect(first.factory.create).toHaveBeenCalledTimes(2)
		expect(first.watcher.dispose).toHaveBeenCalledTimes(1)
		next.progress.fire({ processedInBatch: 0, totalInBatch: 1 })
		expect(first.state.state).toBe("Indexing")
		next.finish.fire({ processedFiles: [] })
		expect(first.state.state).toBe("Indexed")
	})

	it.each(["resolve", "reject"])("preserves replacement when old startup later %ss", async (outcome) => {
		const first = setup()
		const next = setup()
		let resolve!: () => void
		let reject!: (error: Error) => void
		first.watcher.initialize.mockReturnValue(
			new Promise<void>((done, fail) => {
				resolve = done
				reject = fail
			}),
		)
		first.factory.create.mockReturnValueOnce(first.watcher).mockReturnValue(next.watcher)
		const pending = first.session.start()
		const rejected = expect(pending).rejects.toBeInstanceOf(Error)
		first.session.stop()
		await first.session.start()
		if (outcome === "resolve") resolve()
		else reject(new Error("late failure"))
		await rejected
		await first.session.start()
		expect(first.factory.create).toHaveBeenCalledTimes(2)
		expect(next.watcher.initialize).toHaveBeenCalledTimes(1)
		expect(next.watcher.dispose).not.toHaveBeenCalled()
		next.progress.fire({ processedInBatch: 0, totalInBatch: 1 })
		expect(first.state.state).toBe("Indexing")
		next.finish.fire({ processedFiles: [] })
		expect(first.state.state).toBe("Indexed")
	})

	describe("real state manager integration", () => {
		it("preserves the current outcome when an empty batch starts", async () => {
			const { session, start, finish, state } = setup()
			await session.start()
			finish.fire({ processedFiles: [], batchError: new Error("database unavailable") })
			const outcome = state.getCurrentStatus()
			expect(outcome.systemStatus).toBe("Error")
			start.fire([])
			expect(state.getCurrentStatus()).toEqual(outcome)
		})

		it.each(["success", "skipped", "error", "local_error"] as const)(
			"preserves the %s outcome through terminal and empty progress",
			async (status) => {
				const { session, start, progress, finish, state } = setup()
				await session.start()
				start.fire(["/workspace/file.ts"])
				progress.fire({ processedInBatch: 0, totalInBatch: 1, currentFile: "/workspace/file.ts" })
				expect(state.getCurrentStatus()).toMatchObject({ systemStatus: "Indexing", currentItemUnit: "files" })
				expect(state.getCurrentStatus().message).toContain("Current: file.ts")
				progress.fire({ processedInBatch: 1, totalInBatch: 1 })
				expect(state.state).toBe("Indexing")
				finish.fire({ processedFiles: [{ path: "/workspace/file.ts", status }] })
				const outcome = state.getCurrentStatus()
				expect(outcome.systemStatus).toBe(status === "error" || status === "local_error" ? "Error" : "Indexed")
				progress.fire({ processedInBatch: 1, totalInBatch: 1 })
				progress.fire({ processedInBatch: 0, totalInBatch: 0 })
				expect(state.getCurrentStatus()).toEqual(outcome)
			},
		)

		it("reports batch errors, then allows a subsequent successful batch to recover", async () => {
			const { session, start, finish, state } = setup()
			await session.start()
			finish.fire({ processedFiles: [], batchError: new Error("database unavailable") })
			expect(state.state).toBe("Error")
			expect(state.getCurrentStatus().message).toContain("database unavailable")
			start.fire(["next.ts"])
			expect(state.state).toBe("Indexing")
			finish.fire({ processedFiles: [{ path: "next.ts", status: "success" }] })
			expect(state.state).toBe("Indexed")
		})

		it("reports file errors even in a mixed successful batch", async () => {
			const { session, finish, state } = setup()
			await session.start()
			finish.fire({
				processedFiles: [
					{ path: "good.ts", status: "success" },
					{ path: "bad.ts", status: "local_error", error: new Error("parse failed") },
				],
			})
			expect(state.state).toBe("Error")
			expect(state.getCurrentStatus().message).toContain("parse failed")
		})

		it("does not override Stopping with any watcher event", async () => {
			const { session, start, progress, finish, state } = setup()
			await session.start()
			state.setSystemState("Stopping", "Stopped")
			start.fire(["file.ts"])
			progress.fire({ processedInBatch: 0, totalInBatch: 1 })
			finish.fire({ processedFiles: [] })
			expect(state.state).toBe("Stopping")
		})
	})
})
