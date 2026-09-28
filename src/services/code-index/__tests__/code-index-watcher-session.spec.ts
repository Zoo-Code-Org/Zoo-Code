import type { IFileWatcher } from "../interfaces"
import { CodeIndexWatcherSession } from "../code-index-watcher-session"

function setup() {
	const progress = { dispose: vi.fn() }
	const finished = { dispose: vi.fn() }
	const watcher = {
		initialize: vi.fn<IFileWatcher["initialize"]>().mockResolvedValue(undefined),
		dispose: vi.fn(),
		onDidStartBatchProcessing: vi.fn<IFileWatcher["onDidStartBatchProcessing"]>(),
		onBatchProgressUpdate: vi.fn<IFileWatcher["onBatchProgressUpdate"]>().mockReturnValue(progress),
		onDidFinishBatchProcessing: vi.fn<IFileWatcher["onDidFinishBatchProcessing"]>().mockReturnValue(finished),
		processFile: vi.fn<IFileWatcher["processFile"]>(),
	} satisfies IFileWatcher
	const stateManager = {
		state: "Standby" as const,
		setSystemState: vi.fn(),
		reportFileQueueProgress: vi.fn(),
	}
	const session = new CodeIndexWatcherSession(watcher, stateManager)
	return { session, watcher, progress, finished, stateManager }
}

describe("CodeIndexWatcherSession", () => {
	it.each(["error", "local_error"] as const)("preserves the specific message of a %s file result", async (status) => {
		const { session, watcher, stateManager } = setup()
		await session.start(new AbortController().signal)
		watcher.onDidFinishBatchProcessing.mock.calls[0][0]({
			processedFiles: [{ path: "file.ts", status, error: new Error("specific failure") }],
		})
		expect(stateManager.setSystemState).toHaveBeenLastCalledWith("Error", "specific failure")
		session.stop()
	})

	it("unsubscribes the registered listeners so later events cannot change state", async () => {
		const { session, watcher, stateManager } = setup()
		const progressListeners = new Set<Parameters<IFileWatcher["onBatchProgressUpdate"]>[0]>()
		const finishedListeners = new Set<Parameters<IFileWatcher["onDidFinishBatchProcessing"]>[0]>()
		watcher.onBatchProgressUpdate.mockImplementation((listener) => {
			progressListeners.add(listener)
			return {
				dispose: () => {
					progressListeners.delete(listener)
				},
			}
		})
		watcher.onDidFinishBatchProcessing.mockImplementation((listener) => {
			finishedListeners.add(listener)
			return {
				dispose: () => {
					finishedListeners.delete(listener)
				},
			}
		})
		await session.start(new AbortController().signal)
		expect(progressListeners.has(watcher.onBatchProgressUpdate.mock.calls[0][0])).toBe(true)
		expect(finishedListeners.has(watcher.onDidFinishBatchProcessing.mock.calls[0][0])).toBe(true)
		session.stop()
		for (const listener of progressListeners) listener({ processedInBatch: 0, totalInBatch: 1 })
		for (const listener of finishedListeners) listener({ processedFiles: [] })
		expect(progressListeners.size).toBe(0)
		expect(finishedListeners.size).toBe(0)
		expect(stateManager.setSystemState).not.toHaveBeenCalled()
		expect(stateManager.reportFileQueueProgress).not.toHaveBeenCalled()
	})

	it("reports batch progress with the file name and ignores terminal progress", async () => {
		const { session, watcher, stateManager } = setup()
		await session.start(new AbortController().signal)
		const onProgress = watcher.onBatchProgressUpdate.mock.calls[0][0]
		onProgress({ processedInBatch: 1, totalInBatch: 2, currentFile: "/workspace/file.ts" })
		expect(stateManager.setSystemState).toHaveBeenCalledWith("Indexing", "Processing file changes...")
		expect(stateManager.reportFileQueueProgress).toHaveBeenCalledWith(1, 2, "file.ts")
		stateManager.setSystemState.mockClear()
		onProgress({ processedInBatch: 2, totalInBatch: 2 })
		onProgress({ processedInBatch: 0, totalInBatch: 0 })
		expect(stateManager.setSystemState).not.toHaveBeenCalled()
		expect(stateManager.reportFileQueueProgress).toHaveBeenCalledOnce()
		session.stop()
	})

	it("reports batch success and individual file errors", async () => {
		const { session, watcher, stateManager } = setup()
		await session.start(new AbortController().signal)
		const onFinished = watcher.onDidFinishBatchProcessing.mock.calls[0][0]
		onFinished({ processedFiles: [] })
		expect(stateManager.setSystemState).toHaveBeenLastCalledWith(
			"Indexed",
			"File changes processed. Index up-to-date.",
		)
		onFinished({ processedFiles: [{ path: "file.ts", status: "error" }] })
		expect(stateManager.setSystemState).toHaveBeenLastCalledWith("Error", "Failed to index file: file.ts")
		session.stop()
	})

	it("starts once, registers callbacks and releases subscriptions on stop", async () => {
		const { session, watcher, progress, finished } = setup()
		const signal = new AbortController().signal
		await session.start(signal)
		await session.start(signal)
		expect(session.isRunning).toBe(true)
		expect(watcher.initialize).toHaveBeenCalledOnce()
		expect(watcher.onBatchProgressUpdate).toHaveBeenCalledOnce()
		expect(watcher.onDidFinishBatchProcessing).toHaveBeenCalledOnce()
		session.stop()
		session.stop()
		expect(session.isRunning).toBe(false)
		expect(progress.dispose).toHaveBeenCalledOnce()
		expect(finished.dispose).toHaveBeenCalledOnce()
	})

	it("does not initialize after cancellation", async () => {
		const { session, watcher } = setup()
		const controller = new AbortController()
		controller.abort()
		await expect(session.start(controller.signal)).rejects.toMatchObject({ name: "AbortError" })
		expect(watcher.initialize).not.toHaveBeenCalled()
	})

	it("releases partially registered subscriptions and preserves the startup error", async () => {
		const { session, watcher, progress } = setup()
		const error = new Error("registration failed")
		watcher.onDidFinishBatchProcessing.mockImplementation(() => {
			throw error
		})
		await expect(session.start(new AbortController().signal)).rejects.toBe(error)
		expect(progress.dispose).toHaveBeenCalledOnce()
		expect(watcher.dispose).toHaveBeenCalledOnce()
		expect(session.isRunning).toBe(false)
	})

	it("cleans up a failed initialization", async () => {
		const { session, watcher } = setup()
		const error = new Error("initialization failed")
		watcher.initialize.mockRejectedValue(error)
		await expect(session.start(new AbortController().signal)).rejects.toBe(error)
		expect(watcher.dispose).toHaveBeenCalledOnce()
		expect(watcher.onBatchProgressUpdate).not.toHaveBeenCalled()
	})

	it.each(["stop", "abort"] as const)("does not revive after %s during initialization", async (action) => {
		const { session, watcher } = setup()
		let release!: () => void
		watcher.initialize.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const controller = new AbortController()
		const starting = session.start(controller.signal)
		const rejected = expect(starting).rejects.toMatchObject({ name: "AbortError" })
		if (action === "stop") session.stop()
		else controller.abort()
		await expect(session.start(new AbortController().signal)).rejects.toThrow("already in progress")
		release()
		await rejected
		expect(session.isRunning).toBe(false)
		expect(watcher.onBatchProgressUpdate).not.toHaveBeenCalled()
		expect(watcher.dispose).toHaveBeenCalled()
	})

	it("attempts all disposals even if one subscription throws", async () => {
		const { session, watcher, progress, finished } = setup()
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
		try {
			await session.start(new AbortController().signal)
			progress.dispose.mockImplementation(() => {
				throw new Error("dispose failed")
			})
			session.stop()
			expect(finished.dispose).toHaveBeenCalledOnce()
			expect(watcher.dispose).toHaveBeenCalledOnce()
			expect(log).toHaveBeenCalledOnce()
		} finally {
			log.mockRestore()
		}
	})
})
